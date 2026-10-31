-- Xirel OS — Phase 6: FIX "infinite recursion detected in policy for
-- relation workspace_members"
--
-- ROOT CAUSE (diagnosed from 0001_foundation.sql):
--   The SELECT policy on workspace_members
--     ("workspace_members_select_same_workspace")
--   and the FOR ALL policy ("workspace_members_admin_manage") both run an
--   EXISTS() subquery against workspace_members — the very table being
--   policed. Every policy evaluation re-triggers the same policy, so ANY
--   authenticated query whose policy chain touches workspace_members
--   (selecting workspace_members directly — as the Business OS app does —
--   or any tasks/messages/projects query, whose policies subquery it)
--   fails with:  infinite recursion detected in policy for relation
--   "workspace_members".
--
-- FIX (targeted, additive, semantics-preserving):
--   1. Introduce narrowly-scoped SECURITY DEFINER helper functions that
--      answer "is this user a member / does this user hold one of these
--      roles in this workspace". As table owner, the definer bypasses RLS
--      on workspace_members, so policy evaluation terminates.
--   2. Rewrite ONLY the policy bodies (same policy names, same effective
--      rules) to call the helpers instead of subquerying
--      workspace_members inline.
--
-- Nothing else changes: no table is dropped or altered, no row is
-- touched, isolation semantics are identical, and every statement is
-- idempotent (drop-if-exists + create), following the repo's 0002/0003
-- migration safety pattern. Policies on bos_* tables (0006) already use
-- this definer-function pattern and were never affected.
--
-- SECURITY IMPLICATIONS OF THE DEFINER FUNCTIONS (documented per the
-- Phase 6 requirements):
--   - Each function is STABLE, single-purpose, and hard-vulnerable to
--     nothing: it takes only a workspace uuid, filters by auth.uid()
--     internally (NULL for anonymous → false), and leaks nothing else.
--   - search_path is pinned to public so a malicious search_path cannot
--     redirect the workspace_members reference.
--   - Execute is revoked from PUBLIC (anonymous) and granted to
--     authenticated only. They can merely ask membership/role questions
--     about themselves — the same information the old policies exposed.
--   - They do NOT bypass RLS for callers: they run as the owner ONLY
--     internally; the caller's own statement still sees only rows its
--     policies allow.

-- ─────────────────────────────────────────────────────────
-- 1) Helper functions (the recursion-breaking boundary)
-- ─────────────────────────────────────────────────────────
create or replace function public.app_is_workspace_member(target_workspace uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.workspace_members wm
    where wm.workspace_id = target_workspace
      and wm.user_id = auth.uid()
  );
$$;

create or replace function public.app_has_workspace_role(
  target_workspace uuid,
  allowed workspace_role[]
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.workspace_members wm
    where wm.workspace_id = target_workspace
      and wm.user_id = auth.uid()
      and wm.role in (select r from unnest(allowed) as r)
  );
$$;

create or replace function public.app_can_write_workspace(target_workspace uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.app_has_workspace_role(
    target_workspace, array['owner','admin','member']::workspace_role[]
  );
$$;

revoke all on function public.app_is_workspace_member(uuid) from public;
revoke all on function public.app_has_workspace_role(uuid, workspace_role[]) from public;
revoke all on function public.app_can_write_workspace(uuid) from public;
grant execute on function public.app_is_workspace_member(uuid) to authenticated;
grant execute on function public.app_has_workspace_role(uuid, workspace_role[]) to authenticated;
grant execute on function public.app_can_write_workspace(uuid) to authenticated;

-- ─────────────────────────────────────────────────────────
-- 2) Rewrite the recursive policies (0001 foundation)
--    Same names, same rules — definer helper instead of
--    a self-referential subquery.
-- ─────────────────────────────────────────────────────────
drop policy if exists "workspaces_select_member" on public.workspaces;
create policy "workspaces_select_member" on public.workspaces
  for select using (public.app_is_workspace_member(id));

drop policy if exists "workspaces_update_admin" on public.workspaces;
create policy "workspaces_update_admin" on public.workspaces
  for update using (
    public.app_has_workspace_role(id, array['owner','admin']::workspace_role[])
  );

drop policy if exists "workspace_members_select_same_workspace" on public.workspace_members;
create policy "workspace_members_select_same_workspace" on public.workspace_members
  for select using (public.app_is_workspace_member(workspace_members.workspace_id));

drop policy if exists "workspace_members_admin_manage" on public.workspace_members;
create policy "workspace_members_admin_manage" on public.workspace_members
  for all using (
    public.app_has_workspace_role(
      workspace_members.workspace_id, array['owner','admin']::workspace_role[]
    )
  ) with check (
    public.app_has_workspace_role(
      workspace_members.workspace_id, array['owner','admin']::workspace_role[]
    )
  );

drop policy if exists "projects_select_member" on public.projects;
create policy "projects_select_member" on public.projects
  for select using (public.app_is_workspace_member(projects.workspace_id));

drop policy if exists "projects_write_member" on public.projects;
create policy "projects_write_member" on public.projects
  for all using (public.app_can_write_workspace(projects.workspace_id))
  with check (public.app_can_write_workspace(projects.workspace_id));

drop policy if exists "ai_providers_select_member" on public.workspace_ai_providers;
create policy "ai_providers_select_member" on public.workspace_ai_providers
  for select using (public.app_is_workspace_member(workspace_ai_providers.workspace_id));

drop policy if exists "ai_providers_write_admin" on public.workspace_ai_providers;
create policy "ai_providers_write_admin" on public.workspace_ai_providers
  for all using (
    public.app_has_workspace_role(
      workspace_ai_providers.workspace_id, array['owner','admin']::workspace_role[]
    )
  ) with check (
    public.app_has_workspace_role(
      workspace_ai_providers.workspace_id, array['owner','admin']::workspace_role[]
    )
  );

-- ─────────────────────────────────────────────────────────
-- 3) Rewrite the subquerying policies (0002 tasks/messages,
--    0003 tool_executions) — they recursed transitively
--    through workspace_members' own policies.
-- ─────────────────────────────────────────────────────────
drop policy if exists "tasks_select_workspace_member" on public.tasks;
create policy "tasks_select_workspace_member" on public.tasks
  for select using (public.app_is_workspace_member(tasks.workspace_id));

drop policy if exists "tasks_insert_workspace_member" on public.tasks;
create policy "tasks_insert_workspace_member" on public.tasks
  for insert with check (
    user_id = auth.uid() and public.app_is_workspace_member(tasks.workspace_id)
  );

drop policy if exists "tasks_update_owner" on public.tasks;
create policy "tasks_update_owner" on public.tasks
  for update using (
    user_id = auth.uid()
    or public.app_has_workspace_role(
      tasks.workspace_id, array['owner','admin']::workspace_role[]
    )
  );

drop policy if exists "tasks_delete_owner" on public.tasks;
create policy "tasks_delete_owner" on public.tasks
  for delete using (
    user_id = auth.uid()
    or public.app_has_workspace_role(
      tasks.workspace_id, array['owner','admin']::workspace_role[]
    )
  );

drop policy if exists "messages_select_workspace_member" on public.messages;
create policy "messages_select_workspace_member" on public.messages
  for select using (
    exists (
      select 1 from public.tasks t
      where t.id = messages.task_id
        and public.app_is_workspace_member(t.workspace_id)
    )
  );

drop policy if exists "messages_insert_workspace_member" on public.messages;
create policy "messages_insert_workspace_member" on public.messages
  for insert with check (
    exists (
      select 1 from public.tasks t
      where t.id = messages.task_id
        and public.app_is_workspace_member(t.workspace_id)
    )
  );

drop policy if exists "messages_delete_task_owner" on public.messages;
create policy "messages_delete_task_owner" on public.messages
  for delete using (
    exists (
      select 1 from public.tasks t
      where t.id = messages.task_id
        and (
          t.user_id = auth.uid()
          or public.app_has_workspace_role(
            t.workspace_id, array['owner','admin']::workspace_role[]
          )
        )
    )
  );

drop policy if exists "tool_executions_select_workspace_member" on public.tool_executions;
create policy "tool_executions_select_workspace_member" on public.tool_executions
  for select using (
    exists (
      select 1 from public.tasks t
      where t.id = tool_executions.task_id
        and public.app_is_workspace_member(t.workspace_id)
    )
  );

drop policy if exists "tool_executions_insert_workspace_member" on public.tool_executions;
create policy "tool_executions_insert_workspace_member" on public.tool_executions
  for insert with check (
    exists (
      select 1 from public.tasks t
      where t.id = tool_executions.task_id
        and public.app_is_workspace_member(t.workspace_id)
    )
  );

-- ─────────────────────────────────────────────────────────
-- 4) Rewrite the 0005 agent-runtime policies the same way.
-- ─────────────────────────────────────────────────────────
drop policy if exists "agent_runs_select_workspace_member" on public.agent_runs;
create policy "agent_runs_select_workspace_member" on public.agent_runs
  for select using (public.app_is_workspace_member(agent_runs.workspace_id));

drop policy if exists "agent_runs_insert_workspace_member" on public.agent_runs;
create policy "agent_runs_insert_workspace_member" on public.agent_runs
  for insert with check (
    user_id = auth.uid() and public.app_is_workspace_member(agent_runs.workspace_id)
  );

drop policy if exists "agent_runs_update_member" on public.agent_runs;
create policy "agent_runs_update_member" on public.agent_runs
  for update using (
    user_id = auth.uid()
    or public.app_has_workspace_role(
      agent_runs.workspace_id, array['owner','admin']::workspace_role[]
    )
  );

drop policy if exists "agent_steps_select_workspace_member" on public.agent_steps;
create policy "agent_steps_select_workspace_member" on public.agent_steps
  for select using (
    exists (
      select 1 from public.agent_runs r
      where r.id = agent_steps.run_id
        and public.app_is_workspace_member(r.workspace_id)
    )
  );

drop policy if exists "agent_steps_insert_workspace_member" on public.agent_steps;
create policy "agent_steps_insert_workspace_member" on public.agent_steps
  for insert with check (
    exists (
      select 1 from public.agent_runs r
      where r.id = agent_steps.run_id
        and public.app_is_workspace_member(r.workspace_id)
    )
  );

drop policy if exists "agent_steps_update_member" on public.agent_steps;
create policy "agent_steps_update_member" on public.agent_steps
  for update using (
    exists (
      select 1 from public.agent_runs r
      where r.id = agent_steps.run_id
        and public.app_is_workspace_member(r.workspace_id)
    )
  );

drop policy if exists "agent_events_select_workspace_member" on public.agent_events;
create policy "agent_events_select_workspace_member" on public.agent_events
  for select using (public.app_is_workspace_member(agent_events.workspace_id));

drop policy if exists "agent_events_insert_workspace_member" on public.agent_events;
create policy "agent_events_insert_workspace_member" on public.agent_events
  for insert with check (public.app_is_workspace_member(agent_events.workspace_id));

drop policy if exists "project_memory_select_workspace_member" on public.project_memory;
create policy "project_memory_select_workspace_member" on public.project_memory
  for select using (public.app_is_workspace_member(project_memory.workspace_id));

drop policy if exists "project_memory_write_workspace_member" on public.project_memory;
create policy "project_memory_write_workspace_member" on public.project_memory
  for insert with check (public.app_is_workspace_member(project_memory.workspace_id));

drop policy if exists "project_memory_delete_workspace_member" on public.project_memory;
create policy "project_memory_delete_workspace_member" on public.project_memory
  for delete using (
    public.app_has_workspace_role(
      project_memory.workspace_id, array['owner','admin']::workspace_role[]
    )
  );
