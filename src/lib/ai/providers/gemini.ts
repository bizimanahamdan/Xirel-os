import 'server-only';
import type {
  AiChunk,
  AiMessage,
  AiProvider,
  AiRequest,
  AiResponse,
  ProviderCapabilities,
  ProviderHealth,
  StructuredAiRequest,
} from '../types';
import { AiProviderError } from '../types';
import { isProviderConfigured } from '../config';

/**
 * Gemini adapter, using Google's Generative Language REST API directly
 * (no SDK dependency, to keep the provider layer lightweight).
 *
 * UNVERIFIED: written from documented API shape, not executed against
 * the live endpoint in this environment (no network access at build
 * time). Before relying on this in production: run one real request
 * per method and confirm against https://ai.google.dev/api.
 *
 * Gemini has no separate "system" role — system instructions are sent
 * via a dedicated `systemInstruction` field, so we split messages here.
 */

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

function getApiKey(): string {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    throw new AiProviderError('GEMINI_API_KEY is not set', 'gemini', undefined, false);
  }
  return key;
}

function toGeminiContents(messages: AiMessage[]) {
  const systemParts = messages
    .filter((m) => m.role === 'system')
    .map((m) => ({ text: m.content }));

  const contents = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

  return {
    systemInstruction: systemParts.length > 0 ? { parts: systemParts } : undefined,
    contents,
  };
}

export const geminiProvider: AiProvider = {
  id: 'gemini',

  isConfigured() {
    return isProviderConfigured('gemini');
  },

  async generateText(request: AiRequest): Promise<AiResponse> {
    const start = Date.now();
    const apiKey = getApiKey();
    const { systemInstruction, contents } = toGeminiContents(request.messages);

    const res = await fetch(
      `${GEMINI_API_BASE}/models/${request.model}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents,
          systemInstruction,
          generationConfig: {
            temperature: request.temperature ?? 0.7,
            maxOutputTokens: request.maxOutputTokens,
          },
        }),
      }
    );

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new AiProviderError(
        `Gemini request failed: ${res.status} ${res.statusText} ${body}`,
        'gemini',
        undefined,
        res.status === 429 || res.status >= 500
      );
    }

    const data = await res.json();
    const text =
      data.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? '').join('') ??
      '';

    return {
      text,
      usage: {
        inputTokens: data.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
      },
      latencyMs: Date.now() - start,
      model: request.model,
      providerId: 'gemini',
    };
  },

  async *streamText(request: AiRequest): AsyncIterable<AiChunk> {
    const apiKey = getApiKey();
    const { systemInstruction, contents } = toGeminiContents(request.messages);

    const res = await fetch(
      `${GEMINI_API_BASE}/models/${request.model}:streamGenerateContent?alt=sse&key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents,
          systemInstruction,
          generationConfig: {
            temperature: request.temperature ?? 0.7,
            maxOutputTokens: request.maxOutputTokens,
          },
        }),
      }
    );

    if (!res.ok || !res.body) {
      const body = await res.text().catch(() => '');
      throw new AiProviderError(
        `Gemini stream request failed: ${res.status} ${res.statusText} ${body}`,
        'gemini',
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
        if (!payload) continue;
        try {
          const parsed = JSON.parse(payload);
          const text =
            parsed.candidates?.[0]?.content?.parts
              ?.map((p: { text?: string }) => p.text ?? '')
              .join('') ?? '';
          if (text) yield { text, done: false };
        } catch {
          // Partial chunk split across reads — skip, matches Groq adapter behavior.
        }
      }
    }

    yield { text: '', done: true };
  },

  async generateStructuredOutput<T>(request: StructuredAiRequest<T>): Promise<T> {
    const apiKey = getApiKey();
    const { systemInstruction, contents } = toGeminiContents(request.messages);

    const res = await fetch(
      `${GEMINI_API_BASE}/models/${request.model}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents,
          systemInstruction,
          generationConfig: {
            temperature: request.temperature ?? 0,
            responseMimeType: 'application/json',
            responseSchema: request.schema,
          },
        }),
      }
    );

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new AiProviderError(
        `Gemini structured output request failed: ${res.status} ${body}`,
        'gemini',
        undefined,
        res.status === 429 || res.status >= 500
      );
    }

    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!text) {
      throw new AiProviderError(
        'Gemini structured output response had no content',
        'gemini',
        data,
        false
      );
    }

    try {
      return JSON.parse(text) as T;
    } catch (err) {
      throw new AiProviderError(
        `Gemini returned content that was not valid JSON for schema "${request.schemaName}"`,
        'gemini',
        err,
        false
      );
    }
  },

  getCapabilities(): ProviderCapabilities {
    // Verify current model list, context windows, and rate limits at
    // https://ai.google.dev/gemini-api/docs/models before routing —
    // these values change with new Gemini releases.
    return {
      supportsStreaming: true,
      supportsStructuredOutput: true,
      supportsTools: true,
      supportsVision: true,
      maxContextTokens: 1_000_000, // Gemini's flagship long-context models; smaller variants differ
      hasFreeTier: true,
    };
  },

  async healthCheck(): Promise<ProviderHealth> {
    if (!isProviderConfigured('gemini')) {
      return { status: 'not_configured', checkedAt: new Date().toISOString() };
    }

    try {
      const res = await fetch(`${GEMINI_API_BASE}/models?key=${getApiKey()}`);
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
