import { NextResponse } from 'next/server';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { agentSchedules } from '@/lib/db/schema';
import { requireWorkspaceAccess } from '@/lib/api/guards';
import { rateLimit } from '@/lib/security/rate-limit';
import { validateCron, nextCronRun } from '@/lib/schedules/cron';
import { submitJob } from '@/lib/jobs/queue';

export const dynamic = 'force-dynamic';

const actionsSchema = z.object({
  action: z.enum(['pause', 'resume', 'disable', 'run_now', 'update']),
  cron: z.string().min(9).max(100).optional(),
  instructions: z.string().min(1).max(8000).optional(),
  name: z.string().min(1).max(120).optional(),
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/agent/schedules/[id]/actions — enable/disable/pause/resume,
 * edit cron or instructions (next run recomputed), or enqueue a run NOW
 * (durable job, immediately claimable by the worker).
 */
export async function POST(
  request: Request,
  { params }: { params: { id: string } },
) {
  if (!UUID.test(params.id)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const parsed = actionsSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid action or payload' }, { status: 400 });
  }

  const rows = await db.select().from(agentSchedules).where(eq(agentSchedules.id, params.id)).limit(1);
  const schedule = rows[0];
  if (!schedule) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const guard = await requireWorkspaceAccess(schedule.workspaceId, 'member');
  if (!guard.ok) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const rl = rateLimit(`schedules:action:${guard.ctx.userId}`, 30, 60_000);
  if (!rl.ok) return NextResponse.json({ error: 'Too many requests' }, { status: 429 });

  const now = new Date();
  const { action } = parsed.data;

  try {
    if (action === 'pause' || action === 'disable' || action === 'resume') {
      const status = action === 'resume' ? 'active' : action === 'pause' ? 'paused' : 'disabled';
      if (schedule.status === status) {
        return NextResponse.json({ error: `Schedule is already ${status}` }, { status: 409 });
      }
      const patch: Record<string, unknown> = { status, updatedAt: now };
      if (action === 'resume') {
        const next =
          nextCronRun(schedule.cron, now) ??
          (() => {
            throw new Error('cron has no upcoming fire time');
          })();
        patch.nextRunAt = next;
      }
      await db.update(agentSchedules).set(patch).where(eq(agentSchedules.id, schedule.id));
      return NextResponse.json({ ok: true, status });
    }

    if (action === 'update') {
      const patch: Record<string, unknown> = { updatedAt: now };
      if (parsed.data.instructions) patch.instructions = parsed.data.instructions;
      if (parsed.data.name) patch.name = parsed.data.name;
      if (parsed.data.cron) {
        const cronError = validateCron(parsed.data.cron);
        if (cronError) return NextResponse.json({ error: `Invalid cron: ${cronError}` }, { status: 400 });
        const next = nextCronRun(parsed.data.cron, now);
        if (!next) return NextResponse.json({ error: 'Cron has no upcoming fire time' }, { status: 400 });
        patch.cron = parsed.data.cron;
        patch.nextRunAt = next;
      }
      await db.update(agentSchedules).set(patch).where(eq(agentSchedules.id, schedule.id));
      return NextResponse.json({ ok: true, action: 'update' });
    }

    // run_now — enqueue a durable job immediately; idempotency key uses
    // the current second so accidental double-clicks still collapse.
    const fireEpoch = Math.floor(now.getTime() / 1000);
    const { job, created } = await submitJob({
      workspaceId: schedule.workspaceId,
      createdBy: guard.ctx.userId,
      projectId: schedule.projectId,
      scheduleId: schedule.id,
      title: `Manual run: ${schedule.name}`,
      description: schedule.instructions,
      taskType: schedule.taskType,
      idempotencyKey: `sched:${schedule.id}:manual:${fireEpoch}`,
    });
    return NextResponse.json({ ok: true, jobId: job.id, created }, { status: created ? 202 : 200 });
  } catch (err) {
    console.error('Schedule action failed:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Schedule action failed' },
      { status: 500 },
    );
  }
}
