import 'server-only';
import { db } from '@/lib/db';
import { workspaceMembers, toolExecutions } from '@/lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { routeGenerateText, type RouteRequest } from '@/lib/ai/router';
import { getDefaultModel } from '@/lib/ai/models';
import type { AiMessage, AiProviderId, AiToolCall } from '@/lib/ai/types';
import { getAllTools, getTool, toAiToolDefinitions } from './tools/registry';
import type { ToolPermission } from './tools/types';

/**
 * Orchestrator Agent (Phase 3)
 *
 * This is the first and currently only agent. Per the project spec's
 * agent list (Orchestrator, Developer, Research, ...), the other agents
 * are NOT implemented here — each needs its own tool set and system
 * prompt, and building empty placeholders for them now would be the
 * same "stub now, hope it's right later" problem the spec explicitly
 * warns against. The Orchestrator is the one agent Phase 3 actually
 * needs: something that can hold a conversation AND call tools when
 * the model asks to.
 *
 * The loop: call the model with available tools -> if it asks to call
 * one or more tools, execute them (permission-checked, logged) and feed
 * the results back as role:'tool' messages -> call the model again ->
 * repeat until it responds with plain text or the iteration cap is hit.
 */

const MAX_ITERATIONS = 6;

const PERMISSION_RANK: Record<'viewer' | 'member' | 'admin' | 'owner', number> = {
  viewer: 0,
  member: 1,
  admin: 2,
  owner: 3,
};

export interface OrchestratorRunRequest {
  workspaceId: string;
  userId: string;
  taskId: string;
  messages: AiMessage[];
  providerPriority: AiProviderId[];
  /** Optional per-provider model override; falls back to each provider's default (src/lib/ai/models.ts). */
  modelByProvider?: Partial<Record<AiProviderId, string>>;
}

export interface OrchestratorRunResult {
  /** Final assistant-facing text. */
  text: string;
  /** Every message added during this run (assistant tool-call turns, tool results, final answer) — append these to the task's stored message history. */
  newMessages: AiMessage[];
  providerId: AiProviderId;
  iterations: number;
}

async function getWorkspaceRole(
  workspaceId: string,
  userId: string
): Promise<'viewer' | 'member' | 'admin' | 'owner' | null> {
  const membership = await db.query.workspaceMembers.findFirst({
    where: and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)),
    columns: { role: true },
  });
  return membership?.role ?? null;
}

function hasPermission(
  userRole: 'viewer' | 'member' | 'admin' | 'owner',
  required: ToolPermission
): boolean {
  return PERMISSION_RANK[userRole] >= PERMISSION_RANK[required];
}

async function logToolExecution(params: {
  taskId: string;
  toolName: string;
  riskLevel: string;
  input: Record<string, unknown>;
  output: Record<string, unknown> | undefined;
  success: boolean;
  error: string | undefined;
}) {
  try {
    await db.insert(toolExecutions).values({
      taskId: params.taskId,
      toolName: params.toolName,
      riskLevel: params.riskLevel as never,
      input: params.input,
      output: params.output ?? null,
      success: params.success,
      error: params.error,
    });
  } catch (err) {
    // Logging failure must never take down the agent loop — surface to
    // server logs only, the tool call itself already succeeded or failed
    // independently of whether we could record it.
    console.error('Failed to log tool execution:', err);
  }
}

async function executeToolCall(
  call: AiToolCall,
  ctx: { workspaceId: string; userId: string; taskId: string },
  userRole: 'viewer' | 'member' | 'admin' | 'owner'
): Promise<string> {
  const tool = getTool(call.name);

  if (!tool) {
    const error = `Unknown tool "${call.name}". No tool with that name is registered.`;
    await logToolExecution({
      taskId: ctx.taskId,
      toolName: call.name,
      riskLevel: 'safe',
      input: call.arguments,
      output: undefined,
      success: false,
      error,
    });
    return JSON.stringify({ success: false, error });
  }

  if (!hasPermission(userRole, tool.requiredPermission)) {
    const error = `Permission denied: tool "${tool.name}" requires role "${tool.requiredPermission}" or higher; caller has "${userRole}".`;
    await logToolExecution({
      taskId: ctx.taskId,
      toolName: tool.name,
      riskLevel: tool.riskLevel,
      input: call.arguments,
      output: undefined,
      success: false,
      error,
    });
    return JSON.stringify({ success: false, error });
  }

  const parsed = tool.inputSchema.safeParse(call.arguments);
  if (!parsed.success) {
    const error = `Invalid arguments for tool "${tool.name}": ${parsed.error.message}`;
    await logToolExecution({
      taskId: ctx.taskId,
      toolName: tool.name,
      riskLevel: tool.riskLevel,
      input: call.arguments,
      output: undefined,
      success: false,
      error,
    });
    return JSON.stringify({ success: false, error });
  }

  try {
    const result = await tool.execute(parsed.data, ctx);
    await logToolExecution({
      taskId: ctx.taskId,
      toolName: tool.name,
      riskLevel: tool.riskLevel,
      input: call.arguments,
      output: result.output as Record<string, unknown> | undefined,
      success: result.success,
      error: result.error,
    });
    return JSON.stringify(result);
  } catch (err) {
    // A tool's execute() throwing is a bug in the tool, not a reason to
    // crash the agent loop — surface it to the model as a failed result
    // so it can decide how to proceed (retry, try another approach, tell
    // the user), same as any other tool failure.
    const error = err instanceof Error ? err.message : 'Tool execution threw an unexpected error';
    await logToolExecution({
      taskId: ctx.taskId,
      toolName: tool.name,
      riskLevel: tool.riskLevel,
      input: call.arguments,
      output: undefined,
      success: false,
      error,
    });
    return JSON.stringify({ success: false, error });
  }
}

export async function runOrchestrator(
  request: OrchestratorRunRequest
): Promise<OrchestratorRunResult> {
  const userRole = await getWorkspaceRole(request.workspaceId, request.userId);
  if (!userRole) {
    throw new Error('Caller is not a member of this workspace — cannot run agent.');
  }

  if (request.providerPriority.length === 0) {
    throw new Error('runOrchestrator: providerPriority was empty — no provider to route to.');
  }

  const availableTools = getAllTools().filter((t) => hasPermission(userRole, t.requiredPermission));
  const aiTools = toAiToolDefinitions(availableTools);

  const conversation: AiMessage[] = [...request.messages];
  const newMessages: AiMessage[] = [];
  let lastProviderId: AiProviderId = request.providerPriority[0] ?? 'openrouter';

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    const primaryProvider = request.providerPriority[0];
    const routeRequest: RouteRequest = {
      messages: conversation,
      // `model` is required by AiRequest but is only actually used when a
      // provider has no modelByProvider entry — every provider we route to
      // here does, via getDefaultModel's fallback below, so this is just
      // a safe placeholder for the type.
      model: request.modelByProvider?.[primaryProvider] ?? getDefaultModel(primaryProvider),
      providerPriority: request.providerPriority,
      modelByProvider: {
        ...Object.fromEntries(
          request.providerPriority.map((p) => [p, request.modelByProvider?.[p] ?? getDefaultModel(p)])
        ),
      },
      tools: aiTools.length > 0 ? aiTools : undefined,
    };

    const response = await routeGenerateText(routeRequest);
    lastProviderId = response.providerId;

    if (response.finishReason !== 'tool_calls' || !response.toolCalls?.length) {
      // Model gave a final answer — done.
      const finalMessage: AiMessage = { role: 'assistant', content: response.text };
      newMessages.push(finalMessage);
      return {
        text: response.text,
        newMessages,
        providerId: response.providerId,
        iterations: iteration + 1,
      };
    }

    // Model wants to call tools. Record its tool-call turn, execute each
    // tool, then feed results back and loop.
    const assistantToolCallMessage: AiMessage = {
      role: 'assistant',
      content: response.text ?? '',
      toolCalls: response.toolCalls,
    };
    conversation.push(assistantToolCallMessage);
    newMessages.push(assistantToolCallMessage);

    for (const call of response.toolCalls) {
      const resultJson = await executeToolCall(
        call,
        { workspaceId: request.workspaceId, userId: request.userId, taskId: request.taskId },
        userRole
      );
      const toolResultMessage: AiMessage = {
        role: 'tool',
        content: resultJson,
        toolCallId: call.id,
        name: call.name,
      };
      conversation.push(toolResultMessage);
      newMessages.push(toolResultMessage);
    }
  }

  // Hit the iteration cap without a final answer — surface this honestly
  // rather than silently returning an empty/truncated response.
  const fallbackMessage: AiMessage = {
    role: 'assistant',
    content:
      "I made several tool calls but couldn't reach a final answer within the step limit. Here's what I found so far — let me know if you'd like me to continue.",
  };
  newMessages.push(fallbackMessage);
  return {
    text: fallbackMessage.content,
    newMessages,
    providerId: lastProviderId,
    iterations: MAX_ITERATIONS,
  };
}
