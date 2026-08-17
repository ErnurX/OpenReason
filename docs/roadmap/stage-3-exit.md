# Stage 3 Exit

Date: 2026-08-14  
Status: **Implemented and testable**

## Exit statement

Stage 3 adds a local runtime for trusted typed tools and branch-scoped
workstreams. Calls are schema checked and deny-by-default, spend finite
budgets, and produce canonical run provenance. Workstreams can execute in
parallel on isolated branches, be paused/resumed/cancelled, recover interrupted
runs, and complete only through the Stage 2 policy engine.

This is an orchestration kernel, not a model agent loop or secure compute
sandbox.

## Delivered

- Serializable tool contracts with a closed JSON Schema subset for input/output
  validation, capabilities, side-effect declarations, determinism,
  cancellation, and default timeouts. Unsupported keywords fail registration.
- A deterministic registry and in-process adapter for trusted handlers, plus
  small `core.echo`, `core.delay`, and `core.text-artifact` conformance tools.
- Explicit per-workstream tool allowlists and capability grants; authorization
  occurs before handler invocation.
- Dedicated child branches plus canonical `workstream` and `environment`
  objects for every runtime workstream.
- Finite call-count, wall-time, artifact-byte, and cost-micro budgets, checked
  before dispatch where possible and before artifact persistence on result.
- Canonical `run` versions, content-addressed artifact registration, and open
  `failure` objects for invalid results, handler errors, timeouts, budget
  violations, and recovered interruptions.
- Pause, resume, cancellation, policy-gated completion, and recovery that marks
  orphaned active runs `interrupted` and leaves their workstreams paused.
- Concurrent handler execution across independent branch workstreams while
  project mutations remain serialized in-process.
- JSON CLI adapters for tool discovery, workstream creation/inspection,
  execution, lifecycle control, completion, and recovery.

## Acceptance traceability

| ID | Machine-testable rule | Evidence |
| --- | --- | --- |
| S3-AC-01 | A registered contract is serializable; malformed contracts and schema-invalid inputs or outputs are rejected. | `packages/store/src/tools.ts`; `packages/store/test/tools.test.ts` validates the schema subset, contracts, results, and registry. |
| S3-AC-02 | An unlisted tool or missing capability is denied before its handler runs. | `authorizeTool`; the authorization runtime test observes zero run objects and unchanged call usage. |
| S3-AC-03 | A workstream owns a distinct child branch, explicit environment, finite budget, and policy; execution does not mutate its base branch. | `createWorkstream`; `packages/store/test/runtime.test.ts` checks branch/environment ownership. |
| S3-AC-04 | Successful calls record validated output and hashed artifacts against exact run/environment IDs; schema, handler, timeout, and budget failures remain durable. | `WorkstreamRuntime.executeTool`; runtime provenance, schema-cleanup, explicit timeout, lifecycle, and pre-CAS budget tests. |
| S3-AC-05 | At least three workstreams can have handlers in flight concurrently without sharing a branch. | Runtime concurrency test observes `maximumActive === 3` and three branch IDs. |
| S3-AC-06 | Pause/cancel abort the active call path, committed records remain, and resume permits later calls without resetting usage. | Runtime lifecycle test records `interrupted` and `cancelled` run states. |
| S3-AC-07 | Recovery changes persisted `reserved`/`running` runs to `interrupted`, creates open failures, and pauses the owning workstreams. | Runtime recovery test for `recoverInterruptedRuns`. |
| S3-AC-08 | `completed` is written only from a passing stored completion-policy evaluation. | Runtime completion test plus `packages/store/test/policy.test.ts`. |
| S3-AC-09 | Every delivered Stage 3 operation has a JSON CLI path. | `packages/cli/src/index.ts`; the Stage 3 CLI integration test covers discovery, create, lifecycle, calls, provenance, completion, list, recovery, and verification. |

Run the complete gate with:

```bash
pnpm run check
```

## Honest boundaries

- Authorization is enforced by the dispatcher, not by the OS. Handlers execute
  in the same process and must be trusted; side-effect declarations are
  auditable metadata, not containment. This does **not** satisfy
  `DOD-EXEC-06` for untrusted code.
- Timeout, pause, and cancel signal an `AbortSignal` and stop waiting for the
  call. They cannot forcibly terminate a handler that ignores cancellation.
- There is no model-provider loop, planner, scheduler daemon, background queue,
  remote compute, container, secret broker, interactive kernel, or UI.
- Completion uses the current structural policy predicates. It does not imply
  proof, reproduction, citation verification, or scientific correctness.
- Runtime orchestration spans several canonical events. Mutations are
  single-writer/in-process serialized, but a complete call is not an atomic
  transaction and cross-process scheduling has no lease protocol.
- Recovery records interruption; it does not continue a handler from its
  instruction pointer or prove that an ignored handler stopped externally.
- Agents still cannot merge their branch into accepted state automatically.

## Next useful slice

Add a real model/coordinator adapter only after context compilation and steering
messages are typed. Enforceable local containers and one remote compute adapter
should remain a separate execution-fabric slice so their security guarantees
are testable rather than implied by this dispatcher.
