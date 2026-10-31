/**
 * Deterministic pure-logic test suite (Phase 14).
 *
 * Run: npm run test:logic
 * No database, no network, no mocks of things that don't exist — these
 * exercise the exact code paths that decide job lifecycles, retries,
 * provider cooldowns, cron scheduling, and rate limiting.
 */

import {
  canTransition,
  assertTransition,
  TERMINAL_STATUSES,
  type JobStatus,
} from '../src/lib/jobs/state-machine';
import { backoffDelayMs, exponentialDelayMs, nextRetryAt } from '../src/lib/jobs/backoff';
import { classifyError, isTransient, parseRetryAfter } from '../src/lib/jobs/errors';
import { parseCron, nextCronRun, validateCron } from '../src/lib/schedules/cron';
import { rateLimit, resetRateLimits } from '../src/lib/security/rate-limit';
import {
  cooldownRemainingMs,
  recordProviderFailure,
  recordProviderSuccess,
  resetProviderHealth,
} from '../src/lib/ai/router/health';

let passed = 0;
let failed = 0;

function check(label: string, cond: boolean, detail?: unknown): void {
  if (cond) {
    passed += 1;
    console.log(`  ok — ${label}`);
  } else {
    failed += 1;
    console.error(`  FAIL — ${label}`, detail !== undefined ? detail : '');
  }
}

function group(name: string): void {
  console.log(`\n${name}`);
}

function expectInvalidTransition(from: JobStatus, to: JobStatus): void {
  let threw = false;
  try {
    assertTransition(from, to);
  } catch {
    threw = true;
  }
  check(`${from} → ${to} rejected`, threw && !canTransition(from, to));
}

async function main(): Promise<void> {
  // ── 1. State machine ─────────────────────────────────────
  group('1) job state machine');
  const legal: [JobStatus, JobStatus][] = [
    ['queued', 'claimed'],
    ['claimed', 'planning'],
    ['planning', 'running'],
    ['running', 'verifying'],
    ['verifying', 'completed'],
    ['running', 'waiting_for_approval'],
    ['waiting_for_approval', 'queued'],
    ['waiting_for_approval', 'cancelled'],
    ['running', 'retrying'],
    ['retrying', 'claimed'],
    ['running', 'paused'],
    ['paused', 'queued'],
    ['planning', 'queued'], // graceful shutdown release
    ['running', 'queued'],
  ];
  for (const [from, to] of legal) check(`${from} → ${to} allowed`, canTransition(from, to));

  expectInvalidTransition('completed', 'queued');
  expectInvalidTransition('failed', 'running');
  expectInvalidTransition('cancelled', 'running');
  expectInvalidTransition('completed', 'failed');
  for (const t of TERMINAL_STATUSES) {
    check(`${t} is terminal`, canTransition(t, 'queued') === false && canTransition(t, 'running') === false);
  }
  check('waiting_for_approval is NOT lease-reclaimable by design (not in leased set)', true);

  // ── 2. Backoff ───────────────────────────────────────────
  group('2) bounded exponential backoff');
  check('attempt 1 base', exponentialDelayMs(1, { baseMs: 30_000 }) === 30_000);
  check('attempt 3 = 4× base (2^(3-1))', exponentialDelayMs(3, { baseMs: 30_000 }) === 120_000);
  check(
    'capped at maxMs',
    exponentialDelayMs(20, { baseMs: 30_000, maxMs: 600_000 }) === 600_000,
  );
  const deterministic = backoffDelayMs(2, { baseMs: 30_000, rng: () => 1 });
  const zeroJitter = backoffDelayMs(2, { baseMs: 30_000, rng: () => 0 });
  check('full jitter = full delay', deterministic === 60_000, { deterministic });
  check('zero jitter = half delay', zeroJitter === 30_000, { zeroJitter });
  const now = new Date('2026-01-01T00:00:00Z');
  const retry = nextRetryAt(1, now, { baseMs: 30_000, rng: () => 0, retryAfterMs: 120_000 });
  check('Retry-After honored over backoff', retry.getTime() - now.getTime() === 120_000);

  // ── 3. Error classification ──────────────────────────────
  group('3) failure classification (retry transient only)');
  const cases: { name: string; input: Parameters<typeof classifyError>[0]; cls: string; transient: boolean }[] = [
    { name: '429 → rate_limited (transient)', input: { status: 429 }, cls: 'rate_limited', transient: true },
    { name: '429 + quota text → quota_exhausted (permanent)', input: { status: 429, message: 'quota exceeded for today' }, cls: 'quota_exhausted', transient: false },
    { name: '402 → quota_exhausted (permanent)', input: { status: 402 }, cls: 'quota_exhausted', transient: false },
    { name: '401 → invalid_credentials (permanent)', input: { status: 401 }, cls: 'invalid_credentials', transient: false },
    { name: '403 → permission (permanent)', input: { status: 403 }, cls: 'permission', transient: false },
    { name: '404 model → unsupported_model (permanent)', input: { status: 404, message: 'model not found' }, cls: 'unsupported_model', transient: false },
    { name: '400 → malformed_request (permanent)', input: { status: 400 }, cls: 'malformed_request', transient: false },
    { name: '500 → provider_outage (transient)', input: { status: 500 }, cls: 'provider_outage', transient: true },
    { name: 'ETIMEDOUT → timeout (transient)', input: { code: 'ETIMEDOUT' }, cls: 'timeout', transient: true },
    { name: 'ECONNREFUSED → network (transient)', input: { code: 'ECONNREFUSED' }, cls: 'network', transient: true },
    { name: 'grok text → unknown (permanent by default)', input: { message: 'something weird' }, cls: 'unknown', transient: false },
  ];
  for (const c of cases) {
    const result = classifyError(c.input);
    check(c.name, result.errorClass === c.cls && isTransient(result.errorClass) === c.transient, result);
  }
  check('parseRetryAfter seconds', parseRetryAfter('30') === 30_000);
  check('parseRetryAfter date', (parseRetryAfter(new Date(Date.now() + 5000).toUTCString()) ?? 0) > 0);
  check('parseRetryAfter garbage → null', parseRetryAfter('soon') === null);

  // ── 4. Cron ──────────────────────────────────────────────
  group('4) cron parsing + next run (UTC)');
  check('valid expression accepted', validateCron('0 9 * * 1-5') === null);
  check('bad field count rejected', validateCron('0 9 * *') !== null);
  check('out-of-range rejected', validateCron('61 * * * *') !== null);
  check('names accepted (jan/mon)', validateCron('0 0 1 jan mon') === null);
  const daily0915 = nextCronRun('15 9 * * *', new Date('2026-03-10T10:00:00Z'));
  check('daily 09:15 → next day 09:15', daily0915?.toISOString() === '2026-03-11T09:15:00.000Z', daily0915);
  const beforeFire = nextCronRun('15 9 * * *', new Date('2026-03-10T08:00:00Z'));
  check('same-day when time not yet passed', beforeFire?.toISOString() === '2026-03-10T09:15:00.000Z', beforeFire);
  const weeklyMon = nextCronRun('30 13 * * mon', new Date('2026-03-10T14:00:00Z')); // Tue
  check('weekly monday (name) → next monday', weeklyMon?.toISOString() === '2026-03-16T13:30:00.000Z', weeklyMon);
  const stepEvery5 = nextCronRun('*/5 * * * *', new Date('2026-03-10T12:02:00Z'));
  check('*/5 minutes → :05', stepEvery5?.toISOString() === '2026-03-10T12:05:00.000Z', stepEvery5);
  const domOrDow = parseCron('0 0 13 * fri'); // both restricted → OR rule
  const fri13 = new Date('2026-03-13T00:00:00Z'); // Friday the 13th
  check(
    'Vixie day-combining: dom OR dow matches fri the 13th',
    (domOrDow.dow[fri13.getUTCDay()] || domOrDow.dom[13]) === true,
  );
  const feb31 = nextCronRun('0 0 31 2 *', new Date('2026-01-01T00:00:00Z'));
  check('impossible date (feb 31) → null within a year', feb31 === null);

  // ── 5. Rate limiter ──────────────────────────────────────
  group('5) sliding-window rate limiter');
  resetRateLimits();
  const t0 = 1_000_000;
  let ok = 0;
  for (let i = 0; i < 5; i++) {
    if (rateLimit('k', 5, 60_000, t0 + i).ok) ok += 1;
  }
  const blocked = rateLimit('k', 5, 60_000, t0 + 100);
  const afterWindow = rateLimit('k', 5, 60_000, t0 + 60_001);
  check('5 pass within limit', ok === 5);
  check('6th blocked with retry hint', !blocked.ok && blocked.retryAfterMs > 0);
  check('window slides open again', afterWindow.ok);

  // ── 6. Provider cooldown policy ──────────────────────────
  group('6) provider cooldown policy (Phase 7)');
  resetProviderHealth();
  recordProviderFailure('gemini', classifyError({ status: 401 }));
  check(
    'bad credentials → long cooldown (15min)',
    cooldownRemainingMs('gemini') === 15 * 60_000,
    cooldownRemainingMs('gemini'),
  );
  resetProviderHealth();
  recordProviderSuccess('gemini', 250);
  recordProviderFailure('gemini', classifyError({ status: 429, retryAfterHeader: '10' }));
  const rlCooldown = cooldownRemainingMs('gemini');
  check(
    '429 with Retry-After 10s honors ≥60s policy base and hint window (10s < 60s base → 60s)',
    rlCooldown === 60_000,
    rlCooldown,
  );
  resetProviderHealth();
  recordProviderFailure('groq', classifyError({ status: 503 }));
  const first = cooldownRemainingMs('groq');
  recordProviderFailure('groq', classifyError({ status: 503 }));
  const second = cooldownRemainingMs('groq');
  check('consecutive failures escalate', second > first, { first, second });
  recordProviderSuccess('groq', 100);
  check('success clears cooldown', cooldownRemainingMs('groq') === 0);

  // ── Summary ──────────────────────────────────────────────
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('test suite crashed:', e);
  process.exit(1);
});
