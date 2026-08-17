# ADR-0002: Local-First Modular Monolith

Status: **Accepted**  
Date: 2026-08-14

## Context

The product needs desktop interactivity, scientific Python, local files,
background agents, optional servers, and remote compute. Premature
microservices would slow iteration and complicate local deployment.

## Decision

Build a local-first modular monolith with explicit package boundaries:

- Tauri desktop shell;
- React/TypeScript user interface;
- TypeScript/Bun control plane and APIs;
- Python scientific workers;
- SQLite local projection store;
- filesystem content-addressed storage;
- optional PostgreSQL, object storage, and job services for collaborative
  deployments.

Modules communicate through typed internal contracts that can later cross
process boundaries without changing project semantics.

## Consequences

- A complete single-user installation can run on one machine.
- Most features can be developed and tested without cloud infrastructure.
- Python remains native for science while orchestration and UI share types in
  TypeScript.
- Hosted scale can extract services only after measured need.
- Tauri introduces a Rust build dependency, but core product logic does not
  initially require a separate Rust service.

## Rejected alternatives

- **Microservices from the start:** excessive operational and schema overhead.
- **Browser-only SaaS:** weak local/HPC integration and provider dependence.
- **Python-only desktop/UI:** slower rich-interface iteration and weaker shared
  type contracts.
- **Electron as default:** acceptable fallback, but Tauri better fits a
  local-first scientific desktop footprint.

