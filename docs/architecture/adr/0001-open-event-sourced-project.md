# ADR-0001: Open Event-Sourced Canonical Project

Status: **Accepted**  
Date: 2026-08-14

## Context

Research projects must survive provider changes, offline use, crashes, branch
merges, audits, and publication. A database-only model or hosted conversation
cannot provide that portability and history.

## Decision

The canonical project is an open directory containing:

- a versioned manifest;
- append-only event segments;
- ordinary research files;
- content-addressed artifacts;
- pinned environment descriptions.

SQLite, full-text search, embeddings, and graph projections are derived caches.
They may be deleted and rebuilt.

Durable objects and versions use stable opaque IDs. Corrections append events
and superseding versions rather than rewriting history.

## Consequences

- Portability and auditability are available without a server.
- Time travel and crash recovery have a uniform source of truth.
- Event and migration schemas become long-lived public APIs.
- The implementation must support compaction and snapshots without losing
  original audit meaning.
- Git can version ordinary files and snapshots but is not the transactional
  event store.

## Rejected alternatives

- **Chat transcript as project:** loses typed meaning and long-term context.
- **SQLite/PostgreSQL as sole canonical state:** harms portability and durable
  open interchange.
- **Git alone:** poor fit for concurrent fine-grained events and runtime state.
- **Notebook as project:** cannot represent literature, branches, reviews, and
  cross-artifact dependencies reliably.

