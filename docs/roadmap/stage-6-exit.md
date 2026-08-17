# Stage 6 Exit — Execution Plane

Status: **Complete for the agreed Stage 6 slice**  
Date: 2026-08-15

Stage 6 adds an immutable compute path without creating a second authority
system. The whole-product execution Definition of Done is not yet fully closed:
the explicit limitations below remain visible rather than being counted as
implemented guarantees.

## Acceptance criteria

| ID | Criterion | Evidence |
|---|---|---|
| S6-AC-01 | Jobs normalize to one canonical, hashable contract and reject traversal, undeclared entrypoints, embedded secrets, invalid seeds, and network access. | `execution.test.ts`: immutable job validation and digest test. |
| S6-AC-02 | Local Python/process execution uses a fresh workspace, sanitized environment, cancellation, wall/CPU/output policy, and declared-only capture. | `LocalExecutionTarget` plus success and timeout tests. |
| S6-AC-03 | stdout, stderr, and declared outputs become CAS artifacts with producing run, exact environment, reproducibility, and branch-visible input-digest lineage. | RP-001 execution, derived-input, sibling-denial, and `verifyProject` tests. |
| S6-AC-04 | Deterministic and seeded cache identity binds job, inputs, and target; a hit verifies CAS bytes and remains a new auditable run. | RP-001 first-run/cache-hit digest equivalence test. |
| S6-AC-05 | Nondeterministic jobs are not cacheable. | RP-001 repeated nondeterministic-job regression test. |
| S6-AC-06 | Interactive Python cells promote to the ordinary immutable job format with cell/session provenance. | transcript-promotion unit and CLI tests. |
| S6-AC-07 | One SSH target maps the same job and CAS inputs to a bounded JSON worker protocol and validates exact remote outputs. | injected transport conformance test. |
| S6-AC-08 | Execution remains behind named tool and capability gates and charges ordinary workstream run/artifact budgets. | RP-001 runtime integration and CLI workstream test. |
| S6-AC-09 | An agent can observe a failed Python result, retain its logs, submit corrected code, and capture a figure. | scripted coordinator two-turn failure/correction test. |
| S6-AC-10 | Users can inspect, promote, list, and run jobs from the CLI. | Stage 6 CLI integration test. |

## Public surface

- `normalizeExecutionJob`, `executionJobDigest`, and `ExecutionJobSpec`;
- `LocalExecutionTarget`, `SshExecutionTarget`, and `NodeSshTransport`;
- `ExecutionTargetRegistry`, `createExecutionTool`, and
  `createExecutionToolRegistry`;
- `promoteInteractiveTranscript`;
- `rw execution inspect|promote|run|targets`;
- `execution.local` in the default CLI/agent tool registry.

## Definition-of-Done mapping

- `DOD-EXEC-01`: implemented for transcript-to-job promotion.
- `DOD-EXEC-02`: exact job, permissions, resources, parameters, seed, logs,
  outputs, and environment are durable.
- `DOD-EXEC-03`: outputs use the existing verified SHA-256 CAS.
- `DOD-EXEC-04`: successful deterministic/seeded runs are reusable.
- `DOD-EXEC-05`: local target plus SSH adapter/protocol are implemented; CI
  does not claim a live remote worker.
- `DOD-EXEC-06`: filesystem, network, process-fork, wall time, CPU, logs, and
  output size have an enforceable macOS backend. Hard resident-memory control
  and non-macOS secure local execution remain incomplete.

## Explicit boundaries

- The required local sandbox currently targets macOS. A nested host sandbox
  may refuse `sandbox-exec`; execution then fails closed before claiming an
  isolated result.
- `--unsafe-process-only` is an explicit CLI development/testing escape hatch
  and does not satisfy the sandbox acceptance boundary.
- `memoryBytes` is recorded but not hard-enforced locally.
- SSH tests use an injected worker response; deployment owns worker install,
  authentication, host-key policy, and remote isolation acceptance.
- SSH results are not reused until a future remote-worker contract can bind an
  immutable image/environment digest before dispatch.
- There is no persistent Jupyter kernel, package lock/resolver, container image
  builder, Slurm scheduler, or automatic environment provisioning.
- Job artifacts are attached to their run. Turning a figure into accepted
  claim evidence and transcluding it into a working paper belongs to Stage 7.

## Next useful slice

Stage 7 should build the living working paper and deeper reasoning-graph view:
claim transclusion, sections/equations/citations, verification profiles,
assumption-scoped impact warnings, artifact-to-evidence promotion, and semantic
branch comparison.

## Verification

`pnpm run check` passes: TypeScript, checked-in schemas, 16 Vitest files with
121 tests, and the Stage 0 contract/link/stable-ID validator (29 Markdown
files, 36 local links, and 109 stable-ID definitions).
