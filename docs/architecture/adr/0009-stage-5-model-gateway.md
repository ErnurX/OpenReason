# ADR-0009: Stage 5 Model Gateway

Status: **Accepted**  
Date: 2026-08-15

## Context

Stage 4 defines a provider-neutral model turn but ships only a deterministic
scripted adapter. Real providers add network access, credentials, variable
pricing, provider-specific response envelopes, and configuration drift. Those
concerns must not leak into canonical research semantics or let a remote model
bypass workstream capabilities and budgets.

## Decision

### Live adapters behind the Stage 4 contract

The store ships three HTTP adapters implementing the existing `ModelAdapter`
interface:

- OpenAI Responses with JSON-Schema structured output;
- Anthropic Messages with one forced `submit_reasoning_action` tool call;
- OpenAI-compatible Chat Completions for Gemini compatibility endpoints,
  Ollama, vLLM, and other compatible servers.

The provider envelope is converted into exactly one canonical `ModelAction`
and then checked by the provider-independent Stage 4 validator. Provider prose,
malformed JSON, unexpected action fields, and secret-like output are rejected.
The adapters use native `fetch`; provider SDK state and provider conversation
IDs are not project dependencies.
Provider-native tools, MCP, background jobs, conversation continuation,
multi-choice generation, and automatic truncation are reserved fields rather
than free configuration: they would create untracked effects or hide the exact
input boundary. Tools requested by a model still run only through Stage 3.

### Credential boundary and network safety

Configuration contains an opaque `credentialRef`, such as
`env:OPENAI_API_KEY`, never a credential value. Resolution happens only when a
call is about to be sent. The default resolver supports environment references;
other secret stores can implement the same callback. Descriptors, model turns,
event history, exports, errors, and capability profiles retain only the
reference.

External calls require `network.access`; credential-bearing calls also require
`secrets.read`; OpenAI, Anthropic, and paid compatible endpoints additionally
require `spend`. Authorization is still performed by the workstream before any
canonical model-turn write. Redirects are rejected so an authorization header
cannot follow a provider redirect. Vendor endpoints require HTTPS; plain HTTP
is accepted only for loopback compatible servers. HTTP error bodies are not
copied into durable-facing errors, and response bodies have a byte limit.

### Output and spend limits

The remaining Stage 4 output-token budget is sent as the provider's hard output
limit. For paid calls, declared token prices reserve estimated input spend and
reduce the output limit to what fits both the session limit and the shared
workstream cost budget. A call that cannot fit is rejected before credential
resolution or network access. Actual provider usage is converted with integer
micro-unit arithmetic, charged to the workstream through an idempotent model-turn
ledger, and checked again before an action is applied. Recovery can reconcile a
durable response without charging the same turn twice.

Prices are explicit configuration, not mutable built-in vendor facts. This
makes a recorded turn auditable but means operators must keep their price
declarations current. Stage 5 uses USD micro-units, matching the existing
workstream cost ledger; multi-currency conversion is outside this stage. Exact
input spend cannot be guaranteed before a provider
tokenizes the request; the preflight uses the compiled context estimate and the
postflight records actual reported usage.

### Capability registry and deterministic routing

A capability profile declares context/output limits, modalities, structured
output, tool-use support, per-task strengths, expected latency, pricing, and a
privacy class. The gateway filters on hard context, modality, privacy, tool,
output, and cost constraints, then deterministically ranks eligible models by
explicit quality/cost/latency weights with adapter ID as the tie-breaker.

Profiles are operator declarations, not proof of a provider's privacy policy or
quality. Routing does not grant capabilities and does not mutate a project. A
chosen adapter is still bound into the agent session descriptor and rechecked
on every step.

### Usage inspection

Token, call, failure, cost, and latency reports are derived from branch-visible
canonical `model-turn` run objects. They can be rebuilt without provider access.
Invocation latency is recorded on completed and failed turns; older turns fall
back to their start/finish timestamps.

## Consequences

- One coordinator can use OpenAI, Anthropic, or a local/compatible model without
  changing project semantics.
- Provider credentials remain deployment state rather than portable project
  state.
- Model choice and declared economics are inspectable before a call.
- Third-party adapters can continue implementing `ModelAdapter` without
  modifying the coordinator.
- The test suite exercises all protocols with injected HTTP transports and a
  complete RP-001 coordinator turn without requiring paid credentials.

The implemented request shapes follow the official
[OpenAI Responses API](https://platform.openai.com/docs/api-reference/responses/create),
[Anthropic Messages/tool-use API](https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/overview),
and [Gemini OpenAI compatibility API](https://ai.google.dev/gemini-api/docs/openai).

## Stage 5 boundary

Stage 5 includes production HTTP request/response adapters, but CI does not call
real vendor accounts. It therefore proves protocol conformance against mocked
transports, not account availability, current vendor pricing, model quality, or
vendor privacy claims. There is no retry layer because an automatic retry can
duplicate spend or provider-side effects. There is also no secret broker UI,
organization-wide quota service, scheduler, OS sandbox, remote execution plane,
automatic model fallback, or accepted-state merge.

`DOD-AGENT-06` is implemented at the adapter and conformance-contract level for
two external protocols and one local/OpenAI-compatible protocol; a deployment
must still run its own live credential acceptance checks before claiming those
accounts operational.

## Rejected alternatives

- **Persisting API keys in adapter JSON:** violates the secret-state invariant and makes
  exports unsafe.
- **Using a provider SDK object as canonical state:** violates portability and
  provider replaceability.
- **Letting routing silently grant network or spend:** bypasses workstream
  authority.
- **Trusting structured-output mode without local validation:** couples project
  safety to a remote implementation detail.
- **Baking current vendor prices into source:** creates silently stale cost
  provenance.
