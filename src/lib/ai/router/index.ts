import 'server-only';
import type { AiProviderId, AiRequest, AiResponse } from '../types';
import { AiProviderError } from '../types';
import { getProvider } from '../registry';

/**
 * Phase 1 router: ordered fallback only.
 *
 * This deliberately does NOT implement the full task-aware routing
 * policy described in the project spec (task type, complexity, cost,
 * multimodal needs, etc.) — that requires the task/agent framework
 * from Phase 2/3 to have real task metadata to route on. Building
 * that policy now, against no real tasks, would mean guessing at an
 * API that will have to change anyway.
 *
 * What this DOES give the rest of the app: a single call site that
 * tries providers in order and fails over on retryable errors, so
 * "one provider having a bad day" doesn't take down a workflow.
 * Every later routing policy can be layered on top of this function
 * without changing its callers.
 */

export interface RouteRequest extends AiRequest {
  /** Providers to try, in order. First configured + successful one wins. */
  providerPriority: AiProviderId[];
  /**
   * Optional per-provider model override. If omitted for a given
   * provider, that provider's default (src/lib/ai/models.ts) is used
   * instead of `request.model` — a single model string is not valid
   * across providers with different naming schemes. Existing callers
   * that only set `model` are unaffected: this field is additive.
   */
  modelByProvider?: Partial<Record<AiProviderId, string>>;
}

export interface RouteResult extends AiResponse {
  /** Providers that were attempted and failed before this one succeeded. */
  failedProviders: { providerId: AiProviderId; error: string }[];
}

/**
 * How many providers a single request may attempt, in priority order.
 * Raised from 3 to 5 so the preferred chat fallback chain
 * (gemini → groq → openrouter) stays fully reachable even when qwen is
 * ALSO configured (registry order puts it third). Timeout-budget note:
 * the pathological worst case is attempts × PROVIDER_TIMEOUT_MS (5 ×
 * 12s = 60s) against /api/chat's 60s maxDuration — only reachable when
 * EVERY provider hangs for its full timeout; real failures (404/429/
 * 5xx/auth) return in well under a second, which is the case this
 * fallback chain actually exists for. If you add more providers or
 * raise per-call timeouts, redo this arithmetic.
 */
const MAX_ATTEMPTS = 5;

export async function routeGenerateText(request: RouteRequest): Promise<RouteResult> {
  const failedProviders: RouteResult['failedProviders'] = [];
  const candidates = request.providerPriority.slice(0, MAX_ATTEMPTS);

  if (candidates.length === 0) {
    throw new Error('routeGenerateText: providerPriority was empty — nothing to try.');
  }

  for (const providerId of candidates) {
    const provider = getProvider(providerId);

    if (!provider.isConfigured()) {
      failedProviders.push({ providerId, error: 'not_configured' });
      continue;
    }

    try {
      const modelForThisProvider = request.modelByProvider?.[providerId] ?? request.model;
      const response = await provider.generateText({ ...request, model: modelForThisProvider });
      return { ...response, failedProviders };
    } catch (err) {
      const message = err instanceof AiProviderError ? err.message : String(err);
      failedProviders.push({ providerId, error: message });

      // Non-retryable errors (bad request, auth failure, etc.) still fall
      // through to the next provider here — a provider being broken for
      // one reason doesn't mean another provider can't serve the request.
      // Retry-within-a-provider (e.g. backoff on 429) is the adapter's job,
      // not the router's.
      continue;
    }
  }

  throw new Error(
    `All ${candidates.length} candidate provider(s) failed or were unconfigured: ` +
      failedProviders.map((f) => `${f.providerId} (${f.error})`).join(', ')
  );
}

export async function* routeStreamText(
  request: RouteRequest
): AsyncGenerator<{ text: string; providerId: AiProviderId }> {
  const candidates = request.providerPriority.slice(0, MAX_ATTEMPTS);
  const failedProviders: { providerId: AiProviderId; error: string }[] = [];

  if (candidates.length === 0) {
    throw new Error('routeStreamText: providerPriority was empty — nothing to try.');
  }

  for (const providerId of candidates) {
    const provider = getProvider(providerId);

    if (!provider.isConfigured()) {
      console.warn(`Provider ${providerId} is not configured — skipping.`);
      failedProviders.push({ providerId, error: 'not_configured' });
      continue;
    }

    try {
      // Resolve the model PER PROVIDER, exactly like routeGenerateText
      // below. A bare request.model (e.g. an OpenRouter-qualified name like
      // "openai/gpt-4-turbo") is meaningless — or an outright 404 — when
      // forwarded to Gemini/Groq/Qwen, whose model ids follow different
      // schemes. Passing request through unmodified here was the root cause
      // of "Gemini stream request failed: 404 Not Found" in production:
      // Gemini received "openai/gpt-4-turbo" interpolated into
      // /v1beta/models/{model}:streamGenerateContent, which is not a valid
      // Gemini model path.
      const modelForThisProvider = request.modelByProvider?.[providerId] ?? request.model;
      for await (const chunk of provider.streamText({ ...request, model: modelForThisProvider })) {
        // Adapters end their stream with an empty {text: '', done: true}
        // sentinel — don't forward it, or /api/chat enqueues a junk SSE
        // event that clients must then ignore.
        if (chunk.text) {
          yield { text: chunk.text, providerId };
        }
      }
      return;
    } catch (err) {
      const message = err instanceof AiProviderError ? err.message : String(err);
      // Truncate provider error bodies so a chatty 4xx/5xx response can't
      // flood logs or the client-facing error (they never contain keys —
      // keys are sent in headers and providers don't echo them).
      failedProviders.push({ providerId, error: message.slice(0, 300) });
      console.warn(`Provider ${providerId} stream failed: ${message}`);
      continue;
    }
  }

  throw new Error(
    `All ${candidates.length} candidate provider(s) failed or were unconfigured for streaming: ` +
      failedProviders.map((f) => `${f.providerId} (${f.error})`).join(', ')
  );
}
