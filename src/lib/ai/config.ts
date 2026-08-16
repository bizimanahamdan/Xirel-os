import 'server-only';
import type { AiProviderId } from './types';

/**
 * Single source of truth for "is provider X configured". Every part of
 * the app that needs to know this MUST call these functions rather than
 * checking process.env directly, so there's exactly one place that
 * defines what "configured" means per provider.
 */

interface ProviderEnvRequirement {
  id: AiProviderId;
  requiredEnvVars: string[];
}

const PROVIDER_ENV_REQUIREMENTS: ProviderEnvRequirement[] = [
  { id: 'gemini', requiredEnvVars: ['GEMINI_API_KEY'] },
  { id: 'groq', requiredEnvVars: ['GROQ_API_KEY'] },
  { id: 'qwen', requiredEnvVars: ['QWEN_API_KEY', 'QWEN_BASE_URL'] },
  { id: 'moonshot', requiredEnvVars: ['MOONSHOT_API_KEY'] },
  { id: 'openai', requiredEnvVars: ['OPENAI_API_KEY'] },
  { id: 'anthropic', requiredEnvVars: ['ANTHROPIC_API_KEY'] },
];

export function isProviderConfigured(id: AiProviderId): boolean {
  const requirement = PROVIDER_ENV_REQUIREMENTS.find((r) => r.id === id);
  if (!requirement) return false;
  return requirement.requiredEnvVars.every((key) => !!process.env[key]?.trim());
}

export function getConfiguredProviders(): AiProviderId[] {
  return PROVIDER_ENV_REQUIREMENTS.filter((r) => isProviderConfigured(r.id)).map(
    (r) => r.id
  );
}

export function getMissingEnvVars(id: AiProviderId): string[] {
  const requirement = PROVIDER_ENV_REQUIREMENTS.find((r) => r.id === id);
  if (!requirement) return [];
  return requirement.requiredEnvVars.filter((key) => !process.env[key]?.trim());
}
