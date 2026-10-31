/**
 * Job executor (Phase 4): runs ONE durable job through the EXISTING
 * Xirel Manager (src/lib/agents/runtime.ts) — the worker is a host for
 * the same agent runtime the chat uses, never a competing framework.
 *
 * Ownership discipline: every job mutation is guarded by leaseOwner ===
 * workerId; the lease is renewed by the worker's heartbeat loop while
 * the executor runs. If the worker dies, the lease expires and another
 * worker reclaims the job from its checkpoint.
 */

import { runAgentTurn } from '@/lib/agents/runtime';
import { getTaskById, ensureTask } from '@/lib/jobs/task-helpers';
import {
  attachRunToJob,
  finishJob,
  transitionJob,
  waitForApproval,
  type JobOutcome,
} from '@/lib/jobs/queue';
import type { JobRow } from '@/lib/jobs/queue';
import type { JobCheckpoint } from '@/lib/jobs/state-machine';
import { classifyError } from '@/lib/jobs/errors';
import type { AiProviderId } from '@/lib/ai/types';

export interface ExecuteContext {
  workerId: string;
  leaseSeconds: number;
  providerPriority: AiProviderId[];
}

export interface ExecuteResult {
  outcome: 'completed' | 'failed' | 'retry_scheduled' | 'waiting_approval' | 'not_owner';
  runId?: string;
  detail?: string;
}

/**
 * Execute a claimed job. The job arrives in `claimed` state with this
 * worker owning the lease. Map the agent turn's result onto queue
 * semantics:
 *   completed            → job completed (checkpoint keeps run/project ids)
 *   waiting_for_approval → job parked, approval row created
 *   failed               → classified: retry with backoff or fail
 */
export async function executeJob(job: JobRow, ctx: ExecuteContext): Promise<ExecuteResult> {
  // claimed → running
  const started = await transitionJob(job.id, ctx.workerId, 'running', {
    currentStep: 'Starting agent run',
    checkpoint: { lastStep: 'running' },
  });
  if (!started) {
    return { outcome: 'not_owner', detail: 'lost ownership before start' };
  }

  const checkpoint = (job.checkpoint ?? {}) as JobCheckpoint;
  const approvedTools = checkpoint.approvedTools ?? [];
  const resuming = approvedTools.length > 0;

  // Resolve/attach the conversation task: reuse the job's task when it
  // has one, otherwise create a dedicated task for this job so messages,
  // runs, and audit rows all hang off the existing structures.
  const taskId = await ensureTaskForJob(job);

  const message = resuming
    ? `A human approved the previously blocked action(s): ${approvedTools.join(', ')}. ` +
      `Continue the original task from its checkpoint. Original instructions:\n\n${job.description}`
    : job.description;

  try {
    const turn = await runAgentTurn({
      workspaceId: job.workspaceId,
      userId: job.createdBy,
      taskId,
      message,
      history: [],
      providerPriority: ctx.providerPriority,
      approvedTools: resuming ? approvedTools : undefined,
    });

    await attachRunToJob(job.id, ctx.workerId, turn.runId, turn.projectId ?? undefined);

    const progress: JobCheckpoint = {
      runId: turn.runId,
      ...(turn.projectId ? { projectId: turn.projectId } : {}),
      lastStep: turn.status,
      notes: turn.error ?? undefined,
    };

    if (turn.status === 'completed') {
      const outcome: JobOutcome = { kind: 'completed', checkpoint: progress };
      const state = await finishJob(job.id, ctx.workerId, outcome);
      return { outcome: state === 'completed' ? 'completed' : 'not_owner', runId: turn.runId };
    }

    if (turn.status === 'waiting_for_approval') {
      const parsed = parseApprovalRequest(turn.error ?? '');
      const approval = await waitForApproval({
        jobId: job.id,
        workerId: ctx.workerId,
        summary:
          parsed.summary ??
          turn.text?.slice(0, 400) ??
          turn.error ??
          'The agent requests approval to continue.',
        toolName: parsed.toolName,
        payload: { runId: turn.runId, requestedTools: parsed.toolName ? [parsed.toolName] : [] },
      });
      if (!approval) {
        return { outcome: 'not_owner', runId: turn.runId, detail: 'could not park for approval' };
      }
      return { outcome: 'waiting_approval', runId: turn.runId, detail: approval.approvalId };
    }

    // failed — classify honestly, retry only transient classes
    const classified = classifyError({
      message: turn.error ?? 'Agent turn failed without a specific error.',
    });
    const state = await finishJob(job.id, ctx.workerId, {
      kind: 'failed_permanently',
      error: classified,
      checkpoint: progress,
    });
    return {
      outcome: state === 'retrying' ? 'retry_scheduled' : state === 'failed' ? 'failed' : 'not_owner',
      runId: turn.runId,
      detail: classified.errorClass,
    };
  } catch (error) {
    // Unexpected executor crash (provider outage, bug, transient DB):
    // classify from the throwable so genuine outages retry.
    const { classifyThrownError } = await import('@/lib/jobs/errors');
    const classified = classifyThrownError(error);
    const state = await finishJob(job.id, ctx.workerId, {
      kind: 'failed_permanently',
      error: classified,
    });
    return {
      outcome: state === 'retrying' ? 'retry_scheduled' : state === 'failed' ? 'failed' : 'not_owner',
      detail: classified.errorClass,
    };
  }
}

/** Extract tool name + human summary from the runtime's APPROVAL_REQUIRED signal. */
function parseApprovalRequest(error: string): { toolName: string | null; summary: string | null } {
  const match = /APPROVAL_REQUIRED:\s*tool\s+"([^"]+)"/i.exec(error);
  if (match) {
    return { toolName: match[1] ?? null, summary: error };
  }
  return { toolName: null, summary: error || null };
}

/**
 * Ensure a task row exists for the job. Reuses the job's task when
 * present (chat-initiated jobs), else creates one owned by the job's
 * requesting user — tasks are the anchor for messages/runs/audit.
 */
async function ensureTaskForJob(job: JobRow): Promise<string> {
  if (job.taskId) {
    const existing = await getTaskById(job.taskId);
    if (existing && existing.workspaceId === job.workspaceId) return job.taskId;
  }
  return ensureTask({
    workspaceId: job.workspaceId,
    userId: job.createdBy,
    title: job.title,
    description: job.description,
  });
}
