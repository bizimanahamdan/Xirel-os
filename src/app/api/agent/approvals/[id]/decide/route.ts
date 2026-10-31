import { NextResponse } from 'next/server';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { agentApprovals } from '@/lib/db/schema';
import { requireWorkspaceAccess } from '@/lib/api/guards';
import { decideApproval } from '@/lib/jobs/queue';

export const dynamic = 'force-dynamic';

const decideSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  note: z.string().max(1000).optional(),
});

/**
 * POST /api/agent/approvals/[id]/decide — resolve a pending approval.
 * The requester may decide their own request; anyone else needs admin+.
 * approved → the job returns to the queue with the tool recorded as
 * granted in its checkpoint; rejected → the job is cancelled. The
 * decision (who, when, note) is audited on the approval row.
 */
export async function POST(
  request: Request,
  { params }: { params: { id: string } },
) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(params.id)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const parsed = decideSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'decision must be "approved" or "rejected"' }, { status: 400 });
  }

  const rows = await db.select().from(agentApprovals).where(eq(agentApprovals.id, params.id)).limit(1);
  const approval = rows[0];
  if (!approval) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const viewerGuard = await requireWorkspaceAccess(approval.workspaceId, 'viewer');
  if (!viewerGuard.ok) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  if (viewerGuard.ctx.userId !== approval.requestedBy) {
    const adminGuard = await requireWorkspaceAccess(approval.workspaceId, 'admin');
    if (!adminGuard.ok) {
      return NextResponse.json(
        { error: 'Only the requester or a workspace admin can decide this approval' },
        { status: 403 },
      );
    }
  }

  const result = await decideApproval({
    approvalId: approval.id,
    decidedBy: viewerGuard.ctx.userId,
    decision: parsed.data.decision,
    note: parsed.data.note,
  });

  if (result === 'not_found') return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (result === 'already_decided') {
    return NextResponse.json({ error: 'This approval was already decided' }, { status: 409 });
  }
  return NextResponse.json({ ok: true, status: parsed.data.decision });
}
