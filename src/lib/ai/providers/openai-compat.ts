import type { AiMessage, AiResponse, AiToolCall, AiToolDefinition } from '../types';

/**
 * Shared conversion helpers for the OpenAI-compatible chat completions
 * wire format, used identically by Groq, OpenRouter, and Qwen. Kept in
 * one place so the three adapters can't drift out of sync with each
 * other on tool-calling behavior.
 */

/**
 * Per-attempt timeout for AI provider calls, used by generateText/
 * streamText/generateStructuredOutput across Groq, OpenRouter, Qwen,
 * and Gemini (Gemini keeps its own copy since it doesn't import this
 * file, to avoid a cross-shape dependency for one constant — kept in
 * sync manually, see gemini.ts).
 *
 * This value is NOT independent — it's sized against the Vercel
 * serverless function's maxDuration (see src/app/api/chat/route.ts,
 * currently 60s) and the DB call timeouts in the same request's hot
 * path (src/lib/tasks/queries.ts, src/app/api/chat/route.ts).
 * routeGenerateText/routeStreamText can fall back across up to 3
 * providers in one request, so the worst case for /api/chat is:
 *   createTask(5s) + insert user msg(5s) + getTaskMessages(6s)
 *   + 3 × PROVIDER_TIMEOUT_MS(12s) = 36s
 *   + updateTaskStatus(4s)
 *   = 56s, against a 60s maxDuration — ~4s headroom.
 * This must stay comfortably under maxDuration, or Vercel kills the
 * function before any of this codebase's own error handling can run
 * — which is exactly the silent-hang bug these timeouts were tuned to
 * close. If you raise maxDuration, raise this in proportion (and the
 * Gemini copy alongside it) — but re-run the arithmetic above rather
 * than guessing; a stale mental model of "the timeouts are generous"
 * is how they drifted out of budget the first time.
 */
export const PROVIDER_TIMEOUT_MS = 12_000;

export function toOpenAiMessages(messages: AiMessage[]) {
  return messages.map((m) => {
    if (m.role === 'tool') {
      return {
        role: 'tool' as const,
        tool_call_id: m.toolCallId,
        content: m.content,
      };
    }
    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
      return {
        role: 'assistant' as const,
        content: m.content || null,
        tool_calls: m.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.arguments),
          },
        })),
      };
    }
    return { role: m.role, content: m.content };
  });
}

export function toOpenAiTool(tool: AiToolDefinition) {
  return {
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  };
}

interface OpenAiToolCallWire {
  id: string;
  function: { name: string; arguments: string };
}

export function fromOpenAiToolCalls(
  toolCalls: OpenAiToolCallWire[] | undefined
): AiToolCall[] | undefined {
  if (!toolCalls || toolCalls.length === 0) return undefined;

  return toolCalls.map((tc) => {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(tc.function.arguments);
    } catch {
      // Model returned malformed JSON arguments — surface as empty args
      // rather than throwing, so the agent loop can decide how to handle it
      // (e.g. tell the model its arguments were invalid and ask it to retry).
    }
    return { id: tc.id, name: tc.function.name, arguments: args };
  });
}

export function fromOpenAiFinishReason(reason: string | undefined): AiResponse['finishReason'] {
  switch (reason) {
    case 'stop':
      return 'stop';
    case 'tool_calls':
      return 'tool_calls';
    case 'length':
      return 'length';
    case 'content_filter':
      return 'content_filter';
    default:
      return 'unknown';
  }
}
