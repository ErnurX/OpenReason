# ADR-0012: Stage 8 Verification Plane and Hard Completion Gates

Status: **Accepted**

Date: 2026-08-20

## Context

Stage 7 can display exact evidence and review vectors, but it cannot execute a
verifier, distinguish a reported checklist from a proof-kernel result, require
independent review, or stop a workstream when a required verification
dimension is absent. That makes evidence inspectable but leaves completion too
easy to game.

Stage 8 must add verification without turning model confidence, author-written
JSON, reviewer consensus, or mere artifact existence into proof.

## Decision

### Verifiers are typed, deny-by-default adapters

A `VerifierContract` declares a stable ID and version, one verification
dimension, assurance level, input JSON Schema, capabilities, side effects,
determinism, cancellation support, and timeout. `VerifierRegistry` rejects
malformed or duplicate definitions, validates inputs and results, derives the
overall outcome from non-empty check results, and applies an explicit verifier
allow-list and capability subset.

The assurance levels have deliberately different meanings:

- `reported`: a complete structured report was supplied;
- `support`: ordinary exact-version evidence;
- `machine-checked`: the named adapter actually performed a bounded check;
- `human-reviewed`: an attributable review was recorded;
- `formal-kernel`: a proof kernel accepted the bound formal statement.

Only `formal-kernel` can yield profile status `verified`; passed results at all
other levels remain `supported`. No aggregate confidence score is introduced.
Hard verification gates exclude `reported` assurance by default; a policy must
opt into report-only completion explicitly.

The bundled report adapters cover the required shapes for code, symbolic,
numerical, physical, citation, and formal reports. They fail when mandatory
checks are absent, but remain `reported`: validating a report is not validating
the mathematics it describes. The bundled artifact-integrity adapter is a real
`machine-checked` verifier for CAS digest, size, visibility, producing run, and
environment lineage. SymPy, Sage, Lean, remote workers, and literature
providers attach through the same registry rather than provider-specific core
branches.

### Verifier executions and negative results are canonical

`runVerification` binds the current claim and context versions, assumptions,
artifacts, complete input and input digest, verifier contract and digest,
environment, permissions, nondeterminism, result and result digest. It writes a
versioned environment and run, then an exact-version `verification-result`
evidence object and typed judgment edge. Failed and inconclusive checks also
produce an open `verification-gap`; adapter errors produce a
`verifier-execution-failure`. Explicit recovery turns abandoned running
verifier records into interrupted runs and open failures.

This orchestration uses several individually atomic canonical appends. A crash
can therefore leave a running run or evidence without its final edge. Recovery
preserves the former, and the Stage 7 profile treats the latter as stale rather
than support. The event log's atomic batch primitive remains available for a
future generalized project transaction API; Stage 8 does not bypass the typed
project service to use it unsafely.

### Independent review removes persuasive author context

An independent review packet contains the problem, exact claim and context,
selected evidence, and selected sources. Secret-like values are redacted and
keys representing confidence, certainty, self-assessment, persuasive verdicts,
or model scores are omitted. Reviews cite concrete evidence and record reviewer
identity, model family, fresh-context/adversarial modes, and randomized spot
checks. A model from the author's declared family is rejected. Review outcome
is derived: open objections fail; a pass requires cited evidence and at least
one independence safeguard.

Repeated objection fingerprints, repeated review without new evidence,
revisited canonical claim content, and growing claim text without evidence are
derived review-loop signals. The loop gate blocks completion; explicit
enforcement persists a `human-required` failure rather than continuing an
unbounded agent/reviewer cycle.

### Completion is executable and statement alignment is separate

The completion-policy union gains four caller-unforgeable rules:

- `verification_gate` requires named dimensions at `supported` or `verified`;
- `independent_review` requires distinct qualifying reviewers and safeguards;
- `review_loop_clear` requires no detected death spiral;
- `formal_alignment` requires a current passed alignment object.

Rules may exempt only claims explicitly marked
`verificationDisposition: "conjecture"` with a non-empty `unresolvedReason`.
Formal kernel evidence binds the formal claim. A separate human-reviewed
`formal-statement-alignment` object binds the informal claim, formal claim,
context, and kernel evidence; kernel acceptance alone cannot prove that the
formalization expresses the intended theorem.

## Consequences

- A workstream can be denied completion with exact missing dimensions,
  reviewers, loop signals, alignments, or open failure IDs.
- Every verifier result is attributable to exact inputs, environment, adapter,
  permissions, and nondeterminism.
- Failed checks and skeptical objections remain useful project state.
- Third-party verifiers can extend the system without changing the canonical
  format or claiming a stronger assurance than their contract.
- Adding the physical dimension extends the Stage 7 profile from seven to
  eight independent dimensions.
- This ADR amends only ADR-0011's verification-dimension/status vocabulary;
  its working-paper and rendering decisions remain accepted.

## Rejected alternatives

- **Trust an adapter-authored overall verdict:** outcome is derived from its
  concrete checks instead.
- **Treat a complete report as machine verification:** reports remain
  `reported` until a real engine adapter performs the check.
- **Use reviewer agreement as confidence:** independent-review requirements and
  loop detection preserve disagreement and gaps.
- **Let kernel success verify informal prose:** statement alignment remains a
  separate review boundary.
- **Hide failed verifier runs:** failures and interruptions are canonical.
