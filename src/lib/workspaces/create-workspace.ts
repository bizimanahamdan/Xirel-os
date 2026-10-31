'use server';

import { z } from 'zod';
import { redirect } from 'next/navigation';
import { createSupabaseServerClient } from '@/lib/auth/supabase-server';
import { db } from '@/lib/db';
import { workspaceMembers, workspaces } from '@/lib/db/schema';
import { generateUniqueSlug } from './slug';

/**
 * IMPORTANT — trust boundary note:
 *
 * This writes via Drizzle over DATABASE_URL, which is a direct Postgres
 * connection and BYPASSES Row Level Security (RLS applies to connections
 * authenticated through Supabase's PostgREST/GoTrue layer using a user
 * JWT — a direct `postgres://` connection string is not that). The RLS
 * policies in supabase/migrations/0001_foundation.sql are real and will
 * protect any future code path that queries Supabase directly from the
 * browser client with a user's session (e.g. client-side realtime
 * subscriptions), but they are NOT what's protecting this server action.
 *
 * What protects this action instead: it runs only in a Next.js Server
 * Action (never reachable from the browser as raw SQL), and it manually
 * scopes every write to `user.id` pulled from the verified session below
 * rather than trusting any client-supplied identifier. Every future
 * Drizzle query in this codebase needs the same discipline — treat
 * Drizzle as a trusted-backend connection with no automatic isolation,
 * not as "RLS but through a different client."
 */

const createWorkspaceSchema = z.object({
  name: z.string().trim().min(2, 'Name must be at least 2 characters').max(64),
});

export interface CreateWorkspaceState {
  error?: string;
}

export async function createWorkspace(
  _prevState: CreateWorkspaceState,
  formData: FormData
): Promise<CreateWorkspaceState> {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return { error: 'You must be signed in to create a workspace.' };
  }

  const parsed = createWorkspaceSchema.safeParse({ name: formData.get('name') });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Invalid workspace name.' };
  }

  const slug = await generateUniqueSlug(parsed.data.name);

  let workspaceId: string;
  try {
    // Two writes need to happen together (workspace + owner membership).
    // The SQL migration also creates a DB trigger that inserts the owner
    // membership automatically on workspace insert — but that trigger
    // only fires for inserts made through Supabase's own connection
    // pooling in some configurations, and relying on an invisible DB
    // trigger from application code that can't see it fail is fragile.
    // Doing both writes explicitly here, in a transaction, is more
    // honest about what the app depends on.
    const result = await db.transaction(async (tx) => {
      const [workspace] = await tx
        .insert(workspaces)
        .values({ name: parsed.data.name, slug, ownerId: user.id })
        .returning({ id: workspaces.id });

      if (!workspace) {
        throw new Error('Workspace insert returned no row.');
      }

      // Explicit membership insert. If the DB trigger from the migration
      // also fires, the unique constraint on (workspace_id, user_id)
      // makes this a safe no-op via ON CONFLICT rather than a duplicate.
      await tx
        .insert(workspaceMembers)
        .values({ workspaceId: workspace.id, userId: user.id, role: 'owner' })
        .onConflictDoNothing();

      return workspace.id;
    });

    workspaceId = result;
  } catch (err) {
    console.error('createWorkspace failed', err);
    return { error: 'Could not create workspace. Please try again.' };
  }

  // Redirect throws internally (Next.js control-flow signal) — do not
  // wrap this call in the try/catch above or it will be caught as an error.
  redirect(`/dashboard?workspace=${workspaceId}`);
}
