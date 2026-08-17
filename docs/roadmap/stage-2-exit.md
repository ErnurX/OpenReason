# Stage 2 Exit

Date: 2026-08-14  
Status: **Implemented and testable**

## Exit statement

Stage 2 turns the Stage 1 project substrate into a compact, provider-neutral
reasoning service layer. A caller can query and traverse a typed branch graph,
derive impact and staleness with exact paths, compare a direct child with its
parent, perform a conservative safe merge, and evaluate machine-testable
completion policies.

These services implement a bounded part of the complete product contract. They
do not constitute an autonomous researcher, execution runtime, graphical
workbench, or collaborative merge system.

## Delivered services

- Deterministic branch-scoped graph query with object-type, edge-type, and
  context filters.
- Cycle-safe upstream, downstream, and bidirectional traversal with optional
  depth bounds and an explicit edge-propagation table.
- Multi-source impact analysis and derived staleness classifications carrying
  current version lineage and causal edge paths; the analysis performs no
  canonical write.
- Direct-child-to-parent three-way object diff and branch-visible edge diff.
- A conflict-free safe merge that creates target-branch object versions,
  preserves merge provenance, and copies source-only edges to new target edge
  IDs bound to current target endpoint versions before recording a typed
  `BranchMerged` event.
- A conflict outcome that applies no source changes and preserves every
  incompatible object as an open target-branch `failure` record.
- A validated, JSON-serializable completion-policy evaluator with object,
  edge, coverage, open-failure, and artifact predicates. Results are derived
  from accepted branch state and include observed canonical IDs.
- JSON CLI adapters for graph query/traversal, impact/staleness, branch
  diff/merge, and completion-policy evaluation.

## Acceptance traceability

| ID | Acceptance criterion | Implementation evidence | Automated evidence |
| --- | --- | --- | --- |
| S2-AC-01 | A typed branch graph can be filtered and traversed deterministically through cycles. | `packages/store/src/graph.ts`: `queryGraph`, `traverseGraph`, `EDGE_PROPAGATION_DIRECTION` | `packages/store/test/graph.test.ts` exercises induced filters, propagation semantics, cycles, stable order, and depth bounds. |
| S2-AC-02 | Explicit changed objects produce explainable downstream impact and staleness without changing canonical history. | `packages/store/src/graph.ts`: `computeImpact`, `deriveStaleness` | `packages/store/test/graph.test.ts` checks multi-source paths, current-version lineage, and an unchanged accepted history. |
| S2-AC-03 | A direct child and parent can be compared against their fork snapshot and merged when conflict free. | `packages/store/src/merge.ts`: `diffBranches`, `mergeBranchSafe`; `packages/project-format/src/schemas.ts`: `BranchMergedPayloadSchema` | `packages/store/test/merge.test.ts` covers three-way classifications, copied target versions, new target edge IDs with rebased exact-version endpoints and source provenance, canonical merge outcome, and project verification. |
| S2-AC-04 | Divergent edits are not silently chosen; they remain open failure objects. | `packages/store/src/merge.ts`: conflicted safe-merge path | `packages/store/test/merge.test.ts` verifies that source changes are not applied, conflict failures remain current, and the resulting project verifies. |
| S2-AC-05 | Completion is a deterministic conjunction of validated rules, not caller-authored status. | `packages/store/src/policy.ts`: `assertCompletionPolicy`, `evaluateCompletionPolicy` | `packages/store/test/policy.test.ts` covers passing and failing gates, edge direction/types, stable evidence, branch visibility, and rejection of injected success. |
| S2-AC-06 | Every Stage 2 service is usable through the JSON CLI with branch names or IDs. | `packages/cli/src/index.ts`: `graph`, `impact`, `staleness`, `branch diff`, `branch merge`, `policy evaluate` | `packages/cli/test/cli.test.ts` — “exposes Stage 2 graph, impact, policy, diff, and safe merge services”. |
| S2-AC-07 | Canonical merge meaning replays independently of the disposable SQLite view. | `packages/store/src/projection.ts`: `BranchMerged` replay; `packages/store/src/project.ts`: fresh-replay verification | `packages/store/test/merge.test.ts` verifies clean and conflicted histories through `verifyProject`, which compares the live view with a fresh canonical replay. |

Run the repository gate with:

```bash
pnpm run check
```

## Honest Stage 2 boundaries

- Impact and staleness are on-demand derived reports. Stage 2 has no persisted
  stale-status event, incremental invalidation worker, or automatic re-check.
- Propagation is structural and typed, not a proof that an affected conclusion
  changed truth value.
- Completion policies provide five structural predicates. They do not yet run
  tests, proof kernels, numerical reproduction, citation review, or waivers.
- Safe merge supports only a direct child back into its parent. It does not
  support arbitrary ancestry, object deletion, interactive conflict editing,
  multi-user synchronization, or automatic publication to accepted state.
- Merge is single-writer, multi-event orchestration and is not transactionally
  atomic as a whole. Every individual append remains crash safe, but Stage 2
  does not yet provide operation-journal recovery or optimistic multi-writer
  head locking.
- `BranchMerged` is canonical; graph indexes and SQLite state remain disposable
  derived data and are excluded from export.
- There is no agent scheduler, model-provider loop, execution fabric,
  notebook/kernel integration, proof-assistant adapter, literature ingestion,
  desktop UI, or hosted collaboration service.
- Passing `rw verify` establishes structural integrity and replay equivalence.
  Passing a completion policy establishes only that its declared structural
  rules hold. Neither result proves a mathematical or physical claim.

## Next proposed stage

The next stage should add branch-scoped workstream execution and typed tool
contracts only after defining authorization, cancellation, recovery, budgets,
and durable run provenance. A UI can then consume the same services without
making view state canonical. General merge, snapshots, compaction, and format
migration remain separate engineering tracks rather than implicit Stage 2
claims.
