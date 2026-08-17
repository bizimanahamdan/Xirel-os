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
}

export interface RouteResult extends AiResponse {
  /** Providers that were attempted and failed before this one succeeded. */
  failedProviders: { providerId: AiProviderId; error: string }[];
}

const MAX_ATTEMPTS = 3;

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
      const response = await provider.generateText(request);
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

  if (candidates.length === 0) {
    throw new Error('routeStreamText: providerPriority was empty — nothing to try.');
  }

  for (const providerId of candidates) {
    const provider = getProvider(providerId);

    if (!provider.isConfigured()) {
      continue;
    }

    try {
      for await (const chunk of provider.streamText(request)) {
        yield { text: chunk.text, providerId };
      }
      return;
    } catch (err) {
      const message = err instanceof AiProviderError ? err.message : String(err);
      console.warn(`Provider ${providerId} stream failed: ${message}`);
      continue;
    }
  }

  throw new Error(
    `All ${candidates.length} candidate provider(s) failed or were unconfigured for streaming`
  );
}
