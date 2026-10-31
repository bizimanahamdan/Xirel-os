-- Xirel OS — Phase 4: Project-Aware Durable Agent Runtime
--
-- Adds the persistent state the agent runtime needs:
--   1. projects                — EXTENDED (table already exists from Phase 1;
--                                this adds registry columns, no data touched)
--   2. tasks.project_id        — nullable link: task belongs to a project
--   3. agent_runs              — durable agent execution record
--   4. agent_steps             — per-run step trajectory (plan/execute/verify)
--   5. agent_events            — human-readable activity events per run
--   6. project_memory          — structured, long-lived project memory
--   7. tool_executions.run_id  — nullable link: audit row to the run that made it
--
-- SAFETY: fully idempotent (create if not exists / add column if not exists /
-- drop policy if exists + create). No table is dropped, no existing row is
-- modified, every new column is nullable or has a default, so all existing
-- data and RLS policies are preserved. See MIGRATION_SAFETY.md.

-- ─────────────────────────────────────────────────────────
-- Enums (idempotent)
-- ─────────────────────────────────────────────────────────
do $$ begin
  create type project_status as enum ('active', 'paused', 'archived');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type agent_run_status as enum (
    'queued', 'planning', 'running', 'waiting_for_approval',
    'verifying', 'completed', 'failed', 'cancelled', 'paused'
  );
exception when duplicate_object then null;
end $$;

do $$ begin
  create type agent_step_status as enum (
    'pending', 'running', 'completed', 'failed', 'skipped', 'waiting_approval'
  );
exception when duplicate_object then null;
end $$;

-- ─────────────────────────────────────────────────────────
-- projects: extend the Phase 1 skeleton with registry metadata.
-- Secrets (API keys, tokens) are deliberately NOT columns here —
-- integration credentials belong in server-side env/secret storage.
-- Integration-specific details that don't warrant a column yet
-- belong in `metadata` jsonb.
-- ─────────────────────────────────────────────────────────
alter table public.projects
  add column if not exists status project_status not null default 'active',
  add column if not exists repo_provider text,
  add column if not exists repo_url text,
  add column if not exists repo_owner text,
  add column if not exists repo_name text,
  add column if not exists deployment_provider text,
  add column if not exists deployment_url text,
  add column if not exists database_provider text,
  add column if not exists metadata jsonb not null default '{}'::jsonb;

create index if not exists projects_workspace_id_idx on public.projects (workspace_id);
create index if not exists projects_status_idx on public.projects (status);

-- Case-insensitive per-workspace name uniqueness, used by project
-- resolution ("continue the Soleil project"). Uniqueness is desirable
-- but must not break an existing deployment that already has duplicate
-- names: try the unique index first; if existing data violates it, fall
-- back to a plain lookup index (resolution still works; uniqueness is
-- then enforced by the application layer on create/rename).
do $$
begin
  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public' and indexname = 'projects_workspace_name_unique_idx'
  ) then
    begin
      create unique index projects_workspace_name_unique_idx
        on public.projects (workspace_id, lower(name));
    exception when others then
      raise notice 'projects: duplicate names exist — falling back to non-unique lookup index';
      create index if not exists projects_workspace_name_idx2
        on public.projects (workspace_id, lower(name));
    end;
  end if;
end $$;

-- ─────────────────────────────────────────────────────────
-- tasks.project_id — nullable: every existing task stays valid
-- ─────────────────────────────────────────────────────────
alter table public.tasks
  add column if not exists project_id uuid references public.projects (id) on delete set null;

create index if not exists tasks_project_id_idx on public.tasks (project_id);

-- ─────────────────────────────────────────────────────────
-- agent_runs: one durable agent execution (a "turn" of work).
-- Survives the HTTP request that started it so a crashed run
-- leaves real state behind instead of nothing.
-- ─────────────────────────────────────────────────────────
create table if not exists public.agent_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  task_id uuid references public.tasks (id) on delete set null,
  project_id uuid references public.projects (id) on delete set null,
  user_id uuid not null references public.profiles (id) on delete cascade,
  status agent_run_status not null default 'queued',
  current_step text,
  error text,
  metadata jsonb not null default '{}'::jsonb,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists agent_runs_workspace_id_idx on public.agent_runs (workspace_id);
create index if not exists agent_runs_task_id_idx on public.agent_runs (task_id);
create index if not exists agent_runs_project_id_idx on public.agent_runs (project_id);
create index if not exists agent_runs_status_idx on public.agent_runs (status);

-- ─────────────────────────────────────────────────────────
-- agent_steps: the per-step trajectory of a run. input/output are
-- jsonb on purpose — step payloads vary by step type and rigid
-- columns would freeze the shape prematurely.
-- ─────────────────────────────────────────────────────────
create table if not exists public.agent_steps (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.agent_runs (id) on delete cascade,
  sequence integer not null,
  step_type text not null,
  description text not null,
  status agent_step_status not null default 'pending',
  input jsonb,
  output jsonb,
  tool_name text,
  error text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists agent_steps_run_id_seq_idx on public.agent_steps (run_id, sequence);
create index if not exists agent_steps_tool_name_idx on public.agent_steps (tool_name);

-- ─────────────────────────────────────────────────────────
-- agent_events: append-only activity feed for a run ("Resolving
-- project...", "Executing tool...", "Verifying result...").
-- run_id is nullable so workspace-level events are also possible.
-- ─────────────────────────────────────────────────────────
create table if not exists public.agent_events (
  id uuid primary key default gen_random_uuid(),
  run_id uuid references public.agent_runs (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  event_type text not null,
  message text not null,
  data jsonb,
  created_at timestamptz not null default now()
);

create index if not exists agent_events_run_id_idx on public.agent_events (run_id);
create index if not exists agent_events_workspace_id_idx on public.agent_events (workspace_id);

-- ─────────────────────────────────────────────────────────
-- project_memory: structured long-lived project knowledge —
-- distinct from raw chat history. kind keeps entries queryable
-- (decision / problem / status / fact / note); (project_id, kind, key)
-- supports upsert-style "current status" updates without history loss.
-- ─────────────────────────────────────────────────────────
create table if not exists public.project_memory (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  kind text not null,
  key text not null default '',
  content text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists project_memory_project_id_idx on public.project_memory (project_id);
create unique index if not exists project_memory_entry_idx
  on public.project_memory (project_id, kind, key);

-- ─────────────────────────────────────────────────────────
-- tool_executions.run_id — nullable link from the existing audit
-- log to the run that produced it (existing rows unaffected)
-- ─────────────────────────────────────────────────────────
alter table public.tool_executions
  add column if not exists run_id uuid references public.agent_runs (id) on delete set null;

create index if not exists tool_executions_run_id_idx on public.tool_executions (run_id);

-- ─────────────────────────────────────────────────────────
-- Row Level Security (same membership model as 0001-0003)
-- ─────────────────────────────────────────────────────────
alter table public.agent_runs enable row level security;
alter table public.agent_steps enable row level security;
alter table public.agent_events enable row level security;
alter table public.project_memory enable row level security;

drop policy if exists "agent_runs_select_workspace_member" on public.agent_runs;
drop policy if exists "agent_runs_insert_workspace_member" on public.agent_runs;
drop policy if exists "agent_runs_update_member" on public.agent_runs;

drop policy if exists "agent_steps_select_workspace_member" on public.agent_steps;
drop policy if exists "agent_steps_insert_workspace_member" on public.agent_steps;
drop policy if exists "agent_steps_update_member" on public.agent_steps;

drop policy if exists "agent_events_select_workspace_member" on public.agent_events;
drop policy if exists "agent_events_insert_workspace_member" on public.agent_events;

drop policy if exists "project_memory_select_workspace_member" on public.project_memory;
drop policy if exists "project_memory_write_workspace_member" on public.project_memory;
drop policy if exists "project_memory_delete_workspace_member" on public.project_memory;

-- agent_runs
create policy "agent_runs_select_workspace_member" on public.agent_runs
  for select using (
    exists (
      select 1 from public.workspace_members m
      where m.workspace_id = agent_runs.workspace_id and m.user_id = auth.uid()
    )
  );

create policy "agent_runs_insert_workspace_member" on public.agent_runs
  for insert with check (
    user_id = auth.uid() and
    exists (
      select 1 from public.workspace_members m
      where m.workspace_id = agent_runs.workspace_id and m.user_id = auth.uid()
    )
  );

create policy "agent_runs_update_member" on public.agent_runs
  for update using (
    user_id = auth.uid() or
    exists (
      select 1 from public.workspace_members m
      where m.workspace_id = agent_runs.workspace_id and m.user_id = auth.uid()
        and m.role in ('owner', 'admin')
    )
  );

-- agent_steps (via the run's workspace)
create policy "agent_steps_select_workspace_member" on public.agent_steps
  for select using (
    exists (
      select 1 from public.agent_runs r
      join public.workspace_members m on r.workspace_id = m.workspace_id
      where r.id = agent_steps.run_id and m.user_id = auth.uid()
    )
  );

create policy "agent_steps_insert_workspace_member" on public.agent_steps
  for insert with check (
    exists (
      select 1 from public.agent_runs r
      join public.workspace_members m on r.workspace_id = m.workspace_id
      where r.id = agent_steps.run_id and m.user_id = auth.uid()
    )
  );

create policy "agent_steps_update_member" on public.agent_steps
  for update using (
    exists (
      select 1 from public.agent_runs r
      join public.workspace_members m on r.workspace_id = m.workspace_id
      where r.id = agent_steps.run_id and m.user_id = auth.uid()
    )
  );

-- agent_events (workspace_id is a direct column)
create policy "agent_events_select_workspace_member" on public.agent_events
  for select using (
    exists (
      select 1 from public.workspace_members m
      where m.workspace_id = agent_events.workspace_id and m.user_id = auth.uid()
    )
  );

create policy "agent_events_insert_workspace_member" on public.agent_events
  for insert with check (
    exists (
      select 1 from public.workspace_members m
      where m.workspace_id = agent_events.workspace_id and m.user_id = auth.uid()
    )
  );

-- project_memory (via the project's workspace)
create policy "project_memory_select_workspace_member" on public.project_memory
  for select using (
    exists (
      select 1 from public.workspace_members m
      where m.workspace_id = project_memory.workspace_id and m.user_id = auth.uid()
    )
  );

create policy "project_memory_write_workspace_member" on public.project_memory
  for insert with check (
    exists (
      select 1 from public.workspace_members m
      where m.workspace_id = project_memory.workspace_id and m.user_id = auth.uid()
    )
  );

create policy "project_memory_delete_workspace_member" on public.project_memory
  for delete using (
    exists (
      select 1 from public.workspace_members m
      where m.workspace_id = project_memory.workspace_id and m.user_id = auth.uid()
        and m.role in ('owner', 'admin')
    )
  );
