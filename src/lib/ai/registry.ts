import 'server-only';
import type { AiProvider, AiProviderId } from './types';
import { geminiProvider } from './providers/gemini';
import { groqProvider } from './providers/groq';
import { qwenProvider } from './providers/qwen';

/**
 * All providers the app knows how to talk to. Per the project spec's
 * MVP guidance (section 9), only Gemini/Groq/Qwen are wired up in
 * Phase 1. Moonshot/OpenAI/Anthropic adapters can be added later
 * following the exact same AiProvider shape — nothing else in the
 * app needs to change when that happens, which is the point of the
 * abstraction.
 */
const REGISTRY: Record<string, AiProvider> = {
  gemini: geminiProvider,
  groq: groqProvider,
  qwen: qwenProvider,
};

export function getProvider(id: AiProviderId): AiProvider {
  const provider = REGISTRY[id];
  if (!provider) {
    throw new Error(
      `No adapter registered for provider "${id}". ` +
        `Implemented providers: ${Object.keys(REGISTRY).join(', ')}.`
    );
  }
  return provider;
}

export function getAllProviders(): AiProvider[] {
  return Object.values(REGISTRY);
}

export function getConfiguredProviderInstances(): AiProvider[] {
  return getAllProviders().filter((p) => p.isConfigured());
}
