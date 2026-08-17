import { redirect } from 'next/navigation';
import { createSupabaseServerClient } from '@/lib/auth/supabase-server';
import { db } from '@/lib/db';
import { workspaceMembers } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import ChatClient from './chat-client';

export default async function ChatPage({
  searchParams,
}: {
  searchParams: { workspace?: string };
}) {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect('/login');
  }

  // Get user's first workspace if none specified
  let workspaceId = searchParams.workspace;

  if (!workspaceId) {
    const membership = await db.query.workspaceMembers.findFirst({
      where: eq(workspaceMembers.userId, user.id),
      columns: { workspaceId: true },
    });

    if (!membership) {
      redirect('/onboarding');
    }

    workspaceId = membership.workspaceId;
  }

  return <ChatClient workspaceId={workspaceId} />;
}
