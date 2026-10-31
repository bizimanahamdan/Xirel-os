import 'server-only';
import { db } from '@/lib/db';
import { projects, projectMemory, tasks } from '@/lib/db/schema';
import { and, desc, eq, ilike, sql } from 'drizzle-orm';
import { withTimeout } from '@/lib/db/with-timeout';

/**
 * Project registry queries (Phase 4).
 *
 * Projects are first-class Xirel objects scoped to a workspace — the
 * same isolation boundary as every other table here. Resolution by
 * name is case-insensitive so the agent can act on "continue the
 * Soleil project" without exact-match requirements.
 *
 * Conventions match src/lib/tasks/queries.ts: bounded queries in
 * request hot paths, errors thrown for create/update (callers own
 * their error responses) and returned as empty results for reads
 * where a degraded view beats a failed request.
 */

const QUERY_TIMEOUT_MS = 5_000;

export type ProjectRecord = typeof projects.$inferSelect;
export type ProjectStatus = ProjectRecord['status'];
export type ProjectMemoryRecord = typeof projectMemory.$inferSelect;

export const PROJECT_MEMORY_KINDS = ['decision', 'problem', 'status', 'fact', 'note'] as const;
export type ProjectMemoryKind = (typeof PROJECT_MEMORY_KINDS)[number];

export interface CreateProjectInput {
  workspaceId: string;
  name: string;
  description?: string | null;
  repoProvider?: string | null;
  repoUrl?: string | null;
  repoOwner?: string | null;
  repoName?: string | null;
  deploymentProvider?: string | null;
  deploymentUrl?: string | null;
  databaseProvider?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Creates a project, or returns the existing project with the same
 * (case-insensitive) name in the workspace — "create a project called
 * Test Project" twice must not produce two rows. Uniqueness is enforced
 * here because the DB-level unique index may be absent when an existing
 * deployment has legacy duplicate names (see migration 0005).
 */
export async function createProject(input: CreateProjectInput): Promise<ProjectRecord> {
  const name = input.name.trim();
  if (!name) {
    throw new Error('Project name cannot be empty');
  }

  const existing = await findProjectByName(input.workspaceId, name);
  if (existing) {
    return existing;
  }

  const [created] = await withTimeout(
    db
      .insert(projects)
      .values({
        workspaceId: input.workspaceId,
        name,
        description: input.description ?? null,
        repoProvider: input.repoProvider ?? null,
        repoUrl: input.repoUrl ?? null,
        repoOwner: input.repoOwner ?? null,
        repoName: input.repoName ?? null,
        deploymentProvider: input.deploymentProvider ?? null,
        deploymentUrl: input.deploymentUrl ?? null,
        databaseProvider: input.databaseProvider ?? null,
        metadata: input.metadata ?? {},
      })
      .returning(),
    QUERY_TIMEOUT_MS,
    'createProject'
  );

  if (!created) {
    throw new Error('Project insert returned no row');
  }
  return created;
}

export async function findProjectByName(
  workspaceId: string,
  name: string
): Promise<ProjectRecord | null> {
  const trimmed = name.trim();
  if (!trimmed) return null;
  const rows = await withTimeout(
    db
      .select()
      .from(projects)
      .where(and(eq(projects.workspaceId, workspaceId), ilike(projects.name, trimmed)))
      .limit(1),
    QUERY_TIMEOUT_MS,
    'findProjectByName'
  );
  return rows[0] ?? null;
}

/**
 * Resolves a project reference from an agent conversation: a UUID id
 * matches exactly; anything else is treated as a (case-insensitive) name.
 * Returns null when nothing matches — the caller decides whether to create.
 */
export async function resolveProject(
  workspaceId: string,
  reference: string
): Promise<ProjectRecord | null> {
  const trimmed = reference.trim();
  if (!trimmed) return null;

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (UUID_RE.test(trimmed)) {
    const byId = await withTimeout(
      db
        .select()
        .from(projects)
        .where(and(eq(projects.workspaceId, workspaceId), eq(projects.id, trimmed)))
        .limit(1),
      QUERY_TIMEOUT_MS,
      'resolveProject'
    );
    if (byId[0]) return byId[0];
  }
  return findProjectByName(workspaceId, trimmed);
}

export async function getProject(
  workspaceId: string,
  projectId: string
): Promise<ProjectRecord | null> {
  const rows = await withTimeout(
    db
      .select()
      .from(projects)
      .where(and(eq(projects.workspaceId, workspaceId), eq(projects.id, projectId)))
      .limit(1),
    QUERY_TIMEOUT_MS,
    'getProject'
  );
  return rows[0] ?? null;
}

export async function listProjects(workspaceId: string): Promise<ProjectRecord[]> {
  return withTimeout(
    db
      .select()
      .from(projects)
      .where(eq(projects.workspaceId, workspaceId))
      .orderBy(desc(projects.updatedAt))
      .limit(100),
    QUERY_TIMEOUT_MS,
    'listProjects'
  );
}

export interface UpdateProjectInput {
  name?: string;
  description?: string | null;
  status?: ProjectStatus;
  repoProvider?: string | null;
  repoUrl?: string | null;
  repoOwner?: string | null;
  repoName?: string | null;
  deploymentProvider?: string | null;
  deploymentUrl?: string | null;
  databaseProvider?: string | null;
  metadata?: Record<string, unknown>;
}

export async function updateProject(
  workspaceId: string,
  projectId: string,
  patch: UpdateProjectInput
): Promise<ProjectRecord | null> {
  const rows = await withTimeout(
    db
      .update(projects)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(projects.workspaceId, workspaceId), eq(projects.id, projectId)))
      .returning(),
    QUERY_TIMEOUT_MS,
    'updateProject'
  );
  return rows[0] ?? null;
}

/** Attaches a task to a project (task → project edge). Existing tasks unaffected. */
export async function attachTaskToProject(
  taskId: string,
  projectId: string
): Promise<void> {
  await withTimeout(
    db.update(tasks).set({ projectId, updatedAt: new Date() }).where(eq(tasks.id, taskId)),
    QUERY_TIMEOUT_MS,
    'attachTaskToProject'
  );
}

/**
 * The context the agent gets when it resolves a project: the registry
 * row plus a brief roll-up (recent runs/tasks/memory) so "continue the
 * Soleil project" answers with the CURRENT STATE, not just metadata.
 * Bounded reads; a failure in the roll-up degrades to counts only.
 */
export async function getProjectSummary(workspaceId: string, projectId: string) {
  const project = await getProject(workspaceId, projectId);
  if (!project) return null;

  const [memory, recentTasks] = await Promise.all([
    withTimeout(
      db
        .select()
        .from(projectMemory)
        .where(eq(projectMemory.projectId, projectId))
        .orderBy(desc(projectMemory.updatedAt))
        .limit(20),
      QUERY_TIMEOUT_MS,
      'projectSummaryMemory'
    ).catch(() => [] as ProjectMemoryRecord[]),
    withTimeout(
      db
        .select({ id: tasks.id, title: tasks.title, status: tasks.status, updatedAt: tasks.updatedAt })
        .from(tasks)
        .where(eq(tasks.projectId, projectId))
        .orderBy(desc(tasks.updatedAt))
        .limit(5),
      QUERY_TIMEOUT_MS,
      'projectSummaryTasks'
    ).catch(() => []),
  ]);

  return { project, memory, recentTasks };
}

// ─────────────────────────────────────────────────────────
// Structured project memory
// ─────────────────────────────────────────────────────────

export interface UpsertMemoryInput {
  projectId: string;
  workspaceId: string;
  kind: ProjectMemoryKind;
  key?: string;
  content: string;
  metadata?: Record<string, unknown>;
}

/** Inserts or updates a memory entry keyed by (project, kind, key). */
export async function upsertProjectMemory(input: UpsertMemoryInput): Promise<ProjectMemoryRecord> {
  const key = (input.key ?? '').trim();
  const content = input.content.trim();
  if (!content) {
    throw new Error('Project memory content cannot be empty');
  }

  const [row] = await withTimeout(
    db
      .insert(projectMemory)
      .values({
        projectId: input.projectId,
        workspaceId: input.workspaceId,
        kind: input.kind,
        key,
        content,
        metadata: input.metadata ?? {},
      })
      .onConflictDoUpdate({
        target: [projectMemory.projectId, projectMemory.kind, projectMemory.key],
        set: {
          content,
          metadata: input.metadata ?? {},
          updatedAt: new Date(),
        },
      })
      .returning(),
    QUERY_TIMEOUT_MS,
    'upsertProjectMemory'
  );

  if (!row) {
    throw new Error('Project memory upsert returned no row');
  }
  return row;
}

export async function listProjectMemory(
  projectId: string,
  kind?: ProjectMemoryKind
): Promise<ProjectMemoryRecord[]> {
  const where = kind
    ? and(eq(projectMemory.projectId, projectId), eq(projectMemory.kind, kind))
    : eq(projectMemory.projectId, projectId);
  return withTimeout(
    db
      .select()
      .from(projectMemory)
      .where(where)
      .orderBy(desc(projectMemory.updatedAt))
      .limit(100),
    QUERY_TIMEOUT_MS,
    'listProjectMemory'
  );
}

/** Row count guard used by tests/health — never exposes content. */
export async function countProjectMemory(projectId: string): Promise<number> {
  const rows = await withTimeout(
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(projectMemory)
      .where(eq(projectMemory.projectId, projectId)),
    QUERY_TIMEOUT_MS,
    'countProjectMemory'
  );
  return rows[0]?.count ?? 0;
}
