# ADR-0004: Branch-Scoped Agent Runtime with Hard Gates

Status: **Accepted**  
Date: 2026-08-14

## Context

Long-running mathematical work is exploratory and frequently fails. Agents can
hallucinate shortcuts, prematurely declare success, overwrite useful state, or
converge with reviewers on a plausible error.

## Decision

Agents execute as resumable jobs within explicit workstream contracts:

- goal and context;
- isolated branch;
- allowed tools and capabilities;
- resource budgets;
- completion policy;
- escalation and termination rules.

Project coordinators organize goals and workstreams. Specialist agents perform
bounded work. Agents communicate through recorded messages and project objects,
not an unstructured shared transcript.

Workstream completion is evaluated by executable gates. Agent or reviewer text
cannot set completion directly. Failures and unresolved reviewer loops are
durable outcomes.

## Consequences

- Parallel work can proceed without corrupting accepted state.
- Users can steer, pause, compare, and merge workstreams.
- Scheduler, branch, permission, and event semantics are core infrastructure.
- Reviewer independence and loop detection must be measurable rather than
  prompt-only conventions.

## Rejected alternatives

- **Single autonomous agent:** poor parallelism, oversight, and specialization.
- **Unstructured swarm chat:** difficult to audit and impossible to reproduce.
- **Agents editing accepted state directly:** unsafe and hard to review.
- **Reviewer approval as the only gate:** susceptible to false consensus.

