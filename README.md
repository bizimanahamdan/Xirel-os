# Xirel OS — Phase 1: Foundation

AI Business Operating System. This is the foundation layer only:
application architecture, database, authentication, and the AI
provider abstraction. No agents, tools, or orchestration yet — those
are Phase 2 and 3, deliberately not started here (see project spec's
phasing requirement).

## Status: honest accounting

**Structurally complete, not yet executed.** This was built in an
environment with no network access, so nothing here has been run —
not `npm install`, not a build, not a real request to Supabase or any
AI provider. Treat this as a strong first draft that needs a real
verification pass, not as tested software. Concretely, before trusting
this:

1. `npm install` and `npm run build` — confirm it compiles.
2. Create a free Supabase project, run the migration, confirm auth
   (GitHub OAuth + magic link) actually completes end-to-end.
3. Add one real AI provider key (Groq is fastest to test — free,
   no waitlist) and hit `/api/ai/health` to confirm the adapter's
   request/response parsing matches the live API. The adapters were
   written from documented API shapes, not verified against live
   responses — provider APIs do drift from docs.

## What's implemented

- **Next.js 14 App Router + TypeScript**, Tailwind for styling.
- **Auth**: Supabase Auth, email magic link + GitHub OAuth, session
  refresh via middleware, protected `/dashboard` routes.
- **Database**: Postgres via Supabase. Schema covers `profiles`,
  `workspaces`, `workspace_members` (with roles), `projects`
  (skeleton — repo/deploy fields land in Phase 4/5), and
  `workspace_ai_providers` (per-workspace provider enable/priority).
  Row Level Security policies enforce workspace isolation at the
  database level, not just in application code.
- **AI provider abstraction** (`src/lib/ai/`): a single `AiProvider`
  interface (`types.ts`) that Gemini, Groq, and Qwen adapters
  implement identically. Nothing outside `src/lib/ai/providers/`
  should ever import a provider-specific shape.
- **Config detection** (`src/lib/ai/config.ts`): checks which
  provider API keys are actually present at runtime. Never assumes a
  provider is available — `isConfigured()` is a real check, not a
  hardcoded `true`.
- **Router** (`src/lib/ai/router/`): ordered fallback across
  providers only. This is intentionally *not* the full task-aware
  routing policy from the project spec (task type, cost, multimodal
  needs) — that needs real task metadata from the Phase 2/3 agent
  framework to route on meaningfully. Building a "smart" router
  against no real tasks would mean guessing at requirements.

## What's explicitly NOT here yet (by design)

- Agents, tools, tool registry, permissions — Phase 3.
- GitHub integration, Developer Agent — Phase 4.
- Deployment adapters — Phase 5.
- Leads, CRM, content, social, analytics — Phases 6–9.
- Moonshot/OpenAI/Anthropic adapters — the spec treats these as
  optional; adding one is a ~150-line file following the exact shape
  of `src/lib/ai/providers/groq.ts`, once you decide you need it.
- ~~Workspace creation UI/flow~~ — implemented (`/onboarding` +
  `src/lib/workspaces/`). Dashboard redirects users with no workspace
  there automatically. Read the trust-boundary comment at the top of
  `create-workspace.ts` before writing more Drizzle mutations — it
  explains an important, easy-to-miss gap between how RLS is enforced
  (Supabase's PostgREST/JWT path) and how this app's server actions
  actually write data (a direct, RLS-bypassing Postgres connection).

## Setup

```bash
npm install
cp .env.example .env.local
# fill in .env.local:
#   - Supabase project URL + anon key + service role key + DATABASE_URL
#   - at least one AI provider key (GROQ_API_KEY is easiest to start with)
```

In the Supabase dashboard:
1. Authentication → Providers → enable GitHub, add your GitHub OAuth
   app's client ID/secret (create that app in GitHub Developer
   Settings; callback URL is `https://<your-supabase-project>.supabase.co/auth/v1/callback`).
2. SQL Editor → run `supabase/migrations/0001_foundation.sql`.

Then:

```bash
npm run dev
```

## Architecture decisions worth knowing

- **Supabase over separate Postgres + Auth vendor**: one free-tier
  service instead of two, and RLS gives real data isolation instead
  of relying purely on application-layer checks.
- **Drizzle over Prisma**: closer to raw SQL, smaller runtime,
  migrations are plain `.sql` files you can read and reason about —
  matches the "prefer simple maintainable architecture" principle.
- **Provider adapters use raw `fetch`, not vendor SDKs**: keeps the
  provider layer dependency-light and makes the request/response
  shape fully visible in this codebase rather than hidden in a
  third-party SDK. Trade-off: adapters need updating if a provider's
  REST API changes shape, same as an SDK would.
- **RLS protects the Supabase-client path** (browser client, any
  future PostgREST/realtime usage) **but not the Drizzle path.**
  This is a correction to an earlier draft of this README, which
  overstated RLS as "the" isolation boundary everywhere. In practice:
  all current data writes go through Server Actions using Drizzle
  over `DATABASE_URL`, a direct Postgres connection that bypasses RLS.
  Isolation there depends on every query manually scoping by the
  session's `user.id` — see the comment in
  `src/lib/workspaces/create-workspace.ts` for the full explanation.
  If this codebase later adds browser-side Supabase queries (e.g.
  realtime task updates), RLS is what protects those, and the two
  enforcement mechanisms need to be kept in sync by hand — there's no
  single switch that guarantees both.

## Next task

Onboarding (`/onboarding`) now creates a workspace and the dashboard
redirects there automatically for new users. Reasonable next steps:
1. **Verify this foundation actually works** (run the checklist
   above) before building anything else on top of it — still not
   done, and still the highest-priority item.
2. Once verified: start Phase 2 (AI Command Center) — the chat/command
   interface that turns a natural-language request into the first
   real call through `routeGenerateText`.
