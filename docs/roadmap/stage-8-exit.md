# Stage 8 Exit — Verification Plane

Status: **Complete for the agreed Stage 8 slice**

Date: 2026-08-20

Stage 8 turns the Stage 7 evidence vector into executable, hard completion
criteria while preserving the distinction between support, machine checks,
human review, and proof-kernel verification.

## Acceptance criteria

| ID | Criterion | Evidence |
|---|---|---|
| S8-AC-01 | Third-party verifiers declare typed schemas, dimension, assurance, permissions, side effects, determinism, cancellation, version, and timeout; registration and execution fail closed. | `verification.test.ts` registry/report conformance test and shared tool-schema validator. |
| S8-AC-02 | A verification run binds exact claim/context versions, assumptions, artifacts, input/verifier/result digests, environment, permissions, and nondeterminism. | RP-001 artifact-integrity store and CLI tests. |
| S8-AC-03 | Passed, failed, inconclusive, crashed, and interrupted verification attempts remain durable; failed attempts create concrete open gaps. | Verification result, exception, loop-enforcement, and crash-recovery paths. |
| S8-AC-04 | Profiles distinguish eight dimensions and reserve `verified` for passed `formal-kernel` evidence; reported checklists cannot self-upgrade. | Structured-report and injected Lean-kernel conformance tests. |
| S8-AC-05 | Completion policies can require current dimensions at supported/verified status, exclude report-only assurance by default, and exempt only explicitly reasoned conjectures. | `verification_gate` evaluator, report-trust test, and claim-revision staleness test. |
| S8-AC-06 | Reviewer packets omit persuasive self-assessment and secrets; a passed independent review cites packet evidence and records fresh/adversarial/spot-check and model-family safeguards. | Independent packet/review test including same-family rejection. |
| S8-AC-07 | Repeated objections, claim cycles, no-new-evidence revisions, and length growth without evidence can block completion and persist human escalation. | Review-loop analysis, enforcement, and `review_loop_clear` policy test. |
| S8-AC-08 | Formal kernel verification and informal/formal statement alignment are separate exact-version objects and gates. | Injected kernel plus `recordFormalAlignment`/`formal_alignment` test. |
| S8-AC-09 | Core adapters cover report contracts for code, symbolic, numerical, physical, citations, and formal proof, plus real CAS/provenance integrity. | `createCoreVerifierRegistry` list and required-check tests. |
| S8-AC-10 | Verifier list/run, review packet/recording, loop analysis/enforcement, alignment, recovery, profile, and policies are available through the CLI. | `packages/cli/test/stage8.test.ts` plus captured-IO command coverage. |

## Public surface

- `VerifierRegistry`, `VerifierContract`, `VerifierDefinition`,
  `authorizeVerifier`, and `createCoreVerifierRegistry`;
- `runVerification` and `recoverInterruptedVerifications`;
- `createIndependentReviewPacket`, `recordIndependentReview`,
  `analyzeReviewLoop`, and `enforceReviewLoopGuard`;
- `recordFormalAlignment`;
- completion rules `verification_gate`, `independent_review`,
  `review_loop_clear`, and `formal_alignment`;
- `rw verification list|run|packet|review|loop|align|recover` and the existing
  `profile` command.

## Definition-of-Done mapping

- `DOD-VERIFY-01`, `DOD-VERIFY-02`, and `DOD-VERIFY-08`: executable completion
  gates, durable gaps, independent review, and bounded reviewer loops.
- `DOD-VERIFY-03` through `DOD-VERIFY-07`: typed report contracts capture the
  required symbolic, numerical, physical, formal, and citation checks; only
  actual engine adapters may claim machine/kernel assurance.
- `DOD-EXT-01` through `DOD-EXT-03`: provider-neutral registry, declared
  contracts, validation, authorization, and provenance.
- `DOD-REF-01`: RP-001 exercises exact artifact verification, staleness, CLI,
  review, and hard policies.

## Explicit boundaries

- The repository does not bundle SymPy, Sage, Lean, a citation database, or a
  remote verifier worker. Core report adapters validate report completeness at
  `reported` assurance; deployment adapters perform the actual domain checks.
- The artifact-integrity adapter verifies bytes and lineage, not the truth of
  the claim those bytes are used to support.
- Verifiers run in-process and are trusted code. Process/container isolation is
  supplied by the Stage 6 execution plane when an adapter needs external code.
- Multi-object verifier orchestration is recoverable but not one event-log
  transaction. A missing exact-version judgment edge never counts as support.
- Review-loop signals are deterministic heuristics and trigger human authority;
  they are not evidence that a claim is false.
- There is no Stage 8 graphical review dashboard or live Lean LSP UI.

## Next useful slice

Stage 9 should add the literature workspace: document ingestion, exact page and
section anchors, source-aware search, assumption-compatible citation support,
and provenance-preserving source bundles that feed the Stage 8 citation
verifier contract.

## Verification

The release-gate components pass: TypeScript, checked-in schemas, 22 Vitest
files with 147 tests, and the Stage 0 validator over 33 Markdown files, 42
local links, and 109 stable-ID definitions.
