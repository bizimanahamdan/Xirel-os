import { NextResponse } from 'next/server';
import { createSupabaseServerClient } from '@/lib/auth/supabase-server';
import { getAllProviders } from '@/lib/ai/registry';

/**
 * Returns configured/health status for every registered AI provider.
 * Requires auth so this doesn't become a public probe of your setup.
 * Actually hits each configured provider's API (not just an env-var
 * check) — this is the place to verify the adapters really work once
 * you have real keys and network access.
 */
export async function GET() {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const providers = getAllProviders();
  const results = await Promise.all(
    providers.map(async (provider) => ({
      providerId: provider.id,
      configured: provider.isConfigured(),
      health: await provider.healthCheck(),
    }))
  );

  return NextResponse.json({ providers: results });
}
