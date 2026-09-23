import 'server-only';
import type { AiMessage, AiProviderId } from '@/lib/ai/types';
import { runOrchestrator } from './orchestrator';
import { generatePlan, persistPlan, settlePlanSteps } from './planner';
import { verifyToolExecution, type VerificationReport } from './verification';
import {
  addEvent,
  createRun,
  finishStep,
  startStep,
  updateRunStatus,
} from './runs';

/**
 * Agent runtime — the "Xirel Manager" (Phase 4).
 *
 * One turn of the main chat goes through a REAL lifecycle instead of a
 * bare model round-trip:
 *
 *   create run (queued → planning)
 *     → plan (LLM-generated, persisted as pending steps; honest fallback)
 *     → execute (existing orchestrator tool-calling loop, instrumented:
 *        every tool call becomes a step + activity event; moderate+ risk
 *        tools put the run into waiting_for_approval instead of executing)
 *     → verify (real verifiers where they exist; unavailable is recorded,
 *        never reported as verified)
 *     → complete/fail (durable, with the full trajectory)
 *
 * Execution state lives in the database (agent_runs/steps/events), not in
 * this function's frame: the HTTP request that started a run may die
 * without losing the trajectory, and a background worker can pick runs up
 * from here later.
 *
 * Provider-agnostic: model calls go through the existing router/fallback.
 * If the model chain fails, the run FAILS — it never fabricates success.
 */

export interface AgentTurnRequest {
  workspaceId: string;
  userId: string;
  taskId: string;
  message: string;
  history: AiMessage[];
  providerPriority: AiProviderId[];
}

export interface AgentTurnResult {
  runId: string;
  taskId: string;
  status: 'completed' | 'failed' | 'waiting_for_approval';
  text: string;
  providerId: AiProviderId | null;
  iterations: number;
  projectId: string | null;
  planSource: 'model' | 'deterministic_fallback' | 'skipped';
  verification: VerificationReport | null;
  error: string | null;
  /** Messages produced this turn — the route persists them onto the task. */
  newMessages: AiMessage[];
}

const MAX_SERIALIZED_TOOL_OUTPUT = 4_000;

function safeJson(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function truncateForStep(raw: string): string {
  return raw.length > MAX_SERIALIZED_TOOL_OUTPUT
    ? raw.slice(0, MAX_SERIALIZED_TOOL_OUTPUT) + '…[truncated]'
    : raw;
}

export async function runAgentTurn(request: AgentTurnRequest): Promise<AgentTurnResult> {
  const { workspaceId, userId, taskId, message, history, providerPriority } = request;

  // ── 1. RUN ──────────────────────────────────────────────
  const run = await createRun({
    workspaceId,
    userId,
    taskId,
    metadata: { providerPriority },
  });
  await addEvent({
    runId: run.id,
    workspaceId,
    eventType: 'run_started',
    message: 'Agent run started.',
  });
  await updateRunStatus(run.id, 'planning', { currentStep: 'Planning' });

  const result: AgentTurnResult = {
    runId: run.id,
    taskId,
    status: 'failed',
    text: '',
    providerId: null,
    iterations: 0,
    projectId: null,
    planSource: 'skipped',
    verification: null,
    error: null,
    newMessages: [],
  };

  try {
    // ── 2. PLAN ───────────────────────────────────────────
    const planOutcome = await generatePlan({
      runId: run.id,
      workspaceId,
      message,
      history,
      providerPriority,
    });
    result.planSource = planOutcome.source;
    await persistPlan(run.id, planOutcome.plan);

    // ── 3. EXECUTE (instrumented orchestrator) ────────────
    await updateRunStatus(run.id, 'running', { currentStep: 'Executing' });

    let stepSeq = 0;
    let waitingApproval = false;
    // Per-turn record of what actually executed — captured by the hook
    // closure below, consumed by the verification phase. NEVER module
    // state: concurrent turns must not see each other's tool calls.
    const turnToolCalls: { call: { name: string }; resultJson: string; success: boolean }[] = [];

    const orchestratorResult = await runOrchestrator({
      workspaceId,
      userId,
      taskId,
      messages: history,
      providerPriority,
      hooks: {
        runId: run.id,
        onTurnStart: (iteration) => {
          return updateRunStatus(run.id, 'running', {
            currentStep: `Reasoning (round ${iteration + 1})`,
          });
        },
        onToolExecuted: async (call, resultJson, success) => {
          stepSeq += 1;
          const parsed = safeJson(resultJson);
          const approvalBlocked =
            parsed?.['approval_required'] === true;
          const step = await startStep({
            runId: run.id,
            sequence: 1_000 + stepSeq, // plan steps are 1..n; execution steps offset after them
            stepType: 'tool',
            description: `Tool: ${call.name}`,
            toolName: call.name,
            input: call.arguments,
          });
          if (step) {
            await finishStep(
              step.id,
              success ? 'completed' : approvalBlocked ? 'waiting_approval' : 'failed',
              { output: parsed ? { raw: truncateForStep(resultJson) } : { raw: truncateForStep(resultJson) } }
            );
          }
          await addEvent({
            runId: run.id,
            workspaceId,
            eventType: approvalBlocked
              ? 'tool_waiting_approval'
              : success
                ? 'tool_completed'
                : 'tool_failed',
            message: approvalBlocked
              ? `Tool "${call.name}" requires human approval — not executed.`
              : `Tool "${call.name}" ${success ? 'completed' : 'failed'}.`,
            data: { tool: call.name, success },
          });

          // Project linkage: resolve_project/create_project outputs carry
          // the project id — bind it to the run (and surface in the result).
          if (parsed && typeof parsed['project'] === 'object' && parsed['project'] !== null) {
            const projectRef = parsed['project'] as { id?: unknown };
            if (typeof projectRef.id === 'string') {
              result.projectId = projectRef.id;
              await updateRunStatus(run.id, success ? 'running' : 'running', {
                currentStep: 'Executing',
                projectId: projectRef.id,
              });
            }
          }

          if (approvalBlocked) {
            waitingApproval = true;
          }
          turnToolCalls.push({ call: { name: call.name }, resultJson, success });
        },
        onFinalText: (text, providerId) => {
          result.providerId = providerId;
          return updateRunStatus(run.id, 'running', { currentStep: 'Responding' });
        },
      },
    });

    result.text = orchestratorResult.text;
    result.providerId = result.providerId ?? orchestratorResult.providerId;
    result.iterations = orchestratorResult.iterations;
    result.newMessages = orchestratorResult.newMessages;

    // Approval-blocked tools mean the run is NOT complete: record the
    // request as an explicit approval-needed state (Milestone: approval).
    if (waitingApproval) {
      result.status = 'waiting_for_approval';
      await addEvent({
        runId: run.id,
        workspaceId,
        eventType: 'run_waiting_approval',
        message:
          'Run paused: one or more requested actions require human approval before they can execute.',
      });
      await updateRunStatus(run.id, 'waiting_for_approval', {
        currentStep: 'Waiting for approval',
      });
      await settlePlanSteps(run.id, 'cancelled');
      // Final text still exists (the model explains what it needs approved) —
      // persist it as a respond step for the trajectory.
      const respondStep = await startStep({
        runId: run.id,
        sequence: 9_000,
        stepType: 'respond',
        description: 'Produce response (approval pending)',
      });
      if (respondStep) {
        await finishStep(respondStep.id, 'completed', {
          output: { text: result.text },
        });
      }
      return result;
    }

    // ── 4. VERIFY ─────────────────────────────────────────
    await updateRunStatus(run.id, 'verifying', { currentStep: 'Verifying' });
    const verifyStep = await startStep({
      runId: run.id,
      sequence: 9_500,
      stepType: 'verify',
      description: 'Verify the results of executed tools',
    });

    const report: VerificationReport = {
      checked: 0,
      verified: 0,
      failed: 0,
      unavailable: 0,
      results: [],
    };
    result.verification = report;

    for (const executed of turnToolCalls) {
      report.checked += 1;
      const outcome = await verifyToolExecution({
        toolName: executed.call.name,
        toolOutput: safeJson(executed.resultJson),
        toolSuccess: executed.success,
        context: { workspaceId, userId, taskId },
      });
      if (outcome.status === 'verified') report.verified += 1;
      else if (outcome.status === 'failed') report.failed += 1;
      else report.unavailable += 1;
      report.results.push({
        toolName: executed.call.name,
        status: outcome.status,
        method: outcome.method,
        detail: outcome.detail ?? null,
      });
      await addEvent({
        runId: run.id,
        workspaceId,
        eventType:
          outcome.status === 'verified'
            ? 'verification_passed'
            : outcome.status === 'failed'
              ? 'verification_failed'
              : 'verification_unavailable',
        message:
          outcome.status === 'verified'
            ? `Verified: ${outcome.detail ?? executed.call.name}`
            : outcome.status === 'failed'
              ? `Verification FAILED for ${executed.call.name}: ${outcome.detail}`
              : `Verification unavailable for ${executed.call.name}: ${outcome.detail}`,
      });
    }

    if (verifyStep) {
      await finishStep(verifyStep.id, report.failed > 0 ? 'failed' : 'completed', {
        output: report as unknown as Record<string, unknown>,
      });
    }

    // ── 5. COMPLETE ───────────────────────────────────────
    const respondStep = await startStep({
      runId: run.id,
      sequence: 9_900,
      stepType: 'respond',
      description: 'Produce final response',
    });
    if (respondStep) {
      await finishStep(respondStep.id, 'completed', { output: { text: result.text } });
    }

    result.status = 'completed';
    await settlePlanSteps(run.id, 'completed');
    await updateRunStatus(run.id, 'completed', { currentStep: 'Completed' });
    await addEvent({
      runId: run.id,
      workspaceId,
      eventType: 'run_completed',
      message: `Run completed: ${report.verified} verified, ${report.failed} failed, ${report.unavailable} unverified.`,
      data: {
        providerId: orchestratorResult.providerId,
        iterations: orchestratorResult.iterations,
        planSource: planOutcome.source,
      },
    });
    return result;
  } catch (err) {
    const message0 = err instanceof Error ? err.message : 'Agent run failed';
    result.error = message0;
    result.status = 'failed';
    await settlePlanSteps(run.id, 'failed');
    await updateRunStatus(run.id, 'failed', { currentStep: 'Failed', error: message0 });
    await addEvent({
      runId: run.id,
      workspaceId,
      eventType: 'run_failed',
      message: `Run failed: ${message0}`,
    });
    return result;
  }
}

