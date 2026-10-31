import 'server-only';
import { z } from 'zod';
import type { ToolDefinition } from './types';
import {
  createProject,
  getProjectSummary,
  listProjects,
  resolveProject,
  updateProject,
  upsertProjectMemory,
  PROJECT_MEMORY_KINDS,
} from '@/lib/projects/queries';

/**
 * PROJECTS tool category (Phase 4 / Milestone 7) — the first real
 * external-capability category in the tool gateway. These tools talk to
 * the local project registry (the projects/project_memory tables via the
 * existing Drizzle layer) — nothing here is faked, and nothing here calls
 * external services.
 *
 * Gateway extension contract for the NEXT categories (github, vercel,
 * supabase, render, web, code, files): implement ToolDefinition against a
 * REAL client backed by server-side credentials, register it in
 * registry.ts, and declare its risk level honestly. When no credential or
 * client exists, the category is NOT registered — a missing integration
 * must be invisible to the model, not a tool that pretends to work.
 *
 * Risk mapping per the Phase 4 permission model:
 *   reads → 'safe'; create/update of workspace records → 'low'.
 * Nothing here is moderate+ — external side effects (deployments,
 * infrastructure) belong to future categories that SHOULD be gated into
 * waiting_for_approval by the runtime's approval policy.
 */

const uuidSchema = z.string().uuid();

// ─────────────────────────────────────────────────────────
// Input schemas (Zod = runtime validation; inputJsonSchema on each
// tool = the wire format the model sees)
// ─────────────────────────────────────────────────────────

const CreateProjectInputSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
  repoUrl: z.string().max(500).optional(),
  deploymentUrl: z.string().max(500).optional(),
});

const ListProjectsInputSchema = z.object({}).strict();

const ResolveProjectInputSchema = z.object({
  reference: z.string().min(1).max(200),
});

const UpdateProjectInputSchema = z.object({
  projectId: uuidSchema,
  description: z.string().max(2000).optional(),
  status: z.enum(['active', 'paused', 'archived']).optional(),
  repoUrl: z.string().max(500).optional(),
  repoOwner: z.string().max(120).optional(),
  repoName: z.string().max(200).optional(),
  deploymentUrl: z.string().max(500).optional(),
  deploymentProvider: z.string().max(60).optional(),
});

const AddProjectMemoryInputSchema = z.object({
  projectId: uuidSchema,
  kind: z.enum(PROJECT_MEMORY_KINDS),
  key: z.string().max(120).optional(),
  content: z.string().min(1).max(4000),
});

function projectRef(project: {
  id: string;
  name: string;
  status: string;
  description: string | null;
  repoUrl: string | null;
  deploymentUrl: string | null;
  updatedAt: Date;
}) {
  return {
    id: project.id,
    name: project.name,
    status: project.status,
    description: project.description,
    repoUrl: project.repoUrl,
    deploymentUrl: project.deploymentUrl,
    updatedAt: project.updatedAt.toISOString(),
  };
}

export const createProjectTool: ToolDefinition<
  z.infer<typeof CreateProjectInputSchema>,
  Record<string, unknown>
> = {
  name: 'create_project',
  description:
    'Register a new project in this workspace, or return the existing project if one with the same name already exists. Use this when the user refers to a project that is not registered yet.',
  inputSchema: CreateProjectInputSchema,
  inputJsonSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Project name, e.g. "AI Clips"' },
      description: { type: 'string', description: 'What the project is' },
      repoUrl: { type: 'string', description: 'Repository URL, if known' },
      deploymentUrl: { type: 'string', description: 'Deployment URL, if known' },
    },
    required: ['name'],
  },
  outputDescription:
    'The project record (id, name, status, metadata) — created or pre-existing.',
  riskLevel: 'low',
  requiredPermission: 'member',
  async execute(input, ctx) {
    const created = await createProject({
      workspaceId: ctx.workspaceId,
      name: input.name,
      description: input.description ?? null,
      repoUrl: input.repoUrl ?? null,
      deploymentUrl: input.deploymentUrl ?? null,
    });
    return {
      success: true,
      output: {
        project: projectRef(created),
        existedAlready: false,
        note:
          'Project registered. Attach repository/deployment details with update_project when known.',
      },
    };
  },
};

export const listProjectsTool: ToolDefinition<
  z.infer<typeof ListProjectsInputSchema>,
  Record<string, unknown>
> = {
  name: 'list_projects',
  description:
    'List the projects registered in this workspace. Use this to check what projects exist or what needs attention.',
  inputSchema: ListProjectsInputSchema,
  inputJsonSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  outputDescription: 'Array of project records.',
  riskLevel: 'safe',
  requiredPermission: 'member',
  async execute(_input, ctx) {
    const rows = await listProjects(ctx.workspaceId);
    return {
      success: true,
      output: {
        count: rows.length,
        projects: rows.map(projectRef),
      },
    };
  },
};

export const resolveProjectTool: ToolDefinition<
  z.infer<typeof ResolveProjectInputSchema>,
  Record<string, unknown>
> = {
  name: 'resolve_project',
  description:
    'Find a project by name (case-insensitive) or id and return its current state: registry details, structured memory (decisions, known problems, status) and recent tasks. Use this at the start of working on a named project.',
  inputSchema: ResolveProjectInputSchema,
  inputJsonSchema: {
    type: 'object',
    properties: {
      reference: {
        type: 'string',
        description: 'Project name (fuzzy, case-insensitive) or project id',
      },
    },
    required: ['reference'],
  },
  outputDescription:
    'The resolved project with its memory and recent tasks, or found:false when no project matches.',
  riskLevel: 'safe',
  requiredPermission: 'member',
  async execute(input, ctx) {
    const summary = await resolveProject(ctx.workspaceId, input.reference);
    if (!summary) {
      return {
        success: true,
        output: {
          found: false,
          note: 'No project with that name exists yet. Use create_project to register it, or list_projects to see what exists.',
        },
      };
    }
    const full = await getProjectSummary(ctx.workspaceId, summary.id);
    return {
      success: true,
      output: {
        found: true,
        project: projectRef(full?.project ?? summary),
        description: summary.description,
        memory:
          full?.memory.map((m) => ({
            kind: m.kind,
            key: m.key,
            content: m.content,
            updatedAt: m.updatedAt.toISOString(),
          })) ?? [],
        recentTasks:
          full?.recentTasks.map((t) => ({
            id: t.id,
            title: t.title,
            status: t.status,
            updatedAt: t.updatedAt.toISOString(),
          })) ?? [],
      },
    };
  },
};

export const updateProjectTool: ToolDefinition<
  z.infer<typeof UpdateProjectInputSchema>,
  Record<string, unknown>
> = {
  name: 'update_project',
  description:
    'Update a project registry record: description, status (active/paused/archived), repository or deployment metadata. Requires the project id.',
  inputSchema: UpdateProjectInputSchema,
  inputJsonSchema: {
    type: 'object',
    properties: {
      projectId: { type: 'string', description: 'Project id (from resolve_project / create_project)' },
      description: { type: 'string' },
      status: { type: 'string', enum: ['active', 'paused', 'archived'] },
      repoUrl: { type: 'string' },
      repoOwner: { type: 'string' },
      repoName: { type: 'string' },
      deploymentUrl: { type: 'string' },
      deploymentProvider: { type: 'string' },
    },
    required: ['projectId'],
  },
  outputDescription: 'The updated project record.',
  riskLevel: 'low',
  requiredPermission: 'member',
  async execute(input, ctx) {
    const updated = await updateProject(ctx.workspaceId, input.projectId, {
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.repoUrl !== undefined ? { repoUrl: input.repoUrl } : {}),
      ...(input.repoOwner !== undefined ? { repoOwner: input.repoOwner } : {}),
      ...(input.repoName !== undefined ? { repoName: input.repoName } : {}),
      ...(input.deploymentUrl !== undefined ? { deploymentUrl: input.deploymentUrl } : {}),
      ...(input.deploymentProvider !== undefined
        ? { deploymentProvider: input.deploymentProvider }
        : {}),
    });
    if (!updated) {
      return { success: false, error: `No project found with id ${input.projectId} in this workspace.` };
    }
    return { success: true, output: { project: projectRef(updated) } };
  },
};

export const addProjectMemoryTool: ToolDefinition<
  z.infer<typeof AddProjectMemoryInputSchema>,
  Record<string, unknown>
> = {
  name: 'add_project_memory',
  description:
    'Record durable knowledge about a project: a decision that was made, a known problem, current status, a fact, or a note. This is how the project is remembered across conversations — prefer this over mentioning things only in chat.',
  inputSchema: AddProjectMemoryInputSchema,
  inputJsonSchema: {
    type: 'object',
    properties: {
      projectId: { type: 'string', description: 'Project id' },
      kind: { type: 'string', enum: ['decision', 'problem', 'status', 'fact', 'note'] },
      key: {
        type: 'string',
        description: 'Short stable key so the entry can be updated later, e.g. "current-status". Optional.',
      },
      content: { type: 'string', description: 'What to remember' },
    },
    required: ['projectId', 'kind', 'content'],
  },
  outputDescription: 'The stored memory entry.',
  riskLevel: 'low',
  requiredPermission: 'member',
  async execute(input, ctx) {
    const row = await upsertProjectMemory({
      projectId: input.projectId,
      workspaceId: ctx.workspaceId,
      kind: input.kind,
      key: input.key ?? '',
      content: input.content,
    });
    return {
      success: true,
      output: {
        memoryId: row.id,
        kind: row.kind,
        key: row.key,
        content: row.content,
        updatedAt: row.updatedAt.toISOString(),
      },
    };
  },
};
