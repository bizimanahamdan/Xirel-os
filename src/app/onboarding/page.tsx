import { redirect } from 'next/navigation';
import { createSupabaseServerClient } from '@/lib/auth/supabase-server';
import { db } from '@/lib/db';
import { workspaceMembers } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import CreateWorkspaceForm from './create-workspace-form';

export default async function OnboardingPage() {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect('/login');
  }

  // If they already have a workspace, onboarding is done — don't show
  // this page again just because they navigated back to it.
  const existingMembership = await db.query.workspaceMembers.findFirst({
    where: eq(workspaceMembers.userId, user.id),
    columns: { id: true },
  });

  if (existingMembership) {
    redirect('/dashboard');
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm rounded-xl border border-border bg-surface p-8">
        <h1 className="mb-1 text-xl font-semibold">Name your workspace</h1>
        <p className="mb-6 text-sm text-muted">
          This is where your projects, agents, and AI team will live.
        </p>
        <CreateWorkspaceForm />
      </div>
    </main>
  );
}
