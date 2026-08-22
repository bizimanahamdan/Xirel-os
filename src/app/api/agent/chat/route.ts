import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { createSupabaseServerClient } from '@/lib/auth/supabase-server';
import { db } from '@/lib/db';
import { workspaceMembers, messages as messagesTable } from '@/lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { getConfiguredProviderInstances } from '@/lib/ai/registry';
import { runOrchestrator } from '@/lib/agents/orchestrator';
import {
  createTask,
  getTaskMessagesForAgent,
  saveAgentMessages,
  updateTaskStatus,
} from '@/lib/tasks/queries';
import type { AiProviderId } from '@/lib/ai/types';

/**
 * See src/app/api/chat/route.ts's maxDuration comment for why this
 * exists at all (Vercel's Hobby default is 10s).
 *
 * UNRESOLVED GAP, flagged rather than silently left: runOrchestrator
 * (src/lib/agents/orchestrator.ts) can loop up to MAX_ITERATIONS (6)
 * times, and each iteration can fall back across up to 3 providers at
 * PROVIDER_TIMEOUT_MS (12s) each. Theoretical worst case is
 * 6 × 3 × 12s = 216s — far beyond what's practical to set here. This
 * endpoint was already documented as untested against live systems
 * (PHASE_3_AGENT_FRAMEWORK.md); this is a second, related reason it
 * isn't production-ready as-is. A real fix needs an overall deadline
 * threaded through runOrchestrator (each attempt gets whatever time
 * remains in the request's budget, not its own fresh timeout) rather
 * than more tuning of independent per-call numbers — out of scope for
 * this pass, which is focused on the actively-reported /api/chat hang.
 * 60s is a reasonable stopgap for now, not a real fix for this gap.
 */
export const maxDuration = 60;

/**
 * POST /api/agent/chat
 *
 * Phase 3: runs the Orchestrator Agent (tool-calling capable) instead of
 * the plain streaming chat in /api/chat. Deliberately a SEPARATE endpoint
 * rather than modifying /api/chat — Phase 2's plain chat is verified
 * working and untouched; this is new, additive functionality.
 *
 * Not streamed: the agentic loop needs each full response (to inspect
 * finishReason and toolCalls) before it can decide whether to continue,
 * so there is no meaningful "stream of tokens" until the FINAL answer.
 * A future iteration could stream just the final iteration's text; not
 * done here to keep this slice's scope honest about what's implemented.
 *
 * Request body:
 *   {
 *     "taskId": "uuid or null (null = create new task)",
 *     "message": "user message text",
 *     "workspaceId": "workspace uuid",
 *     "providerPriority": ["openrouter", "groq"] // optional, defaults to configured providers
 *   }
 */

const agentChatRequestSchema = z.object({
  taskId: z.string().uuid().optional().nullable(),
  message: z.string().min(1, 'Message cannot be empty').max(10000),
  workspaceId: z.string().uuid(),
  providerPriority: z.array(z.string()).optional(),
});

const VALID_PROVIDER_IDS: AiProviderId[] = [
  'gemini',
  'groq',
  'qwen',
  'moonshot',
  'openai',
  'anthropic',
  'openrouter',
];

export async function POST(request: NextRequest) {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const parsed = agentChatRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request', details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { taskId, message, workspaceId, providerPriority } = parsed.data;

  // Verify workspace membership before doing anything else — the
  // orchestrator re-checks this internally for tool permission, but
  // failing fast here avoids creating a task for a non-member.
  const membership = await db.query.workspaceMembers.findFirst({
    where: and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, user.id)),
  });
  if (!membership) {
    return NextResponse.json({ error: 'Not a member of this workspace' }, { status: 403 });
  }

  // Resolve provider priority the same way /api/chat does, for consistency.
  let providers: AiProviderId[] = [];
  if (providerPriority && Array.isArray(providerPriority)) {
    providers = providerPriority.filter((p): p is AiProviderId =>
      VALID_PROVIDER_IDS.includes(p as AiProviderId)
    );
  }
  if (providers.length === 0) {
    providers = getConfiguredProviderInstances().map((p) => p.id);
  }
  if (providers.length === 0) {
    return NextResponse.json({ error: 'No AI providers configured' }, { status: 500 });
  }

  // Create or reuse task.
  let currentTaskId = taskId;
  if (!currentTaskId) {
    try {
      const newTask = await createTask(workspaceId, user.id, message.slice(0, 100));
      currentTaskId = newTask.id;
    } catch (err) {
      console.error('Failed to create task:', err);
      return NextResponse.json({ error: 'Failed to create task' }, { status: 500 });
    }
  }

  // Store the user's message first, so it's part of history even if the
  // agent run fails partway through.
  try {
    await db.insert(messagesTable).values({
      taskId: currentTaskId,
      role: 'user',
      content: message,
    });
  } catch (err) {
    console.error('Failed to store user message:', err);
    return NextResponse.json({ error: 'Failed to store message' }, { status: 500 });
  }

  try {
    const history = await getTaskMessagesForAgent(currentTaskId);

    const result = await runOrchestrator({
      workspaceId,
      userId: user.id,
      taskId: currentTaskId,
      messages: history,
      providerPriority: providers,
    });

    // Persist everything the agent produced this turn (tool-call turns,
    // tool results, and the final answer) so a page refresh or resumed
    // conversation sees the full trace, not just the final text.
    await saveAgentMessages(currentTaskId, result.newMessages);
    await updateTaskStatus(currentTaskId, 'completed');

    return NextResponse.json({
      taskId: currentTaskId,
      text: result.text,
      providerId: result.providerId,
      iterations: result.iterations,
    });
  } catch (err) {
    console.error('Agent run failed:', err);
    try {
      await updateTaskStatus(currentTaskId, 'failed');
    } catch {
      // Silent — the client already gets the error below.
    }
    const errMessage = err instanceof Error ? err.message : 'Agent run failed';
    return NextResponse.json({ error: errMessage, taskId: currentTaskId }, { status: 500 });
  }
}
