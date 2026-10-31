import { NextResponse } from 'next/server';
import { z } from 'zod';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { agentSchedules } from '@/lib/db/schema';
import { requireWorkspaceAccess } from '@/lib/api/guards';
import { rateLimit } from '@/lib/security/rate-limit';
import { validateCron, nextCronRun } from '@/lib/schedules/cron';

export const dynamic = 'force-dynamic';

const createSchema = z.object({
  workspaceId: z.string().uuid(),
  name: z.string().min(1).max(120),
  instructions: z.string().min(1).max(8000),
  cron: z.string().min(9).max(100),
  projectId: z.string().uuid().optional(),
  taskType: z.string().max(60).optional(),
});

/**
 * GET /api/agent/schedules?workspaceId=... — persistent schedules in a
 * workspace (Phase 11): next/last run, status, failure history.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const workspaceId = url.searchParams.get('workspaceId');
  const guard = await requireWorkspaceAccess(workspaceId, 'viewer');
  if (!guard.ok) return guard.response;

  try {
    const rows = await db
      .select()
      .from(agentSchedules)
      .where(eq(agentSchedules.workspaceId, guard.ctx.workspaceId))
      .orderBy(desc(agentSchedules.createdAt))
      .limit(200);

    return NextResponse.json({ schedules: rows });
  } catch (err) {
    console.error('Failed to list schedules:', err);
    return NextResponse.json({ error: 'Failed to list schedules' }, { status: 500 });
  }
}

/**
 * POST /api/agent/schedules — create a persistent schedule. Cron is
 * validated and the first next_run_at is computed at creation, so the
 * worker only ever reads due dates — it never parses user input.
 */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request', details: parsed.error.flatten().fieldErrors },
      { status: 400 },
    );
  }
  const input = parsed.data;

  const guard = await requireWorkspaceAccess(input.workspaceId, 'member');
  if (!guard.ok) return guard.response;

  const rl = rateLimit(`schedules:create:${guard.ctx.userId}`, 10, 60_000);
  if (!rl.ok) return NextResponse.json({ error: 'Too many requests' }, { status: 429 });

  const cronError = validateCron(input.cron);
  if (cronError) {
    return NextResponse.json({ error: `Invalid cron: ${cronError}` }, { status: 400 });
  }
  const nextRunAt = nextCronRun(input.cron, new Date());
  if (!nextRunAt) {
    return NextResponse.json(
      { error: 'Cron expression has no upcoming fire time' },
      { status: 400 },
    );
  }

  try {
    const inserted = await db
      .insert(agentSchedules)
      .values({
        workspaceId: guard.ctx.workspaceId,
        createdBy: guard.ctx.userId,
        projectId: input.projectId ?? null,
        name: input.name,
        instructions: input.instructions,
        taskType: input.taskType ?? 'scheduled_task',
        cron: input.cron,
        nextRunAt,
      })
      .onConflictDoNothing()
      .returning();
    const row = inserted[0];
    if (!row) {
      return NextResponse.json(
        { error: 'A schedule with this name already exists in the workspace' },
        { status: 409 },
      );
    }
    return NextResponse.json({ schedule: row }, { status: 201 });
  } catch (err) {
    console.error('Failed to create schedule:', err);
    return NextResponse.json({ error: 'Failed to create schedule' }, { status: 500 });
  }
}
