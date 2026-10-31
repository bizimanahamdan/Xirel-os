/**
 * Skills architecture (Phase 8).
 *
 * A Skill is a REUSABLE, INDEPENDENTLY TESTABLE capability above the
 * tool layer: it declares what it needs (tools, permissions), how it
 * executes (deterministic procedure or agent instructions), how its
 * result is verified, and how it fails. The Xirel Manager never
 * hardcodes capabilities — it composes skills.
 *
 * Honesty rules carried over from the tool gateway:
 *  - a skill that cannot really run is declared `available: false` with
 *    the concrete missing dependency — never registered as executable;
 *  - verification requirements are explicit: a skill says whether its
 *    outcome is verified, unverified, or unverifiable.
 */

import type { z } from 'zod';
import type { ToolRiskLevel } from '@/lib/agents/tools/types';

export type SkillFailureBehavior =
  | 'fail_job' // surfaced to the queue: classified, maybe retried
  | 'report_partial' // complete with explicit "what did not happen"
  | 'requires_approval'; // cannot continue without a human decision

export interface SkillVerification {
  /** How the skill's claimed outcome gets verified. */
  method:
    | 'tool_verification' // reuse the VERIFIERS registry on the outputs
    | 're_read_state' // re-read DB/external state before claiming success
    | 'external_confirmation' // an external system must confirm (webhook/poll)
    | 'none'; // explicitly unverifiable — reported as unavailable
  detail: string;
}

export interface Skill<I = unknown, O = unknown> {
  /** Stable identifier, e.g. 'project_status_report'. */
  name: string;
  description: string;
  /** Semver of the skill definition itself. */
  version: string;
  /** Zod schema for the skill's input (validated before execution).
   *  Input-side is `unknown` so schemas using defaults coerce properly. */
  inputSchema: z.ZodType<I, z.ZodTypeDef, unknown>;
  /** Zod schema for the skill's structured output. */
  outputSchema: z.ZodType<O, z.ZodTypeDef, unknown>;
  /** Tool names that must be registered for this skill to run. */
  requiredTools: string[];
  /** Highest risk level the skill's underlying operations imply. */
  riskLevel: ToolRiskLevel;
  /**
   * Deterministic skills execute as code (fast, testable); agent-driven
   * skills produce instructions for the Manager to execute through the
   * orchestrator loop.
   */
  kind: 'deterministic' | 'agent_driven';
  /** Execution instructions (agent_driven) or documentation (deterministic). */
  instructions: string;
  verification: SkillVerification;
  failureBehavior: SkillFailureBehavior;
  /**
   * Whether the skill can actually run right now. Skills with missing
   * connectors/integrations are listed but refuse to execute, with the
   * concrete reason — the interface documents the boundary instead of
   * pretending.
   */
  available: boolean;
  /** When available=false: what exactly is missing. */
  unavailableReason?: string;
  execute?: (input: I) => Promise<O>;
}

export interface SkillRunResult<O = unknown> {
  skill: string;
  ok: boolean;
  output?: O;
  error?: string;
  verification: {
    status: 'verified' | 'unverified' | 'unavailable';
    method: string;
    detail?: string;
  };
}
