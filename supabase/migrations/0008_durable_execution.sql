-- Xirel OS — Phase 3/11: Durable execution engine
--
-- Postgres is the authoritative task store (durable queue): jobs survive
-- browser/worker restarts, are claimed atomically (FOR UPDATE SKIP LOCKED),
-- execute under time-bounded leases with heartbeats, checkpoint their
-- progress, retry transient failures with bounded backoff, and can wait
-- for human approval. Also adds persistent schedules (cron), the worker
-- registry for observability, and platform-level execution switches.
--
-- SAFETY: additive and idempotent only — new tables, new enum, new
-- indexes, new RLS policies using the 0007 definer helpers. No existing
-- table, row, or policy is touched.

-- ─────────────────────────────────────────────────────────
-- agent_job_status enum (full lifecycle incl. queue mechanics)
-- ─────────────────────────────────────────────────────────
do $$ begin
  create type agent_job_status as enum (
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
    'paused'
  );
exception when duplicate_object then null;
end $$;

-- ─────────────────────────────────────────────────────────
-- agent_jobs: the durable task queue
-- ─────────────────────────────────────────────────────────
create table if not exists public.agent_jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  created_by uuid not null references public.profiles (id) on delete cascade,
  task_id uuid references public.tasks (id) on delete set null,
  project_id uuid references public.projects (id) on delete set null,
  run_id uuid references public.agent_runs (id) on delete set null,

  -- what to do
  title text not null,
  description text not null,
  task_type text not null default 'agent_task',
  metadata jsonb not null default '{}'::jsonb,

  -- queue mechanics
  status agent_job_status not null default 'queued',
  priority integer not null default 0,            -- higher runs first
  attempt_count integer not null default 0,
  max_attempts integer not null default 3,
  next_execution_at timestamptz not null default now(),

  -- worker ownership
  lease_owner text,                                -- worker instance id
  lease_expires_at timestamptz,
  heartbeat_at timestamptz,

  -- progress / recovery
  current_step text,
  checkpoint jsonb not null default '{}'::jsonb,
  last_error text,
  error_class text,                                -- transient | permanent | internal

  -- idempotency (client-supplied, workspace-scoped)
  idempotency_key text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

-- Claim scan: eligible = (queued|retrying, due) or (active states, expired lease)
create index if not exists agent_jobs_claim_idx
  on public.agent_jobs (status, next_execution_at);
create index if not exists agent_jobs_workspace_idx
  on public.agent_jobs (workspace_id, created_at desc);
-- Idempotent submission: one job per (workspace, client key)
create unique index if not exists agent_jobs_idempotency_uniq
  on public.agent_jobs (workspace_id, idempotency_key)
  where idempotency_key is not null;
-- Recovery sweep: find leases the worker stopped renewing
create index if not exists agent_jobs_lease_idx
  on public.agent_jobs (lease_expires_at)
  where lease_expires_at is not null;

-- ─────────────────────────────────────────────────────────
-- agent_schedules: persistent cron schedules (worker-enqueued)
-- (created before agent_jobs so jobs can FK their origin schedule;
--  last_job_id is a soft informational reference, no FK needed)
-- ─────────────────────────────────────────────────────────
create table if not exists public.agent_schedules (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  created_by uuid not null references public.profiles (id) on delete cascade,
  project_id uuid references public.projects (id) on delete set null,

  name text not null,
  instructions text not null,          -- what the agent should do on each fire
  task_type text not null default 'scheduled_task',

  cron text not null,                  -- 5-field cron, evaluated in UTC (see lib/schedules)
  timezone text not null default 'UTC',

  status text not null default 'active'
    check (status in ('active','paused','disabled')),

  next_run_at timestamptz not null default now(),
  last_run_at timestamptz,
  last_job_id uuid,                    -- soft reference to the last enqueued job
  last_error text,
  failure_count integer not null default 0,
  run_count integer not null default 0,

  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, name)
);

create index if not exists agent_schedules_due_idx
  on public.agent_schedules (status, next_run_at);

-- job → originating schedule (added here, after the table exists)
alter table public.agent_jobs
  add column if not exists schedule_id uuid
  references public.agent_schedules (id) on delete set null;
create index if not exists agent_jobs_schedule_idx
  on public.agent_jobs (schedule_id) where schedule_id is not null;

-- ─────────────────────────────────────────────────────────
-- agent_approvals: human approval checkpoints
-- ─────────────────────────────────────────────────────────
create table if not exists public.agent_approvals (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  job_id uuid references public.agent_jobs (id) on delete cascade,
  run_id uuid references public.agent_runs (id) on delete set null,
  requested_by uuid not null references public.profiles (id) on delete cascade,

  tool_name text,
  risk_level text,
  summary text not null,
  payload jsonb not null default '{}'::jsonb,

  status text not null default 'pending'
    check (status in ('pending','approved','rejected','expired')),
  decided_by uuid references public.profiles (id) on delete set null,
  decision_note text,
  decided_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists agent_approvals_workspace_idx
  on public.agent_approvals (workspace_id, created_at desc);
create index if not exists agent_approvals_pending_idx
  on public.agent_approvals (workspace_id)
  where status = 'pending';
create index if not exists agent_approvals_job_idx
  on public.agent_approvals (job_id) where job_id is not null;

-- ─────────────────────────────────────────────────────────
-- worker_heartbeats: worker registry (observability, Phase 13)
-- ─────────────────────────────────────────────────────────
create table if not exists public.worker_heartbeats (
  worker_id text primary key,
  workspace_id uuid references public.workspaces (id) on delete cascade,
  last_heartbeat_at timestamptz not null default now(),
  active_jobs integer not null default 0,
  max_concurrency integer not null default 1,
  version text,
  started_at timestamptz not null default now()
);
create index if not exists worker_heartbeats_workspace_idx
  on public.worker_heartbeats (workspace_id);

-- ─────────────────────────────────────────────────────────
-- system_settings: platform-level switches (global pause etc.)
-- ─────────────────────────────────────────────────────────
create table if not exists public.system_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
insert into public.system_settings (key, value) values
  ('execution_paused', 'false'::jsonb)
on conflict (key) do nothing;

-- ─────────────────────────────────────────────────────────
-- Row Level Security — workspace isolation via the 0007
-- definer helpers (recursion-safe by construction).
-- Workers and the API use the server-side DATABASE_URL
-- connection (service trust); RLS protects any direct
-- browser path, consistent with every other table.
-- ─────────────────────────────────────────────────────────
alter table public.agent_jobs enable row level security;
alter table public.agent_approvals enable row level security;
alter table public.agent_schedules enable row level security;
alter table public.worker_heartbeats enable row level security;
alter table public.system_settings enable row level security;

-- jobs
drop policy if exists "agent_jobs_select_workspace_member" on public.agent_jobs;
create policy "agent_jobs_select_workspace_member" on public.agent_jobs
  for select using (public.app_is_workspace_member(agent_jobs.workspace_id));

drop policy if exists "agent_jobs_insert_workspace_member" on public.agent_jobs;
create policy "agent_jobs_insert_workspace_member" on public.agent_jobs
  for insert with check (
    created_by = auth.uid()
    and public.app_can_write_workspace(agent_jobs.workspace_id)
  );

drop policy if exists "agent_jobs_update_workspace_member" on public.agent_jobs;
create policy "agent_jobs_update_workspace_member" on public.agent_jobs
  for update using (
    created_by = auth.uid()
    or public.app_has_workspace_role(
      agent_jobs.workspace_id, array['owner','admin']::workspace_role[]
    )
  );

-- approvals: any member can read; requester or admins decide
drop policy if exists "agent_approvals_select_workspace_member" on public.agent_approvals;
create policy "agent_approvals_select_workspace_member" on public.agent_approvals
  for select using (public.app_is_workspace_member(agent_approvals.workspace_id));

drop policy if exists "agent_approvals_insert_workspace_member" on public.agent_approvals;
create policy "agent_approvals_insert_workspace_member" on public.agent_approvals
  for insert with check (
    requested_by = auth.uid()
    and public.app_can_write_workspace(agent_approvals.workspace_id)
  );

drop policy if exists "agent_approvals_update_workspace_member" on public.agent_approvals;
create policy "agent_approvals_update_workspace_member" on public.agent_approvals
  for update using (
    requested_by = auth.uid()
    or public.app_has_workspace_role(
      agent_approvals.workspace_id, array['owner','admin']::workspace_role[]
    )
  );

-- schedules
drop policy if exists "agent_schedules_select_workspace_member" on public.agent_schedules;
create policy "agent_schedules_select_workspace_member" on public.agent_schedules
  for select using (public.app_is_workspace_member(agent_schedules.workspace_id));

drop policy if exists "agent_schedules_write_workspace_member" on public.agent_schedules;
create policy "agent_schedules_write_workspace_member" on public.agent_schedules
  for all using (public.app_can_write_workspace(agent_schedules.workspace_id))
  with check (public.app_can_write_workspace(agent_schedules.workspace_id));

-- worker heartbeats: readable by members whose workspace the worker
-- serves (health surface); not writable over the browser path at all
-- (workers use the service connection).
drop policy if exists "worker_heartbeats_select_workspace" on public.worker_heartbeats;
create policy "worker_heartbeats_select_workspace" on public.worker_heartbeats
  for select using (public.app_is_workspace_member(worker_heartbeats.workspace_id));

-- system settings: readable by any authenticated user (platform health
-- is not secret); writable only via the service path (no insert/update
-- policy → denied for browser clients).
drop policy if exists "system_settings_select_authenticated" on public.system_settings;
create policy "system_settings_select_authenticated" on public.system_settings
  for select to authenticated using (true);
