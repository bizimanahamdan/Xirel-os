/**
 * Bounded exponential backoff with equal jitter (Phase 3).
 *
 * Pure logic. delay(attempt) = base·2^(attempt−1), capped at max, with
 * equal jitter (½·d + rand(0, ½·d)) so concurrent retries spread out
 * instead of stampeding. A provider Retry-After hint, when present, is
 * always honored by taking the max of the two.
 */

export interface BackoffOptions {
  /** Delay before the FIRST retry (attempt=1). Default 30s. */
  baseMs?: number;
  /** Upper bound on the computed delay. Default 30min. */
  maxMs?: number;
  /** Random source for jitter; injectable for deterministic tests. */
  rng?: () => number;
}

const DEFAULT_BASE_MS = 30_000;
const DEFAULT_MAX_MS = 30 * 60_000;

/** Raw exponential delay (no jitter) for a 1-based attempt number. */
export function exponentialDelayMs(attempt: number, opts: BackoffOptions = {}): number {
  const baseMs = opts.baseMs ?? DEFAULT_BASE_MS;
  const maxMs = opts.maxMs ?? DEFAULT_MAX_MS;
  const safeAttempt = Math.max(1, Math.floor(attempt));
  const raw = baseMs * 2 ** (safeAttempt - 1);
  return Math.min(raw, maxMs);
}

/** Jittered delay actually used for the next execution. */
export function backoffDelayMs(attempt: number, opts: BackoffOptions = {}): number {
  const rng = opts.rng ?? Math.random;
  const delay = exponentialDelayMs(attempt, opts);
  const half = delay / 2;
  return Math.floor(half + half * Math.max(0, Math.min(1, rng())));
}

/**
 * Absolute retry time for a job that just failed its `attempt`-th try.
 * `retryAfterMs` (provider hint) is honored when it exceeds the backoff.
 */
export function nextRetryAt(
  attempt: number,
  now: Date,
  opts: BackoffOptions & { retryAfterMs?: number | null } = {},
): Date {
  const delay = Math.max(backoffDelayMs(attempt, opts), opts.retryAfterMs ?? 0);
  return new Date(now.getTime() + delay);
}
