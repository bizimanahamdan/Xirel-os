import type { AiMessage, AiResponse, AiToolCall, AiToolDefinition } from '../types';

/**
 * Shared conversion helpers for the OpenAI-compatible chat completions
 * wire format, used identically by Groq, OpenRouter, and Qwen. Kept in
 * one place so the three adapters can't drift out of sync with each
 * other on tool-calling behavior.
 */

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
