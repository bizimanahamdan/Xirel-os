/**
 * In-memory sliding-window rate limiter (Phase 5).
 *
 * Scope honesty: on Vercel each function instance keeps its own buckets,
 * so this is a per-instance guard (blunt but real protection against a
 * runaway client or a retry storm on ONE instance) — not a global
 * quota. A shared store (e.g. Supabase-backed counters) is the future
 * global mechanism; the call sites won't change when it lands.
 */

const buckets = new Map<string, number[]>();

export interface RateLimitResult {
  ok: boolean;
  remaining: number;
  retryAfterMs: number;
}

export function rateLimit(key: string, limit: number, windowMs: number, now = Date.now()): RateLimitResult {
  const windowStart = now - windowMs;
  const hits = (buckets.get(key) ?? []).filter((t) => t > windowStart);

  if (hits.length >= limit) {
    const oldest = Math.min(...hits);
    buckets.set(key, hits);
    return {
      ok: false,
      remaining: 0,
      retryAfterMs: Math.max(1, oldest + windowMs - now),
    };
  }

  hits.push(now);
  buckets.set(key, hits);

  // Opportunistic GC so long-lived processes (the worker imports none of
  // this, but server instances can persist) don't grow unbounded.
  if (buckets.size > 10_000) {
    for (const [k, times] of buckets) {
      if (times.every((t) => t <= windowStart)) buckets.delete(k);
    }
  }

  return { ok: true, remaining: limit - hits.length, retryAfterMs: 0 };
}

/** Reset — tests only. */
export function resetRateLimits(): void {
  buckets.clear();
}
