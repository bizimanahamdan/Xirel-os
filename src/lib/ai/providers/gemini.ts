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
 * Kept as a separate constant from PROVIDER_TIMEOUT_MS (openai-compat.ts)
 * since Gemini doesn't share that file's wire format and importing it
 * just for one constant seemed like the wrong dependency to introduce.
 * Must be changed together with PROVIDER_TIMEOUT_MS — see that
 * constant's comment for why this value is what it is (sized against
 * the request's overall Vercel maxDuration budget, not arbitrary).
 */
const GEMINI_TIMEOUT_MS = 12_000;

/**
 * Gemini adapter, using Google's Generative Language REST API directly
 * (no SDK dependency, to keep the provider layer lightweight).
 *
 * WIRE FORMAT VERIFIED 2026-09-22 against https://ai.google.dev/api —
 * the endpoint paths, auth header, request body fields and SSE stream
 * shape below are the currently documented ones (see the verification
 * note above GEMINI_API_BASE). What still can't be exercised from this
 * environment is a LIVE request with a real key — confirm that once in
 * production via /api/ai/health with real credentials before routing
 * significant traffic.
 *
 * Gemini has no separate "system" role — system instructions are sent
 * via a dedicated `systemInstruction` field, so we split messages here.
 *
 * Function calling: request uses `tools: [{ functionDeclarations }]`;
 * responses may contain `functionCall` parts instead of/alongside text;
 * results are sent back as a `function`-role content with a
 * `functionResponse` part. Re-confirm this multi-turn convention
 * against https://ai.google.dev/gemini-api/docs/function-calling before
 * relying on agent tool calls through Gemini in production.
 */

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

/**
 * VERIFIED 2026-09-22 against https://ai.google.dev/api/generate-content
 * and the current REST streaming examples:
 *   - Endpoint  POST {base}/models/{model}:generateContent
 *   - Streaming POST {base}/models/{model}:streamGenerateContent?alt=sse
 *     (alt=sse = server-sent events, one GenerateContentResponse JSON per
 *     `data:` line — exactly what the SSE parser below consumes)
 *   - Auth      x-goog-api-key header (the `?key=` query param also works,
 *     but URLs get recorded in proxy/platform logs, so the header is used
 *     to keep the key out of logs)
 * The v1beta path is the currently documented REST generation API — do
 * not confuse it with the separate higher-level v1beta/interactions API,
 * which is a different abstraction this adapter deliberately doesn't use.
 */

function getApiKey(): string {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    throw new AiProviderError('GEMINI_API_KEY is not set', 'gemini', undefined, false);
  }
  return key;
}

function geminiHeaders(apiKey: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'x-goog-api-key': apiKey,
  };
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
  /**
   * Thinking models (2.5 series and all Gemini 3.x) can include
   * thought-summary parts in their response. These carry intermediate
   * reasoning, NOT the answer — they must be excluded from extracted
   * text or reasoning text leaks into the chat UI.
   */
  thought?: boolean;
}

function extractText(parts: GeminiPart[] | undefined): string {
  return parts
    ?.filter((p) => !p.thought)
    .map((p) => p.text ?? '')
    .join('') ?? '';
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
      `${GEMINI_API_BASE}/models/${request.model}:generateContent`,
      {
        method: 'POST',
        signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
        headers: geminiHeaders(apiKey),
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
      `${GEMINI_API_BASE}/models/${request.model}:streamGenerateContent?alt=sse`,
      {
        method: 'POST',
        signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
        headers: geminiHeaders(apiKey),
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
              ?.filter((p: { thought?: boolean }) => !p.thought)
              .map((p: { text?: string }) => p.text ?? '')
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
      `${GEMINI_API_BASE}/models/${request.model}:generateContent`,
      {
        method: 'POST',
        signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
        headers: geminiHeaders(apiKey),
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
      const res = await fetch(`${GEMINI_API_BASE}/models`, {
        headers: geminiHeaders(getApiKey()),
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
