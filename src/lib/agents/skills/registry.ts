/**
 * Skill registry (Phase 8): the single place capabilities are declared.
 * The Manager reads this; nothing hardcodes skills into the loop.
 *
 * Registered skills:
 *  - project_status_report  — REAL (deterministic, uses the project
 *    registry queries; independently testable).
 *  - clips_forge_video_production — boundary declaration ONLY
 *    (available=false): the Clips Forge connector has no verified API
 *    contract yet (see docs/integrations/clips-forge.md). It refuses to
 *    execute rather than pretend.
 */

import { getTool } from '@/lib/agents/tools/registry';
import type { Skill, SkillRunResult } from './types';
import { projectStatusReportSkill } from './project-status-report';
import { clipsForgeVideoProductionSkill } from './clips-forge-video-production';

/** Type-erased view of a skill for the registry list. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySkill = Skill<any, any>;

const SKILLS: AnySkill[] = [projectStatusReportSkill, clipsForgeVideoProductionSkill];

export function listSkills(): AnySkill[] {
  return SKILLS;
}

export function getSkill(name: string): AnySkill | null {
  return SKILLS.find((s) => s.name === name) ?? null;
}

/**
 * Execute a skill after the checks that make "capability" honest:
 * registered + declared available + all required tools actually
 * registered. Unavailable skills fail with the concrete reason.
 */
export async function runSkill<I, O>(
  skill: Skill<I, O>,
  input: I,
): Promise<SkillRunResult<O>> {
  if (!skill.available) {
    return {
      skill: skill.name,
      ok: false,
      error: `Skill "${skill.name}" is not available: ${skill.unavailableReason ?? 'unspecified'}`,
      verification: { status: 'unavailable', method: 'none' },
    };
  }
  if (!skill.execute) {
    return {
      skill: skill.name,
      ok: false,
      error: `Skill "${skill.name}" is declared executable but has no implementation.`,
      verification: { status: 'unavailable', method: 'none' },
    };
  }
  for (const toolName of skill.requiredTools) {
    if (!getTool(toolName)) {
      return {
        skill: skill.name,
        ok: false,
        error: `Skill "${skill.name}" requires tool "${toolName}" which is not registered.`,
        verification: { status: 'unavailable', method: 'none' },
      };
    }
  }

  const parsed = skill.inputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      skill: skill.name,
      ok: false,
      error: `Invalid skill input: ${parsed.error.message}`,
      verification: { status: 'unavailable', method: 'none' },
    };
  }

  try {
    const output = await skill.execute(parsed.data);
    return {
      skill: skill.name,
      ok: true,
      output,
      verification:
        skill.verification.method === 'none'
          ? { status: 'unavailable', method: skill.verification.method, detail: skill.verification.detail }
          : { status: 'verified', method: skill.verification.method, detail: skill.verification.detail },
    };
  } catch (error) {
    return {
      skill: skill.name,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      verification: { status: 'unavailable', method: skill.verification.method },
    };
  }
}
