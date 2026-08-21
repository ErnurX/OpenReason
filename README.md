# OpenReason

OpenReason is an open-source, local-first reasoning workbench for sustained
mathematical, theoretical-physics, and computational reasoning. The current
repository implements **Stage 10: Domain Packs** on the canonical substrate.
Pure Mathematics, Theoretical Physics, and Computational Reasoning add strict
semantic/adapter manifests and seven project templates without coupling core to
one engine. RP-001, RP-002, and RP-003 pass machine-derived acceptance and
export hashed research packages. A dependency-light local browser workbench
now provides the first graphical project surface. It is not yet an autonomous
scientist, bundled domain-engine distribution, collaborative server, or native
Tauri distribution.

## Quick start

Requirements: Node.js 22.13 or newer and pnpm 11.

```bash
pnpm install
pnpm run check

# Show every available command.
pnpm rw --help

# Create and inspect an empty project.
pnpm rw init /tmp/rw-demo --title "Demo investigation"
pnpm rw info /tmp/rw-demo
pnpm rw verify /tmp/rw-demo

# Open the token-authenticated, loopback-only local workbench.
pnpm rw workbench /tmp/rw-demo

# Query the branch graph.
pnpm rw graph query /tmp/rw-demo

# Inspect the trusted tools available to the local CLI runtime.
pnpm rw tools list
pnpm rw verification list --human

# Or create the RP-001 Euler-polynomial fixture.
pnpm rw fixture rp001 /tmp/rw-rp001
pnpm rw info /tmp/rw-rp001
pnpm rw history /tmp/rw-rp001
pnpm rw verify /tmp/rw-rp001

# Compile bounded context after taking the goal ID from the fixture output.
pnpm rw context compile /tmp/rw-rp001 --goal <goal-id> --query "first composite"

# Inspect a secret-free model declaration before attaching it to a session.
pnpm rw models inspect --model-config-file ./model.json

# Normalize and hash an execution job before granting it to a workstream.
pnpm rw execution inspect --job-file ./job.json

# Author and render a typed paper after filling paper.json with real fixture IDs.
pnpm rw paper put /tmp/rw-rp001 --paper-file ./paper.json
pnpm rw paper render /tmp/rw-rp001 <paper-id> --format latex

# Ingest and search local literature; PDF text/page extraction is a sidecar file.
pnpm rw literature ingest /tmp/rw-rp001 ./paper.pdf \
  --metadata-file ./metadata.json --extracted-text-file ./paper.pages.txt
pnpm rw literature search /tmp/rw-rp001 --query "exact theorem" --anchor-kind theorem

# Inspect domain packs or produce a complete reference research package.
pnpm rw domain packs
pnpm rw domain templates --pack pure-mathematics
pnpm rw reference create /tmp/rw-rp002 RP-002
pnpm rw research-package build /tmp/rw-rp002 /tmp/rw-rp002-package --reference RP-002
```

`pnpm run check` runs the TypeScript build check, verifies that the checked-in
JSON Schemas are current, runs the Vitest suite, and runs the Stage 0 contract
validator. `pnpm schemas` regenerates the public Draft 2020-12 JSON Schemas
under `schemas/generated/` from the Zod source schemas.

## CLI

Commands emit JSON by default. Commands with a compact formatter also accept
`--human`; `--help` and errors are always text.

```text
pnpm rw init <project-dir> --title <title>
pnpm rw info <project-dir>
pnpm rw workbench <project-dir> [--port <port>] [--no-open]
pnpm rw branch create <project-dir> <name> [--from <branch-id-or-name>]
pnpm rw branch diff <project-dir> <source> <target>
pnpm rw branch semantic-diff <project-dir> <source> <target>
pnpm rw branch merge <project-dir> <source> <target>
pnpm rw object put <project-dir> --type <type> [--branch <id-or-name>]
    (--content <json> | --content-file <path>) [--object-id <id>]
pnpm rw edge add <project-dir> --type <type> --from <object-id> --to <object-id>
    --context <context-id> [--branch <id-or-name>] [--metadata <json>]
pnpm rw artifact add <project-dir> <file> --media-type <type> --name <logical-name>
    --run-id <run-id> --environment-id <env-id> [--branch <id-or-name>]
pnpm rw evidence promote <project-dir> --claim <claim-id> --context <context-id>
    --artifact <artifact-id> --dimension <dimension> --outcome <outcome>
    --summary <text> [--branch <id-or-name>]
pnpm rw review record <project-dir> --claim <claim-id> --context <context-id>
    --outcome <outcome> --summary <text> [--branch <id-or-name>]
pnpm rw verification profile <project-dir> <claim-id> --context <context-id>
    [--branch <id-or-name>]
pnpm rw verification list
pnpm rw verification run <project-dir> --claim <claim-id> --context <context-id>
    --verifier <verifier-id> (--input <json> | --input-file <path>)
    [--artifact <id,...>] [--assumption <id,...>] [--branch <id-or-name>]
pnpm rw verification packet <project-dir> --claim <claim-id> --context <context-id>
    [--evidence <id,...>] [--source <id,...>] [--branch <id-or-name>]
pnpm rw verification review <project-dir> --review-file <path> [--branch <id-or-name>]
pnpm rw verification loop <project-dir> --claim <claim-id> --context <context-id>
    [--enforce] [--branch <id-or-name>]
pnpm rw verification align <project-dir> --alignment-file <path> [--branch <id-or-name>]
pnpm rw verification recover <project-dir> [--branch <id-or-name>]
pnpm rw paper put <project-dir> (--paper <json> | --paper-file <path>)
    [--paper-id <document-id>] [--branch <id-or-name>]
pnpm rw paper render <project-dir> <paper-id> [--format <markdown|latex>]
    [--branch <id-or-name>]
pnpm rw paper inspect <project-dir> <paper-id> [--branch <id-or-name>]
pnpm rw paper impact <project-dir> <paper-id> --changed <object-id,...>
    [--branch <id-or-name>]
pnpm rw literature ingest <project-dir> <file> [--metadata-file <path>]
    [--extracted-text-file <path>] [--kind <kind>] [--branch <id-or-name>]
pnpm rw literature ingest-folder <project-dir> <folder> [--branch <id-or-name>]
pnpm rw literature list <project-dir> [--branch <id-or-name>]
pnpm rw literature show <project-dir> <source-id> [--branch <id-or-name>]
pnpm rw literature open <project-dir> <source-id> <anchor-id> [--branch <id-or-name>]
pnpm rw literature search <project-dir> --query <text>
    [--mode <lexical|semantic|hybrid|citation>] [--anchor-kind <kind,...>]
    [--assumption <id,...>] [--seed-source <id,...>] [--limit <n>]
pnpm rw literature review <project-dir> --source <id> --anchor <id>
    --outcome <accepted|rejected|revised> --summary <text>
pnpm rw literature link <project-dir> --from <source-id> --to <source-id>
pnpm rw literature cite <project-dir> --claim <id> --context <id>
    --citation-file <path>
pnpm rw literature novelty <project-dir> --claim <id> --context <id> [--limit <n>]
pnpm rw literature catalog-search --query <text> --allow-network [--limit <n>]
pnpm rw literature catalog-ingest <project-dir> --record-file <path>
pnpm rw domain packs
pnpm rw domain show <pack-id>
pnpm rw domain templates [--pack <pack-id>]
pnpm rw domain conformance <pack-id>
pnpm rw domain authorize <project-dir> --pack <pack-id> --allow-binding <id,...>
    [--capability <capability,...>] [--branch <id-or-name>]
pnpm rw domain init <project-dir> --pack <pack-id> --template <template-id>
    --title <title> [--problem <text>] [--goal <text>] [--context-file <path>]
pnpm rw reference create <project-dir> <RP-001|RP-002|RP-003>
pnpm rw reference evaluate <project-dir> <RP-001|RP-002|RP-003>
    [--branch <id-or-name>]
pnpm rw research-package build <project-dir> <destination-dir>
    --reference <RP-001|RP-002|RP-003> [--branch <id-or-name>]
pnpm rw graph query <project-dir> [--branch <id-or-name>]
    [--object-type <type,...>] [--edge-type <type,...>] [--context <id>]
pnpm rw graph traverse <project-dir> --start <object-id,...>
    --direction <upstream|downstream|both> [--max-depth <n>]
    [--branch <id-or-name>] [--edge-type <type,...>]
pnpm rw impact <project-dir> --changed <object-id,...> [--branch <id-or-name>]
pnpm rw staleness <project-dir> --changed <object-id,...> [--branch <id-or-name>]
pnpm rw policy evaluate <project-dir> --policy-file <path> [--branch <id-or-name>]
pnpm rw context compile <project-dir> --goal <goal-id> [--branch <id-or-name>]
    [--query <text>] [--max-characters <n>] [--max-entries <n>]
pnpm rw models inspect --model-config-file <path>
pnpm rw models route --registry-file <path> --task <task>
    --input-tokens <n> --output-tokens <n>
    [--privacy <local-only|no-training-or-local|external-allowed>]
    [--modality <text,image,audio>] [--require-tool-use]
    [--max-cost-micros <n>]
pnpm rw models usage <project-dir> [--branch <id-or-name>]
pnpm rw execution inspect --job-file <path>
pnpm rw execution promote --transcript-file <path>
pnpm rw execution run <project-dir> <workstream-id> --job-file <path>
    [--timeout-ms <n>] [--unsafe-process-only]
pnpm rw execution targets
pnpm rw agent create <project-dir> <workstream-id>
    (--script-file <path> | --model-config-file <path>)
    [--query <text>] [--max-turns <n>] [--max-input-tokens <n>]
    [--max-output-tokens <n>] [--max-model-cost-micros <n>]
    [--repeated-action-limit <n>] [--max-characters <n>] [--max-entries <n>]
pnpm rw agent <step|run> <project-dir> <session-id>
    (--script-file <path> | --model-config-file <path>)
pnpm rw agent steer <project-dir> <session-id> --instruction <text>
pnpm rw agent <status|resume> <project-dir> <session-id>
pnpm rw agent list <project-dir>
pnpm rw agent recover <project-dir>
pnpm rw tools list
pnpm rw workstream create <project-dir> <name> --goal <goal-id>
    --policy-file <path> --allow-tool <tool-id,...> [--capability <cap,...>]
    [--from <branch-id-or-name>] [--max-tool-calls <n>]
    [--max-wall-time-ms <n>] [--max-artifact-bytes <n>] [--max-cost-micros <n>]
pnpm rw workstream list <project-dir>
pnpm rw workstream status <project-dir> <workstream-id>
pnpm rw workstream run <project-dir> <workstream-id> --tool <tool-id>
    (--input <json> | --input-file <path>) [--timeout-ms <n>]
pnpm rw workstream <pause|resume|cancel|complete> <project-dir> <workstream-id>
pnpm rw workstream recover <project-dir>
pnpm rw history <project-dir>
pnpm rw verify <project-dir>
pnpm rw rebuild <project-dir>
pnpm rw cleanup <project-dir> [--dry-run] [--remove-orphans]
pnpm rw export <project-dir> <destination-dir>
pnpm rw fixture rp001 <project-dir>
```

Project mutations append typed canonical events. `verify` checks the manifest,
accepted event history and hash chain, artifact digests, and equivalence with a
fresh projection replay. `export` first verifies the source and copies only
canonical state to an empty directory. The exported package contains no
`.reasoning/`; `info` or the next typed mutation rebuilds its SQLite projection
when it is opened.

`workbench` always binds `127.0.0.1` and uses a fresh bearer token per launch.
The token-authenticated browser shell reads projections and writes only through
the typed store; tabs, filters, and selections are not project state. It can
create an isolated branch and common typed project objects without JSON. This
is a local administrative surface, not remote authentication, an execution
sandbox, or a packaged Tauri application. See
[ADR-0015](docs/architecture/adr/0015-loopback-workbench-shell.md) and the
[workbench acceptance notes](docs/roadmap/stage-2-workbench.md).

Graph query, traversal, impact, staleness, and policy evaluation are derived
reads. A safe merge is an explicit direct-child-to-parent operation: clean
objects become new target versions and source-only edges become new target
edges bound to current target endpoint versions. Divergent object edits produce
durable open failure records instead of an automatic winner. See
[ADR-0006](docs/architecture/adr/0006-stage-2-reasoning-services.md) for its
single-writer and recovery boundary.

Stage 3 tool dispatch is also explicit. A workstream grants named tools and
capabilities on its own branch, and every call is checked against its typed
contract and remaining budget. Environment, run, artifact, and failure records
are canonical project objects; local runtime bookkeeping remains derived. The
in-process adapter is intended for trusted handlers and is not an OS sandbox.
See [ADR-0007](docs/architecture/adr/0007-stage-3-workstream-runtime.md).

Stage 4 compiles model input from the current branch graph, carries exact
object/version/hash back-references, prioritizes relevant open failures, applies
hard character and entry limits, redacts secret-like fields, and hashes the
result. An agent session records the exact prompt, adapter descriptor,
permissions, structured response, and usage. A model may request a permitted
tool, propose an unreviewed branch-local object, checkpoint, escalate, or ask
for completion; it cannot merge or declare success. The bundled scripted local
adapter is for offline conformance and demos, not a live provider. See
[ADR-0008](docs/architecture/adr/0008-stage-4-context-and-agent-coordinator.md).

Stage 5 supplies live HTTP adapters without placing credentials in project
state. A model JSON file contains an opaque reference such as
`"credentialRef": "env:OPENAI_API_KEY"`; the value is resolved only at call
time. OpenAI and Anthropic require `network.access,secrets.read,spend` on the
workstream. A credential-free loopback compatible server requires only
`network.access`. Output tokens are capped at the provider request and declared
token prices constrain both session and shared workstream spend before the
call; actual usage, cost, and latency are retained on the model turn and charged
idempotently to the workstream. Routing profiles are inspectable
operator declarations, not independent proof of provider privacy or quality.
See [ADR-0009](docs/architecture/adr/0009-stage-5-model-gateway.md).

Stage 6 normalizes code, inputs, outputs, parameters, resources, environment,
network policy, reproducibility, and seed into one hashed job. `execution.local`
materializes a fresh workspace and returns stdout, stderr, and declared outputs
through the ordinary CAS/artifact runtime; only successful deterministic or
seeded jobs can be reused. The default local target fails closed unless its
macOS OS sandbox can be applied. The explicit `--unsafe-process-only` option is
for development/tests and is not a security boundary. Hard resident-memory
enforcement and a bundled remote worker remain open; the SSH adapter is a
bounded protocol and target implementation. See
[ADR-0010](docs/architecture/adr/0010-stage-6-execution-plane.md).

Stage 7 stores a working paper as an ordinary versioned `document`, not as a
second database. Each reference carries a semantic object ID, exact object and
context versions, and an explicit `live` or `pinned` policy. Markdown and LaTeX
renders are derived and hashed. Artifact promotion creates exact-version
evidence with CAS/run/environment lineage; the profile keeps logical, symbolic,
numerical, source, reproducibility, human-review, and formal dimensions
separate from model confidence. Impact warnings reuse graph paths but accept a
path for a section only when every edge has that section's context. See
[ADR-0011](docs/architecture/adr/0011-stage-7-living-working-paper.md).

Stage 8 executes typed verifier adapters behind explicit schemas,
capabilities, side effects, determinism, and assurance levels. The profile now
separates logical, symbolic, numerical, physical, source, reproducibility,
human-review, and formal dimensions; only `formal-kernel` evidence becomes
`verified`, while bundled domain report adapters remain honestly `reported`.
CAS integrity is machine-checked locally. Independent review packets omit
persuasive author self-assessment, reviewer loops can escalate to durable human
gaps, and completion policies can require current evidence, reviewers, clear
loops, and informal/formal alignment. See
[ADR-0012](docs/architecture/adr/0012-stage-8-verification-plane.md).

Stage 9 stores each source as a versioned `source` object backed by the normal
CAS, with exact run/environment/ingestor lineage. Extracted anchors remain
machine proposals until an exact-version review accepts, rejects, or revises
them. Search combines lexical, adapter-based semantic, citation-graph, anchor-
kind, and assumption signals. Source grounding checks location, metadata,
quotation, assumptions, statement strength, and reviewed support; changing the
source or anchor makes existing evidence stale. OpenAlex access is deny-by-
default and requires `--allow-network`; novelty output always requires human
review. See [ADR-0013](docs/architecture/adr/0013-stage-9-literature-workspace.md).

Stage 10 adds strict, content-hashed Domain Pack manifests. A pack maps its
disciplinary vocabulary onto the existing graph and declares typed tool/
verifier bindings; registration grants no permission. Conformance checks actual
contracts, and authorization persists an explicit binding/capability allow-list
with exact contract digests. Seven templates create ordinary project state.
Machine-derived RP-001/002/003 assertions gate a portable export whose
`research-package.json` inventories the event head, pack/template, exact object
versions, CAS artifacts, failures, and acceptance evidence. External Lean,
Sage, GAP, PARI/GP, SMT, SymPy, Cadabra/xAct, and JAX engines remain replaceable
deployment adapters. See [ADR-0014](docs/architecture/adr/0014-stage-10-domain-packs.md).

A minimal local-compatible model declaration is:

```json
{
  "schemaVersion": 1,
  "kind": "openai-compatible",
  "adapterId": "local.math",
  "model": "local-model",
  "pricing": {
    "inputMicrosPerMillionTokens": 0,
    "outputMicrosPerMillionTokens": 0,
    "currency": "USD"
  },
  "profile": {
    "maxContextTokens": 32768,
    "maxOutputTokens": 4096,
    "modalities": ["text"],
    "structuredOutput": true,
    "toolUse": true,
    "strengths": { "general": 60, "mathematics": 70 },
    "expectedLatencyMs": 500,
    "privacy": "local"
  }
}
```

For OpenAI use `"kind": "openai-responses"`; for Anthropic use
`"kind": "anthropic-messages"`. Both require `credentialRef`. Prices are
micro-units of the declared currency per one million tokens and are never
silently fetched or updated. Repository tests inject mock transports; run a
deployment-specific live acceptance check before relying on an account.

`artifact add` does not accept invented lineage IDs. First create `run` and
`environment` objects on the same branch with `object put`, then pass their
returned `objectId` values as `--run-id` and `--environment-id`.

## Canonical state and derived state

The project directory is the portable source of truth:

- `reasoning-project.json` is the versioned manifest and acceptance boundary
  for event segments;
- `events/*.jsonl` is the append-only accepted history;
- `artifacts/sha256/...` contains content-addressed artifact bytes;
- `documents/`, `code/`, `proofs/`, `sources/`, and `environments/` hold
  portable research files referenced by project records.

`.reasoning/state.sqlite` and `.reasoning/runtime/` are derived local state.
They are deliberately excluded from export and may be deleted. Recreate the
SQLite view from canonical events explicitly with:

```bash
pnpm rw rebuild <project-dir>
```

Opening a canonical-only export with `info`, or applying a typed mutation to
it, performs the same rebuild lazily.

This separation is an architectural invariant: SQLite accelerates inspection,
but it never becomes the only copy of project meaning.

## Repository map

- `packages/project-format` — opaque IDs, UTC timestamps, canonical JSON and
  SHA-256 hashing, Zod envelopes, event builders, and JSON-Schema source types.
- `packages/store` — atomic JSONL event segments, filesystem CAS, disposable
  SQLite projections, typed graph/impact services, completion gates,
  conservative branch diff/merge, typed tools and workstream runtime, bounded
  context compilation, provider-neutral agent coordination, live model
  adapters, capability routing, usage accounting, immutable compute jobs,
  local/SSH execution targets, deterministic artifact reuse, typed working
  papers, Markdown/LaTeX rendering, verifier adapters, independent review,
  hard verification gates, portable literature ingestion, exact anchors,
  source-aware search, citation grounding, conservative novelty, semantic
  impact and branch comparison, domain-pack manifests and templates, reference
  acceptance, research-package export, cleanup, verification, and RP-001/002/
  003 fixtures.
- `packages/cli` — the `rw` command-line adapter over the project service.
- `schemas` — schema-generation notes and checked-in public Draft 2020-12
  schemas.
- `docs/product` — product contract and complete-product Definition of Done.
- `docs/architecture` — format contract, invariants, and ADRs.
- `docs/reference-projects` — end-to-end research cases used to drive future
  cross-cutting capabilities.
- `docs/roadmap` — stage exit criteria and implementation traceability.

## Contracts and stage status

- [Product contract](docs/product/product-contract.md)
- [Definition of Done](docs/product/definition-of-done.md)
- [System invariants](docs/architecture/invariants.md)
- [Project format v0](docs/architecture/project-format-v0.md)
- [Architecture decisions](docs/architecture/adr/README.md)
- [Reference projects](docs/reference-projects/README.md)
- [Stage 0 exit and Stage 1 entry](docs/roadmap/stage-0-exit.md)
- [Stage 1 exit](docs/roadmap/stage-1-exit.md)
- [Stage 2 exit](docs/roadmap/stage-2-exit.md)
- [Stage 3 exit](docs/roadmap/stage-3-exit.md)
- [Stage 4 exit](docs/roadmap/stage-4-exit.md)
- [Stage 5 exit](docs/roadmap/stage-5-exit.md)
- [Stage 6 exit](docs/roadmap/stage-6-exit.md)
- [Stage 7 exit](docs/roadmap/stage-7-exit.md)
- [Stage 8 exit](docs/roadmap/stage-8-exit.md)
- [Stage 9 exit](docs/roadmap/stage-9-exit.md)
- [Stage 10 exit](docs/roadmap/stage-10-exit.md)
