-- Xirel OS — Phase 3: Agent Framework (messages table extension)
--
-- Extends the Phase 2 `messages` table to support tool-calling:
--   1. Adds a 'tool' role (tool execution results fed back to the model)
--   2. Adds columns to carry tool-call data on assistant/tool messages
--
-- SAFETY: fully idempotent, safe to run multiple times. Does not touch
-- existing rows — new columns are nullable, so all Phase 2 messages
-- (role IN 'system'/'user'/'assistant', no tool data) remain valid and
-- unaffected. See MIGRATION_SAFETY.md for the patterns used here.

-- ─────────────────────────────────────────────────────────
-- New columns (nullable — existing rows are unaffected)
-- ─────────────────────────────────────────────────────────
alter table public.messages
  add column if not exists tool_calls jsonb,
  add column if not exists tool_call_id text,
  add column if not exists tool_name text;

-- ─────────────────────────────────────────────────────────
-- Widen the role check constraint to allow 'tool'.
-- Postgres has no "ADD CONSTRAINT IF NOT EXISTS" for check constraints,
-- so we drop-if-exists then add, same idempotent pattern as the
-- DROP POLICY IF EXISTS approach used for RLS policies in 0002/0003.
-- ─────────────────────────────────────────────────────────
alter table public.messages drop constraint if exists messages_role_check;

alter table public.messages
  add constraint messages_role_check
  check (role in ('system', 'user', 'assistant', 'tool'));
