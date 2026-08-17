# Complete Product Definition of Done

Status: **Accepted for implementation**

This document defines the testable completion contract for the complete
Reasoning Workbench. Requirements use stable identifiers so automated and
manual acceptance tests can reference them.

## A. Project state and portability

- **DOD-STATE-01:** A project can be created, closed, moved to another machine,
  reopened, and inspected without access to its original model provider.
- **DOD-STATE-02:** The canonical project is reconstructible from open files,
  an append-only event history, and content-addressed artifacts; indexes are
  disposable.
- **DOD-STATE-03:** The user can inspect and restore any committed historical
  project state.
- **DOD-STATE-04:** Crashing the application during an agent run does not
  corrupt previously committed state, and resumable work can continue.

## B. Research model

- **DOD-GRAPH-01:** Problems, goals, contexts, definitions, assumptions, claims,
  evidence, sources, executions, reviews, decisions, failures, and artifacts
  exist as versioned typed objects.
- **DOD-GRAPH-02:** Support, refutation, dependency, derivation, testing,
  formalization, citation, production, contradiction, and supersession exist as
  typed edges.
- **DOD-GRAPH-03:** Changing an upstream assumption or statement marks affected
  downstream objects stale without deleting their history.
- **DOD-GRAPH-04:** A claim's model confidence is stored separately from its
  logical, symbolic, numerical, source, reproducibility, and review evidence.
- **DOD-GRAPH-05:** Failed and abandoned approaches remain queryable and can be
  supplied as negative context to future workstreams.

## C. Human and agent collaboration

- **DOD-AGENT-01:** The user can approve a research question and goals before
  expensive work begins.
- **DOD-AGENT-02:** At least three workstreams can run concurrently in isolated
  branches while the user continues interacting with the project.
- **DOD-AGENT-03:** A running workstream can be paused, resumed, redirected, or
  cancelled without losing its committed reports and artifacts.
- **DOD-AGENT-04:** A blocked workstream produces a structured escalation that
  states attempted approaches, evidence, blocker, and requested human input.
- **DOD-AGENT-05:** Agents cannot merge to accepted state, spend beyond budget,
  use undeclared network access, or publish without an explicit policy grant.
- **DOD-AGENT-06:** The same workflow can use at least two external model
  providers and one local/OpenAI-compatible provider through adapters.

## D. Context and long-running work

- **DOD-CONTEXT-01:** Model context is compiled from project objects and carries
  stable back-references; it is not assembled solely from chat history or
  embedding similarity.
- **DOD-CONTEXT-02:** A project containing at least 1,000 claims and 100 sources
  remains navigable and can produce bounded, goal-specific contexts.
- **DOD-CONTEXT-03:** A previously documented failed approach is surfaced when a
  new workstream proposes a materially equivalent strategy.

## E. Execution and artifacts

- **DOD-EXEC-01:** Python runs can execute interactively and be promoted to an
  immutable reproducible job.
- **DOD-EXEC-02:** Every reproducible job records command, code version, inputs,
  environment, permissions, resources, parameters, seeds, logs, and outputs.
- **DOD-EXEC-03:** Generated figures, datasets, proof files, reports, and code
  are content-addressed artifacts with lineage.
- **DOD-EXEC-04:** An identical deterministic job can be served from cache, and
  nondeterministic tools explicitly declare their behavior.
- **DOD-EXEC-05:** A job can run locally and through at least one remote adapter
  such as SSH or Slurm, with results returned to the same project graph.
- **DOD-EXEC-06:** Untrusted agent code runs within enforceable filesystem,
  network, time, CPU, and memory policies.

## F. Verification and uncertainty

- **DOD-VERIFY-01:** Workstream completion is controlled by executable gates,
  not by a model emitting a success phrase.
- **DOD-VERIFY-02:** A code-producing workstream cannot complete until required
  tests and artifact checks pass.
- **DOD-VERIFY-03:** Symbolic claims can carry machine-readable CAS evidence
  including assumptions and tool versions.
- **DOD-VERIFY-04:** Numerical claims can carry convergence, sensitivity,
  precision, and independent-reproduction evidence.
- **DOD-VERIFY-05:** Physical derivations can carry dimensional, convention,
  symmetry, conservation, and limiting-case checks where applicable.
- **DOD-VERIFY-06:** A Lean statement can be built by the proof kernel, its
  axioms audited, and its alignment with the informal claim reviewed separately.
- **DOD-VERIFY-07:** Citation evidence identifies an exact source location and
  records whether the source actually supports the claim under compatible
  assumptions.
- **DOD-VERIFY-08:** Reviewer loops detect repeated objections, revision cycles,
  or lack of new evidence and terminate as unresolved rather than fabricating
  consensus.
- **DOD-VERIFY-09:** The UI visibly distinguishes unreviewed prose, supported
  claims, reproduced computations, and formally verified statements.

## G. Literature

- **DOD-LIT-01:** The system ingests local PDFs, bibliographies, and at least one
  external literature catalog.
- **DOD-LIT-02:** Sources are navigable through stable page/section/theorem/
  equation/figure anchors when the document permits it.
- **DOD-LIT-03:** Machine-extracted definitions and statements remain labeled as
  proposals until reviewed.
- **DOD-LIT-04:** A novelty search can return potentially overlapping prior work
  without silently declaring a result novel or non-novel.

## H. Authoring, branching, and collaboration

- **DOD-COLLAB-01:** Markdown/LaTeX documents can embed live references to
  project claims, evidence, sources, runs, and figures.
- **DOD-COLLAB-02:** Two branches can be compared for textual and semantic
  differences in statements, assumptions, contexts, and evidence.
- **DOD-COLLAB-03:** Two authenticated users can edit a project, request review,
  and merge accepted changes while retaining attribution.
- **DOD-COLLAB-04:** A review is bound to exact object versions and becomes stale
  after relevant changes.

## I. Publication and reproducibility

- **DOD-PUBLISH-01:** The project exports a manuscript, bibliography, code,
  proof files, figures, data, environment definitions, verification reports,
  unresolved gaps, failures, and a provenance manifest.
- **DOD-PUBLISH-02:** Release checks prevent stale or failed required evidence
  from being presented as accepted without an explicit, visible waiver.
- **DOD-PUBLISH-03:** A clean machine can reproduce the designated central runs
  of every reference project from the exported package.
- **DOD-PUBLISH-04:** Publication is always an explicit authorized action.

## J. Extensibility and deployment

- **DOD-EXT-01:** A third party can add a model adapter, tool, verifier, domain
  pack, or compute target without modifying core packages.
- **DOD-EXT-02:** Plugin manifests declare schemas, capabilities, permissions,
  side effects, cancellation behavior, and provenance output.
- **DOD-EXT-03:** Conformance tests reject a plugin that omits required
  provenance or violates declared permissions.
- **DOD-DEPLOY-01:** The same project can run in local desktop and self-hosted
  collaborative modes.
- **DOD-DEPLOY-02:** Secrets are not persisted in project artifacts or exposed to
  models without a scoped grant.

## K. Reference-project acceptance

- **DOD-REF-01:** RP-001 demonstrates hypothesis formation, computational
  refutation, revision, evidence attachment, and durable negative results.
- **DOD-REF-02:** RP-002 demonstrates informal-to-formal alignment, Lean build,
  axiom audit, proof holes, and version-bound review.
- **DOD-REF-03:** RP-003 demonstrates convention scoping, symbolic derivation,
  dimensional checks, numerical reproduction, and figure provenance.
- **DOD-REF-04:** Every cross-cutting feature added to the product is exercised
  by at least one automated or documented reference-project assertion.

## Completion rule

The full product is complete when all non-waived requirements above pass in CI
or documented acceptance runs. Waivers must be visible, versioned decisions with
an owner and rationale; they cannot be implicit omissions.

