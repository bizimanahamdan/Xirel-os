/**
 * Shared API guards (Phase 5): authentication + workspace authorization
 * for every task/job/approval/schedule endpoint, in one place so
 * "never trust a client-supplied workspace id" is enforced uniformly.
 */

import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { createSupabaseServerClient } from '@/lib/auth/supabase-server';
import { db } from '@/lib/db';
import { workspaceMembers, type workspaceRoleEnum } from '@/lib/db/schema';

type WorkspaceRole = (typeof workspaceRoleEnum.enumValues)[number];

const ROLE_RANK: Record<WorkspaceRole, number> = {
  viewer: 0,
  member: 1,
  admin: 2,
  owner: 3,
};

export interface WorkspaceAccessContext {
  userId: string;
  workspaceId: string;
  role: WorkspaceRole;
}

type GuardResult =
  | { ok: true; ctx: WorkspaceAccessContext }
  | { ok: false; response: NextResponse };

/**
 * Verify the caller is authenticated AND holds at least `minRole` in
 * the given workspace. Returns a ready-to-return NextResponse on
 * failure (401 / 403 / 404-safe 403 wording kept simple).
 */
export async function requireWorkspaceAccess(
  workspaceId: string | null | undefined,
  minRole: WorkspaceRole = 'viewer',
): Promise<GuardResult> {
  const uuidLike = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!workspaceId || !uuidLike.test(workspaceId)) {
    return { ok: false, response: NextResponse.json({ error: 'workspaceId is required' }, { status: 400 }) };
  }

  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { ok: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  }

  const rows = await db
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, user.id)))
    .limit(1);

  const membership = rows[0];
  if (!membership) {
    return {
      ok: false,
      response: NextResponse.json({ error: 'Workspace not found or access denied' }, { status: 403 }),
    };
  }

  if (ROLE_RANK[membership.role] < ROLE_RANK[minRole]) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: `This action requires the "${minRole}" role or higher` },
        { status: 403 },
      ),
    };
  }

  return { ok: true, ctx: { userId: user.id, workspaceId, role: membership.role } };
}

/** Authenticate only (no workspace context) — for system endpoints. */
export type UserGuardResult =
  | { ok: true; ctx: { userId: string } }
  | { ok: false; response: NextResponse };

export async function requireUser(): Promise<UserGuardResult> {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { ok: false, response: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
  }
  return { ok: true, ctx: { userId: user.id } };
}
