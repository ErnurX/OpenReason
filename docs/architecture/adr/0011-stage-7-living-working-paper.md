# ADR-0011: Stage 7 Living Working Paper and Semantic Impact

Status: **Accepted**  
Date: 2026-08-15

## Context

The canonical graph can already represent versioned claims, assumptions,
evidence, reviews, runs, and artifacts, but researchers also need a readable
mathematical narrative. Making a manuscript the only source of truth would
erase typed meaning; treating it as an unrelated export would make statements,
figures, and reviews drift silently after upstream changes.

Stage 7 must connect authoring to the existing graph without inventing another
database, a second artifact identity, or a verification score.

## Decision

### A working paper is a typed document object

A working paper is a versioned canonical `document` whose content has
`schemaVersion: 1` and `kind: "working-paper"`. It contains ordered sections,
equations, Markdown prose, object transclusions, source citations, CAS artifact
embeds, internal links, margin-style annotations, and explicit open or resolved
gaps.

The paper and every section bind an exact context ID and version. Every object
reference binds a stable semantic object ID, its exact version, and its exact
context version. A reference is either:

- `live`: render the current object version while reporting that the paper's
  bound version is outdated; or
- `pinned`: render the bound historical version and report the same drift.

Thus live prose can follow a revised statement without erasing the version that
was reviewed when the paper was written. Recursive document transclusion,
dangling internal links, mismatched declared contexts, duplicate structural
IDs, secret-like prose, invisible references, and invisible/corrupt artifacts
are rejected by the typed service.

Documents created through the generic object API do not become trusted working
papers merely by using object type `document`; paper reads validate the full
Stage 7 shape.

### Rendering is deterministic and derived

The same paper version and branch snapshot render deterministically to Markdown
or standalone LaTeX. Renders include exact object/version back-references,
portable `artifact:sha256:...` references, warnings, a SHA-256 digest, and the
verification profiles of transcluded claims. Rendered text is a derived view,
not a second canonical manuscript file.

Stage 7 does not append graph edges for transclusions. The current edge model
has no deletion/supersession operation; appending fresh document edges on every
paper revision would leave old exact-version edges active and create false
staleness. Paper references remain typed canonical content and the impact
service interprets them directly.

### Verification remains a vector

The profile has separate logical, symbolic, numerical, source,
reproducibility, human-review, and formal dimensions. Each dimension is derived
as `missing`, `supported`, `failed`, `inconclusive`, or `stale`, with the exact
evidence objects exposed. No aggregate score is produced, and model confidence
is not an input.

Stage 7 artifact promotion creates an `artifact-verification-evidence` object
bound to the exact claim and context versions and then adds a typed
`supports`, `refutes`, or `tested_by` edge. The source artifact must be visible
on the branch and pass CAS digest/size verification. Promotion records only
`assurance: "support"`; it cannot claim a symbolic check, proof-kernel verdict,
or independent reproduction merely because a user or model supplied an
artifact.

Human review uses the parallel `verification-review` record, also bound to the
exact claim and context versions. Its passed, failed, or inconclusive outcome
feeds only the human-review dimension. Exact bindings themselves are treated as
semantic dependencies during paper impact, so a revised claim invalidates its
old evidence and review even when the judgment edge points toward the claim.

### Staleness and branch semantics are derived

Paper impact starts with the Stage 2 propagation table. A dependency path may
affect a section only when every edge on that path has the section's context.
The report maps changed assumptions or statements to exact referenced claims,
evidence, reviews, producing runs, embedded artifacts, and sections. It also
reports direct version drift. No `stale: true` event is appended.

Semantic branch comparison preserves the conservative direct-child-to-parent
scope of Stage 2. It augments the three-way diff with top-level textual fields,
categories for statements, assumptions, contexts, evidence, reviews, and
documents, proof-status changes, and dependency-edge details.

## Consistency and recovery boundary

Creating or revising a paper is one ordinary object-version event. Artifact
promotion is a preflight followed by an evidence event and an edge event. Each
append has the existing atomic event boundary, but the pair is not a
multi-event transaction; a process crash can leave visible evidence without
its edge, in which case the verification profile reports it stale rather than
counting it as support.

The Stage 2 single-writer and direct-child merge limits still apply. Markdown
and LaTeX rendering do not compile TeX, resolve bibliography databases, extract
PDF anchors, or publish externally.

## Consequences

- One claim keeps the same semantic identity in the graph, paper, impact view,
  and verification profile.
- A changed scoped hypothesis immediately exposes affected reasoning and prose
  without mutating canonical history.
- Figures and tables retain CAS and producing-run lineage instead of becoming
  anonymous manuscript files.
- Presentation can show evidence dimensions without implying mathematical
  proof.
- A later edge lifecycle or batch-event design can materialize document edges
  without changing the paper content contract.

## Rejected alternatives

- **Working paper as sole project state:** violates typed reasoning and impact
  invariants.
- **Transclusion by mutable object ID only:** cannot bind reviews or evidence to
  what was actually read.
- **Always pin or always float:** either prevents living documents or silently
  rewrites reviewed prose; explicit `live`/`pinned` keeps both facts visible.
- **Persisting staleness:** duplicates a derived view and can drift.
- **One confidence/verification score:** conflates incompatible evidence.
- **Treating any artifact as verified:** provenance is necessary but not proof.
