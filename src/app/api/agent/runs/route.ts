import { NextResponse } from 'next/server';
import { createSupabaseServerClient } from '@/lib/auth/supabase-server';
import { db } from '@/lib/db';
import { workspaceMembers } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { listRunsForWorkspaces } from '@/lib/agents/runs';

/**
 * GET /api/agent/runs
 *
 * Recent agent runs across the caller's workspaces (newest first) — the
 * minimal read layer a future Agent Activity panel renders. Requires
 * auth; only runs from workspaces the user belongs to are returned.
 */
export async function GET() {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const memberships = await db
      .select({ workspaceId: workspaceMembers.workspaceId })
      .from(workspaceMembers)
      .where(eq(workspaceMembers.userId, user.id));

    const runs = await listRunsForWorkspaces(memberships.map((m) => m.workspaceId));
    return NextResponse.json({ runs });
  } catch (err) {
    console.error('Failed to list agent runs:', err);
    return NextResponse.json({ error: 'Failed to list agent runs' }, { status: 500 });
  }
}
