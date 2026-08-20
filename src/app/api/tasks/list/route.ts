import { NextResponse } from 'next/server';
import { createSupabaseServerClient } from '@/lib/auth/supabase-server';
import { db } from '@/lib/db';
import { workspaceMembers } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { getWorkspaceTasks } from '@/lib/tasks/queries';

/**
 * GET /api/tasks/list?workspaceId=...
 * 
 * Get all tasks for a workspace. Used by chat sidebar and task history.
 * Requires authentication and workspace membership.
 */
export async function GET(request: Request) {
  const supabase = createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const url = new URL(request.url);
  const workspaceId = url.searchParams.get('workspaceId');

  if (!workspaceId) {
    return NextResponse.json({ error: 'workspaceId is required' }, { status: 400 });
  }

  // Verify user is a member of this workspace
  try {
    const membership = await db.query.workspaceMembers.findFirst({
      where: eq(workspaceMembers.userId, user.id),
    });

    if (!membership) {
      return NextResponse.json({ error: 'Not a workspace member' }, { status: 403 });
    }
  } catch (err) {
    console.error('Failed to verify workspace membership:', err);
    return NextResponse.json({ error: 'Failed to verify access' }, { status: 500 });
  }

  try {
    const taskList = await getWorkspaceTasks(workspaceId);
    return NextResponse.json({ tasks: taskList });
  } catch (err) {
    console.error('Failed to fetch tasks:', err);
    return NextResponse.json({ error: 'Failed to fetch tasks' }, { status: 500 });
  }
}
