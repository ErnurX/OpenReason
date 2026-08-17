# Stage 5 Exit — Model Gateway

Status: **Complete**  
Date: 2026-08-15

Stage 5 closes the live-provider gap left by Stage 4 without changing canonical
research semantics. Acceptance is protocol-level and uses injected HTTP
transports; no paid account is contacted by the repository test suite.

## Acceptance criteria

| ID | Criterion | Evidence |
|---|---|---|
| S5-AC-01 | OpenAI Responses maps bounded context to one validated typed action. | `providers.test.ts`: structured request, output cap, usage and cost. |
| S5-AC-02 | Anthropic Messages maps a forced tool-use response to the same action contract. | `providers.test.ts`: headers, forced tool schema and action validation. |
| S5-AC-03 | A credential-free loopback OpenAI-compatible model uses the same coordinator contract. | `providers.test.ts`: local Chat Completions request and normalized action. |
| S5-AC-04 | Credential values cannot enter descriptors, errors, event history, or exports through supported configuration. | Opaque-reference validation, secret scanning, body-free HTTP errors, and gateway/provider regression tests. |
| S5-AC-05 | Network, secret, and spend capabilities remain deny-by-default. | Adapter descriptors declare exact capabilities; Stage 4 authorization runs before the model-turn write. |
| S5-AC-06 | Remaining output and both session/workstream cost budgets constrain a call before credential or network access; actual cost is charged idempotently. | Provider exact-cap test plus RP-001 gateway test for global cap, workstream charge, and duplicate-charge rejection. |
| S5-AC-07 | Model profiles can be filtered and deterministically ranked by task, modality, context, privacy, cost, and latency. | `gateway.test.ts`: quality route, local-only route, and no-candidate rejection. |
| S5-AC-08 | Calls, statuses, tokens, cost, and latency are reconstructed from branch-visible model-turn objects. | `gateway.test.ts`: deterministic RP-001 usage aggregation. |
| S5-AC-09 | A live-protocol adapter traverses the ordinary RP-001 coordinator, capability, provenance, and checkpoint path. | `gateway.test.ts`: mocked OpenAI HTTP turn with secret-absence assertion. |
| S5-AC-10 | CLI users can inspect config, route profiles, attach live adapters to sessions, and inspect usage. | `cli.test.ts`: Stage 5 end-to-end CLI case. |

## Public surface

- `OpenAIResponsesAdapter`, `AnthropicMessagesAdapter`, and
  `OpenAICompatibleAdapter`;
- `CredentialResolver`, `environmentCredentialResolver`, `TokenPricing`,
  `calculateModelCost`, and `providerOutputTokenLimit`;
- `createConfiguredModel` and strict JSON configuration parsing;
- `ModelGatewayRegistry.route` and serializable capability profiles;
- `inspectModelUsage` for branch-derived accounting;
- `rw models inspect`, `rw models route`, and `rw models usage`;
- `rw agent create|step|run --model-config-file ...`.

## Explicit boundaries

- Vendor calls in tests are mocked; a deployment owns live account checks.
- Pricing, latency, strength, and privacy profiles are explicit operator
  declarations and may become stale.
- Cost profiles and the workstream ledger currently use USD micro-units only;
  there is no foreign-exchange service.
- Input cost uses the compiler's token estimate before invocation; actual
  provider usage is enforced and persisted after invocation.
- No automatic retry/fallback, key-management UI, global quota service,
  scheduler, sandbox, remote execution, or automatic merge exists yet.
- OpenAI-compatible structured-output support varies by server; conformance must
  be checked for the selected deployment.

## Next useful slice

Stage 6 should implement the execution plane: immutable job specifications,
local Python/process execution with enforceable limits, deterministic caching,
interactive-to-immutable promotion, and one remote target adapter. Model tools
must continue to enter that plane through the existing capability and
workstream gates.

## Verification

`pnpm run check` passes: TypeScript, checked-in schemas, 15 Vitest files with
114 tests, and the Stage 0 contract/link/stable-ID validator.
