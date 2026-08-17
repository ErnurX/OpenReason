# System Invariants

Status: **Normative**

Invariants are properties the implementation must preserve across refactors,
providers, deployments, and product surfaces. Violating an invariant requires a
new ADR and an explicit product-contract change.

## State and identity

### INV-STATE-01 — Research state, not chat, is canonical

Chat messages and raw model outputs are transient proposals. Durable knowledge
must be promoted into typed project objects.

Enforcement: chat deletion cannot delete accepted claims, evidence, decisions,
or provenance.

### INV-STATE-02 — Canonical state is open and reconstructible

No proprietary database, embedding index, provider conversation ID, or hosted
service may be required to reconstruct the accepted project state.

Enforcement: rebuild tests recreate projections from project files, events, and
content-addressed artifacts.

### INV-STATE-03 — Durable objects have stable identity and versions

Claims, contexts, sources, runs, reviews, and artifacts have stable IDs. Reviews
and evidence point to exact versions, not mutable aliases.

### INV-STATE-04 — History is append-only at the audit layer

Corrections supersede prior events and objects; they do not erase them. User
interfaces may hide history by default but must allow inspection.

## Meaning and uncertainty

### INV-MEANING-01 — Claims are scoped by context

A claim is not interpreted independently of its definitions, assumptions,
conventions, notation, and domain.

### INV-MEANING-02 — Upstream changes propagate staleness

Changing a context, assumption, definition, statement, source, code input, or
environment marks dependent evidence and approvals stale until re-evaluated.

### INV-MEANING-03 — Confidence is not verification

Model confidence, reviewer consensus, numerical support, source support,
symbolic checking, human review, reproduction, and formal proof remain separate
dimensions.

### INV-MEANING-04 — Formal proof includes a statement-alignment boundary

A proof kernel verifies a formal statement. The mapping from an informal claim
to that formal statement is a separate versioned, reviewable object.

## Agents and human authority

### INV-AGENT-01 — Agent work is branch scoped

Agents propose changes in isolated branches. They do not mutate accepted state
or overwrite another workstream's state without a merge decision.

### INV-AGENT-02 — Completion is policy controlled

An agent cannot complete a workstream by emitting text. Required tests,
evidence, reviews, reproduction, or proof checks are evaluated by executable
completion gates.

### INV-AGENT-03 — Long-running work is steerable and resumable

The user can inspect, pause, redirect, resume, and cancel workstreams while
retaining committed intermediate state.

### INV-AGENT-04 — Failures are first-class outcomes

Rejected conjectures, failed searches, blocked proof attempts, invalid code,
and unresolved reviewer disagreements are durable project objects.

### INV-AGENT-05 — Human authority governs irreversible effects

Publication, external communication, accepted-state merge, budget expansion,
and access to protected resources require explicit authority.

## Execution and provenance

### INV-EXEC-01 — Every durable result has lineage

An artifact or evidence record identifies the actor, tool/model, exact inputs,
environment, parameters, relevant permissions, and producing run.

### INV-EXEC-02 — Artifacts are content addressed

Durable files have cryptographic content hashes. A path or filename alone is
not identity.

### INV-EXEC-03 — Reproducibility claims are explicit

Tools declare determinism or nondeterminism. Replaying an LLM trace means
replaying the recorded trajectory and artifacts, not promising identical new
generation.

### INV-EXEC-04 — Interactive work must be promotable

Significant results produced in mutable kernels can be converted into immutable
jobs with captured code, inputs, environment, and outputs.

## Security

### INV-SEC-01 — Capabilities are deny-by-default

Filesystem writes, process execution, network access, secrets, remote compute,
spend, merge, and publication are separate capabilities.

### INV-SEC-02 — Model access does not imply tool access

A model's ability to request a tool does not authorize that tool call. The
policy engine evaluates the project, branch, actor, tool, inputs, and budget.

### INV-SEC-03 — Secrets are not project artifacts

Secrets cannot enter model context, logs, event payloads, exports, or artifacts
unless an explicit redacted workflow requires it.

## User experience

### INV-UX-01 — Progressive disclosure is reversible

The default interface summarizes activity and uncertainty, while every summary
can be traced down to exact project objects, runs, and evidence.

### INV-UX-02 — Presentation quality does not imply rigor

Visual styling must clearly distinguish working prose, unreviewed claims,
supported results, reproduced computations, and formal verification.

### INV-UX-03 — Uncertainty and blockers remain visible

The UI cannot mark a project or workstream successful while required evidence
is failed, stale, unresolved, or waived without a visible status.

## Extensibility

### INV-EXT-01 — Providers and engines are replaceable

Core project semantics cannot depend on one model vendor, proof assistant, CAS,
literature service, compute provider, or plugin transport.

### INV-EXT-02 — Tools have typed contracts

Tool inputs, outputs, permissions, side effects, cancellation, determinism, and
provenance obligations are machine readable.

### INV-EXT-03 — Transport is not semantics

MCP, command line, HTTP, LSP, kernel protocols, and native SDKs may transport
tool calls. None alone defines the canonical Reasoning Workbench tool model.

