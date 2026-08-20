import 'server-only';
import type {
  AiChunk,
  AiProvider,
  AiRequest,
  AiResponse,
  ProviderCapabilities,
  ProviderHealth,
  StructuredAiRequest,
} from '../types';
import { AiProviderError } from '../types';
import { isProviderConfigured } from '../config';
import {
  toOpenAiMessages,
  toOpenAiTool,
  fromOpenAiToolCalls,
  fromOpenAiFinishReason,
} from './openai-compat';

/**
 * Qwen adapter. "Qwen-compatible" per the project spec means: any
 * endpoint implementing the OpenAI chat-completions shape that serves
 * Qwen models — e.g. Alibaba Cloud DashScope's compatible-mode endpoint,
 * or a self-hosted Qwen deployment. QWEN_BASE_URL makes this swappable
 * without a code change.
 *
 * UNVERIFIED: written from documented API shape, not executed against
 * a live endpoint in this environment (no network access at build
 * time). Confirm QWEN_BASE_URL and model naming against whichever
 * Qwen host you actually use before relying on this.
 */

function getConfig(): { apiKey: string; baseUrl: string } {
  const apiKey = process.env.QWEN_API_KEY;
  const baseUrl = process.env.QWEN_BASE_URL;
  if (!apiKey || !baseUrl) {
    throw new AiProviderError(
      'QWEN_API_KEY and QWEN_BASE_URL must both be set',
      'qwen',
      undefined,
      false
    );
  }
  return { apiKey, baseUrl: baseUrl.replace(/\/$/, '') };
}

export const qwenProvider: AiProvider = {
  id: 'qwen',

  isConfigured() {
    return isProviderConfigured('qwen');
  },

  async generateText(request: AiRequest): Promise<AiResponse> {
    const start = Date.now();
    const { apiKey, baseUrl } = getConfig();

    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      signal: AbortSignal.timeout(30_000),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: request.model,
        messages: toOpenAiMessages(request.messages),
        temperature: request.temperature ?? 0.7,
        max_tokens: request.maxOutputTokens,
        tools: request.tools?.map(toOpenAiTool),
        stream: false,
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new AiProviderError(
        `Qwen request failed: ${res.status} ${res.statusText} ${body}`,
        'qwen',
        undefined,
        res.status === 429 || res.status >= 500
      );
    }

    const data = await res.json();
    const choice = data.choices?.[0];

    if (!choice) {
      throw new AiProviderError('Qwen response had no choices', 'qwen', data, false);
    }

    return {
      text: choice.message?.content ?? '',
      usage: {
        inputTokens: data.usage?.prompt_tokens ?? 0,
        outputTokens: data.usage?.completion_tokens ?? 0,
      },
      latencyMs: Date.now() - start,
      model: request.model,
      providerId: 'qwen',
      toolCalls: fromOpenAiToolCalls(choice.message?.tool_calls),
      finishReason: fromOpenAiFinishReason(choice.finish_reason),
    };
  },

  async *streamText(request: AiRequest): AsyncIterable<AiChunk> {
    const { apiKey, baseUrl } = getConfig();

    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      signal: AbortSignal.timeout(30_000),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: request.model,
        messages: toOpenAiMessages(request.messages),
        temperature: request.temperature ?? 0.7,
        max_tokens: request.maxOutputTokens,
        stream: true,
      }),
    });

    if (!res.ok || !res.body) {
      const body = await res.text().catch(() => '');
      throw new AiProviderError(
        `Qwen stream request failed: ${res.status} ${res.statusText} ${body}`,
        'qwen',
        undefined,
        res.status === 429 || res.status >= 500
      );
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === '[DONE]') {
          yield { text: '', done: true };
          return;
        }
        try {
          const parsed = JSON.parse(payload);
          const delta = parsed.choices?.[0]?.delta?.content ?? '';
          if (delta) yield { text: delta, done: false };
        } catch {
          // Partial chunk — skip, next read completes it.
        }
      }
    }

    yield { text: '', done: true };
  },

  async generateStructuredOutput<T>(request: StructuredAiRequest<T>): Promise<T> {
    const { apiKey, baseUrl } = getConfig();

    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      signal: AbortSignal.timeout(30_000),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: request.model,
        messages: toOpenAiMessages(request.messages),
        temperature: request.temperature ?? 0,
        response_format: {
          type: 'json_schema',
          json_schema: { name: request.schemaName, schema: request.schema },
        },
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new AiProviderError(
        `Qwen structured output request failed: ${res.status} ${body}`,
        'qwen',
        undefined,
        res.status === 429 || res.status >= 500
      );
    }

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content;

    if (!content) {
      throw new AiProviderError(
        'Qwen structured output response had no content',
        'qwen',
        data,
        false
      );
    }

    try {
      return JSON.parse(content) as T;
    } catch (err) {
      throw new AiProviderError(
        `Qwen returned content that was not valid JSON for schema "${request.schemaName}"`,
        'qwen',
        err,
        false
      );
    }
  },

  getCapabilities(): ProviderCapabilities {
    // These vary significantly by which Qwen model + host you point
    // QWEN_BASE_URL at. Treat as a rough default, not a guarantee.
    return {
      supportsStreaming: true,
      supportsStructuredOutput: true,
      supportsTools: true,
      supportsVision: false,
      maxContextTokens: 32_000,
      hasFreeTier: true, // depends entirely on the chosen host/plan
    };
  },

  async healthCheck(): Promise<ProviderHealth> {
    if (!isProviderConfigured('qwen')) {
      return { status: 'not_configured', checkedAt: new Date().toISOString() };
    }

    try {
      const { apiKey, baseUrl } = getConfig();
      const res = await fetch(`${baseUrl}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(8_000),
      });
      return {
        status: res.ok ? 'healthy' : 'degraded',
        checkedAt: new Date().toISOString(),
        detail: res.ok ? undefined : `${res.status} ${res.statusText}`,
      };
    } catch (err) {
      return {
        status: 'unavailable',
        checkedAt: new Date().toISOString(),
        detail: err instanceof Error ? err.message : 'Unknown error',
      };
    }
  },
};
