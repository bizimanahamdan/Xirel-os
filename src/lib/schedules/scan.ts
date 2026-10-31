/**
 * Schedule scanning (Phase 11): the worker periodically claims due
 * schedules (FOR UPDATE SKIP LOCKED — multiple workers never double-fire
 * one schedule) and enqueues a durable job per fire.
 *
 * Duplicate prevention: each enqueued job carries the idempotency key
 * `sched:<scheduleId>:<fireEpochSeconds>` — even if the same fire is
 * processed twice (crash between claim and update), the unique index
 * collapses it into the one already-enqueued job.
 */

import { sql } from 'drizzle-orm';
import { db } from '@/lib/db';
import { submitJob } from '@/lib/jobs/queue';
import { nextCronRun } from './cron';

export interface DueScheduleRow {
  id: string;
  workspaceId: string;
  createdBy: string;
  projectId: string | null;
  name: string;
  instructions: string;
  taskType: string;
  cron: string;
}

export interface FireResult {
  scheduleId: string;
  jobId: string | null;
  created: boolean;
  nextRunAt: Date | null;
  error?: string;
}

/**
 * Claim up to `limit` due schedules and enqueue their jobs.
 * The cron's next run is computed AFTER the fire so a misconfigured cron
 * that never matches still records the attempted fire (and surfaces its
 * error on the schedule row).
 */
export async function fireDueSchedules(limit = 10, now = new Date()): Promise<FireResult[]> {
  const claimed = (await db.execute(sql`
    select id, workspace_id, created_by, project_id, name, instructions, task_type, cron
    from agent_schedules
    where status = 'active' and next_run_at <= now()
    order by next_run_at asc
    limit ${limit}
    for update skip locked
  `)) as unknown as Record<string, unknown>[];

  const results: FireResult[] = [];

  for (const row of claimed) {
    const schedule: DueScheduleRow = {
      id: row.id as string,
      workspaceId: row.workspace_id as string,
      createdBy: row.created_by as string,
      projectId: (row.project_id as string | null) ?? null,
      name: row.name as string,
      instructions: row.instructions as string,
      taskType: (row.task_type as string) ?? 'scheduled_task',
      cron: row.cron as string,
    };

    const fireEpoch = Math.floor(now.getTime() / 1000);
    const next = nextCronRun(schedule.cron, now);
    const idempotencyKey = `sched:${schedule.id}:${fireEpoch}`;

    try {
      const { job, created } = await submitJob({
        workspaceId: schedule.workspaceId,
        createdBy: schedule.createdBy,
        projectId: schedule.projectId,
        scheduleId: schedule.id,
        title: `Scheduled: ${schedule.name}`,
        description: schedule.instructions,
        taskType: schedule.taskType,
        idempotencyKey,
        priority: 0,
      });
      if (next) {
        await db.execute(sql`
          update agent_schedules
          set last_run_at = now(),
              last_job_id = ${job.id},
              last_error = null,
              failure_count = 0,
              run_count = run_count + ${created ? 1 : 0},
              next_run_at = ${next.toISOString()},
              updated_at = now()
          where id = ${schedule.id}
        `);
      } else {
        // Unrepresentable cron (no future match within a year): park it
        // loudly instead of violating the NOT NULL next_run_at.
        await db.execute(sql`
          update agent_schedules
          set status = 'paused',
              last_error = 'Cron expression has no future fire time — schedule paused',
              updated_at = now()
          where id = ${schedule.id}
        `);
      }
      results.push({
        scheduleId: schedule.id,
        jobId: job.id,
        created,
        nextRunAt: next,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await db.execute(sql`
        update agent_schedules
        set last_run_at = now(),
            last_error = ${message.slice(0, 500)},
            failure_count = failure_count + 1,
            ${next
              ? sql`next_run_at = ${next.toISOString()},`
              : sql`status = 'paused',`}
            updated_at = now()
        where id = ${schedule.id}
      `);
      results.push({ scheduleId: schedule.id, jobId: null, created: false, nextRunAt: next, error: message });
    }
  }

  return results;
}
