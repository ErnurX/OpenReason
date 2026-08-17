import {
  canonicalJson,
  computeContentHash,
  type JsonValue,
} from "@reasoning-workbench/project-format";

import { redactSecretValue } from "./context.js";
import { assertModelAdapterDescriptor, type ModelAdapter } from "./model.js";
import {
  AnthropicMessagesAdapter,
  OpenAICompatibleAdapter,
  OpenAIResponsesAdapter,
  assertTokenPricing,
  calculateModelCost,
  type CredentialResolver,
  type FetchLike,
  type TokenPricing,
} from "./providers.js";
import { listCurrentObjects } from "./projection.js";

export const MODEL_TASK_TYPES = [
  "discovery",
  "mathematics",
  "physics",
  "formal-math",
  "coding",
  "review",
  "extraction",
  "general",
] as const;

export type ModelTaskType = (typeof MODEL_TASK_TYPES)[number];

export const MODEL_MODALITIES = ["text", "image", "audio"] as const;
export type ModelModality = (typeof MODEL_MODALITIES)[number];

export const MODEL_PRIVACY_CLASSES = [
  "local",
  "external-no-training",
  "external-managed",
] as const;
export type ModelPrivacyClass = (typeof MODEL_PRIVACY_CLASSES)[number];

export interface ModelCapabilityProfile {
  readonly schemaVersion: 1;
  readonly adapterId: string;
  readonly maxContextTokens: number;
  readonly maxOutputTokens: number;
  readonly modalities: readonly ModelModality[];
  readonly structuredOutput: boolean;
  readonly toolUse: boolean;
  readonly strengths: Readonly<Partial<Record<ModelTaskType, number>>>;
  readonly pricing: TokenPricing;
  readonly expectedLatencyMs: number;
  readonly privacy: ModelPrivacyClass;
}

export interface ModelProfileInput {
  readonly maxContextTokens: number;
  readonly maxOutputTokens: number;
  readonly modalities: readonly ModelModality[];
  readonly structuredOutput: boolean;
  readonly toolUse: boolean;
  readonly strengths: Readonly<Partial<Record<ModelTaskType, number>>>;
  readonly expectedLatencyMs: number;
  readonly privacy: ModelPrivacyClass;
}

interface BaseModelAdapterConfig {
  readonly schemaVersion: 1;
  readonly adapterId: string;
  readonly model: string;
  readonly endpoint?: string;
  readonly pricing: TokenPricing;
  readonly parameters?: Readonly<Record<string, JsonValue>>;
  readonly maxResponseBytes?: number;
  readonly profile: ModelProfileInput;
}

export interface OpenAIModelAdapterConfig extends BaseModelAdapterConfig {
  readonly kind: "openai-responses";
  readonly credentialRef: string;
}

export interface AnthropicModelAdapterConfig extends BaseModelAdapterConfig {
  readonly kind: "anthropic-messages";
  readonly credentialRef: string;
  readonly anthropicVersion?: string;
}

export interface CompatibleModelAdapterConfig extends BaseModelAdapterConfig {
  readonly kind: "openai-compatible";
  readonly credentialRef?: string;
  readonly paid?: boolean;
  readonly maxTokensField?: "max_tokens" | "max_completion_tokens";
  readonly provider?: string;
}

export type ModelAdapterConfig =
  | OpenAIModelAdapterConfig
  | AnthropicModelAdapterConfig
  | CompatibleModelAdapterConfig;

export interface ConfiguredModel {
  readonly adapter: ModelAdapter;
  readonly profile: ModelCapabilityProfile;
  readonly configDigest: string;
}

export interface ConfiguredModelDependencies {
  readonly fetch?: FetchLike;
  readonly resolveCredential?: CredentialResolver;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new TypeError(`${label} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function allowedKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const keys = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!keys.has(key)) throw new TypeError(`${label} contains unsupported field ${key}`);
  }
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return Number(value);
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return Number(value);
}

function optionalString(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : string(value, label);
}

function optionalPositiveInteger(value: unknown, label: string): number | undefined {
  return value === undefined ? undefined : positiveInteger(value, label);
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${label} must be boolean`);
  return value;
}

function noSecrets(value: unknown, label: string): void {
  let serialized: string;
  try {
    serialized = canonicalJson(value);
  } catch (error) {
    throw new TypeError(
      `${label} must be JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (canonicalJson(redactSecretValue(value)) !== serialized) {
    throw new TypeError(`${label} contains secret-like material; use credentialRef`);
  }
}

function parsePricing(value: unknown): TokenPricing {
  const input = record(value, "pricing");
  allowedKeys(
    input,
    ["inputMicrosPerMillionTokens", "outputMicrosPerMillionTokens", "currency"],
    "pricing",
  );
  const currency = string(input.currency, "pricing.currency");
  if (currency !== "USD") throw new TypeError("pricing.currency must be USD");
  const pricing: TokenPricing = {
    inputMicrosPerMillionTokens: nonNegativeInteger(
      input.inputMicrosPerMillionTokens,
      "pricing.inputMicrosPerMillionTokens",
    ),
    outputMicrosPerMillionTokens: nonNegativeInteger(
      input.outputMicrosPerMillionTokens,
      "pricing.outputMicrosPerMillionTokens",
    ),
    currency,
  };
  assertTokenPricing(pricing);
  return pricing;
}

function parseStringEnum<T extends string>(
  value: unknown,
  values: readonly T[],
  label: string,
): T {
  const result = string(value, label);
  if (!(values as readonly string[]).includes(result)) {
    throw new TypeError(`${label} must be one of ${values.join(", ")}`);
  }
  return result as T;
}

function parseProfile(value: unknown): ModelProfileInput {
  const input = record(value, "profile");
  allowedKeys(
    input,
    [
      "maxContextTokens",
      "maxOutputTokens",
      "modalities",
      "structuredOutput",
      "toolUse",
      "strengths",
      "expectedLatencyMs",
      "privacy",
    ],
    "profile",
  );
  if (!Array.isArray(input.modalities) || input.modalities.length === 0) {
    throw new TypeError("profile.modalities must be a non-empty array");
  }
  const modalities = input.modalities.map((item, index) =>
    parseStringEnum(item, MODEL_MODALITIES, `profile.modalities[${index}]`),
  );
  if (new Set(modalities).size !== modalities.length) {
    throw new TypeError("profile.modalities cannot contain duplicates");
  }
  const rawStrengths = record(input.strengths, "profile.strengths");
  const strengths: Partial<Record<ModelTaskType, number>> = {};
  for (const [task, score] of Object.entries(rawStrengths)) {
    const typedTask = parseStringEnum(task, MODEL_TASK_TYPES, `profile.strengths key ${task}`);
    if (!Number.isFinite(score) || Number(score) < 0 || Number(score) > 100) {
      throw new TypeError(`profile.strengths.${task} must be between 0 and 100`);
    }
    strengths[typedTask] = Number(score);
  }
  return {
    maxContextTokens: positiveInteger(input.maxContextTokens, "profile.maxContextTokens"),
    maxOutputTokens: positiveInteger(input.maxOutputTokens, "profile.maxOutputTokens"),
    modalities,
    structuredOutput: boolean(input.structuredOutput, "profile.structuredOutput"),
    toolUse: boolean(input.toolUse, "profile.toolUse"),
    strengths,
    expectedLatencyMs: nonNegativeInteger(input.expectedLatencyMs, "profile.expectedLatencyMs"),
    privacy: parseStringEnum(input.privacy, MODEL_PRIVACY_CLASSES, "profile.privacy"),
  };
}

export function parseModelAdapterConfig(value: unknown): ModelAdapterConfig {
  const input = record(value, "model adapter config");
  const common = [
    "schemaVersion",
    "kind",
    "adapterId",
    "model",
    "endpoint",
    "pricing",
    "parameters",
    "maxResponseBytes",
    "profile",
  ] as const;
  if (input.schemaVersion !== 1) {
    throw new TypeError("model adapter config.schemaVersion must be 1");
  }
  const kind = parseStringEnum(
    input.kind,
    ["openai-responses", "anthropic-messages", "openai-compatible"] as const,
    "model adapter config.kind",
  );
  const additional = kind === "openai-responses"
    ? ["credentialRef"]
    : kind === "anthropic-messages"
      ? ["credentialRef", "anthropicVersion"]
      : ["credentialRef", "paid", "maxTokensField", "provider"];
  allowedKeys(input, [...common, ...additional], "model adapter config");
  const parameters = input.parameters === undefined
    ? undefined
    : record(input.parameters, "model adapter config.parameters") as Record<string, JsonValue>;
  const base = {
    schemaVersion: 1 as const,
    adapterId: string(input.adapterId, "model adapter config.adapterId"),
    model: string(input.model, "model adapter config.model"),
    ...(input.endpoint === undefined
      ? {}
      : { endpoint: string(input.endpoint, "model adapter config.endpoint") }),
    pricing: parsePricing(input.pricing),
    ...(parameters === undefined ? {} : { parameters }),
    ...(input.maxResponseBytes === undefined
      ? {}
      : { maxResponseBytes: positiveInteger(input.maxResponseBytes, "model adapter config.maxResponseBytes") }),
    profile: parseProfile(input.profile),
  };
  let parsed: ModelAdapterConfig;
  if (kind === "openai-responses") {
    parsed = {
      ...base,
      kind,
      credentialRef: string(input.credentialRef, "model adapter config.credentialRef"),
    };
  } else if (kind === "anthropic-messages") {
    const anthropicVersion = optionalString(input.anthropicVersion, "model adapter config.anthropicVersion");
    parsed = {
      ...base,
      kind,
      credentialRef: string(input.credentialRef, "model adapter config.credentialRef"),
      ...(anthropicVersion === undefined ? {} : { anthropicVersion }),
    };
  } else {
    const credentialRef = optionalString(input.credentialRef, "model adapter config.credentialRef");
    const maxTokensField = input.maxTokensField === undefined
      ? undefined
      : parseStringEnum(
          input.maxTokensField,
          ["max_tokens", "max_completion_tokens"] as const,
          "model adapter config.maxTokensField",
        );
    const provider = optionalString(input.provider, "model adapter config.provider");
    parsed = {
      ...base,
      kind,
      ...(credentialRef === undefined ? {} : { credentialRef }),
      ...(input.paid === undefined ? {} : { paid: boolean(input.paid, "model adapter config.paid") }),
      ...(maxTokensField === undefined ? {} : { maxTokensField }),
      ...(provider === undefined ? {} : { provider }),
    };
  }
  noSecrets(parsed, "model adapter config");
  return parsed;
}

export function createConfiguredModel(
  value: unknown,
  dependencies: ConfiguredModelDependencies = {},
): ConfiguredModel {
  const config = parseModelAdapterConfig(value);
  const common = {
    adapterId: config.adapterId,
    model: config.model,
    pricing: config.pricing,
    maxContextTokens: config.profile.maxContextTokens,
    maxOutputTokens: config.profile.maxOutputTokens,
    ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint }),
    ...(config.parameters === undefined ? {} : { parameters: config.parameters }),
    ...(config.maxResponseBytes === undefined ? {} : { maxResponseBytes: config.maxResponseBytes }),
    ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
    ...(dependencies.resolveCredential === undefined
      ? {}
      : { resolveCredential: dependencies.resolveCredential }),
  };
  const adapter: ModelAdapter = config.kind === "openai-responses"
    ? new OpenAIResponsesAdapter({ ...common, credentialRef: config.credentialRef })
    : config.kind === "anthropic-messages"
      ? new AnthropicMessagesAdapter({
          ...common,
          credentialRef: config.credentialRef,
          ...(config.anthropicVersion === undefined ? {} : { anthropicVersion: config.anthropicVersion }),
        })
      : new OpenAICompatibleAdapter({
          ...common,
          ...(config.credentialRef === undefined ? {} : { credentialRef: config.credentialRef }),
          ...(config.paid === undefined ? {} : { paid: config.paid }),
          ...(config.maxTokensField === undefined ? {} : { maxTokensField: config.maxTokensField }),
          ...(config.provider === undefined ? {} : { provider: config.provider }),
        });
  const profile: ModelCapabilityProfile = {
    schemaVersion: 1,
    adapterId: config.adapterId,
    ...structuredClone(config.profile),
    pricing: structuredClone(config.pricing),
  };
  assertModelCapabilityProfile(profile);
  return {
    adapter,
    profile,
    configDigest: computeContentHash(config as unknown as Record<string, unknown>),
  };
}

export function assertModelCapabilityProfile(
  value: unknown,
): asserts value is ModelCapabilityProfile {
  const input = record(value, "model capability profile");
  allowedKeys(
    input,
    [
      "schemaVersion",
      "adapterId",
      "maxContextTokens",
      "maxOutputTokens",
      "modalities",
      "structuredOutput",
      "toolUse",
      "strengths",
      "pricing",
      "expectedLatencyMs",
      "privacy",
    ],
    "model capability profile",
  );
  if (input.schemaVersion !== 1) throw new TypeError("model capability profile.schemaVersion must be 1");
  string(input.adapterId, "model capability profile.adapterId");
  parseProfile({
    maxContextTokens: input.maxContextTokens,
    maxOutputTokens: input.maxOutputTokens,
    modalities: input.modalities,
    structuredOutput: input.structuredOutput,
    toolUse: input.toolUse,
    strengths: input.strengths,
    expectedLatencyMs: input.expectedLatencyMs,
    privacy: input.privacy,
  });
  parsePricing(input.pricing);
  noSecrets(input, "model capability profile");
}

export interface ModelRouteRequest {
  readonly task: ModelTaskType;
  readonly estimatedInputTokens: number;
  readonly requestedOutputTokens: number;
  readonly requiredModalities?: readonly ModelModality[];
  readonly requireStructuredOutput?: boolean;
  readonly requireToolUse?: boolean;
  readonly privacy?: "local-only" | "no-training-or-local" | "external-allowed";
  readonly maxEstimatedCostMicros?: number;
  readonly weights?: {
    readonly quality: number;
    readonly cost: number;
    readonly latency: number;
  };
}

export interface ModelRouteCandidate {
  readonly adapterId: string;
  readonly score: number;
  readonly quality: number;
  readonly estimatedCostMicros: number;
  readonly expectedLatencyMs: number;
}

export interface ModelRouteResult {
  readonly selectedAdapterId: string;
  readonly candidates: readonly ModelRouteCandidate[];
}

export class ModelRoutingError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ModelRoutingError";
  }
}

export class ModelGatewayRegistry {
  readonly #models = new Map<string, ConfiguredModel>();

  public register(model: ConfiguredModel): this {
    assertModelAdapterDescriptor(model.adapter.descriptor);
    assertModelCapabilityProfile(model.profile);
    if (model.adapter.descriptor.adapterId !== model.profile.adapterId) {
      throw new TypeError("adapter and capability profile IDs do not match");
    }
    if (
      canonicalJson(model.adapter.descriptor.configuration.pricing) !==
      canonicalJson(model.profile.pricing)
    ) {
      throw new TypeError("adapter and capability profile pricing do not match");
    }
    if (
      model.adapter.descriptor.configuration.maxContextTokens !==
        model.profile.maxContextTokens ||
      model.adapter.descriptor.configuration.providerMaxOutputTokens !==
        model.profile.maxOutputTokens
    ) {
      throw new TypeError("adapter and capability profile token limits do not match");
    }
    if (!/^sha256:[0-9a-f]{64}$/u.test(model.configDigest)) {
      throw new TypeError("configured model has an invalid config digest");
    }
    if (this.#models.has(model.profile.adapterId)) {
      throw new TypeError(`model is already registered: ${model.profile.adapterId}`);
    }
    this.#models.set(model.profile.adapterId, model);
    return this;
  }

  public get(adapterId: string): ConfiguredModel | undefined {
    return this.#models.get(adapterId);
  }

  public list(): ConfiguredModel[] {
    return [...this.#models.values()].sort((left, right) =>
      left.profile.adapterId.localeCompare(right.profile.adapterId),
    );
  }

  public route(request: ModelRouteRequest): ModelRouteResult {
    parseStringEnum(request.task, MODEL_TASK_TYPES, "route.task");
    positiveInteger(request.estimatedInputTokens, "route.estimatedInputTokens");
    positiveInteger(request.requestedOutputTokens, "route.requestedOutputTokens");
    const modalities = request.requiredModalities ?? ["text"];
    for (const [index, modality] of modalities.entries()) {
      parseStringEnum(modality, MODEL_MODALITIES, `route.requiredModalities[${index}]`);
    }
    const privacy = request.privacy ?? "external-allowed";
    parseStringEnum(
      privacy,
      ["local-only", "no-training-or-local", "external-allowed"] as const,
      "route.privacy",
    );
    const maxCost = request.maxEstimatedCostMicros === undefined
      ? undefined
      : nonNegativeInteger(request.maxEstimatedCostMicros, "route.maxEstimatedCostMicros");
    const weights = request.weights ?? { quality: 0.7, cost: 0.2, latency: 0.1 };
    for (const [name, weight] of Object.entries(weights)) {
      if (!Number.isFinite(weight) || weight < 0) {
        throw new TypeError(`route.weights.${name} must be finite and non-negative`);
      }
    }
    if (weights.quality + weights.cost + weights.latency <= 0) {
      throw new TypeError("at least one route weight must be positive");
    }

    const eligible = this.list().flatMap((model) => {
      const profile = model.profile;
      if (request.estimatedInputTokens + request.requestedOutputTokens > profile.maxContextTokens) return [];
      if (request.requestedOutputTokens > profile.maxOutputTokens) return [];
      if (modalities.some((modality) => !profile.modalities.includes(modality))) return [];
      if (request.requireStructuredOutput === true && !profile.structuredOutput) return [];
      if (request.requireToolUse === true && !profile.toolUse) return [];
      if (privacy === "local-only" && profile.privacy !== "local") return [];
      if (privacy === "no-training-or-local" && profile.privacy === "external-managed") return [];
      const estimatedCostMicros = calculateModelCost(
        request.estimatedInputTokens,
        request.requestedOutputTokens,
        profile.pricing,
      );
      if (maxCost !== undefined && estimatedCostMicros > maxCost) return [];
      return [{
        adapterId: profile.adapterId,
        quality: profile.strengths[request.task] ?? profile.strengths.general ?? 0,
        estimatedCostMicros,
        expectedLatencyMs: profile.expectedLatencyMs,
      }];
    });
    if (eligible.length === 0) {
      throw new ModelRoutingError("No registered model satisfies the route constraints");
    }
    const maxCandidateCost = Math.max(1, ...eligible.map((item) => item.estimatedCostMicros));
    const maxCandidateLatency = Math.max(1, ...eligible.map((item) => item.expectedLatencyMs));
    const candidates: ModelRouteCandidate[] = eligible.map((item) => ({
      ...item,
      score:
        weights.quality * item.quality -
        weights.cost * 100 * (item.estimatedCostMicros / maxCandidateCost) -
        weights.latency * 100 * (item.expectedLatencyMs / maxCandidateLatency),
    })).sort((left, right) =>
      right.score - left.score || left.adapterId.localeCompare(right.adapterId),
    );
    return { selectedAdapterId: candidates[0]!.adapterId, candidates };
  }
}

export interface ModelUsageTotals {
  readonly calls: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly interrupted: number;
  readonly running: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costMicros: number;
  readonly latencyMs: number;
}

export interface ModelAdapterUsage extends ModelUsageTotals {
  readonly adapterId: string;
  readonly descriptorDigest: string;
  readonly provider: string;
  readonly model: string;
}

export interface ModelUsageReport {
  readonly schemaVersion: 1;
  readonly branchId: string;
  readonly totals: ModelUsageTotals;
  readonly byAdapter: readonly ModelAdapterUsage[];
}

function emptyUsage(): ModelUsageTotals {
  return {
    calls: 0,
    succeeded: 0,
    failed: 0,
    interrupted: 0,
    running: 0,
    inputTokens: 0,
    outputTokens: 0,
    costMicros: 0,
    latencyMs: 0,
  };
}

function usageStatus(value: unknown): "succeeded" | "failed" | "interrupted" | "running" {
  return value === "succeeded" || value === "failed" || value === "interrupted"
    ? value
    : "running";
}

function duration(content: Record<string, unknown>): number {
  if (Number.isSafeInteger(content.latencyMs) && Number(content.latencyMs) >= 0) {
    return Number(content.latencyMs);
  }
  if (typeof content.startedAt === "string" && typeof content.finishedAt === "string") {
    const elapsed = Date.parse(content.finishedAt) - Date.parse(content.startedAt);
    return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : 0;
  }
  return 0;
}

function addUsage(
  target: {
    calls: number;
    succeeded: number;
    failed: number;
    interrupted: number;
    running: number;
    inputTokens: number;
    outputTokens: number;
    costMicros: number;
    latencyMs: number;
  },
  status: "succeeded" | "failed" | "interrupted" | "running",
  usage: Record<string, unknown> | undefined,
  latencyMs: number,
): void {
  target.calls += 1;
  target[status] += 1;
  target.inputTokens += Number.isSafeInteger(usage?.inputTokens) ? Number(usage!.inputTokens) : 0;
  target.outputTokens += Number.isSafeInteger(usage?.outputTokens) ? Number(usage!.outputTokens) : 0;
  target.costMicros += Number.isSafeInteger(usage?.costMicros) ? Number(usage!.costMicros) : 0;
  target.latencyMs += latencyMs;
  for (const key of [
    "calls", "succeeded", "failed", "interrupted", "running",
    "inputTokens", "outputTokens", "costMicros", "latencyMs",
  ] as const) {
    if (!Number.isSafeInteger(target[key])) {
      throw new RangeError(`model usage ${key} exceeds the safe integer range`);
    }
  }
}

export function inspectModelUsage(projectRoot: string, branchId: string): ModelUsageReport {
  const totals = emptyUsage();
  const groups = new Map<string, {
    adapterId: string;
    descriptorDigest: string;
    provider: string;
    model: string;
    calls: number;
    succeeded: number;
    failed: number;
    interrupted: number;
    running: number;
    inputTokens: number;
    outputTokens: number;
    costMicros: number;
    latencyMs: number;
  }>();
  const turns = listCurrentObjects(projectRoot, branchId)
    .filter((object) => {
      const content = object.content as Record<string, unknown>;
      return object.objectType === "run" && content.kind === "model-turn";
    })
    .sort((left, right) => left.objectId.localeCompare(right.objectId));
  for (const turn of turns) {
    const content = record(turn.content, `model turn ${turn.objectId}`);
    const adapter = record(content.adapter, `model turn ${turn.objectId}.adapter`);
    const adapterId = string(adapter.adapterId, `model turn ${turn.objectId}.adapter.adapterId`);
    const descriptorDigest = computeContentHash(adapter);
    const group = groups.get(descriptorDigest) ?? {
      adapterId,
      descriptorDigest,
      provider: string(adapter.provider, `model turn ${turn.objectId}.adapter.provider`),
      model: string(adapter.model, `model turn ${turn.objectId}.adapter.model`),
      ...emptyUsage(),
    };
    const status = usageStatus(content.status);
    const usage = content.usage === undefined
      ? undefined
      : record(content.usage, `model turn ${turn.objectId}.usage`);
    const latencyMs = duration(content);
    addUsage(group, status, usage, latencyMs);
    addUsage(totals as typeof group, status, usage, latencyMs);
    groups.set(descriptorDigest, group);
  }
  return {
    schemaVersion: 1,
    branchId,
    totals,
    byAdapter: [...groups.values()].sort((left, right) =>
      left.adapterId.localeCompare(right.adapterId) ||
      left.descriptorDigest.localeCompare(right.descriptorDigest),
    ),
  };
}
