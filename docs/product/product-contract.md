# Product Contract

Status: **Accepted for implementation**  
Working title: **Reasoning Workbench**  
Scope: the complete open-source product, not a disposable prototype

## 1. Mission

Reasoning Workbench helps mathematicians, theoretical physicists, and
computational researchers investigate uncertain questions over hours, days, or
months while retaining a comprehensible, auditable, and reproducible research
state.

The product is successful when a researcher can move from an imprecise question
to a research package containing explicit claims, assumptions, derivations,
computations, sources, reviews, failures, and verification evidence without
using a chat transcript as the project's memory.

## 2. Primary users

### Research mathematician

Needs to explore conjectures, search literature, test finite cases, compare
proof strategies, preserve failed approaches, and optionally formalize critical
statements.

### Theoretical physicist

Needs to keep conventions and assumptions explicit, combine symbolic
derivations with numerical experiments, check dimensions and limits, and trace
figures back to equations, code, and parameters.

### Computational reasoner

Needs to design algorithms, run experiments, compare implementations, use
solvers and remote compute, and preserve executable evidence for conclusions.

### Reviewer or collaborator

Needs to inspect exact versions of claims, source locations, execution records,
formal certificates, unresolved gaps, and the history of revisions.

## 3. Problem statement

Existing tools optimize different isolated objects:

- chat systems optimize conversations;
- notebooks optimize cells and outputs;
- LaTeX editors optimize manuscripts;
- proof assistants optimize formal declarations and proof terms;
- coding agents optimize repositories;
- scientific-agent systems optimize runs and artifacts.

Research reasoning crosses all of these objects. Today the researcher acts as
the manual connective tissue and must remember which assumptions, computations,
references, and failed attempts support each conclusion.

Reasoning Workbench makes that connective state explicit.

## 4. First-class product object

The first-class object is a **versioned research state**:

```text
Research Project
├── Questions and goals
├── Contexts
│   ├── definitions
│   ├── assumptions
│   ├── conventions
│   └── notation
├── Claims and dependencies
├── Evidence and counter-evidence
├── Branches and workstreams
├── Experiments and executions
├── Sources and citations
├── Reviews and decisions
├── Failures and open gaps
└── Documents and publication artifacts
```

Chat, notebooks, proof files, figures, and papers are views or artifacts of this
state. None is the sole source of truth.

## 5. Product promises

### PC-01 — Stateful research

The project remains intelligible after long gaps and does not depend on replaying
the full conversational history.

### PC-02 — Iterative intent

The user can refine questions, goals, definitions, and conventions without
restarting the project. Downstream effects are made visible.

### PC-03 — Branching exploration

Humans and agents can pursue incompatible approaches in isolated branches,
compare them semantically, and merge accepted results.

### PC-04 — Steerable asynchronous work

Long-running workstreams can be observed, paused, redirected, resumed, or
stopped while other work continues.

### PC-05 — Native research artifacts

The system produces and understands Markdown, LaTeX, source code, notebooks,
datasets, figures, proof files, and review reports rather than reducing them to
chat summaries.

### PC-06 — Explicit uncertainty

The system distinguishes proposal, confidence, computational support, source
support, human review, and formal verification. Unresolved gaps remain visible.

### PC-07 — Hard verification gates

Completion policies are executable rules. A persuasive model response cannot
bypass missing tests, citations, reproduction, or proof checks.

### PC-08 — Reproducibility and provenance

Every durable result can be traced to versions of inputs, code, environment,
tools, models, parameters, and actors.

### PC-09 — Human authority

The user controls accepted project state, resource budgets, external side
effects, publication, and the interpretation of mathematical significance.

### PC-10 — Open and replaceable infrastructure

Projects remain portable. Models, tools, proof assistants, compute targets, and
literature providers are replaceable through typed adapters.

## 6. Complete product capabilities

### Project workspace

- local-first projects with optional synchronized collaboration;
- project navigator, research surface, claim inspector, and activity panel;
- living working paper with internal links and margin annotations;
- time travel, snapshots, branches, reviews, and semantic impact warnings.

### Reasoning graph

- typed nodes for problems, goals, contexts, definitions, assumptions, claims,
  evidence, failures, sources, runs, reviews, and decisions;
- typed dependency, support, contradiction, derivation, testing,
  formalization, citation, and production edges;
- scoped truth: claims are interpreted under explicit contexts;
- stale-state propagation after upstream changes.

### Agent workbench

- project coordinator and branch-scoped workstream coordinators;
- specialist roles for exploration, literature, coding, numerics,
  formalization, skepticism, reproduction, review, and synthesis;
- multiple model providers and local models;
- asynchronous messages, checkpoints, budgets, escalation, and failure records;
- progressive disclosure from project status down to exact tool traces.

### Execution fabric

- persistent interactive kernels and immutable reproducible runs;
- typed tools for files, code, CAS, solvers, proof assistants, literature, and
  compute;
- sandboxed local execution and adapters for SSH, Slurm/PBS, Kubernetes, and
  cloud resources;
- automatic artifact capture, hashing, caching, logs, and lineage.

### Verification fabric

- code tests and property checks;
- symbolic equivalence and domain-assumption checks;
- numerical convergence, sensitivity, precision, and reproduction checks;
- dimensional, symmetry, conservation, and limiting-case checks;
- source-location and citation-entailment review;
- Lean and other proof-kernel integrations;
- explicit alignment review between informal and formal statements;
- independent and adversarial review policies with loop detection.

### Literature workspace

- PDF, LaTeX, bibliography, local-library, and external-catalog ingestion;
- source anchors down to page, section, theorem, equation, or figure;
- lexical, semantic, citation-graph, and statement-aware retrieval;
- extraction labels that distinguish machine proposals from reviewed objects.

### Collaboration and publication

- live co-editing, roles, comments, branch reviews, and version-bound approvals;
- attribution of human, model, tool, and source contributions;
- export of manuscripts, proofs, code, data, environments, reviews, and a
  machine-readable provenance manifest;
- immutable public or private research snapshots.

### Extension system

- model adapters, tools, verifiers, domain packs, compute targets, renderers,
  workflows, and project templates;
- capability and permission manifests;
- conformance tests for cancellation, provenance, schemas, and side effects.

## 7. Primary interaction model

```text
Formulate question
        ↓
Approve contexts and goals
        ↓
Create parallel workstreams
        ↓
Explore literature / proofs / computation
        ↓
Attach evidence and expose failures
        ↓
Run independent verification
        ↓
Accept, refute, revise, or leave unresolved
        ↓
Publish a reproducible research package
```

The user may enter, leave, and redirect the loop at any time.

## 8. Required product surfaces

1. **Project cockpit** — goals, accepted knowledge, gaps, contradictions,
   active work, cost, and blockers.
2. **Research surface** — documents, equations, code, notebooks, proofs,
   PDFs, figures, and reasoning canvas.
3. **Claim inspector** — statement, context, dependencies, evidence,
   verification profile, reviews, and history.
4. **Agent studio** — workstream contracts, branches, permissions, budgets,
   status, steering, and comparisons.
5. **Compute lab** — kernels, jobs, resources, logs, artifacts, and replay.
6. **Review center** — gaps, contradictions, stale claims, citation issues,
   reproduction failures, and release gates.
7. **Publication center** — manuscript, appendices, proof certificates,
   datasets, environment locks, and snapshots.

## 9. Output contract

A completed investigation can be exported as:

```text
research-package/
├── statements-and-contexts/
├── manuscript/
├── proofs-and-derivations/
├── code/
├── data/
├── figures/
├── environments/
├── sources/
├── reviews/
├── failures-and-open-gaps/
└── provenance-manifest.json
```

The package must remain interpretable without access to a particular model
provider or hosted Reasoning Workbench instance.

## 10. Explicit non-goals

The project does not attempt to:

- train a new foundation model;
- implement a new proof kernel, CAS, notebook protocol, or HPC scheduler;
- guarantee mathematical truth merely by orchestrating language models;
- require full formalization of all mathematics;
- autonomously publish or communicate externally without explicit authority;
- hide failed work to make a project appear more successful;
- support every scientific discipline through hard-coded core logic.

## 11. Product completion

The complete product is considered delivered only when the requirements in
`definition-of-done.md` pass against the reference projects. A polished UI or a
successful single demo is insufficient by itself.

