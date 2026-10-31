import { NextResponse } from 'next/server';
import { requireWorkspaceAccess } from '@/lib/api/guards';
import { getJob } from '@/lib/jobs/queue';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/agent/jobs/[id] — job detail (status, checkpoint, errors).
 * Workspace-scoped: a job from another workspace 404s identically to a
 * missing one (no existence leak), same convention as /api/agent/runs/[id].
 */
export async function GET(
  _request: Request,
  { params }: { params: { id: string } },
) {
  if (!UUID.test(params.id)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const job = await getJob(params.id);
  if (!job) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const guard = await requireWorkspaceAccess(job.workspaceId, 'viewer');
  if (!guard.ok) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  return NextResponse.json({
    job: {
      id: job.id,
      title: job.title,
      description: job.description,
      status: job.status,
      taskType: job.taskType,
      attemptCount: job.attemptCount,
      maxAttempts: job.maxAttempts,
      currentStep: job.currentStep,
      checkpoint: job.checkpoint,
      lastError: job.lastError,
      errorClass: job.errorClass,
      runId: job.runId,
      projectId: job.projectId,
      taskId: job.taskId,
      scheduleId: job.scheduleId,
      nextExecutionAt: job.nextExecutionAt,
      leaseOwner: job.leaseOwner,
      leaseExpiresAt: job.leaseExpiresAt,
      heartbeatAt: job.heartbeatAt,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      completedAt: job.completedAt,
    },
  });
}
