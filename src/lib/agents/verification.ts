import 'server-only';
import { z } from 'zod';

/**
 * Verification abstraction (Phase 4).
 *
 * The runtime must distinguish "the model said it succeeded" from "the
 * outcome was verified". This module owns that distinction.
 *
 * A verifier is registered per tool name and receives what actually
 * happened (tool output + execution context) and re-checks the CLAIM
 * against reality — e.g. after create_project, re-read the project from
 * the database. A verifier that throws or is missing means verification
 * is UNAVAILABLE, which is recorded honestly — never silently reported
 * as verified, and never faked.
 *
 * Future verifiers (next milestones): typecheck/build/test for code
 * changes, deployment-status polling after a deploy, schema checks after
 * a database operation. They slot into VERIFIERS without touching the
 * runtime.
 */

export interface VerificationInput {
  toolName: string;
  toolOutput: Record<string, unknown> | null;
  toolSuccess: boolean;
  context: {
    workspaceId: string;
    userId: string;
    taskId: string | null;
  };
}

export type VerificationOutcome =
  | { status: 'verified'; method: string; detail?: string }
  | { status: 'failed'; method: string; detail: string }
  | { status: 'unavailable'; method: null; detail: string };

type Verifier = (input: VerificationInput) => Promise<VerificationOutcome>;

// ─────────────────────────────────────────────────────────
// Tool-specific verifiers (real ones only)
// ─────────────────────────────────────────────────────────

const projectRefSchema = z.object({
  project: z.object({ id: z.string().uuid(), name: z.string() }).passthrough(),
});

/**
 * create_project → re-read the project through resolveProject. This is a
 * REAL verification: the claim ("project exists") is checked against the
 * database, not against the tool's own say-so.
 */
async function verifyCreateProject(input: VerificationInput): Promise<VerificationOutcome> {
  if (!input.toolSuccess) {
    return { status: 'unavailable', method: null, detail: 'Tool did not succeed — nothing to verify.' };
  }
  const parsed = projectRefSchema.safeParse(input.toolOutput);
  if (!parsed.success) {
    return {
      status: 'unavailable',
      method: null,
      detail: 'Tool output shape unexpected — verification unavailable.',
    };
  }
  const { resolveProject } = await import('@/lib/projects/queries');
  const reloaded = await resolveProject(
    input.context.workspaceId,
    parsed.data.project.id
  );
  if (reloaded && reloaded.id === parsed.data.project.id) {
    return {
      status: 'verified',
      method: 'db_re-read',
      detail: `Project "${reloaded.name}" exists in the registry (id ${reloaded.id}).`,
    };
  }
  return {
    status: 'failed',
    method: 'db_re-read',
    detail: `Project id ${parsed.data.project.id} not found on re-read.`,
  };
}

const VERIFIERS: Record<string, Verifier> = {
  create_project: verifyCreateProject,
};

// ─────────────────────────────────────────────────────────
// Runtime entry point
// ─────────────────────────────────────────────────────────

export async function verifyToolExecution(input: VerificationInput): Promise<VerificationOutcome> {
  const verifier = VERIFIERS[input.toolName];
  if (!verifier) {
    return {
      status: 'unavailable',
      method: null,
      detail: `No verifier registered for "${input.toolName}" — outcome recorded as unverified, not verified.`,
    };
  }
  try {
    return await verifier(input);
  } catch (err) {
    const detail = err instanceof Error ? err.message : 'Verifier threw';
    return { status: 'unavailable', method: null, detail: `Verification errored: ${detail}` };
  }
}

export interface VerificationReport {
  checked: number;
  verified: number;
  failed: number;
  unavailable: number;
  results: {
    toolName: string;
    status: VerificationOutcome['status'];
    method: string | null;
    detail: string | null;
  }[];
}
