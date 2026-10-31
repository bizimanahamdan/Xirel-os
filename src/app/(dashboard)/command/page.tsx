import { redirect } from 'next/navigation';
import { createSupabaseServerClient } from '@/lib/auth/supabase-server';
import { db } from '@/lib/db';
import { workspaceMembers } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { isPhase2SetupComplete } from '@/lib/db/setup-check';
import CommandClient from './command-client';

/**
 * AI Command Center (Phase 12) — the default landing surface of Xirel
 * OS. Business OS remains a separate module at /business; the command
 * center is the AI operating system front door: conversation, durable
 * tasks, execution activity, approvals, schedules, provider health.
 */
export default async function CommandPage({
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

  const isSetupComplete = await isPhase2SetupComplete();

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
      <main className="min-h-screen p-6">
        <div className="mx-auto max-w-2xl">
          <div className="rounded-xl border border-border bg-surface p-8">
            <h1 className="text-2xl font-semibold text-yellow-400">Setup Required</h1>
            <p className="mt-4 text-sm text-muted">
              The command center needs the database migrations applied first
              (in order): <code>0001</code>–<code>0006</code>, then{' '}
              <code>0007_rls_recursion_fix.sql</code> and{' '}
              <code>0008_durable_execution.sql</code> from{' '}
              <code>supabase/migrations/</code>.
            </p>
          </div>
        </div>
      </main>
    );
  }

  return <CommandClient workspaceId={workspaceId} />;
}
