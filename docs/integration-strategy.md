# Phase 0 — Integration strategy (hybrid infrastructure)

## What was found (2026-10-31 discovery)

| Branch | Tip | Content |
|---|---|---|
| `main` | `5382e8c` ("Fix invoice selection in payment modal") | **Orphan-root history.** A standalone Business OS app: `src/components/business-app.tsx` (customers/inventory/sales/invoices/payments over `bos_*` tables), `src/app/business/page.tsx`, `src/lib/supabase.ts`, migration `0006_business_os.sql`. The entire AI-OS tree (~15k lines) was **deleted** from this branch. |
| `arena/01a0c404-xirel-os` | `c5df212` | The full AI OS: provider router + 4 providers, orchestrator, planner, durable agent runtime (runs/steps/events), project registry + memory, tool gateway, tasks/messages, auth/workspaces, migrations 0001–0005, chat UI. No Business OS. |

The branches share **no commit history** (main was rewritten as an orphan
root), but ~95% of their trees are identical — main descends from the
same codebase with the AI modules removed and the Business suite added.

## Backup branches (created before any modification)

- `backup/pre-hybrid-main` → `5382e8c` (main, untouched)
- `backup/pre-hybrid-ai-os` → `c5df212` (AI branch pre-merge, untouched)

## Strategy executed: union merge, AI runtime as the base

A regular merge was impossible (unrelated histories) and wrong anyway —
main's defining change was a mass deletion of the AI tree. The correct
integration preserves BOTH feature sets:

1. **Base = the AI branch** (session branch, full AI runtime, Phase 4
   durable execution).
2. `git merge --no-commit --allow-unrelated-histories origin/main`;
   conflicts (the 11 shell files) resolved deliberately:
   - **Kept from the AI branch:** tsconfig (strict superset), tailwind
     (command-center palette), postcss, layout, root page (auth-aware
     redirect), .env.example (pooler + provider docs), .gitignore,
     README (updated separately), package.json (superset + Business's
     `lucide-react`), next.config (strict mode + body limit +
     `poweredByHeader: false`).
   - **Taken from main:** `business/page.tsx`, `business-app.tsx`
     (6 minimal strictness guards added — behavior unchanged),
     `lib/supabase.ts`, `0006_business_os.sql`,
     `docs/verification-checklist.md`, the full Business stylesheet
     (appended verbatim to globals.css under a marker banner).
3. **Migration numbering** is complementary, no collision: 0001–0005
   (AI) + 0006_business_os (main) + new work starts at 0007.
4. **Duplicate implementations:** none found — the Business suite uses
   the browser Supabase client directly against `bos_*` tables; the AI
   runtime uses the server-side Drizzle path. They share auth
   (Supabase) and the `workspaces`/`workspace_members` tables, which is
   exactly the RLS-recursion bug's blast radius — fixed by 0007 and
   verified against a real database (`npm run test:db`).

## Result

`/` → AI OS command center (authenticated) or login.
`/business` → Business OS suite (own auth gate, same Supabase project).
Both build in one production bundle; `npm run typecheck`, `next build`,
`npm run test:logic` (59) and `npm run test:db` (44) all green.
