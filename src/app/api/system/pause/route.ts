import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireUser } from '@/lib/api/guards';
import { getExecutionPaused, setExecutionPaused } from '@/lib/jobs/queue';

export const dynamic = 'force-dynamic';

const pauseSchema = z.object({ paused: z.boolean() });

/**
 * GET /api/system/pause — current global pause state.
 */
export async function GET() {
  const guard = await requireUser();
  if (!guard.ok) return guard.response;
  return NextResponse.json({ paused: await getExecutionPaused() });
}

/**
 * POST /api/system/pause — the Phase 13 global kill switch for NEW
 * execution. When paused, workers stop claiming jobs (in-flight jobs
 * finish or hit their leases; nothing new starts).
 *
 * Authorization: only user ids listed in GLOBAL_ADMIN_USER_IDS (env,
 * comma-separated). Unset → the switch is read-only for everyone.
 * This is a platform-level control — workspace roles are deliberately
 * not sufficient.
 */
export async function POST(request: Request) {
  const guard = await requireUser();
  if (!guard.ok) return guard.response;

  const allowlist = (process.env.GLOBAL_ADMIN_USER_IDS ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  if (allowlist.length === 0) {
    return NextResponse.json(
      { error: 'Global pause control is disabled (GLOBAL_ADMIN_USER_IDS is not configured)' },
      { status: 403 },
    );
  }
  if (!allowlist.includes(guard.ctx.userId)) {
    return NextResponse.json({ error: 'Not permitted to toggle the global pause' }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const parsed = pauseSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Body must be {"paused": boolean}' }, { status: 400 });
  }

  await setExecutionPaused(parsed.data.paused);
  return NextResponse.json({ ok: true, paused: parsed.data.paused });
}
