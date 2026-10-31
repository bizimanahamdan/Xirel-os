/**
 * Failure classification for job retries and provider fallbacks (Phase 3/7).
 *
 * Pure logic. The queue only retries TRANSIENT failures; permanent
 * failures (bad credentials, unsupported models, malformed requests,
 * exhausted quotas, permission errors) fail the job immediately —
 * endless retrying of hopeless work is a bug, not resilience.
 */

/** Machine-readable error classes, shared by the AI router and the queue. */
export type AiErrorClass =
  | 'rate_limited' // too many requests right now — safe to retry later
  | 'quota_exhausted' // credits/plan limit hit — retrying will not help
  | 'invalid_credentials' // 401 / bad API key — permanent
  | 'permission' // 403 — authenticated but not allowed — permanent
  | 'unsupported_model' // unknown/deprecated model id — permanent
  | 'malformed_request' // 400/422 — our request is wrong — permanent
  | 'timeout' // the call took too long — transient
  | 'network' // connection refused/reset/DNS — transient
  | 'provider_outage' // 5xx from the provider — transient
  | 'unknown';

/** Whether the queue may retry this class of failure. */
export type FailureClass = 'transient' | 'permanent';

export const TRANSIENT_CLASSES: readonly AiErrorClass[] = [
  'rate_limited',
  'timeout',
  'network',
  'provider_outage',
];

export function isTransient(errorClass: AiErrorClass): boolean {
  return TRANSIENT_CLASSES.includes(errorClass);
}

export interface ClassifiedError {
  errorClass: AiErrorClass;
  failureClass: FailureClass;
  /** Retry-After hint from the provider, in ms, when present. */
  retryAfterMs: number | null;
  message: string;
}

/** Parse a Retry-After header (delay-seconds or HTTP-date) to ms. */
export function parseRetryAfter(header: string | null | undefined): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isFinite(seconds) ? seconds * 1000 : null;
  }
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  const delta = date - Date.now();
  return delta > 0 ? delta : 0;
}

const QUOTA_MESSAGE =
  /\b(quota|credit)s?\b.{0,40}\b(exceed|exhaust|surpass|deplet|run out|insufficient|no remaining|limit reached)\b|\binsufficient_(quota|credits)\b|\bexceeded your (daily|monthly|weekly)\b/i;
const RATE_MESSAGE = /\brate.?limit|too many requests\b/i;
const TIMEOUT_MESSAGE = /\b(timeout|timed? ?out|etimedout|esockettimedout)\b/i;
const NETWORK_MESSAGE =
  /\b(econn(refused|reset|aborted)|enotfound|eai_again|econnreset|socket hang up|fetch failed|network|dns)\b/i;
const UNSUPPORTED_MODEL_MESSAGE =
  /\b(model not found|unknown model|invalid model|does not exist|not a valid model|no endpoints found|not supported)\b/i;

export interface ClassifyInput {
  /** HTTP status from the provider, when the failure produced one. */
  status?: number | null;
  /** Error code (e.g. errno) when present. */
  code?: string | null;
  /** Error message/body text. */
  message?: string | null;
  /** Raw Retry-After header when present. */
  retryAfterHeader?: string | null;
}

/**
 * Classify one failure. Status codes win over message heuristics;
 * Retry-After is surfaced so both the router cooldown and the job
 * backoff can honor it instead of hammering.
 */
export function classifyError(input: ClassifyInput): ClassifiedError {
  const message = input.message ?? '';
  const retryAfterMs = parseRetryAfter(input.retryAfterHeader);
  const status = input.status ?? null;
  const code = (input.code ?? '').toUpperCase();

  const withClass = (errorClass: AiErrorClass): ClassifiedError => ({
    errorClass,
    failureClass: isTransient(errorClass) ? 'transient' : 'permanent',
    retryAfterMs,
    message,
  });

  if (status === 429) {
    if (QUOTA_MESSAGE.test(message)) return withClass('quota_exhausted');
    return withClass('rate_limited');
  }
  if (status === 402) return withClass('quota_exhausted'); // e.g. OpenRouter insufficient credits
  if (status === 401) return withClass('invalid_credentials');
  if (status === 403) return withClass('permission');
  if (status === 404) {
    if (UNSUPPORTED_MODEL_MESSAGE.test(message) || message.toLowerCase().includes('model')) {
      return withClass('unsupported_model');
    }
    return withClass('malformed_request');
  }
  if (status === 400 || status === 422) return withClass('malformed_request');
  if (status === 408) return withClass('timeout');
  if (status !== null && status >= 500) return withClass('provider_outage');

  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT' || code === 'ABORT_ERR') {
    return withClass('timeout');
  }
  if (
    code === 'ECONNREFUSED' ||
    code === 'ECONNRESET' ||
    code === 'ENOTFOUND' ||
    code === 'EAI_AGAIN' ||
    code === 'EPIPE'
  ) {
    return withClass('network');
  }

  if (TIMEOUT_MESSAGE.test(message)) return withClass('timeout');
  if (NETWORK_MESSAGE.test(message)) return withClass('network');
  if (UNSUPPORTED_MODEL_MESSAGE.test(message)) return withClass('unsupported_model');
  if (QUOTA_MESSAGE.test(message)) return withClass('quota_exhausted');
  if (RATE_MESSAGE.test(message)) return withClass('rate_limited');
  if (/unauthor/i.test(message)) return withClass('invalid_credentials');
  if (/forbidden|not allowed|permission/i.test(message)) return withClass('permission');

  return withClass('unknown');
}

/**
 * Classify a thrown Error (no HTTP context) — used by the worker to
 * decide retry vs fail for unexpected exceptions.
 */
export function classifyThrownError(error: unknown): ClassifiedError {
  if (error instanceof Error) {
    const err = error as NodeJS.ErrnoException;
    return classifyError({ code: err.code ?? null, message: err.message });
  }
  return classifyError({ message: String(error) });
}
