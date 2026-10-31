import { NextResponse, type NextRequest } from 'next/server';
import { createSupabaseServerClient } from '@/lib/auth/supabase-server';

/**
 * Handles the redirect back from Supabase after GitHub OAuth or a
 * magic-link click. Exchanges the one-time `code` for a session and
 * sets the auth cookies, then sends the user on to where they meant
 * to go (or /dashboard by default).
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get('code');
  const redirectTo = searchParams.get('redirectTo') ?? '/dashboard';

  if (code) {
    const supabase = createSupabaseServerClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);

    if (error) {
      const failUrl = new URL('/login', origin);
      failUrl.searchParams.set('error', 'auth_callback_failed');
      return NextResponse.redirect(failUrl);
    }
  }

  return NextResponse.redirect(new URL(redirectTo, origin));
}
