/**
 * Xirel background worker (Phase 4) — Render deployment target.
 *
 * A standalone Node process (no Next.js) that:
 *   - claims durable jobs atomically (FOR UPDATE SKIP LOCKED in 0008)
 *   - executes them through the existing Xirel Manager agent runtime
 *   - renews leases + heartbeats while work is active
 *   - enqueues due cron schedules (Phase 11)
 *   - recovers jobs abandoned by dead workers
 *   - honors the global execution pause (Phase 13)
 *   - drains safely on SIGTERM (Render's stop signal)
 *
 * All state lives in Postgres — this process is replaceable at any time.
 * Concurrency is bounded by WORKER_CONCURRENCY (default 2).
 */

import { claimDueJobs, heartbeatWorker, renewLease, getExecutionPaused, failAbandonedExhaustedJobs } from '@/lib/jobs/queue';
import { fireDueSchedules } from '@/lib/schedules/scan';
import { executeJob } from './job-executor';
import type { AiProviderId } from '@/lib/ai/types';

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const WORKER_ID =
  process.env.WORKER_ID?.trim() || `${process.env.HOSTNAME || 'worker'}-${process.pid}`;
const CONCURRENCY = Math.min(envInt('WORKER_CONCURRENCY', 2), 10);
const LEASE_SECONDS = Math.min(envInt('WORKER_LEASE_SECONDS', 300), 3600);
const POLL_MS = envInt('WORKER_POLL_MS', 2_000);
const HEARTBEAT_MS = envInt('WORKER_HEARTBEAT_MS', 15_000);
const SCHEDULER_MS = envInt('WORKER_SCHEDULER_MS', 30_000);
const GRACE_MS = envInt('WORKER_GRACE_MS', 25_000);
const VERSION = process.env.RENDER_GIT_COMMIT?.slice(0, 12) ?? 'dev';

const DEFAULT_PROVIDERS: AiProviderId[] = ['gemini', 'openrouter', 'groq'];

function providerPriority(): AiProviderId[] {
  const raw = process.env.WORKER_PROVIDER_PRIORITY;
  if (!raw) return DEFAULT_PROVIDERS;
  const parsed = raw
    .split(',')
    .map((p) => p.trim())
    .filter((p): p is AiProviderId =>
      ['gemini', 'groq', 'qwen', 'moonshot', 'openai', 'anthropic', 'openrouter'].includes(p),
    );
  return parsed.length > 0 ? parsed : DEFAULT_PROVIDERS;
}

const active = new Map<string, Promise<void>>();
let shuttingDown = false;
let schedulerTimer: NodeJS.Timeout | null = null;

function log(...args: unknown[]): void {
  console.log(`[worker ${WORKER_ID}]`, ...args);
}

async function runSchedulerTick(): Promise<void> {
  try {
    const fired = await fireDueSchedules(10);
    for (const f of fired) {
      log(`schedule ${f.scheduleId} → job ${f.jobId ?? 'FAILED'}${f.error ? ` (${f.error})` : ''}`);
    }
    const abandoned = await failAbandonedExhaustedJobs();
    if (abandoned > 0) log(`recovery: failed ${abandoned} abandoned job(s) with exhausted attempts`);
  } catch (error) {
    // Transient DB outage — the next tick retries; never crash the worker.
    log('scheduler tick failed (will retry):', error instanceof Error ? error.message : error);
  }
}

async function pump(): Promise<void> {
  if (shuttingDown) return;

  try {
    const paused = await getExecutionPaused();
    if (paused) {
      if (!shuttingDown && active.size === 0) log('execution globally paused — idling');
      return;
    }

    const capacity = CONCURRENCY - active.size;
    if (capacity <= 0) return;

    const jobs = await claimDueJobs({
      workerId: WORKER_ID,
      leaseSeconds: LEASE_SECONDS,
      limit: capacity,
    });

    for (const job of jobs) {
      log(`claimed job ${job.id} (attempt ${job.attemptCount}/${job.maxAttempts}) — ${job.title}`);
      const execution = executeJob(job, {
        workerId: WORKER_ID,
        leaseSeconds: LEASE_SECONDS,
        providerPriority: providerPriority(),
      })
        .then((result) => {
          log(`job ${job.id} → ${result.outcome}${result.detail ? ` (${result.detail})` : ''}`);
        })
        .catch((error) => {
          log(`job ${job.id} executor crashed:`, error instanceof Error ? error.message : error);
        })
        .finally(() => {
          active.delete(job.id);
        });
      active.set(job.id, execution);
    }
  } catch (error) {
    log('claim loop failed (will retry):', error instanceof Error ? error.message : error);
  }
}

async function heartbeatLoop(): Promise<void> {
  // renew leases for every active job + report the worker heartbeat
  for (const jobId of Array.from(active.keys())) {
    try {
      const renewed = await renewLease(jobId, WORKER_ID, LEASE_SECONDS);
      if (!renewed && !shuttingDown) {
        log(`warning: lost lease on job ${jobId} — its executor result may be discarded`);
      }
    } catch {
      // transient — renewed on the next beat
    }
  }
  try {
    await heartbeatWorker({
      workerId: WORKER_ID,
      activeJobs: active.size,
      maxConcurrency: CONCURRENCY,
      version: VERSION,
    });
  } catch {
    // transient
  }
}

async function drainAndExit(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`${signal} received — draining ${active.size} active job(s) (grace ${GRACE_MS}ms)`);

  if (schedulerTimer) clearInterval(schedulerTimer);

  const deadline = Date.now() + GRACE_MS;
  while (active.size > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  // Release any job still active back to the queue: another worker (or
  // this one after redeploy) picks it up immediately; the attempt is
  // already counted, and its checkpoint limits repeated work.
  for (const jobId of Array.from(active.keys())) {
    try {
      const { transitionJob } = await import('@/lib/jobs/queue');
      const released = await transitionJob(jobId, WORKER_ID, 'queued');
      log(`released job ${jobId} on shutdown: ${released ? 'queued' : 'not owned (left to lease expiry)'}`);
    } catch (error) {
      log(`failed to release job ${jobId}:`, error instanceof Error ? error.message : error);
    }
  }

  try {
    await heartbeatWorker({
      workerId: WORKER_ID,
      activeJobs: 0,
      maxConcurrency: CONCURRENCY,
      version: VERSION,
    });
  } catch {
    // best effort
  }

  log('shutdown complete');
  process.exit(0);
}

async function main(): Promise<void> {
  log(`starting — concurrency=${CONCURRENCY} lease=${LEASE_SECONDS}s poll=${POLL_MS}ms`);
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is required — refusing to start.');
    process.exit(1);
  }

  process.on('SIGTERM', () => void drainAndExit('SIGTERM'));
  process.on('SIGINT', () => void drainAndExit('SIGINT'));

  // Boot is tolerant of a temporarily unreachable database (Render
  // restarts, Supabase failover): log loudly and keep retrying — the
  // poll loop recovers on its own once the connection returns. Only a
  // MISSING DATABASE_URL is fatal (config error, not transient).
  try {
    await heartbeatWorker({ workerId: WORKER_ID, activeJobs: 0, maxConcurrency: CONCURRENCY, version: VERSION });
    log('database reachable — polling for work');
  } catch (error) {
    log('database unreachable at boot — will keep retrying:',
      error instanceof Error ? error.message : error);
  }

  schedulerTimer = setInterval(() => void runSchedulerTick(), SCHEDULER_MS);
  schedulerTimer.unref();
  setInterval(() => void heartbeatLoop(), HEARTBEAT_MS).unref();

  for (;;) {
    if (!shuttingDown) await pump();
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

main().catch((error) => {
  console.error('[worker] fatal startup error:', error);
  process.exit(1);
});
