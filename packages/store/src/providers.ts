import {
  canonicalJson,
  computeContentHash,
  type JsonValue,
} from "@reasoning-workbench/project-format";

import { redactSecretText, redactSecretValue } from "./context.js";
import {
  assertModelAction,
  assertModelAdapterDescriptor,
  validateModelResponse,
  type ModelAction,
  type ModelAdapter,
  type ModelAdapterDescriptor,
  type ModelInvocationContext,
  type ModelRequest,
  type ModelResponse,
} from "./model.js";
import type { ToolCapability } from "./tools.js";

export interface TokenPricing {
  /** Micro-units of the configured currency per one million input tokens. */
  readonly inputMicrosPerMillionTokens: number;
  /** Micro-units of the configured currency per one million output tokens. */
  readonly outputMicrosPerMillionTokens: number;
  /** Stage 3 workstream costMicros currently uses USD as the project currency. */
  readonly currency: "USD";
}

export type CredentialResolver = (
  credentialRef: string,
  context: { readonly signal: AbortSignal },
) => string | Promise<string>;

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export class ModelProviderError extends Error {
  public constructor(
    message: string,
    public readonly code:
      | "credential-unavailable"
      | "budget-exhausted"
      | "request-failed"
      | "http-error"
      | "response-too-large"
      | "invalid-response",
    public readonly status?: number,
    public readonly providerRequestId?: string,
  ) {
    super(message);
    this.name = "ModelProviderError";
  }
}

export interface BaseHttpAdapterOptions {
  readonly adapterId: string;
  readonly model: string;
  readonly pricing: TokenPricing;
  readonly maxContextTokens: number;
  readonly maxOutputTokens: number;
  readonly endpoint?: string;
  readonly parameters?: Readonly<Record<string, JsonValue>>;
  readonly fetch?: FetchLike;
  readonly resolveCredential?: CredentialResolver;
  readonly maxResponseBytes?: number;
}

export interface OpenAIResponsesAdapterOptions extends BaseHttpAdapterOptions {
  readonly credentialRef: string;
}

export interface AnthropicMessagesAdapterOptions extends BaseHttpAdapterOptions {
  readonly credentialRef: string;
  readonly anthropicVersion?: string;
}

export interface OpenAICompatibleAdapterOptions extends BaseHttpAdapterOptions {
  readonly credentialRef?: string;
  /** Remote compatible APIs that may charge must explicitly declare this. */
  readonly paid?: boolean;
  readonly maxTokensField?: "max_tokens" | "max_completion_tokens";
  readonly provider?: string;
}

const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
const MICROS_PER_UNIT = 1_000_000n;
const ACTION_FORMAT_NAME = "reasoning_workbench_action";
const SUBMIT_ACTION_TOOL = "submit_reasoning_action";

/**
 * Transport schema is deliberately broader than the canonical validator. It
 * guides providers toward one action while assertModelAction remains the
 * authoritative, provider-independent boundary.
 */
export const MODEL_ACTION_JSON_SCHEMA = {
  type: "object",
  properties: {
    kind: {
      type: "string",
      enum: [
        "tool-call",
        "propose-object",
        "checkpoint",
        "escalate",
        "request-completion",
      ],
    },
    toolId: { type: "string" },
    input: {},
    timeoutMs: { type: ["integer", "null"], minimum: 1 },
    objectType: {
      type: "string",
      enum: [
        "definition",
        "assumption",
        "claim",
        "evidence",
        "source",
        "document",
        "alignment",
      ],
    },
    content: { type: "object" },
    contextId: { type: ["string", "null"] },
    summary: { type: "string" },
    nextSteps: { type: "array", items: { type: "string" } },
    evidenceObjectIds: { type: "array", items: { type: "string" } },
    attemptedApproaches: { type: "array", items: { type: "string" } },
    blocker: { type: "string" },
    requestedHumanInput: { type: "string" },
    rationale: { type: "string" },
  },
  required: ["kind"],
} as const satisfies Readonly<Record<string, JsonValue>>;

const SYSTEM_INSTRUCTION = [
  "You are one reasoning step inside Reasoning Workbench.",
  "Return exactly one structured action matching the supplied JSON Schema.",
  "Do not claim that prose, confidence, or consensus proves a result.",
  "A completion request is only a request; executable policy decides success.",
].join(" ");
const ACTION_SCHEMA_DIGEST = computeContentHash(
  MODEL_ACTION_JSON_SCHEMA as unknown as Record<string, unknown>,
);
const SYSTEM_INSTRUCTION_DIGEST = computeContentHash({
  text: SYSTEM_INSTRUCTION,
});

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function nonNegativeSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return Number(value);
}

export function assertTokenPricing(value: TokenPricing): void {
  nonNegativeSafeInteger(
    value.inputMicrosPerMillionTokens,
    "pricing.inputMicrosPerMillionTokens",
  );
  nonNegativeSafeInteger(
    value.outputMicrosPerMillionTokens,
    "pricing.outputMicrosPerMillionTokens",
  );
  if (value.currency !== "USD") {
    throw new TypeError("pricing.currency must be USD");
  }
}

function assertSafeJson(value: unknown, label: string): void {
  try {
    canonicalJson(value);
  } catch (error) {
    throw new TypeError(
      `${label} must be JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (canonicalJson(redactSecretValue(value)) !== canonicalJson(value)) {
    throw new TypeError(`${label} contains secret-like material`);
  }
}

function normalizedParameters(
  parameters: Readonly<Record<string, JsonValue>> | undefined,
  reservedKeys: readonly string[],
): Readonly<Record<string, JsonValue>> {
  const result = structuredClone(parameters ?? {});
  assertSafeJson(result, "provider parameters");
  for (const key of reservedKeys) {
    if (Object.hasOwn(result, key)) {
      throw new TypeError(`provider parameters cannot override ${JSON.stringify(key)}`);
    }
  }
  return result;
}

function endpoint(
  value: string | undefined,
  fallback: string,
  allowLoopbackHttp: boolean,
): string {
  const parsed = new URL(value ?? fallback);
  const loopback =
    parsed.hostname === "localhost" ||
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "[::1]" ||
    parsed.hostname === "::1";
  if (parsed.protocol !== "https:" && !(allowLoopbackHttp && loopback && parsed.protocol === "http:")) {
    throw new TypeError("model endpoint must use HTTPS, except loopback OpenAI-compatible endpoints");
  }
  if (
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0
  ) {
    throw new TypeError("model endpoint cannot contain credentials, query, or fragment");
  }
  if (/(?:^|\/)(?:sk|key|token|bearer)-[A-Za-z0-9._-]{8,}(?:\/|$)/iu.test(parsed.pathname)) {
    throw new TypeError("model endpoint path contains secret-like material");
  }
  return parsed.href;
}

function credentialReference(value: string): string {
  const result = nonEmptyString(value, "credentialRef");
  if (
    result.length > 256 ||
    !/^[a-z][a-z0-9+.-]*:[A-Za-z0-9_./:@-]+$/u.test(result) ||
    /^(?:sk|key|token|bearer)-/iu.test(result)
  ) {
    throw new TypeError(
      "credentialRef must be an opaque scheme reference such as env:OPENAI_API_KEY",
    );
  }
  return result;
}

function maxResponseBytes(value: number | undefined): number {
  const result = value ?? DEFAULT_MAX_RESPONSE_BYTES;
  if (!Number.isSafeInteger(result) || result < 1024 || result > 16 * 1024 * 1024) {
    throw new TypeError("maxResponseBytes must be a safe integer between 1024 and 16777216");
  }
  return result;
}

function positiveTokenLimit(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value;
}

export const environmentCredentialResolver: CredentialResolver = (credentialRef) => {
  const match = /^env:([A-Za-z_][A-Za-z0-9_]*)$/u.exec(credentialRef);
  if (match === null) {
    throw new ModelProviderError(
      `Unsupported credential reference ${JSON.stringify(credentialRef)}`,
      "credential-unavailable",
    );
  }
  const value = process.env[match[1]!];
  if (value === undefined || value.length === 0) {
    throw new ModelProviderError(
      `Credential is unavailable for ${JSON.stringify(credentialRef)}`,
      "credential-unavailable",
    );
  }
  return value;
};

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator;
}

export function calculateModelCost(
  inputTokens: number,
  outputTokens: number,
  pricing: TokenPricing,
): number {
  nonNegativeSafeInteger(inputTokens, "inputTokens");
  nonNegativeSafeInteger(outputTokens, "outputTokens");
  assertTokenPricing(pricing);
  const numerator =
    BigInt(inputTokens) * BigInt(pricing.inputMicrosPerMillionTokens) +
    BigInt(outputTokens) * BigInt(pricing.outputMicrosPerMillionTokens);
  const value = ceilDiv(numerator, MICROS_PER_UNIT);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError("calculated model cost exceeds the safe integer range");
  }
  return Number(value);
}

/** Reserve input spend and cap provider output to the remaining turn budget. */
export function providerOutputTokenLimit(
  request: ModelRequest,
  pricing: TokenPricing,
  requiresSpend: boolean,
): number {
  if (request.limits.remainingOutputTokens <= 0) {
    throw new ModelProviderError("Model output-token budget is exhausted", "budget-exhausted");
  }
  if (!requiresSpend) return request.limits.remainingOutputTokens;
  if (request.limits.remainingCostMicros <= 0) {
    throw new ModelProviderError("Model cost budget is exhausted", "budget-exhausted");
  }
  const budgetNumerator =
    BigInt(request.limits.remainingCostMicros) * MICROS_PER_UNIT;
  const inputNumerator =
    BigInt(request.estimatedInputTokens) *
    BigInt(pricing.inputMicrosPerMillionTokens);
  if (inputNumerator > budgetNumerator) {
    throw new ModelProviderError(
      "Estimated model input exceeds the remaining cost budget",
      "budget-exhausted",
    );
  }
  if (pricing.outputMicrosPerMillionTokens === 0) {
    return request.limits.remainingOutputTokens;
  }
  const affordable =
    (budgetNumerator - inputNumerator) /
    BigInt(pricing.outputMicrosPerMillionTokens);
  const capped = Math.min(
    request.limits.remainingOutputTokens,
    affordable > BigInt(Number.MAX_SAFE_INTEGER)
      ? Number.MAX_SAFE_INTEGER
      : Number(affordable),
  );
  if (capped <= 0) {
    throw new ModelProviderError(
      "No model output token fits the remaining cost budget",
      "budget-exhausted",
    );
  }
  return capped;
}

function configuredOutputTokenLimit(
  request: ModelRequest,
  pricing: TokenPricing,
  requiresSpend: boolean,
  maxContextTokens: number,
  maxOutputTokens: number,
): number {
  const contextRemainder = maxContextTokens - request.estimatedInputTokens;
  const result = Math.min(
    providerOutputTokenLimit(request, pricing, requiresSpend),
    maxOutputTokens,
    contextRemainder,
  );
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new ModelProviderError(
      "Compiled model input leaves no configured context for output",
      "budget-exhausted",
    );
  }
  return result;
}

function promptFor(request: ModelRequest): string {
  const steering = request.steering.length === 0
    ? ""
    : `\n\nSteering decisions:\n${canonicalJson(request.steering)}`;
  return `${request.promptText}${steering}`;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ModelProviderError(`${label} is not an object`, "invalid-response");
  }
  return value as Record<string, unknown>;
}

function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new ModelProviderError(`${label} is not a non-negative integer`, "invalid-response");
  }
  return Number(value);
}

function safeRequestId(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    /[\r\n]/u.test(value) ||
    /^(?:sk|key|token|bearer)-/iu.test(value) ||
    redactSecretText(value) !== value
  ) {
    return undefined;
  }
  return value;
}

function normalizeAction(value: unknown): ModelAction {
  const candidate = structuredClone(record(value, "provider action"));
  if (candidate.kind === "tool-call" && candidate.timeoutMs === null) {
    delete candidate.timeoutMs;
  }
  if (candidate.kind === "propose-object" && candidate.contextId === null) {
    delete candidate.contextId;
  }
  try {
    assertModelAction(candidate);
  } catch {
    throw new ModelProviderError(
      "Provider returned an invalid structured action",
      "invalid-response",
    );
  }
  return candidate;
}

function parseActionText(value: string): ModelAction {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new ModelProviderError(
      "Provider returned malformed structured JSON",
      "invalid-response",
    );
  }
  return normalizeAction(parsed);
}

async function jsonResponse(
  response: Response,
  limit: number,
): Promise<Record<string, unknown>> {
  const requestId = safeRequestId(
    response.headers.get("x-request-id") ??
      response.headers.get("request-id") ??
      undefined,
  );
  if (!response.ok) {
    throw new ModelProviderError(
      `Model provider returned HTTP ${response.status}`,
      "http-error",
      response.status,
      requestId,
    );
  }
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > limit) {
    throw new ModelProviderError(
      "Model provider response exceeded the configured byte limit",
      "response-too-large",
      undefined,
      requestId,
    );
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body?.getReader();
  if (reader !== undefined) {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      total += item.value.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw new ModelProviderError(
          "Model provider response exceeded the configured byte limit",
          "response-too-large",
          undefined,
          requestId,
        );
      }
      chunks.push(item.value);
    }
  }
  const text = Buffer.concat(chunks, total).toString("utf8");
  try {
    return record(JSON.parse(text) as unknown, "provider response");
  } catch (error) {
    if (error instanceof ModelProviderError) throw error;
    throw new ModelProviderError(
      "Model provider returned malformed JSON",
      "invalid-response",
      undefined,
      requestId,
    );
  }
}

async function credential(
  reference: string | undefined,
  resolver: CredentialResolver,
  signal: AbortSignal,
): Promise<string | undefined> {
  if (reference === undefined) return undefined;
  if (signal.aborted) throw signal.reason ?? new Error("Model call aborted");
  try {
    const value = await resolver(reference, { signal });
    if (typeof value !== "string" || value.length === 0) throw new Error("empty credential");
    return value;
  } catch (error) {
    if (signal.aborted) throw signal.reason ?? error;
    throw new ModelProviderError(
      `Credential is unavailable for ${JSON.stringify(reference)}`,
      "credential-unavailable",
    );
  }
}

async function postJson(
  fetcher: FetchLike,
  url: string,
  headers: Readonly<Record<string, string>>,
  body: Readonly<Record<string, unknown>>,
  context: ModelInvocationContext,
  limit: number,
): Promise<Record<string, unknown>> {
  if (context.signal.aborted) {
    throw context.signal.reason ?? new ModelProviderError("Model call aborted", "request-failed");
  }
  let response: Response;
  try {
    response = await fetcher(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: context.signal,
      redirect: "error",
    });
  } catch (error) {
    if (context.signal.aborted) throw context.signal.reason ?? error;
    throw new ModelProviderError(
      "Model provider request failed",
      "request-failed",
    );
  }
  return jsonResponse(response, limit);
}

function descriptor(
  adapterId: string,
  provider: string,
  model: string,
  protocol: string,
  url: string,
  credentialRef: string | undefined,
  pricing: TokenPricing,
  parameters: Readonly<Record<string, JsonValue>>,
  responseLimit: number,
  capabilities: readonly ToolCapability[],
  extra: Readonly<Record<string, JsonValue>> = {},
): ModelAdapterDescriptor {
  const result: ModelAdapterDescriptor = {
    schemaVersion: 1,
    adapterId: nonEmptyString(adapterId, "adapterId"),
    provider,
    model: nonEmptyString(model, "model"),
    version: "1.0.0",
    configuration: {
      protocol,
      endpoint: url,
      ...(credentialRef === undefined ? {} : { credentialRef }),
      pricing: pricing as unknown as JsonValue,
      parameters: parameters as unknown as JsonValue,
      maxResponseBytes: responseLimit,
      systemInstruction: SYSTEM_INSTRUCTION,
      actionSchemaDigest: ACTION_SCHEMA_DIGEST,
      actionSchema: MODEL_ACTION_JSON_SCHEMA,
      systemInstructionDigest: SYSTEM_INSTRUCTION_DIGEST,
      ...extra,
    },
    requiredCapabilities: capabilities,
    reproducibility: "externally-sourced",
  };
  assertModelAdapterDescriptor(result);
  return result;
}

function response(
  action: ModelAction,
  inputTokens: number,
  outputTokens: number,
  pricing: TokenPricing,
  requestId: unknown,
): ModelResponse {
  const providerRequestId = safeRequestId(requestId);
  return validateModelResponse({
    schemaVersion: 1,
    action,
    usage: {
      inputTokens,
      outputTokens,
      costMicros: calculateModelCost(inputTokens, outputTokens, pricing),
    },
    ...(providerRequestId === undefined ? {} : { providerRequestId }),
  });
}

function responseOutputText(raw: Record<string, unknown>): string {
  if (typeof raw.output_text === "string") return raw.output_text;
  if (!Array.isArray(raw.output)) {
    throw new ModelProviderError("OpenAI response omitted output", "invalid-response");
  }
  for (const item of raw.output) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const content = (item as Record<string, unknown>).content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (typeof block !== "object" || block === null || Array.isArray(block)) continue;
      const text = (block as Record<string, unknown>).text;
      if (typeof text === "string") return text;
    }
  }
  throw new ModelProviderError("OpenAI response omitted structured text", "invalid-response");
}

export class OpenAIResponsesAdapter implements ModelAdapter {
  public readonly descriptor: ModelAdapterDescriptor;
  readonly #endpoint: string;
  readonly #credentialRef: string;
  readonly #pricing: TokenPricing;
  readonly #parameters: Readonly<Record<string, JsonValue>>;
  readonly #fetch: FetchLike;
  readonly #resolveCredential: CredentialResolver;
  readonly #maxResponseBytes: number;
  readonly #maxContextTokens: number;
  readonly #maxOutputTokens: number;

  public constructor(options: OpenAIResponsesAdapterOptions) {
    assertTokenPricing(options.pricing);
    this.#endpoint = endpoint(options.endpoint, "https://api.openai.com/v1/responses", false);
    this.#credentialRef = credentialReference(options.credentialRef);
    this.#pricing = structuredClone(options.pricing);
    this.#parameters = normalizedParameters(options.parameters, [
      "model", "input", "instructions", "max_output_tokens", "text", "store", "stream",
      "tools", "tool_choice", "max_tool_calls", "parallel_tool_calls", "background",
      "previous_response_id", "conversation", "prompt", "truncation", "modalities", "audio",
    ]);
    this.#fetch = options.fetch ?? fetch;
    this.#resolveCredential = options.resolveCredential ?? environmentCredentialResolver;
    this.#maxResponseBytes = maxResponseBytes(options.maxResponseBytes);
    this.#maxContextTokens = positiveTokenLimit(options.maxContextTokens, "maxContextTokens");
    this.#maxOutputTokens = positiveTokenLimit(options.maxOutputTokens, "maxOutputTokens");
    this.descriptor = descriptor(
      options.adapterId,
      "openai",
      options.model,
      "openai-responses-v1",
      this.#endpoint,
      this.#credentialRef,
      this.#pricing,
      this.#parameters,
      this.#maxResponseBytes,
      ["network.access", "secrets.read", "spend"],
      {
        maxContextTokens: this.#maxContextTokens,
        providerMaxOutputTokens: this.#maxOutputTokens,
      },
    );
  }

  public async invoke(request: ModelRequest, context: ModelInvocationContext): Promise<ModelResponse> {
    const maxOutputTokens = configuredOutputTokenLimit(
      request,
      this.#pricing,
      true,
      this.#maxContextTokens,
      this.#maxOutputTokens,
    );
    const secret = await credential(this.#credentialRef, this.#resolveCredential, context.signal);
    const raw = await postJson(
      this.#fetch,
      this.#endpoint,
      { authorization: `Bearer ${secret!}` },
      {
        ...this.#parameters,
        model: this.descriptor.model,
        instructions: SYSTEM_INSTRUCTION,
        input: promptFor(request),
        max_output_tokens: maxOutputTokens,
        store: false,
        background: false,
        truncation: "disabled",
        text: {
          format: {
            type: "json_schema",
            name: ACTION_FORMAT_NAME,
            schema: MODEL_ACTION_JSON_SCHEMA,
            strict: false,
          },
        },
      },
      context,
      this.#maxResponseBytes,
    );
    if (typeof raw.status === "string" && raw.status !== "completed") {
      throw new ModelProviderError(
        "OpenAI response did not complete",
        "invalid-response",
      );
    }
    const usage = record(raw.usage, "OpenAI usage");
    return response(
      parseActionText(responseOutputText(raw)),
      integer(usage.input_tokens, "OpenAI usage.input_tokens"),
      integer(usage.output_tokens, "OpenAI usage.output_tokens"),
      this.#pricing,
      raw.id,
    );
    if (typeof raw.stop_reason === "string" && raw.stop_reason !== "tool_use") {
      throw new ModelProviderError(
        "Anthropic response stopped without the action tool",
        "invalid-response",
      );
    }
  }
}

export class AnthropicMessagesAdapter implements ModelAdapter {
  public readonly descriptor: ModelAdapterDescriptor;
  readonly #endpoint: string;
  readonly #credentialRef: string;
  readonly #pricing: TokenPricing;
  readonly #parameters: Readonly<Record<string, JsonValue>>;
  readonly #fetch: FetchLike;
  readonly #resolveCredential: CredentialResolver;
  readonly #maxResponseBytes: number;
  readonly #anthropicVersion: string;
  readonly #maxContextTokens: number;
  readonly #maxOutputTokens: number;

  public constructor(options: AnthropicMessagesAdapterOptions) {
    assertTokenPricing(options.pricing);
    this.#endpoint = endpoint(options.endpoint, "https://api.anthropic.com/v1/messages", false);
    this.#credentialRef = credentialReference(options.credentialRef);
    this.#pricing = structuredClone(options.pricing);
    this.#parameters = normalizedParameters(options.parameters, [
      "model", "messages", "system", "max_tokens", "tools", "tool_choice", "stream",
      "mcp_servers", "container", "context_management",
    ]);
    this.#fetch = options.fetch ?? fetch;
    this.#resolveCredential = options.resolveCredential ?? environmentCredentialResolver;
    this.#maxResponseBytes = maxResponseBytes(options.maxResponseBytes);
    this.#anthropicVersion = nonEmptyString(
      options.anthropicVersion ?? "2023-06-01",
      "anthropicVersion",
    );
    this.#maxContextTokens = positiveTokenLimit(options.maxContextTokens, "maxContextTokens");
    this.#maxOutputTokens = positiveTokenLimit(options.maxOutputTokens, "maxOutputTokens");
    this.descriptor = descriptor(
      options.adapterId,
      "anthropic",
      options.model,
      "anthropic-messages-v1",
      this.#endpoint,
      this.#credentialRef,
      this.#pricing,
      this.#parameters,
      this.#maxResponseBytes,
      ["network.access", "secrets.read", "spend"],
      {
        anthropicVersion: this.#anthropicVersion,
        maxContextTokens: this.#maxContextTokens,
        providerMaxOutputTokens: this.#maxOutputTokens,
      },
    );
  }

  public async invoke(request: ModelRequest, context: ModelInvocationContext): Promise<ModelResponse> {
    const maxOutputTokens = configuredOutputTokenLimit(
      request,
      this.#pricing,
      true,
      this.#maxContextTokens,
      this.#maxOutputTokens,
    );
    const secret = await credential(this.#credentialRef, this.#resolveCredential, context.signal);
    const raw = await postJson(
      this.#fetch,
      this.#endpoint,
      { "x-api-key": secret!, "anthropic-version": this.#anthropicVersion },
      {
        ...this.#parameters,
        model: this.descriptor.model,
        max_tokens: maxOutputTokens,
        system: SYSTEM_INSTRUCTION,
        messages: [{ role: "user", content: promptFor(request) }],
        tools: [{
          name: SUBMIT_ACTION_TOOL,
          description: "Submit exactly one typed Reasoning Workbench action.",
          input_schema: MODEL_ACTION_JSON_SCHEMA,
        }],
        tool_choice: { type: "tool", name: SUBMIT_ACTION_TOOL },
      },
      context,
      this.#maxResponseBytes,
    );
    if (!Array.isArray(raw.content)) {
      throw new ModelProviderError("Anthropic response omitted content", "invalid-response");
    }
    const block = raw.content.find((item) =>
      typeof item === "object" && item !== null && !Array.isArray(item) &&
      (item as Record<string, unknown>).type === "tool_use" &&
      (item as Record<string, unknown>).name === SUBMIT_ACTION_TOOL
    );
    if (block === undefined) {
      throw new ModelProviderError("Anthropic response omitted the forced action tool", "invalid-response");
    }
    const usage = record(raw.usage, "Anthropic usage");
    return response(
      normalizeAction((block as Record<string, unknown>).input),
      integer(usage.input_tokens, "Anthropic usage.input_tokens"),
      integer(usage.output_tokens, "Anthropic usage.output_tokens"),
      this.#pricing,
      raw.id,
    );
  }
}

function chatCompletionText(raw: Record<string, unknown>): string {
  if (!Array.isArray(raw.choices) || raw.choices.length === 0) {
    throw new ModelProviderError("Chat completion omitted choices", "invalid-response");
  }
  const first = record(raw.choices[0], "chat completion choice");
  if (first.finish_reason === "length") {
    throw new ModelProviderError(
      "Chat completion reached its output limit before a complete action",
      "invalid-response",
    );
  }
  const message = record(first.message, "chat completion message");
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    const text = message.content
      .map((part) =>
        typeof part === "object" && part !== null && !Array.isArray(part)
          ? (part as Record<string, unknown>).text
          : undefined,
      )
      .find((part): part is string => typeof part === "string");
    if (text !== undefined) return text;
  }
  throw new ModelProviderError("Chat completion omitted structured content", "invalid-response");
}

export class OpenAICompatibleAdapter implements ModelAdapter {
  public readonly descriptor: ModelAdapterDescriptor;
  readonly #endpoint: string;
  readonly #credentialRef: string | undefined;
  readonly #pricing: TokenPricing;
  readonly #parameters: Readonly<Record<string, JsonValue>>;
  readonly #fetch: FetchLike;
  readonly #resolveCredential: CredentialResolver;
  readonly #maxResponseBytes: number;
  readonly #paid: boolean;
  readonly #maxTokensField: "max_tokens" | "max_completion_tokens";
  readonly #maxContextTokens: number;
  readonly #maxOutputTokens: number;

  public constructor(options: OpenAICompatibleAdapterOptions) {
    assertTokenPricing(options.pricing);
    this.#endpoint = endpoint(
      options.endpoint,
      "http://127.0.0.1:11434/v1/chat/completions",
      true,
    );
    this.#credentialRef = options.credentialRef === undefined
      ? undefined
      : credentialReference(options.credentialRef);
    this.#pricing = structuredClone(options.pricing);
    this.#parameters = normalizedParameters(options.parameters, [
      "model", "messages", "max_tokens", "max_completion_tokens", "response_format", "stream",
      "tools", "tool_choice", "functions", "function_call", "parallel_tool_calls", "store",
      "modalities", "audio", "prediction", "n",
    ]);
    this.#fetch = options.fetch ?? fetch;
    this.#resolveCredential = options.resolveCredential ?? environmentCredentialResolver;
    this.#maxResponseBytes = maxResponseBytes(options.maxResponseBytes);
    this.#paid = options.paid ?? new URL(this.#endpoint).protocol === "https:";
    this.#maxTokensField = options.maxTokensField ?? "max_tokens";
    this.#maxContextTokens = positiveTokenLimit(options.maxContextTokens, "maxContextTokens");
    this.#maxOutputTokens = positiveTokenLimit(options.maxOutputTokens, "maxOutputTokens");
    const capabilities: ToolCapability[] = ["network.access"];
    if (this.#credentialRef !== undefined) capabilities.push("secrets.read");
    if (this.#paid) capabilities.push("spend");
    this.descriptor = descriptor(
      options.adapterId,
      options.provider ?? "openai-compatible",
      options.model,
      "openai-chat-completions-v1",
      this.#endpoint,
      this.#credentialRef,
      this.#pricing,
      this.#parameters,
      this.#maxResponseBytes,
      capabilities,
      {
        paid: this.#paid,
        maxTokensField: this.#maxTokensField,
        maxContextTokens: this.#maxContextTokens,
        providerMaxOutputTokens: this.#maxOutputTokens,
      },
    );
  }

  public async invoke(request: ModelRequest, context: ModelInvocationContext): Promise<ModelResponse> {
    const maxOutputTokens = configuredOutputTokenLimit(
      request,
      this.#pricing,
      this.#paid,
      this.#maxContextTokens,
      this.#maxOutputTokens,
    );
    const secret = await credential(this.#credentialRef, this.#resolveCredential, context.signal);
    const headers = secret === undefined ? {} : { authorization: `Bearer ${secret}` };
    const raw = await postJson(
      this.#fetch,
      this.#endpoint,
      headers,
      {
        ...this.#parameters,
        model: this.descriptor.model,
        messages: [
          { role: "system", content: SYSTEM_INSTRUCTION },
          { role: "user", content: promptFor(request) },
        ],
        [this.#maxTokensField]: maxOutputTokens,
        n: 1,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: ACTION_FORMAT_NAME,
            schema: MODEL_ACTION_JSON_SCHEMA,
            strict: false,
          },
        },
      },
      context,
      this.#maxResponseBytes,
    );
    const usage = record(raw.usage, "chat completion usage");
    const inputTokens = usage.prompt_tokens ?? usage.input_tokens;
    const outputTokens = usage.completion_tokens ?? usage.output_tokens;
    return response(
      parseActionText(chatCompletionText(raw)),
      integer(inputTokens, "chat completion usage input tokens"),
      integer(outputTokens, "chat completion usage output tokens"),
      this.#pricing,
      raw.id,
    );
  }
}
