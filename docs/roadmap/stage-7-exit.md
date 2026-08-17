# Stage 7 Exit — Living Working Paper

Status: **Complete for the agreed Stage 7 slice**  
Date: 2026-08-15

Stage 7 connects readable mathematical authoring to canonical reasoning state.
It does not claim that the whole-product authoring, collaboration, publication,
or verification Definition of Done is complete; the boundaries below remain
explicit.

## Acceptance criteria

| ID | Criterion | Evidence |
|---|---|---|
| S7-AC-01 | A typed working paper stores ordered sections, Markdown, equations, transclusions, citations, artifacts, annotations, internal links, and unresolved gaps as a versioned `document`. | `paper.test.ts`: deterministic RP-001 paper and invalid-structure tests. |
| S7-AC-02 | Every transclusion binds stable object identity plus exact object/context versions and supports explicit live or pinned rendering. | RP-001 revision test checks live current text, pinned historical text, and exact backrefs. |
| S7-AC-03 | One paper snapshot renders deterministically to Markdown and standalone LaTeX with portable artifact references and a digest. | RP-001 render test and Stage 7 CLI test. |
| S7-AC-04 | Verification is a seven-dimensional derived profile with no aggregate confidence score. | Profile test keeps a `modelConfidence: 0.99` claim logically missing while numerical artifact evidence is supported. |
| S7-AC-05 | Artifact promotion binds exact claim/context versions, producing run, environment, reproducibility, CAS digest, and a typed evidence edge. | Artifact promotion/profile test plus sibling-branch denial. |
| S7-AC-06 | Revising a claim makes old exact-version evidence and paper bindings stale rather than silently reusing them. | Claim-revision profile/render test. |
| S7-AC-07 | Changing a scoped assumption maps affected claims, evidence, reviews, computation, artifact embeds, and paper sections with graph paths. | RP-001 assumption-impact test. |
| S7-AC-08 | Direct child and parent branches compare statements, assumptions, contexts, evidence, proof statuses, documents, and dependency edges semantically. | Semantic comparison service test and CLI test. |
| S7-AC-09 | The typed service rejects recursive documents, dangling links, context conflicts, secret-like content, invisible artifacts, and sibling-only artifact promotion. | Stage 7 negative tests. |
| S7-AC-10 | Paper put/render/inspect/impact, evidence promotion, verification profile, and semantic diff are available through JSON CLI commands. | `packages/cli/test/stage7.test.ts`. |

## Public surface

- `putWorkingPaper`, `getWorkingPaper`, `inspectWorkingPaper`, and
  `renderWorkingPaper`;
- `analyzeWorkingPaperImpact`;
- `promoteArtifactToEvidence` and `listVisibleArtifacts`;
- `recordVerificationReview`;
- `deriveVerificationProfile` and `VERIFICATION_DIMENSIONS`;
- `compareResearchBranches`;
- `rw paper put|render|inspect|impact`;
- `rw evidence promote`, `rw review record`, and `rw verification profile`;
- `rw branch semantic-diff`.

## Definition-of-Done mapping

- `DOD-GRAPH-03`: implemented for branch-current graph paths and typed paper
  references under an exact context.
- `DOD-GRAPH-04`: confidence is separated from seven verification dimensions.
- `DOD-COLLAB-01`: implemented for Markdown/LaTeX live references to typed
  objects and CAS figures/artifacts.
- `DOD-COLLAB-02`: implemented within Stage 2's direct-child comparison scope.
- `DOD-COLLAB-04`: exact-version review/evidence/paper drift is derived; a full
  review-request workflow remains later work.
- `DOD-REF-01`: RP-001 now exercises computational evidence promotion,
  transclusion, skeptical review, hypothesis impact, and semantic revision.

## Explicit boundaries

- There is no graphical or collaborative editor, CRDT, authentication, comment
  assignment, or multi-user review-request workflow.
- The LaTeX renderer emits source but does not invoke a TeX engine; bibliography
  resolution, PDF/source anchor extraction, HTML, PDF, and journal templates
  are not included.
- `artifact:sha256:...` is a portable reference. A later publisher must
  materialize it into a release tree and enforce release gates.
- Verification profiles summarize typed evidence records; Stage 7 contains no
  CAS/symbolic/numerical/domain verifier, Lean kernel, citation checker, or
  independent reproduction runner. `supported` never means formally verified.
- Context-scoped impact currently requires every edge in a path to carry the
  same exact context ID; cross-context alignment requires explicit future
  alignment semantics.
- Semantic comparison and merge remain direct child to parent, single writer,
  and non-transactional across multi-event orchestration.
- Evidence promotion is two appends. A crash between them leaves evidence that
  the profile safely reports stale because its exact-version edge is missing.

## Next useful slice

Stage 8 should build the Verification Plane: typed verifier adapters and result
contracts for logical review, symbolic algebra, numerical robustness, source
support, reproduction, dimensional/physics checks, formal-kernel builds, axiom
audit, and informal-to-formal alignment. Those results should feed the Stage 7
profile without changing its no-single-score rule.

## Verification

`pnpm run check` passes: TypeScript, checked-in schemas, 18 Vitest files with
127 tests, and the Stage 0 contract/link/stable-ID validator (31 Markdown
files, 39 local links, and 109 stable-ID definitions).
