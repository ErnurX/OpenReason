# ADR-0005: Typed Tools and Sandboxed Execution

Status: **Accepted**  
Date: 2026-08-14

## Context

Research agents must execute code, invoke proof assistants and CAS systems,
query literature, and submit remote compute. Raw shell access is flexible but
does not adequately describe permissions, outputs, determinism, or provenance.

## Decision

Every first-class tool exposes a machine-readable contract for:

- input and output schemas;
- required capabilities;
- side effects;
- determinism or nondeterminism;
- cancellation and timeout behavior;
- expected artifacts;
- provenance obligations;
- optional verifier.

Tools may be transported through CLI, HTTP, MCP, LSP, Jupyter kernels, or native
SDKs. Transport adapters map them into the canonical tool contract.

Agent-generated code executes inside enforceable local containers or remote job
environments with scoped filesystems, networks, secrets, resources, and time.

## Consequences

- Completion gates can reason over structured tool results.
- Plugins can be tested for provenance and permission compliance.
- Simple shell operations require an adapter or an explicitly unstructured run
  record.
- Local container support becomes an early platform dependency.
- Remote SSH/Slurm jobs share the same run and artifact model as local jobs.

## Rejected alternatives

- **Raw shell as the primary API:** side effects and result meaning are opaque.
- **MCP as the entire internal model:** useful transport, insufficient canonical
  semantics for determinism, evidence, and compute jobs.
- **Trusting application-level permission prompts as a sandbox:** not an
  enforceable security boundary.

