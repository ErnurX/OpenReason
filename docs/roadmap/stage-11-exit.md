# Stage 11 Exit — Collaboration and RBAC

Status: **Partial — canonical collaboration substrate complete; authenticated deployment pending**

Date: 2026-08-21

## Acceptance criteria

| ID | Criterion | Evidence |
|---|---|---|
| S11-AC-01 | Canonical append-only membership grants and revocations assign only the six typed human roles. | `collaboration.test.ts` membership replay and denial cases. |
| S11-AC-02 | The frozen permission matrix denies every capability absent from a role; no role receives implicit merge authority, and agents/contributors cannot merge accepted state. | Role-matrix and unauthorized-merge tests. |
| S11-AC-03 | Comments reference an exact object/version/hash; review requests bind exact claim and evidence versions. | RP-001 collaboration test. |
| S11-AC-04 | Reviewer-attributed approvals/rejections become stale after a relevant revision and stale decisions append nothing. | RP-001 collaboration test. |
| S11-AC-05 | Collaboration writers cannot directly change default state. An owner-issued, branch-head-bound, one-shot decision tied to exact subject/issuer membership grants is required for a human to merge a child branch. | Direct-default denial, revoked/regranted membership, and accepted-merge provenance tests. |
| S11-AC-06 | Accepted merge atomically records adopted objects/edges, authorization consumption, and `BranchMerged`; no replay can reuse authorization. | Atomic batch/replay and crash-window stale-projection tests. |
| S11-AC-07 | Collaboration commands expose authenticated-facade replay, current/stale reviews, and decisions; canonical operations offer optimistic head checks. | `packages/cli/test/stage11.test.ts`, concurrency, and crash-window review tests. |

## Definition-of-Done mapping

- `DOD-COLLAB-03`: **partially met only.** The portable model supports separate
  actor records, branches, review, and provenance-bearing merges. It does not
  authenticate two users, so this requirement is not complete until a server
  transport maps authenticated principals to trusted actors and protects event
  writes.
- `DOD-COLLAB-04`: comments/reviews bind exact versions; revisions stalen them.
- `DOD-AGENT-05` and `INV-AGENT-05`: accepted-state merge requires explicit
  human authorization and cannot be granted by an agent or contributor role.
- `INV-STATE-03`, `INV-STATE-04`, and `INV-SEC-01`: membership, decisions, and
  anchors are versioned canonical history with deny-by-default capabilities.

## Explicit boundaries

- This is not live Yjs co-editing, SSO, or a shared sync service.
- The actor given to the local API/CLI is a trusted transport input; a server
  deployment must authenticate it and prevent direct event-log writes.
- Existing raw local project commands and explicitly named `audit*` reads are
  backwards-compatible single-user/operator tools, not a substitute for the
  collaboration transport.
- The collaboration layer refreshes SQLite from the canonical event head before
  using branch visibility, review staleness, or merge heads; a crash between
  canonical append and cache rebuild cannot revive a stale authorization.
- An approval records review activity only; it does not prove correctness or
  bypass verification/release gates.
