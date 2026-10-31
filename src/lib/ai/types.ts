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
  | 'anthropic'
  | 'openrouter';

export interface AiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Present when role is 'assistant' and the model chose to call tools instead of (or alongside) replying. */
  toolCalls?: AiToolCall[];
  /** Present when role is 'tool' — must match the id from the AiToolCall this message answers. */
  toolCallId?: string;
  /** Present when role is 'tool' — the tool's name, required by some providers alongside toolCallId. */
  name?: string;
}

/**
 * A tool definition passed to the model so it knows what it can call.
 * inputSchema is a JSON Schema object (not a Zod schema) since that's
 * the wire format every provider's function-calling API expects.
 */
export interface AiToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface AiToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface AiRequest {
  messages: AiMessage[];
  /** Provider-specific model id, e.g. "gemini-2.0-flash". Resolved by the router. */
  model: string;
  temperature?: number;
  maxOutputTokens?: number;
  /** Tools the model may call. Omit or leave empty for a plain chat request. */
  tools?: AiToolDefinition[];
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
  /** Present when finishReason is 'tool_calls' — the model wants these executed before it continues. */
  toolCalls?: AiToolCall[];
  finishReason: 'stop' | 'tool_calls' | 'length' | 'content_filter' | 'unknown';
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

  /**
   * Supports `request.tools`. If the model calls a tool, the returned
   * AiResponse has finishReason: 'tool_calls' and populated toolCalls —
   * the caller (an Agent) must execute them and continue the conversation
   * with role: 'tool' messages containing the results.
   */
  generateText(request: AiRequest): Promise<AiResponse>;

  /**
   * Plain text streaming. Does NOT support request.tools — tool-calling
   * requires the full response to inspect finishReason before continuing,
   * so agents use generateText, not streamText. streamText remains for
   * the direct-chat path (Phase 2) where no tools are involved.
   */
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
