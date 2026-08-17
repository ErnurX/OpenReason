# Project instructions

These instructions apply to the entire repository.

## Sources of truth

Before changing product behavior or architecture, read:

1. `docs/product/product-contract.md`
2. `docs/product/definition-of-done.md`
3. `docs/architecture/invariants.md`
4. the relevant ADRs in `docs/architecture/adr/`

If implementation pressure conflicts with an invariant, do not silently weaken
the invariant. Add or amend an ADR and make the trade-off explicit.

## Engineering rules

- Keep the canonical project format open, portable, and independent of any
  database index or model provider.
- Treat chat messages and model outputs as proposals until promoted into typed
  project objects.
- Never use an LLM's confidence or reviewer agreement as proof of correctness.
- Every durable artifact must have provenance and a content hash.
- Every execution must declare its inputs, environment, permissions, and
  nondeterminism.
- Agents work in isolated project branches and cannot publish or merge to the
  accepted branch without an explicit policy decision.
- Preserve failed workstreams and negative results as first-class records.
- Prefer a modular monolith and typed interfaces over premature microservices.
- Add tests against at least one reference project for every cross-cutting
  product capability.
- Keep provider-specific behavior behind adapters.

## Documentation

- Architectural changes require an ADR.
- User-visible completion states must have machine-testable acceptance rules.
- Use stable identifiers for invariants, Definition-of-Done requirements, and
  reference-project assertions so tests can refer to them.

