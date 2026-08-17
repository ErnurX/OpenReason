# Stage 1 Exit

Date: 2026-08-14  
Status: **Implemented and testable**

## Exit statement

Stage 1 delivers the open canonical project substrate specified by
[ADR-0001](../architecture/adr/0001-open-event-sourced-project.md) and the
[project-format v0 contract](../architecture/project-format-v0.md). A local
project can be created, changed through typed operations, inspected, verified,
rebuilt from canonical events, and exported without making SQLite or a model
provider part of canonical state.

This is storage and project-state infrastructure. It is not yet the complete
Reasoning Workbench described by the product contract, and it does not claim
to be an autonomous mathematician or scientific agent.

## Delivered substrate

- A pnpm TypeScript monorepo with shared strict compiler and Vitest
  configuration.
- Opaque time-sortable IDs, strict UTC timestamps, canonical JSON, SHA-256
  content hashes, and event hashes.
- Zod envelopes and checked-in public Draft 2020-12 JSON Schemas for manifests,
  actors, objects, edges, artifacts, and open and known event types, with a
  stale-generation check in the repository gate.
- Append-only JSONL event segments. A complete immutable segment becomes
  accepted only when an atomic manifest replacement references it.
- A filesystem content-addressed store at
  `artifacts/sha256/<prefix>/<digest>`, with streaming writes, deduplication,
  and digest verification.
- A disposable SQLite projection with full replay, branch snapshots, current
  object pointers, immutable object-version history, edges, artifacts, and
  verbatim storage of unknown events.
- A project service for initialization, branches, object versions, edges,
  artifact registration, inspection, verification, export, and fixture
  creation.
- A JSON-emitting `rw` CLI over the typed project service.
- An RP-001 seed containing the problem, context, goal, four workstreams, and
  their initial graph edges.

## Acceptance traceability

The identifiers below make the Stage 1 criteria from
[Stage 0 Exit and Stage 1 Entry](stage-0-exit.md) stable and test-addressable.

| ID | Acceptance criterion | Implementation evidence | Automated evidence | Reproduction command |
| --- | --- | --- | --- | --- |
| S1-AC-01 | A project can be created and inspected from the CLI. | `packages/cli/src/index.ts`: `init`, `info`; `packages/store/src/project.ts`: `createProject`, `inspectProject` | `packages/cli/test/cli.test.ts` — “drives a portable project through init, editing, history, rebuild, verify, and export” | `pnpm rw init /tmp/rw-s1 --title "Stage 1"` then `pnpm rw info /tmp/rw-s1` |
| S1-AC-02 | Objects and edges can be appended on isolated branches. | `packages/store/src/project.ts`: `createBranch`, `putObject`, `addEdge`; `packages/store/src/projection.ts`: branch snapshots and branch-scoped current-object and edge views | `packages/store/src/projection.test.ts` — isolated current versions, immutable history, inherited edge snapshot, and child-only edge isolation; `packages/cli/test/cli.test.ts` — branch/object workflow and RP-001 edge counts | `pnpm rw branch create <project> skeptical --from main`, then use `object put` and `edge add` with `--branch skeptical` |
| S1-AC-03 | Artifacts are stored and verified by digest. | `packages/store/src/cas.ts`: `FileSystemArtifactStore`; `packages/store/src/project.ts`: lineage preflight, artifact registration, and project verification; CLI `artifact add` and `verify` | `packages/store/src/cas.test.ts` — byte/file storage, deduplication, corruption detection, digest validation, invalid-entry reporting; `packages/store/test/project.integration.test.ts` — registered-artifact lineage and project verification | Create `run` and `environment` objects on the target branch, pass their returned IDs to `artifact add`, then run `pnpm rw verify <project>` |
| S1-AC-04 | Deleting SQLite and rebuilding produces equivalent current state. | `packages/store/src/projection.ts`: atomic `rebuildProjection`; `packages/store/src/project.ts`: fresh-replay comparison during `verifyProject` | `packages/store/src/projection.test.ts` — “rebuilds an equivalent disposable projection after SQLite is deleted”; `packages/cli/test/cli.test.ts` removes the database, rebuilds, and checks counts | Delete only `<project>/.reasoning/state.sqlite`, then run `pnpm rw rebuild <project>` and `pnpm rw verify <project>` |
| S1-AC-05 | An interrupted append cannot leave a partially accepted event. | `packages/store/src/event-log.ts`: durable staging, immutable segment rename, atomic manifest acceptance boundary, append lock, orphan detection | `packages/store/test/event-log.test.ts` — interruption before manifest commit remains unaccepted; truncated and malformed accepted segments are rejected | `pnpm exec vitest run packages/store/test/event-log.test.ts` |
| S1-AC-06 | Unknown namespaced fields survive import/export. | Zod `looseObject` envelopes in `packages/project-format/src/schemas.ts`; exports copy canonical event bytes and manifest fields rather than projecting them away | `packages/project-format/test/project-format.test.ts` — namespaced manifest/object/event round-trips and unknown future event fields; `packages/store/test/project.integration.test.ts` — canonical export round-trip; projection test retains unknown events verbatim | `pnpm exec vitest run packages/project-format/test/project-format.test.ts packages/store/test/project.integration.test.ts packages/store/src/projection.test.ts` |
| S1-AC-07 | An exported project reopens in a clean temporary directory. | `packages/store/src/project.ts`: `exportProject` verifies and replays the copy, then removes derived state; `inspectProject` and typed mutations lazily rebuild a missing projection | `packages/cli/test/cli.test.ts` exports to a clean directory and verifies the reopened result; `packages/store/test/project.integration.test.ts` asserts canonical-only export and lazy reopen | `pnpm rw export <project> <empty-destination>`, confirm there is no `<empty-destination>/.reasoning`, then run `pnpm rw info <empty-destination>` |
| S1-AC-08 | Initial RP-001 fixture objects contain no provider-specific canonical fields. | `packages/store/src/project.ts`: `createRp001Fixture`; canonical IDs and envelopes come only from `packages/project-format` | `packages/cli/test/cli.test.ts` creates RP-001 through the public CLI and checks canonical IDs, object/edge/event counts, and verification; `packages/store/test/project.integration.test.ts` asserts that provider-identity keys are absent from fixture canonical data | `pnpm rw fixture rp001 /tmp/rw-rp001` then `pnpm rw info /tmp/rw-rp001` and `pnpm rw verify /tmp/rw-rp001` |

Run the complete repository gate with:

```bash
pnpm run check
```

Regenerate the checked-in JSON-Schema artifacts with:

```bash
pnpm schemas
```

## Honest Stage 1 boundaries

- The canonical format is `0.1.0`. Compatibility envelopes include a
  `MigrationApplied` event, but there is no general migration planner or
  cross-version migration catalogue yet.
- Each Stage 1 append creates one immutable event segment. Orphan segments left
  before manifest acceptance are detectable and excluded; compaction and
  snapshots are not implemented.
- Branch creation takes an isolated snapshot and later writes are branch
  scoped. Merge, conflict resolution, accepted-branch publication policy, and
  multi-user synchronization are not implemented.
- The CLI exposes typed project mutations, not an unrestricted raw-event
  append command. This keeps envelope and branch checks on the public path.
- Artifact records require digest, producing-run ID, environment ID, inputs,
  and reproducibility class. Stage 1 does not execute that run, capture tool
  permissions, or independently reproduce the artifact.
- Unknown fields and future event types are preserved, but Stage 1 has no
  plugin runtime or semantics for them.
- `node:sqlite` is used for a local disposable projection and may print an
  experimental-runtime warning on Node.js 22. It is never part of exported
  canonical state.
- There is no reasoning query engine, verification-policy engine, agent
  scheduler, notebook/kernel execution, proof-assistant adapter, literature
  integration, desktop UI, or hosted collaboration service in this stage.
- Passing `rw verify` establishes structural integrity and replay equivalence.
  It does not establish that a mathematical or physical claim is true.

## Next proposed stage: reasoning graph and project services

> Historical handoff: this proposal was subsequently bounded and accepted in
> [ADR-0006](../architecture/adr/0006-stage-2-reasoning-services.md) and
> [Stage 2 Exit](stage-2-exit.md).

At the Stage 1 exit, Stage 2 was not yet a normative contract. The proposed handoff was to build
project-level reasoning services on this substrate:

1. Query and traverse the typed reasoning graph, including exact-version and
   context-scoped dependency views.
2. Add richer project lifecycle operations: version migrations, project
   import, branch merge and conflict records, snapshots, and compaction without
   losing audit meaning.
3. Implement staleness propagation and machine-testable completion and
   verification-policy evaluation over claims, evidence, reviews, runs, and
   failures.
4. Define execution and agent-runtime interfaces on isolated branches, with
   declared inputs, environments, permissions, nondeterminism, cancellation,
   and durable negative results.
5. Expose these services through the first interactive UI without changing the
   canonical format into UI state or a provider-specific database.

That proposal required its own bounded contract before implementation; ADR-0006
records the subset that became committed Stage 2 scope.
