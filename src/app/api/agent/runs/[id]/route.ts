import { NextResponse } from 'next/server';
import { createSupabaseServerClient } from '@/lib/auth/supabase-server';
import { db } from '@/lib/db';
import { agentRuns, workspaceMembers } from '@/lib/db/schema';
import { and, eq } from 'drizzle-orm';
import { getRunDetail } from '@/lib/agents/runs';

/**
 * GET /api/agent/runs/[id]
 *
 * Full trajectory of one agent run: run record + steps + activity events
 * + the tool-execution audit rows. Membership-scoped: the caller must be
 * a member of the run's workspace, otherwise 404 (not 403 — existence is
 * not disclosed across workspaces).
 */
export async function GET(
  _request: Request,
  { params }: { params: { id: string } }
) {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const runId = params.id;
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!UUID_RE.test(runId)) {
    return NextResponse.json({ error: 'Invalid run id' }, { status: 400 });
  }

  try {
    const runRow = await db.query.agentRuns.findFirst({
      where: eq(agentRuns.id, runId),
      columns: { id: true, workspaceId: true },
    });
    if (!runRow) {
      return NextResponse.json({ error: 'Run not found' }, { status: 404 });
    }

    const membership = await db
      .select({ id: workspaceMembers.id })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, runRow.workspaceId),
          eq(workspaceMembers.userId, user.id)
        )
      )
      .limit(1);
    if (!membership[0]) {
      return NextResponse.json({ error: 'Run not found' }, { status: 404 });
    }

    const detail = await getRunDetail(runRow.workspaceId, runId);
    if (!detail) {
      return NextResponse.json({ error: 'Run not found' }, { status: 404 });
    }
    return NextResponse.json(detail);
  } catch (err) {
    console.error('Failed to load agent run:', err);
    return NextResponse.json({ error: 'Failed to load agent run' }, { status: 500 });
  }
}
