import {
  canonicalJson,
  computeContentHash,
  type JsonValue,
  type ObjectType,
  type ReproducibilityKind,
} from "@reasoning-workbench/project-format";

import {
  TOOL_CAPABILITIES,
  type ToolCapability,
} from "./tools.js";
import { redactSecretValue } from "./context.js";

export const MODEL_ACTION_KINDS = [
  "tool-call",
  "propose-object",
  "checkpoint",
  "escalate",
  "request-completion",
] as const;

export const MODEL_PROPOSABLE_OBJECT_TYPES = [
  "definition",
  "assumption",
  "claim",
  "evidence",
  "source",
  "document",
  "alignment",
] as const satisfies readonly ObjectType[];

export type ModelProposableObjectType =
  (typeof MODEL_PROPOSABLE_OBJECT_TYPES)[number];

export interface ModelAdapterDescriptor {
  readonly schemaVersion: 1;
  readonly adapterId: string;
  readonly provider: string;
  readonly model: string;
  readonly version: string;
  /** Exact provider/model parameters, excluding credentials. */
  readonly configuration: Readonly<Record<string, JsonValue>>;
  readonly requiredCapabilities: readonly ToolCapability[];
  readonly reproducibility: ReproducibilityKind;
}

export interface ModelContextReference {
  readonly objectId: string;
  readonly versionId: string;
  readonly objectType: ObjectType;
  readonly contentHash: string;
}

export interface ModelSteeringInput {
  readonly decisionId: string;
  readonly instruction: string;
  readonly createdAt: string;
}

export interface ModelRequest {
  readonly schemaVersion: 1;
  readonly sessionId: string;
  readonly turn: number;
  readonly workstreamId: string;
  readonly branchId: string;
  readonly goalId: string;
  readonly promptText: string;
  readonly contextDigest: string;
  readonly contextEntries: readonly ModelContextReference[];
  readonly estimatedInputTokens: number;
  readonly limits: {
    readonly remainingInputTokens: number;
    readonly remainingOutputTokens: number;
    readonly remainingCostMicros: number;
  };
  readonly steering: readonly ModelSteeringInput[];
}

export interface ToolCallAction {
  readonly kind: "tool-call";
  readonly toolId: string;
  readonly input: JsonValue;
  readonly timeoutMs?: number;
}

export interface ProposeObjectAction {
  readonly kind: "propose-object";
  readonly objectType: ModelProposableObjectType;
  readonly content: Readonly<Record<string, JsonValue>>;
  /** Explicit mathematical context, retained on claims and evidence. */
  readonly contextId?: string;
}

export interface CheckpointAction {
  readonly kind: "checkpoint";
  readonly summary: string;
  readonly nextSteps: readonly string[];
  readonly evidenceObjectIds: readonly string[];
}

export interface EscalateAction {
  readonly kind: "escalate";
  readonly attemptedApproaches: readonly string[];
  readonly evidenceObjectIds: readonly string[];
  readonly blocker: string;
  readonly requestedHumanInput: string;
}

export interface RequestCompletionAction {
  readonly kind: "request-completion";
  readonly rationale: string;
}

/** A provider returns exactly one action; untyped assistant prose is invalid. */
export type ModelAction =
  | ToolCallAction
  | ProposeObjectAction
  | CheckpointAction
  | EscalateAction
  | RequestCompletionAction;

export interface ModelUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costMicros: number;
}

export interface ModelResponse {
  readonly schemaVersion: 1;
  readonly action: ModelAction;
  readonly usage: ModelUsage;
  readonly providerRequestId?: string;
}

export interface ModelInvocationContext {
  readonly signal: AbortSignal;
}

export interface ModelAdapter {
  readonly descriptor: ModelAdapterDescriptor;
  invoke(
    request: ModelRequest,
    context: ModelInvocationContext,
  ): Promise<ModelResponse>;
}

function plainRecord(value: unknown, label: string): Record<string, unknown> {
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
  keys: readonly string[],
  label: string,
): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new TypeError(`${label} contains unsupported field ${JSON.stringify(key)}`);
    }
  }
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return Number(value);
}

function positiveInteger(value: unknown, label: string): number {
  const result = nonNegativeInteger(value, label);
  if (result === 0) throw new TypeError(`${label} must be positive`);
  return result;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  return value.map((item, index) => nonEmptyString(item, `${label}[${index}]`));
}

function uniqueStringArray(value: unknown, label: string): string[] {
  const result = stringArray(value, label);
  if (new Set(result).size !== result.length) {
    throw new TypeError(`${label} cannot contain duplicates`);
  }
  return result;
}

function assertJson(value: unknown, label: string): asserts value is JsonValue {
  try {
    canonicalJson(value);
  } catch (error) {
    throw new TypeError(
      `${label} must be JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function assertNoSecretMaterial(value: unknown, label: string): void {
  if (canonicalJson(redactSecretValue(value)) !== canonicalJson(value)) {
    throw new TypeError(`${label} contains secret-like material`);
  }
}

function assertCredentialReferences(value: unknown, path = "configuration"): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertCredentialReferences(item, `${path}[${index}]`));
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/gu, "");
    const secretReference = normalized.endsWith("ref") &&
      ["credential", "secret", "token", "apikey", "authorization", "accesskey", "privatekey"]
        .some((part) => normalized.includes(part));
    if (secretReference) {
      if (
        typeof child !== "string" ||
        child.length > 256 ||
        !/^[a-z][a-z0-9+.-]*:[A-Za-z0-9_./:@-]+$/u.test(child) ||
        /^(?:sk|key|token|bearer)-/iu.test(child)
      ) {
        throw new TypeError(`${path}.${key} must be an opaque credential reference`);
      }
    } else {
      assertCredentialReferences(child, `${path}.${key}`);
    }
  }
}

export function assertModelAdapterDescriptor(
  descriptor: unknown,
): asserts descriptor is ModelAdapterDescriptor {
  const value = plainRecord(descriptor, "model adapter descriptor");
  allowedKeys(
    value,
    [
      "schemaVersion",
      "adapterId",
      "provider",
      "model",
      "version",
      "configuration",
      "requiredCapabilities",
      "reproducibility",
    ],
    "model adapter descriptor",
  );
  if (value.schemaVersion !== 1) {
    throw new TypeError("model adapter descriptor.schemaVersion must be 1");
  }
  nonEmptyString(value.adapterId, "model adapter descriptor.adapterId");
  nonEmptyString(value.provider, "model adapter descriptor.provider");
  nonEmptyString(value.model, "model adapter descriptor.model");
  nonEmptyString(value.version, "model adapter descriptor.version");
  assertJson(
    plainRecord(
      value.configuration,
      "model adapter descriptor.configuration",
    ),
    "model adapter descriptor.configuration",
  );
  const capabilities = uniqueStringArray(
    value.requiredCapabilities,
    "model adapter descriptor.requiredCapabilities",
  );
  const knownCapabilities = new Set<string>(TOOL_CAPABILITIES);
  for (const capability of capabilities) {
    if (!knownCapabilities.has(capability)) {
      throw new TypeError(`Unsupported model capability: ${capability}`);
    }
  }
  if (
    value.reproducibility !== "deterministic" &&
    value.reproducibility !== "seeded" &&
    value.reproducibility !== "nondeterministic" &&
    value.reproducibility !== "externally-sourced"
  ) {
    throw new TypeError("Unsupported model reproducibility declaration");
  }
  assertNoSecretMaterial(value, "model adapter descriptor");
  assertCredentialReferences(value.configuration);
}

export function assertModelAction(action: unknown): asserts action is ModelAction {
  const value = plainRecord(action, "model action");
  const kind = nonEmptyString(value.kind, "model action.kind");
  switch (kind) {
    case "tool-call":
      allowedKeys(value, ["kind", "toolId", "input", "timeoutMs"], "tool-call action");
      nonEmptyString(value.toolId, "tool-call action.toolId");
      assertJson(value.input, "tool-call action.input");
      if (value.timeoutMs !== undefined) {
        positiveInteger(value.timeoutMs, "tool-call action.timeoutMs");
      }
      break;
    case "propose-object": {
      allowedKeys(
        value,
        ["kind", "objectType", "content", "contextId"],
        "propose-object action",
      );
      const objectType = nonEmptyString(
        value.objectType,
        "propose-object action.objectType",
      );
      if (!(MODEL_PROPOSABLE_OBJECT_TYPES as readonly string[]).includes(objectType)) {
        throw new TypeError(`Model cannot propose object type: ${objectType}`);
      }
      const content = plainRecord(value.content, "propose-object action.content");
      assertJson(content, "propose-object action.content");
      if (value.contextId !== undefined) {
        nonEmptyString(value.contextId, "propose-object action.contextId");
      }
      break;
    }
    case "checkpoint":
      allowedKeys(
        value,
        ["kind", "summary", "nextSteps", "evidenceObjectIds"],
        "checkpoint action",
      );
      nonEmptyString(value.summary, "checkpoint action.summary");
      stringArray(value.nextSteps, "checkpoint action.nextSteps");
      uniqueStringArray(value.evidenceObjectIds, "checkpoint action.evidenceObjectIds");
      break;
    case "escalate":
      allowedKeys(
        value,
        [
          "kind",
          "attemptedApproaches",
          "evidenceObjectIds",
          "blocker",
          "requestedHumanInput",
        ],
        "escalate action",
      );
      if (
        stringArray(
          value.attemptedApproaches,
          "escalate action.attemptedApproaches",
        ).length === 0
      ) {
        throw new TypeError("escalate action.attemptedApproaches must not be empty");
      }
      uniqueStringArray(value.evidenceObjectIds, "escalate action.evidenceObjectIds");
      nonEmptyString(value.blocker, "escalate action.blocker");
      nonEmptyString(value.requestedHumanInput, "escalate action.requestedHumanInput");
      break;
    case "request-completion":
      allowedKeys(value, ["kind", "rationale"], "request-completion action");
      nonEmptyString(value.rationale, "request-completion action.rationale");
      break;
    default:
      throw new TypeError(`Unsupported model action kind: ${kind}`);
  }
  assertNoSecretMaterial(value, "model action");
}

export function validateModelResponse(response: unknown): ModelResponse {
  const value = plainRecord(response, "model response");
  allowedKeys(
    value,
    ["schemaVersion", "action", "usage", "providerRequestId"],
    "model response",
  );
  if (value.schemaVersion !== 1) {
    throw new TypeError("model response.schemaVersion must be 1");
  }
  assertModelAction(value.action);
  const usage = plainRecord(value.usage, "model response.usage");
  allowedKeys(usage, ["inputTokens", "outputTokens", "costMicros"], "model response.usage");
  nonNegativeInteger(usage.inputTokens, "model response.usage.inputTokens");
  nonNegativeInteger(usage.outputTokens, "model response.usage.outputTokens");
  nonNegativeInteger(usage.costMicros, "model response.usage.costMicros");
  if (value.providerRequestId !== undefined) {
    nonEmptyString(value.providerRequestId, "model response.providerRequestId");
  }
  assertNoSecretMaterial(value, "model response");
  return response as ModelResponse;
}

export function modelActionHash(action: ModelAction): string {
  assertModelAction(action);
  return computeContentHash(action as unknown as Record<string, unknown>);
}

export class ModelRegistry {
  readonly #adapters = new Map<string, ModelAdapter>();

  public register(adapter: ModelAdapter): this {
    assertModelAdapterDescriptor(adapter.descriptor);
    if (typeof adapter.invoke !== "function") {
      throw new TypeError("Model adapter.invoke must be a function");
    }
    const adapterId = adapter.descriptor.adapterId;
    if (this.#adapters.has(adapterId)) {
      throw new Error(`Model adapter already registered: ${adapterId}`);
    }
    this.#adapters.set(adapterId, adapter);
    return this;
  }

  public get(adapterId: string): ModelAdapter | undefined {
    return this.#adapters.get(adapterId);
  }

  public list(): ModelAdapter[] {
    return [...this.#adapters.values()].sort((left, right) =>
      left.descriptor.adapterId.localeCompare(right.descriptor.adapterId),
    );
  }
}

export interface ScriptedModelAdapterOptions {
  readonly adapterId?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly version?: string;
  readonly configuration?: Readonly<Record<string, JsonValue>>;
  readonly script: readonly (ModelAction | ModelResponse)[];
}

/** Deterministic, local adapter for tests, conformance, and offline demos. */
export class ScriptedModelAdapter implements ModelAdapter {
  public readonly descriptor: ModelAdapterDescriptor;
  readonly #script: readonly (ModelAction | ModelResponse)[];

  public constructor(options: ScriptedModelAdapterOptions) {
    if (!Array.isArray(options.script) || options.script.length === 0) {
      throw new TypeError("scripted model script must be a non-empty array");
    }
    for (const [index, item] of options.script.entries()) {
      if (isResponse(item)) validateModelResponse(item);
      else {
        try {
          assertModelAction(item);
        } catch (error) {
          throw new TypeError(
            `Invalid scripted model item ${index}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
    this.#script = structuredClone(options.script);
    const scriptDigest = computeContentHash({
      script: this.#script,
    } as unknown as Record<string, unknown>);
    this.descriptor = {
      schemaVersion: 1,
      adapterId: options.adapterId ?? "scripted.local",
      provider: options.provider ?? "local-scripted",
      model: options.model ?? "deterministic-script",
      version: options.version ?? "1.0.0",
      configuration: {
        ...structuredClone(options.configuration ?? {}),
        scriptDigest,
        scriptMode: "request-turn-indexed",
      },
      requiredCapabilities: [],
      reproducibility: "deterministic",
    };
    assertModelAdapterDescriptor(this.descriptor);
  }

  public async invoke(
    request: ModelRequest,
    context: ModelInvocationContext,
  ): Promise<ModelResponse> {
    if (context.signal.aborted) throw context.signal.reason ?? new Error("Model call aborted");
    const item = this.#script[request.turn - 1];
    if (item === undefined) throw new Error("Scripted model response sequence is exhausted");
    const response: ModelResponse = isResponse(item)
      ? structuredClone(item)
      : {
          schemaVersion: 1,
          action: structuredClone(item),
          usage: {
            inputTokens: request.estimatedInputTokens,
            outputTokens: Math.max(1, Math.ceil(canonicalJson(item).length / 4)),
            costMicros: 0,
          },
        };
    return validateModelResponse(response);
  }
}

function isResponse(value: ModelAction | ModelResponse): value is ModelResponse {
  return "schemaVersion" in value && "action" in value && "usage" in value;
}
