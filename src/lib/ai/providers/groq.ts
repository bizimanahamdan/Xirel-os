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
 * Groq adapter. Groq exposes an OpenAI-compatible chat completions API,
 * which is why this adapter's request/response shape looks like OpenAI's.
 *
 * UNVERIFIED: written from documented API shape, not executed against
 * the live endpoint in this environment (no network access at build
 * time). Before relying on this in production: run one real request
 * per method and confirm against https://console.groq.com/docs.
 */

const GROQ_API_BASE = 'https://api.groq.com/openai/v1';

function getApiKey(): string {
  const key = process.env.GROQ_API_KEY;
  if (!key) {
    throw new AiProviderError('GROQ_API_KEY is not set', 'groq', undefined, false);
  }
  return key;
}

export const groqProvider: AiProvider = {
  id: 'groq',

  isConfigured() {
    return isProviderConfigured('groq');
  },

  async generateText(request: AiRequest): Promise<AiResponse> {
    const start = Date.now();
    const apiKey = getApiKey();

    const res = await fetch(`${GROQ_API_BASE}/chat/completions`, {
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
        `Groq request failed: ${res.status} ${res.statusText} ${body}`,
        'groq',
        undefined,
        res.status === 429 || res.status >= 500
      );
    }

    const data = await res.json();
    const choice = data.choices?.[0];

    if (!choice) {
      throw new AiProviderError('Groq response had no choices', 'groq', data, false);
    }

    return {
      text: choice.message?.content ?? '',
      usage: {
        inputTokens: data.usage?.prompt_tokens ?? 0,
        outputTokens: data.usage?.completion_tokens ?? 0,
      },
      latencyMs: Date.now() - start,
      model: request.model,
      providerId: 'groq',
      toolCalls: fromOpenAiToolCalls(choice.message?.tool_calls),
      finishReason: fromOpenAiFinishReason(choice.finish_reason),
    };
  },

  async *streamText(request: AiRequest): AsyncIterable<AiChunk> {
    const apiKey = getApiKey();

    const res = await fetch(`${GROQ_API_BASE}/chat/completions`, {
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
        `Groq stream request failed: ${res.status} ${res.statusText} ${body}`,
        'groq',
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
          // Partial chunk split across reads — skip, next read will complete it.
          // If this happens frequently in testing, buffer by SSE event boundary
          // instead of by line.
        }
      }
    }

    yield { text: '', done: true };
  },

  async generateStructuredOutput<T>(request: StructuredAiRequest<T>): Promise<T> {
    // Groq's OpenAI-compatible API supports `response_format: json_schema`
    // on some models only — verify against current docs per model before
    // relying on this in a workflow that requires strict schema adherence.
    const start = Date.now();
    const apiKey = getApiKey();

    const res = await fetch(`${GROQ_API_BASE}/chat/completions`, {
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
        `Groq structured output request failed: ${res.status} ${body}`,
        'groq',
        undefined,
        res.status === 429 || res.status >= 500
      );
    }

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content;

    if (!content) {
      throw new AiProviderError(
        'Groq structured output response had no content',
        'groq',
        data,
        false
      );
    }

    try {
      return JSON.parse(content) as T;
    } catch (err) {
      throw new AiProviderError(
        `Groq returned content that was not valid JSON for schema "${request.schemaName}"`,
        'groq',
        err,
        false
      );
    } finally {
      void start; // latency not currently surfaced for structured calls
    }
  },

  getCapabilities(): ProviderCapabilities {
    // Groq's value proposition is inference speed on open-weight models
    // (e.g. Llama, Mixtral family) — good fit for fast/cheap routing tiers.
    // Confirm current model list and context sizes at
    // https://console.groq.com/docs/models before routing to a specific one.
    return {
      supportsStreaming: true,
      supportsStructuredOutput: true,
      supportsTools: true,
      supportsVision: false,
      maxContextTokens: 32_000, // conservative floor — varies by model, verify per-model
      hasFreeTier: true,
    };
  },

  async healthCheck(): Promise<ProviderHealth> {
    if (!isProviderConfigured('groq')) {
      return { status: 'not_configured', checkedAt: new Date().toISOString() };
    }

    try {
      const res = await fetch(`${GROQ_API_BASE}/models`, {
        headers: { Authorization: `Bearer ${getApiKey()}` },
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
