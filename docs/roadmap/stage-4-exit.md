# Stage 4 Exit

Date: 2026-08-15  
Status: **Implemented and testable**

## Exit statement

Stage 4 adds deterministic bounded context and a provider-neutral coordinator
for explicit model turns. A session is tied to one Stage 3 workstream branch;
each turn records its exact prompt, stable references, adapter, permissions,
typed action, and usage. Models remain proposal engines: ordinary runtime and
completion-policy gates retain authority.

The shipped adapter is a deterministic local script used for tests and offline
demos. This is a real coordinator contract, not live vendor integration or an
autonomous scheduler.

## Delivered

- Read-only goal-specific context compilation from current branch objects and
  edges with deterministic graph/lexical ranking.
- Exact object ID, version ID, content hash, selection reason, prompt span, and
  bundle digest; hard character and entry limits.
- Relevant open failures as negative context, branch isolation, current-version
  selection, and recursive secret-like key/free-text redaction.
- Provider-neutral adapter descriptors, remaining-budget request limits,
  measured usage, abort signals, strict response validation, and a local
  scripted conformance adapter.
- One typed action per turn: authorized tool call, unreviewed object proposal,
  checkpoint, structured escalation, or policy-gated completion request.
- Canonical agent-session and model-turn runs, steering/checkpoint decisions,
  model/action/budget/loop failures, and exact prompt/action provenance.
- Model token/cost/turn/repetition limits, preflight checks, actual-usage checks,
  post-inference authorization/lifecycle revalidation, and same-session turn
  serialization.
- Recovery marks an unaccounted durable model turn interrupted, conservatively
  accounts known usage, creates an open failure, and blocks replay pending
  explicit review.
- JSON CLI paths for context inspection, session creation/list/status,
  steering, stepping, running, and resuming.

## Acceptance traceability

| ID | Machine-testable rule | Evidence |
| --- | --- | --- |
| S4-AC-01 | Repeated compilation on the same branch produces the same bounded prompt, exact spans/back-references, and digest without writing history. | `packages/store/test/context.test.ts` RP-001 determinism test. |
| S4-AC-02 | A 1,000-claim project yields a deterministic goal-specific context within entry and character limits. | Context scale test builds 1,000 canonical claims and selects the lexical target without embeddings. |
| S4-AC-03 | Only current branch-visible versions are selected; relevant open failures are prioritized and secret-like content is redacted. | Context branch, negative-context, and redaction tests. |
| S4-AC-04 | Adapter descriptors and responses are provider-neutral and strictly typed; an ungranted provider capability is denied before invocation or canonical write. | `packages/store/src/model.ts`; coordinator provider-denial test. |
| S4-AC-05 | A turn records exact context, adapter, permissions, structured action, usage, and promotes proposals only as unreviewed objects on the workstream branch. | RP-001 coordinator proposal/provenance test. |
| S4-AC-06 | Model tool requests use `WorkstreamRuntime.executeTool`, and completion requests use executable policy rather than model prose. | Coordinator tool and failed-completion tests. |
| S4-AC-07 | Steering is consumed in order; checkpoints and structured escalations are durable, and escalation pauses the workstream. | Coordinator steering/checkpoint and escalation tests. |
| S4-AC-08 | Budget or repeated-action excess blocks before action; same-session turns serialize; pause is linearized against direct actions; interrupted tools remain resumable; incomplete durable turns recover without replay. | Coordinator budget, loop, pause-race, tool-interruption, concurrency, and recovery tests. |
| S4-AC-09 | RP-001 can compile context and run a steered scripted turn entirely through JSON CLI commands, then pass project verification. | Stage 4 case in `packages/cli/test/cli.test.ts`. |

Run the complete gate with:

```bash
pnpm run check
```

## Honest boundaries

- No live OpenAI, Anthropic, local-server, or other network model adapter is
  included. The scripted adapter proves the contract and provider swap, not
  `DOD-AGENT-06` in full.
- There is no planner, scheduler daemon, background queue, cross-process lease,
  or transactional whole-turn commit. Project writes retain their individual
  append-only atomic boundaries.
- Abort is cooperative. An adapter that ignores its signal cannot be forcibly
  terminated by this process.
- Provider-reported usage is checked and persisted; the request supplies
  remaining limits, but an external provider must itself enforce its hard
  generation/spend cap.
- Secret-like project content is defensively redacted, but Stage 4 is not a
  credential broker or general data-loss-prevention system. Secrets still must
  not be written into canonical project state.
- Typed model actions are proposals, not mathematical verification. There is no
  automatic merge, publication, OS/container sandbox, remote compute, or UI.

## Next useful slice

Add separately packaged live adapters behind the same contract, with
out-of-project credential handling, hard provider-side output/spend limits, and
conformance tests. Enforceable local containers and remote compute remain a
separate execution-fabric slice.
