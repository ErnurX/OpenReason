# Stage 10 Exit — Domain Packs

Status: **Complete for the agreed Stage 10 slice**

Date: 2026-08-21

Stage 10 keeps core domain-neutral while adding composable disciplinary
vocabulary, adapter manifests, project templates, conformance, and complete
reference research packages.

## Acceptance criteria

| ID | Criterion | Evidence |
|---|---|---|
| S10-AC-01 | A strict, secret-free, hashed Domain Pack manifest declares semantic types, tool/verifier bindings, capabilities, templates, policies, workstreams, and artifacts. | Built-in/third-party registry tests. |
| S10-AC-02 | Pure Mathematics covers theorem/lemma/conjecture/counterexample ontology and Lean, Sage, GAP, PARI/GP, SMT/SAT adapter boundaries. | Built-in manifest assertions. |
| S10-AC-03 | Theoretical Physics covers explicit conventions, symbolic/tensor algebra, ODE/PDE, perturbation, simulation, dimensions, conservation, and limits. | Built-in manifest and RP-003 assertions. |
| S10-AC-04 | Computational Reasoning covers optimization/JAX, benchmarks, algorithms, complexity, evolutionary search, and reproducible datasets. | Built-in manifest assertions. |
| S10-AC-05 | Seven roadmap templates instantiate ordinary portable problem/context/goal/workstream graph state and executable baseline policies. | Template enumeration and third-party instantiation test. |
| S10-AC-06 | Pack registration grants nothing; explicit binding authorization rejects absent, non-conforming, or under-capability adapters and records exact contract digests. | Conformance and authorization tests. |
| S10-AC-07 | RP-001, RP-002, and RP-003 pass all stable assertions and export hashed research-package manifests with exact objects, artifacts, event head, pack provenance, failures, and acceptance evidence. | Three-reference package integration test. |
| S10-AC-08 | A regressed scientific threshold prevents package creation and identifies the failed stable assertion. | RP-003 energy-drift regression test. |
| S10-AC-09 | Pack inspection, templates, conformance, authorization, initialization, reference evaluation, and package building are exposed through modular CLI commands. | `packages/cli/test/stage10.test.ts` and help. |

## Definition-of-Done mapping

- `DOD-EXT-01` through `DOD-EXT-03`: third-party manifest registration,
  contract/capability conformance, explicit authorization, and provenance.
- `DOD-REF-01` through `DOD-REF-04`: all three reference projects produce
  accepted portable packages and a scientific regression fails closed.
- `DOD-PUBLISH-01` and `DOD-PUBLISH-02`: packages inventory manuscripts/proofs/
  code/data/environments/reviews/failures and refuse failed assertions.
- `DOD-STATE-01` and `DOD-STATE-02`: exported packages reopen and verify from
  events and CAS without provider or SQLite state.

## Explicit boundaries

- External mathematics, physics, and compute engines are typed adapter slots,
  not bundled dependencies or simulated assurance.
- Reference fixtures validate the workbench and stable known results; live
  deployment acceptance must exercise the configured external engines.
- Multi-object template/fixture creation is recoverable canonical state but not
  one generalized project transaction.
- The research manifest is derived; canonical project state remains authoritative.

## Next useful slice

Stage 11 can extend semantic branching into authenticated collaboration,
version-bound approvals, comments, and accepted-state merge authority.

## Verification

The release gate passes: TypeScript, checked-in schemas, 26 Vitest files with
162 tests, and the Stage 0 validator over 37 Markdown files, 48 local links,
and 109 stable-ID definitions.
