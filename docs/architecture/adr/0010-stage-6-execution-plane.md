# ADR-0010: Stage 6 Execution Plane

Status: **Accepted**  
Date: 2026-08-15

## Context

Stage 3 can authorize typed tools and persist their runs, but its trusted
in-process handlers are not a code-execution boundary. Computational research
also needs an exact job definition, input and output lineage, reproducible
reuse, and a target abstraction that does not let local Python or remote SSH
bypass the workstream's permissions and budgets.

## Decision

### Immutable job contract

An execution job is normalized before it is hashed or launched. The normalized
contract fixes the program and arguments, source files, content-addressed
inputs, declared outputs, non-secret environment variables, parameters,
resource requests, network policy, reproducibility class, and optional seed.
Paths are normalized project-relative POSIX paths; absolute/traversing paths,
duplicates, undeclared Python entrypoints, secret-like environment values, and
network-enabled jobs are rejected. This pure preflight runs after tool
authorization but before the runtime reserves a run, so rejected or
secret-bearing raw input never crosses the append-only acceptance boundary.

The job digest is a SHA-256 hash of canonical JSON. An execution-specific
environment object records the normalized job, actual target descriptor,
command, arguments, resource request, isolation declaration, and cache key.
The ordinary Stage 3 run already records the exact tool contract, input,
permissions, timeout, output, usage, and producing environment.

### Targets remain typed tools

Each execution target is exposed as `execution.<target-id>`. Local and remote
execution therefore pass through the existing explicit tool allow-list,
capability subset, cancellation, wall-time, artifact, cost, and branch gates.
Target code cannot publish or merge a branch.

`execution.local` materializes only declared source and CAS input bytes in a
fresh temporary workspace, starts a sanitized process environment, captures
bounded stdout and stderr, and reads only explicitly declared regular-file
outputs. It never inherits arbitrary host environment variables. On macOS the
default required backend uses `sandbox-exec` to deny network, deny process
forks, restrict writable paths to the workspace, and restrict readable paths
to the workspace and required system runtimes. Parent wall timers plus POSIX
CPU and file-size limits terminate overruns. A separately named
`process-only` option exists for tests and explicit development use; it is
marked unsafe and is never selected implicitly.

The macOS backend cannot reliably impose a hard resident-memory limit using
the available platform primitives. `memoryBytes` is retained in the immutable
request and the environment records `memoryLimitEnforced: false`. This is an
explicit incomplete part of `DOD-EXEC-06`, not an inferred guarantee. A
container/cgroup backend is required before claiming hard memory enforcement.

### Remote adapter

`SshExecutionTarget` uses the same normalized contract. The production
`NodeSshTransport` invokes OpenSSH without a local shell, disables forwarding,
ignores ambient SSH config, requires strict host-key checking, uses batch mode,
sends one canonical JSON request on stdin, and accepts one bounded JSON
response bound to the requested job digest. CAS input bytes accompany their
verified digests. The target requires `network.access`, `secrets.read`, and
`compute.remote`; the response must contain exact stdout/stderr artifacts, only
declared outputs, and respect declared log/output byte limits.

The remote worker is a deployment component and must independently enforce its
declared sandbox and environment. Repository tests use an injected transport,
so they prove adapter/protocol conformance, not availability or isolation of a
particular remote host.

### Artifacts and deterministic reuse

Every log and declared output is returned to the Stage 3 runtime, hashed into
the project CAS, and registered with its producing run, exact execution
environment, reproducibility class, and input digests. Non-zero exits and
timeouts are typed execution results with retained logs; the tool invocation
itself remains consumable so an agent can inspect the failure and submit a
corrected job. A CAS digest is materialized only when an artifact registration
is visible through the current branch's fork snapshot; knowing a sibling
branch's digest does not grant access to its bytes.

Only successful `deterministic` and `seeded` jobs are cache candidates. The
cache key binds the complete normalized job, input digests, and target
descriptor, including local interpreter/sandbox binary digests and a
job-specific process-executable digest. A hit must be branch-visible, reads and
verifies the original CAS bytes, and registers new artifact references for the
current run. A `nondeterministic` job always executes. SSH results are not
cached yet because the adapter cannot prove an immutable remote worker image
before dispatch.

### Interactive promotion

Promotion converts an ordered Python transcript into a normal `main.py` job.
Cell IDs, cell hashes, session ID, environment, inputs, outputs, parameters,
resources, and seed become immutable promotion provenance. The promoted job
uses the same validator, digest, target, cache, and artifact paths as a job
written directly.

## Consequences

- A model can request computation without receiving ambient shell authority.
- Local and SSH runs share one canonical provenance and artifact model.
- Successful exact jobs can be reused without trusting a mutable cache index.
- Failed code and logs remain available for a later corrective turn.
- Stage 6 has no persistent notebook kernel, package resolver, Linux/container
  backend, Slurm scheduler, remote worker distribution, hard local memory
  control, or automatic promotion of an artifact into an accepted evidence
  claim. Those boundaries remain explicit.

## Rejected alternatives

- **Raw shell text as model input:** hides files, resources, outputs, and
  reproducibility and makes authorization too coarse.
- **A separate execution permission system:** would let compute drift from the
  workstream's canonical authority and budgets.
- **Caching by command string:** omits inputs, environment, seed, and target.
- **Claiming memory isolation from a recorded limit:** declaration is not
  enforcement.
- **Persisting ambient process environment:** risks secret leakage and makes a
  replay depend on undeclared host state.
