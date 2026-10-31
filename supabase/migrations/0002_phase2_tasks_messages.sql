-- Xirel OS — Phase 2: Chat/Command Interface
-- Adds task and message tables to support the AI Command Center.
-- 
-- SAFETY: This migration is fully idempotent and safe to run multiple times.
-- Existing tables, indexes, data, and RLS policies are preserved or updated as needed.

-- ─────────────────────────────────────────────────────────
-- task_status enum: lifecycle of a task
-- ─────────────────────────────────────────────────────────
do $$ begin
  create type task_status as enum (
    'queued',
    'planning',
    'running',
    'waiting_for_approval',
    'completed',
    'failed',
    'cancelled'
  );
exception when duplicate_object then null;
end $$;

-- ─────────────────────────────────────────────────────────
-- tasks: represents a single user command/request
-- ─────────────────────────────────────────────────────────
create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  title text not null,
  description text,
  status task_status not null default 'queued',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Create indexes only if they don't exist
-- (CREATE INDEX IF NOT EXISTS is safe to run repeatedly)
create index if not exists tasks_workspace_id_idx on public.tasks (workspace_id);
create index if not exists tasks_user_id_idx on public.tasks (user_id);
create index if not exists tasks_status_idx on public.tasks (status);

-- ─────────────────────────────────────────────────────────
-- messages: individual messages within a task's conversation
-- ─────────────────────────────────────────────────────────
create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks (id) on delete cascade,
  role text not null check (role in ('system', 'user', 'assistant')),
  content text not null,
  created_at timestamptz not null default now()
);

create index if not exists messages_task_id_idx on public.messages (task_id);
create index if not exists messages_created_at_idx on public.messages (created_at);

-- ─────────────────────────────────────────────────────────
-- Row Level Security
-- ─────────────────────────────────────────────────────────

-- Enable RLS on tasks table (idempotent: enabling RLS twice is safe)
alter table public.tasks enable row level security;

-- Enable RLS on messages table (idempotent: enabling RLS twice is safe)
alter table public.messages enable row level security;

-- Drop existing policies before creating to ensure clean state
-- This makes the migration safe to re-run if policies were partially created
drop policy if exists "tasks_select_workspace_member" on public.tasks;
drop policy if exists "tasks_insert_workspace_member" on public.tasks;
drop policy if exists "tasks_update_owner" on public.tasks;
drop policy if exists "tasks_delete_owner" on public.tasks;

drop policy if exists "messages_select_workspace_member" on public.messages;
drop policy if exists "messages_insert_workspace_member" on public.messages;
drop policy if exists "messages_delete_task_owner" on public.messages;

-- ─────────────────────────────────────────────────────────
-- Tasks RLS Policies
-- ─────────────────────────────────────────────────────────

-- SELECT: users can see only tasks in their workspace
create policy "tasks_select_workspace_member" on public.tasks
  for select using (
    exists (
      select 1 from public.workspace_members m
      where m.workspace_id = tasks.workspace_id and m.user_id = auth.uid()
    )
  );

-- INSERT: user can create a task only if they're in the workspace
create policy "tasks_insert_workspace_member" on public.tasks
  for insert with check (
    user_id = auth.uid() and
    exists (
      select 1 from public.workspace_members m
      where m.workspace_id = tasks.workspace_id and m.user_id = auth.uid()
    )
  );

-- UPDATE: task owner or workspace admin/owner can update
create policy "tasks_update_owner" on public.tasks
  for update using (
    user_id = auth.uid() or
    exists (
      select 1 from public.workspace_members m
      where m.workspace_id = tasks.workspace_id and m.user_id = auth.uid()
        and m.role in ('owner', 'admin')
    )
  );

-- DELETE: task owner or workspace admin/owner can delete (prepared for future use)
create policy "tasks_delete_owner" on public.tasks
  for delete using (
    user_id = auth.uid() or
    exists (
      select 1 from public.workspace_members m
      where m.workspace_id = tasks.workspace_id and m.user_id = auth.uid()
        and m.role in ('owner', 'admin')
    )
  );

-- ─────────────────────────────────────────────────────────
-- Messages RLS Policies
-- ─────────────────────────────────────────────────────────

-- SELECT: any workspace member can read messages in their workspace's tasks
create policy "messages_select_workspace_member" on public.messages
  for select using (
    exists (
      select 1 from public.tasks t
      join public.workspace_members m on t.workspace_id = m.workspace_id
      where t.id = messages.task_id and m.user_id = auth.uid()
    )
  );

-- INSERT: any workspace member can add messages to their workspace's tasks
create policy "messages_insert_workspace_member" on public.messages
  for insert with check (
    exists (
      select 1 from public.tasks t
      join public.workspace_members m on t.workspace_id = m.workspace_id
      where t.id = messages.task_id and m.user_id = auth.uid()
    )
  );

-- DELETE: task owner or workspace admin/owner can delete (prepared for future use)
create policy "messages_delete_task_owner" on public.messages
  for delete using (
    exists (
      select 1 from public.tasks t
      where t.id = messages.task_id and (
        t.user_id = auth.uid() or
        exists (
          select 1 from public.workspace_members m
          where m.workspace_id = t.workspace_id and m.user_id = auth.uid()
            and m.role in ('owner', 'admin')
        )
      )
    )
  );

