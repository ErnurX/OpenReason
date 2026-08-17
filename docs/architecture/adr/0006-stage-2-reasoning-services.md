# ADR-0006: Stage 2 Reasoning Services and Conservative Branch Merge

Status: **Accepted**  
Date: 2026-08-14

## Context

Stage 1 made typed project history canonical and SQLite disposable, but it did
not yet provide operations for asking graph questions, tracing the effect of a
changed premise, comparing isolated work, or evaluating a completion gate.
Those operations must preserve the open event-sourced format and must not turn
an analytical result or model opinion into proof.

General distributed merge, an agent scheduler, execution sandboxes, and a UI
would add different concurrency and authorization requirements. They are not
needed to establish the first project-level reasoning semantics.

## Decision

Stage 2 adds four services inside the modular monolith.

### Typed graph analysis

Graph queries operate on one branch's current projection and may filter object
types, edge types, and context. Traversal is deterministic, cycle safe, and
bounded by an optional depth. An explicit propagation table defines which end
of every known edge is upstream; callers do not infer dependency direction
from arrow shape alone.

Impact and staleness are derived reports. Given explicit changed object IDs,
they return affected current objects, exact-version lineage, depth, and edge
paths. They append no events and do not claim that an object is false; they say
that dependent work requires re-evaluation.

### Serializable completion policies

A Stage 2 completion policy is a closed, JSON-serializable schema evaluated as
a conjunction over one branch's accepted state. The initial predicates cover:

- current-object counts;
- typed edge counts and endpoint types;
- required incoming or outgoing edges for every object of a type;
- absence of open failure objects;
- artifact counts, optionally restricted by media type.

The evaluator validates policy structure and derives every result, including
the observed canonical IDs. A caller-supplied `passed` field is invalid.
Passing a policy is a gate result, not mathematical verification.

### Direct-child three-way diff and safe merge

Stage 2 compares only a direct child branch with its parent. The fork snapshot
is the base for a three-way object comparison, producing `source-only`,
`target-only`, `converged`, or `conflict` classifications plus branch-visible
edge differences.

The `safe` merge strategy is deliberately conservative:

- it runs only child-to-parent and only after an explicit caller action;
- if there are no object conflicts, source-only current objects become new
  target-branch versions with merge provenance; every source-only edge is
  copied to a new target edge whose endpoints name the target's current exact
  versions, while `x-rw:merge` retains the source edge ID, source branch ID,
  and merge ID;
- target-only and already converged objects are left unchanged;
- if any object conflicts, no source object or edge is applied; every conflict
  becomes an open `failure` object on the target branch;
- every successfully completed orchestration ends with a typed `BranchMerged`
  event recording the base, heads, strategy, outcome, applied versions, newly
  adopted target edge IDs, and conflict records.

The canonical event history remains the source of truth. Graph, diff, impact,
staleness, and policy reads may use SQLite projections, but SQLite remains
derived and rebuildable.

## Concurrency and recovery boundary

Stage 2 merge orchestration assumes one writer and is not a transaction across
its several append operations. Each individual event append retains the Stage
1 atomic acceptance boundary, so a crash does not corrupt prior history, but a
crash before the final `BranchMerged` event can leave already appended target
versions or failure records. A later stage must add an operation journal or an
atomic merge batch, optimistic head checks, retry semantics, and multi-writer
coordination before exposing general collaborative merge.

Stage 2 does not implement object deletion, arbitrary ancestry merge, rename
semantics, conflict editing, accepted-state publication policy, or automatic
agent merge. The future agent runtime must put this service behind explicit
merge authorization as required by `INV-AGENT-05`.

## Consequences

- Project state can now answer reproducible graph, impact, branch comparison,
  and hard-gate questions without a model provider.
- Staleness remains explainable because reports carry exact IDs and paths.
- Conflicts and failed merge attempts remain first-class research history.
- The propagation table and completion-policy schema are product semantics and
  require compatibility care when extended.
- Stage 2 merge is useful for local isolated work, but is not yet a general
  source-control or collaboration subsystem.

## Rejected alternatives

- **Persisting `stale: true` on objects:** duplicates a derivable view and can
  drift from graph history.
- **Using stored edge direction as dependency direction:** evidence and
  dependency edges have different semantics.
- **Letting an agent report completion:** violates executable-gate and
  confidence-separation invariants.
- **Automatically choosing a side in conflicts:** loses human authority and
  hides incompatible research states.
- **Implementing arbitrary distributed merge now:** requires authorization,
  concurrency, recovery, and UI decisions outside Stage 2.
