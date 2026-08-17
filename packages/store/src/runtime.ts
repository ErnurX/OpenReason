import { resolve } from "node:path";

import {
  createObjectId,
  utcNow,
  type Actor,
  type JsonValue,
} from "@reasoning-workbench/project-format";

import {
  assertCompletionPolicy,
  evaluateCompletionPolicy,
  type CompletionPolicy,
  type CompletionPolicyEvaluation,
} from "./policy.js";
import {
  createBranch,
  inspectProject,
  putObject,
  registerArtifactBytes,
} from "./project.js";
import {
  listBranches,
  listCurrentObjects,
  type ObjectProjection,
} from "./projection.js";
import {
  TOOL_CAPABILITIES,
  JsonSchemaValidationError,
  authorizeTool,
  validateJsonSchema,
  type ToolCapability,
  type ToolContract,
  type ToolExecutionResult,
  type ToolRegistry,
} from "./tools.js";

export type WorkstreamStatus =
  | "ready"
  | "running"
  | "paused"
  | "blocked"
  | "completed"
  | "cancelled";

export interface WorkstreamBudget {
  readonly maxToolCalls: number;
  readonly maxWallTimeMs: number;
  readonly maxArtifactBytes: number;
  readonly maxCostMicros: number;
}

export interface WorkstreamUsage {
  readonly toolCalls: number;
  readonly wallTimeMs: number;
  readonly artifactBytes: number;
  readonly costMicros: number;
}

export interface ExternalCostCharge {
  readonly runId: string;
  readonly costMicros: number;
}

export interface CreateWorkstreamOptions {
  readonly name: string;
  readonly goalId: string;
  readonly baseBranchId?: string;
  readonly allowedToolIds: readonly string[];
  readonly capabilities: readonly ToolCapability[];
  readonly budget: WorkstreamBudget;
  readonly completionPolicy: CompletionPolicy;
  readonly actor?: Actor;
}

export interface WorkstreamRecord {
  readonly workstreamId: string;
  readonly versionId: string;
  readonly version: number;
  readonly name: string;
  readonly goalId: string;
  /** The owning branch is also canonical content, not only projection context. */
  readonly branchId: string;
  readonly baseBranchId: string;
  readonly environmentId: string;
  readonly allowedToolIds: readonly string[];
  readonly capabilities: readonly ToolCapability[];
  readonly budget: WorkstreamBudget;
  readonly usage: WorkstreamUsage;
  /** Idempotency ledger for provider/remote costs reported outside tool runs. */
  readonly externalCostCharges: readonly ExternalCostCharge[];
  readonly completionPolicy: CompletionPolicy;
  readonly status: WorkstreamStatus;
  readonly activeRunId?: string;
  readonly completionEvaluation?: CompletionPolicyEvaluation;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ExecuteToolOptions {
  readonly workstreamId: string;
  readonly toolId: string;
  readonly input: JsonValue;
  readonly timeoutMs?: number;
  readonly actor?: Actor;
}

export interface RuntimeArtifactResult {
  readonly artifactId: string;
  readonly digest: string;
  readonly logicalName: string;
  readonly mediaType: string;
  readonly size: number;
}

export interface RuntimeToolExecution {
  readonly workstreamId: string;
  readonly runId: string;
  readonly toolId: string;
  readonly environmentId: string;
  readonly output: JsonValue;
  readonly artifacts: readonly RuntimeArtifactResult[];
  readonly usage: Omit<WorkstreamUsage, "toolCalls">;
}

export interface RecoveryResult {
  readonly recoveredWorkstreamIds: readonly string[];
  readonly interruptedRunIds: readonly string[];
  readonly failureObjectIds: readonly string[];
}

export interface ChargeExternalCostOptions {
  readonly workstreamId: string;
  readonly runId: string;
  readonly costMicros: number;
  readonly actor?: Actor;
}

export interface ExternalCostChargeResult {
  readonly workstream: WorkstreamRecord;
  readonly charged: boolean;
  readonly budgetExceeded: boolean;
  readonly failureObjectId?: string;
}

export class WorkstreamRuntimeError extends Error {
  public constructor(
    message: string,
    public readonly code:
      | "invalid-state"
      | "budget-exceeded"
      | "input-schema"
      | "output-schema"
      | "tool-failed"
      | "tool-timeout"
      | "interrupted",
    public readonly runId?: string,
  ) {
    super(message);
    this.name = "WorkstreamRuntimeError";
  }
}

interface ActiveInvocation {
  readonly runId: string;
  readonly controller: AbortController;
}

interface ProjectProcessState {
  tail: Promise<void>;
  readonly activeInvocations: Map<string, ActiveInvocation>;
}

const projectProcessStates = new Map<string, ProjectProcessState>();

function processState(projectRoot: string): ProjectProcessState {
  const key = resolve(projectRoot);
  let state = projectProcessStates.get(key);
  if (state === undefined) {
    state = { tail: Promise.resolve(), activeInvocations: new Map() };
    projectProcessStates.set(key, state);
  }
  return state;
}

/**
 * Serializes project mutations across every runtime instance in this process.
 * The canonical event log remains the acceptance boundary. Cross-process
 * scheduling requires a later lease/operation-journal layer.
 */
async function withProjectMutation<T>(
  projectRoot: string,
  operation: () => Promise<T>,
): Promise<T> {
  const state = processState(projectRoot);
  const predecessor = state.tail.catch(() => undefined);
  let release!: () => void;
  const gate = new Promise<void>((resolveGate) => {
    release = resolveGate;
  });
  state.tail = predecessor.then(() => gate);
  await predecessor;
  try {
    return await operation();
  } finally {
    release();
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return Number(value);
}

function positiveInteger(value: unknown, label: string): number {
  const checked = integer(value, label);
  if (checked === 0) throw new TypeError(`${label} must be positive`);
  return checked;
}

function uniqueStrings(value: readonly string[], label: string): string[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  const checked = value.map((item, index) => stringValue(item, `${label}[${index}]`));
  if (new Set(checked).size !== checked.length) {
    throw new TypeError(`${label} cannot contain duplicates`);
  }
  return [...checked].sort((left, right) => left.localeCompare(right));
}

function checkedBudget(value: WorkstreamBudget): WorkstreamBudget {
  return {
    maxToolCalls: integer(value.maxToolCalls, "budget.maxToolCalls"),
    maxWallTimeMs: integer(value.maxWallTimeMs, "budget.maxWallTimeMs"),
    maxArtifactBytes: integer(value.maxArtifactBytes, "budget.maxArtifactBytes"),
    maxCostMicros: integer(value.maxCostMicros, "budget.maxCostMicros"),
  };
}

function checkedCapabilities(values: readonly ToolCapability[]): ToolCapability[] {
  const known = new Set<string>(TOOL_CAPABILITIES);
  const checked = uniqueStrings(values, "capabilities");
  for (const capability of checked) {
    if (!known.has(capability)) {
      throw new TypeError(`Unsupported capability: ${capability}`);
    }
  }
  return checked as ToolCapability[];
}

function usageFrom(value: unknown, label: string): WorkstreamUsage {
  const item = record(value, label);
  return {
    toolCalls: integer(item.toolCalls, `${label}.toolCalls`),
    wallTimeMs: integer(item.wallTimeMs, `${label}.wallTimeMs`),
    artifactBytes: integer(item.artifactBytes, `${label}.artifactBytes`),
    costMicros: integer(item.costMicros, `${label}.costMicros`),
  };
}

function externalCostChargesFrom(value: unknown): ExternalCostCharge[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new TypeError("workstream.externalCostCharges must be an array");
  }
  const seen = new Set<string>();
  return value.map((item, index) => {
    const charge = record(item, `workstream.externalCostCharges[${index}]`);
    const runId = stringValue(
      charge.runId,
      `workstream.externalCostCharges[${index}].runId`,
    );
    if (seen.has(runId)) {
      throw new TypeError(`workstream.externalCostCharges contains duplicate run ${runId}`);
    }
    seen.add(runId);
    return {
      runId,
      costMicros: integer(
        charge.costMicros,
        `workstream.externalCostCharges[${index}].costMicros`,
      ),
    };
  });
}

function budgetFrom(value: unknown, label: string): WorkstreamBudget {
  const item = record(value, label);
  return checkedBudget({
    maxToolCalls: integer(item.maxToolCalls, `${label}.maxToolCalls`),
    maxWallTimeMs: integer(item.maxWallTimeMs, `${label}.maxWallTimeMs`),
    maxArtifactBytes: integer(item.maxArtifactBytes, `${label}.maxArtifactBytes`),
    maxCostMicros: integer(item.maxCostMicros, `${label}.maxCostMicros`),
  });
}

const WORKSTREAM_STATUSES = new Set<WorkstreamStatus>([
  "ready",
  "running",
  "paused",
  "blocked",
  "completed",
  "cancelled",
]);

function workstreamFromProjection(object: ObjectProjection): WorkstreamRecord {
  if (object.objectType !== "workstream") {
    throw new TypeError(`${object.objectId} is not a workstream`);
  }
  const content = record(object.content, `workstream ${object.objectId}`);
  if (content.kind !== "runtime-workstream") {
    throw new TypeError(`${object.objectId} is not a runtime-managed workstream`);
  }
  const status = stringValue(content.status, "workstream.status") as WorkstreamStatus;
  if (!WORKSTREAM_STATUSES.has(status)) {
    throw new TypeError(`Unsupported workstream status: ${status}`);
  }
  const capabilities = checkedCapabilities(
    uniqueStrings(
      content.capabilities as readonly string[],
      "workstream.capabilities",
    ) as ToolCapability[],
  );
  const completionPolicy = content.completionPolicy;
  assertCompletionPolicy(completionPolicy);
  const completionEvaluation = content.completionEvaluation;
  return {
    workstreamId: object.objectId,
    versionId: object.versionId,
    version: object.version,
    name: stringValue(content.name, "workstream.name"),
    goalId: stringValue(content.goalId, "workstream.goalId"),
    branchId: stringValue(content.branchId, "workstream.branchId"),
    baseBranchId: stringValue(content.baseBranchId, "workstream.baseBranchId"),
    environmentId: stringValue(content.environmentId, "workstream.environmentId"),
    allowedToolIds: uniqueStrings(
      content.allowedToolIds as readonly string[],
      "workstream.allowedToolIds",
    ),
    capabilities,
    budget: budgetFrom(content.budget, "workstream.budget"),
    usage: usageFrom(content.usage, "workstream.usage"),
    externalCostCharges: externalCostChargesFrom(content.externalCostCharges),
    completionPolicy,
    status,
    ...(typeof content.activeRunId === "string"
      ? { activeRunId: content.activeRunId }
      : {}),
    ...(completionEvaluation === undefined
      ? {}
      : {
          completionEvaluation:
            completionEvaluation as unknown as CompletionPolicyEvaluation,
        }),
    createdAt: stringValue(content.createdAt, "workstream.createdAt"),
    updatedAt: stringValue(content.updatedAt, "workstream.updatedAt"),
  };
}

function isRuntimeWorkstreamProjection(object: ObjectProjection): boolean {
  if (object.objectType !== "workstream") return false;
  if (typeof object.content !== "object" || object.content === null || Array.isArray(object.content)) {
    return false;
  }
  const content = object.content as Record<string, unknown>;
  return content.kind === "runtime-workstream" && content.branchId === object.branchId;
}

function findOwnedWorkstream(
  projectRoot: string,
  workstreamId: string,
): WorkstreamRecord | undefined {
  for (const candidate of listCurrentObjects(projectRoot)) {
    if (candidate.objectId !== workstreamId || !isRuntimeWorkstreamProjection(candidate)) {
      continue;
    }
    const parsed = workstreamFromProjection(candidate);
    return parsed;
  }
  return undefined;
}

function getOwnedWorkstream(projectRoot: string, workstreamId: string): WorkstreamRecord {
  const selected = findOwnedWorkstream(projectRoot, workstreamId);
  if (selected === undefined) throw new Error(`Workstream does not exist: ${workstreamId}`);
  return selected;
}

function workstreamContent(
  workstream: WorkstreamRecord,
  changes: Record<string, unknown>,
): Record<string, unknown> {
  const content: Record<string, unknown> = {
    schemaVersion: 1,
    kind: "runtime-workstream",
    name: workstream.name,
    goalId: workstream.goalId,
    branchId: workstream.branchId,
    baseBranchId: workstream.baseBranchId,
    environmentId: workstream.environmentId,
    allowedToolIds: [...workstream.allowedToolIds],
    capabilities: [...workstream.capabilities],
    budget: { ...workstream.budget },
    usage: { ...workstream.usage },
    externalCostCharges: workstream.externalCostCharges.map((charge) => ({ ...charge })),
    completionPolicy: workstream.completionPolicy,
    status: workstream.status,
    createdAt: workstream.createdAt,
    updatedAt: utcNow(),
    ...changes,
  };
  // An absent field must be omitted, never serialized as undefined.
  for (const [key, value] of Object.entries(content)) {
    if (value === undefined) delete content[key];
  }
  return content;
}

async function updateWorkstream(
  projectRoot: string,
  workstream: WorkstreamRecord,
  changes: Record<string, unknown>,
  actor?: Actor,
): Promise<WorkstreamRecord> {
  await putObject(projectRoot, {
    branchId: workstream.branchId,
    objectId: workstream.workstreamId,
    objectType: "workstream",
    content: workstreamContent(workstream, changes),
    ...(actor === undefined ? {} : { actor }),
  });
  return getOwnedWorkstream(projectRoot, workstream.workstreamId);
}

function slug(value: string): string {
  const normalized = value
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return normalized.slice(0, 32) || "work";
}

export async function createWorkstream(
  projectRoot: string,
  options: CreateWorkstreamOptions,
): Promise<WorkstreamRecord> {
  return withProjectMutation(projectRoot, async () => {
    const name = stringValue(options.name, "name");
    const goalId = stringValue(options.goalId, "goalId");
    const allowedToolIds = uniqueStrings(options.allowedToolIds, "allowedToolIds");
    const capabilities = checkedCapabilities(options.capabilities);
    const budget = checkedBudget(options.budget);
    assertCompletionPolicy(options.completionPolicy);

    const inspection = await inspectProject(projectRoot);
    const baseBranchId = options.baseBranchId ?? inspection.manifest.defaultBranchId;
    if (!inspection.branches.some((branch) => branch.branchId === baseBranchId)) {
      throw new Error(`Base branch does not exist: ${baseBranchId}`);
    }
    const goal = listCurrentObjects(projectRoot, baseBranchId).find(
      (object) => object.objectId === goalId && object.objectType === "goal",
    );
    if (goal === undefined) {
      throw new Error(`Goal ${goalId} is not visible on branch ${baseBranchId}`);
    }

    const workstreamId = createObjectId("workstream");
    const branch = await createBranch(projectRoot, {
      name: `ws-${slug(name)}-${workstreamId.slice(-8).toLowerCase()}`,
      baseBranchId,
      ...(options.actor === undefined ? {} : { actor: options.actor }),
    });
    const environmentId = createObjectId("environment");
    const createdAt = utcNow();
    await putObject(projectRoot, {
      branchId: branch.branchId,
      objectId: environmentId,
      objectType: "environment",
      content: {
        schemaVersion: 1,
        kind: "workstream-runtime",
        workstreamId,
        branchId: branch.branchId,
        runtime: "reasoning-workbench/in-process",
        nodeVersion: process.version,
        platform: process.platform,
        architecture: process.arch,
        isolation: "application-policy-only",
        allowedToolIds,
        capabilities,
        createdAt,
      },
      ...(options.actor === undefined ? {} : { actor: options.actor }),
    });
    await putObject(projectRoot, {
      branchId: branch.branchId,
      objectId: workstreamId,
      objectType: "workstream",
      content: {
        schemaVersion: 1,
        kind: "runtime-workstream",
        name,
        goalId,
        branchId: branch.branchId,
        baseBranchId,
        environmentId,
        allowedToolIds,
        capabilities,
        budget,
        usage: {
          toolCalls: 0,
          wallTimeMs: 0,
          artifactBytes: 0,
          costMicros: 0,
        },
        externalCostCharges: [],
        completionPolicy: options.completionPolicy,
        status: "ready",
        createdAt,
        updatedAt: createdAt,
      },
      ...(options.actor === undefined ? {} : { actor: options.actor }),
    });
    return getOwnedWorkstream(projectRoot, workstreamId);
  });
}

function exactToolContract(contract: ToolContract): Record<string, unknown> {
  return {
    schemaVersion: contract.schemaVersion,
    toolId: contract.toolId,
    name: contract.name,
    version: contract.version,
    description: contract.description,
    inputSchema: contract.inputSchema,
    outputSchema: contract.outputSchema,
    requiredCapabilities: [...contract.requiredCapabilities],
    sideEffects: [...contract.sideEffects],
    determinism: contract.determinism,
    supportsCancellation: contract.supportsCancellation,
    defaultTimeoutMs: contract.defaultTimeoutMs,
  };
}

function runContentBase(
  workstream: WorkstreamRecord,
  runId: string,
  contract: ToolContract,
  input: JsonValue,
  timeoutMs: number,
  reservedAt: string,
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    runId,
    workstreamId: workstream.workstreamId,
    branchId: workstream.branchId,
    environmentId: workstream.environmentId,
    tool: exactToolContract(contract),
    input,
    permissions: {
      allowedToolIds: [...workstream.allowedToolIds],
      grantedCapabilities: [...workstream.capabilities],
    },
    timeoutMs,
    status: "reserved",
    reservedAt,
    artifacts: [],
    usage: { wallTimeMs: 0, artifactBytes: 0, costMicros: 0 },
  };
}

async function createFailure(
  projectRoot: string,
  workstream: WorkstreamRecord,
  details: Record<string, unknown>,
  actor?: Actor,
): Promise<string> {
  const failure = await putObject(projectRoot, {
    branchId: workstream.branchId,
    objectType: "failure",
    content: {
      schemaVersion: 1,
      kind: "workstream-execution-failure",
      status: "open",
      workstreamId: workstream.workstreamId,
      branchId: workstream.branchId,
      occurredAt: utcNow(),
      ...details,
    },
    ...(actor === undefined ? {} : { actor }),
  });
  return failure.objectId;
}

function addUsage(
  usage: WorkstreamUsage,
  delta: Omit<WorkstreamUsage, "toolCalls">,
): WorkstreamUsage {
  return {
    toolCalls: usage.toolCalls,
    wallTimeMs: usage.wallTimeMs + delta.wallTimeMs,
    artifactBytes: usage.artifactBytes + delta.artifactBytes,
    costMicros: usage.costMicros + delta.costMicros,
  };
}

function budgetViolation(
  usage: WorkstreamUsage,
  budget: WorkstreamBudget,
): string | undefined {
  if (usage.toolCalls > budget.maxToolCalls) return "tool call budget exceeded";
  if (usage.wallTimeMs > budget.maxWallTimeMs) return "wall-time budget exceeded";
  if (usage.artifactBytes > budget.maxArtifactBytes) return "artifact-byte budget exceeded";
  if (usage.costMicros > budget.maxCostMicros) return "cost budget exceeded";
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function runProjection(
  projectRoot: string,
  branchId: string,
  runId: string,
): ObjectProjection {
  const selected = listCurrentObjects(projectRoot, branchId).find(
    (object) => object.objectId === runId && object.objectType === "run",
  );
  if (selected === undefined) throw new Error(`Run does not exist: ${runId}`);
  return selected;
}

async function updateRun(
  projectRoot: string,
  branchId: string,
  runId: string,
  content: Record<string, unknown>,
  actor?: Actor,
): Promise<void> {
  await putObject(projectRoot, {
    branchId,
    objectId: runId,
    objectType: "run",
    content,
    ...(actor === undefined ? {} : { actor }),
  });
}

function contentOf(object: ObjectProjection, label: string): Record<string, unknown> {
  return record(object.content, label);
}

function validateRequestedTimeout(timeoutMs: number | undefined): number | undefined {
  return timeoutMs === undefined ? undefined : positiveInteger(timeoutMs, "timeoutMs");
}

export class WorkstreamRuntime {
  public readonly projectRoot: string;

  public constructor(
    projectRoot: string,
    public readonly registry: ToolRegistry,
  ) {
    this.projectRoot = resolve(projectRoot);
  }

  public get(workstreamId: string): WorkstreamRecord {
    return getOwnedWorkstream(this.projectRoot, workstreamId);
  }

  public list(): WorkstreamRecord[] {
    const workstreams: WorkstreamRecord[] = [];
    for (const object of listCurrentObjects(this.projectRoot)) {
      if (!isRuntimeWorkstreamProjection(object)) continue;
      workstreams.push(workstreamFromProjection(object));
    }
    return workstreams.sort((left, right) =>
      left.workstreamId.localeCompare(right.workstreamId),
    );
  }

  public remainingCostMicros(workstreamId: string): number {
    const workstream = this.get(workstreamId);
    return Math.max(0, workstream.budget.maxCostMicros - workstream.usage.costMicros);
  }

  /**
   * Idempotently adds provider/remote cost to the same aggregate budget used by
   * tools. The run ID prevents recovery from charging a completed turn twice.
   */
  public async chargeExternalCost(
    options: ChargeExternalCostOptions,
  ): Promise<ExternalCostChargeResult> {
    const runId = stringValue(options.runId, "external cost runId");
    const costMicros = integer(options.costMicros, "external costMicros");
    return withProjectMutation(this.projectRoot, async () => {
      const workstream = this.get(options.workstreamId);
      const run = runProjection(this.projectRoot, workstream.branchId, runId);
      const runContent = contentOf(run, `external cost run ${runId}`);
      if (runContent.workstreamId !== workstream.workstreamId) {
        throw new TypeError(
          `External cost run ${runId} does not belong to workstream ${workstream.workstreamId}`,
        );
      }
      const existing = workstream.externalCostCharges.find(
        (charge) => charge.runId === runId,
      );
      if (existing !== undefined) {
        if (existing.costMicros !== costMicros) {
          throw new WorkstreamRuntimeError(
            `External cost for ${runId} was already recorded with a different value`,
            "invalid-state",
            runId,
          );
        }
        return {
          workstream,
          charged: false,
          budgetExceeded: workstream.usage.costMicros > workstream.budget.maxCostMicros,
        };
      }
      const nextCost = workstream.usage.costMicros + costMicros;
      if (!Number.isSafeInteger(nextCost)) {
        throw new RangeError("aggregate workstream cost exceeds the safe integer range");
      }
      const nextUsage = { ...workstream.usage, costMicros: nextCost };
      const violation = nextCost > workstream.budget.maxCostMicros;
      let failureObjectId: string | undefined;
      if (violation) {
        failureObjectId = await createFailure(
          this.projectRoot,
          workstream,
          {
            phase: "external-cost",
            runId,
            reason: "cost budget exceeded",
            chargedCostMicros: costMicros,
            budget: workstream.budget,
            usage: nextUsage,
          },
          options.actor,
        );
      }
      const updated = await updateWorkstream(
        this.projectRoot,
        workstream,
        {
          usage: nextUsage,
          externalCostCharges: [
            ...workstream.externalCostCharges.map((charge) => ({ ...charge })),
            { runId, costMicros },
          ],
          ...(violation && workstream.status !== "cancelled"
            ? { status: "blocked", blockedReason: "cost budget exceeded" }
            : {}),
        },
        options.actor,
      );
      return {
        workstream: updated,
        charged: true,
        budgetExceeded: violation,
        ...(failureObjectId === undefined ? {} : { failureObjectId }),
      };
    });
  }

  /**
   * Linearization boundary for coordinator-owned branch writes. The callback
   * must not call another WorkstreamRuntime mutation method, which would
   * re-enter the same project gate.
   */
  public async withReadyMutation<T>(
    workstreamId: string,
    operation: (workstream: WorkstreamRecord) => Promise<T>,
  ): Promise<T> {
    return withProjectMutation(this.projectRoot, async () => {
      const workstream = this.get(workstreamId);
      if (workstream.status !== "ready") {
        throw new WorkstreamRuntimeError(
          `Workstream ${workstream.workstreamId} is ${workstream.status}, not ready`,
          "invalid-state",
        );
      }
      return operation(workstream);
    });
  }

  public async executeTool(options: ExecuteToolOptions): Promise<RuntimeToolExecution> {
    const requestedTimeout = validateRequestedTimeout(options.timeoutMs);
    const definition = this.registry.get(options.toolId);
    if (definition === undefined) throw new Error(`Tool is not registered: ${options.toolId}`);

    // Authorization happens before reserving a run. A denied request therefore
    // leaves no misleading execution record and invokes neither preflight nor
    // the handler.
    const initial = this.get(options.workstreamId);
    authorizeTool(definition.contract, {
      allowedToolIds: [...initial.allowedToolIds],
      grantedCapabilities: [...initial.capabilities],
    });
    // Security-sensitive tools can reject and normalize input before the
    // append-only run reservation makes any part of it canonical.
    const preparedInput = definition.prepareInput?.(options.input) ?? options.input;

    const runId = createObjectId("run");
    const controller = new AbortController();
    const state = processState(this.projectRoot);
    let timeoutMs = 0;

    await withProjectMutation(this.projectRoot, async () => {
      const workstream = this.get(options.workstreamId);
      // Re-authorize against the fresh canonical version in case permissions
      // changed while this invocation waited for the project mutation lock.
      authorizeTool(definition.contract, {
        allowedToolIds: [...workstream.allowedToolIds],
        grantedCapabilities: [...workstream.capabilities],
      });
      if (workstream.status !== "ready") {
        throw new WorkstreamRuntimeError(
          `Workstream ${workstream.workstreamId} is ${workstream.status}, not ready`,
          "invalid-state",
        );
      }
      if (state.activeInvocations.has(workstream.workstreamId)) {
        throw new WorkstreamRuntimeError(
          `Workstream ${workstream.workstreamId} already has an active invocation`,
          "invalid-state",
        );
      }

      const immediateViolation =
        workstream.usage.toolCalls >= workstream.budget.maxToolCalls
          ? "tool call budget exhausted"
          : workstream.usage.wallTimeMs >= workstream.budget.maxWallTimeMs
            ? "wall-time budget exhausted"
            : workstream.usage.artifactBytes > workstream.budget.maxArtifactBytes
              ? "artifact-byte budget exceeded"
              : workstream.usage.costMicros > workstream.budget.maxCostMicros
                ? "cost budget exceeded"
                : undefined;
      if (immediateViolation !== undefined) {
        await createFailure(
          this.projectRoot,
          workstream,
          {
            phase: "reservation",
            toolId: definition.contract.toolId,
            reason: immediateViolation,
            budget: workstream.budget,
            usage: workstream.usage,
          },
          options.actor,
        );
        await updateWorkstream(
          this.projectRoot,
          workstream,
          { status: "blocked", blockedReason: immediateViolation },
          options.actor,
        );
        throw new WorkstreamRuntimeError(immediateViolation, "budget-exceeded");
      }

      const remainingWallTime =
        workstream.budget.maxWallTimeMs - workstream.usage.wallTimeMs;
      timeoutMs = Math.min(
        definition.contract.defaultTimeoutMs,
        requestedTimeout ?? Number.POSITIVE_INFINITY,
        remainingWallTime,
      );
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
        throw new WorkstreamRuntimeError(
          "No positive wall-time budget remains",
          "budget-exceeded",
        );
      }

      const reservedAt = utcNow();
      const base = runContentBase(
        workstream,
        runId,
        definition.contract,
        preparedInput,
        timeoutMs,
        reservedAt,
      );
      const usage: WorkstreamUsage = {
        ...workstream.usage,
        // Reservation is durable before the handler can run, so a crash cannot
        // be used to evade maxToolCalls.
        toolCalls: workstream.usage.toolCalls + 1,
      };
      await updateWorkstream(
        this.projectRoot,
        workstream,
        { status: "running", activeRunId: runId, usage },
        options.actor,
      );
      await putObject(this.projectRoot, {
        branchId: workstream.branchId,
        objectId: runId,
        objectType: "run",
        content: { ...base, status: "running", startedAt: utcNow() },
        ...(options.actor === undefined ? {} : { actor: options.actor }),
      });
      state.activeInvocations.set(workstream.workstreamId, { runId, controller });
    });

    try {
      const inputIssues = validateJsonSchema(definition.contract.inputSchema, preparedInput);
    if (inputIssues.length > 0) {
      const message = `Tool input failed schema validation: ${inputIssues
        .map((issue) => `${issue.path}: ${issue.message}`)
        .join("; ")}`;
      await this.finalizeFailure(
        options,
        runId,
        "input-schema",
        message,
        0,
        { schemaIssues: inputIssues },
      );
      throw new WorkstreamRuntimeError(message, "input-schema", runId);
    }

    const started = Date.now();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error(`Tool timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    let result: ToolExecutionResult;
    try {
      const abort = new Promise<never>((_resolve, reject) => {
        const rejectAbort = (): void =>
          reject(controller.signal.reason ?? new Error("Tool execution aborted"));
        if (controller.signal.aborted) rejectAbort();
        else controller.signal.addEventListener("abort", rejectAbort, { once: true });
      });
      // Tool code is intentionally outside the mutation mutex: other
      // workstreams can execute and pause/cancel can abort this signal.
      // This is application-level isolation, not an OS security sandbox.
      result = await Promise.race([
        this.registry.execute(definition.contract.toolId, preparedInput, {
          signal: controller.signal,
          executionId: runId,
          projectRoot: this.projectRoot,
          branchId: initial.branchId,
          workstreamId: initial.workstreamId,
        }),
        abort,
      ]);
    } catch (error) {
      const elapsed = Math.max(0, Date.now() - started);
      const current = this.get(options.workstreamId);
      const userInterrupted =
        controller.signal.aborted &&
        !timedOut &&
        (current.status === "paused" || current.status === "cancelled");
      if (userInterrupted) {
        await this.finalizeInterruption(options, runId, elapsed, current.status);
        throw new WorkstreamRuntimeError(
          `Tool execution ${current.status}`,
          "interrupted",
          runId,
        );
      }
      const outputSchemaFailure = error instanceof JsonSchemaValidationError;
      const code = timedOut
        ? "tool-timeout"
        : outputSchemaFailure
          ? "output-schema"
          : "tool-failed";
      const message = timedOut
        ? `Tool timed out after ${timeoutMs} ms`
        : errorMessage(error);
      await this.finalizeFailure(
        options,
        runId,
        code,
        message,
        elapsed,
        outputSchemaFailure ? { schemaIssues: error.issues } : {},
      );
      throw new WorkstreamRuntimeError(message, code, runId);
    } finally {
      clearTimeout(timeout);
    }

    const elapsed = Math.max(0, Date.now() - started);
    if (elapsed > timeoutMs) {
      const message = `Tool timed out after ${timeoutMs} ms`;
      await this.finalizeFailure(
        options,
        runId,
        "tool-timeout",
        message,
        elapsed,
      );
      throw new WorkstreamRuntimeError(message, "tool-timeout", runId);
    }
    const outputIssues = validateJsonSchema(definition.contract.outputSchema, result.output);
    if (outputIssues.length > 0) {
      const message = `Tool output failed schema validation: ${outputIssues
        .map((issue) => `${issue.path}: ${issue.message}`)
        .join("; ")}`;
      await this.finalizeFailure(
        options,
        runId,
        "output-schema",
        message,
        elapsed,
        { schemaIssues: outputIssues },
      );
      throw new WorkstreamRuntimeError(message, "output-schema", runId);
    }

    const artifacts = result.artifacts ?? [];
    const artifactBytes = artifacts.reduce((total, artifact) => {
      const next = total + artifact.bytes.byteLength;
      if (!Number.isSafeInteger(next)) throw new RangeError("Artifact size exceeds safe integer range");
      return next;
    }, 0);
    const costMicros = integer(result.costMicros ?? 0, "tool result.costMicros");

      return await withProjectMutation(this.projectRoot, async () => {
      const workstream = this.get(options.workstreamId);
      if (workstream.status === "paused" || workstream.status === "cancelled") {
        await this.finishInterruptedRun(
          workstream,
          runId,
          elapsed,
          workstream.status,
          options.actor,
        );
        state.activeInvocations.delete(workstream.workstreamId);
        throw new WorkstreamRuntimeError(
          `Tool execution ${workstream.status}`,
          "interrupted",
          runId,
        );
      }

      const delta = { wallTimeMs: elapsed, artifactBytes, costMicros };
      const nextUsage = addUsage(workstream.usage, delta);
      const violation = budgetViolation(nextUsage, workstream.budget);
      if (violation !== undefined) {
        // Output schema and the complete aggregate artifact/cost budget are
        // checked before the first CAS write, avoiding unreferenced blobs.
        await this.writeFailedRunAndWorkstream(
          workstream,
          runId,
          "budget",
          violation,
          elapsed,
          delta,
          { attemptedOutput: result.output },
          options.actor,
        );
        state.activeInvocations.delete(workstream.workstreamId);
        throw new WorkstreamRuntimeError(violation, "budget-exceeded", runId);
      }

      const registered: RuntimeArtifactResult[] = [];
      let resultEnvironmentId = workstream.environmentId;
      if (result.environment !== undefined) {
        resultEnvironmentId = createObjectId("environment");
        await putObject(this.projectRoot, {
          branchId: workstream.branchId,
          objectId: resultEnvironmentId,
          objectType: "environment",
          content: {
            schemaVersion: 1,
            kind: "tool-execution-environment",
            workstreamId: workstream.workstreamId,
            runId,
            branchId: workstream.branchId,
            parentEnvironmentId: workstream.environmentId,
            descriptor: result.environment,
            createdAt: utcNow(),
          },
          ...(options.actor === undefined ? {} : { actor: options.actor }),
        });
        const environmentRun = runProjection(this.projectRoot, workstream.branchId, runId);
        await updateRun(
          this.projectRoot,
          workstream.branchId,
          runId,
          {
            ...contentOf(environmentRun, `run ${runId}`),
            environmentId: resultEnvironmentId,
          },
          options.actor,
        );
      }
      for (const artifact of artifacts) {
        try {
          const registration = await registerArtifactBytes(
            this.projectRoot,
            artifact.bytes,
            {
              branchId: workstream.branchId,
              mediaType: artifact.mediaType,
              logicalName: artifact.logicalName,
              producedByRunId: runId,
              environmentId: resultEnvironmentId,
              ...(artifact.inputs === undefined ? {} : { inputs: [...artifact.inputs] }),
              reproducibility: artifact.reproducibility,
              ...(options.actor === undefined ? {} : { actor: options.actor }),
            },
          );
          registered.push({
            artifactId: registration.artifact.artifactId,
            digest: registration.artifact.digest,
            logicalName: registration.artifact.logicalName,
            mediaType: registration.artifact.mediaType,
            size: registration.artifact.size,
          });
        } catch (error) {
          const message = `Artifact registration failed: ${errorMessage(error)}`;
          await this.writeFailedRunAndWorkstream(
            workstream,
            runId,
            "artifact-registration",
            message,
            elapsed,
            {
              wallTimeMs: elapsed,
              artifactBytes: registered.reduce((total, item) => total + item.size, 0),
              costMicros,
            },
            { registeredArtifacts: registered },
            options.actor,
          );
          state.activeInvocations.delete(workstream.workstreamId);
          throw new WorkstreamRuntimeError(message, "tool-failed", runId);
        }
      }

      const run = runProjection(this.projectRoot, workstream.branchId, runId);
      await updateRun(
        this.projectRoot,
        workstream.branchId,
        runId,
        {
          ...contentOf(run, `run ${runId}`),
          status: "succeeded",
          finishedAt: utcNow(),
          output: result.output,
          artifacts: registered,
          usage: delta,
        },
        options.actor,
      );
      await updateWorkstream(
        this.projectRoot,
        workstream,
        { status: "ready", activeRunId: undefined, usage: nextUsage },
        options.actor,
      );
      state.activeInvocations.delete(workstream.workstreamId);
      return {
        workstreamId: workstream.workstreamId,
        runId,
        toolId: definition.contract.toolId,
        environmentId: resultEnvironmentId,
        output: result.output,
        artifacts: registered,
        usage: delta,
      };
      });
    } finally {
      // Cleanup is unconditional even when durable failure finalization itself
      // fails. Otherwise a transient project-write error could wedge this
      // workstream in the in-process scheduler forever.
      state.activeInvocations.delete(options.workstreamId);
    }
  }

  private async finalizeFailure(
    options: ExecuteToolOptions,
    runId: string,
    phase: string,
    message: string,
    elapsed: number,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    await withProjectMutation(this.projectRoot, async () => {
      const workstream = this.get(options.workstreamId);
      const delta = { wallTimeMs: elapsed, artifactBytes: 0, costMicros: 0 };
      await this.writeFailedRunAndWorkstream(
        workstream,
        runId,
        phase,
        message,
        elapsed,
        delta,
        extra,
        options.actor,
      );
      processState(this.projectRoot).activeInvocations.delete(workstream.workstreamId);
    });
  }

  private async writeFailedRunAndWorkstream(
    workstream: WorkstreamRecord,
    runId: string,
    phase: string,
    message: string,
    elapsed: number,
    delta: Omit<WorkstreamUsage, "toolCalls">,
    extra: Record<string, unknown>,
    actor?: Actor,
  ): Promise<void> {
    const run = runProjection(this.projectRoot, workstream.branchId, runId);
    const failureObjectId = await createFailure(
      this.projectRoot,
      workstream,
      {
        runId,
        toolId: record(contentOf(run, `run ${runId}`).tool, "run.tool").toolId,
        phase,
        reason: message,
        ...extra,
      },
      actor,
    );
    await updateRun(
      this.projectRoot,
      workstream.branchId,
      runId,
      {
        ...contentOf(run, `run ${runId}`),
        status: "failed",
        finishedAt: utcNow(),
        error: { phase, message, failureObjectId },
        usage: delta,
      },
      actor,
    );
    await updateWorkstream(
      this.projectRoot,
      workstream,
      {
        status: "blocked",
        activeRunId: undefined,
        blockedReason: message,
        usage: addUsage(workstream.usage, delta),
      },
      actor,
    );
  }

  private async finalizeInterruption(
    options: ExecuteToolOptions,
    runId: string,
    elapsed: number,
    status: "paused" | "cancelled",
  ): Promise<void> {
    await withProjectMutation(this.projectRoot, async () => {
      const workstream = this.get(options.workstreamId);
      await this.finishInterruptedRun(
        workstream,
        runId,
        elapsed,
        status,
        options.actor,
      );
      processState(this.projectRoot).activeInvocations.delete(workstream.workstreamId);
    });
  }

  private async finishInterruptedRun(
    workstream: WorkstreamRecord,
    runId: string,
    elapsed: number,
    status: "paused" | "cancelled",
    actor?: Actor,
  ): Promise<void> {
    const run = runProjection(this.projectRoot, workstream.branchId, runId);
    await updateRun(
      this.projectRoot,
      workstream.branchId,
      runId,
      {
        ...contentOf(run, `run ${runId}`),
        status: status === "cancelled" ? "cancelled" : "interrupted",
        finishedAt: utcNow(),
        error: { phase: "control", message: `Execution ${status} by user` },
        usage: { wallTimeMs: elapsed, artifactBytes: 0, costMicros: 0 },
      },
      actor,
    );
    await updateWorkstream(
      this.projectRoot,
      workstream,
      {
        status,
        activeRunId: undefined,
        usage: addUsage(workstream.usage, {
          wallTimeMs: elapsed,
          artifactBytes: 0,
          costMicros: 0,
        }),
      },
      actor,
    );
  }

  public async pause(workstreamId: string, actor?: Actor): Promise<WorkstreamRecord> {
    return withProjectMutation(this.projectRoot, async () => {
      const workstream = this.get(workstreamId);
      if (workstream.status === "completed" || workstream.status === "cancelled") {
        throw new WorkstreamRuntimeError(
          `Cannot pause a ${workstream.status} workstream`,
          "invalid-state",
        );
      }
      if (workstream.status === "paused") return workstream;
      const updated = await updateWorkstream(
        this.projectRoot,
        workstream,
        { status: "paused", pausedAt: utcNow() },
        actor,
      );
      processState(this.projectRoot)
        .activeInvocations.get(workstreamId)
        ?.controller.abort(new Error("Workstream paused"));
      return updated;
    });
  }

  public async resume(workstreamId: string, actor?: Actor): Promise<WorkstreamRecord> {
    return withProjectMutation(this.projectRoot, async () => {
      const workstream = this.get(workstreamId);
      if (workstream.status !== "paused" && workstream.status !== "blocked") {
        throw new WorkstreamRuntimeError(
          `Cannot resume a ${workstream.status} workstream`,
          "invalid-state",
        );
      }
      return updateWorkstream(
        this.projectRoot,
        workstream,
        {
          status: "ready",
          activeRunId: undefined,
          resumedAt: utcNow(),
          blockedReason: undefined,
        },
        actor,
      );
    });
  }

  public async cancel(workstreamId: string, actor?: Actor): Promise<WorkstreamRecord> {
    return withProjectMutation(this.projectRoot, async () => {
      const workstream = this.get(workstreamId);
      if (workstream.status === "completed") {
        throw new WorkstreamRuntimeError(
          "Cannot cancel a completed workstream",
          "invalid-state",
        );
      }
      if (workstream.status === "cancelled") return workstream;
      const updated = await updateWorkstream(
        this.projectRoot,
        workstream,
        { status: "cancelled", cancelledAt: utcNow() },
        actor,
      );
      processState(this.projectRoot)
        .activeInvocations.get(workstreamId)
        ?.controller.abort(new Error("Workstream cancelled"));
      return updated;
    });
  }

  public async complete(workstreamId: string, actor?: Actor): Promise<WorkstreamRecord> {
    return withProjectMutation(this.projectRoot, async () => {
      const workstream = this.get(workstreamId);
      if (workstream.status === "completed") return workstream;
      if (workstream.status !== "ready" && workstream.status !== "blocked") {
        throw new WorkstreamRuntimeError(
          `Cannot complete a ${workstream.status} workstream`,
          "invalid-state",
        );
      }
      const evaluation = await evaluateCompletionPolicy(this.projectRoot, {
        branchId: workstream.branchId,
        policy: workstream.completionPolicy,
      });
      return updateWorkstream(
        this.projectRoot,
        workstream,
        {
          status: evaluation.passed ? "completed" : "blocked",
          completionEvaluation: evaluation,
          ...(evaluation.passed
            ? { completedAt: utcNow(), activeRunId: undefined }
            : { blockedReason: "completion policy did not pass" }),
        },
        actor,
      );
    });
  }

  public async recoverInterruptedRuns(actor?: Actor): Promise<RecoveryResult> {
    const recoveredWorkstreamIds: string[] = [];
    const interruptedRunIds: string[] = [];
    const failureObjectIds: string[] = [];
    for (const candidate of this.list()) {
      if (candidate.status !== "running") continue;
      if (processState(this.projectRoot).activeInvocations.has(candidate.workstreamId)) {
        continue;
      }
      await withProjectMutation(this.projectRoot, async () => {
        const workstream = this.get(candidate.workstreamId);
        if (workstream.status !== "running") return;
        const lingering = listCurrentObjects(this.projectRoot, workstream.branchId).filter(
          (object) => {
            if (object.objectType !== "run") return false;
            const content = contentOf(object, `run ${object.objectId}`);
            return (
              content.workstreamId === workstream.workstreamId &&
              (content.status === "reserved" || content.status === "running")
            );
          },
        );
        for (const run of lingering) {
          const content = contentOf(run, `run ${run.objectId}`);
          const failureObjectId = await createFailure(
            this.projectRoot,
            workstream,
            {
              runId: run.objectId,
              toolId: record(content.tool, "run.tool").toolId,
              phase: "recovery",
              reason: "Runtime restarted while the run was active",
            },
            actor,
          );
          failureObjectIds.push(failureObjectId);
          await updateRun(
            this.projectRoot,
            workstream.branchId,
            run.objectId,
            {
              ...content,
              status: "interrupted",
              finishedAt: utcNow(),
              error: {
                phase: "recovery",
                message: "Runtime restarted while the run was active",
                failureObjectId,
              },
            },
            actor,
          );
          interruptedRunIds.push(run.objectId);
        }
        if (lingering.length === 0) {
          failureObjectIds.push(
            await createFailure(
              this.projectRoot,
              workstream,
              {
                phase: "recovery",
                reason: "Workstream was running but had no recoverable active run",
              },
              actor,
            ),
          );
        }
        await updateWorkstream(
          this.projectRoot,
          workstream,
          {
            status: "paused",
            activeRunId: undefined,
            pausedAt: utcNow(),
            blockedReason: "interrupted runtime recovered",
          },
          actor,
        );
        recoveredWorkstreamIds.push(workstream.workstreamId);
      });
    }
    return {
      recoveredWorkstreamIds: recoveredWorkstreamIds.sort(),
      interruptedRunIds: interruptedRunIds.sort(),
      failureObjectIds: failureObjectIds.sort(),
    };
  }
}

/** Convenience reads for callers that do not need to construct a runtime. */
export function listWorkstreams(projectRoot: string): WorkstreamRecord[] {
  const records: WorkstreamRecord[] = [];
  for (const object of listCurrentObjects(resolve(projectRoot))) {
    if (!isRuntimeWorkstreamProjection(object)) continue;
    records.push(workstreamFromProjection(object));
  }
  return records.sort((left, right) => left.workstreamId.localeCompare(right.workstreamId));
}

export function getWorkstream(
  projectRoot: string,
  workstreamId: string,
): WorkstreamRecord {
  return getOwnedWorkstream(resolve(projectRoot), workstreamId);
}

/** Exposed for diagnostics; canonical branch objects remain the source of truth. */
export function workstreamBranchExists(projectRoot: string, branchId: string): boolean {
  return listBranches(resolve(projectRoot)).some((branch) => branch.branchId === branchId);
}
