import 'server-only';

/**
 * Bounds a promise-like value to at most `ms` milliseconds, rejecting
 * with a clear error if it doesn't settle in time. Same "bounded wait,
 * visible error" pattern applied to the AI provider fetch calls
 * (src/lib/ai/providers/*.ts) — connect_timeout/idle_timeout on the
 * postgres-js client (src/lib/db/index.ts) reduce how often a query
 * hangs, but don't guarantee it can't; this is the backstop for
 * request-hot-path DB calls where an indefinite hang is worse than a
 * clear failure the client can show and the router can retry around.
 *
 * Accepts PromiseLike<T>, not just Promise<T> — Drizzle's query
 * builders (db.select()..., db.insert()...) are thenable but don't
 * implement the full Promise interface (.catch/.finally), so a
 * Promise<T> parameter type would reject them at compile time despite
 * working fine at runtime.
 *
 * Not applied blanket to every DB call in the codebase — that would
 * mask genuinely slow-but-legitimate queries behind an arbitrary
 * limit. Used specifically on calls in request-serving hot paths
 * (e.g. loading message history before streaming a response) where a
 * silent multi-minute hang is the worse failure mode.
 */
export function withTimeout<T>(promise: PromiseLike<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}
