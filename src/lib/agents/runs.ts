import 'server-only';
import { db } from '@/lib/db';
import { agentEvents, agentRuns, agentSteps, toolExecutions } from '@/lib/db/schema';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { withTimeout } from '@/lib/db/with-timeout';

/**
 * Durable agent run state (Phase 4).
 *
 * The orchestrator loop is process memory; THIS module is what makes an
 * agent's work survive it. Every meaningful transition (run started,
 * step started/finished, tool executed, verification done, run failed)
 * is written here, so:
 *
 *   - a crash after step 3 of 8 leaves real state to inspect/resume
 *   - the UI can display a trajectory without reading process memory
 *   - execution state is decoupled from the HTTP request lifetime
 *
 * All writers swallow-and-log DB errors: run bookkeeping must never be
 * the thing that crashes an otherwise-working agent turn. The
 * tool_executions audit log (Phase 3) remains the compliance record;
 * steps reference it via run linkage, not duplication.
 */

const WRITE_TIMEOUT_MS = 4_000;
const READ_TIMEOUT_MS = 6_000;

export type AgentRunRecord = typeof agentRuns.$inferSelect;
export type AgentStepRecord = typeof agentSteps.$inferSelect;
export type AgentEventRecord = typeof agentEvents.$inferSelect;
export type AgentRunStatus = AgentRunRecord['status'];
export type AgentStepStatus = AgentStepRecord['status'];

export interface CreateRunInput {
  workspaceId: string;
  userId: string;
  taskId?: string | null;
  projectId?: string | null;
  metadata?: Record<string, unknown>;
}

export async function createRun(input: CreateRunInput): Promise<AgentRunRecord> {
  const [run] = await withTimeout(
    db
      .insert(agentRuns)
      .values({
        workspaceId: input.workspaceId,
        userId: input.userId,
        taskId: input.taskId ?? null,
        projectId: input.projectId ?? null,
        status: 'queued',
        metadata: input.metadata ?? {},
        startedAt: new Date(),
      })
      .returning(),
    WRITE_TIMEOUT_MS,
    'createRun'
  );
  if (!run) {
    throw new Error('Agent run insert returned no row');
  }
  return run;
}

/** Status transition + optional currentStep/error. Invalid states are not second-guessed here. */
export async function updateRunStatus(
  runId: string,
  status: AgentRunStatus,
  patch: { currentStep?: string | null; error?: string | null; projectId?: string | null } = {}
): Promise<void> {
  try {
    await withTimeout(
      db
        .update(agentRuns)
        .set({
          status,
          currentStep: patch.currentStep ?? null,
          ...(patch.error !== undefined ? { error: patch.error } : {}),
          ...(patch.projectId !== undefined ? { projectId: patch.projectId } : {}),
          ...(status === 'completed' || status === 'failed' || status === 'cancelled'
            ? { completedAt: new Date() }
            : {}),
          updatedAt: new Date(),
        })
        .where(eq(agentRuns.id, runId)),
      WRITE_TIMEOUT_MS,
      'updateRunStatus'
    );
  } catch (err) {
    console.error(`Failed to update run ${runId} status to ${status}:`, err);
  }
}

export async function getRun(workspaceId: string, runId: string): Promise<AgentRunRecord | null> {
  const rows = await withTimeout(
    db
      .select()
      .from(agentRuns)
      .where(and(eq(agentRuns.workspaceId, workspaceId), eq(agentRuns.id, runId)))
      .limit(1),
    READ_TIMEOUT_MS,
    'getRun'
  );
  return rows[0] ?? null;
}

export async function listRuns(workspaceId: string, limit = 20): Promise<AgentRunRecord[]> {
  return withTimeout(
    db
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.workspaceId, workspaceId))
      .orderBy(desc(agentRuns.createdAt))
      .limit(limit),
    READ_TIMEOUT_MS,
    'listRuns'
  );
}

/** Runs across all of a user's workspaces (membership-scoped listing). */
export async function listRunsForWorkspaces(
  workspaceIds: string[],
  limit = 50
): Promise<AgentRunRecord[]> {
  if (workspaceIds.length === 0) return [];
  return withTimeout(
    db
      .select()
      .from(agentRuns)
      .where(inArray(agentRuns.workspaceId, workspaceIds))
      .orderBy(desc(agentRuns.createdAt))
      .limit(limit),
    READ_TIMEOUT_MS,
    'listRunsForWorkspaces'
  );
}

// ─────────────────────────────────────────────────────────
// Steps
// ─────────────────────────────────────────────────────────

export interface StartStepInput {
  runId: string;
  sequence: number;
  stepType: string;
  description: string;
  input?: Record<string, unknown> | null;
  toolName?: string | null;
}

export async function startStep(input: StartStepInput): Promise<AgentStepRecord | null> {
  try {
    const [step] = await withTimeout(
      db
        .insert(agentSteps)
        .values({
          runId: input.runId,
          sequence: input.sequence,
          stepType: input.stepType,
          description: input.description,
          status: 'running',
          input: input.input ?? null,
          toolName: input.toolName ?? null,
          startedAt: new Date(),
        })
        .returning(),
      WRITE_TIMEOUT_MS,
      'startStep'
    );
    return step ?? null;
  } catch (err) {
    console.error('Failed to persist agent step start:', err);
    return null;
  }
}

export async function finishStep(
  stepId: string,
  status: Exclude<AgentStepStatus, 'pending' | 'running'>,
  patch: {
    output?: Record<string, unknown> | null;
    error?: string | null;
  } = {}
): Promise<void> {
  try {
    await withTimeout(
      db
        .update(agentSteps)
        .set({
          status,
          output: patch.output ?? null,
          error: patch.error ?? null,
          completedAt: new Date(),
        })
        .where(eq(agentSteps.id, stepId)),
      WRITE_TIMEOUT_MS,
      'finishStep'
    );
  } catch (err) {
    console.error('Failed to persist agent step finish:', err);
  }
}

export async function listSteps(runId: string): Promise<AgentStepRecord[]> {
  return withTimeout(
    db.select().from(agentSteps).where(eq(agentSteps.runId, runId)).orderBy(asc(agentSteps.sequence)),
    READ_TIMEOUT_MS,
    'listSteps'
  );
}

// ─────────────────────────────────────────────────────────
// Events (activity feed)
// ─────────────────────────────────────────────────────────

export interface AddEventInput {
  runId: string | null;
  workspaceId: string;
  eventType: string;
  message: string;
  data?: Record<string, unknown> | null;
}

export async function addEvent(input: AddEventInput): Promise<void> {
  try {
    await withTimeout(
      db.insert(agentEvents).values({
        runId: input.runId,
        workspaceId: input.workspaceId,
        eventType: input.eventType,
        message: input.message,
        data: input.data ?? null,
      }),
      WRITE_TIMEOUT_MS,
      'addEvent'
    );
  } catch (err) {
    console.error('Failed to persist agent event:', err);
  }
}

export async function listEvents(runId: string, limit = 100): Promise<AgentEventRecord[]> {
  return withTimeout(
    db
      .select()
      .from(agentEvents)
      .where(eq(agentEvents.runId, runId))
      .orderBy(desc(agentEvents.createdAt))
      .limit(limit),
    READ_TIMEOUT_MS,
    'listEvents'
  );
}

/** Everything the UI / an inspector needs for one run, in one call. */
export async function getRunDetail(workspaceId: string, runId: string) {
  const run = await getRun(workspaceId, runId);
  if (!run) return null;
  const [steps, events] = await Promise.all([listSteps(runId), listEvents(runId)]);
  const toolAudit = await withTimeout(
    db
      .select()
      .from(toolExecutions)
      .where(eq(toolExecutions.runId, runId))
      .orderBy(asc(toolExecutions.createdAt)),
    READ_TIMEOUT_MS,
    'runDetailToolAudit'
  ).catch(() => []);
  return { run, steps, events, toolAudit };
}
