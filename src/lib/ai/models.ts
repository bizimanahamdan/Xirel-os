import 'server-only';
import type { AiProviderId } from './types';

/**
 * Default model per provider.
 *
 * Why this file exists: a single "model" string cannot mean the same
 * thing across providers — OpenRouter uses qualified names like
 * "openai/gpt-4-turbo", Groq and Gemini use their own unqualified model
 * ids, and Qwen's valid ids depend entirely on which host QWEN_BASE_URL
 * points at. Code that sends one hardcoded model string to whichever
 * provider the router happens to fall back to will silently send the
 * wrong model id to at least some providers. This registry exists so
 * new code (the agent/orchestrator path) resolves a model per-provider
 * instead of repeating that mistake.
 *
 * UNVERIFIED like the adapters themselves: these are current model ids
 * per each provider's public docs as of this codebase's writing, not
 * confirmed against a live call in this environment. Re-check against
 * the provider's model list before relying on this in production —
 * providers deprecate and rename models regularly.
 */
const DEFAULT_MODELS: Record<AiProviderId, string> = {
  groq: 'llama-3.3-70b-versatile',
  gemini: 'gemini-2.0-flash',
  openrouter: 'openai/gpt-4-turbo',
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
