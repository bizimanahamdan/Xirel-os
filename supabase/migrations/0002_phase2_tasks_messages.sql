-- Xirel OS — Phase 2: Chat/Command Interface
-- Adds task and message tables to support the AI Command Center.

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

alter table public.tasks enable row level security;
alter table public.messages enable row level security;

-- tasks: users can see/manage only tasks in their workspace
create policy "tasks_select_workspace_member" on public.tasks
  for select using (
    exists (
      select 1 from public.workspace_members m
      where m.workspace_id = tasks.workspace_id and m.user_id = auth.uid()
    )
  );

create policy "tasks_insert_workspace_member" on public.tasks
  for insert with check (
    user_id = auth.uid() and
    exists (
      select 1 from public.workspace_members m
      where m.workspace_id = tasks.workspace_id and m.user_id = auth.uid()
    )
  );

create policy "tasks_update_owner" on public.tasks
  for update using (
    user_id = auth.uid() or
    exists (
      select 1 from public.workspace_members m
      where m.workspace_id = tasks.workspace_id and m.user_id = auth.uid()
        and m.role in ('owner', 'admin')
    )
  );

-- messages: visible to workspace members
create policy "messages_select_workspace_member" on public.messages
  for select using (
    exists (
      select 1 from public.tasks t
      join public.workspace_members m on t.workspace_id = m.workspace_id
      where t.id = messages.task_id and m.user_id = auth.uid()
    )
  );

create policy "messages_insert_workspace_member" on public.messages
  for insert with check (
    exists (
      select 1 from public.tasks t
      join public.workspace_members m on t.workspace_id = m.workspace_id
      where t.id = messages.task_id and m.user_id = auth.uid()
    )
  );
