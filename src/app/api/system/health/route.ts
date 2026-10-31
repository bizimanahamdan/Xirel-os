import { NextResponse } from 'next/server';
import { desc } from 'drizzle-orm';
import { db } from '@/lib/db';
import { workerHeartbeats } from '@/lib/db/schema';
import { requireUser } from '@/lib/api/guards';
import {
  countJobsByStatus,
  getOldestPendingJobAgeSeconds,
  getExecutionPaused,
} from '@/lib/jobs/queue';
import { getProviderHealthSnapshot } from '@/lib/ai/router/health';
import { getProvider } from '@/lib/ai/registry';

export const dynamic = 'force-dynamic';

/**
 * GET /api/system/health — the Phase 13 observability surface:
 * queue depth, oldest pending job, per-status counts, failed/retry
 * counts, worker heartbeats (with staleness), provider health from the
 * router's live observations, and the global pause state.
 *
 * Authenticated users only (platform posture, not secrets — the values
 * are operational counters).
 */
export async function GET() {
  const guard = await requireUser();
  if (!guard.ok) return guard.response;

  try {
    const [statuses, oldestPendingSeconds, paused, workers] = await Promise.all([
      countJobsByStatus(),
      getOldestPendingJobAgeSeconds(),
      getExecutionPaused(),
      db.select().from(workerHeartbeats).orderBy(desc(workerHeartbeats.lastHeartbeatAt)).limit(20),
    ]);

    const now = Date.now();
    const health = getProviderHealthSnapshot(now);
    // Merge with actual configuration so the surface shows providers
    // that exist but have never been called, too.
    const configuredIds = ['gemini', 'groq', 'qwen', 'moonshot', 'openai', 'anthropic', 'openrouter'] as const;
    const providers = configuredIds.map((id) => {
      const snapshot = health.find((h) => h.providerId === id);
      let configured = false;
      try {
        configured = getProvider(id).isConfigured();
      } catch {
        configured = false;
      }
      return {
        providerId: id,
        configured,
        lastSuccessAt: snapshot?.lastSuccessAt ?? null,
        lastFailureAt: snapshot?.lastFailureAt ?? null,
        lastErrorClass: snapshot?.lastErrorClass ?? null,
        lastErrorMessage: snapshot?.lastErrorMessage ?? null,
        lastLatencyMs: snapshot?.lastLatencyMs ?? null,
        cooldownRemainingMs: snapshot?.cooldownRemainingMs ?? 0,
        consecutiveFailures: snapshot?.consecutiveFailures ?? 0,
      };
    });

    return NextResponse.json({
      executionPaused: paused,
      queue: {
        byStatus: statuses,
        depth: (statuses['queued'] ?? 0) + (statuses['retrying'] ?? 0),
        active: (statuses['claimed'] ?? 0) + (statuses['planning'] ?? 0) + (statuses['running'] ?? 0) + (statuses['verifying'] ?? 0),
        waitingApproval: statuses['waiting_for_approval'] ?? 0,
        failed: statuses['failed'] ?? 0,
        retrying: statuses['retrying'] ?? 0,
        completed: statuses['completed'] ?? 0,
        oldestPendingSeconds: oldestPendingSeconds ?? null,
      },
      workers: workers.map((w) => ({
        workerId: w.workerId,
        lastHeartbeatAt: w.lastHeartbeatAt,
        staleSeconds: Math.max(0, Math.floor((now - new Date(w.lastHeartbeatAt).getTime()) / 1000)),
        activeJobs: w.activeJobs,
        maxConcurrency: w.maxConcurrency,
        version: w.version,
        startedAt: w.startedAt,
      })),
      providers,
    });
  } catch (err) {
    console.error('Health check failed:', err);
    return NextResponse.json({ error: 'Health check failed' }, { status: 500 });
  }
}
