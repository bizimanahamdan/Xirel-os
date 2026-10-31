import 'server-only';
import { z } from 'zod';
import { routeGenerateText } from '@/lib/ai/router';
import { getDefaultModel } from '@/lib/ai/models';
import type { AiMessage, AiProviderId } from '@/lib/ai/types';
import { addEvent, startStep, finishStep, listSteps } from './runs';

/**
 * Planner (Phase 4 / Milestone 4).
 *
 * Deliberately NOT an autonomous planner: it produces a SHORT, structured,
 * persisted plan (max PLAN_MAX_STEPS steps) that becomes executable state
 * (pending agent_steps rows) — the model never just narrates a plan into
 * chat text and forgets it. The model's tool-calling loop remains the
 * authority on what actually happens; the recorded trajectory (tool steps)
 * is what execution really did, and both are kept.
 *
 * Provider-agnostic: goes through the existing router with fallback, like
 * every other LLM call in the codebase. If planning fails entirely, the
 * run proceeds on an honest single-step fallback plan labeled
 * 'deterministic_fallback' — planning failure never blocks execution and
 * never fabricates a plan the model didn't produce.
 */

export const PLAN_MAX_STEPS = 6;

const planSchema = z.object({
  steps: z
    .array(
      z.object({
        description: z.string().min(1).max(300),
        toolHint: z.string().max(80).optional().nullable(),
      })
    )
    .min(1)
    .max(PLAN_MAX_STEPS),
});

export type AgentPlan = z.infer<typeof planSchema>;

/**
 * Tolerant JSON extraction from a model response: strips markdown
 * fences / preamble and parses the first balanced JSON object. Local
 * to the planner on purpose — the provider adapters own their own
 * structured-output paths, this only handles the planner's prompt.
 */
export function extractPlanJson(text: string): unknown {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('{');
  if (start === -1) throw new Error('no JSON object in plan response');
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') inString = !inString;
    if (inString) continue;
    if (ch === '{') depth++;
    if (ch === '}') {
      depth--;
      if (depth === 0) {
        return JSON.parse(cleaned.slice(start, i + 1));
      }
    }
  }
  throw new Error('unterminated JSON object in plan response');
}

export interface PlanOutcome {
  plan: AgentPlan;
  source: 'model' | 'deterministic_fallback';
  providerId: AiProviderId | null;
  error: string | null;
}

const PLANNING_INSTRUCTIONS = `You are the Xirel planning module. Given a user's request, produce a SHORT ordered plan of the concrete steps required.

Rules:
- At most ${PLAN_MAX_STEPS} steps. Prefer fewer.
- Each step is one verb phrase describing an action (resolve information, inspect something, use a tool, produce the answer).
- Do NOT include "verify" or "report the result" steps — the runtime adds those itself.
- If the request is simple conversation, one step like "Answer the user's question directly, using tools only if needed." is correct.

Respond ONLY with a single valid JSON object, no markdown fences:
{"steps": [{"description": "...", "toolHint": "tool_name_or_null"}]}`;

export async function generatePlan(params: {
  runId: string;
  workspaceId: string;
  message: string;
  history: AiMessage[];
  providerPriority: AiProviderId[];
}): Promise<PlanOutcome> {
  const { runId, workspaceId, message, history, providerPriority } = params;

  const recentHistory = history.slice(-6); // context, not the whole log
  const prompt =
    (recentHistory.length > 0
      ? `Recent conversation:\n${recentHistory
          .map((m) => `${m.role}: ${m.content.slice(0, 200)}`)
          .join('\n')}\n\n`
      : '') + `Current request: ${message}`;

  try {
    const response = await routeGenerateText({
      messages: [
        { role: 'system', content: PLANNING_INSTRUCTIONS },
        { role: 'user', content: prompt },
      ],
      model: getDefaultModel(providerPriority[0] ?? 'openrouter'),
      providerPriority,
      temperature: 0.1,
      maxOutputTokens: 500,
    });

    const parsed = planSchema.parse(extractPlanJson(response.text));
    await addEvent({
      runId,
      workspaceId,
      eventType: 'plan_generated',
      message: `Plan created with ${parsed.steps.length} step(s).`,
      data: { source: 'model', providerId: response.providerId, steps: parsed.steps },
    });
    return { plan: parsed, source: 'model', providerId: response.providerId, error: null };
  } catch (err) {
    const error = err instanceof Error ? err.message : 'Planning failed';
    const fallback: AgentPlan = {
      steps: [
        {
          description: 'Work the request using the available tools and answer.',
          toolHint: null,
        },
      ],
    };
    await addEvent({
      runId,
      workspaceId,
      eventType: 'plan_fallback',
      message: 'Model planning unavailable — continuing with a single-step fallback plan.',
      data: { error },
    });
    return { plan: fallback, source: 'deterministic_fallback', providerId: null, error };
  }
}

/**
 * Persists the plan as pending steps so it is executable state, not chat
 * text. Returns how many were written.
 */
export async function persistPlan(
  runId: string,
  plan: AgentPlan
): Promise<number> {
  const existing = await listSteps(runId);
  const baseSequence = existing.length;
  let written = 0;
  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i];
    if (!step) continue;
    const created = await startStep({
      runId,
      sequence: baseSequence + i + 1,
      stepType: 'plan',
      description: step.description.slice(0, 300),
      toolName: step.toolHint ?? null,
      input: null,
    });
    if (created) written++;
  }
  return written;
}

/**
 * Aligns plan steps with the run's final outcome: the plan is marked
 * completed when the run completed, failed when it failed, etc. The
 * executed trajectory (tool/verify/respond steps) is the fine-grained
 * truth; this is the plan-of-record's ending state.
 */
export async function settlePlanSteps(
  runId: string,
  outcome: 'completed' | 'failed' | 'cancelled'
): Promise<void> {
  const steps = await listSteps(runId);
  const planSteps = steps.filter((s) => s.stepType === 'plan' && s.status === 'pending');
  for (const step of planSteps) {
    await finishStep(step.id, outcome === 'completed' ? 'completed' : outcome === 'failed' ? 'failed' : 'skipped');
  }
}
