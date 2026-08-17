# RP-002 — Finite-Sum Formalization in Lean

## Purpose

Exercise problem decomposition, native Lean artifacts, informal-to-formal
statement alignment, proof-kernel verification, axiom auditing, review binding,
and reproducible proof environments.

## User brief

> Prove that the sum of the natural numbers from zero through `n`, inclusive,
> is `n(n+1)/2`. Give an understandable informal proof and a Lean 4
> formalization. Make it explicit that the Lean statement represents the same
> inclusive range as the prose statement.

## Canonical informal statement

To avoid natural-number division ambiguity, the canonical claim is:

```text
For every n : Nat,
2 * (sum of k for k = 0, ..., n) = n * (n + 1).
```

The familiar divided form may appear in exposition, but the multiplication form
is the alignment target.

## Required workstreams

### WS-002-A — Informal proof

- produce an induction or pairing proof;
- identify base case, induction hypothesis, and algebraic step;
- attach each lemma dependency to the main claim.

### WS-002-B — Lean formalization

- create a pinned Lean 4 + mathlib project;
- formalize the inclusive sum using `Finset.range (n + 1)` or an equivalent
  representation;
- build without `sorry`, `admit`, or unreviewed custom axioms;
- save compiler output and dependency information.

### WS-002-C — Statement alignment

- compare the natural-language quantifiers, domain, inclusivity, arithmetic
  type, and conclusion with the Lean declaration;
- reject a proof of a weaker, shifted, or differently typed statement;
- bind the approval to the exact Lean and informal statement versions.

### WS-002-D — Independent review

- inspect the axiom report;
- ensure the proof environment is reproducible;
- verify that successful compilation is not presented as proof of semantic
  alignment by itself.

## Target declaration shape

The exact identifier and proof are implementation choices. The declaration must
be equivalent to:

```lean
theorem twice_sum_zero_through_n (n : ℕ) :
    2 * (∑ k in Finset.range (n + 1), k) = n * (n + 1) := by
  -- checked proof, no sorry/admit
```

## Deliberate traps

- `Finset.range n` represents `0, ..., n-1`, not `0, ..., n`.
- A theorem over integers or reals is not automatically the requested theorem
  over naturals.
- A declaration that imports the desired result unchanged from a fixture file
  does not demonstrate the formalization workflow.
- Successful Lean compilation does not establish that the informal and formal
  statements match.
- Standard foundational axioms must be distinguished from project-introduced
  axioms.

## Required artifacts

- informal proof document;
- Lean source files;
- `lakefile`/toolchain and dependency lock;
- clean build log;
- `sorry`/`admit` scan result;
- axiom audit;
- statement-alignment report;
- version-bound independent review;
- provenance manifest.

## Acceptance assertions

- **RP-002-A01:** The Lean statement quantifies over `n : Nat` and represents the
  inclusive range `0` through `n`.
- **RP-002-A02:** The main declaration builds in a clean pinned environment with
  no `sorry` or `admit` in the project proof path.
- **RP-002-A03:** The axiom report lists all axioms used and flags any
  project-introduced axiom as a failure.
- **RP-002-A04:** A separate alignment review checks domain, quantifiers, range
  endpoint, and conclusion against exact object versions.
- **RP-002-A05:** Changing the informal statement or Lean declaration makes the
  prior alignment approval stale.
- **RP-002-A06:** The exported project builds on a clean machine or container.

