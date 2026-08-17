# Project Format Contract v0

Status: **Accepted design input for Stage 1**

This is the minimum canonical format contract. Stage 1 will implement and test
it; field-level schemas may be expanded without weakening the invariants.

## Directory layout

```text
project-root/
├── reasoning-project.json
├── events/
│   └── 00000001-00001000.jsonl
├── objects/
│   └── optional human-readable projections
├── documents/
├── code/
├── proofs/
├── sources/
├── environments/
├── artifacts/
│   └── sha256/<prefix>/<digest>
└── .reasoning/
    ├── state.sqlite
    ├── search-index/
    └── runtime/
```

`.reasoning/state.sqlite`, search indexes, caches, and runtime state are derived
and disposable. The manifest, events, referenced source files, and artifacts are
canonical.

## Identifier rules

- IDs are globally unique, opaque, and stable.
- IDs do not encode mutable names, paths, providers, or object versions.
- Human-readable slugs are optional aliases.
- Every durable object version is immutable.
- A mutable project view points to the currently selected version.

Recommended representation: UUIDv7 or equivalent time-sortable opaque IDs.

## Project manifest envelope

```json
{
  "format": "reasoning-project",
  "formatVersion": "0.1.0",
  "projectId": "prj_...",
  "title": "Example investigation",
  "createdAt": "2026-08-14T00:00:00Z",
  "defaultBranchId": "br_...",
  "eventSegments": ["events/00000001-00001000.jsonl"],
  "hashAlgorithm": "sha256"
}
```

## Object envelope

```json
{
  "objectId": "clm_...",
  "objectType": "claim",
  "versionId": "ver_...",
  "version": 3,
  "createdAt": "2026-08-14T00:00:00Z",
  "createdBy": {"actorType": "human", "actorId": "usr_..."},
  "branchId": "br_...",
  "content": {},
  "contentHash": "sha256:...",
  "supersedesVersionId": "ver_..."
}
```

Required initial object types:

```text
problem, goal, context, definition, assumption, claim, evidence,
source, run, artifact, review, decision, failure, branch, workstream,
document, environment, alignment
```

## Edge envelope

```json
{
  "edgeId": "edg_...",
  "edgeType": "supports",
  "from": {"objectId": "evd_...", "versionId": "ver_..."},
  "to": {"objectId": "clm_...", "versionId": "ver_..."},
  "contextId": "ctx_...",
  "createdAt": "2026-08-14T00:00:00Z",
  "createdBy": {"actorType": "tool", "actorId": "tool_..."},
  "metadata": {}
}
```

Required initial edge types:

```text
depends_on, uses_definition, supports, refutes, derived_from,
tested_by, formalizes, cites, produced_by, contradicts, supersedes
```

## Event envelope

```json
{
  "sequence": 42,
  "eventId": "evt_...",
  "eventType": "ClaimProposed",
  "occurredAt": "2026-08-14T00:00:00Z",
  "projectId": "prj_...",
  "branchId": "br_...",
  "actor": {"actorType": "agent", "actorId": "agt_..."},
  "causationId": "evt_...",
  "correlationId": "job_...",
  "schemaVersion": 1,
  "payload": {},
  "eventHash": "sha256:..."
}
```

Events within a project have a monotonic sequence. Import preserves source
identity. A merge never rewrites source history: it keeps stable object IDs,
creates target-local versions and exact-version edge copies where necessary,
retains source version/edge IDs in provenance, and records a new merge event.

## Artifact reference

```json
{
  "artifactId": "art_...",
  "digest": "sha256:...",
  "mediaType": "application/json",
  "size": 12345,
  "logicalName": "enumeration-results.json",
  "producedByRunId": "run_...",
  "environmentId": "env_...",
  "inputs": ["sha256:..."],
  "reproducibility": "deterministic"
}
```

## Verification profile

A claim carries references to evidence; it does not own a single mutable truth
score. Derived views may summarize:

```json
{
  "logical": "informal-reviewed",
  "symbolic": "checked",
  "numerical": "reproduced",
  "source": "location-verified",
  "formal": "not-formalized",
  "humanReview": "accepted",
  "stale": false
}
```

The summary is a projection from evidence and policy, not an agent-authored
field that can bypass underlying records.

## Compatibility rules

- Readers reject unsupported major versions.
- Readers preserve unknown object fields and event types when round-tripping.
- Migrations append migration events and never mutate published snapshots.
- Plugin data lives under namespaced fields.
- Provider-specific IDs may appear in provenance but never replace canonical
  IDs.
