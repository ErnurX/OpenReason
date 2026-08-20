# Architecture Decision Records

ADRs capture decisions that constrain implementation. Accepted ADRs are
normative together with the product contract and system invariants.

| ADR | Decision | Status |
|---|---|---|
| [0001](0001-open-event-sourced-project.md) | Open event-sourced canonical project | Accepted |
| [0002](0002-local-first-modular-monolith.md) | Local-first modular monolith | Accepted |
| [0003](0003-typed-reasoning-and-verification.md) | Typed reasoning graph and evidence vectors | Accepted |
| [0004](0004-branch-scoped-agent-runtime.md) | Branch-scoped agents with hard gates | Accepted |
| [0005](0005-typed-tools-and-sandboxed-execution.md) | Typed tools and sandboxed execution | Accepted |
| [0006](0006-stage-2-reasoning-services.md) | Stage 2 reasoning services and conservative branch merge | Accepted |
| [0007](0007-stage-3-workstream-runtime.md) | Stage 3 typed tools and branch-scoped workstream runtime | Accepted |
| [0008](0008-stage-4-context-and-agent-coordinator.md) | Stage 4 bounded context and provider-neutral agent coordination | Accepted |
| [0009](0009-stage-5-model-gateway.md) | Stage 5 live model adapters, credential boundary, routing, and usage accounting | Accepted |
| [0010](0010-stage-6-execution-plane.md) | Stage 6 immutable jobs, local/SSH execution, artifact lineage, and deterministic reuse | Accepted |
| [0011](0011-stage-7-living-working-paper.md) | Stage 7 typed working papers, exact transclusion, evidence vectors, scoped impact, and semantic comparison | Accepted |
| [0012](0012-stage-8-verification-plane.md) | Stage 8 typed verifier adapters, independent review, hard gates, loop guards, and formal alignment | Accepted |

## ADR lifecycle

Statuses: `Proposed`, `Accepted`, `Superseded`, `Rejected`.

An ADR may be superseded only by another ADR that names it and explains the
migration and compatibility impact.
