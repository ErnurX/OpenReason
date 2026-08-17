# Stage 0 Exit and Stage 1 Entry

Date: 2026-08-14

## Stage 0 deliverables

- [x] Complete product contract
- [x] Testable complete-product Definition of Done
- [x] Three end-to-end reference projects
- [x] Normative system invariants
- [x] Canonical project-format contract v0
- [x] Architecture decision records for state, deployment, reasoning, agents,
      and tools
- [x] Repository-level implementation instructions
- [x] Git repository initialized and transient files ignored
- [x] Reproducible Stage 0 document validator

Validation command:

```bash
python3 scripts/validate_stage0.py
```

## Decisions that do not block Stage 1

These remain intentionally reversible:

- final public project name;
- Apache-2.0 versus another OSI-approved license;
- exact UI component library;
- initial hosted model-provider order;
- initial external literature catalog;
- hosted deployment provider.

They must be resolved before the relevant release or integration, not before the
canonical project substrate is implemented.

## Stage 1 objective

Implement the open canonical project substrate described by ADR-0001 and
`project-format-v0.md`.

## Stage 1 ordered work

1. Scaffold the monorepo and shared TypeScript configuration.
2. Implement IDs, timestamps, hashing, and schema-version primitives.
3. Implement Zod/JSON Schema definitions for the manifest, object, edge, event,
   actor, and artifact envelopes.
4. Implement append-only JSONL event segments with atomic commit behavior.
5. Implement filesystem content-addressed storage with digest verification.
6. Implement SQLite projections and complete rebuild from canonical state.
7. Implement branch creation and immutable object versioning.
8. Implement a CLI for project creation, event append, object inspection,
   history, verification, rebuild, and export.
9. Add corruption, crash, unknown-field, and migration tests.
10. Encode RP-001's initial problem/context/goal objects as the first fixture.

## Stage 1 acceptance criteria

- A project can be created and inspected from the CLI.
- Objects and edges can be appended on isolated branches.
- Artifacts are stored and verified by digest.
- Deleting SQLite projections and rebuilding produces equivalent current state.
- An interrupted append cannot leave a partially accepted event.
- Unknown namespaced fields survive import/export.
- An exported project reopens in a clean temporary directory.
- The first RP-001 fixture objects are represented without provider-specific
  fields.

## Primary risks entering Stage 1

### Schema over-design

Mitigation: implement stable envelopes and namespaced extensibility; keep
domain-specific content minimally constrained until exercised by fixtures.

### Event/file divergence

Mitigation: define atomic write order, content hashes, integrity checks, and
rebuild tests before UI work.

### Treating projections as canonical

Mitigation: CI deletes all derived state and rebuilds reference projects from
canonical files.

### Provider leakage

Mitigation: provider IDs are provenance metadata only; fixture schemas reject
provider-specific canonical identity.
