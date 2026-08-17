# Reference Projects

Reference projects are executable product contracts, not showcase prompts. They
exercise the system end to end and intentionally include failure modes that a
persuasive language model could otherwise hide.

| ID | Project | Primary capability |
|---|---|---|
| RP-001 | [Euler polynomial investigation](RP-001-euler-polynomial.md) | Experimental mathematics, refutation, negative results |
| RP-002 | [Finite-sum formalization](RP-002-finite-sum-lean.md) | Informal/formal alignment and Lean verification |
| RP-003 | [Harmonic oscillator](RP-003-harmonic-oscillator.md) | Symbolic, dimensional, numerical, and provenance checks |

## Why these projects

The fixtures are deliberately known and bounded. Their purpose is to test the
workbench, not to claim frontier mathematical discovery. Together they cover:

- refinement of an initially plausible but false hypothesis;
- parallel proof, counterexample, literature, and computational workstreams;
- durable failed approaches;
- explicit contexts and assumptions;
- code, datasets, figures, proofs, and sources as native artifacts;
- hard verification gates;
- reproducible export.

Frontier and open-problem evaluations can be added later, but they cannot
replace these deterministic integration fixtures.

## Shared execution rules

Each reference project must:

1. begin from the supplied user brief rather than a pre-populated solution;
2. retain all branch outcomes, including rejected claims and failed runs;
3. record which conclusions came from users, models, tools, and sources;
4. export a complete research package;
5. pass its stable `RP-xxx-Ayy` acceptance assertions;
6. be runnable in a clean environment with pinned dependencies.

