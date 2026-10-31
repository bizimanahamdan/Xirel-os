/**
 * clips_forge_video_production — Phase 9 INTEGRATION BOUNDARY.
 *
 * This skill is deliberately NOT executable: the Clips Forge connector
 * does not exist yet because no verified API contract is available.
 * Per the standing rules — "Do not claim an integration works when only
 * a placeholder exists" and "Do not invent endpoints" — the skill is
 * declared with available=false and the concrete reason. When the real
 * API contract is provided (authenticated generation, job status, asset
 * retrieval, webhook/polling), the connector implements
 * VideoGenerationConnector (src/lib/connectors/types.ts) and this skill
 * flips to available with a real workflow:
 *
 *   plan → submit generation jobs → track → retrieve assets → store in
 *   durable storage → verify → present previews → REQUIRE APPROVAL →
 *   publish → record platform ids → report.
 *
 * Publishing NEVER happens without an approved agent_approvals row, and
 * a queued generation request is NEVER reported as a completed video.
 */

import { z } from 'zod';
import type { Skill } from './types';

const inputSchema = z.object({
  workspaceId: z.string().uuid(),
  projectId: z.string().uuid(),
  /** What the clips should promote; the agent turns this into a content plan. */
  brief: z.string().min(1).max(2000),
  clipCount: z.number().int().min(1).max(10).default(3),
  /** Publishing targets — require explicit approval per target later. */
  publishTargets: z.array(z.string().max(60)).max(5).default([]),
});

const outputSchema = z.object({
  clips: z.array(
    z.object({
      status: z.enum(['submitted', 'processing', 'generated', 'retrieved', 'verified', 'approved', 'published']),
      assetUrl: z.string().nullable(),
      platformRefs: z.record(z.string()),
    }),
  ),
});

export const clipsForgeVideoProductionSkill: Skill<
  z.infer<typeof inputSchema>,
  z.infer<typeof outputSchema>
> = {
  name: 'clips_forge_video_production',
  description:
    'Autonomous promotional-video production: content plan → Clips Forge ' +
    'generation → durable asset storage → verification → previews → ' +
    'human approval → publishing → outcome report.',
  version: '0.1.0-boundary',
  inputSchema,
  outputSchema,
  requiredTools: ['resolve_project'],
  riskLevel: 'high', // publishing is externally consequential — approval gate applies
  kind: 'agent_driven',
  instructions:
    'BLOCKED at the connector boundary: see docs/integrations/clips-forge.md. ' +
    'The Clips Forge deployed API must expose (and be verified against): ' +
    'authenticated generation requests, job status, asset retrieval, and ' +
    'webhook-or-polling progress. Until then this skill refuses to run.',
  verification: {
    method: 'external_confirmation',
    detail:
      'Asset availability must be confirmed against durable storage and ' +
      'publishing outcomes reconciled against the platform before reporting ' +
      'success. None of this can be honestly claimed without the connector.',
  },
  failureBehavior: 'requires_approval',
  available: false,
  unavailableReason:
    'No verified Clips Forge API contract (no connector, no credentials ' +
    'documented, endpoints must not be invented). See ' +
    'docs/integrations/clips-forge.md.',
};
