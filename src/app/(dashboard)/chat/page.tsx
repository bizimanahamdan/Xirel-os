import { redirect } from 'next/navigation';
import { createSupabaseServerClient } from '@/lib/auth/supabase-server';
import { db } from '@/lib/db';
import { workspaceMembers } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { isPhase2SetupComplete } from '@/lib/db/setup-check';
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

  // Check if Phase 2 database migration has been run
  const isSetupComplete = await isPhase2SetupComplete();

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

  if (!isSetupComplete) {
    return (
      <main className="min-h-screen p-8">
        <div className="mx-auto max-w-2xl">
          <div className="rounded-xl border border-border bg-surface p-8">
            <h1 className="text-2xl font-semibold text-yellow-400">Setup Required</h1>
            <p className="mt-4 text-sm text-muted">
              The AI Command Center requires a database migration to be run before it can be used.
            </p>

            <div className="mt-6 space-y-4">
              <div className="rounded-lg bg-surface/50 p-4">
                <h2 className="font-medium text-white">Next Steps:</h2>
                <ol className="mt-3 space-y-2 text-sm text-muted">
                  <li>1. Open your Supabase project dashboard</li>
                  <li>2. Go to SQL Editor</li>
                  <li>3. Create a new query and paste the contents of:
                    <code className="mt-1 block text-xs bg-black/30 p-2 rounded">
                      supabase/migrations/0002_phase2_tasks_messages.sql
                    </code>
                  </li>
                  <li>4. Click "Run" to execute the migration</li>
                  <li>5. Refresh this page once complete</li>
                </ol>
              </div>

              <div className="rounded-lg border border-green-500/20 bg-green-500/5 p-4">
                <h2 className="text-sm font-medium text-green-400">What this migration does:</h2>
                <ul className="mt-2 space-y-1 text-xs text-green-300/80">
                  <li>✓ Creates tasks table (for storing conversations)</li>
                  <li>✓ Creates messages table (for storing chat history)</li>
                  <li>✓ Enables Row Level Security (workspace isolation)</li>
                  <li>✓ Creates necessary database indexes (performance)</li>
                </ul>
              </div>

              <div className="rounded-lg border border-border p-4">
                <p className="text-xs text-muted">
                  This is a one-time setup. After running the migration, the AI Command Center will be fully functional.
                  Your authentication and workspace configuration are already complete.
                </p>
              </div>
            </div>
          </div>
        </div>
      </main>
    );
  }

  return <ChatClient workspaceId={workspaceId} />;
}
