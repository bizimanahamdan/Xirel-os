/**
 * project_status_report — the first REAL skill (Phase 8).
 *
 * Deterministic (no model calls): pulls the project registry, memory,
 * and recent tasks through the existing project queries and produces a
 * structured status report. Independently testable — it touches only
 * query functions and returns data, so a harness can run it against a
 * stubbed DB layer seam or (in integration) a real database.
 */

import { z } from 'zod';
import { listProjects, getProjectSummary } from '@/lib/projects/queries';
import type { Skill } from './types';

const inputSchema = z.object({
  workspaceId: z.string().uuid(),
  /** Optional project name/id; omit for an all-projects rollup. */
  projectName: z.string().min(1).max(200).optional(),
});

const outputSchema = z.object({
  projects: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      status: z.string(),
      repoUrl: z.string().nullable(),
      deploymentUrl: z.string().nullable(),
      memory: z.record(z.string()),
      recentTaskCount: z.number(),
    }),
  ),
  generatedAt: z.string(),
});

export type ProjectStatusReportInput = z.infer<typeof inputSchema>;
export type ProjectStatusReportOutput = z.infer<typeof outputSchema>;

export const projectStatusReportSkill: Skill<
  ProjectStatusReportInput,
  ProjectStatusReportOutput
> = {
  name: 'project_status_report',
  description:
    'Report the current state of one or all projects in a workspace: ' +
    'registry status, repo/deployment, structured memory, recent task activity.',
  version: '1.0.0',
  inputSchema,
  outputSchema,
  requiredTools: ['list_projects', 'resolve_project'],
  riskLevel: 'safe',
  kind: 'deterministic',
  instructions:
    'Deterministic execution: reads the project registry and memory via ' +
    'src/lib/projects/queries.ts. No model involvement, no external calls.',
  verification: {
    method: 're_read_state',
    detail:
      'Every value is a fresh read from the registry at generation time; ' +
      'the report embeds generatedAt so staleness is explicit.',
  },
  failureBehavior: 'report_partial',
  available: true,
  async execute(input) {
    if (input.projectName) {
      const summary = await getProjectSummary(input.workspaceId, input.projectName);
      return {
        projects: summary
          ? [
              {
                id: summary.project.id,
                name: summary.project.name,
                status: summary.project.status,
                repoUrl: summary.project.repoUrl ?? null,
                deploymentUrl: summary.project.deploymentUrl ?? null,
                memory: Object.fromEntries(
                  summary.memory.map((m) => [`${m.kind}:${m.key}`, m.content]),
                ),
                recentTaskCount: summary.recentTasks.length,
              },
            ]
          : [],
        generatedAt: new Date().toISOString(),
      };
    }

    const projects = await listProjects(input.workspaceId);
    const reports = await Promise.all(
      projects.slice(0, 25).map(async (p) => {
        const summary = await getProjectSummary(input.workspaceId, p.id);
        return {
          id: p.id,
          name: p.name,
          status: p.status,
          repoUrl: p.repoUrl ?? null,
          deploymentUrl: p.deploymentUrl ?? null,
          memory: Object.fromEntries(
            (summary?.memory ?? []).map((m) => [`${m.kind}:${m.key}`, m.content]),
          ),
          recentTaskCount: summary?.recentTasks.length ?? 0,
        };
      }),
    );
    return { projects: reports, generatedAt: new Date().toISOString() };
  },
};
