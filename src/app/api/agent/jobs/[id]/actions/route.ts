import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireWorkspaceAccess } from '@/lib/api/guards';
import { rateLimit } from '@/lib/security/rate-limit';
import { cancelJob, pauseJob, resumeJob, getJob } from '@/lib/jobs/queue';

export const dynamic = 'force-dynamic';

const actionSchema = z.object({
  action: z.enum(['cancel', 'pause', 'resume']),
});

/**
 * POST /api/agent/jobs/[id]/actions — user-driven lifecycle control.
 * cancel: requester or admin; pause/resume: requester or admin.
 * (The state machine rejects illegal moves — e.g. cancelling a
 * completed job is a no-op, surfaced as 409.)
 */
export async function POST(
  request: Request,
  { params }: { params: { id: string } },
) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const parsed = actionSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
  }

  const job = await getJob(params.id);
  if (!job) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  // requester OR admin+ may act on a job (mirrors the RLS update policy)
  const isRequester = job.createdBy === (await currentUserId());
  const guard = await requireWorkspaceAccess(job.workspaceId, isRequester ? 'viewer' : 'admin');
  if (!guard.ok) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const rl = rateLimit(`jobs:action:${guard.ctx.userId}`, 30, 60_000);
  if (!rl.ok) {
    return NextResponse.json({ error: 'Too many actions' }, { status: 429 });
  }

  let ok: boolean;
  switch (parsed.data.action) {
    case 'cancel':
      ok = await cancelJob(job.id);
      break;
    case 'pause':
      ok = await pauseJob(job.id);
      break;
    case 'resume':
      ok = await resumeJob(job.id);
      break;
  }

  if (!ok) {
    return NextResponse.json(
      { error: `Cannot ${parsed.data.action} a job in "${job.status}" state` },
      { status: 409 },
    );
  }
  return NextResponse.json({ ok: true, action: parsed.data.action });
}

async function currentUserId(): Promise<string | null> {
  const { createSupabaseServerClient } = await import('@/lib/auth/supabase-server');
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user?.id ?? null;
}
