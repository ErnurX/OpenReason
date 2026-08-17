# ADR-0007: Stage 3 Typed Tool and Workstream Runtime

Status: **Accepted**  
Date: 2026-08-14

## Context

Stages 1 and 2 established canonical project history, isolated branches,
reasoning services, and executable completion policies. They did not execute a
workstream or mediate a tool call. The first runtime must make authorization,
budgets, cancellation, and provenance testable without coupling project meaning
to a model provider, transport, or daemon.

ADR-0004 and ADR-0005 describe the complete direction. Stage 3 implements a
bounded local slice of those decisions.

## Decision

### Typed tools

A tool has a serializable contract containing schemas from a closed,
explicitly validated JSON Schema subset for its input and output, required
capabilities, declared side effects, determinism, timeout and cancellation
behavior. Unsupported schema keywords are rejected instead of ignored. A
registry resolves a tool by stable ID and dispatches it through an adapter;
Stage 3 supplies an in-process adapter. The runtime applies one mandatory
provenance envelope to all registered tools rather than trusting each handler
to invent its own lineage format.

Before a handler runs, the dispatcher validates its input and checks the
workstream's explicit tool allowlist, capability grants, remaining finite
budget, and lifecycle state. It validates the result before making it durable.
Timeout and cancellation are cooperative through an abort signal. A model's
request to call a tool is never authorization.

### Branch-scoped workstreams

A workstream contract binds a goal to a dedicated child branch and declares
its tools, capabilities, finite call-count, wall-time, artifact-byte, and cost
budgets, plus its completion policy. Independent workstreams may execute
concurrently because their project writes remain branch scoped.

Lifecycle transitions support start, pause, resume, and cancel. Workstream
creation and tool calls commit durable environment, run, artifact, and failure
provenance through the existing typed project objects and append-only events.
A successful handler does not complete a workstream: the existing
completion-policy evaluator alone decides whether the completion gate passes.

The runtime stores enough canonical lifecycle and run state to identify a call
left active by process interruption. Recovery converts such a call into an
explicit durable interrupted outcome before the workstream continues; it does
not pretend that an in-process handler itself resumed.

### Authorization and execution boundary

Stage 3 authorization is a deny-by-default dispatcher check. It prevents a
registered handler from being invoked through this runtime without the declared
grant, but it is not an operating-system security boundary. Tool handlers run
in the application process and could exceed their declaration if they are
malicious or buggy. Therefore Stage 3 is suitable only for trusted handlers.

The runtime remains a modular-monolith service. Its multi-event orchestration
assumes one canonical writer; individual appends retain their existing atomic
boundary, but a whole tool invocation is not one database transaction.

## Consequences

- Tool requests and results are schema checked and provider neutral.
- Authorization, budgets, lifecycle, failures, and completion are inspectable
  instead of prompt conventions.
- Concurrent isolated investigations can retain committed results even when
  another workstream pauses, fails, or is cancelled.
- Interrupted local calls become visible negative history rather than an
  implicit success or disappearing trace.
- A later execution fabric must add enforceable process/container isolation,
  filesystem and network controls, resource limits, and remote adapters without
  changing the canonical tool model.

## Stage 3 boundary

Stage 3 does not include a model reasoning loop, scheduler daemon, remote
compute, container sandbox, secret broker, interactive kernel, UI, or automatic
merge into accepted state. It does not make untrusted code safe. General
multi-writer coordination and transactionally atomic run orchestration remain
future work.

## Rejected alternatives

- **Granting every registered tool:** registration describes availability, not
  authority.
- **Treating JSON Schema as a sandbox:** validation constrains data shape, not
  handler behavior.
- **Letting handlers set completion:** violates the executable-gate invariant.
- **Writing workstream results to the accepted branch:** breaks branch
  isolation and human merge authority.
- **Erasing interrupted or cancelled runs:** loses auditability and negative
  results.
