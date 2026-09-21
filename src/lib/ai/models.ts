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
 * VERIFIED 2026-09-21 against each provider's live deprecation pages:
 *   - Gemini: https://ai.google.dev/gemini-api/docs/deprecations
 *     (gemini-2.0-flash was SHUT DOWN 2026-06-01 — calls to it 404.)
 *   - Groq: https://console.groq.com/docs/deprecations
 *     (llama-3.3-70b-versatile was SHUT DOWN 2026-08-16; openai/gpt-oss-120b
 *     is Groq's officially recommended replacement.)
 *   - OpenRouter: https://openrouter.ai/api/v1/models (openai/gpt-4-turbo
 *     still served today but its upstream id is scheduled for removal on
 *     2026-10-23 per https://platform.openai.com/docs/deprecations, so the
 *     default moves to the long-lived openai/gpt-4o-mini.)
 * Providers deprecate models regularly — RE-VERIFY these ids against the
 * pages above whenever chat responses start failing with 404/"model not
 * found", rather than assuming the code regressed.
 *
 * Each default is overridable without a code change via env var, so a
 * future deprecation can be handled by updating the environment (e.g.
 * Vercel project settings) alone.
 */
const DEFAULT_MODELS: Record<AiProviderId, string> = {
  groq: process.env.GROQ_DEFAULT_MODEL || 'openai/gpt-oss-120b',
  gemini: process.env.GEMINI_DEFAULT_MODEL || 'gemini-2.5-flash',
  openrouter: process.env.OPENROUTER_DEFAULT_MODEL || 'openai/gpt-4o-mini',
  qwen: process.env.QWEN_DEFAULT_MODEL || 'qwen-plus',
  moonshot: 'moonshot-v1-8k',
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
