import 'server-only';
import { createClient } from '@supabase/supabase-js';

/**
 * PRIVILEGED CLIENT — bypasses Row Level Security entirely.
 *
 * Use only for operations that legitimately need to act outside a
 * single user's permissions (e.g. system-level maintenance jobs).
 * Do NOT use this as a shortcut to avoid writing correct RLS policies.
 * Every call site using this client should have a comment explaining
 * why RLS cannot express the required check.
 *
 * The `server-only` import ensures this file throws a build error if
 * anything tries to bundle it into client-side JavaScript.
 */
export function createSupabaseAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    throw new Error(
      'createSupabaseAdminClient: NEXT_PUBLIC_SUPABASE_URL and ' +
        'SUPABASE_SERVICE_ROLE_KEY must both be set. Refusing to run ' +
        'with a partial/misconfigured privileged client.'
    );
  }

  return createClient(url, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}
