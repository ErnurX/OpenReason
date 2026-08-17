# RP-001 — Euler Polynomial Investigation

## Purpose

Exercise experimental mathematics, parallel exploration, computational
evidence, refutation, hypothesis revision, proof synthesis, and preservation of
negative results.

## User brief

> Investigate the integer-valued polynomial
> \(p(n)=n^2+n+41\) for non-negative integers. Use computation to identify a
> plausible pattern, test it aggressively, and determine the strongest general
> statements that can be justified. Keep counterexamples and failed conjectures
> visible.

The initial brief intentionally does not mention the known prime-producing
range or factorization pattern.

## Required context

```yaml
domain: non-negative integers
polynomial: p(n) = n^2 + n + 41
prime_definition: integer greater than 1 with exactly two positive divisors
```

## Required workstreams

### WS-001-A — Enumeration

- evaluate and factor `p(n)` for at least `0 <= n <= 200`;
- write tested code;
- save a table containing `n`, `p(n)`, primality, and factorization;
- identify the first composite value;
- attach the dataset as evidence rather than copying selected values into prose.

### WS-001-B — Pattern and proof

- explain why the first composite value occurs;
- search for an infinite family of composite values;
- state all assumptions and quantify the result precisely;
- distinguish a proof from computational support.

### WS-001-C — Skeptical review

- attempt to refute every universal or extrapolative claim;
- verify the factorization algebra independently;
- check off-by-one and primality-definition errors;
- preserve any rejected conjecture as a failure object.

### WS-001-D — Synthesis

- produce a working-paper section linking claims to code, dataset rows, proofs,
  and reviews;
- explicitly describe how the original pattern was misleading.

## Expected mathematical state

The fixture does not require identical prose, but the accepted graph must
contain results equivalent to the following.

### RP-001-C01 — Finite prime-producing range

For every integer `n` with `0 <= n <= 39`, `p(n)` is prime.

Required evidence: exhaustive checked computation over the complete stated
range. A stronger proof is optional.

### RP-001-C02 — Universal primality is false

`p(40) = 1681 = 41^2`, so the conjecture that `p(n)` is prime for all
non-negative integers is false.

Required evidence: independent arithmetic or factorization check plus a durable
refutation edge to the universal conjecture.

### RP-001-C03 — Infinite composite subsequence

For every integer `k >= 1`,

```text
p(41k) = 41(41k^2 + k + 1),
```

and both factors are greater than one, so `p(41k)` is composite.

Required evidence: symbolic derivation and reviewed quantifier/domain check.

## Deliberate traps

- Observing primes through `n = 39` must not justify universal primality.
- `n = 0` is divisible by `41` but produces the prime `41`; the infinite-family
  statement therefore requires `k >= 1`.
- A reviewer merely agreeing with the author agent does not verify the algebra.
- A failed universal conjecture must not disappear after the revised statement
  is accepted.

## Required artifacts

- tested enumeration source code;
- pinned execution environment;
- complete result table for the tested range;
- computation log;
- symbolic/proof note for RP-001-C03;
- skeptical-review report;
- working-paper section;
- failure record for universal primality;
- provenance manifest.

## Acceptance assertions

- **RP-001-A01:** The accepted project contains an explicitly refuted universal
  primality conjecture rather than silently replacing it.
- **RP-001-A02:** The first composite record is `n = 40`, value `1681`, with
  factorization `41 * 41`.
- **RP-001-A03:** RP-001-C01 is scoped exactly to `0 <= n <= 39` and is backed by
  complete-range computation.
- **RP-001-A04:** RP-001-C03 is stated for `k >= 1`, has a symbolic derivation,
  and is not labeled formally verified unless an actual proof kernel is used.
- **RP-001-A05:** Code, environment, dataset, and report can be replayed from the
  exported package.
- **RP-001-A06:** At least one branch or reviewer records why finite evidence was
  insufficient for the rejected universal claim.

