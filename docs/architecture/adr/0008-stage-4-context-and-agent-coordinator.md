# ADR-0008: Stage 4 Context and Agent Coordinator

Status: **Accepted**  
Date: 2026-08-15

## Context

Stage 3 can run authorized typed tools on isolated workstream branches, but it
does not decide what a model sees or interpret model output. Adding a model
loop without those boundaries would make chat history canonical by accident,
hide provenance, and let a completion phrase bypass executable policy.

## Decision

### Compiled context

Model context is a deterministic, read-only compilation of the current
workstream branch. A bundle is goal-specific and bounded by both characters
and entries. Every included object carries its exact object ID, version ID,
content hash, selection reason, and prompt span; the complete bundle has a
canonical digest. Graph proximity, lexical overlap, and relevant open failures
are explicit selection signals. Secret-like fields are redacted before prompt
material is produced.

The bundle is derived state. The exact prompt, digest, limits, and stable
back-references used for a model turn are copied into that turn's canonical run
record, so later projection rebuilds do not lose execution lineage.

### Provider-neutral structured turns

A model adapter declares a stable provider/model descriptor, exact JSON
configuration, and required capabilities, accepts a serializable request plus
`AbortSignal`, and returns a validated structured action with measured usage.
Secret-like configuration and responses are rejected before canonical writes;
persisted error text is defensively redacted. Core semantics do not depend on a
vendor SDK or transport. Adapter access is separately authorized and does not
grant any tool.

The action for one turn is exactly one of: request an authorized tool call,
propose a typed branch-local object, write a checkpoint, produce a structured
escalation, or request policy-gated completion. Raw model output and model
confidence are never proof and never become accepted project state merely by
being emitted.

### Coordinator authority

An agent session is attached to one runtime workstream and therefore one
isolated branch. Each explicit step recompiles context, invokes the adapter,
records exact request/action/usage provenance, then re-reads durable state
before applying the action. Tool requests go only through
`WorkstreamRuntime.executeTool`; completion requests go only through
`WorkstreamRuntime.complete`; the coordinator has no merge or publication
authority.

Steering messages and checkpoints are append-only typed decision records.
Escalation records attempted approaches, evidence IDs, the blocker, and the
requested human input, then pauses the workstream. Model-turn, token, cost, and
repeated-action limits are finite and enforced before a proposed action is
applied. Exceeded limits remain durable failures rather than silent stops.

Model inference happens outside project mutation critical sections. Stage 4
still assumes a single canonical writer for its multi-event orchestration.
After inference, each direct proposal/checkpoint/escalation write is
linearized against pause/cancel through the same workstream mutation gate;
tool and completion actions use their existing gates. An entire turn is not
one transaction.

If a process stops after a model-turn record is created but before the session
accounts for it, recovery never replays the action. It marks the turn
interrupted when needed, accounts known usage, creates an open failure, pauses
the workstream, and blocks that session for explicit review. Unknown external
effects are not silently treated as zero-cost success.

## Consequences

- Context can be inspected and reproduced without the original provider.
- Providers can be replaced without changing project meaning.
- Steering, negative results, model usage, and escalation remain queryable.
- A scripted local adapter can exercise the complete contract without network
  access. Its descriptor binds a canonical script digest and uses durable turn
  numbers rather than process-local cursor state, but it is a conformance
  adapter, not evidence of external-provider support.
- A later adapter package can add real providers without granting tools,
  completion, merge, or publication authority.

## Stage 4 boundary

Stage 4 has no live vendor adapter, autonomous scheduler daemon, background
queue, cross-process lease, secret broker, OS/container sandbox, remote compute,
automatic merge, or UI. Cooperative abort cannot forcibly stop an adapter that
ignores its signal. This stage therefore does not claim complete satisfaction
of `DOD-AGENT-06`, `DOD-EXEC-05`, or `DOD-EXEC-06`.

## Rejected alternatives

- **Using chat history as the prompt database:** loses stable references and
  bounded reproducibility.
- **Letting the model emit arbitrary canonical events:** bypasses type,
  authorization, and review boundaries.
- **Treating a model's completion action as success:** violates executable
  completion gates.
- **Bundling vendor credentials into the project:** violates the secret and
  portability invariants.
- **Holding the writer lock during inference:** blocks unrelated workstreams
  and still does not make a remote request transactional.
