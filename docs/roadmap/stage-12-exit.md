# Stage 12 Exit — Publication Releases and Reproducibility

Status: **Complete for the agreed publication/reproducibility slice**

Date: 2026-08-21

## Acceptance criteria

| ID | Criterion | Evidence |
|---|---|---|
| S12-AC-01 | A release is a branch-scoped derived layout with manuscript, proofs, code, data, figures, environments, verification, provenance, and a clean canonical snapshot. | publication build integration coverage. |
| S12-AC-02 | A deterministic manifest, full branch-source-state record, and inventory bind every emitted payload file, exact source object/artifact/edge/environment lineage, artifact/reproduction auxiliary views, and the snapshot event head. Closed public record shapes reject rehashed authentication, external-publication, or engine-execution claims. Release report gates, reference assertions, and normalized verification profiles are semantically rechecked on reopen. | Offline source-digest, fully rehashed report/reproduction/environment, manifest, artifact-lineage, false-claim, and missing/tampered/extra inventory tests. |
| S12-AC-03 | Integrity, reference assertions, exact edge/citation refs, stale/failed profiles, template roles, artifact lineage, all non-closed failures, normalized paper gaps, and malformed papers are hard gates. A stale historical edge is release-omitted only when a current exact same-relationship edge replaces it. | REL-001 through REL-007 plus edge replacement coverage. |
| S12-AC-04 | A local human-attribution record binds the selected branch state but makes no authentication or external-publication claim. | REL-008 attribution tests. |
| S12-AC-05 | RP-001, RP-002, and RP-003 create clean branch-scoped releases that reopen/check through an external temporary projection, including read-only canonical media; every `.reasoning` payload is rejected. RP-002 retains alignment/review/paper exact-reference semantics. | packages/store/test/publication.test.ts. |
| S12-AC-06 | A bounded, object-ID-ordered eligible-candidate reproduction report does not pretend that optional external engines ran or that its candidates are researcher-designated central runs. | publication reproduce reports not-attempted. |

## Definition-of-Done mapping

- DOD-PUBLISH-01 and DOD-PUBLISH-02
- `DOD-STATE-01`, `DOD-STATE-02`, and `DOD-REF-01` through `DOD-REF-04`

## Explicit limitations

- DOD-PUBLISH-03 is partial: the release verifies/reopens a clean snapshot and
  lists bounded eligible run candidates, but it neither records designated
  central runs nor runs configured external engines.
- DOD-PUBLISH-04 is not satisfied: actor-id is local attribution only, not
  authentication or external publication authority.
- The release layer validates and reopens canonical snapshots; it does not run
  unbundled Lean, CAS, simulation, remote-compute, or journal/repository APIs.
- A production deployment must add an explicitly authorized engine adapter to
  turn the bounded inspection plan into an executable reproduction run.
