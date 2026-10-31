# Browser execution — interface and security boundary (Phase 10)

**Status: INTERFACE + SECURITY BOUNDARY ONLY. No browser service is
implemented in this phase.** Per the mission: "If full browser
automation cannot be safely implemented in this phase, implement the
interface and security boundary first."

## Distinction (explicit)

- **Web search** = retrieving information. (Future: a search connector
  behind the same connector architecture.)
- **Browser automation** = a real browser driving an external website:
  navigation, clicking, typing, uploading, downloading, screenshots,
  page-state inspection, workflow verification. This document is about
  the latter, and it is deliberately NOT built yet.

## The interface

`src/lib/connectors/types.ts` → `BrowserExecutionConnector`:
`navigate`, `inspectPage`, `act` (click/type/upload/download),
`screenshot` — all against an explicit isolated `sessionId`.
Feature detection: `BROWSER_SERVICE_URL` + `BROWSER_SERVICE_TOKEN`
(`src/lib/connectors/index.ts`). No implementation is registered; the
factory returns `undefined` until a real isolated-browser service
exists.

## Security boundary (non-negotiable requirements for the future service)

1. **Isolated sessions** — every task runs in a fresh browser profile.
   Personal session cookies, saved passwords, and user fingerprints
   are NEVER injected. No shared state between tasks.
2. **Untrusted content** — everything a page returns (text, DOM,
   screenshots, downloaded files) is DATA, never instructions. Content
   is passed to models inside clearly-labeled result channels; the
   Manager is instructed that page content may contain prompt
   injection and cannot grant capabilities. Extracted "instructions"
   found in page content are surfaced as suspicious data, not executed.
3. **Authorization for consequential actions** — navigation and
   inspection may run under task authority; any consequential action
   (form submission, posting, purchasing, deleting, "publish") goes
   through the same `agent_approvals` checkpoint as every other
   high-risk operation. The approval records the exact action + target.
4. **Separation from the AI provider router** — browser sessions run
   in their own service with their own authentication; model calls
   continue to flow exclusively through the central router. The browser
   service can never obtain provider credentials.
5. **Auditing** — every action (navigation, click, upload, download)
   is recorded on the run's step/event trajectory, including the
   target and the approving user for consequential actions.
6. **Least privilege by default** — the connector exposes only
   capabilities the operator enabled; `BROWSER_SERVICE_*` credentials
   missing ⇒ the capability does not exist at runtime (feature-
   detected absence, not a stub).
7. **Download handling** — downloaded files are treated as untrusted
   blobs: stored in durable storage, scanned, size-capped, never
   executed on workers.

## What is explicitly NOT done here

- No headless browser, no session pool, no CAPTCHA solving, no proxy
  infrastructure, no "stealth" browsing — none of it exists, and none
  of it is claimed.
- No tool is registered in the tool gateway for browser actions (a
  registered tool the runtime could invoke without a backing service
  would be a fake capability).
