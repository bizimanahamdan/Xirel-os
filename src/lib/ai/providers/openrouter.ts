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
  PROVIDER_TIMEOUT_MS,
} from './openai-compat';

/**
 * OpenRouter adapter. OpenRouter is an aggregator that routes requests to
 * underlying models (Claude, GPT, Llama, etc.) through a unified OpenAI-
 * compatible API. Since the request/response shape is OpenAI-compatible,
 * this adapter mirrors groq.ts largely — the key difference is the base
 * URL and credential handling.
 *
 * OpenRouter also requires a unique feature: the X-Title header, which
 * helps them understand usage patterns (not required but recommended).
 *
 * UNVERIFIED: written from documented API shape, not executed against
 * live endpoint. Confirm against https://openrouter.ai/docs before
 * relying on this in production. Model names must be qualified
 * (e.g. "openai/gpt-4", "anthropic/claude-3-opus") per OpenRouter's
 * naming scheme.
 */

const OPENROUTER_API_BASE = 'https://openrouter.ai/api/v1';

function getApiKey(): string {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) {
    throw new AiProviderError('OPENROUTER_API_KEY is not set', 'openrouter', undefined, false);
  }
  return key;
}

export const openrouterProvider: AiProvider = {
  id: 'openrouter',

  isConfigured() {
    return isProviderConfigured('openrouter');
  },

  async generateText(request: AiRequest): Promise<AiResponse> {
    const start = Date.now();
    const apiKey = getApiKey();

    const res = await fetch(`${OPENROUTER_API_BASE}/chat/completions`, {
      method: 'POST',
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000',
        'X-Title': 'Xirel OS',
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
        `OpenRouter request failed: ${res.status} ${res.statusText} ${body}`,
        'openrouter',
        undefined,
        res.status === 429 || res.status >= 500
      );
    }

    const data = await res.json();
    const choice = data.choices?.[0];

    if (!choice) {
      throw new AiProviderError('OpenRouter response had no choices', 'openrouter', data, false);
    }

    return {
      text: choice.message?.content ?? '',
      usage: {
        inputTokens: data.usage?.prompt_tokens ?? 0,
        outputTokens: data.usage?.completion_tokens ?? 0,
      },
      latencyMs: Date.now() - start,
      model: request.model,
      providerId: 'openrouter',
      toolCalls: fromOpenAiToolCalls(choice.message?.tool_calls),
      finishReason: fromOpenAiFinishReason(choice.finish_reason),
    };
  },

  async *streamText(request: AiRequest): AsyncIterable<AiChunk> {
    const apiKey = getApiKey();

    const res = await fetch(`${OPENROUTER_API_BASE}/chat/completions`, {
      method: 'POST',
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000',
        'X-Title': 'Xirel OS',
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
        `OpenRouter stream request failed: ${res.status} ${res.statusText} ${body}`,
        'openrouter',
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
          // Partial chunk split across reads — skip, next read completes it.
        }
      }
    }

    yield { text: '', done: true };
  },

  async generateStructuredOutput<T>(request: StructuredAiRequest<T>): Promise<T> {
    const apiKey = getApiKey();

    const res = await fetch(`${OPENROUTER_API_BASE}/chat/completions`, {
      method: 'POST',
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000',
        'X-Title': 'Xirel OS',
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
        `OpenRouter structured output request failed: ${res.status} ${body}`,
        'openrouter',
        undefined,
        res.status === 429 || res.status >= 500
      );
    }

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content;

    if (!content) {
      throw new AiProviderError(
        'OpenRouter structured output response had no content',
        'openrouter',
        data,
        false
      );
    }

    try {
      return JSON.parse(content) as T;
    } catch (err) {
      throw new AiProviderError(
        `OpenRouter returned content that was not valid JSON for schema "${request.schemaName}"`,
        'openrouter',
        err,
        false
      );
    }
  },

  getCapabilities(): ProviderCapabilities {
    // OpenRouter routes to multiple underlying models. These values are
    // a conservative baseline — OpenRouter supports models with much larger
    // context windows (Claude 3.5 Sonnet has 200k), but we default low to
    // guarantee we work with every model they offer. Per-model capability
    // detection is a Phase 3 feature.
    return {
      supportsStreaming: true,
      supportsStructuredOutput: true,
      supportsTools: true,
      supportsVision: true,
      maxContextTokens: 32_000,
      hasFreeTier: false, // OpenRouter requires a credit card, but has low minimums
    };
  },

  async healthCheck(): Promise<ProviderHealth> {
    if (!isProviderConfigured('openrouter')) {
      return { status: 'not_configured', checkedAt: new Date().toISOString() };
    }

    try {
      const res = await fetch(`${OPENROUTER_API_BASE}/models`, {
        headers: {
          Authorization: `Bearer ${getApiKey()}`,
          'HTTP-Referer': process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000',
        },
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
