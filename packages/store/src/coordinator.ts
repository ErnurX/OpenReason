import { resolve } from "node:path";

import {
  canonicalJson,
  createObjectId,
  utcNow,
  type Actor,
  type JsonValue,
  type ObjectType,
} from "@reasoning-workbench/project-format";

import {
  compileContext,
  redactSecretText,
  type ContextBundle,
} from "./context.js";
import {
  ModelRegistry,
  assertModelAdapterDescriptor,
  modelActionHash,
  validateModelResponse,
  type ModelAction,
  type ModelAdapterDescriptor,
  type ModelRequest,
  type ModelResponse,
  type ModelSteeringInput,
  type ModelUsage,
} from "./model.js";
import { putObject } from "./project.js";
import { listCurrentObjects, type ObjectProjection } from "./projection.js";
import {
  WorkstreamRuntime,
  WorkstreamRuntimeError,
  type RuntimeToolExecution,
  type WorkstreamRecord,
} from "./runtime.js";

export interface AgentSessionLimits {
  readonly maxTurns: number;
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly maxCostMicros: number;
  /** Maximum consecutive occurrences of one deterministic action hash. */
  readonly repeatedActionLimit: number;
}

export interface AgentContextLimits {
  readonly maxCharacters: number;
  readonly maxEntries: number;
  readonly query?: string;
  readonly includeObjectTypes?: readonly ObjectType[];
}

export interface AgentSessionUsage extends ModelUsage {
  readonly turns: number;
}

export type AgentSessionStatus = "active" | "paused" | "blocked" | "completed";

export interface AgentSessionRecord {
  readonly sessionId: string;
  readonly versionId: string;
  readonly version: number;
  readonly workstreamId: string;
  readonly branchId: string;
  readonly goalId: string;
  readonly environmentId: string;
  readonly adapter: ModelAdapterDescriptor;
  readonly limits: AgentSessionLimits;
  readonly contextLimits: AgentContextLimits;
  readonly usage: AgentSessionUsage;
  readonly status: AgentSessionStatus;
  readonly consumedSteeringMessageIds: readonly string[];
  readonly modelTurnIds: readonly string[];
  readonly lastActionHash?: string;
  readonly repeatedActionCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateAgentSessionOptions {
  readonly workstreamId: string;
  readonly adapter: ModelAdapterDescriptor;
  readonly limits: AgentSessionLimits;
  readonly context: AgentContextLimits;
  readonly actor?: Actor;
}

export interface AppendSteeringOptions {
  readonly instruction: string;
  readonly actor?: Actor;
}

export interface AgentStepOptions {
  readonly signal?: AbortSignal;
  readonly actor?: Actor;
}

export type AgentActionOutcome =
  | { readonly kind: "tool-run"; readonly execution: RuntimeToolExecution }
  | { readonly kind: "proposed-object"; readonly objectId: string }
  | { readonly kind: "checkpoint"; readonly decisionId: string }
  | { readonly kind: "escalation"; readonly failureId: string }
  | {
      readonly kind: "completion-evaluation";
      readonly workstreamStatus: WorkstreamRecord["status"];
    }
  | { readonly kind: "blocked"; readonly failureId: string; readonly reason: string };

export interface AgentStepResult {
  readonly session: AgentSessionRecord;
  readonly modelTurnId: string;
  readonly request: ModelRequest;
  readonly response: ModelResponse;
  readonly actionHash: string;
  readonly outcome: AgentActionOutcome;
}

export interface AgentRunResult {
  readonly session: AgentSessionRecord;
  readonly steps: readonly AgentStepResult[];
}

export interface AgentRecoveryResult {
  readonly recoveredSessionIds: readonly string[];
  readonly interruptedModelTurnIds: readonly string[];
  readonly failureObjectIds: readonly string[];
}

export class AgentCoordinatorError extends Error {
  public constructor(
    message: string,
    public readonly code:
      | "session-not-found"
      | "invalid-session-state"
      | "adapter-not-found"
      | "adapter-mismatch"
      | "provider-denied"
      | "model-failed"
      | "budget-exceeded"
      | "loop-detected",
  ) {
    super(message);
    this.name = "AgentCoordinatorError";
  }
}

const sessionTurnTails = new Map<string, Promise<void>>();

async function withSessionTurn<T>(
  projectRoot: string,
  sessionId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const key = `${resolve(projectRoot)}\0${sessionId}`;
  const predecessor = sessionTurnTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolveGate) => {
    release = resolveGate;
  });
  const tail = predecessor.catch(() => undefined).then(() => gate);
  sessionTurnTails.set(key, tail);
  await predecessor.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (sessionTurnTails.get(key) === tail) sessionTurnTails.delete(key);
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

function integer(value: unknown, label: string, positive = false): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || (positive && value === 0)) {
    throw new TypeError(`${label} must be a ${positive ? "positive" : "non-negative"} safe integer`);
  }
  return Number(value);
}

function uniqueStrings(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  const result = value.map((item, index) => stringValue(item, `${label}[${index}]`));
  if (new Set(result).size !== result.length) {
    throw new TypeError(`${label} cannot contain duplicates`);
  }
  return result;
}

function checkedLimits(value: AgentSessionLimits): AgentSessionLimits {
  return {
    maxTurns: integer(value.maxTurns, "limits.maxTurns", true),
    maxInputTokens: integer(value.maxInputTokens, "limits.maxInputTokens"),
    maxOutputTokens: integer(value.maxOutputTokens, "limits.maxOutputTokens"),
    maxCostMicros: integer(value.maxCostMicros, "limits.maxCostMicros"),
    repeatedActionLimit: integer(
      value.repeatedActionLimit,
      "limits.repeatedActionLimit",
      true,
    ),
  };
}

function checkedContextLimits(value: AgentContextLimits): AgentContextLimits {
  const result: AgentContextLimits = {
    maxCharacters: integer(value.maxCharacters, "context.maxCharacters", true),
    maxEntries: integer(value.maxEntries, "context.maxEntries", true),
    ...(value.query === undefined
      ? {}
      : { query: redactSecretText(stringValue(value.query, "context.query")) }),
    ...(value.includeObjectTypes === undefined
      ? {}
      : { includeObjectTypes: [...value.includeObjectTypes] }),
  };
  return result;
}

function usageFrom(value: unknown): AgentSessionUsage {
  const usage = record(value, "agent session usage");
  return {
    turns: integer(usage.turns, "agent session usage.turns"),
    inputTokens: integer(usage.inputTokens, "agent session usage.inputTokens"),
    outputTokens: integer(usage.outputTokens, "agent session usage.outputTokens"),
    costMicros: integer(usage.costMicros, "agent session usage.costMicros"),
  };
}

const SESSION_STATUSES = new Set<AgentSessionStatus>([
  "active",
  "paused",
  "blocked",
  "completed",
]);

function sessionFromProjection(object: ObjectProjection): AgentSessionRecord {
  if (object.objectType !== "run") throw new TypeError(`${object.objectId} is not a run`);
  const content = record(object.content, `agent session ${object.objectId}`);
  if (content.kind !== "agent-session") {
    throw new TypeError(`${object.objectId} is not an agent session`);
  }
  assertModelAdapterDescriptor(content.adapter);
  const status = stringValue(content.status, "agent session.status") as AgentSessionStatus;
  if (!SESSION_STATUSES.has(status)) throw new TypeError(`Unsupported session status: ${status}`);
  const context = record(content.contextLimits, "agent session.contextLimits");
  const limits = record(content.limits, "agent session.limits");
  return {
    sessionId: object.objectId,
    versionId: object.versionId,
    version: object.version,
    workstreamId: stringValue(content.workstreamId, "agent session.workstreamId"),
    branchId: stringValue(content.branchId, "agent session.branchId"),
    goalId: stringValue(content.goalId, "agent session.goalId"),
    environmentId: stringValue(content.environmentId, "agent session.environmentId"),
    adapter: content.adapter,
    limits: checkedLimits({
      maxTurns: Number(limits.maxTurns),
      maxInputTokens: Number(limits.maxInputTokens),
      maxOutputTokens: Number(limits.maxOutputTokens),
      maxCostMicros: Number(limits.maxCostMicros),
      repeatedActionLimit: Number(limits.repeatedActionLimit),
    }),
    contextLimits: checkedContextLimits({
      maxCharacters: Number(context.maxCharacters),
      maxEntries: Number(context.maxEntries),
      ...(typeof context.query === "string" ? { query: context.query } : {}),
      ...(Array.isArray(context.includeObjectTypes)
        ? { includeObjectTypes: context.includeObjectTypes as ObjectType[] }
        : {}),
    }),
    usage: usageFrom(content.usage),
    status,
    consumedSteeringMessageIds: uniqueStrings(
      content.consumedSteeringMessageIds,
      "agent session.consumedSteeringMessageIds",
    ),
    modelTurnIds: uniqueStrings(content.modelTurnIds, "agent session.modelTurnIds"),
    ...(typeof content.lastActionHash === "string"
      ? { lastActionHash: content.lastActionHash }
      : {}),
    repeatedActionCount: integer(
      content.repeatedActionCount,
      "agent session.repeatedActionCount",
    ),
    createdAt: stringValue(content.createdAt, "agent session.createdAt"),
    updatedAt: stringValue(content.updatedAt, "agent session.updatedAt"),
  };
}

function isOwnedAgentSessionProjection(object: ObjectProjection): boolean {
  if (
    object.objectType !== "run" ||
    typeof object.content !== "object" ||
    object.content === null ||
    Array.isArray(object.content)
  ) {
    return false;
  }
  const content = object.content as Record<string, unknown>;
  return content.kind === "agent-session" && content.branchId === object.branchId;
}

function sessionContent(
  session: AgentSessionRecord,
  changes: Record<string, unknown> = {},
): Record<string, unknown> {
  const content: Record<string, unknown> = {
    schemaVersion: 1,
    kind: "agent-session",
    workstreamId: session.workstreamId,
    branchId: session.branchId,
    goalId: session.goalId,
    environmentId: session.environmentId,
    adapter: session.adapter,
    limits: session.limits,
    contextLimits: session.contextLimits,
    usage: session.usage,
    status: session.status,
    consumedSteeringMessageIds: [...session.consumedSteeringMessageIds],
    modelTurnIds: [...session.modelTurnIds],
    ...(session.lastActionHash === undefined
      ? {}
      : { lastActionHash: session.lastActionHash }),
    repeatedActionCount: session.repeatedActionCount,
    createdAt: session.createdAt,
    updatedAt: utcNow(),
    ...changes,
  };
  for (const [key, value] of Object.entries(content)) {
    if (value === undefined) delete content[key];
  }
  return content;
}

function assertProviderAuthorized(
  descriptor: ModelAdapterDescriptor,
  workstream: WorkstreamRecord,
): void {
  const grants = new Set(workstream.capabilities);
  const missing = descriptor.requiredCapabilities.filter((capability) => !grants.has(capability));
  if (missing.length > 0) {
    throw new AgentCoordinatorError(
      `Model adapter ${descriptor.adapterId} requires ungranted capabilities: ${missing.join(", ")}`,
      "provider-denied",
    );
  }
}

function modelActor(sessionId: string): Actor {
  return { actorType: "agent", actorId: sessionId };
}

export async function createAgentSession(
  projectRoot: string,
  runtime: WorkstreamRuntime,
  options: CreateAgentSessionOptions,
): Promise<AgentSessionRecord> {
  const root = resolve(projectRoot);
  if (resolve(runtime.projectRoot) !== root) {
    throw new Error("Workstream runtime belongs to a different project");
  }
  assertModelAdapterDescriptor(options.adapter);
  const workstream = runtime.get(options.workstreamId);
  // Authorization precedes every canonical write, including session creation.
  assertProviderAuthorized(options.adapter, workstream);
  if (workstream.status !== "ready") {
    throw new AgentCoordinatorError(
      `Workstream ${workstream.workstreamId} is ${workstream.status}, not ready`,
      "invalid-session-state",
    );
  }
  const limits = checkedLimits(options.limits);
  const contextLimits = checkedContextLimits(options.context);
  const sessionId = createObjectId("run");
  const createdAt = utcNow();
  await putObject(root, {
    branchId: workstream.branchId,
    objectId: sessionId,
    objectType: "run",
    content: {
      schemaVersion: 1,
      kind: "agent-session",
      workstreamId: workstream.workstreamId,
      branchId: workstream.branchId,
      goalId: workstream.goalId,
      environmentId: workstream.environmentId,
      adapter: options.adapter,
      permissions: {
        allowedToolIds: [...workstream.allowedToolIds],
        grantedCapabilities: [...workstream.capabilities],
        requiredModelCapabilities: [...options.adapter.requiredCapabilities],
      },
      limits,
      contextLimits,
      usage: { turns: 0, inputTokens: 0, outputTokens: 0, costMicros: 0 },
      status: "active",
      consumedSteeringMessageIds: [],
      modelTurnIds: [],
      repeatedActionCount: 0,
      createdAt,
      updatedAt: createdAt,
    },
    actor: options.actor ?? modelActor(sessionId),
  });
  const selected = listCurrentObjects(root, workstream.branchId).find(
    (object) => object.objectId === sessionId,
  );
  if (selected === undefined) throw new Error(`Agent session was not projected: ${sessionId}`);
  return sessionFromProjection(selected);
}

function contextReferences(bundle: ContextBundle): ModelRequest["contextEntries"] {
  return bundle.entries.map((entry) => ({
    objectId: entry.objectId,
    versionId: entry.versionId,
    objectType: entry.objectType as ObjectType,
    contentHash: entry.contentHash,
  }));
}

function budgetViolation(
  usage: AgentSessionUsage,
  limits: AgentSessionLimits,
): string | undefined {
  if (usage.turns > limits.maxTurns) return "model turn budget exceeded";
  if (usage.inputTokens > limits.maxInputTokens) return "model input-token budget exceeded";
  if (usage.outputTokens > limits.maxOutputTokens) return "model output-token budget exceeded";
  if (usage.costMicros > limits.maxCostMicros) return "model cost budget exceeded";
  return undefined;
}

function addUsage(usage: AgentSessionUsage, delta: ModelUsage): AgentSessionUsage {
  return {
    turns: usage.turns + 1,
    inputTokens: usage.inputTokens + delta.inputTokens,
    outputTokens: usage.outputTokens + delta.outputTokens,
    costMicros: usage.costMicros + delta.costMicros,
  };
}

export class AgentCoordinator {
  public readonly projectRoot: string;

  public constructor(
    projectRoot: string,
    public readonly runtime: WorkstreamRuntime,
    public readonly models: ModelRegistry,
  ) {
    this.projectRoot = resolve(projectRoot);
    if (resolve(runtime.projectRoot) !== this.projectRoot) {
      throw new Error("Workstream runtime belongs to a different project");
    }
  }

  public async create(
    options: Omit<CreateAgentSessionOptions, "adapter"> & { readonly adapterId: string },
  ): Promise<AgentSessionRecord> {
    const adapter = this.models.get(options.adapterId);
    if (adapter === undefined) {
      throw new AgentCoordinatorError(`Unknown model adapter: ${options.adapterId}`, "adapter-not-found");
    }
    return createAgentSession(this.projectRoot, this.runtime, {
      workstreamId: options.workstreamId,
      adapter: adapter.descriptor,
      limits: options.limits,
      context: options.context,
      ...(options.actor === undefined ? {} : { actor: options.actor }),
    });
  }

  public get(sessionId: string): AgentSessionRecord {
    const selected = listCurrentObjects(this.projectRoot).find(
      (object) => object.objectId === sessionId && isOwnedAgentSessionProjection(object),
    );
    if (selected === undefined) {
      throw new AgentCoordinatorError(`Agent session does not exist: ${sessionId}`, "session-not-found");
    }
    return sessionFromProjection(selected);
  }

  public list(): AgentSessionRecord[] {
    return listCurrentObjects(this.projectRoot)
      .filter(isOwnedAgentSessionProjection)
      .map(sessionFromProjection)
      .sort((left, right) => left.sessionId.localeCompare(right.sessionId));
  }

  public async appendSteering(
    sessionId: string,
    options: AppendSteeringOptions,
  ): Promise<string> {
    const session = this.get(sessionId);
    if (session.status === "completed" || session.status === "blocked") {
      throw new AgentCoordinatorError(
        `Cannot steer a ${session.status} session`,
        "invalid-session-state",
      );
    }
    const instruction = redactSecretText(
      stringValue(options.instruction, "steering instruction"),
    );
    const decision = await putObject(this.projectRoot, {
      branchId: session.branchId,
      objectType: "decision",
      content: {
        schemaVersion: 1,
        kind: "steering-message",
        sessionId: session.sessionId,
        workstreamId: session.workstreamId,
        instruction,
        createdAt: utcNow(),
      },
      ...(options.actor === undefined ? {} : { actor: options.actor }),
    });
    return decision.objectId;
  }

  public async resume(sessionId: string, actor?: Actor): Promise<AgentSessionRecord> {
    const session = this.get(sessionId);
    if (session.status !== "paused") {
      throw new AgentCoordinatorError(
        `Cannot resume a ${session.status} session`,
        "invalid-session-state",
      );
    }
    const workstream = this.runtime.get(session.workstreamId);
    if (workstream.status === "paused" || workstream.status === "blocked") {
      await this.runtime.resume(workstream.workstreamId, actor);
    }
    return this.updateSession(session, { status: "active", resumedAt: utcNow() }, actor);
  }

  public async step(
    sessionId: string,
    options: AgentStepOptions = {},
  ): Promise<AgentStepResult> {
    return withSessionTurn(this.projectRoot, sessionId, () =>
      this.stepUnlocked(sessionId, options),
    );
  }

  private async stepUnlocked(
    sessionId: string,
    options: AgentStepOptions,
  ): Promise<AgentStepResult> {
    let session = this.get(sessionId);
    const recovered = await this.recoverSession(session, options.actor);
    if (recovered.interruptedModelTurnIds.length > 0) {
      throw new AgentCoordinatorError(
        `Recovered incomplete model turns for ${sessionId}; inspect the blocked session before continuing`,
        "invalid-session-state",
      );
    }
    session = this.get(sessionId);
    if (session.status !== "active") {
      throw new AgentCoordinatorError(
        `Agent session ${sessionId} is ${session.status}, not active`,
        "invalid-session-state",
      );
    }
    const adapter = this.models.get(session.adapter.adapterId);
    if (adapter === undefined) {
      throw new AgentCoordinatorError(
        `Model adapter is not registered: ${session.adapter.adapterId}`,
        "adapter-not-found",
      );
    }
    if (canonicalJson(adapter.descriptor) !== canonicalJson(session.adapter)) {
      throw new AgentCoordinatorError(
        `Registered descriptor changed for ${session.adapter.adapterId}`,
        "adapter-mismatch",
      );
    }
    let workstream = this.runtime.get(session.workstreamId);
    // Re-check before compiling or recording a provider execution. A denial has
    // no model turn, failure, or other canonical write.
    assertProviderAuthorized(adapter.descriptor, workstream);
    if (workstream.status !== "ready") {
      throw new AgentCoordinatorError(
        `Workstream ${workstream.workstreamId} is ${workstream.status}, not ready`,
        "invalid-session-state",
      );
    }
    // Backfill cost ledgers for Stage 4 sessions before admitting new spend.
    await this.reconcileWorkstreamModelCosts(session, options.actor);
    workstream = this.runtime.get(session.workstreamId);
    if (workstream.status !== "ready") {
      throw new AgentCoordinatorError(
        `Workstream ${workstream.workstreamId} is ${workstream.status}, not ready`,
        "invalid-session-state",
      );
    }
    if (session.usage.turns >= session.limits.maxTurns) {
      const reason = "model turn budget exhausted";
      const failureId = await this.blockWithoutTurn(session, "agent-budget", reason, options.actor);
      throw new AgentCoordinatorError(`${reason} (${failureId})`, "budget-exceeded");
    }

    const bundle = compileContext(this.projectRoot, {
      branchId: session.branchId,
      goalId: session.goalId,
      maxCharacters: session.contextLimits.maxCharacters,
      maxEntries: session.contextLimits.maxEntries,
      ...(session.contextLimits.query === undefined
        ? {}
        : { query: session.contextLimits.query }),
      ...(session.contextLimits.includeObjectTypes === undefined
        ? {}
        : { includeObjectTypes: session.contextLimits.includeObjectTypes }),
    });
    const remainingInputTokens =
      session.limits.maxInputTokens - session.usage.inputTokens;
    if (bundle.estimatedTokens > remainingInputTokens) {
      const reason =
        `compiled context estimate ${bundle.estimatedTokens} exceeds ` +
        `${remainingInputTokens} remaining input tokens`;
      const failureId = await this.blockWithoutTurn(
        session,
        "agent-budget",
        reason,
        options.actor,
      );
      throw new AgentCoordinatorError(`${reason} (${failureId})`, "budget-exceeded");
    }
    const steering = this.pendingSteering(session);
    const request: ModelRequest = {
      schemaVersion: 1,
      sessionId: session.sessionId,
      turn: session.usage.turns + 1,
      workstreamId: session.workstreamId,
      branchId: session.branchId,
      goalId: session.goalId,
      promptText: bundle.promptText,
      contextDigest: bundle.digest,
      contextEntries: contextReferences(bundle),
      estimatedInputTokens: bundle.estimatedTokens,
      limits: {
        remainingInputTokens,
        remainingOutputTokens:
          session.limits.maxOutputTokens - session.usage.outputTokens,
        remainingCostMicros:
          Math.min(
            session.limits.maxCostMicros - session.usage.costMicros,
            Math.max(
              0,
              workstream.budget.maxCostMicros - workstream.usage.costMicros,
            ),
          ),
      },
      steering,
    };
    const modelTurnId = createObjectId("run");
    const startedAt = utcNow();
    await putObject(this.projectRoot, {
      branchId: session.branchId,
      objectId: modelTurnId,
      objectType: "run",
      content: this.modelTurnBase(session, workstream, modelTurnId, request, bundle, startedAt),
      actor: options.actor ?? modelActor(session.sessionId),
    });

    const controller = new AbortController();
    const forwardAbort = (): void =>
      controller.abort(options.signal?.reason ?? new Error("Model call aborted"));
    if (options.signal?.aborted === true) forwardAbort();
    else options.signal?.addEventListener("abort", forwardAbort, { once: true });
    const controlPoll = setInterval(() => {
      try {
        const currentSession = this.get(sessionId);
        const currentWorkstream = this.runtime.get(currentSession.workstreamId);
        if (currentSession.status !== "active" || currentWorkstream.status !== "ready") {
          controller.abort(
            new Error(
              `Model call interrupted: session=${currentSession.status}, workstream=${currentWorkstream.status}`,
            ),
          );
        }
      } catch (error) {
        controller.abort(error);
      }
    }, 100);
    let response: ModelResponse;
    const invocationStartedAtMs = Date.now();
    try {
      response = validateModelResponse(
        await adapter.invoke(request, { signal: controller.signal }),
      );
    } catch (error) {
      const message = redactSecretText(
        error instanceof Error ? error.message : String(error),
      );
      await this.updateModelTurn(session, modelTurnId, {
        status: "failed",
        finishedAt: utcNow(),
        latencyMs: Math.max(0, Date.now() - invocationStartedAtMs),
        error: { phase: "model-invocation", message },
      }, options.actor);
      await this.createFailure(session, "agent-model", {
        modelTurnId,
        reason: message,
      }, options.actor);
      const currentWorkstream = this.runtime.get(session.workstreamId);
      if (currentWorkstream.status === "ready") {
        await this.runtime.pause(session.workstreamId, options.actor);
      }
      await this.updateSession(session, {
        status: currentWorkstream.status === "paused" ? "paused" : "blocked",
        usage: { ...session.usage, turns: session.usage.turns + 1 },
        modelTurnIds: [...session.modelTurnIds, modelTurnId],
      }, options.actor);
      throw new AgentCoordinatorError(message, "model-failed");
    } finally {
      clearInterval(controlPoll);
      options.signal?.removeEventListener("abort", forwardAbort);
    }

    const hash = modelActionHash(response.action);
    const repeatedActionCount =
      session.lastActionHash === hash ? session.repeatedActionCount + 1 : 1;
    const nextUsage = addUsage(session.usage, response.usage);
    await this.updateModelTurn(session, modelTurnId, {
      status: "succeeded",
      finishedAt: utcNow(),
      latencyMs: Math.max(0, Date.now() - invocationStartedAtMs),
      response,
      action: response.action,
      actionHash: hash,
      usage: response.usage,
      actionApplied: false,
    }, options.actor);
    if (response.usage.costMicros > 0) {
      await this.runtime.chargeExternalCost({
        workstreamId: session.workstreamId,
        runId: modelTurnId,
        costMicros: response.usage.costMicros,
        ...(options.actor === undefined ? {} : { actor: options.actor }),
      });
    }

    // Permissions or lifecycle may have changed during inference. The complete
    // response remains auditable, but its action is never applied from stale
    // authority or after a pause/cancel.
    session = this.get(sessionId);
    workstream = this.runtime.get(session.workstreamId);
    const lifecycleChanged = session.status !== "active" || workstream.status !== "ready";
    let providerDenied: AgentCoordinatorError | undefined;
    try {
      assertProviderAuthorized(adapter.descriptor, workstream);
    } catch (error) {
      if (error instanceof AgentCoordinatorError) providerDenied = error;
      else throw error;
    }
    if (lifecycleChanged || providerDenied !== undefined) {
      const reason = providerDenied?.message ??
        `Model action not applied: session=${session.status}, workstream=${workstream.status}`;
      await this.updateModelTurn(session, modelTurnId, {
        status: lifecycleChanged ? "interrupted" : "failed",
        actionApplied: false,
        actionError: { phase: "post-model-authorization", message: reason },
      }, options.actor);
      await this.createFailure(session, "agent-model", {
        modelTurnId,
        reason,
        phase: "post-model-authorization",
      }, options.actor);
      if (workstream.status === "ready") {
        await this.runtime.pause(session.workstreamId, options.actor);
      }
      await this.updateSession(session, {
        status: workstream.status === "paused" ? "paused" : "blocked",
        usage: nextUsage,
        consumedSteeringMessageIds: [
          ...session.consumedSteeringMessageIds,
          ...steering.map((item) => item.decisionId),
        ],
        modelTurnIds: [...session.modelTurnIds, modelTurnId],
        lastActionHash: hash,
        repeatedActionCount,
      }, options.actor);
      throw providerDenied ?? new AgentCoordinatorError(reason, "invalid-session-state");
    }

    const violation = budgetViolation(nextUsage, session.limits);
    if (violation !== undefined) {
      const failureId = await this.blockAfterTurn(
        session,
        modelTurnId,
        "agent-budget",
        violation,
        nextUsage,
        hash,
        repeatedActionCount,
        steering.map((item) => item.decisionId),
        options.actor,
      );
      return {
        session: this.get(sessionId), modelTurnId, request, response, actionHash: hash,
        outcome: { kind: "blocked", failureId, reason: violation },
      };
    }
    if (repeatedActionCount > session.limits.repeatedActionLimit) {
      const reason = `repeated action limit exceeded for ${hash}`;
      const failureId = await this.blockAfterTurn(
        session,
        modelTurnId,
        "agent-loop",
        reason,
        nextUsage,
        hash,
        repeatedActionCount,
        steering.map((item) => item.decisionId),
        options.actor,
      );
      return {
        session: this.get(sessionId), modelTurnId, request, response, actionHash: hash,
        outcome: { kind: "blocked", failureId, reason },
      };
    }

    let outcome: AgentActionOutcome;
    try {
      outcome = await this.applyAction(session, modelTurnId, response.action, options.actor);
    } catch (error) {
      const message = redactSecretText(
        error instanceof Error ? error.message : String(error),
      );
      const failedWorkstream = this.runtime.get(session.workstreamId);
      const interruptedByPause = failedWorkstream.status === "paused";
      await this.updateModelTurn(session, modelTurnId, {
        status: interruptedByPause ? "interrupted" : "failed",
        actionApplied: false,
        actionError: { phase: "action-application", message },
      }, options.actor);
      if (!interruptedByPause) {
        await this.createFailure(session, "agent-action", {
          modelTurnId,
          actionHash: hash,
          reason: message,
        }, options.actor);
      }
      if (failedWorkstream.status === "ready") {
        await this.runtime.pause(session.workstreamId, options.actor);
      }
      await this.updateSession(session, {
        status: interruptedByPause ? "paused" : "blocked",
        usage: nextUsage,
        consumedSteeringMessageIds: [
          ...session.consumedSteeringMessageIds,
          ...steering.map((item) => item.decisionId),
        ],
        modelTurnIds: [...session.modelTurnIds, modelTurnId],
        lastActionHash: hash,
        repeatedActionCount,
      }, options.actor);
      if (
        interruptedByPause &&
        error instanceof WorkstreamRuntimeError &&
        error.code === "invalid-state"
      ) {
        // A pause can win either just before the post-inference lifecycle
        // check or while the action is queued on the runtime mutation lock.
        // Normalize both safe linearizations to the coordinator-level code.
        throw new AgentCoordinatorError(message, "invalid-session-state");
      }
      throw error;
    }
    await this.updateModelTurn(session, modelTurnId, {
      actionApplied: true,
      actionOutcome: outcome as unknown as JsonValue,
    }, options.actor);
    const latestWorkstream = this.runtime.get(session.workstreamId);
    const nextStatus: AgentSessionStatus =
      outcome.kind === "escalation"
        ? "paused"
        : latestWorkstream.status === "completed"
          ? "completed"
          : latestWorkstream.status === "paused"
            ? "paused"
          : latestWorkstream.status === "blocked" || latestWorkstream.status === "cancelled"
            ? "blocked"
            : "active";
    const updated = await this.updateSession(session, {
      usage: nextUsage,
      status: nextStatus,
      consumedSteeringMessageIds: [
        ...session.consumedSteeringMessageIds,
        ...steering.map((item) => item.decisionId),
      ],
      modelTurnIds: [...session.modelTurnIds, modelTurnId],
      lastActionHash: hash,
      repeatedActionCount,
    }, options.actor);
    return { session: updated, modelTurnId, request, response, actionHash: hash, outcome };
  }

  public async run(
    sessionId: string,
    options: AgentStepOptions = {},
  ): Promise<AgentRunResult> {
    const steps: AgentStepResult[] = [];
    while (this.get(sessionId).status === "active") {
      const step = await this.step(sessionId, options);
      steps.push(step);
      if (
        step.outcome.kind === "checkpoint" ||
        step.outcome.kind === "escalation" ||
        step.outcome.kind === "completion-evaluation" ||
        step.outcome.kind === "blocked"
      ) {
        break;
      }
    }
    return { session: this.get(sessionId), steps };
  }

  public async recoverInterruptedTurns(actor?: Actor): Promise<AgentRecoveryResult> {
    const recoveredSessionIds: string[] = [];
    const interruptedModelTurnIds: string[] = [];
    const failureObjectIds: string[] = [];
    for (const candidate of this.list()) {
      const recovered = await withSessionTurn(
        this.projectRoot,
        candidate.sessionId,
        () => this.recoverSession(this.get(candidate.sessionId), actor),
      );
      if (recovered.interruptedModelTurnIds.length === 0) continue;
      recoveredSessionIds.push(candidate.sessionId);
      interruptedModelTurnIds.push(...recovered.interruptedModelTurnIds);
      failureObjectIds.push(...recovered.failureObjectIds);
    }
    return {
      recoveredSessionIds: recoveredSessionIds.sort(),
      interruptedModelTurnIds: interruptedModelTurnIds.sort(),
      failureObjectIds: failureObjectIds.sort(),
    };
  }

  private pendingSteering(session: AgentSessionRecord): ModelSteeringInput[] {
    const consumed = new Set(session.consumedSteeringMessageIds);
    return listCurrentObjects(this.projectRoot, session.branchId)
      .filter((object) => {
        if (object.objectType !== "decision" || consumed.has(object.objectId)) return false;
        const content = record(object.content, `decision ${object.objectId}`);
        return content.kind === "steering-message" && content.sessionId === session.sessionId;
      })
      .sort((left, right) => left.objectId.localeCompare(right.objectId))
      .map((object) => {
        const content = record(object.content, `steering ${object.objectId}`);
        return {
          decisionId: object.objectId,
          instruction: stringValue(content.instruction, "steering instruction"),
          createdAt: stringValue(content.createdAt, "steering createdAt"),
        };
      });
  }

  private async recoverSession(
    session: AgentSessionRecord,
    actor?: Actor,
  ): Promise<AgentRecoveryResult> {
    const knownTurnIds = new Set(session.modelTurnIds);
    const incomplete = listCurrentObjects(this.projectRoot, session.branchId)
      .filter((object) => {
        if (object.objectType !== "run" || knownTurnIds.has(object.objectId)) {
          return false;
        }
        const content = record(object.content, `run ${object.objectId}`);
        return content.kind === "model-turn" && content.sessionId === session.sessionId;
      })
      .sort((left, right) => left.objectId.localeCompare(right.objectId));
    if (incomplete.length === 0) {
      return {
        recoveredSessionIds: [],
        interruptedModelTurnIds: [],
        failureObjectIds: [],
      };
    }

    let usage = session.usage;
    const steeringIds = new Set(session.consumedSteeringMessageIds);
    const interruptedModelTurnIds: string[] = [];
    const failureObjectIds: string[] = [];
    for (const turn of incomplete) {
      const content = record(turn.content, `model turn ${turn.objectId}`);
      const response =
        typeof content.response === "object" &&
        content.response !== null &&
        !Array.isArray(content.response)
          ? (content.response as Record<string, unknown>)
          : undefined;
      const responseUsage =
        response !== undefined &&
        typeof response.usage === "object" &&
        response.usage !== null &&
        !Array.isArray(response.usage)
          ? (response.usage as Record<string, unknown>)
          : undefined;
      const request =
        typeof content.request === "object" &&
        content.request !== null &&
        !Array.isArray(content.request)
          ? (content.request as Record<string, unknown>)
          : {};
      let delta: ModelUsage;
      try {
        delta = responseUsage === undefined
          ? {
              inputTokens: integer(
                request.estimatedInputTokens ?? 0,
                "recovered request.estimatedInputTokens",
              ),
              outputTokens: 0,
              costMicros: 0,
            }
          : {
              inputTokens: integer(
                responseUsage.inputTokens,
                "recovered response.inputTokens",
              ),
              outputTokens: integer(
                responseUsage.outputTokens,
                "recovered response.outputTokens",
              ),
              costMicros: integer(
                responseUsage.costMicros,
                "recovered response.costMicros",
              ),
            };
      } catch {
        delta = { inputTokens: 0, outputTokens: 0, costMicros: 0 };
      }
      usage = addUsage(usage, delta);
      if (responseUsage !== undefined && delta.costMicros > 0) {
        const charge = await this.runtime.chargeExternalCost({
          workstreamId: session.workstreamId,
          runId: turn.objectId,
          costMicros: delta.costMicros,
          ...(actor === undefined ? {} : { actor }),
        });
        if (charge.failureObjectId !== undefined) {
          failureObjectIds.push(charge.failureObjectId);
        }
      }
      for (const steeringId of Array.isArray(content.steeringMessageIds)
        ? content.steeringMessageIds
        : []) {
        if (typeof steeringId === "string") steeringIds.add(steeringId);
      }
      const previousStatus =
        typeof content.status === "string" ? content.status : "unknown";
      const actionApplied = content.actionApplied === true;
      await this.updateModelTurn(session, turn.objectId, {
        ...(actionApplied
          ? {}
          : {
              status: "interrupted",
              actionApplied: false,
              finishedAt: utcNow(),
            }),
        recoveredAt: utcNow(),
        recovery: {
          previousStatus,
          actionApplied,
          reason: "session did not account for this durable model turn",
        },
      }, actor);
      const failureId = await this.createFailure(session, "agent-turn-recovery", {
        modelTurnId: turn.objectId,
        previousStatus,
        actionApplied,
        accountedUsage: delta,
        reason: "incomplete model turn recovered without replaying its action",
      }, actor);
      interruptedModelTurnIds.push(turn.objectId);
      failureObjectIds.push(failureId);
    }

    let workstream = this.runtime.get(session.workstreamId);
    if (workstream.status === "ready") {
      try {
        workstream = await this.runtime.pause(session.workstreamId, actor);
      } catch (error) {
        workstream = this.runtime.get(session.workstreamId);
        if (workstream.status === "ready") throw error;
      }
    }
    await this.updateSession(session, {
      status: workstream.status === "completed" ? "completed" : "blocked",
      usage,
      consumedSteeringMessageIds: [...steeringIds],
      modelTurnIds: [
        ...session.modelTurnIds,
        ...incomplete.map((turn) => turn.objectId),
      ],
      blockedReason:
        "incomplete model turn recovered; unknown provider effects require explicit review",
      recoveredAt: utcNow(),
    }, actor);
    return {
      recoveredSessionIds: [session.sessionId],
      interruptedModelTurnIds,
      failureObjectIds,
    };
  }

  private async reconcileWorkstreamModelCosts(
    session: AgentSessionRecord,
    actor?: Actor,
  ): Promise<void> {
    if (session.modelTurnIds.length === 0) return;
    const turns = new Map(
      listCurrentObjects(this.projectRoot, session.branchId)
        .filter((object) => object.objectType === "run")
        .map((object) => [object.objectId, object] as const),
    );
    for (const modelTurnId of session.modelTurnIds) {
      const turn = turns.get(modelTurnId);
      if (turn === undefined) {
        throw new AgentCoordinatorError(
          `Accounted model turn is not visible: ${modelTurnId}`,
          "invalid-session-state",
        );
      }
      const content = record(turn.content, `model turn ${modelTurnId}`);
      if (content.kind !== "model-turn" || content.sessionId !== session.sessionId) {
        throw new AgentCoordinatorError(
          `Run is not owned by agent session ${session.sessionId}: ${modelTurnId}`,
          "invalid-session-state",
        );
      }
      if (
        typeof content.response !== "object" ||
        content.response === null ||
        Array.isArray(content.response)
      ) {
        continue;
      }
      const response = content.response as Record<string, unknown>;
      const usage = record(response.usage, `model turn ${modelTurnId}.response.usage`);
      const costMicros = integer(usage.costMicros, `model turn ${modelTurnId}.costMicros`);
      if (costMicros > 0) {
        await this.runtime.chargeExternalCost({
          workstreamId: session.workstreamId,
          runId: modelTurnId,
          costMicros,
          ...(actor === undefined ? {} : { actor }),
        });
      }
    }
  }

  private modelTurnBase(
    session: AgentSessionRecord,
    workstream: WorkstreamRecord,
    modelTurnId: string,
    request: ModelRequest,
    bundle: ContextBundle,
    startedAt: string,
  ): Record<string, unknown> {
    return {
      schemaVersion: 1,
      kind: "model-turn",
      runId: modelTurnId,
      sessionId: session.sessionId,
      turn: request.turn,
      workstreamId: session.workstreamId,
      branchId: session.branchId,
      environmentId: session.environmentId,
      adapter: session.adapter,
      permissions: {
        allowedToolIds: [...workstream.allowedToolIds],
        grantedCapabilities: [...workstream.capabilities],
        requiredModelCapabilities: [...session.adapter.requiredCapabilities],
      },
      request,
      context: {
        digest: bundle.digest,
        promptText: bundle.promptText,
        entries: bundle.entries,
        estimatedTokens: bundle.estimatedTokens,
        usedCharacters: bundle.usedCharacters,
        omittedEntryCount: bundle.omittedEntryCount,
        omittedObjectIds: bundle.omittedObjectIds,
      },
      steeringMessageIds: request.steering.map((item) => item.decisionId),
      nondeterminism: session.adapter.reproducibility,
      status: "running",
      startedAt,
    };
  }

  private async applyAction(
    session: AgentSessionRecord,
    modelTurnId: string,
    action: ModelAction,
    actor?: Actor,
  ): Promise<AgentActionOutcome> {
    switch (action.kind) {
      case "tool-call": {
        const execution = await this.runtime.executeTool({
          workstreamId: session.workstreamId,
          toolId: action.toolId,
          input: action.input,
          ...(action.timeoutMs === undefined ? {} : { timeoutMs: action.timeoutMs }),
          ...(actor === undefined ? {} : { actor }),
        });
        return { kind: "tool-run", execution };
      }
      case "propose-object": {
        return this.runtime.withReadyMutation(session.workstreamId, async () => {
          if (action.contextId !== undefined) {
            const context = listCurrentObjects(this.projectRoot, session.branchId).find(
              (object) => object.objectId === action.contextId && object.objectType === "context",
            );
            if (context === undefined) {
              throw new TypeError(`Proposed context is not visible: ${action.contextId}`);
            }
          }
          const proposed = await putObject(this.projectRoot, {
            branchId: session.branchId,
            objectType: action.objectType,
            content: {
              ...action.content,
              ...(action.contextId === undefined ? {} : { contextId: action.contextId }),
              status: "unreviewed",
              provenance: {
                kind: "model-proposal",
                sessionId: session.sessionId,
                modelTurnId,
                turn: session.usage.turns + 1,
                contextDigest: this.modelTurnContextDigest(modelTurnId, session.branchId),
              },
            },
            actor: actor ?? modelActor(session.sessionId),
          });
          return { kind: "proposed-object", objectId: proposed.objectId };
        });
      }
      case "checkpoint": {
        return this.runtime.withReadyMutation(session.workstreamId, async () => {
          this.assertVisibleEvidence(session.branchId, action.evidenceObjectIds);
          const decision = await putObject(this.projectRoot, {
            branchId: session.branchId,
            objectType: "decision",
            content: {
              schemaVersion: 1,
              kind: "agent-checkpoint",
              sessionId: session.sessionId,
              workstreamId: session.workstreamId,
              modelTurnId,
              summary: action.summary,
              nextSteps: [...action.nextSteps],
              evidenceObjectIds: [...action.evidenceObjectIds],
              createdAt: utcNow(),
            },
            actor: actor ?? modelActor(session.sessionId),
          });
          return { kind: "checkpoint", decisionId: decision.objectId };
        });
      }
      case "escalate": {
        const failureId = await this.runtime.withReadyMutation(
          session.workstreamId,
          async () => {
            this.assertVisibleEvidence(session.branchId, action.evidenceObjectIds);
            return this.createFailure(session, "agent-escalation", {
              modelTurnId,
              attemptedApproaches: [...action.attemptedApproaches],
              evidenceObjectIds: [...action.evidenceObjectIds],
              blocker: action.blocker,
              requestedHumanInput: action.requestedHumanInput,
            }, actor);
          },
        );
        if (this.runtime.get(session.workstreamId).status === "ready") {
          await this.runtime.pause(session.workstreamId, actor);
        }
        return { kind: "escalation", failureId };
      }
      case "request-completion": {
        const workstream = await this.runtime.complete(session.workstreamId, actor);
        return { kind: "completion-evaluation", workstreamStatus: workstream.status };
      }
    }
  }

  private assertVisibleEvidence(branchId: string, objectIds: readonly string[]): void {
    const visible = new Set(listCurrentObjects(this.projectRoot, branchId).map((item) => item.objectId));
    for (const objectId of objectIds) {
      if (!visible.has(objectId)) throw new TypeError(`Evidence object is not visible: ${objectId}`);
    }
  }

  private modelTurnContextDigest(modelTurnId: string, branchId: string): string {
    const turn = listCurrentObjects(this.projectRoot, branchId).find(
      (object) => object.objectId === modelTurnId,
    );
    const content = record(turn?.content, `model turn ${modelTurnId}`);
    const request = record(content.request, `model turn ${modelTurnId}.request`);
    return stringValue(request.contextDigest, "model turn context digest");
  }

  private async updateSession(
    session: AgentSessionRecord,
    changes: Record<string, unknown>,
    actor?: Actor,
  ): Promise<AgentSessionRecord> {
    const selected = listCurrentObjects(this.projectRoot, session.branchId).find(
      (object) => object.objectId === session.sessionId,
    );
    if (selected === undefined) {
      throw new Error(`Agent session does not exist: ${session.sessionId}`);
    }
    await putObject(this.projectRoot, {
      branchId: session.branchId,
      objectId: session.sessionId,
      objectType: "run",
      // Preserve immutable provenance fields (notably the exact permissions
      // snapshot) across mutable session-status/usage versions.
      content: {
        ...record(selected.content, `agent session ${session.sessionId}`),
        ...sessionContent(session, changes),
      },
      actor: actor ?? modelActor(session.sessionId),
    });
    return this.get(session.sessionId);
  }

  private async updateModelTurn(
    session: AgentSessionRecord,
    modelTurnId: string,
    changes: Record<string, unknown>,
    actor?: Actor,
  ): Promise<void> {
    const selected = listCurrentObjects(this.projectRoot, session.branchId).find(
      (object) => object.objectId === modelTurnId,
    );
    if (selected === undefined) throw new Error(`Model turn does not exist: ${modelTurnId}`);
    await putObject(this.projectRoot, {
      branchId: session.branchId,
      objectId: modelTurnId,
      objectType: "run",
      content: { ...record(selected.content, `model turn ${modelTurnId}`), ...changes },
      actor: actor ?? modelActor(session.sessionId),
    });
  }

  private async createFailure(
    session: AgentSessionRecord,
    kind: string,
    details: Record<string, unknown>,
    actor?: Actor,
  ): Promise<string> {
    const failure = await putObject(this.projectRoot, {
      branchId: session.branchId,
      objectType: "failure",
      content: {
        schemaVersion: 1,
        kind,
        status: "open",
        sessionId: session.sessionId,
        workstreamId: session.workstreamId,
        branchId: session.branchId,
        occurredAt: utcNow(),
        ...details,
      },
      actor: actor ?? modelActor(session.sessionId),
    });
    return failure.objectId;
  }

  private async blockWithoutTurn(
    session: AgentSessionRecord,
    kind: "agent-budget" | "agent-loop",
    reason: string,
    actor?: Actor,
  ): Promise<string> {
    const failureId = await this.createFailure(session, kind, {
      reason,
      limits: session.limits,
      usage: session.usage,
    }, actor);
    await this.runtime.pause(session.workstreamId, actor);
    await this.updateSession(session, { status: "blocked", blockedReason: reason }, actor);
    return failureId;
  }

  private async blockAfterTurn(
    session: AgentSessionRecord,
    modelTurnId: string,
    kind: "agent-budget" | "agent-loop",
    reason: string,
    usage: AgentSessionUsage,
    actionHash: string,
    repeatedActionCount: number,
    steeringMessageIds: readonly string[],
    actor?: Actor,
  ): Promise<string> {
    const failureId = await this.createFailure(session, kind, {
      modelTurnId,
      reason,
      limits: session.limits,
      usage,
      actionHash,
      repeatedActionCount,
    }, actor);
    await this.runtime.pause(session.workstreamId, actor);
    await this.updateSession(session, {
      status: "blocked",
      usage,
      consumedSteeringMessageIds: [
        ...session.consumedSteeringMessageIds,
        ...steeringMessageIds,
      ],
      modelTurnIds: [...session.modelTurnIds, modelTurnId],
      lastActionHash: actionHash,
      repeatedActionCount,
      blockedReason: reason,
    }, actor);
    return failureId;
  }
}

// Keep the runtime error type in the public surface for callers that want to
// distinguish an authorized model tool request rejected by Stage 3 policy.
export { WorkstreamRuntimeError };
