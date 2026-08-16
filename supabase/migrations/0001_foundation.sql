-- Xirel OS — Phase 1 Foundation schema
-- Run via Supabase SQL editor, or `supabase db push` with the CLI.
-- This file is the source of truth for RLS; src/lib/db/schema.ts is the
-- source of truth for TypeScript types. Keep them in sync manually until
-- a migration-generation step is wired up in Phase 1 CI.

create extension if not exists "pgcrypto";

-- ─────────────────────────────────────────────────────────
-- profiles: mirrors auth.users
-- ─────────────────────────────────────────────────────────
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  display_name text,
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Auto-create a profile row whenever a new auth user signs up.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email, display_name, avatar_url)
  values (
    new.id,
    new.email,
    new.raw_user_meta_data ->> 'full_name',
    new.raw_user_meta_data ->> 'avatar_url'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ─────────────────────────────────────────────────────────
-- workspace_role enum
-- ─────────────────────────────────────────────────────────
do $$ begin
  create type workspace_role as enum ('owner', 'admin', 'member', 'viewer');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type ai_provider_id as enum ('gemini', 'groq', 'qwen', 'moonshot', 'openai', 'anthropic');
exception when duplicate_object then null;
end $$;

-- ─────────────────────────────────────────────────────────
-- workspaces
-- ─────────────────────────────────────────────────────────
create table if not exists public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  owner_id uuid not null references public.profiles (id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.workspace_members (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  role workspace_role not null default 'member',
  created_at timestamptz not null default now(),
  unique (workspace_id, user_id)
);

-- When a workspace is created, add its creator as owner automatically.
create or replace function public.handle_new_workspace()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.workspace_members (workspace_id, user_id, role)
  values (new.id, new.owner_id, 'owner');
  return new;
end;
$$;

drop trigger if exists on_workspace_created on public.workspaces;
create trigger on_workspace_created
  after insert on public.workspaces
  for each row execute procedure public.handle_new_workspace();

-- ─────────────────────────────────────────────────────────
-- projects (skeleton)
-- ─────────────────────────────────────────────────────────
create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name text not null,
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ─────────────────────────────────────────────────────────
-- workspace_ai_providers
-- ─────────────────────────────────────────────────────────
create table if not exists public.workspace_ai_providers (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  provider_id ai_provider_id not null,
  enabled boolean not null default true,
  priority text not null default '100',
  config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (workspace_id, provider_id)
);

-- ─────────────────────────────────────────────────────────
-- Row Level Security — this is the actual isolation boundary.
-- Every table a user can query directly must have RLS enabled;
-- privileged server-side operations use the service role key,
-- which bypasses RLS intentionally (see src/lib/db/admin.ts).
-- ─────────────────────────────────────────────────────────

alter table public.profiles enable row level security;
alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.projects enable row level security;
alter table public.workspace_ai_providers enable row level security;

-- profiles: a user can read/update only their own profile.
create policy "profiles_select_own" on public.profiles
  for select using (auth.uid() = id);
create policy "profiles_update_own" on public.profiles
  for update using (auth.uid() = id);

-- workspaces: visible to members only.
create policy "workspaces_select_member" on public.workspaces
  for select using (
    exists (
      select 1 from public.workspace_members m
      where m.workspace_id = workspaces.id and m.user_id = auth.uid()
    )
  );
create policy "workspaces_insert_self_owner" on public.workspaces
  for insert with check (owner_id = auth.uid());
create policy "workspaces_update_admin" on public.workspaces
  for update using (
    exists (
      select 1 from public.workspace_members m
      where m.workspace_id = workspaces.id and m.user_id = auth.uid()
        and m.role in ('owner', 'admin')
    )
  );

-- workspace_members: visible to other members of the same workspace.
create policy "workspace_members_select_same_workspace" on public.workspace_members
  for select using (
    exists (
      select 1 from public.workspace_members m
      where m.workspace_id = workspace_members.workspace_id and m.user_id = auth.uid()
    )
  );
create policy "workspace_members_admin_manage" on public.workspace_members
  for all using (
    exists (
      select 1 from public.workspace_members m
      where m.workspace_id = workspace_members.workspace_id and m.user_id = auth.uid()
        and m.role in ('owner', 'admin')
    )
  );

-- projects: visible/editable by workspace members.
create policy "projects_select_member" on public.projects
  for select using (
    exists (
      select 1 from public.workspace_members m
      where m.workspace_id = projects.workspace_id and m.user_id = auth.uid()
    )
  );
create policy "projects_write_member" on public.projects
  for all using (
    exists (
      select 1 from public.workspace_members m
      where m.workspace_id = projects.workspace_id and m.user_id = auth.uid()
        and m.role in ('owner', 'admin', 'member')
    )
  );

-- workspace_ai_providers: admins/owners only (this is config, not content).
create policy "ai_providers_select_member" on public.workspace_ai_providers
  for select using (
    exists (
      select 1 from public.workspace_members m
      where m.workspace_id = workspace_ai_providers.workspace_id and m.user_id = auth.uid()
    )
  );
create policy "ai_providers_write_admin" on public.workspace_ai_providers
  for all using (
    exists (
      select 1 from public.workspace_members m
      where m.workspace_id = workspace_ai_providers.workspace_id and m.user_id = auth.uid()
        and m.role in ('owner', 'admin')
    )
  );
