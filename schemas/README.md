# JSON Schemas

Generated schemas are derived from the normative Zod schemas in
`packages/project-format`. From the repository root, run:

```bash
pnpm schemas
```

This writes Draft 2020-12 schemas and `index.json` to `schemas/generated/` for
the actor, artifact, edge, event, known-event, object, and manifest envelopes.
These generated files are checked-in public interchange artifacts. The Zod
definitions and generator remain their source; do not hand-edit generated
JSON. CI detects stale artifacts with:

```bash
pnpm run schemas:check
```
