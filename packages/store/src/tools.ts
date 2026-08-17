import {
  REPRODUCIBILITY_KINDS,
  canonicalJson,
  type JsonValue,
  type ReproducibilityKind,
} from "@reasoning-workbench/project-format";

export const TOOL_CAPABILITIES = [
  "project.read",
  "project.write",
  "project.artifact.write",
  "filesystem.read",
  "filesystem.write",
  "process.execute",
  "network.access",
  "secrets.read",
  "compute.local",
  "compute.remote",
  "external.write",
  "spend",
] as const;

export type ToolCapability = (typeof TOOL_CAPABILITIES)[number];

export const TOOL_SIDE_EFFECTS = [
  "none",
  "project.write",
  "artifact.write",
  "filesystem.write",
  "process.execute",
  "network.access",
  "external.write",
  "spend",
] as const;

export type ToolSideEffect = (typeof TOOL_SIDE_EFFECTS)[number];

export const JSON_SCHEMA_TYPES = [
  "null",
  "boolean",
  "number",
  "integer",
  "string",
  "array",
  "object",
] as const;

export type JsonSchemaType = (typeof JSON_SCHEMA_TYPES)[number];

/**
 * Deliberately small, transport-independent JSON Schema subset used by local
 * tools. Unsupported keywords are rejected when a tool is registered rather
 * than being silently ignored.
 */
export type JsonSchema =
  | boolean
  | {
      readonly $id?: string;
      readonly $schema?: string;
      readonly title?: string;
      readonly description?: string;
      readonly type?: JsonSchemaType | readonly JsonSchemaType[];
      readonly properties?: Readonly<Record<string, JsonSchema>>;
      readonly required?: readonly string[];
      readonly additionalProperties?: boolean | JsonSchema;
      readonly items?: JsonSchema;
      readonly enum?: readonly JsonValue[];
      readonly const?: JsonValue;
      readonly minimum?: number;
      readonly maximum?: number;
      readonly exclusiveMinimum?: number;
      readonly exclusiveMaximum?: number;
      readonly minLength?: number;
      readonly maxLength?: number;
      readonly pattern?: string;
      readonly minItems?: number;
      readonly maxItems?: number;
    };

export interface ToolContract {
  readonly schemaVersion: 1;
  readonly toolId: string;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly outputSchema: JsonSchema;
  readonly requiredCapabilities: readonly ToolCapability[];
  readonly sideEffects: readonly ToolSideEffect[];
  readonly determinism: ReproducibilityKind;
  readonly supportsCancellation: boolean;
  readonly defaultTimeoutMs: number;
}

/** Bytes returned by a tool for the execution layer to hash and register. */
export interface ToolByteArtifact {
  readonly logicalName: string;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
  readonly reproducibility: ReproducibilityKind;
  readonly inputs?: readonly string[];
}

export interface ToolExecutionResult {
  readonly output: JsonValue;
  readonly artifacts?: readonly ToolByteArtifact[];
  /** Provider or compute cost in integer millionths of the project currency. */
  readonly costMicros?: number;
  /** Exact job-specific environment; the runtime promotes it to an environment object. */
  readonly environment?: Readonly<Record<string, JsonValue>>;
}

export interface ToolExecutionContext {
  readonly signal: AbortSignal;
  readonly executionId?: string;
  readonly projectRoot?: string;
  readonly branchId?: string;
  readonly workstreamId?: string;
}

export interface ToolDefinition {
  readonly contract: ToolContract;
  /**
   * Pure validation/normalization performed before a runtime reserves a run.
   * Use this for security-sensitive values that must never enter canonical
   * input in an unvalidated form.
   */
  readonly prepareInput?: (input: JsonValue) => JsonValue;
  readonly execute: (
    input: JsonValue,
    context: ToolExecutionContext,
  ) => Promise<ToolExecutionResult>;
}

export interface ToolAuthorization {
  readonly allowedToolIds: readonly string[];
  readonly grantedCapabilities: readonly ToolCapability[];
}

export interface JsonSchemaIssue {
  readonly path: string;
  readonly keyword: string;
  readonly message: string;
}

export class JsonSchemaValidationError extends TypeError {
  public readonly issues: readonly JsonSchemaIssue[];

  public constructor(label: string, issues: readonly JsonSchemaIssue[]) {
    super(
      `${label} does not match its JSON Schema: ${issues
        .map((issue) => `${issue.path || "/"}: ${issue.message}`)
        .join("; ")}`,
    );
    this.name = "JsonSchemaValidationError";
    this.issues = issues;
  }
}

export class ToolAuthorizationError extends Error {
  public readonly toolId: string;
  public readonly missingCapabilities: readonly ToolCapability[];

  public constructor(
    toolId: string,
    message: string,
    missingCapabilities: readonly ToolCapability[] = [],
  ) {
    super(message);
    this.name = "ToolAuthorizationError";
    this.toolId = toolId;
    this.missingCapabilities = missingCapabilities;
  }
}

export class ToolNotFoundError extends Error {
  public readonly toolId: string;

  public constructor(toolId: string) {
    super(`Unknown tool: ${toolId}`);
    this.name = "ToolNotFoundError";
    this.toolId = toolId;
  }
}

export class ToolExecutionAbortedError extends Error {
  public readonly reason: unknown;

  public constructor(reason?: unknown) {
    super("Tool execution was aborted");
    this.name = "AbortError";
    this.reason = reason;
  }
}

const capabilities = new Set<string>(TOOL_CAPABILITIES);
const sideEffects = new Set<string>(TOOL_SIDE_EFFECTS);
const reproducibilityKinds = new Set<string>(REPRODUCIBILITY_KINDS);
const schemaTypes = new Set<string>(JSON_SCHEMA_TYPES);
const schemaKeywords = new Set([
  "$id",
  "$schema",
  "title",
  "description",
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "const",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minLength",
  "maxLength",
  "pattern",
  "minItems",
  "maxItems",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(`${label} must be a plain object`);
  return value;
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
  const checked = nonNegativeInteger(value, label);
  if (checked === 0) throw new TypeError(`${label} must be positive`);
  return checked;
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${label} must be a finite number`);
  }
  return value;
}

function stringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  const result = value.map((entry, index) => nonEmptyString(entry, `${label}[${index}]`));
  if (new Set(result).size !== result.length) {
    throw new TypeError(`${label} cannot contain duplicates`);
  }
  return result;
}

function enumArray<T extends string>(
  value: unknown,
  allowed: ReadonlySet<string>,
  label: string,
  options: { readonly allowEmpty?: boolean } = {},
): readonly T[] {
  const result = stringArray(value, label);
  if (result.length === 0 && options.allowEmpty !== true) {
    throw new TypeError(`${label} cannot be empty`);
  }
  for (const entry of result) {
    if (!allowed.has(entry)) throw new TypeError(`${label} contains unsupported value ${entry}`);
  }
  return result as readonly T[];
}

function assertJsonDomain(value: unknown, label: string): asserts value is JsonValue {
  try {
    canonicalJson(value);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new TypeError(`${label} must be a JSON value: ${detail}`);
  }
}

function validateBounds(
  value: Record<string, unknown>,
  minimumKey: string,
  maximumKey: string,
  label: string,
  integer: boolean,
): void {
  const minimum = value[minimumKey];
  const maximum = value[maximumKey];
  if (minimum !== undefined) {
    if (integer) nonNegativeInteger(minimum, `${label}.${minimumKey}`);
    else finiteNumber(minimum, `${label}.${minimumKey}`);
  }
  if (maximum !== undefined) {
    if (integer) nonNegativeInteger(maximum, `${label}.${maximumKey}`);
    else finiteNumber(maximum, `${label}.${maximumKey}`);
  }
  if (minimum !== undefined && maximum !== undefined && Number(minimum) > Number(maximum)) {
    throw new TypeError(`${label}.${minimumKey} must be <= ${maximumKey}`);
  }
}

/** Validate a schema itself and reject every keyword this runtime cannot enforce. */
export function assertJsonSchema(schema: unknown, label = "JSON Schema"): asserts schema is JsonSchema {
  if (typeof schema === "boolean") return;
  const value = record(schema, label);

  for (const key of Object.keys(value).sort()) {
    if (!schemaKeywords.has(key)) {
      throw new TypeError(`${label} contains unsupported keyword ${JSON.stringify(key)}`);
    }
  }

  for (const key of ["$id", "$schema", "title", "description"] as const) {
    if (value[key] !== undefined) nonEmptyString(value[key], `${label}.${key}`);
  }

  if (value.type !== undefined) {
    const declared = Array.isArray(value.type) ? value.type : [value.type];
    enumArray<JsonSchemaType>(declared, schemaTypes, `${label}.type`);
  }

  if (value.properties !== undefined) {
    const properties = record(value.properties, `${label}.properties`);
    for (const key of Object.keys(properties).sort()) {
      assertJsonSchema(properties[key], `${label}.properties[${JSON.stringify(key)}]`);
    }
  }

  if (value.required !== undefined) stringArray(value.required, `${label}.required`);
  if (value.additionalProperties !== undefined) {
    assertJsonSchema(value.additionalProperties, `${label}.additionalProperties`);
  }
  if (value.items !== undefined) assertJsonSchema(value.items, `${label}.items`);

  if (value.enum !== undefined) {
    if (!Array.isArray(value.enum) || value.enum.length === 0) {
      throw new TypeError(`${label}.enum must be a non-empty array`);
    }
    const seen = new Set<string>();
    for (const [index, item] of value.enum.entries()) {
      assertJsonDomain(item, `${label}.enum[${index}]`);
      const canonical = canonicalJson(item);
      if (seen.has(canonical)) throw new TypeError(`${label}.enum cannot contain duplicates`);
      seen.add(canonical);
    }
  }
  if (Object.prototype.hasOwnProperty.call(value, "const")) {
    assertJsonDomain(value.const, `${label}.const`);
  }

  for (const key of ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"] as const) {
    if (value[key] !== undefined) finiteNumber(value[key], `${label}.${key}`);
  }
  validateBounds(value, "minimum", "maximum", label, false);
  validateBounds(value, "exclusiveMinimum", "exclusiveMaximum", label, false);
  validateBounds(value, "minLength", "maxLength", label, true);
  validateBounds(value, "minItems", "maxItems", label, true);
  if (value.pattern !== undefined) {
    const pattern = nonEmptyString(value.pattern, `${label}.pattern`);
    try {
      new RegExp(pattern, "u");
    } catch {
      throw new TypeError(`${label}.pattern must be a valid Unicode regular expression`);
    }
  }
}

function typeOfJson(value: unknown): JsonSchemaType | "non-json" {
  if (value === null) return "null";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  if (typeof value === "string") return "string";
  if (Array.isArray(value)) return "array";
  if (isRecord(value)) return "object";
  return "non-json";
}

function typeMatches(value: unknown, declared: JsonSchemaType): boolean {
  if (declared === "number") return typeof value === "number" && Number.isFinite(value);
  if (declared === "integer") return Number.isSafeInteger(value);
  return typeOfJson(value) === declared;
}

function pointer(path: string, segment: string | number): string {
  const escaped = String(segment).replaceAll("~", "~0").replaceAll("/", "~1");
  return `${path}/${escaped}`;
}

function issue(path: string, keyword: string, message: string): JsonSchemaIssue {
  return { path, keyword, message };
}

function validateValue(
  schema: JsonSchema,
  value: unknown,
  path: string,
  issues: JsonSchemaIssue[],
): void {
  if (schema === true) return;
  if (schema === false) {
    issues.push(issue(path, "falseSchema", "value is forbidden"));
    return;
  }

  if (schema.enum !== undefined) {
    let canonical: string;
    try {
      canonical = canonicalJson(value);
    } catch {
      canonical = "";
    }
    if (!schema.enum.some((entry) => canonicalJson(entry) === canonical)) {
      issues.push(issue(path, "enum", "value is not in the declared enum"));
    }
  }
  if (Object.prototype.hasOwnProperty.call(schema, "const")) {
    let matches = false;
    try {
      matches = canonicalJson(value) === canonicalJson(schema.const);
    } catch {
      matches = false;
    }
    if (!matches) issues.push(issue(path, "const", "value does not match const"));
  }

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((entry) => typeMatches(value, entry))) {
      issues.push(
        issue(path, "type", `expected ${types.join(" or ")}, received ${typeOfJson(value)}`),
      );
      return;
    }
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    if (schema.minimum !== undefined && value < schema.minimum) {
      issues.push(issue(path, "minimum", `must be >= ${schema.minimum}`));
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      issues.push(issue(path, "maximum", `must be <= ${schema.maximum}`));
    }
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) {
      issues.push(issue(path, "exclusiveMinimum", `must be > ${schema.exclusiveMinimum}`));
    }
    if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) {
      issues.push(issue(path, "exclusiveMaximum", `must be < ${schema.exclusiveMaximum}`));
    }
  }

  if (typeof value === "string") {
    const length = [...value].length;
    if (schema.minLength !== undefined && length < schema.minLength) {
      issues.push(issue(path, "minLength", `must contain at least ${schema.minLength} characters`));
    }
    if (schema.maxLength !== undefined && length > schema.maxLength) {
      issues.push(issue(path, "maxLength", `must contain at most ${schema.maxLength} characters`));
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, "u").test(value)) {
      issues.push(issue(path, "pattern", `must match /${schema.pattern}/u`));
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      issues.push(issue(path, "minItems", `must contain at least ${schema.minItems} items`));
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      issues.push(issue(path, "maxItems", `must contain at most ${schema.maxItems} items`));
    }
    if (schema.items !== undefined) {
      for (let index = 0; index < value.length; index += 1) {
        validateValue(schema.items, value[index], pointer(path, index), issues);
      }
    }
  }

  if (isRecord(value)) {
    const properties = schema.properties ?? {};
    const required = [...(schema.required ?? [])].sort();
    for (const key of required) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) {
        issues.push(issue(pointer(path, key), "required", "required property is missing"));
      }
    }
    for (const key of Object.keys(properties).sort()) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        validateValue(properties[key] ?? false, value[key], pointer(path, key), issues);
      }
    }
    for (const key of Object.keys(value).sort()) {
      if (Object.prototype.hasOwnProperty.call(properties, key)) continue;
      if (schema.additionalProperties === false) {
        issues.push(issue(pointer(path, key), "additionalProperties", "additional property is not allowed"));
      } else if (
        schema.additionalProperties !== undefined &&
        schema.additionalProperties !== true
      ) {
        validateValue(schema.additionalProperties, value[key], pointer(path, key), issues);
      }
    }
  }
}

/** Return all deterministic validation failures, ordered by schema and JSON key. */
export function validateJsonSchema(
  schema: JsonSchema,
  value: unknown,
): readonly JsonSchemaIssue[] {
  assertJsonSchema(schema);
  try {
    canonicalJson(value);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return [issue("", "json", detail)];
  }
  const issues: JsonSchemaIssue[] = [];
  validateValue(schema, value, "", issues);
  return issues;
}

export function assertJsonSchemaValue(
  schema: JsonSchema,
  value: unknown,
  label = "value",
): asserts value is JsonValue {
  const issues = validateJsonSchema(schema, value);
  if (issues.length > 0) throw new JsonSchemaValidationError(label, issues);
}

/** Validate a complete, provider-independent tool contract. */
export function assertToolContract(value: unknown): asserts value is ToolContract {
  const contract = record(value, "tool contract");
  const expectedKeys = new Set([
    "schemaVersion",
    "toolId",
    "name",
    "version",
    "description",
    "inputSchema",
    "outputSchema",
    "requiredCapabilities",
    "sideEffects",
    "determinism",
    "supportsCancellation",
    "defaultTimeoutMs",
  ]);
  for (const key of Object.keys(contract).sort()) {
    if (!expectedKeys.has(key)) {
      throw new TypeError(`tool contract contains unsupported field ${JSON.stringify(key)}`);
    }
  }
  for (const key of expectedKeys) {
    if (!Object.prototype.hasOwnProperty.call(contract, key)) {
      throw new TypeError(`tool contract.${key} is required`);
    }
  }

  if (contract.schemaVersion !== 1) throw new TypeError("tool contract.schemaVersion must be 1");
  const toolId = nonEmptyString(contract.toolId, "tool contract.toolId");
  if (!/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/.test(toolId)) {
    throw new TypeError("tool contract.toolId must be a lowercase dotted identifier");
  }
  nonEmptyString(contract.name, "tool contract.name");
  const version = nonEmptyString(contract.version, "tool contract.version");
  if (!/^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new TypeError("tool contract.version must be a semantic version");
  }
  nonEmptyString(contract.description, "tool contract.description");
  assertJsonSchema(contract.inputSchema, "tool contract.inputSchema");
  assertJsonSchema(contract.outputSchema, "tool contract.outputSchema");
  const requiredCapabilities = enumArray<ToolCapability>(
    contract.requiredCapabilities,
    capabilities,
    "tool contract.requiredCapabilities",
    { allowEmpty: true },
  );
  const declaredSideEffects = enumArray<ToolSideEffect>(
    contract.sideEffects,
    sideEffects,
    "tool contract.sideEffects",
  );
  if (declaredSideEffects.includes("none") && declaredSideEffects.length !== 1) {
    throw new TypeError('tool contract.sideEffects cannot combine "none" with another effect');
  }
  const capabilityByEffect: Partial<Record<ToolSideEffect, ToolCapability>> = {
    "project.write": "project.write",
    "artifact.write": "project.artifact.write",
    "filesystem.write": "filesystem.write",
    "process.execute": "process.execute",
    "network.access": "network.access",
    "external.write": "external.write",
    spend: "spend",
  };
  for (const effect of declaredSideEffects) {
    const capability = capabilityByEffect[effect];
    if (capability !== undefined && !requiredCapabilities.includes(capability)) {
      throw new TypeError(`tool contract side effect ${effect} requires capability ${capability}`);
    }
  }
  if (typeof contract.determinism !== "string" || !reproducibilityKinds.has(contract.determinism)) {
    throw new TypeError("tool contract.determinism is unsupported");
  }
  if (typeof contract.supportsCancellation !== "boolean") {
    throw new TypeError("tool contract.supportsCancellation must be boolean");
  }
  positiveInteger(contract.defaultTimeoutMs, "tool contract.defaultTimeoutMs");
}

function assertArtifact(value: unknown, index: number): asserts value is ToolByteArtifact {
  const artifact = record(value, `tool result.artifacts[${index}]`);
  const allowed = new Set(["logicalName", "mediaType", "bytes", "reproducibility", "inputs"]);
  for (const key of Object.keys(artifact)) {
    if (!allowed.has(key)) {
      throw new TypeError(`tool result.artifacts[${index}] contains unsupported field ${key}`);
    }
  }
  nonEmptyString(artifact.logicalName, `tool result.artifacts[${index}].logicalName`);
  nonEmptyString(artifact.mediaType, `tool result.artifacts[${index}].mediaType`);
  if (!(artifact.bytes instanceof Uint8Array)) {
    throw new TypeError(`tool result.artifacts[${index}].bytes must be Uint8Array`);
  }
  if (
    typeof artifact.reproducibility !== "string" ||
    !reproducibilityKinds.has(artifact.reproducibility)
  ) {
    throw new TypeError(`tool result.artifacts[${index}].reproducibility is unsupported`);
  }
  if (artifact.inputs !== undefined) {
    if (
      !Array.isArray(artifact.inputs) ||
      artifact.inputs.some((input) => typeof input !== "string" || input.length === 0)
    ) {
      throw new TypeError(`tool result.artifacts[${index}].inputs must be an array of strings`);
    }
  }
}

export function assertToolExecutionResult(
  contract: ToolContract,
  value: unknown,
): asserts value is ToolExecutionResult {
  const result = record(value, "tool result");
  const allowed = new Set(["output", "artifacts", "costMicros", "environment"]);
  for (const key of Object.keys(result)) {
    if (!allowed.has(key)) throw new TypeError(`tool result contains unsupported field ${key}`);
  }
  if (!Object.prototype.hasOwnProperty.call(result, "output")) {
    throw new TypeError("tool result.output is required");
  }
  assertJsonSchemaValue(contract.outputSchema, result.output, `${contract.toolId} output`);
  if (result.artifacts !== undefined) {
    if (!Array.isArray(result.artifacts)) throw new TypeError("tool result.artifacts must be an array");
    result.artifacts.forEach((artifact, index) => assertArtifact(artifact, index));
  }
  if (result.costMicros !== undefined) {
    nonNegativeInteger(result.costMicros, "tool result.costMicros");
  }
  if (result.environment !== undefined) {
    if (!isRecord(result.environment)) {
      throw new TypeError("tool result.environment must be a plain object");
    }
    canonicalJson(result.environment);
  }
}

/** Deny-by-default allow-list and capability-subset authorization. */
export function authorizeTool(contract: ToolContract, authorization: ToolAuthorization): void {
  assertToolContract(contract);
  const allowedToolIds = stringArray(authorization.allowedToolIds, "allowedToolIds");
  enumArray<ToolCapability>(
    authorization.grantedCapabilities,
    capabilities,
    "grantedCapabilities",
    { allowEmpty: true },
  );
  if (!allowedToolIds.includes(contract.toolId)) {
    throw new ToolAuthorizationError(
      contract.toolId,
      `Tool ${contract.toolId} is not present in the explicit allow-list`,
    );
  }
  const granted = new Set(authorization.grantedCapabilities);
  const missing = contract.requiredCapabilities.filter((capability) => !granted.has(capability));
  if (missing.length > 0) {
    throw new ToolAuthorizationError(
      contract.toolId,
      `Tool ${contract.toolId} requires missing capabilities: ${missing.join(", ")}`,
      missing,
    );
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new ToolExecutionAbortedError(signal.reason);
}

export class ToolRegistry {
  readonly #definitions = new Map<string, ToolDefinition>();

  public register(definition: ToolDefinition): this {
    if (!isRecord(definition)) throw new TypeError("tool definition must be a plain object");
    assertToolContract(definition.contract);
    if (typeof definition.execute !== "function") {
      throw new TypeError("tool definition.execute must be a function");
    }
    if (
      definition.prepareInput !== undefined &&
      typeof definition.prepareInput !== "function"
    ) {
      throw new TypeError("tool definition.prepareInput must be a function");
    }
    if (this.#definitions.has(definition.contract.toolId)) {
      throw new Error(`Tool ${definition.contract.toolId} is already registered`);
    }
    this.#definitions.set(definition.contract.toolId, definition);
    return this;
  }

  public get(toolId: string): ToolDefinition | undefined {
    return this.#definitions.get(toolId);
  }

  public list(): readonly ToolDefinition[] {
    return [...this.#definitions.values()].sort((left, right) =>
      left.contract.toolId.localeCompare(right.contract.toolId),
    );
  }

  public async execute(
    toolId: string,
    input: JsonValue,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    const definition = this.get(toolId);
    if (definition === undefined) throw new ToolNotFoundError(toolId);
    assertToolContract(definition.contract);
    throwIfAborted(context.signal);
    const prepared = definition.prepareInput?.(input) ?? input;
    assertJsonSchemaValue(definition.contract.inputSchema, prepared, `${toolId} input`);
    const result: unknown = await definition.execute(prepared, context);
    throwIfAborted(context.signal);
    assertToolExecutionResult(definition.contract, result);
    return result;
  }
}

function objectInput(input: JsonValue, toolId: string): Record<string, JsonValue> {
  if (!isRecord(input)) throw new TypeError(`${toolId} input must be an object`);
  return input as Record<string, JsonValue>;
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(new ToolExecutionAbortedError(signal.reason));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

const ECHO_CONTRACT: ToolContract = {
  schemaVersion: 1,
  toolId: "core.echo",
  name: "Echo",
  version: "1.0.0",
  description: "Return the supplied JSON value unchanged.",
  inputSchema: true,
  outputSchema: true,
  requiredCapabilities: [],
  sideEffects: ["none"],
  determinism: "deterministic",
  supportsCancellation: false,
  defaultTimeoutMs: 1_000,
};

const DELAY_CONTRACT: ToolContract = {
  schemaVersion: 1,
  toolId: "core.delay",
  name: "Delay",
  version: "1.0.0",
  description: "Wait for a bounded interval while supporting cancellation.",
  inputSchema: {
    type: "object",
    properties: {
      milliseconds: { type: "integer", minimum: 0, maximum: 60_000 },
    },
    required: ["milliseconds"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: { elapsedMilliseconds: { type: "integer", minimum: 0 } },
    required: ["elapsedMilliseconds"],
    additionalProperties: false,
  },
  requiredCapabilities: [],
  sideEffects: ["none"],
  determinism: "nondeterministic",
  supportsCancellation: true,
  defaultTimeoutMs: 60_500,
};

const TEXT_ARTIFACT_CONTRACT: ToolContract = {
  schemaVersion: 1,
  toolId: "core.text-artifact",
  name: "Text artifact",
  version: "1.0.0",
  description: "Encode text as artifact bytes for content-addressed registration.",
  inputSchema: {
    type: "object",
    properties: {
      text: { type: "string" },
      logicalName: { type: "string", minLength: 1, maxLength: 1_024 },
      mediaType: { type: "string", minLength: 1, maxLength: 255 },
    },
    required: ["text"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      logicalName: { type: "string", minLength: 1 },
      mediaType: { type: "string", minLength: 1 },
      size: { type: "integer", minimum: 0 },
    },
    required: ["logicalName", "mediaType", "size"],
    additionalProperties: false,
  },
  requiredCapabilities: ["project.artifact.write"],
  sideEffects: ["artifact.write"],
  determinism: "deterministic",
  supportsCancellation: false,
  defaultTimeoutMs: 5_000,
};

/** Small built-in registry used by conformance tests and the local runtime. */
export function createCoreToolRegistry(): ToolRegistry {
  return new ToolRegistry()
    .register({
      contract: ECHO_CONTRACT,
      async execute(input) {
        return { output: input };
      },
    })
    .register({
      contract: DELAY_CONTRACT,
      async execute(input, context) {
        const milliseconds = Number(objectInput(input, "core.delay").milliseconds);
        await abortableDelay(milliseconds, context.signal);
        return { output: { elapsedMilliseconds: milliseconds } };
      },
    })
    .register({
      contract: TEXT_ARTIFACT_CONTRACT,
      async execute(input) {
        const value = objectInput(input, "core.text-artifact");
        const text = String(value.text);
        const logicalName = value.logicalName === undefined ? "output.txt" : String(value.logicalName);
        const mediaType =
          value.mediaType === undefined ? "text/plain; charset=utf-8" : String(value.mediaType);
        const bytes = new TextEncoder().encode(text);
        return {
          output: { logicalName, mediaType, size: bytes.byteLength },
          artifacts: [{ logicalName, mediaType, bytes, reproducibility: "deterministic" }],
        };
      },
    });
}
