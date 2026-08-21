# ADR-0013: Stage 9 Literature Workspace and Source-Grounded Claims

Status: **Accepted**

Date: 2026-08-21

## Context

Stage 8 can represent citation evidence, but it cannot ingest research sources,
resolve an exact theorem or page, search a local corpus, or check that a citation
supports no stronger statement than its source. Stage 9 must add those abilities
without treating extraction, semantic similarity, or database search as proof or
novelty assessment.

## Decision

### Literature remains portable project state

A literature source is a versioned `source` object whose raw bytes are stored in
the ordinary content-addressed artifact store. It binds metadata, artifact
digest, producing run and environment, ingestor identity/version, extraction
digest, references, and stable anchors. PDF, LaTeX, BibTeX, HTML, plain text,
catalog records, and local folders use one provider-neutral ingestion service.
Failed ingestion runs and open failures remain canonical.

Every extracted statement is `machine-proposed`. A separate exact-version
review records acceptance, rejection, or revision; extraction never changes a
claim's verification state by itself. An anchor ID is derived from its kind and
locator, while its content hash detects changed text. A resolver returns the
artifact digest plus page and anchor fragment, so a UI can open the precise
supporting place without making SQLite canonical.

### Search combines independent signals

The local search API supports lexical, semantic, hybrid, citation-graph, anchor-
kind, and assumption-aware ranking. Semantic scoring is an adapter; the bundled
deterministic term-vector implementation is useful offline but is not presented
as an embedding model. Results retain exact source/version/anchor/hash lineage
and review state. Citation edges are explicit project graph edges.

External catalogs use a registry with an explicit catalog allow-list and
capability subset. The OpenAlex adapter requires `network.access`; tests inject
a transport rather than depending on the live service. Catalog results become
portable only when explicitly ingested.

### Citation support is a checked evidence object

Source grounding checks exact location, authors/year/identifiers, quoted text,
assumption inclusion, statement scope, and reviewed support. It persists the
check run/environment, exact source and anchor references, an evidence object,
and judgment/citation edges. Failed or inconclusive checks create an open gap.
The Stage 7/8 verification profile marks this evidence stale when the claim,
context, source version, anchor content, or exact-version judgment edge changes.

Novelty search returns possible overlap, special-case, and prior-attribution
candidates. Its only automatic conclusion is `not-assessed`; every candidate
requires human review.

## Consequences

- Exact source evidence can satisfy the existing `source` verification
  dimension only after a compatible reviewed anchor passes every citation
  check.
- Source bytes, extraction, catalog provenance, negative results, and review
  decisions survive export and replay.
- Provider-specific catalog and semantic behavior stays behind adapters.
- This ADR extends ADR-0011 and ADR-0012; it does not weaken their evidence or
  assurance rules.

## Boundaries

- Core does not bundle OCR or a PDF layout engine. PDF ingestion accepts raw
  bytes plus text/page output from a sidecar extractor; form-feed boundaries
  preserve page numbers. Exact layout quality therefore depends on that
  extractor.
- Zotero is supported through portable BibTeX/filesystem export, not live sync.
- OpenAlex supplies DOI/arXiv discovery metadata but is not a truth oracle.
- HTML extraction is bounded structural text processing, not a browser archive.
- Search scores are discovery aids; neither scores nor citation checks prove a
  theorem or establish novelty.

## Rejected alternatives

- **Store a private search index as the source of truth:** canonical sources and
  anchors stay in the open project format.
- **Auto-accept extracted theorems:** extraction remains a proposal until
  independently reviewed.
- **Let a model declare citation support or novelty:** support is decomposed
  into recorded checks and novelty remains explicitly unassessed.
- **Enable catalog network calls by default:** live access requires an explicit
  allow-list and capability grant.
