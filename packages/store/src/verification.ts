import { arch, platform } from "node:os";

import {
  canonicalJson,
  computeContentHash,
  type Actor,
  type ArtifactReference,
  type JsonValue,
  type ObjectEnvelope,
  type ReproducibilityKind,
} from "@reasoning-workbench/project-format";

import { FileSystemArtifactStore } from "./cas.js";
import { redactSecretValue } from "./context.js";
import {
  listVisibleArtifacts,
  VERIFICATION_ASSURANCE_LEVELS,
  VERIFICATION_DIMENSIONS,
  type PaperContextReference,
  type VerificationAssurance,
  type VerificationDimension,
  type VerificationOutcome,
} from "./paper.js";
import { addEdge, putObject } from "./project.js";
import {
  getObjectHistory,
  listBranches,
  listCurrentObjects,
  listEdges,
  type ObjectProjection,
} from "./projection.js";
import {
  assertJsonSchema,
  assertJsonSchemaValue,
  assertToolContract,
  TOOL_CAPABILITIES,
  type JsonSchema,
  type ToolCapability,
  type ToolSideEffect,
} from "./tools.js";

export const VERIFICATION_CHECK_STATUSES = [
  "passed",
  "failed",
  "inconclusive",
] as const;
export type VerificationCheckStatus = (typeof VERIFICATION_CHECK_STATUSES)[number];

export interface VerifierContract {
  readonly schemaVersion: 1;
  readonly verifierId: string;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly dimension: VerificationDimension;
  readonly assurance: VerificationAssurance;
  readonly inputSchema: JsonSchema;
  readonly requiredCapabilities: readonly ToolCapability[];
  readonly sideEffects: readonly ToolSideEffect[];
  readonly determinism: ReproducibilityKind;
  readonly supportsCancellation: boolean;
  readonly defaultTimeoutMs: number;
}

export interface VerificationCheck {
  readonly checkId: string;
  readonly status: VerificationCheckStatus;
  readonly summary: string;
  readonly evidence?: JsonValue;
}

export interface VerifierResultDraft {
  readonly summary: string;
  readonly checks: readonly VerificationCheck[];
  readonly assumptions?: readonly string[];
  readonly toolVersions?: Readonly<Record<string, string>>;
  readonly details?: JsonValue;
}

export interface VerifierResult extends VerifierResultDraft {
  readonly outcome: VerificationOutcome;
}

export interface VerifierExecutionContext {
  readonly signal: AbortSignal;
  readonly projectRoot: string;
  readonly branchId: string;
  readonly claimRef: PaperContextReference;
  readonly contextRef: PaperContextReference;
}

export interface VerifierDefinition {
  readonly contract: VerifierContract;
  readonly verify: (
    input: JsonValue,
    context: VerifierExecutionContext,
  ) => Promise<VerifierResultDraft>;
}

export interface VerifierAuthorization {
  readonly allowedVerifierIds: readonly string[];
  readonly grantedCapabilities: readonly ToolCapability[];
}

export interface RunVerificationOptions {
  readonly branchId: string;
  readonly claimId: string;
  readonly contextId: string;
  readonly verifierId: string;
  readonly input: JsonValue;
  readonly artifactIds?: readonly string[];
  readonly assumptionIds?: readonly string[];
  readonly authorization?: VerifierAuthorization;
  readonly timeoutMs?: number;
  readonly actor?: Actor;
}

export interface VerificationRunRecord {
  readonly run: ObjectEnvelope;
  readonly environment: ObjectEnvelope;
  readonly evidence: ObjectEnvelope;
  readonly edge: Awaited<ReturnType<typeof addEdge>>;
  readonly failure?: ObjectEnvelope;
  readonly result: VerifierResult;
}

export class VerifierNotFoundError extends Error {
  public constructor(verifierId: string) {
    super(`Unknown verifier: ${verifierId}`);
    this.name = "VerifierNotFoundError";
  }
}

export class VerifierAuthorizationError extends Error {
  public readonly missingCapabilities: readonly ToolCapability[];

  public constructor(message: string, missingCapabilities: readonly ToolCapability[] = []) {
    super(message);
    this.name = "VerifierAuthorizationError";
    this.missingCapabilities = missingCapabilities;
  }
}

export class VerificationRunError extends Error {
  public readonly runId: string;
  public readonly failureId: string;

  public constructor(message: string, runId: string, failureId: string) {
    super(message);
    this.name = "VerificationRunError";
    this.runId = runId;
    this.failureId = failureId;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  return value;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function uniqueStrings(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  const result = value.map((entry, index) =>
    stringValue(entry, `${label}[${index}]`),
  );
  if (new Set(result).size !== result.length) {
    throw new TypeError(`${label} cannot contain duplicates`);
  }
  return result.sort((left, right) => left.localeCompare(right));
}

function jsonClone<T extends JsonValue>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}

function secretFreeJson<T extends JsonValue>(value: T, label: string): T {
  const redacted = redactSecretValue(value);
  if (canonicalJson(redacted) !== canonicalJson(value)) {
    throw new TypeError(`${label} contains secret-like material`);
  }
  return jsonClone(value);
}

export function assertVerifierContract(value: unknown): asserts value is VerifierContract {
  const contract = record(value, "verifier contract");
  const keys = [
    "schemaVersion",
    "verifierId",
    "name",
    "version",
    "description",
    "dimension",
    "assurance",
    "inputSchema",
    "requiredCapabilities",
    "sideEffects",
    "determinism",
    "supportsCancellation",
    "defaultTimeoutMs",
  ];
  for (const key of Object.keys(contract)) {
    if (!keys.includes(key)) {
      throw new TypeError(`verifier contract contains unsupported field ${key}`);
    }
  }
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(contract, key)) {
      throw new TypeError(`verifier contract.${key} is required`);
    }
  }
  assertJsonSchema(contract.inputSchema, "verifier contract.inputSchema");
  if (!(VERIFICATION_DIMENSIONS as readonly unknown[]).includes(contract.dimension)) {
    throw new TypeError("verifier contract.dimension is unsupported");
  }
  if (!(VERIFICATION_ASSURANCE_LEVELS as readonly unknown[]).includes(contract.assurance)) {
    throw new TypeError("verifier contract.assurance is unsupported");
  }
  if (contract.assurance === "formal-kernel" && contract.dimension !== "formal") {
    throw new TypeError("formal-kernel assurance is valid only for the formal dimension");
  }
  assertToolContract({
    schemaVersion: contract.schemaVersion,
    toolId: contract.verifierId,
    name: contract.name,
    version: contract.version,
    description: contract.description,
    inputSchema: contract.inputSchema,
    outputSchema: true,
    requiredCapabilities: contract.requiredCapabilities,
    sideEffects: contract.sideEffects,
    determinism: contract.determinism,
    supportsCancellation: contract.supportsCancellation,
    defaultTimeoutMs: contract.defaultTimeoutMs,
  });
  canonicalJson(contract);
}

function normalizeCheck(value: unknown, index: number): VerificationCheck {
  const check = record(value, `verifier result.checks[${index}]`);
  for (const key of Object.keys(check)) {
    if (!["checkId", "status", "summary", "evidence"].includes(key)) {
      throw new TypeError(`verifier result.checks[${index}] contains unsupported field ${key}`);
    }
  }
  const status = stringValue(check.status, `verifier result.checks[${index}].status`);
  if (!(VERIFICATION_CHECK_STATUSES as readonly string[]).includes(status)) {
    throw new TypeError(`verifier result.checks[${index}].status is unsupported`);
  }
  const evidence = check.evidence === undefined
    ? undefined
    : secretFreeJson(check.evidence as JsonValue, `verifier result.checks[${index}].evidence`);
  return {
    checkId: stringValue(check.checkId, `verifier result.checks[${index}].checkId`),
    status: status as VerificationCheckStatus,
    summary: stringValue(check.summary, `verifier result.checks[${index}].summary`),
    ...(evidence === undefined ? {} : { evidence }),
  };
}

function normalizeVerifierResult(value: unknown): VerifierResult {
  const result = record(value, "verifier result");
  for (const key of Object.keys(result)) {
    if (!["summary", "checks", "assumptions", "toolVersions", "details"].includes(key)) {
      throw new TypeError(`verifier result contains unsupported field ${key}`);
    }
  }
  if (!Array.isArray(result.checks) || result.checks.length === 0) {
    throw new TypeError("verifier result.checks must be a non-empty array");
  }
  const checks = result.checks.map(normalizeCheck);
  if (new Set(checks.map((check) => check.checkId)).size !== checks.length) {
    throw new TypeError("verifier result.checks cannot contain duplicate checkId values");
  }
  const assumptions = uniqueStrings(result.assumptions, "verifier result.assumptions");
  const rawVersions = result.toolVersions === undefined
    ? {}
    : record(result.toolVersions, "verifier result.toolVersions");
  const toolVersions = Object.fromEntries(
    Object.entries(rawVersions)
      .map(([key, version]) => [
        stringValue(key, "verifier result.toolVersions key"),
        stringValue(version, `verifier result.toolVersions.${key}`),
      ] as const)
      .sort(([left], [right]) => left.localeCompare(right)),
  );
  const details = result.details === undefined
    ? undefined
    : secretFreeJson(result.details as JsonValue, "verifier result.details");
  const normalized = {
    summary: stringValue(result.summary, "verifier result.summary"),
    checks,
    assumptions,
    toolVersions,
    ...(details === undefined ? {} : { details }),
  };
  secretFreeJson(normalized as unknown as JsonValue, "verifier result");
  const outcome: VerificationOutcome = checks.some((check) => check.status === "failed")
    ? "failed"
    : checks.some((check) => check.status === "inconclusive")
      ? "inconclusive"
      : "passed";
  return { ...normalized, outcome };
}

export function authorizeVerifier(
  contract: VerifierContract,
  authorization: VerifierAuthorization,
): void {
  assertVerifierContract(contract);
  const allowed = uniqueStrings(authorization.allowedVerifierIds, "allowedVerifierIds");
  const grantedCapabilities = uniqueStrings(
    authorization.grantedCapabilities,
    "grantedCapabilities",
  );
  for (const capability of grantedCapabilities) {
    if (!(TOOL_CAPABILITIES as readonly string[]).includes(capability)) {
      throw new VerifierAuthorizationError(`Unsupported verifier capability: ${capability}`);
    }
  }
  if (!allowed.includes(contract.verifierId)) {
    throw new VerifierAuthorizationError(
      `Verifier ${contract.verifierId} is not present in the explicit allow-list`,
    );
  }
  const granted = new Set(grantedCapabilities);
  const missing = contract.requiredCapabilities.filter((capability) => !granted.has(capability));
  if (missing.length > 0) {
    throw new VerifierAuthorizationError(
      `Verifier ${contract.verifierId} requires missing capabilities: ${missing.join(", ")}`,
      missing,
    );
  }
}

export class VerifierRegistry {
  readonly #definitions = new Map<string, VerifierDefinition>();

  public register(definition: VerifierDefinition): this {
    if (!isRecord(definition)) throw new TypeError("verifier definition must be an object");
    assertVerifierContract(definition.contract);
    if (typeof definition.verify !== "function") {
      throw new TypeError("verifier definition.verify must be a function");
    }
    if (this.#definitions.has(definition.contract.verifierId)) {
      throw new Error(`Verifier ${definition.contract.verifierId} is already registered`);
    }
    this.#definitions.set(definition.contract.verifierId, definition);
    return this;
  }

  public get(verifierId: string): VerifierDefinition | undefined {
    return this.#definitions.get(verifierId);
  }

  public list(): readonly VerifierDefinition[] {
    return [...this.#definitions.values()].sort((left, right) =>
      left.contract.verifierId.localeCompare(right.contract.verifierId),
    );
  }

  public async execute(
    verifierId: string,
    input: JsonValue,
    context: VerifierExecutionContext,
  ): Promise<VerifierResult> {
    const definition = this.get(verifierId);
    if (definition === undefined) throw new VerifierNotFoundError(verifierId);
    if (context.signal.aborted) throw context.signal.reason ?? new Error("Verification aborted");
    assertJsonSchemaValue(definition.contract.inputSchema, input, `${verifierId} input`);
    const result = normalizeVerifierResult(await definition.verify(jsonClone(input), context));
    if (definition.contract.assurance === "formal-kernel") {
      const required = [
        "kernel-build",
        "proof-holes",
        "axiom-audit",
        "dependency-graph",
        "compiler-output",
      ];
      const supplied = new Set(result.checks.map((check) => check.checkId));
      const missing = required.filter((checkId) => !supplied.has(checkId));
      if (missing.length > 0) {
        throw new TypeError(`formal-kernel result is missing required checks: ${missing.join(", ")}`);
      }
    }
    if (context.signal.aborted) throw context.signal.reason ?? new Error("Verification aborted");
    return result;
  }
}

function branchObjects(projectRoot: string, branchId: string): Map<string, ObjectProjection> {
  if (!listBranches(projectRoot).some((branch) => branch.branchId === branchId)) {
    throw new Error(`Branch does not exist: ${branchId}`);
  }
  return new Map(
    listCurrentObjects(projectRoot, branchId).map((object) => [object.objectId, object]),
  );
}

function exactObject(
  objects: ReadonlyMap<string, ObjectProjection>,
  objectId: string,
  objectType: string,
): ObjectProjection {
  const object = objects.get(objectId);
  if (object === undefined || object.objectType !== objectType) {
    throw new Error(`${objectType} ${objectId} is not visible on the branch`);
  }
  return object;
}

function actorOption(actor: Actor | undefined): { actor?: Actor } {
  return actor === undefined ? {} : { actor };
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const redacted = redactSecretValue(message);
  return typeof redacted === "string" ? redacted : "Verifier execution failed";
}

export async function runVerification(
  projectRoot: string,
  registry: VerifierRegistry,
  options: RunVerificationOptions,
): Promise<VerificationRunRecord> {
  const definition = registry.get(options.verifierId);
  if (definition === undefined) throw new VerifierNotFoundError(options.verifierId);
  const contract = definition.contract;
  authorizeVerifier(contract, options.authorization ?? {
    allowedVerifierIds: [contract.verifierId],
    grantedCapabilities: [],
  });
  assertJsonSchemaValue(contract.inputSchema, options.input, `${contract.verifierId} input`);
  const timeoutMs = options.timeoutMs ?? contract.defaultTimeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("timeoutMs must be a positive safe integer");
  }

  const objects = branchObjects(projectRoot, options.branchId);
  const claim = exactObject(objects, options.claimId, "claim");
  const context = exactObject(objects, options.contextId, "context");
  const declaredContext = isRecord(claim.content) ? claim.content.contextId : undefined;
  if (typeof declaredContext === "string" && declaredContext !== context.objectId) {
    throw new Error(`Claim ${claim.objectId} is scoped to context ${declaredContext}`);
  }
  const assumptionIds = uniqueStrings(options.assumptionIds, "assumptionIds");
  const assumptions = assumptionIds.map((objectId) => {
    const object = exactObject(objects, objectId, "assumption");
    return { objectId: object.objectId, versionId: object.versionId };
  });
  const artifactIds = uniqueStrings(options.artifactIds, "artifactIds");
  const visibleArtifacts = new Map(
    (await listVisibleArtifacts(projectRoot, options.branchId)).map((artifact) => [
      artifact.artifactId,
      artifact,
    ]),
  );
  const artifacts = artifactIds.map((artifactId) => {
    const artifact = visibleArtifacts.get(artifactId);
    if (artifact === undefined) {
      throw new Error(`Artifact ${artifactId} is not visible on branch ${options.branchId}`);
    }
    return artifact;
  });
  if (contract.verifierId === "core.artifact-integrity") {
    const inputArtifactIds = isRecord(options.input)
      ? uniqueStrings(options.input.artifactIds as string[] | undefined, "input.artifactIds")
      : [];
    if (canonicalJson(inputArtifactIds) !== canonicalJson(artifactIds)) {
      throw new Error(
        "core.artifact-integrity input.artifactIds must exactly match declared artifactIds",
      );
    }
  }
  const claimRef = { objectId: claim.objectId, versionId: claim.versionId };
  const contextRef = { objectId: context.objectId, versionId: context.versionId };
  const input = secretFreeJson(options.input, "verification input");
  const environment = await putObject(projectRoot, {
    branchId: options.branchId,
    objectType: "environment",
    content: {
      schemaVersion: 1,
      kind: "verifier-environment",
      runtime: { node: process.version, platform: platform(), architecture: arch() },
      verifier: contract,
      verifierDigest: computeContentHash(contract),
    },
    ...actorOption(options.actor),
  });
  let run = await putObject(projectRoot, {
    branchId: options.branchId,
    objectType: "run",
    content: {
      schemaVersion: 1,
      kind: "verification-run",
      status: "running",
      verifier: contract,
      verifierDigest: computeContentHash(contract),
      claimRef,
      contextRef,
      inputs: { assumptions, artifacts, value: input, valueDigest: computeContentHash(input) },
      permissions: {
        allowedVerifierIds: options.authorization?.allowedVerifierIds ?? [contract.verifierId],
        grantedCapabilities: options.authorization?.grantedCapabilities ?? [],
      },
      environmentId: environment.objectId,
      nondeterminism: contract.determinism,
    },
    ...actorOption(options.actor),
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("Verifier timed out")), timeoutMs);
  try {
    const result = await registry.execute(contract.verifierId, input, {
      signal: controller.signal,
      projectRoot,
      branchId: options.branchId,
      claimRef,
      contextRef,
    });
    run = await putObject(projectRoot, {
      branchId: options.branchId,
      objectId: run.objectId,
      objectType: "run",
      content: {
        ...(run.content as Record<string, unknown>),
        status: result.outcome === "passed" ? "succeeded" : "failed",
        result,
        resultDigest: computeContentHash(result),
      },
      ...actorOption(options.actor),
    });
    const evidence = await putObject(projectRoot, {
      branchId: options.branchId,
      objectType: "evidence",
      content: {
        schemaVersion: 1,
        kind: "verification-result",
        dimension: contract.dimension,
        assurance: contract.assurance,
        outcome: result.outcome,
        summary: result.summary,
        checks: result.checks,
        assumptions: result.assumptions ?? [],
        toolVersions: result.toolVersions ?? {},
        ...(result.details === undefined ? {} : { details: result.details }),
        claimRef,
        contextRef,
        artifacts,
        provenance: {
          producedByRunId: run.objectId,
          environmentId: environment.objectId,
          verifierId: contract.verifierId,
          verifierVersion: contract.version,
          verifierDigest: computeContentHash(contract),
          inputDigest: computeContentHash(input),
          resultDigest: computeContentHash(result),
          reproducibility: contract.determinism,
        },
      },
      ...actorOption(options.actor),
    });
    const edgeType = result.outcome === "passed"
      ? "supports"
      : result.outcome === "failed"
        ? "refutes"
        : "tested_by";
    const edge = await addEdge(projectRoot, {
      branchId: options.branchId,
      edgeType,
      ...(edgeType === "tested_by"
        ? { fromObjectId: claim.objectId, toObjectId: evidence.objectId }
        : { fromObjectId: evidence.objectId, toObjectId: claim.objectId }),
      contextId: context.objectId,
      metadata: {
        verificationDimension: contract.dimension,
        assurance: contract.assurance,
        outcome: result.outcome,
        verifierId: contract.verifierId,
      },
      ...actorOption(options.actor),
    });
    const failure = result.outcome === "passed"
      ? undefined
      : await putObject(projectRoot, {
          branchId: options.branchId,
          objectType: "failure",
          content: {
            schemaVersion: 1,
            kind: "verification-gap",
            status: "open",
            claimRef,
            contextRef,
            evidenceRef: { objectId: evidence.objectId, versionId: evidence.versionId },
            verifierId: contract.verifierId,
            outcome: result.outcome,
            failedCheckIds: result.checks
              .filter((check) => check.status !== "passed")
              .map((check) => check.checkId),
          },
          ...actorOption(options.actor),
        });
    return { run, environment, evidence, edge, ...(failure === undefined ? {} : { failure }), result };
  } catch (error) {
    const message = safeErrorMessage(error);
    run = await putObject(projectRoot, {
      branchId: options.branchId,
      objectId: run.objectId,
      objectType: "run",
      content: { ...(run.content as Record<string, unknown>), status: "failed", error: message },
      ...actorOption(options.actor),
    });
    const failure = await putObject(projectRoot, {
      branchId: options.branchId,
      objectType: "failure",
      content: {
        schemaVersion: 1,
        kind: "verifier-execution-failure",
        status: "open",
        claimRef,
        contextRef,
        runRef: { objectId: run.objectId, versionId: run.versionId },
        verifierId: contract.verifierId,
        message,
      },
      ...actorOption(options.actor),
    });
    throw new VerificationRunError(message, run.objectId, failure.objectId);
  } finally {
    clearTimeout(timer);
  }
}

const REPORT_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    summary: { type: "string", minLength: 1 },
    checks: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        properties: {
          checkId: { type: "string", minLength: 1 },
          status: { enum: [...VERIFICATION_CHECK_STATUSES] },
          summary: { type: "string", minLength: 1 },
          evidence: true,
        },
        required: ["checkId", "status", "summary"],
        additionalProperties: false,
      },
    },
    assumptions: { type: "array", items: { type: "string", minLength: 1 } },
    toolVersions: { type: "object", additionalProperties: { type: "string", minLength: 1 } },
    details: true,
  },
  required: ["summary", "checks"],
  additionalProperties: false,
};

const REPORT_REQUIREMENTS: Readonly<Record<string, readonly string[]>> = {
  "core.code-report": [
    "unit-tests",
    "property-tests",
    "golden-tests",
    "static-analysis",
    "clean-environment",
  ],
  "core.symbolic-report": [
    "equivalence",
    "domain-assumptions",
    "simplification-trace",
    "counterexamples",
  ],
  "core.numerical-report": [
    "convergence",
    "sensitivity",
    "stability",
    "precision",
    "independent-implementation",
    "uncertainty-propagation",
  ],
  "core.physical-report": [
    "units",
    "index-contractions",
    "symmetry",
    "conservation",
    "limiting-cases",
    "perturbation-order",
  ],
  "core.citation-report": ["exact-location", "support", "compatible-assumptions"],
  "core.formal-report": [
    "kernel-build",
    "proof-holes",
    "axiom-audit",
    "dependency-graph",
    "compiler-output",
  ],
};

function reportVerifier(
  verifierId: keyof typeof REPORT_REQUIREMENTS,
  dimension: VerificationDimension,
): VerifierDefinition {
  const requirements = REPORT_REQUIREMENTS[verifierId]!;
  return {
    contract: {
      schemaVersion: 1,
      verifierId,
      name: verifierId.replace("core.", "").replace("-report", " report"),
      version: "1.0.0",
      description: "Validate a complete structured verifier report without upgrading it to proof.",
      dimension,
      assurance: "reported",
      inputSchema: REPORT_SCHEMA,
      requiredCapabilities: [],
      sideEffects: ["none"],
      determinism: "deterministic",
      supportsCancellation: false,
      defaultTimeoutMs: 5_000,
    },
    async verify(input) {
      const value = input as Record<string, JsonValue>;
      const supplied = (value.checks as unknown as VerificationCheck[]).map((check) => ({ ...check }));
      const byId = new Map(supplied.map((check) => [check.checkId, check]));
      const missing = requirements
        .filter((checkId) => !byId.has(checkId))
        .map((checkId): VerificationCheck => ({
          checkId,
          status: "failed",
          summary: `Required check ${checkId} is missing from the report.`,
        }));
      return {
        summary: String(value.summary),
        checks: [...supplied, ...missing].sort((left, right) =>
          left.checkId.localeCompare(right.checkId),
        ),
        assumptions: (value.assumptions as string[] | undefined) ?? [],
        toolVersions: (value.toolVersions as Record<string, string> | undefined) ?? {},
        ...(value.details === undefined ? {} : { details: value.details }),
      };
    },
  };
}

const ARTIFACT_INTEGRITY_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    artifactIds: {
      type: "array",
      minItems: 1,
      items: { type: "string", minLength: 1 },
    },
  },
  required: ["artifactIds"],
  additionalProperties: false,
};

function artifactIntegrityVerifier(): VerifierDefinition {
  return {
    contract: {
      schemaVersion: 1,
      verifierId: "core.artifact-integrity",
      name: "Artifact integrity",
      version: "1.0.0",
      description: "Verify visible CAS blobs and their run/environment lineage.",
      dimension: "reproducibility",
      assurance: "machine-checked",
      inputSchema: ARTIFACT_INTEGRITY_SCHEMA,
      requiredCapabilities: [],
      sideEffects: ["none"],
      determinism: "deterministic",
      supportsCancellation: false,
      defaultTimeoutMs: 10_000,
    },
    async verify(input, context) {
      const artifactIds = uniqueStrings(
        (input as Record<string, JsonValue>).artifactIds as string[],
        "artifactIds",
      );
      const visible = new Map(
        (await listVisibleArtifacts(context.projectRoot, context.branchId)).map((artifact) => [
          artifact.artifactId,
          artifact,
        ]),
      );
      const objects = branchObjects(context.projectRoot, context.branchId);
      const store = new FileSystemArtifactStore(context.projectRoot);
      const checks: VerificationCheck[] = [];
      for (const artifactId of artifactIds) {
        const artifact = visible.get(artifactId);
        if (artifact === undefined) {
          checks.push({ checkId: artifactId, status: "failed", summary: "Artifact is not branch-visible." });
          continue;
        }
        const verified = await store.verify(artifact.digest);
        const run = objects.get(artifact.producedByRunId);
        const environment = objects.get(artifact.environmentId);
        const valid = verified.valid &&
          verified.size === artifact.size &&
          run?.objectType === "run" &&
          environment?.objectType === "environment";
        checks.push({
          checkId: artifactId,
          status: valid ? "passed" : "failed",
          summary: valid
            ? "CAS digest, size, producing run, and environment are valid."
            : "CAS integrity or producing run/environment lineage is invalid.",
          evidence: {
            digest: artifact.digest,
            size: artifact.size,
            producedByRunId: artifact.producedByRunId,
            environmentId: artifact.environmentId,
            reproducibility: artifact.reproducibility,
          },
        });
      }
      return {
        summary: checks.every((check) => check.status === "passed")
          ? "All requested artifacts passed integrity and lineage checks."
          : "At least one requested artifact failed integrity or lineage checks.",
        checks,
        toolVersions: { openreason: "stage-8", hash: "sha256" },
      };
    },
  };
}

export function createCoreVerifierRegistry(): VerifierRegistry {
  return new VerifierRegistry()
    .register(artifactIntegrityVerifier())
    .register(reportVerifier("core.code-report", "logical"))
    .register(reportVerifier("core.symbolic-report", "symbolic"))
    .register(reportVerifier("core.numerical-report", "numerical"))
    .register(reportVerifier("core.physical-report", "physical"))
    .register(reportVerifier("core.citation-report", "source"))
    .register(reportVerifier("core.formal-report", "formal"));
}

export interface IndependentReviewPacketEntry {
  readonly objectId: string;
  readonly versionId: string;
  readonly objectType: string;
  readonly contentHash: string;
  readonly content: JsonValue;
}

export interface IndependentReviewPacket {
  readonly schemaVersion: 1;
  readonly kind: "independent-review-packet";
  readonly branchId: string;
  readonly problem?: IndependentReviewPacketEntry;
  readonly claim: IndependentReviewPacketEntry;
  readonly context: IndependentReviewPacketEntry;
  readonly evidence: readonly IndependentReviewPacketEntry[];
  readonly sources: readonly IndependentReviewPacketEntry[];
  readonly digest: string;
}

function assertPacketEntry(value: unknown, label: string): asserts value is IndependentReviewPacketEntry {
  const entry = record(value, label);
  const keys = ["objectId", "versionId", "objectType", "contentHash", "content"];
  for (const key of Object.keys(entry)) {
    if (!keys.includes(key)) throw new TypeError(`${label} contains unsupported field ${key}`);
  }
  for (const key of ["objectId", "versionId", "objectType", "contentHash"] as const) {
    stringValue(entry[key], `${label}.${key}`);
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(String(entry.contentHash))) {
    throw new TypeError(`${label}.contentHash must be a SHA-256 digest`);
  }
  canonicalJson(entry.content);
}

export function assertIndependentReviewPacket(
  value: unknown,
): asserts value is IndependentReviewPacket {
  const packet = record(value, "independent review packet");
  const keys = [
    "schemaVersion",
    "kind",
    "branchId",
    "problem",
    "claim",
    "context",
    "evidence",
    "sources",
    "digest",
  ];
  for (const key of Object.keys(packet)) {
    if (!keys.includes(key)) {
      throw new TypeError(`independent review packet contains unsupported field ${key}`);
    }
  }
  if (packet.schemaVersion !== 1 || packet.kind !== "independent-review-packet") {
    throw new TypeError("independent review packet schemaVersion/kind is unsupported");
  }
  stringValue(packet.branchId, "independent review packet.branchId");
  stringValue(packet.digest, "independent review packet.digest");
  if (!/^sha256:[0-9a-f]{64}$/.test(String(packet.digest))) {
    throw new TypeError("independent review packet.digest must be a SHA-256 digest");
  }
  if (packet.problem !== undefined) assertPacketEntry(packet.problem, "independent review packet.problem");
  assertPacketEntry(packet.claim, "independent review packet.claim");
  assertPacketEntry(packet.context, "independent review packet.context");
  for (const key of ["evidence", "sources"] as const) {
    const entries = packet[key];
    if (!Array.isArray(entries)) throw new TypeError(`independent review packet.${key} must be an array`);
    entries.forEach((entry, index) => assertPacketEntry(entry, `independent review packet.${key}[${index}]`));
    const ids = entries.map((entry) => entry.objectId);
    if (new Set(ids).size !== ids.length) {
      throw new TypeError(`independent review packet.${key} cannot contain duplicates`);
    }
  }
}

const SELF_ASSESSMENT_KEY = /(?:confidence|certainty|self.?assessment|persuasi|author.?verdict|model.?score)/iu;

function reviewerContent(value: unknown): JsonValue {
  if (Array.isArray(value)) return value.map(reviewerContent);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !SELF_ASSESSMENT_KEY.test(key))
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, reviewerContent(entry)]),
    ) as JsonValue;
  }
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) {
    return value as JsonValue;
  }
  return String(value);
}

function packetEntry(object: ObjectProjection): IndependentReviewPacketEntry {
  const content = reviewerContent(redactSecretValue(object.content));
  return {
    objectId: object.objectId,
    versionId: object.versionId,
    objectType: object.objectType,
    contentHash: object.contentHash,
    content,
  };
}

export function createIndependentReviewPacket(
  projectRoot: string,
  options: {
    branchId: string;
    claimId: string;
    contextId: string;
    problemId?: string;
    evidenceObjectIds?: readonly string[];
    sourceObjectIds?: readonly string[];
  },
): IndependentReviewPacket {
  const objects = branchObjects(projectRoot, options.branchId);
  const claim = exactObject(objects, options.claimId, "claim");
  const context = exactObject(objects, options.contextId, "context");
  const edges = listEdges(projectRoot, options.branchId);
  const linkedEvidence = edges.flatMap((edge) => {
    if (
      (edge.edgeType === "supports" || edge.edgeType === "refutes") &&
      edge.toObjectId === claim.objectId &&
      edge.toVersionId === claim.versionId &&
      edge.envelope.contextId === context.objectId
    ) return [edge.fromObjectId];
    if (
      edge.edgeType === "tested_by" &&
      edge.fromObjectId === claim.objectId &&
      edge.fromVersionId === claim.versionId &&
      edge.envelope.contextId === context.objectId
    ) {
      return [edge.toObjectId];
    }
    return [];
  });
  const linkedSources = edges.flatMap((edge) =>
    edge.edgeType === "cites" &&
      edge.fromObjectId === claim.objectId &&
      edge.fromVersionId === claim.versionId &&
      edge.envelope.contextId === context.objectId
      ? [edge.toObjectId]
      : [],
  );
  const evidenceIds = uniqueStrings(
    options.evidenceObjectIds ?? linkedEvidence,
    "evidenceObjectIds",
  );
  const sourceIds = uniqueStrings(options.sourceObjectIds ?? linkedSources, "sourceObjectIds");
  const problem = options.problemId === undefined
    ? [...objects.values()].find((object) => object.objectType === "problem")
    : exactObject(objects, options.problemId, "problem");
  const base = {
    schemaVersion: 1 as const,
    kind: "independent-review-packet" as const,
    branchId: options.branchId,
    ...(problem === undefined ? {} : { problem: packetEntry(problem) }),
    claim: packetEntry(claim),
    context: packetEntry(context),
    evidence: evidenceIds.map((id) => packetEntry(exactObject(objects, id, "evidence"))),
    sources: sourceIds.map((id) => packetEntry(exactObject(objects, id, "source"))),
  };
  return { ...base, digest: computeContentHash(base) };
}

export interface IndependentReviewObjection {
  readonly objectionId: string;
  readonly statement: string;
  readonly status: "open" | "resolved";
  readonly evidenceObjectIds?: readonly string[];
}

export interface RecordIndependentReviewOptions {
  readonly branchId: string;
  readonly packet: IndependentReviewPacket;
  readonly reviewer: {
    readonly reviewerId: string;
    readonly kind: "human" | "model";
    readonly modelFamily?: string;
    readonly freshContext: boolean;
    readonly adversarial: boolean;
    readonly spotCheckSeed?: number;
    readonly spotCheckedEvidenceObjectIds?: readonly string[];
  };
  readonly summary: string;
  readonly evidenceObjectIds: readonly string[];
  readonly objections?: readonly IndependentReviewObjection[];
  readonly actor?: Actor;
}

export interface RecordedIndependentReview {
  readonly review: ObjectEnvelope;
  readonly edge: Awaited<ReturnType<typeof addEdge>>;
  readonly outcome: VerificationOutcome;
  readonly failure?: ObjectEnvelope;
}

function packetDigest(packet: IndependentReviewPacket): string {
  const { digest: _digest, ...base } = packet;
  return computeContentHash(base);
}

export async function recordIndependentReview(
  projectRoot: string,
  options: RecordIndependentReviewOptions,
): Promise<RecordedIndependentReview> {
  assertIndependentReviewPacket(options.packet);
  record(options.reviewer, "reviewer");
  if (options.objections !== undefined && !Array.isArray(options.objections)) {
    throw new TypeError("objections must be an array");
  }
  if (packetDigest(options.packet) !== options.packet.digest) {
    throw new Error("Independent review packet digest is invalid");
  }
  if (options.packet.branchId !== options.branchId) {
    throw new Error("Independent review packet belongs to another branch");
  }
  const objects = branchObjects(projectRoot, options.branchId);
  const claim = exactObject(objects, options.packet.claim.objectId, "claim");
  const context = exactObject(objects, options.packet.context.objectId, "context");
  if (
    claim.versionId !== options.packet.claim.versionId ||
    context.versionId !== options.packet.context.versionId
  ) {
    throw new Error("Independent review packet is stale");
  }
  for (const entry of [
    ...(options.packet.problem === undefined ? [] : [options.packet.problem]),
    ...options.packet.evidence,
    ...options.packet.sources,
  ]) {
    const current = objects.get(entry.objectId);
    if (
      current === undefined ||
      current.objectType !== entry.objectType ||
      current.versionId !== entry.versionId ||
      current.contentHash !== entry.contentHash
    ) {
      throw new Error(`Independent review packet is stale at ${entry.objectId}`);
    }
  }
  const reviewerId = stringValue(options.reviewer.reviewerId, "reviewer.reviewerId");
  if (options.reviewer.kind !== "human" && options.reviewer.kind !== "model") {
    throw new TypeError("reviewer.kind must be human or model");
  }
  if (
    typeof options.reviewer.freshContext !== "boolean" ||
    typeof options.reviewer.adversarial !== "boolean"
  ) {
    throw new TypeError("reviewer freshContext and adversarial must be boolean");
  }
  if (options.reviewer.modelFamily !== undefined) {
    stringValue(options.reviewer.modelFamily, "reviewer.modelFamily");
  }
  if (options.reviewer.kind === "model" && options.reviewer.modelFamily === undefined) {
    throw new TypeError("A model reviewer must declare reviewer.modelFamily");
  }
  const authorFamily = isRecord(claim.content) && typeof claim.content.authorModelFamily === "string"
    ? claim.content.authorModelFamily
    : undefined;
  if (
    authorFamily !== undefined &&
    options.reviewer.modelFamily !== undefined &&
    authorFamily === options.reviewer.modelFamily
  ) {
    throw new Error("Independent model reviewer must use a different model family");
  }
  const allowedEvidenceIds = new Set(options.packet.evidence.map((entry) => entry.objectId));
  const evidenceObjectIds = uniqueStrings(options.evidenceObjectIds, "evidenceObjectIds");
  for (const id of evidenceObjectIds) {
    if (!allowedEvidenceIds.has(id)) {
      throw new Error(`Review cites evidence ${id} that is absent from its packet`);
    }
  }
  const objections = [...(options.objections ?? [])].map((objection, index) => ({
    objectionId: stringValue(objection.objectionId, `objections[${index}].objectionId`),
    statement: stringValue(objection.statement, `objections[${index}].statement`),
    status: (() => {
      if (objection.status !== "open" && objection.status !== "resolved") {
        throw new TypeError(`objections[${index}].status must be open or resolved`);
      }
      return objection.status;
    })(),
    evidenceObjectIds: uniqueStrings(objection.evidenceObjectIds, `objections[${index}].evidenceObjectIds`),
  }));
  if (new Set(objections.map((item) => item.objectionId)).size !== objections.length) {
    throw new TypeError("objections cannot contain duplicate objectionId values");
  }
  const spotChecks = uniqueStrings(
    options.reviewer.spotCheckedEvidenceObjectIds,
    "reviewer.spotCheckedEvidenceObjectIds",
  );
  if (
    spotChecks.length > 0 &&
    (!Number.isSafeInteger(options.reviewer.spotCheckSeed) || Number(options.reviewer.spotCheckSeed) < 0)
  ) {
    throw new TypeError("reviewer.spotCheckSeed must be a non-negative safe integer when spot checks are used");
  }
  for (const id of [
    ...spotChecks,
    ...objections.flatMap((objection) => objection.evidenceObjectIds),
  ]) {
    if (!allowedEvidenceIds.has(id)) {
      throw new Error(`Review safeguard cites evidence ${id} that is absent from its packet`);
    }
  }
  const openObjections = objections.filter((objection) => objection.status === "open");
  const independentProtocol = options.reviewer.freshContext ||
    options.reviewer.adversarial ||
    spotChecks.length > 0;
  const outcome: VerificationOutcome = openObjections.length > 0
    ? "failed"
    : evidenceObjectIds.length > 0 && independentProtocol
      ? "passed"
      : "inconclusive";
  const reviewContent = secretFreeJson({
    schemaVersion: 1,
    kind: "independent-verification-review",
    outcome,
    summary: stringValue(options.summary, "summary"),
    claimRef: { objectId: claim.objectId, versionId: claim.versionId },
    contextRef: { objectId: context.objectId, versionId: context.versionId },
    packetDigest: options.packet.digest,
    evidenceObjectIds,
    evidenceRefs: evidenceObjectIds.map((objectId) => {
      const entry = options.packet.evidence.find((candidate) => candidate.objectId === objectId)!;
      return { objectId: entry.objectId, versionId: entry.versionId };
    }),
    sourceRefs: options.packet.sources.map((entry) => ({
      objectId: entry.objectId,
      versionId: entry.versionId,
    })),
    objections,
    reviewer: {
      reviewerId,
      kind: options.reviewer.kind,
      ...(options.reviewer.modelFamily === undefined
        ? {}
        : { modelFamily: options.reviewer.modelFamily }),
      freshContext: options.reviewer.freshContext,
      adversarial: options.reviewer.adversarial,
      ...(options.reviewer.spotCheckSeed === undefined
        ? {}
        : { spotCheckSeed: options.reviewer.spotCheckSeed }),
      spotCheckedEvidenceObjectIds: spotChecks,
      crossModelFamily: authorFamily !== undefined &&
        options.reviewer.modelFamily !== undefined &&
        authorFamily !== options.reviewer.modelFamily,
    },
  } as JsonValue, "independent review");
  const review = await putObject(projectRoot, {
    branchId: options.branchId,
    objectType: "review",
    content: reviewContent as Record<string, unknown>,
    ...actorOption(options.actor),
  });
  const edgeType = outcome === "passed" ? "supports" : outcome === "failed" ? "refutes" : "tested_by";
  const edge = await addEdge(projectRoot, {
    branchId: options.branchId,
    edgeType,
    ...(edgeType === "tested_by"
      ? { fromObjectId: claim.objectId, toObjectId: review.objectId }
      : { fromObjectId: review.objectId, toObjectId: claim.objectId }),
    contextId: context.objectId,
    metadata: { verificationDimension: "human-review", outcome, independent: true },
    ...actorOption(options.actor),
  });
  const failure = outcome === "failed"
    ? await putObject(projectRoot, {
        branchId: options.branchId,
        objectType: "failure",
        content: {
          schemaVersion: 1,
          kind: "verification-objection",
          status: "open",
          claimRef: { objectId: claim.objectId, versionId: claim.versionId },
          contextRef: { objectId: context.objectId, versionId: context.versionId },
          reviewRef: { objectId: review.objectId, versionId: review.versionId },
          objections: openObjections,
        },
        ...actorOption(options.actor),
      })
    : undefined;
  return { review, edge, outcome, ...(failure === undefined ? {} : { failure }) };
}

export interface ReviewLoopSignal {
  readonly code: "repeated-objection" | "claim-cycle" | "no-new-evidence" | "length-without-evidence";
  readonly count: number;
  readonly message: string;
}

export interface ReviewLoopAnalysis {
  readonly branchId: string;
  readonly claimId: string;
  readonly contextId: string;
  readonly status: "clear" | "human-required";
  readonly reviewObjectIds: readonly string[];
  readonly signals: readonly ReviewLoopSignal[];
}

function visibleClaimHistory(projectRoot: string, claim: ObjectProjection): ObjectProjection[] {
  const history = new Map(
    getObjectHistory(projectRoot, claim.objectId).map((version) => [version.versionId, version]),
  );
  const result: ObjectProjection[] = [];
  const seen = new Set<string>();
  let versionId: string | undefined = claim.versionId;
  while (versionId !== undefined && !seen.has(versionId)) {
    seen.add(versionId);
    const version = history.get(versionId);
    if (version === undefined) break;
    result.push(version);
    const supersedes = version.envelope.supersedesVersionId;
    versionId = typeof supersedes === "string" ? supersedes : undefined;
  }
  return result.reverse();
}

export function analyzeReviewLoop(
  projectRoot: string,
  options: {
    branchId: string;
    claimId: string;
    contextId: string;
    repeatedObjectionLimit?: number;
    noNewEvidenceLimit?: number;
    claimCycleLimit?: number;
  },
): ReviewLoopAnalysis {
  const objects = branchObjects(projectRoot, options.branchId);
  const claim = exactObject(objects, options.claimId, "claim");
  exactObject(objects, options.contextId, "context");
  const reviews = [...objects.values()]
    .filter((object) => {
      if (object.objectType !== "review" || !isRecord(object.content)) return false;
      const claimRef = object.content.claimRef;
      const contextRef = object.content.contextRef;
      return object.content.kind === "independent-verification-review" &&
        isRecord(claimRef) && claimRef.objectId === claim.objectId &&
        isRecord(contextRef) && contextRef.objectId === options.contextId;
    })
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.objectId.localeCompare(right.objectId));
  const signals: ReviewLoopSignal[] = [];
  const objectionCounts = new Map<string, number>();
  for (const review of reviews) {
    const content = review.content as Record<string, unknown>;
    if (!Array.isArray(content.objections)) continue;
    for (const raw of content.objections) {
      if (!isRecord(raw) || raw.status !== "open" || typeof raw.statement !== "string") continue;
      const fingerprint = computeContentHash(raw.statement.trim().toLowerCase());
      objectionCounts.set(fingerprint, (objectionCounts.get(fingerprint) ?? 0) + 1);
    }
  }
  const objectionLimit = options.repeatedObjectionLimit ?? 3;
  const repeated = [...objectionCounts.values()].filter((count) => count >= objectionLimit);
  if (repeated.length > 0) {
    signals.push({
      code: "repeated-objection",
      count: Math.max(...repeated),
      message: "The same unresolved objection has recurred without closure.",
    });
  }
  const history = visibleClaimHistory(projectRoot, claim);
  const cycleLimit = options.claimCycleLimit ?? 2;
  const hashCounts = new Map<string, number>();
  for (const version of history) {
    hashCounts.set(version.contentHash, (hashCounts.get(version.contentHash) ?? 0) + 1);
  }
  const cycles = [...hashCounts.values()].filter((count) => count >= cycleLimit);
  if (cycles.length > 0) {
    signals.push({
      code: "claim-cycle",
      count: Math.max(...cycles),
      message: "A claim revision returned to previously seen canonical content.",
    });
  }
  const evidenceSets = reviews.map((review) => {
    const content = review.content as Record<string, unknown>;
    return canonicalJson(
      Array.isArray(content.evidenceObjectIds)
        ? [...content.evidenceObjectIds].filter((id): id is string => typeof id === "string").sort()
        : [],
    );
  });
  const noEvidenceLimit = options.noNewEvidenceLimit ?? 3;
  const recentSets = evidenceSets.slice(-noEvidenceLimit);
  const recentClaimVersions = reviews.slice(-noEvidenceLimit).flatMap((review) => {
    const claimRef = (review.content as Record<string, unknown>).claimRef;
    return isRecord(claimRef) && typeof claimRef.versionId === "string"
      ? [claimRef.versionId]
      : [];
  });
  if (
    recentSets.length >= noEvidenceLimit &&
    new Set(recentSets).size === 1 &&
    new Set(recentClaimVersions).size > 1
  ) {
    signals.push({
      code: "no-new-evidence",
      count: recentSets.length,
      message: "Repeated review iterations cite no new evidence.",
    });
    const lengths = history.slice(-noEvidenceLimit).map((version) => {
      const statement = isRecord(version.content) ? version.content.statement : undefined;
      return typeof statement === "string" ? statement.length : 0;
    });
    if (
      lengths.length >= noEvidenceLimit &&
      lengths.some((length, index) => index > 0 && length > lengths[index - 1]!) &&
      lengths.every((length, index) => index === 0 || length >= lengths[index - 1]!)
    ) {
      signals.push({
        code: "length-without-evidence",
        count: lengths.length,
        message: "Claim text grew across revisions while the evidence set stayed fixed.",
      });
    }
  }
  return {
    branchId: options.branchId,
    claimId: claim.objectId,
    contextId: options.contextId,
    status: signals.length === 0 ? "clear" : "human-required",
    reviewObjectIds: reviews.map((review) => review.objectId),
    signals,
  };
}

export async function enforceReviewLoopGuard(
  projectRoot: string,
  options: Parameters<typeof analyzeReviewLoop>[1] & { actor?: Actor },
): Promise<{ analysis: ReviewLoopAnalysis; failure?: ObjectEnvelope }> {
  const analysis = analyzeReviewLoop(projectRoot, options);
  if (analysis.status === "clear") return { analysis };
  const objects = branchObjects(projectRoot, options.branchId);
  const claim = exactObject(objects, options.claimId, "claim");
  const context = exactObject(objects, options.contextId, "context");
  const failure = await putObject(projectRoot, {
    branchId: options.branchId,
    objectType: "failure",
    content: {
      schemaVersion: 1,
      kind: "verification-review-loop",
      status: "human-required",
      claimRef: { objectId: claim.objectId, versionId: claim.versionId },
      contextRef: { objectId: context.objectId, versionId: context.versionId },
      analysis,
    },
    ...actorOption(options.actor),
  });
  return { analysis, failure };
}

export interface VerificationRecoveryResult {
  readonly interruptedRunIds: readonly string[];
  readonly failureObjectIds: readonly string[];
}

/**
 * Explicit crash recovery for verifier runs. Call only during project startup
 * or operator recovery, when no verifier is actively executing in this process.
 */
export async function recoverInterruptedVerifications(
  projectRoot: string,
  options: { branchId?: string; actor?: Actor } = {},
): Promise<VerificationRecoveryResult> {
  const branchIds = options.branchId === undefined
    ? listBranches(projectRoot).map((branch) => branch.branchId)
    : [options.branchId];
  const interruptedRunIds: string[] = [];
  const failureObjectIds: string[] = [];
  for (const branchId of branchIds.sort((left, right) => left.localeCompare(right))) {
    const objects = branchObjects(projectRoot, branchId);
    const interrupted = [...objects.values()]
      .filter((object) => {
        const content = contentRecordForRecovery(object);
        return object.objectType === "run" &&
          object.envelope.branchId === branchId &&
          content?.kind === "verification-run" &&
          content.status === "running";
      })
      .sort((left, right) => left.objectId.localeCompare(right.objectId));
    for (const candidate of interrupted) {
      const content = contentRecordForRecovery(candidate)!;
      const run = await putObject(projectRoot, {
        branchId,
        objectId: candidate.objectId,
        objectType: "run",
        content: {
          ...content,
          status: "interrupted",
          error: "Verifier process ended before a terminal result was recorded.",
        },
        ...actorOption(options.actor),
      });
      const failure = await putObject(projectRoot, {
        branchId,
        objectType: "failure",
        content: {
          schemaVersion: 1,
          kind: "verifier-execution-failure",
          status: "open",
          claimRef: content.claimRef,
          contextRef: content.contextRef,
          runRef: { objectId: run.objectId, versionId: run.versionId },
          ...(isRecord(content.verifier) && typeof content.verifier.verifierId === "string"
            ? { verifierId: content.verifier.verifierId }
            : {}),
          message: "Interrupted verifier execution requires an explicit retry.",
        },
        ...actorOption(options.actor),
      });
      interruptedRunIds.push(run.objectId);
      failureObjectIds.push(failure.objectId);
    }
  }
  return { interruptedRunIds, failureObjectIds };
}

function contentRecordForRecovery(object: ObjectProjection): Record<string, unknown> | undefined {
  return isRecord(object.content) ? object.content : undefined;
}

export interface FormalAlignmentOptions {
  readonly branchId: string;
  readonly contextId: string;
  readonly informalClaimId: string;
  readonly formalClaimId: string;
  readonly formalEvidenceId: string;
  readonly reviewerId: string;
  readonly outcome: VerificationOutcome;
  readonly summary: string;
  readonly actor?: Actor;
}

export async function recordFormalAlignment(
  projectRoot: string,
  options: FormalAlignmentOptions,
): Promise<{ alignment: ObjectEnvelope; edge: Awaited<ReturnType<typeof addEdge>> }> {
  const objects = branchObjects(projectRoot, options.branchId);
  const context = exactObject(objects, options.contextId, "context");
  const informal = exactObject(objects, options.informalClaimId, "claim");
  const formal = exactObject(objects, options.formalClaimId, "claim");
  const evidence = exactObject(objects, options.formalEvidenceId, "evidence");
  const evidenceContent = record(evidence.content, "formal evidence content");
  const evidenceClaimRef = record(evidenceContent.claimRef, "formal evidence claimRef");
  const evidenceContextRef = record(evidenceContent.contextRef, "formal evidence contextRef");
  for (const selected of [informal, formal]) {
    const declaredContext = isRecord(selected.content) ? selected.content.contextId : undefined;
    if (typeof declaredContext === "string" && declaredContext !== context.objectId) {
      throw new Error(`Claim ${selected.objectId} is scoped to context ${declaredContext}`);
    }
  }
  if (
    evidenceContent.kind !== "verification-result" ||
    evidenceContent.dimension !== "formal" ||
    evidenceContent.assurance !== "formal-kernel" ||
    evidenceContent.outcome !== "passed" ||
    evidenceClaimRef.objectId !== formal.objectId ||
    evidenceClaimRef.versionId !== formal.versionId ||
    evidenceContextRef.objectId !== context.objectId ||
    evidenceContextRef.versionId !== context.versionId
  ) {
    throw new Error("Formal alignment requires current passed formal-kernel evidence for the formal claim");
  }
  if (!(VERIFICATION_CHECK_STATUSES as readonly string[]).includes(options.outcome)) {
    throw new TypeError("alignment outcome is unsupported");
  }
  const alignmentContent = secretFreeJson({
    schemaVersion: 1,
    kind: "formal-statement-alignment",
    outcome: options.outcome,
    summary: stringValue(options.summary, "summary"),
    reviewerId: stringValue(options.reviewerId, "reviewerId"),
    contextRef: { objectId: context.objectId, versionId: context.versionId },
    informalClaimRef: { objectId: informal.objectId, versionId: informal.versionId },
    formalClaimRef: { objectId: formal.objectId, versionId: formal.versionId },
    formalEvidenceRef: { objectId: evidence.objectId, versionId: evidence.versionId },
  } as JsonValue, "formal alignment");
  const alignment = await putObject(projectRoot, {
    branchId: options.branchId,
    objectType: "alignment",
    content: alignmentContent as Record<string, unknown>,
    ...actorOption(options.actor),
  });
  const edge = await addEdge(projectRoot, {
    branchId: options.branchId,
    edgeType: "formalizes",
    fromObjectId: informal.objectId,
    toObjectId: formal.objectId,
    contextId: context.objectId,
    metadata: {
      alignmentObjectId: alignment.objectId,
      outcome: options.outcome,
      formalEvidenceId: evidence.objectId,
    },
    ...actorOption(options.actor),
  });
  return { alignment, edge };
}
