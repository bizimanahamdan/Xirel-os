import { NextResponse } from 'next/server';
import { createSupabaseServerClient } from '@/lib/auth/supabase-server';
import { db } from '@/lib/db';
import { workspaceMembers } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { getTaskWithMessages } from '@/lib/tasks/queries';

/**
 * GET /api/tasks/get?taskId=...
 * 
 * Get a specific task with all its messages. Used for resuming conversations.
 * Requires authentication and workspace membership.
 */
export async function GET(request: Request) {
  const supabase = createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const url = new URL(request.url);
  const taskId = url.searchParams.get('taskId');

  if (!taskId) {
    return NextResponse.json({ error: 'taskId is required' }, { status: 400 });
  }

  try {
    const taskData = await getTaskWithMessages(taskId);

    if (!taskData) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    // Verify user is a member of the task's workspace
    const membership = await db.query.workspaceMembers.findFirst({
      where: eq(workspaceMembers.userId, user.id),
    });

    if (!membership) {
      return NextResponse.json({ error: 'Not a workspace member' }, { status: 403 });
    }

    return NextResponse.json(taskData);
  } catch (err) {
    console.error('Failed to fetch task:', err);
    return NextResponse.json({ error: 'Failed to fetch task' }, { status: 500 });
  }
}
