# ADR-0014: Stage 10 Provider-Neutral Domain Packs

Status: **Accepted**

Date: 2026-08-21

## Context

The core workbench now supports graph state, tools, execution, verification,
papers, and literature, but disciplinary workflows still have to be assembled
ad hoc. Pure mathematics, theoretical physics, and computational reasoning need
different semantic vocabulary, engines, checks, artifacts, and templates.
Those differences must not hard-code Lean, Sage, SymPy, Cadabra, JAX, or any
other engine into canonical project semantics.

## Decision

### A pack is a portable declarative manifest

A `DomainPackManifest` declares a stable pack/version, disciplines, semantic
types mapped onto existing canonical object types, typed adapter bindings, and
project templates. It is JSON-serializable, secret-free, content-hashed, and
strictly validated. A third party can register another pack without modifying
core packages.

An adapter binding names a tool or verifier, its purpose, required
capabilities, and whether it is optional. Pack registration does not grant an
adapter permission. Conformance compares the binding with an actual registered
contract. Project authorization is a separate, versioned decision containing
an explicit binding allow-list, granted capability subset, pack digest, and
exact adapter-contract digests. Missing, non-conforming, or under-authorized
bindings fail closed.

### Templates create ordinary project state

Seven built-in templates cover theorem investigation, conjecture exploration,
symbolic derivation, PDE study, literature synthesis, formalization, and
computational experiments. Instantiation creates an ordinary project, a domain-
pack activation decision, problem, context, goal, completion policy,
workstreams, and graph edges. Packs do not introduce a second database or a
parallel object system.

The built-in packs declare the intended adapter boundary:

- Pure Mathematics: Lean, Sage, GAP, PARI/GP, SMT/SAT, counterexample and
  theorem/lemma workflows;
- Theoretical Physics: units/conventions, symbolic and tensor algebra,
  Cadabra/xAct-class adapters, ODE/PDE, perturbation, simulation, and limits;
- Computational Reasoning: optimization, JAX, benchmarks, algorithm and
  evolutionary search, complexity experiments, and reproducible datasets.

Bundled Stage 8 report verifiers are required structural contracts. External
engines are optional until a deployment registers and explicitly authorizes a
real adapter. A report contract is never upgraded to an engine check merely
because a pack mentions that engine.

### Reference acceptance and research packages are derived

RP-001, RP-002, and RP-003 have machine-derived acceptance evaluators over
current objects, edges, artifact bytes, lineage, exact versions, and scientific
thresholds. A caller cannot inject `passed`. A package build first verifies the
canonical project and every stable reference assertion, then performs the
ordinary portable export and writes a hashed `research-package.json` inventory
covering event head, pack/template, exact objects, artifacts, unresolved
failures, and acceptance evidence.

## Consequences

- Domain specialization composes existing substrate instead of forking it.
- Adapter availability, contract conformance, authorization, and scientific
  acceptance remain separate facts.
- Every reference package can be reopened without the originating provider or
  disposable SQLite state.
- A regressed threshold, statement, proof-hole scan, alignment, source, or
  required artifact blocks package creation with exact failed assertion IDs.
- This ADR extends ADR-0005, ADR-0010, ADR-0012, and ADR-0013 without weakening
  their capability, execution, verification, or source-grounding boundaries.

## Boundaries

- The repository declares but does not bundle Lean, Sage, GAP, PARI/GP, an SMT
  solver, SymPy, Cadabra/xAct, JAX, or accelerator runtimes. Deployment adapters
  must execute them through the existing typed execution and verifier fabrics.
- Reference fixtures are deterministic product conformance cases, not claims of
  new research or substitutes for live engine acceptance on a deployment.
- A research-package manifest is a derived export index. Canonical meaning
  remains in events and CAS artifacts.
- The Stage 10 CLI is an operator surface, not the final graphical workbench.

## Rejected alternatives

- **Add discipline-specific object tables:** semantic types map to the existing
  versioned graph.
- **Grant every adapter named by a pack:** authorization remains explicit and
  deny-by-default.
- **Pretend report JSON ran Lean/SymPy/JAX:** actual assurance remains that of
  the registered verifier contract.
- **Let a package declare its own acceptance:** acceptance is derived before
  export from stable reference assertions.
