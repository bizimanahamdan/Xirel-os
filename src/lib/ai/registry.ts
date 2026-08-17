import 'server-only';
import type { AiProvider, AiProviderId } from './types';
import { geminiProvider } from './providers/gemini';
import { groqProvider } from './providers/groq';
import { qwenProvider } from './providers/qwen';
import { openrouterProvider } from './providers/openrouter';

/**
 * All providers the app knows how to talk to. Each provider is a fully
 * independent adapter conforming to the AiProvider interface. New
 * providers (OpenAI, Anthropic, Moonshot, etc.) can be added without
 * touching the rest of the app — just implement AiProvider and add
 * to this REGISTRY.
 */
const REGISTRY: Record<string, AiProvider> = {
  gemini: geminiProvider,
  groq: groqProvider,
  qwen: qwenProvider,
  openrouter: openrouterProvider,
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
