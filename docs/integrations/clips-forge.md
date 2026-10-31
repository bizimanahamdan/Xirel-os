# Clips Forge integration boundary (Phase 9)

**Status: BOUNDARY ONLY — no connector exists. Nothing is faked.**

The repo contains no Clips Forge / "AI Clips" source code (verified by
searching the tree — the only historical mentions are comments), and no
Clips Forge API contract is available in this environment. The standing
rules forbid inventing endpoints or shipping placeholder integrations
that pretend to work, so this document defines exactly what exists,
what is required, and what happens the moment a verified API is
provided.

## What exists today

| Piece | File | State |
|---|---|---|
| Connector interface | `src/lib/connectors/types.ts` → `VideoGenerationConnector` | shipped (types only) |
| Feature detection | `src/lib/connectors/index.ts` (`clips_forge` requires `CLIPS_FORGE_API_URL` + `CLIPS_FORGE_API_KEY`) | shipped |
| Skill boundary | `src/lib/agents/skills/clips-forge-video-production.ts` | declared `available: false` — refuses to execute |
| Approval gate for publishing | `agent_approvals` + risk `high` policy | shipped and enforced |

## What the real API must provide (verification checklist)

Before the connector is written, the deployed Clips Forge API must be
verified against each of these — with a real request/response, not
documentation alone:

1. **Authenticated generation requests** — endpoint, auth scheme
   (API key / OAuth), request schema, and idempotency behavior on
   duplicate submission.
2. **Job status** — how to poll (or webhook) a generation job:
   states (queued/processing/done/failed), error reporting, ETA.
3. **Asset retrieval** — how finished clips are fetched (URL TTLs?
   streaming? multipart?), plus format/codec metadata.
4. **Storage references** — whether assets persist on their side and
   for how long (determines how urgently we copy to durable storage).
5. **Publishing targets** — if publishing happens through Clips Forge,
   the exact submission + reconciliation model (platform ids, links,
   uncertain-state handling).

## The workflow this unlocks (unchanged, per the mission)

1. Understand the request → identify the selected project (registry).
2. Generate a content plan.
3. Submit generation jobs (`submitGenerationJob` — consequential,
   logged; queued ≠ completed).
4. Track job progress (`getJobStatus`; durable job heartbeats keep the
   run alive across worker restarts).
5. Retrieve assets (`retrieveAsset`) → store in durable storage
   (never only on the worker's ephemeral disk).
6. Verify asset availability + format (re-read storage; `verified` vs
   `claimed` distinction applies).
7. Present previews to the user.
8. **Request approval** — publishing requires an approved
   `agent_approvals` row (risk `high`); the approval gate blocks
   unattended execution today.
9. Publish only after authorization; record platform identifiers and
   links; reconcile uncertain outcomes before any retry (never
   double-publish).
10. Report the outcome distinguishing submitted / processing /
    generated / retrieved / verified / approved / published.

## What is explicitly NOT done

- No HTTP client, no base URL, no endpoint paths — none were verifiable.
- No credentials are configured (`CLIPS_FORGE_API_URL` /
  `CLIPS_FORGE_API_KEY` are documented placeholders in `.env.example`
  with an explicit "do not set until the connector ships" note).
- The skill is registered so the Manager can honestly answer "this
  capability exists as a plan, and here is exactly what's missing" —
  it cannot be invoked to fake progress.
