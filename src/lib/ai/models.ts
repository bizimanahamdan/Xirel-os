import 'server-only';
import type { AiProviderId } from './types';

/**
 * Default model per provider.
 *
 * Why this file exists: a single "model" string cannot mean the same
 * thing across providers — OpenRouter uses qualified names like
 * "openai/gpt-4o-mini", Groq and Gemini use their own unqualified model
 * ids, and Qwen's valid ids depend entirely on which host QWEN_BASE_URL
 * points at. Code that sends one hardcoded model string to whichever
 * provider the router happens to fall back to will silently send the
 * wrong model id to at least some providers. This registry exists so
 * the router resolves a model PER PROVIDER (via modelByProvider) instead
 * of repeating that mistake — sending "openai/gpt-4-turbo" to Gemini was
 * exactly the production 404 this file's comments warn about.
 *
 * VERIFIED 2026-09-22 against each provider's live documentation:
 *   - Gemini: https://ai.google.dev/gemini-api/docs/deprecations and
 *     https://ai.google.dev/api/generate-content — gemini-3.8-flash is
 *     Google's current flagship Flash model (released 2026-09-02, used in
 *     every current official example; gemini-2.0-flash was SHUT DOWN
 *     2026-06-01 and 404s).
 *   - Groq: https://console.groq.com/docs/deprecations — openai/gpt-oss-120b
 *     is Groq's officially recommended production model (llama-3.3-70b-
 *     versatile was SHUT DOWN 2026-08-16).
 *   - OpenRouter: https://openrouter.ai/api/v1/models — "openrouter/free"
 *     is OpenRouter's official Free Models Router (it selects among the
 *     free models currently available, so it stays usable as individual
 *     free models rotate in and out). Being a free-model router, it may
 *     not support tool calling reliably — the tool-calling orchestrator
 *     path should prefer gemini/groq first (registry order handles this).
 * Providers deprecate models regularly — RE-VERIFY these ids against the
 * pages above whenever chat responses start failing with 404/"model not
 * found", rather than assuming the code regressed.
 *
 * Each default is overridable without a code change via env var, so a
 * future deprecation can be handled by updating the environment (e.g.
 * Vercel project settings) alone. Qwen's valid ids depend entirely on
 * which host QWEN_BASE_URL points at, and Moonshot renames models with
 * releases — both stay env-configurable rather than pinned here.
 */
const DEFAULT_MODELS: Record<AiProviderId, string> = {
  groq: process.env.GROQ_DEFAULT_MODEL || 'openai/gpt-oss-120b',
  gemini: process.env.GEMINI_DEFAULT_MODEL || 'gemini-3.8-flash',
  openrouter: process.env.OPENROUTER_DEFAULT_MODEL || 'openrouter/free',
  qwen: process.env.QWEN_DEFAULT_MODEL || 'qwen-plus',
  moonshot: process.env.MOONSHOT_DEFAULT_MODEL || 'moonshot-v1-8k',
  openai: 'gpt-4-turbo',
  anthropic: 'claude-3-5-sonnet-latest',
};

export function getDefaultModel(providerId: AiProviderId): string {
  return DEFAULT_MODELS[providerId];
}

/**
 * Resolves the model to use for a given provider, given an optional
 * per-provider override map. Falls back to that provider's default.
 */
export function resolveModel(
  providerId: AiProviderId,
  modelByProvider?: Partial<Record<AiProviderId, string>>
): string {
  return modelByProvider?.[providerId] ?? getDefaultModel(providerId);
}
