# Stage 9 Exit — Literature Workspace

Status: **Complete for the agreed Stage 9 slice**

Date: 2026-08-21

Stage 9 adds a portable research corpus with exact anchors, source-aware search,
reviewed citation grounding, and conservative novelty discovery.

## Acceptance criteria

| ID | Criterion | Evidence |
|---|---|---|
| S9-AC-01 | PDF, LaTeX, BibTeX, HTML, text, catalog records, and folders ingest through CAS with run/environment/ingestor lineage; failures remain durable. | `literature.test.ts` PDF and failure tests. |
| S9-AC-02 | Page/section/theorem/definition/equation/figure/reference anchors have stable IDs, content hashes, exact artifact URIs, and remain machine proposals until reviewed. | PDF resolver/review tests and RP-001 CLI LaTeX test. |
| S9-AC-03 | Lexical, adapter-based semantic, hybrid, citation-graph, theorem-kind, and assumption-aware search return exact source/version/anchor references. | Search and citation-graph tests. |
| S9-AC-04 | Citation grounding checks exact location, metadata, quote, assumptions, scope, and reviewed support, then emits current or stale source evidence and gaps. | RP-001 grounding and source-revision staleness test. |
| S9-AC-05 | External catalogs are provider-neutral, deny by default, and require declared capabilities; OpenAlex maps DOI/arXiv metadata through an injected transport. | Static/OpenAlex authorization test. |
| S9-AC-06 | Novelty discovery returns overlap/special-case/attribution candidates but never an automatic novelty verdict. | Novelty test (`not-assessed`, `requires-human-review`). |
| S9-AC-07 | Ingest/list/show/open/search/review/link/cite/novelty/catalog operations are available through the modular CLI. | `packages/cli/test/stage9.test.ts` and CLI help. |

## Definition-of-Done mapping

- `DOD-LIT-01` through `DOD-LIT-04`: local documents/bibliographies, OpenAlex
  adapter, stable anchors, proposal/review boundary, and conservative novelty.
- `DOD-VERIFY-07`: exact source location, metadata, quote, assumptions, scope,
  interpretation, review state, and exact-version staleness.
- `DOD-REF-01`: RP-001 exercises LaTeX/PDF ingestion, theorem search, exact
  opening, citation grounding, and source revision.

## Explicit boundaries

- PDF OCR/layout extraction is a sidecar boundary; the repository does not
  bundle a PDF parser. LaTeX/BibTeX/HTML extraction is intentionally bounded.
- The default semantic adapter is deterministic local term overlap, not a
  neural embedding service.
- OpenAlex live access is opt-in and not part of offline acceptance tests.
- Zotero interoperates through BibTeX/folder export; there is no live sync.
- Search and novelty results are candidates, never evidence of truth or novelty.

## Next useful slice

Stage 10 can add the graphical workbench over the existing project, agent,
verification, paper, and literature services without creating a second source
of truth.

## Verification

The release gate passes: TypeScript, checked-in schemas, 24 Vitest files with
154 tests, and the Stage 0 validator over 35 Markdown files, 45 local links,
and 109 stable-ID definitions.
