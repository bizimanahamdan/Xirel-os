/**
 * Thin bridges between the durable queue and the existing task system —
 * jobs anchor onto tasks so messages, runs, and the audit trail keep
 * using the structures that already exist (no parallel universe).
 */

import 'server-only';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { tasks, workspaceMembers, type workspaceRoleEnum } from '@/lib/db/schema';
import { createTask } from '@/lib/tasks/queries';

type WorkspaceRole = (typeof workspaceRoleEnum.enumValues)[number];

export async function getTaskById(taskId: string) {
  const rows = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
  return rows[0] ?? null;
}

/**
 * Create (or reuse) the anchor task for a job. Idempotent-ish: callers
 * pass a stable title, and repeated creation for the same job is
 * avoided by reusing job.taskId upstream.
 */
export async function ensureTask(params: {
  workspaceId: string;
  userId: string;
  title: string;
  description?: string;
}): Promise<string> {
  const task = await createTask(params.workspaceId, params.userId, params.title);
  if (params.description) {
    await db
      .update(tasks)
      .set({ description: params.description.slice(0, 4000) })
      .where(eq(tasks.id, task.id));
  }
  return task.id;
}

/** Membership + role lookup — the same authorization source as the API routes. */
export async function getWorkspaceRole(
  workspaceId: string,
  userId: string,
): Promise<WorkspaceRole | null> {
  const rows = await db
    .select({ role: workspaceMembers.role, userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.workspaceId, workspaceId))
    .limit(200);
  const match = rows.find((m) => m.userId === userId);
  return (match?.role as WorkspaceRole) ?? null;
}
