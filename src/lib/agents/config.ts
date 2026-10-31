import 'server-only';

/**
 * Agent runtime configuration (Phase 4).
 *
 * Same discipline as src/lib/ai/config.ts: one module owns what the
 * environment means for the agent runtime, so no other file reads these
 * env vars directly.
 */

function getBool(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

function getInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const agentSettings = {
  /**
   * Whether 'moderate'-risk tools execute without human approval.
   * high/destructive ALWAYS require approval regardless of this flag.
   */
  AGENT_AUTO_APPROVE_MODERATE: getBool('AGENT_AUTO_APPROVE_MODERATE', false),

  /**
   * Cap on planning overhead: the planner produces at most this many
   * steps (also enforced in the plan schema).
   */
  AGENT_MAX_PLAN_STEPS: Math.max(1, getInt('AGENT_MAX_PLAN_STEPS', 6)),
} as const;
