# ADR-0017: Derived Publication Releases and Reproducibility Gates

Status: **Accepted**

Date: 2026-08-21

## Context

Stage 10 can export a portable canonical project and derive a reference-package
inventory. It does not yet provide a branch-private release snapshot, a
complete derived-file inventory, or publication gates over stale/open evidence.
An export must not become a second source of truth or cause an agent or model
to publish.

## Decision

The publication check command captures one stable selected-branch state and
derives gates from canonical integrity, current object versions, CAS artifacts,
exact citation/source references, exact edge endpoint versions, verification
profiles, template-required roles, reference assertions, failures, and typed
working-paper gaps. A gate rejects any failure whose status is not closed or
resolved, every normalized gap whose status is not resolved, and any malformed
working-paper object. A visible waiver may name an exact failure/document
version and (for a normalized paper gap) its stable gap ID; it cannot make a
malformed paper canonical.

The capture compares the source event head before and after derivation. Build
compares it again before, during, and after materialization; any concurrent
source mutation aborts and removes the newly created incomplete destination.

A waiver is a visible, versioned decision object with kind
publication-waiver, exact waived object/version or exact document-version/gap
reference, rationale, approved status, and a locally attributed human creator.
Omitting a failure or writing an agent/model waiver cannot pass a release gate.

A trusted local transport can record publication-release-attribution for a
human actor after reviewing a branch-state digest. This is local attribution,
not identity authentication and not authorization to publish externally. The
API rejects agent attribution, but deployment authentication, authorization,
and all journal/repository actions remain outside the local release layer.
Building a release performs no external side effect.

The publication build command first performs the gate and materializes a new,
portable, branch-scoped canonical snapshot under canonical/. It never copies
sibling branch events, objects, or artifacts. It replays full selected source
object envelopes (preserving object/version IDs, content hashes, creators,
timestamps, and extensions) into new branch-scoped events; only the snapshot
branch, local display version, and omitted ancestry are rebased. Full edge
envelopes and artifact references are replayed with their exact endpoint IDs
and metadata. The source event head is cryptographically committed without
exposing sibling activity, and the emitted snapshot has its own independently
verifiable event head. Snapshot materialization reopens the new default branch,
checks every exact object/version reference, and reruns the reference-project
acceptance suite before release construction continues.
Visible historical edges whose endpoint version is no longer current are not
silently accepted: they remain in the source project's append-only history and
are omitted from a release only when a current exact edge with the same edge
type, from object, to object, and context replaces them. Otherwise REL-005
blocks the release. A compact, newly-created lineage decision identifies only
this release's source project/branch, source-state path and digest/head
commitment, and disclosure scope; inherited lineage decisions remain selected
source objects, rather than being recursively embedded in each new decision.
The bundle contains manuscript, proofs, code, data, figures, environments,
verification, and provenance views. Artifact view paths include the artifact
ID and digest prefix, so duplicate logical names cannot collide.

provenance/branch-source-state.json contains full selected-branch source
envelopes and artifact/edge metadata. Its deterministic source-state digest is
recomputed offline during inspection and cross-checked against the manifest,
release report, local attribution, and canonical lineage decision. Every
ordinary emitted file is listed with byte size and SHA-256 in
provenance/release-inventory.json. The inventory and root manifest are
self-verified by their canonical digest, avoiding a recursive byte-hash cycle.
The manifest's selected-object view includes both ordinary and local
attribution source objects; the source-state digest separately excludes the
attribution partition so a new local attribution can bind the same selected
research state without changing it.
Inspect/reproduce reject missing, extra, or tampered files and recompute report
hashes. A release contains no `.reasoning` projection cache at all: any such
entry (including a symlink or an otherwise plausible SQLite file) is an extra
and fails inventory inspection. Semantic reopening replays a writable external
temporary copy, so inspection neither trusts nor writes cache state into a
read-only release. Release paths use a strict forward-slash portable grammar.
Before claiming the new destination root, build compares lexical and real
existing-parent paths, rejects a symbolic-link destination ancestor, and
rejects a destination inside the source project. A hostile local filesystem can
still race path replacement after these checks and before the atomic mkdir
claim; deployment storage controls remain responsible for that residual local
filesystem TOCTOU boundary. Canonical source state remains authoritative.

Public release records use closed, exact shapes at their manifest, attribution,
release-report, reproduction-report, environment-view, inventory, and
source-state wrapper boundaries. The only retained opaque event extension
space is the explicit source-event `extensions` map; original canonical
envelopes remain schema-validated provenance. Thus rehashing cannot add claims
such as authenticated identity, external-publication authorization, or
external-engine execution to a release record.

The manifest's selected object, edge, and artifact views are checked back
against the full source-state record. Artifact paths, digests, lineage, and
inventory entries must agree; the stored artifact-lineage view must equal the
manifest artifacts, and the bounded reproduction report plan must equal the
manifest reproduction plan. Inspection also parses a complete, unique
REL-001 through REL-008 report with every gate passed, validates its fixed
not-executed/no-network/no-external-engine reproduction contract and positive
immutable job bound (even if a presented plan is empty), and compares
the full reference evaluation and normalized verification profiles against a
fresh external snapshot reopen. The release environment view is independently
bound to exact selected source environment object versions and content hashes.

The reproduction report limits itself to a deterministic object-ID-ordered,
bounded set of eligible succeeded deterministic/seeded run candidates,
disables network, and reports inspect-export-only. It does not model a
researcher designation of central runs. It verifies the clean branch snapshot
can be reopened and checked but does not claim that unavailable Lean, CAS,
simulation, or remote engines were run.

## Consequences

- DOD-PUBLISH-01 has a complete derived release layout and hash inventory.
- DOD-PUBLISH-02 fails closed for stale/failed/unresolved required evidence
  unless a visible human waiver is present.
- DOD-PUBLISH-03 is partially addressed: clean snapshot reopen/check and a
  bounded eligible-candidate plan exist, but researcher-designated central
  runs and configured external-engine replay are not modeled here.
- DOD-PUBLISH-04 is not satisfied by this local layer: local attribution is
  neither authentication nor external publication authorization.

## Rejected alternatives

- **Treating an export as canonical publication state:** duplicates authority
  and weakens the event/CAS source of truth.
- **Treating local actor metadata as authentication:** a CLI flag cannot prove
  identity or grant publication authority.
- **Copying the entire project for a branch release:** leaks sibling/private
  work and makes disclosure scope implicit.
- **Claiming external engines were replayed from fixture reports:** confuses
  report shape with engine execution.
