-- Xirel OS — Phase 3: Agent Framework (tool execution audit log)
--
-- SAFETY: This migration is fully idempotent and safe to run multiple
-- times, following the same patterns as 0002 (see MIGRATION_SAFETY.md).
-- Preserves all existing Phase 1/2 tables, data, auth, and RLS.

-- ─────────────────────────────────────────────────────────
-- tool_risk_level enum
-- ─────────────────────────────────────────────────────────
do $$ begin
  create type tool_risk_level as enum (
    'safe',
    'low',
    'moderate',
    'high',
    'destructive'
  );
exception when duplicate_object then null;
end $$;

-- ─────────────────────────────────────────────────────────
-- tool_executions: audit log of every tool call an agent makes
-- ─────────────────────────────────────────────────────────
create table if not exists public.tool_executions (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks (id) on delete cascade,
  tool_name text not null,
  risk_level tool_risk_level not null,
  input jsonb not null,
  output jsonb,
  success boolean not null,
  error text,
  created_at timestamptz not null default now()
);

create index if not exists tool_executions_task_id_idx on public.tool_executions (task_id);
create index if not exists tool_executions_tool_name_idx on public.tool_executions (tool_name);
create index if not exists tool_executions_created_at_idx on public.tool_executions (created_at);

-- ─────────────────────────────────────────────────────────
-- Row Level Security
-- ─────────────────────────────────────────────────────────
alter table public.tool_executions enable row level security;

drop policy if exists "tool_executions_select_workspace_member" on public.tool_executions;
drop policy if exists "tool_executions_insert_workspace_member" on public.tool_executions;

-- SELECT: any workspace member can see the tool execution history for
-- tasks in their workspace (transparency into what an agent did).
create policy "tool_executions_select_workspace_member" on public.tool_executions
  for select using (
    exists (
      select 1 from public.tasks t
      join public.workspace_members m on t.workspace_id = m.workspace_id
      where t.id = tool_executions.task_id and m.user_id = auth.uid()
    )
  );

-- INSERT: any workspace member can log a tool execution against their
-- workspace's tasks. Note: the app writes these rows via the Drizzle
-- (DATABASE_URL) path, which bypasses RLS entirely — this policy exists
-- to protect the equivalent browser-side Supabase client path if one is
-- ever added, per the project's "RLS is the real isolation boundary,
-- not just app-level checks" principle (see schema.ts and README).
create policy "tool_executions_insert_workspace_member" on public.tool_executions
  for insert with check (
    exists (
      select 1 from public.tasks t
      join public.workspace_members m on t.workspace_id = m.workspace_id
      where t.id = tool_executions.task_id and m.user_id = auth.uid()
    )
  );
