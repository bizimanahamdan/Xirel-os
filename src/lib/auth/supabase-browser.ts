import { createBrowserClient } from '@supabase/ssr';

/**
 * Browser-side Supabase client. Uses the public anon key only —
 * never import the service role key here. RLS policies (see
 * supabase/migrations/0001_foundation.sql) are what actually
 * enforce data isolation for anything queried through this client.
 */
export function createSupabaseBrowserClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}
