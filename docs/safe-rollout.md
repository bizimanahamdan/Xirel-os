# Phase 15 — Safe rollout & rollback plan

**Nothing in this plan has been executed against production.** All
changes live on `arena/01a0c404-xirel-os`; `main` is untouched and
backed up (`backup/pre-hybrid-main`, `backup/pre-hybrid-ai-os`).

## Rollout sequence (requires explicit authorization at each gate)

1. **Database first, non-destructively.** In the Supabase dashboard
   (SQL editor), run in order and verify each:
   - `0005_project_agent_runtime.sql` (project registry + agent runs)
   - `0006_business_os.sql` (if not already applied — check
     `select count(*) from information_schema.tables where table_name='bos_customers'`)
   - `0007_rls_recursion_fix.sql` — **fixes the live "infinite
     recursion detected in policy for relation workspace_members"
     error.** Verified against real PostgreSQL (`npm run test:db`); on
     production, verify by re-loading the Business OS app: the
     workspace list must load without the recursion error.
   - `0008_durable_execution.sql` (durable queue/schedules/approvals)
   All four are additive and idempotent (safe to run twice). No table,
   column, row, or existing policy is dropped.
2. **Vercel (frontend + API):** create a PREVIEW deployment from the
   integration branch (Vercel → New Deployment → branch). Compare:
   `/` redirects to `/command`; `/chat` and `/dashboard` behave as
   before; `/business` loads the Business suite; `/api/chat` still
   streams. Only then promote (or merge the PR) to production.
3. **Render (background worker):** create the worker from
   `render.yaml` (manual — `autoDeploy: false`; note background
   workers have no free tier). Set `DATABASE_URL` + provider keys in
   the Render dashboard. Verify: worker logs "database reachable —
   polling for work", `worker_heartbeats` shows a fresh row,
   `/api/system/health` reports the worker online.
4. **End-to-end:** submit a durable task in `/command` with the worker
   running; watch it claim → run → complete with the browser closed;
   then kill the worker mid-run and confirm another worker (or a
   restarted one) reclaims from the checkpoint.

## Feature flags

- The worker only executes what lands in `agent_jobs` — the Vercel app
  runs unchanged without it (tasks simply wait in `queued`).
- `GLOBAL_ADMIN_USER_IDS` gates the global pause; unset = disabled.
- The chat page uses `/api/agent/chat`; legacy `/api/chat` remains for
  rollback — switching back is a one-line revert in `chat-client.tsx`.

## Rollback

- **Frontend/API:** redeploy the previous Vercel deployment (or merge
  revert). Data written by the new code (runs/jobs rows) is inert to
  the old code.
- **Worker:** suspend the Render service — the queue simply accumulates
  `queued` jobs; nothing is lost (Postgres is the source of truth).
- **Database:** no destructive rollback is needed or possible-by-design
  (nothing was dropped). New tables can be left in place; RLS keeps
  them isolated.
- **Branches:** `backup/pre-hybrid-main` and `backup/pre-hybrid-ai-os`
  preserve both pre-integration states.
