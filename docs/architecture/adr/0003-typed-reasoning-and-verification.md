# ADR-0003: Typed Reasoning Graph and Evidence Vectors

Status: **Accepted**  
Date: 2026-08-14

## Context

Documents and chats blur definitions, assumptions, hypotheses, computations,
proofs, citations, and reviews. A single confidence score also conflates
incompatible kinds of support.

## Decision

Represent durable research meaning as a typed, versioned graph. Claims are
scoped by explicit contexts and connected to separately versioned evidence.

Verification is multidimensional. Logical review, symbolic checking, numerical
support, source support, reproduction, human review, and formal proof remain
separate evidence classes. Product surfaces may summarize them but cannot
replace the underlying records with one score.

Changes to upstream objects propagate staleness through dependency edges.

## Consequences

- The UI can distinguish polished prose from verified knowledge.
- Semantic impact analysis and branch comparison become possible.
- Object and edge schemas require careful migrations.
- Users need progressive disclosure so the graph does not increase cognitive
  load.
- Automated extraction from documents creates proposals, not accepted graph
  objects.

## Rejected alternatives

- **Working paper as sole state:** good for exposition, insufficient for machine
  impact analysis and verification.
- **Single confidence/trust score:** hides evidence type and failure modes.
- **Free-form knowledge graph:** too weak for completion policies and tests.

