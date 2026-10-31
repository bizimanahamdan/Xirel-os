/**
 * Durable job state machine (Phase 3).
 *
 * Pure logic — no DB access — so the valid-transition table is unit
 * testable in isolation. The DB layer (queue.ts) enforces these rules on
 * every guarded UPDATE; invalid transitions are rejected, never coerced.
 *
 * Lifecycle:
 *
 *   queued ──▶ claimed ──▶ planning ──▶ running ──▶ verifying ──▶ completed
 *     ▲          │            │            │            │
 *     │          │            │            ├─▶ waiting_for_approval
 *     │          │            │            │        │ (approve → queued, deny → cancelled)
 *     │          │            │            ├─▶ retrying ─┐
 *     │          │            ├─▶ retrying ─┘             │ (due again)
 *     │          │            │            ▼              ▼
 *     │          │            │         failed ◀── attempts exhausted
 *     ├─▶ paused ◀────────────┴────────────┘  (any active state, by request)
 *     └─ cancelled (from any non-terminal state, by request)
 *
 * completed / failed / cancelled are TERMINAL. Re-running a failed job
 * means submitting a new job (with the same idempotency key if desired);
 * this keeps attempt accounting honest and prevents zombie retries.
 */

export const JOB_STATUSES = [
  'queued',
  'claimed',
  'planning',
  'running',
  'waiting_for_approval',
  'retrying',
  'verifying',
  'completed',
  'failed',
  'cancelled',
  'paused',
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

export function isJobStatus(value: unknown): value is JobStatus {
  return typeof value === 'string' && (JOB_STATUSES as readonly string[]).includes(value);
}

/** States a job may legally move to from each current state. */
export const JOB_TRANSITIONS: Readonly<Record<JobStatus, readonly JobStatus[]>> = {
  queued: ['claimed', 'cancelled', 'paused'],
  claimed: ['planning', 'running', 'queued', 'retrying', 'failed', 'cancelled'],
  planning: ['running', 'queued', 'retrying', 'failed', 'cancelled', 'paused'],
  running: [
    'verifying',
    'waiting_for_approval',
    'queued', // graceful-shutdown release
    'retrying',
    'failed',
    'completed',
    'cancelled',
    'paused',
  ],
  // approval resolution: approved → queued (fresh claim, granted tools in
  // checkpoint), denied → cancelled. May also be paused by an admin.
  waiting_for_approval: ['queued', 'cancelled', 'paused'],
  retrying: ['claimed', 'queued', 'cancelled', 'paused'],
  verifying: ['completed', 'queued', 'retrying', 'failed', 'cancelled', 'paused'],
  completed: [],
  failed: [],
  cancelled: [],
  paused: ['queued', 'cancelled'],
};

/** States from which the atomic claim may pick a job up. */
export const CLAIMABLE_STATUSES: readonly JobStatus[] = ['queued', 'retrying'];

/** Active states that, if their lease expires, may be reclaimed. */
export const LEASED_STATUSES: readonly JobStatus[] = [
  'claimed',
  'planning',
  'running',
  'verifying',
];

/** waiting_for_approval is intentionally NOT reclaimable by lease expiry —
 *  the blocker is a human decision, not a dead worker. */
export const TERMINAL_STATUSES: readonly JobStatus[] = ['completed', 'failed', 'cancelled'];

export function canTransition(from: JobStatus, to: JobStatus): boolean {
  return JOB_TRANSITIONS[from].includes(to);
}

export class InvalidJobTransitionError extends Error {
  constructor(
    public readonly from: JobStatus,
    public readonly to: JobStatus,
  ) {
    super(`Invalid job transition: ${from} → ${to}`);
    this.name = 'InvalidJobTransitionError';
  }
}

export function assertTransition(from: JobStatus, to: JobStatus): void {
  if (!canTransition(from, to)) throw new InvalidJobTransitionError(from, to);
}

/**
 * Checkpoint contract persisted on agent_jobs.checkpoint (jsonb).
 * Written after every meaningful step so a reclaimed job resumes from
 * the last valid state instead of repeating completed external actions.
 */
export interface JobCheckpoint {
  /** Set once the job has an agent run attached. */
  runId?: string;
  /** Project resolved/created during execution, if any. */
  projectId?: string;
  /** Tools the human approved (waiting_for_approval resolution). */
  approvedTools?: string[];
  /** Number of orchestrator tool steps already persisted. */
  completedSteps?: number;
  /** What the job was last doing (diagnostics + resume decisions). */
  lastStep?: string;
  /** Free-form notes from the executor. */
  notes?: string;
}

export function mergeCheckpoint(
  base: JobCheckpoint | null | undefined,
  patch: JobCheckpoint,
): JobCheckpoint {
  return { ...(base ?? {}), ...patch };
}
