import { redirect } from 'next/navigation';
import { createSupabaseServerClient } from '@/lib/auth/supabase-server';
import { db } from '@/lib/db';
import { workspaceMembers, workspaces } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { getConfiguredProviders } from '@/lib/ai/config';
import SignOutButton from './sign-out-button';

export default async function DashboardPage() {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect('/login');
  }

  const memberships = await db
    .select({ workspace: workspaces })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(eq(workspaceMembers.userId, user.id));

  const configuredProviders = getConfiguredProviders();

  return (
    <main className="min-h-screen p-8">
      <div className="mx-auto max-w-3xl">
        <div className="mb-8 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold">What do you want your AI team to do?</h1>
            <p className="mt-1 text-sm text-muted">Signed in as {user.email}</p>
          </div>
          <SignOutButton />
        </div>

        <section className="mb-6 rounded-xl border border-border bg-surface p-6">
          <h2 className="mb-3 text-sm font-medium text-muted">Workspaces</h2>
          {memberships.length === 0 ? (
            <p className="text-sm text-muted">
              No workspace yet. Workspace creation ships with the Phase 1 onboarding flow.
            </p>
          ) : (
            <ul className="space-y-2">
              {memberships.map((m) => (
                <li key={m.workspace.id} className="text-sm">
                  {m.workspace.name}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="rounded-xl border border-border bg-surface p-6">
          <h2 className="mb-3 text-sm font-medium text-muted">AI providers configured</h2>
          {configuredProviders.length === 0 ? (
            <p className="text-sm text-muted">
              No AI provider API keys detected in the environment. Add at least one
              (e.g. GEMINI_API_KEY or GROQ_API_KEY) to .env.local — see .env.example.
            </p>
          ) : (
            <ul className="flex flex-wrap gap-2">
              {configuredProviders.map((p) => (
                <li
                  key={p}
                  className="rounded-full border border-border bg-white/5 px-3 py-1 text-xs"
                >
                  {p}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}
