/**
 * Provider health + cooldown tracking (Phase 7).
 *
 * In-memory, per-process by design: Vercel function instances are short-
 * lived and the Render worker is long-lived, so the tracker is most
 * meaningful where it matters most (the worker stops hammering exhausted
 * providers for its whole uptime). This is NOT a cross-instance circuit
 * breaker — documented limitation, not a hidden one.
 *
 * Rules:
 *  - permanent failures (quota exhausted, bad credentials, unsupported
 *    model, permission) cool the provider down for a LONG window —
 *    retrying them inside the same process is pure waste;
 *  - transient failures (rate limit, outage, network, timeout) cool down
 *    briefly, honoring Retry-After when the provider supplied one;
 *  - consecutive failures escalate the cooldown up to a cap;
 *  - success resets the streak.
 */

import type { AiProviderId } from '../types';
import type { AiErrorClass, ClassifiedError } from '@/lib/jobs/errors';

interface ProviderRecord {
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  lastErrorClass: AiErrorClass | null;
  lastErrorMessage: string | null;
  lastLatencyMs: number | null;
  cooldownUntil: number;
  consecutiveFailures: number;
}

const COOLDOWN_MS: Record<AiErrorClass, number> = {
  rate_limited: 60_000,
  timeout: 15_000,
  network: 15_000,
  provider_outage: 30_000,
  quota_exhausted: 15 * 60_000,
  invalid_credentials: 15 * 60_000,
  permission: 15 * 60_000,
  unsupported_model: 15 * 60_000,
  malformed_request: 0, // our bug, not the provider's state — retrying is harmless
  unknown: 30_000,
};

const MAX_COOLDOWN_MS = 15 * 60_000;

const records = new Map<AiProviderId, ProviderRecord>();

function recordFor(providerId: AiProviderId): ProviderRecord {
  let r = records.get(providerId);
  if (!r) {
    r = {
      lastSuccessAt: null,
      lastFailureAt: null,
      lastErrorClass: null,
      lastErrorMessage: null,
      lastLatencyMs: null,
      cooldownUntil: 0,
      consecutiveFailures: 0,
    };
    records.set(providerId, r);
  }
  return r;
}

export function recordProviderSuccess(providerId: AiProviderId, latencyMs: number): void {
  const r = recordFor(providerId);
  r.lastSuccessAt = Date.now();
  r.lastLatencyMs = latencyMs;
  r.consecutiveFailures = 0;
  r.cooldownUntil = 0;
}

export function recordProviderFailure(providerId: AiProviderId, classified: ClassifiedError): void {
  const r = recordFor(providerId);
  r.lastFailureAt = Date.now();
  r.lastErrorClass = classified.errorClass;
  r.lastErrorMessage = classified.message.slice(0, 300);
  r.consecutiveFailures += 1;

  const base =
    classified.retryAfterMs !== null
      ? Math.max(COOLDOWN_MS[classified.errorClass], Math.min(classified.retryAfterMs, MAX_COOLDOWN_MS))
      : COOLDOWN_MS[classified.errorClass];
  // exponential escalation for consecutive failures, capped
  const escalation = Math.min(base * 2 ** Math.min(r.consecutiveFailures - 1, 4), MAX_COOLDOWN_MS);
  r.cooldownUntil = base === 0 ? 0 : Date.now() + escalation;
}

export function cooldownRemainingMs(providerId: AiProviderId, now = Date.now()): number {
  const r = records.get(providerId);
  if (!r) return 0;
  return Math.max(0, r.cooldownUntil - now);
}

export interface ProviderHealthSnapshot {
  providerId: AiProviderId;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastErrorClass: AiErrorClass | null;
  lastErrorMessage: string | null;
  lastLatencyMs: number | null;
  cooldownRemainingMs: number;
  consecutiveFailures: number;
}

export function getProviderHealthSnapshot(now = Date.now()): ProviderHealthSnapshot[] {
  return Array.from(records.entries()).map(([providerId, r]) => ({
    providerId,
    lastSuccessAt: r.lastSuccessAt ? new Date(r.lastSuccessAt).toISOString() : null,
    lastFailureAt: r.lastFailureAt ? new Date(r.lastFailureAt).toISOString() : null,
    lastErrorClass: r.lastErrorClass,
    lastErrorMessage: r.lastErrorMessage,
    lastLatencyMs: r.lastLatencyMs,
    cooldownRemainingMs: Math.max(0, r.cooldownUntil - now),
    consecutiveFailures: r.consecutiveFailures,
  }));
}

/** Reset everything — used by tests. */
export function resetProviderHealth(): void {
  records.clear();
}
