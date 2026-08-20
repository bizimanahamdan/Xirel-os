import 'server-only';
import type {
  AiChunk,
  AiMessage,
  AiProvider,
  AiRequest,
  AiResponse,
  AiToolCall,
  AiToolDefinition,
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
 *
 * Function calling: request uses `tools: [{ functionDeclarations }]`;
 * responses may contain `functionCall` parts instead of/alongside text;
 * results are sent back as a `function`-role content with a
 * `functionResponse` part. This shape is ESPECIALLY unverified — Gemini's
 * function-calling multi-turn convention has changed across API versions.
 * Confirm against https://ai.google.dev/gemini-api/docs/function-calling
 * before routing agent tool calls through Gemini in production.
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
    .map((m) => {
      if (m.role === 'tool') {
        // Gemini's multi-turn function-calling convention: the tool result
        // goes back as a 'function' role content with a functionResponse part.
        // UNVERIFIED against a live call — see file-level note above.
        return {
          role: 'function',
          parts: [
            {
              functionResponse: {
                name: m.name ?? 'unknown_tool',
                response: { result: m.content },
              },
            },
          ],
        };
      }
      if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
        return {
          role: 'model',
          parts: m.toolCalls.map((tc) => ({
            functionCall: { name: tc.name, args: tc.arguments },
          })),
        };
      }
      return {
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      };
    });

  return {
    systemInstruction: systemParts.length > 0 ? { parts: systemParts } : undefined,
    contents,
  };
}

function toGeminiTools(tools: AiToolDefinition[] | undefined) {
  if (!tools || tools.length === 0) return undefined;
  return [
    {
      functionDeclarations: tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      })),
    },
  ];
}

interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args: Record<string, unknown> };
}

function extractText(parts: GeminiPart[] | undefined): string {
  return parts?.map((p) => p.text ?? '').join('') ?? '';
}

function extractToolCalls(parts: GeminiPart[] | undefined): AiToolCall[] | undefined {
  const calls = (parts ?? [])
    .filter((p): p is GeminiPart & { functionCall: NonNullable<GeminiPart['functionCall']> } =>
      Boolean(p.functionCall)
    )
    .map((p, i) => ({
      // Gemini's functionCall has no built-in call id — synthesize one so
      // AiToolCall.id can round-trip through the agent loop's tool results.
      id: `fc-${i}-${p.functionCall.name}`,
      name: p.functionCall.name,
      arguments: p.functionCall.args ?? {},
    }));
  return calls.length > 0 ? calls : undefined;
}

function geminiFinishReason(
  reason: string | undefined,
  hasToolCalls: boolean
): AiResponse['finishReason'] {
  if (hasToolCalls) return 'tool_calls';
  switch (reason) {
    case 'STOP':
      return 'stop';
    case 'MAX_TOKENS':
      return 'length';
    case 'SAFETY':
    case 'RECITATION':
      return 'content_filter';
    default:
      return 'unknown';
  }
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
        signal: AbortSignal.timeout(30_000),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents,
          systemInstruction,
          tools: toGeminiTools(request.tools),
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
    const candidate = data.candidates?.[0];
    const parts: GeminiPart[] | undefined = candidate?.content?.parts;
    const toolCalls = extractToolCalls(parts);

    return {
      text: extractText(parts),
      usage: {
        inputTokens: data.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
      },
      latencyMs: Date.now() - start,
      model: request.model,
      providerId: 'gemini',
      toolCalls,
      finishReason: geminiFinishReason(candidate?.finishReason, Boolean(toolCalls)),
    };
  },

  async *streamText(request: AiRequest): AsyncIterable<AiChunk> {
    const apiKey = getApiKey();
    const { systemInstruction, contents } = toGeminiContents(request.messages);

    const res = await fetch(
      `${GEMINI_API_BASE}/models/${request.model}:streamGenerateContent?alt=sse&key=${apiKey}`,
      {
        method: 'POST',
        signal: AbortSignal.timeout(30_000),
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
        signal: AbortSignal.timeout(30_000),
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
      const res = await fetch(`${GEMINI_API_BASE}/models?key=${getApiKey()}`, {
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
