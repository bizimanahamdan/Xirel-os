import { NextResponse } from 'next/server';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { agentApprovals } from '@/lib/db/schema';
import { requireWorkspaceAccess } from '@/lib/api/guards';

export const dynamic = 'force-dynamic';

/**
 * GET /api/agent/approvals?workspaceId=...&status=pending
 * The human side of the approval checkpoint system (Phase 3/12): what
 * is waiting for a decision, newest first.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const workspaceId = url.searchParams.get('workspaceId');
  const guard = await requireWorkspaceAccess(workspaceId, 'viewer');
  if (!guard.ok) return guard.response;

  const status = url.searchParams.get('status') ?? 'pending';
  const validStatuses = ['pending', 'approved', 'rejected', 'expired'];
  if (!validStatuses.includes(status)) {
    return NextResponse.json({ error: 'Invalid status filter' }, { status: 400 });
  }

  try {
    const rows = await db
      .select()
      .from(agentApprovals)
      .where(
        and(eq(agentApprovals.workspaceId, guard.ctx.workspaceId), eq(agentApprovals.status, status)),
      )
      .orderBy(desc(agentApprovals.createdAt))
      .limit(100);

    return NextResponse.json({
      approvals: rows.map((a) => ({
        id: a.id,
        jobId: a.jobId,
        runId: a.runId,
        toolName: a.toolName,
        riskLevel: a.riskLevel,
        summary: a.summary,
        status: a.status,
        requestedBy: a.requestedBy,
        decidedBy: a.decidedBy,
        decidedAt: a.decidedAt,
        decisionNote: a.decisionNote,
        createdAt: a.createdAt,
      })),
    });
  } catch (err) {
    console.error('Failed to list approvals:', err);
    return NextResponse.json({ error: 'Failed to list approvals' }, { status: 500 });
  }
}
