# Phase 3 — Agent Framework (First Slice)

**Status:** Code complete for this slice. Not yet deployed/tested against a live database or live provider APIs (no network access in the build environment — see caveat below).

---

## What "first slice" means here

The project spec lists ten agent types and a full agent architecture (tools, permissions, workflows, memory). Building all of that in one pass — most of it untestable, all of it unverified — would mean shipping ten agents' worth of guessed API surface. Instead this slice builds the smallest *real* thing:

1. Tool calling actually works, across all four provider adapters (it was previously a fabricated capability claim — see below).
2. One agent (Orchestrator) that can hold a conversation and call tools.
3. Two tools that are real and safe enough to prove the loop end-to-end.
4. An audit trail so every tool call is inspectable.

Everything else in the spec's agent list — Developer, Research, Testing, Deployment, Marketing, Content, Analytics, Security agents, plus workflows and long-term memory — is explicitly **not** in this slice. Each needs its own design pass (tool set, system prompt, permissions), not a stub.

---

## A capability-honesty bug this slice fixes

Before this work, every AI provider adapter's `getCapabilities()` returned `supportsTools: true` — but no adapter actually sent tools to the model or parsed tool-call responses. That's a fabricated capability claim, which the project's core principles explicitly forbid ("never fabricate API capabilities," "never claim a feature works until it has been tested"). This slice makes that claim true for `generateText` across all four providers (Gemini, Groq, OpenRouter, Qwen).

A second, unrelated bug was also fixed while it was in view: `routeGenerateText` sent one hardcoded model string to every provider on fallback (`'openai/gpt-4-turbo'`, an OpenRouter-qualified name that means nothing to Groq or Gemini). This is now resolved for the new agent path via `src/lib/ai/models.ts` (per-provider defaults) and an optional `RouteRequest.modelByProvider` override — backward compatible, so Phase 2's `/api/chat` (which still passes a single `model` string) is untouched and keeps working exactly as before.

---

## What was built

### 1. Tool-calling in the AI provider layer
- `src/lib/ai/types.ts` — `AiToolDefinition`, `AiToolCall`, `tool` message role, `toolCalls`/`finishReason` on responses. Additive; nothing Phase 2 depends on changed shape.
- `src/lib/ai/providers/openai-compat.ts` — shared wire-format helpers for Groq/OpenRouter/Qwen (they're byte-for-byte the same OpenAI-compatible shape).
- `src/lib/ai/providers/gemini.ts` — Gemini's distinct `functionDeclarations`/`functionCall`/`functionResponse` shape, implemented separately and flagged as the least-verified part of this change (Gemini's multi-turn function-calling convention has shifted across API versions in the past).
- Scoped to `generateText`, not `streamText`. The agent loop needs a full response to inspect `finishReason` before deciding whether to continue — there's no meaningful token stream mid-loop.

### 2. Tool framework
`src/lib/agents/tools/`
- `types.ts` — the `ToolDefinition` contract: name, description, Zod input schema (runtime validation) + JSON Schema (wire format to the model), output description, risk level, required permission, `execute()`.
- `calculator.ts` — hand-written recursive-descent arithmetic parser. Deliberately not `eval()`/`Function()` — those would let a model's tool arguments run arbitrary JS.
- `datetime.ts` — `get_current_datetime`, UTC ISO 8601 + Unix timestamp. Models need this because their training data has a cutoff.
- `registry.ts` — central lookup, mirrors the existing AI provider registry pattern.

### 3. Orchestrator Agent
`src/lib/agents/orchestrator.ts` — the agentic loop:
```
call model (with tools) 
  -> finishReason === 'tool_calls'?
       yes -> permission-check each call against caller's workspace role
           -> validate arguments with the tool's Zod schema
           -> execute, log to tool_executions (success or failure)
           -> feed results back as role:'tool' messages
           -> repeat (max 6 iterations)
       no  -> return final text
```
Permission model: tool's `requiredPermission` (`member`/`admin`/`owner`) is checked against the caller's actual `workspace_members.role` for that workspace — not just "is authenticated." A `viewer` cannot invoke any current tool (both ship at `member` level).

### 4. Database
- `tool_executions` table (migration `0003`) — every tool call, success or failure, with inputs/outputs, RLS-scoped to workspace members of the owning task.
- `messages` table widened (migration `0004`) — `role` check constraint now allows `'tool'`; new nullable `tool_calls`/`tool_call_id`/`tool_name` columns. Existing Phase 2 rows are untouched.

### 5. API
`POST /api/agent/chat` — new, separate endpoint. `/api/chat` (Phase 2, streaming, no tools) is completely untouched. Request/response:
```jsonc
// Request
{ "taskId": "uuid | null", "message": "...", "workspaceId": "uuid", "providerPriority": ["groq"] }

// Response (200)
{ "taskId": "uuid", "text": "...", "providerId": "groq", "iterations": 2 }

// Response (error)
{ "error": "...", "taskId": "uuid" }
```
Not streamed — documented as a known limitation above, not silently dropped.

---

## What's deliberately NOT in this slice

- **Other agents** (Developer, Research, Testing, Deployment, Marketing, Content, Analytics, Security) — each needs its own tool set + system prompt.
- **More tools** — no `web_search`, GitHub, or code-execution tools. Each needs a real external service (API key, sandboxing) not yet wired up.
- **Approval workflows** for `moderate`+ risk tools — the spec requires human approval for destructive operations; both current tools are `risk: 'safe'` so this hasn't been needed yet, but the `ToolRiskLevel` field exists specifically so a later pass can gate on it.
- **UI for the agent chat** — `/api/agent/chat` has no frontend yet. `/chat` (Phase 2 UI) still talks to `/api/chat`, not this endpoint.
- **Streaming for the agent loop.**
- **Task decomposition / planning** — the Orchestrator reacts to what the model asks for; it doesn't break a request into a pre-planned multi-step workflow.

---

## Honest status: untested against live systems

This was built with no network access in the build environment. That means:
- **Not run:** `npm install`, `npm run build`, `tsc`, any live API call to Groq/OpenRouter/Gemini/Qwen, any Supabase migration.
- **Verified by inspection instead:** every new/changed file was manually cross-checked against its call sites and the existing (previously-working) code it plugs into — types line up, imports resolve to real exports, the migration's constraint name matches Postgres's auto-generated name for the original inline `CHECK`, `AiResponse.finishReason` is set on every `generateText` return path in all four adapters.
- **Most likely failure points if something's still wrong:** Gemini's function-calling wire format (flagged above as least-verified), and anything that only surfaces at `tsc` time that manual review missed.

Before trusting this in production: run `npm run build`, then the deployment steps below with a real workspace and a real provider key.

---

## Deployment steps for this slice

1. **Push code** — same as Phase 2, `git push origin main --force`.
2. **Run migrations `0003` then `0004`** in Supabase SQL Editor, in that order (both idempotent — safe to re-run). `0004` depends on `0002`'s `messages` table already existing.
3. **No UI yet** — test via a direct request to `/api/agent/chat` (e.g. from an authenticated browser session's fetch, or a REST client with the Supabase session cookie) rather than through `/chat`.
4. **Try a message that should trigger tool use**, e.g. `"What's 47 * 189, and what's today's date?"` — this should produce two tool calls (`calculator`, `get_current_datetime`) visible in `tool_executions`, then a final answer.
5. **Check `tool_executions`** in Supabase to confirm the audit log populated as expected.

---

## Suggested next slice

Pick one, not both:
- **Wire a minimal chat UI to `/api/agent/chat`** so this is actually usable, even before more agents/tools exist.
- **Design and add one more real tool** with an external dependency (e.g. a free-tier web search API) now that the framework and permission model exist to hang it on.

Either is a smaller, verifiable next step — consistent with the phasing principle of completing and validating one piece before building the next.
