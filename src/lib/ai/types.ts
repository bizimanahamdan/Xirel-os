/**
 * Xirel OS — AI Provider Abstraction (Phase 1)
 *
 * The rest of the application must depend on THIS interface, never on
 * a specific provider's SDK or request/response shape directly. This
 * is what makes "models are replaceable workers" (see project spec)
 * actually true instead of aspirational.
 */

export type AiProviderId =
  | 'gemini'
  | 'groq'
  | 'qwen'
  | 'moonshot'
  | 'openai'
  | 'anthropic';

export interface AiMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AiRequest {
  messages: AiMessage[];
  /** Provider-specific model id, e.g. "gemini-2.0-flash". Resolved by the router. */
  model: string;
  temperature?: number;
  maxOutputTokens?: number;
}

export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface AiResponse {
  text: string;
  usage: AiUsage;
  /** Wall-clock latency in ms, measured by the adapter around the network call. */
  latencyMs: number;
  model: string;
  providerId: AiProviderId;
}

export interface AiChunk {
  text: string;
  done: boolean;
}

export interface StructuredAiRequest<T> extends AiRequest {
  /** JSON schema the response must conform to. */
  schema: Record<string, unknown>;
  /** Only used for developer-facing errors, not sent to the provider. */
  schemaName: string;
}

/**
 * Static capability description for a provider. This is intentionally
 * separate from per-workspace config (src/lib/db/schema.ts) — capabilities
 * are a property of the provider/model, not something a workspace configures.
 *
 * IMPORTANT: these values must be sourced from each provider's current
 * official documentation, not assumed. Treat any capability entry here
 * as needing re-verification whenever a provider ships a new model —
 * do not extrapolate from one model's specs to another.
 */
export interface ProviderCapabilities {
  supportsStreaming: boolean;
  supportsStructuredOutput: boolean;
  supportsTools: boolean;
  supportsVision: boolean;
  maxContextTokens: number;
  /** True if this provider has a free tier at all (not "unlimited"). */
  hasFreeTier: boolean;
}

export type ProviderHealthStatus = 'healthy' | 'degraded' | 'unavailable' | 'not_configured';

export interface ProviderHealth {
  status: ProviderHealthStatus;
  checkedAt: string;
  detail?: string;
}

export interface AiProvider {
  id: AiProviderId;

  /** True only if the required env vars are present. Never assume configured. */
  isConfigured(): boolean;

  generateText(request: AiRequest): Promise<AiResponse>;

  streamText(request: AiRequest): AsyncIterable<AiChunk>;

  generateStructuredOutput<T>(request: StructuredAiRequest<T>): Promise<T>;

  getCapabilities(): ProviderCapabilities;

  healthCheck(): Promise<ProviderHealth>;
}

export class AiProviderError extends Error {
  constructor(
    message: string,
    public readonly providerId: AiProviderId,
    public readonly cause?: unknown,
    public readonly retryable: boolean = false
  ) {
    super(message);
    this.name = 'AiProviderError';
  }
}
