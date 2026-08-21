# ADR-0016: Stage 11 Canonical Collaboration and Explicit Merge Authority

Status: **Accepted**

Date: 2026-08-21

## Context

The portable project already represents branches, typed objects, evidence, and
safe merges. Collaboration adds a separate question: which human is allowed to
perform each operation, and which exact versions did a review or approval
cover? A mutable user table, an unversioned comment, or a UI-only merge button
would violate the canonical audit and human-authority boundaries.

## Decision

Stage 11 stores collaboration facts as append-only, content-hashed canonical
events. Human membership grants/revocations assign one of six typed roles:
`owner`, `researcher`, `contributor`, `reviewer`, `compute-operator`, or
`viewer`. The policy is deny-by-default. Only owners manage membership; no role
has an implicit accepted-state merge capability.

Collaboration writers—including owners—cannot write typed objects or edges to
the default/accepted branch. They must create a work branch and use the
explicit merge path. The permission matrix is frozen at runtime and returns
defensive snapshots; `branch:merge` is an action label, never a role grant.

Comments carry an exact object ID, version ID, and content hash. Review
requests bind one claim version and one or more evidence versions. A human
reviewer records an attributed approval or rejection only while every anchor is
the version visible on the requested branch. Revising any anchored statement or
evidence makes the request stale; the old record stays visible and a new request
is required.

An owner issues a separate, branch-head-bound merge authorization to a named
human. The authorization records the subject's and issuer's exact membership
IDs and grant event IDs, so revoking and re-granting the same actor creates a
new authority epoch rather than reviving an old decision. The authorized
subject may invoke the safe merge only when source and target heads still match
that decision and both exact grants remain active. The resulting `BranchMerged`
event contains the authorization ID, preserving the decision-to-merge
provenance. It atomically appends every adopted object/edge,
authorization-consumed record, and `BranchMerged` event through one event-log
batch. An authorization is therefore one-shot and neither a crash nor replay
can expose partially adopted accepted state. The pre-existing local merge
primitive remains an unopinionated migration and single-user service;
collaborative transports must use the authorization-aware service.

## Trust and transport boundary

This repository does **not** implement SSO, session management, Yjs, a live
sync server, or network identity proof. The collaboration API receives a
trusted actor parameter and authorizes it against canonical membership. A real
multi-user deployment must authenticate the caller at a server-owned boundary,
protect canonical event writes, map that authenticated principal to the actor,
and then call this API. Supplying arbitrary actor IDs to a local CLI is not
authentication and must not be represented as such.

Optimistic concurrency is provided through the canonical event head and merge
branch-head snapshots. Before a collaboration service uses SQLite-backed
visibility, staleness, or branch-head data, it refreshes the disposable
projection from and confirms it against the exact canonical tail. Thus a crash
after canonical acceptance but before projection rebuild cannot authorize a
revision using stale cache state. A caller that loses a race receives a
retryable conflict instead of silently rebasing its decision.

Raw event replays are explicitly named `audit*` APIs for offline repair and
forensics. Network transports use the role-checked collaboration read facade;
they do not obtain an unauthenticated convenience read by accident.

## Consequences

- DOD-COLLAB-04 has portable, event-replayable substrate tests. DOD-COLLAB-03
  is only partially met: local trusted actor inputs exercise the state model,
  but two *authenticated* users require the deployment boundary below.
- Reviewer attribution and role decisions are evidence of a human action, not
  proof of mathematical correctness (INV-MEANING-03).
- Agents cannot become human members or invoke accepted-state merges;
  contributors cannot receive merge authority, and researchers need an
  owner-issued merge decision.
- This supersedes the Stage 2 single-writer merge recovery boundary for the
  safe-merge implementation; the raw primitive remains unauthenticated and is
  not a collaboration transport.
- Unknown collaboration events remain portable across older projections. The
  collaboration module reconstructs its own read model from canonical history.

## Rejected alternatives

- **Yjs document state as canonical collaboration state:** adds a transport
  replica without replacing version-bound typed project objects.
- **SSO/session records in the project:** credentials and deployment identity
  are not portable project artifacts.
- **Role-based implicit merge permission:** violates explicit human authority
  over accepted state.
- **Approval attached to an object alias:** loses the exact version and cannot
  become stale deterministically.
