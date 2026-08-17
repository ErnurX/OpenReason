import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  AgentCoordinator,
  AgentCoordinatorError,
  type AgentSessionLimits,
} from "../src/coordinator.js";
import {
  ModelRegistry,
  ScriptedModelAdapter,
  type ModelAdapter,
} from "../src/model.js";
import type { CompletionPolicy } from "../src/policy.js";
import { createBranch, createRp001Fixture, putObject } from "../src/project.js";
import { listCurrentObjects } from "../src/projection.js";
import {
  WorkstreamRuntime,
  WorkstreamRuntimeError,
  createWorkstream,
  type WorkstreamBudget,
} from "../src/runtime.js";
import { createCoreToolRegistry } from "../src/tools.js";

const workstreamBudget: WorkstreamBudget = {
  maxToolCalls: 20,
  maxWallTimeMs: 20_000,
  maxArtifactBytes: 1_000_000,
  maxCostMicros: 1_000_000,
};

const sessionLimits: AgentSessionLimits = {
  maxTurns: 10,
  maxInputTokens: 100_000,
  maxOutputTokens: 10_000,
  maxCostMicros: 1_000_000,
  repeatedActionLimit: 3,
};

const contextLimits = { maxCharacters: 30_000, maxEntries: 100 } as const;

const passingPolicy: CompletionPolicy = {
  schemaVersion: 1,
  policyId: "goal-visible",
  name: "Goal remains visible",
  rules: [{ ruleId: "goal", kind: "object_count", objectType: "goal", min: 1 }],
};

const failingPolicy: CompletionPolicy = {
  schemaVersion: 1,
  policyId: "claim-required",
  name: "A claim is required",
  rules: [{ ruleId: "claim", kind: "object_count", objectType: "claim", min: 1 }],
};

describe("Stage 4 provider-neutral agent coordinator", () => {
  const sandboxes: string[] = [];

  async function fixture(
    name: string,
    options: {
      readonly allowedToolIds?: readonly string[];
      readonly capabilities?: readonly ("network.access" | "spend")[];
      readonly completionPolicy?: CompletionPolicy;
    } = {},
  ) {
    const sandbox = await mkdtemp(join(tmpdir(), `rw-coordinator-${name}-`));
    sandboxes.push(sandbox);
    const root = join(sandbox, "project");
    const rp001 = await createRp001Fixture(root);
    const tools = createCoreToolRegistry();
    const workstream = await createWorkstream(root, {
      name,
      goalId: rp001.goal.objectId,
      allowedToolIds: options.allowedToolIds ?? [],
      capabilities: options.capabilities ?? [],
      budget: workstreamBudget,
      completionPolicy: options.completionPolicy ?? passingPolicy,
    });
    const runtime = new WorkstreamRuntime(root, tools);
    return { root, rp001, workstream, runtime };
  }

  async function coordinatorWith(
    setup: Awaited<ReturnType<typeof fixture>>,
    adapter: ModelAdapter,
    limits: AgentSessionLimits = sessionLimits,
  ) {
    const coordinator = new AgentCoordinator(
      setup.root,
      setup.runtime,
      new ModelRegistry().register(adapter),
    );
    const session = await coordinator.create({
      workstreamId: setup.workstream.workstreamId,
      adapterId: adapter.descriptor.adapterId,
      limits,
      context: contextLimits,
    });
    return { coordinator, session };
  }

  afterEach(async () => {
    await Promise.all(
      sandboxes.splice(0).map((sandbox) => rm(sandbox, { recursive: true, force: true })),
    );
  });

  it("rejects an escalation that omits attempted approaches", () => {
    expect(
      () =>
        new ScriptedModelAdapter({
          script: [
            {
              kind: "escalate",
              attemptedApproaches: [],
              evidenceObjectIds: [],
              blocker: "No route remains",
              requestedHumanInput: "Choose a new assumption",
            },
          ],
        }),
    ).toThrow("attemptedApproaches must not be empty");
  });

  async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() >= deadline) throw new Error("Timed out waiting for test state");
      await new Promise((resolveWait) => setTimeout(resolveWait, 5));
    }
  }

  it("delivers compiled RP-001 context with exact backrefs and keeps proposals branch-only and unreviewed", async () => {
    const setup = await fixture("proposal");
    const adapter = new ScriptedModelAdapter({
      script: [
        {
          kind: "propose-object",
          objectType: "claim",
          contextId: setup.rp001.context.objectId,
          content: { statement: "p(40) = 41^2 is composite" },
        },
      ],
    });
    const { coordinator, session } = await coordinatorWith(setup, adapter);
    const result = await coordinator.step(session.sessionId);

    expect(result.request.promptText).toContain(setup.rp001.goal.objectId);
    expect(result.request.contextDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.request.contextEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          objectId: setup.rp001.goal.objectId,
          versionId: setup.rp001.goal.versionId,
          contentHash: setup.rp001.goal.contentHash,
        }),
      ]),
    );
    expect(result.outcome.kind).toBe("proposed-object");
    if (result.outcome.kind !== "proposed-object") throw new Error("unexpected outcome");
    const proposal = listCurrentObjects(setup.root, setup.workstream.branchId).find(
      (object) => object.objectId === result.outcome.objectId,
    );
    expect(proposal).toMatchObject({ objectType: "claim" });
    expect(proposal?.content).toMatchObject({
      status: "unreviewed",
      contextId: setup.rp001.context.objectId,
      provenance: {
        kind: "model-proposal",
        sessionId: session.sessionId,
        modelTurnId: result.modelTurnId,
        contextDigest: result.request.contextDigest,
      },
    });
    expect(
      listCurrentObjects(setup.root, setup.rp001.project.manifest.defaultBranchId).some(
        (object) => object.objectId === proposal?.objectId,
      ),
    ).toBe(false);

    const turn = listCurrentObjects(setup.root, setup.workstream.branchId).find(
      (object) => object.objectId === result.modelTurnId,
    );
    expect(turn?.content).toMatchObject({
      kind: "model-turn",
      adapter: adapter.descriptor,
      request: {
        promptText: result.request.promptText,
        contextDigest: result.request.contextDigest,
        contextEntries: result.request.contextEntries,
      },
      action: result.response.action,
      actionHash: result.actionHash,
      usage: result.response.usage,
      actionApplied: true,
    });
  });

  it("routes an authorized model tool action through the ordinary Stage 3 runtime", async () => {
    const setup = await fixture("tool", { allowedToolIds: ["core.echo"] });
    const adapter = new ScriptedModelAdapter({
      script: [{ kind: "tool-call", toolId: "core.echo", input: { value: 41 } }],
    });
    const { coordinator, session } = await coordinatorWith(setup, adapter);
    const result = await coordinator.step(session.sessionId);

    expect(result.outcome.kind).toBe("tool-run");
    if (result.outcome.kind !== "tool-run") throw new Error("unexpected outcome");
    expect(result.outcome.execution.output).toEqual({ value: 41 });
    const toolRun = listCurrentObjects(setup.root, setup.workstream.branchId).find(
      (object) => object.objectId === result.outcome.execution.runId,
    );
    expect(toolRun?.content).toMatchObject({
      status: "succeeded",
      workstreamId: setup.workstream.workstreamId,
      tool: { toolId: "core.echo" },
      input: { value: 41 },
    });
    expect(setup.runtime.get(setup.workstream.workstreamId).usage.toolCalls).toBe(1);
  });

  it("appends typed steering between turns and records a typed checkpoint", async () => {
    const setup = await fixture("steering");
    const adapter = new ScriptedModelAdapter({
      script: [
        {
          kind: "checkpoint",
          summary: "Checked the first composite case",
          nextSteps: ["Generalize the factorization"],
          evidenceObjectIds: [],
        },
      ],
    });
    const { coordinator, session } = await coordinatorWith(setup, adapter);
    const steeringId = await coordinator.appendSteering(session.sessionId, {
      instruction: "Prioritize n=40 and preserve the counterexample.",
    });
    const result = await coordinator.step(session.sessionId);

    expect(result.request.steering).toEqual([
      expect.objectContaining({
        decisionId: steeringId,
        instruction: "Prioritize n=40 and preserve the counterexample.",
      }),
    ]);
    expect(result.outcome.kind).toBe("checkpoint");
    if (result.outcome.kind !== "checkpoint") throw new Error("unexpected outcome");
    const checkpoint = listCurrentObjects(setup.root, setup.workstream.branchId).find(
      (object) => object.objectId === result.outcome.decisionId,
    );
    expect(checkpoint?.content).toMatchObject({
      kind: "agent-checkpoint",
      sessionId: session.sessionId,
      modelTurnId: result.modelTurnId,
    });
    expect(coordinator.get(session.sessionId).consumedSteeringMessageIds).toContain(steeringId);
  });

  it("redacts secret-like query and steering text before canonical persistence", async () => {
    const setup = await fixture("redacted-steering");
    const adapter = new ScriptedModelAdapter({
      script: [
        {
          kind: "checkpoint",
          summary: "No credential retained",
          nextSteps: [],
          evidenceObjectIds: [],
        },
      ],
    });
    const coordinator = new AgentCoordinator(
      setup.root,
      setup.runtime,
      new ModelRegistry().register(adapter),
    );
    const session = await coordinator.create({
      workstreamId: setup.workstream.workstreamId,
      adapterId: adapter.descriptor.adapterId,
      limits: sessionLimits,
      context: {
        ...contextLimits,
        query: "inspect token=query-secret",
      },
    });
    await coordinator.appendSteering(session.sessionId, {
      instruction: "Use authorization: Bearer steering-secret",
    });
    const result = await coordinator.step(session.sessionId);

    expect(coordinator.get(session.sessionId).contextLimits.query).toBe(
      "inspect token=[REDACTED]",
    );
    expect(result.request.promptText).not.toContain("query-secret");
    expect(result.request.steering[0]?.instruction).not.toContain("steering-secret");
    expect(result.request.steering[0]?.instruction).toContain("[REDACTED]");
  });

  it("durably records structured escalation and pauses the workstream", async () => {
    const setup = await fixture("escalation");
    const adapter = new ScriptedModelAdapter({
      script: [
        {
          kind: "escalate",
          attemptedApproaches: ["Direct factor search", "Modular analysis"],
          evidenceObjectIds: [setup.rp001.goal.objectId],
          blocker: "The intended quantifier is ambiguous",
          requestedHumanInput: "Confirm whether negative n is in scope",
        },
      ],
    });
    const { coordinator, session } = await coordinatorWith(setup, adapter);
    const result = await coordinator.step(session.sessionId);

    expect(result.outcome.kind).toBe("escalation");
    if (result.outcome.kind !== "escalation") throw new Error("unexpected outcome");
    const failure = listCurrentObjects(setup.root, setup.workstream.branchId).find(
      (object) => object.objectId === result.outcome.failureId,
    );
    expect(failure?.content).toMatchObject({
      kind: "agent-escalation",
      status: "open",
      attemptedApproaches: ["Direct factor search", "Modular analysis"],
      evidenceObjectIds: [setup.rp001.goal.objectId],
      blocker: "The intended quantifier is ambiguous",
      requestedHumanInput: "Confirm whether negative n is in scope",
    });
    expect(setup.runtime.get(setup.workstream.workstreamId).status).toBe("paused");
    expect(coordinator.get(session.sessionId).status).toBe("paused");
  });

  it("blocks an actual model budget overrun before applying its action", async () => {
    const setup = await fixture("model-budget");
    const adapter = new ScriptedModelAdapter({
      script: [
        {
          schemaVersion: 1,
          action: {
            kind: "propose-object",
            objectType: "claim",
            content: { statement: "This action must not be promoted" },
          },
          usage: { inputTokens: 5, outputTokens: 101, costMicros: 0 },
        },
      ],
    });
    const { coordinator, session } = await coordinatorWith(setup, adapter, {
      ...sessionLimits,
      maxOutputTokens: 100,
    });
    const result = await coordinator.step(session.sessionId);

    expect(result.outcome.kind).toBe("blocked");
    expect(
      listCurrentObjects(setup.root, setup.workstream.branchId).filter(
        (object) =>
          object.objectType === "claim" &&
          (object.content as Record<string, unknown>).statement ===
            "This action must not be promoted",
      ),
    ).toHaveLength(0);
    expect(
      listCurrentObjects(setup.root, setup.workstream.branchId).some(
        (object) =>
          object.objectType === "failure" &&
          (object.content as Record<string, unknown>).kind === "agent-budget",
      ),
    ).toBe(true);
    expect(coordinator.get(session.sessionId).status).toBe("blocked");
  });

  it("uses deterministic action hashes to stop repeated-action loops before the excess action", async () => {
    const setup = await fixture("loop");
    const action = {
      kind: "propose-object" as const,
      objectType: "claim" as const,
      content: { statement: "Repeated unchanged proposal" },
    };
    const adapter = new ScriptedModelAdapter({ script: [action, action, action] });
    const { coordinator, session } = await coordinatorWith(setup, adapter, {
      ...sessionLimits,
      repeatedActionLimit: 2,
    });

    const first = await coordinator.step(session.sessionId);
    const second = await coordinator.step(session.sessionId);
    const third = await coordinator.step(session.sessionId);
    expect(new Set([first.actionHash, second.actionHash, third.actionHash]).size).toBe(1);
    expect(third.outcome.kind).toBe("blocked");
    expect(
      listCurrentObjects(setup.root, setup.workstream.branchId).filter(
        (object) =>
          object.objectType === "claim" &&
          (object.content as Record<string, unknown>).statement === "Repeated unchanged proposal",
      ),
    ).toHaveLength(2);
    expect(
      listCurrentObjects(setup.root, setup.workstream.branchId).some(
        (object) =>
          object.objectType === "failure" &&
          (object.content as Record<string, unknown>).kind === "agent-loop",
      ),
    ).toBe(true);
  });

  it("routes completion requests through policy and cannot declare completion itself", async () => {
    const setup = await fixture("completion", { completionPolicy: failingPolicy });
    const adapter = new ScriptedModelAdapter({
      script: [{ kind: "request-completion", rationale: "The prose sounds finished" }],
    });
    const { coordinator, session } = await coordinatorWith(setup, adapter);
    const result = await coordinator.step(session.sessionId);

    expect(result.outcome).toEqual({
      kind: "completion-evaluation",
      workstreamStatus: "blocked",
    });
    expect(setup.runtime.get(setup.workstream.workstreamId)).toMatchObject({
      status: "blocked",
      completionEvaluation: { passed: false },
    });
    expect(coordinator.get(session.sessionId).status).toBe("blocked");
  });

  it("runs the same coordinator workflow with interchangeable scripted descriptors", async () => {
    const firstSetup = await fixture("provider-a");
    const secondSetup = await fixture("provider-b");
    const action = {
      kind: "checkpoint" as const,
      summary: "Provider-neutral checkpoint",
      nextSteps: [] as string[],
      evidenceObjectIds: [] as string[],
    };
    const first = new ScriptedModelAdapter({
      adapterId: "scripted.a",
      provider: "provider-a",
      model: "model-a",
      script: [action],
    });
    const second = new ScriptedModelAdapter({
      adapterId: "scripted.b",
      provider: "provider-b",
      model: "model-b",
      script: [action],
    });
    const firstRun = await coordinatorWith(firstSetup, first);
    const secondRun = await coordinatorWith(secondSetup, second);

    const [a, b] = await Promise.all([
      firstRun.coordinator.step(firstRun.session.sessionId),
      secondRun.coordinator.step(secondRun.session.sessionId),
    ]);
    expect(a.outcome.kind).toBe("checkpoint");
    expect(b.outcome.kind).toBe("checkpoint");
    expect(a.response.action).toEqual(b.response.action);
    expect(a.request.contextEntries.length).toBeGreaterThan(0);
    expect(b.request.contextEntries.length).toBeGreaterThan(0);
  });

  it("denies a provider capability before invocation or any canonical write", async () => {
    const setup = await fixture("provider-denied");
    let invoked = false;
    const adapter: ModelAdapter = {
      descriptor: {
        schemaVersion: 1,
        adapterId: "remote.networked",
        provider: "remote-test",
        model: "remote-model",
        version: "1.0.0",
        configuration: {},
        requiredCapabilities: ["network.access", "spend"],
        reproducibility: "nondeterministic",
      },
      async invoke() {
        invoked = true;
        return {
          schemaVersion: 1,
          action: { kind: "request-completion", rationale: "unreachable" },
          usage: { inputTokens: 0, outputTokens: 0, costMicros: 0 },
        };
      },
    };
    const coordinator = new AgentCoordinator(
      setup.root,
      setup.runtime,
      new ModelRegistry().register(adapter),
    );
    const before = listCurrentObjects(setup.root, setup.workstream.branchId).map(
      (object) => `${object.objectId}@${object.versionId}`,
    );

    await expect(
      coordinator.create({
        workstreamId: setup.workstream.workstreamId,
        adapterId: adapter.descriptor.adapterId,
        limits: sessionLimits,
        context: contextLimits,
      }),
    ).rejects.toMatchObject<Partial<AgentCoordinatorError>>({ code: "provider-denied" });
    expect(invoked).toBe(false);
    expect(
      listCurrentObjects(setup.root, setup.workstream.branchId).map(
        (object) => `${object.objectId}@${object.versionId}`,
      ),
    ).toEqual(before);
  });

  it("records an unauthorized tool proposal as a failed, not-applied model turn", async () => {
    const setup = await fixture("unauthorized-model-tool");
    const adapter = new ScriptedModelAdapter({
      script: [{ kind: "tool-call", toolId: "core.echo", input: { value: 41 } }],
    });
    const { coordinator, session } = await coordinatorWith(setup, adapter);

    await expect(coordinator.step(session.sessionId)).rejects.toThrow();
    const objects = listCurrentObjects(setup.root, setup.workstream.branchId);
    const turn = objects.find(
      (object) =>
        object.objectType === "run" &&
        (object.content as Record<string, unknown>).kind === "model-turn",
    );
    expect(turn?.content).toMatchObject({
      status: "failed",
      actionApplied: false,
      actionError: { phase: "action-application" },
    });
    expect(
      objects.some(
        (object) =>
          object.objectType === "failure" &&
          (object.content as Record<string, unknown>).kind === "agent-action",
      ),
    ).toBe(true);
    expect(
      objects.filter(
        (object) =>
          object.objectType === "run" &&
          (object.content as Record<string, unknown>).tool !== undefined,
      ),
    ).toHaveLength(0);
    expect(coordinator.get(session.sessionId)).toMatchObject({
      status: "blocked",
      usage: { turns: 1 },
    });
  });

  it("aborts inference on a concurrent workstream pause and never applies the action", async () => {
    const setup = await fixture("pause-during-model");
    let invoked = false;
    const adapter: ModelAdapter = {
      descriptor: {
        schemaVersion: 1,
        adapterId: "cooperative.pause-test",
        provider: "local-test",
        model: "delayed",
        version: "1.0.0",
        configuration: {},
        requiredCapabilities: [],
        reproducibility: "deterministic",
      },
      async invoke(_request, context) {
        invoked = true;
        await new Promise<void>((_resolve, reject) => {
          const abort = (): void => reject(context.signal.reason);
          if (context.signal.aborted) abort();
          else context.signal.addEventListener("abort", abort, { once: true });
        });
        throw new Error("unreachable");
      },
    };
    const { coordinator, session } = await coordinatorWith(setup, adapter);
    const pending = coordinator.step(session.sessionId);
    await waitUntil(() => invoked);
    await setup.runtime.pause(setup.workstream.workstreamId);

    await expect(pending).rejects.toMatchObject<Partial<AgentCoordinatorError>>({
      code: "model-failed",
    });
    const objects = listCurrentObjects(setup.root, setup.workstream.branchId);
    expect(
      objects.filter(
        (object) =>
          object.objectType === "claim" &&
          (object.content as Record<string, unknown>).status === "unreviewed",
      ),
    ).toHaveLength(0);
    expect(
      objects.find(
        (object) =>
          object.objectType === "run" &&
          (object.content as Record<string, unknown>).kind === "model-turn",
      )?.content,
    ).toMatchObject({ status: "failed" });
    expect(coordinator.get(session.sessionId).status).toBe("paused");
  });

  it("serializes concurrent step calls for one session", async () => {
    const setup = await fixture("serialized-session");
    let activeInvocations = 0;
    let maximumActiveInvocations = 0;
    const adapter: ModelAdapter = {
      descriptor: {
        schemaVersion: 1,
        adapterId: "serialized.local",
        provider: "local-test",
        model: "serialized",
        version: "1.0.0",
        configuration: {},
        requiredCapabilities: [],
        reproducibility: "deterministic",
      },
      async invoke(request) {
        activeInvocations += 1;
        maximumActiveInvocations = Math.max(maximumActiveInvocations, activeInvocations);
        await new Promise((resolveWait) => setTimeout(resolveWait, 25));
        activeInvocations -= 1;
        return {
          schemaVersion: 1,
          action: {
            kind: "checkpoint",
            summary: `turn ${request.turn}`,
            nextSteps: [],
            evidenceObjectIds: [],
          },
          usage: {
            inputTokens: request.estimatedInputTokens,
            outputTokens: 1,
            costMicros: 0,
          },
        };
      },
    };
    const { coordinator, session } = await coordinatorWith(setup, adapter);

    const [first, second] = await Promise.all([
      coordinator.step(session.sessionId),
      coordinator.step(session.sessionId),
    ]);
    expect(maximumActiveInvocations).toBe(1);
    expect([first.request.turn, second.request.turn]).toEqual([1, 2]);
    expect(coordinator.get(session.sessionId).usage.turns).toBe(2);
  });

  it("lists an owned session once when a descendant branch inherits it", async () => {
    const setup = await fixture("owned-session");
    const adapter = new ScriptedModelAdapter({
      script: [
        {
          kind: "checkpoint",
          summary: "Stable branch ownership",
          nextSteps: [],
          evidenceObjectIds: [],
        },
      ],
    });
    const { coordinator, session } = await coordinatorWith(setup, adapter);
    await createBranch(setup.root, {
      name: "session-descendant",
      baseBranchId: setup.workstream.branchId,
    });

    expect(coordinator.list().map((item) => item.sessionId)).toEqual([
      session.sessionId,
    ]);
    expect(coordinator.get(session.sessionId).branchId).toBe(
      setup.workstream.branchId,
    );
  });

  it("rejects secret-bearing adapter data and redacts provider errors before persistence", async () => {
    expect(
      () =>
        new ScriptedModelAdapter({
          configuration: { apiKey: "sk-must-not-persist" },
          script: [
            {
              kind: "checkpoint",
              summary: "unreachable",
              nextSteps: [],
              evidenceObjectIds: [],
            },
          ],
        }),
    ).toThrow("secret-like material");
    expect(
      () =>
        new ScriptedModelAdapter({
          script: [
            {
              kind: "propose-object",
              objectType: "claim",
              content: { password: "hunter2" },
            },
          ],
        }),
    ).toThrow("secret-like material");

    const setup = await fixture("provider-secret-error");
    const adapter: ModelAdapter = {
      descriptor: {
        schemaVersion: 1,
        adapterId: "safe.error-test",
        provider: "local-test",
        model: "erroring",
        version: "1.0.0",
        configuration: {},
        requiredCapabilities: [],
        reproducibility: "deterministic",
      },
      async invoke() {
        throw new Error("provider password=hunter2");
      },
    };
    const { coordinator, session } = await coordinatorWith(setup, adapter);
    await expect(coordinator.step(session.sessionId)).rejects.toThrow(
      "password=[REDACTED]",
    );
    const durable = JSON.stringify(
      listCurrentObjects(setup.root, setup.workstream.branchId),
    );
    expect(durable).not.toContain("hunter2");
    expect(durable).toContain("[REDACTED]");
  });

  it("binds scripted sessions to the exact script and indexes it by durable turn", async () => {
    const setup = await fixture("script-binding");
    const script = [
      {
        kind: "checkpoint" as const,
        summary: "turn one",
        nextSteps: [] as string[],
        evidenceObjectIds: [] as string[],
      },
      {
        kind: "checkpoint" as const,
        summary: "turn two",
        nextSteps: [] as string[],
        evidenceObjectIds: [] as string[],
      },
    ];
    const firstAdapter = new ScriptedModelAdapter({ script });
    const { coordinator, session } = await coordinatorWith(setup, firstAdapter);
    expect((await coordinator.step(session.sessionId)).response.action).toMatchObject({
      summary: "turn one",
    });

    const reopened = new AgentCoordinator(
      setup.root,
      setup.runtime,
      new ModelRegistry().register(new ScriptedModelAdapter({ script })),
    );
    expect((await reopened.step(session.sessionId)).response.action).toMatchObject({
      summary: "turn two",
    });

    const substituted = new AgentCoordinator(
      setup.root,
      setup.runtime,
      new ModelRegistry().register(
        new ScriptedModelAdapter({
          script: [
            {
              kind: "checkpoint",
              summary: "different script",
              nextSteps: [],
              evidenceObjectIds: [],
            },
          ],
        }),
      ),
    );
    await expect(substituted.step(session.sessionId)).rejects.toMatchObject<
      Partial<AgentCoordinatorError>
    >({ code: "adapter-mismatch" });
  });

  it("linearizes direct actions after a queued pause and applies nothing afterward", async () => {
    const setup = await fixture("pause-before-action");
    let releaseModel!: () => void;
    let modelInvoked = false;
    const modelGate = new Promise<void>((resolveGate) => {
      releaseModel = resolveGate;
    });
    const adapter: ModelAdapter = {
      descriptor: {
        schemaVersion: 1,
        adapterId: "pause-race.local",
        provider: "local-test",
        model: "pause-race",
        version: "1.0.0",
        configuration: {},
        requiredCapabilities: [],
        reproducibility: "deterministic",
      },
      async invoke(request) {
        modelInvoked = true;
        await modelGate;
        return {
          schemaVersion: 1,
          action: {
            kind: "propose-object",
            objectType: "claim",
            content: { statement: "must not be applied after pause" },
          },
          usage: {
            inputTokens: request.estimatedInputTokens,
            outputTokens: 1,
            costMicros: 0,
          },
        };
      },
    };
    const { coordinator, session } = await coordinatorWith(setup, adapter);
    let releaseMutation!: () => void;
    let mutationHeld = false;
    const mutationGate = new Promise<void>((resolveGate) => {
      releaseMutation = resolveGate;
    });
    const holding = setup.runtime.withReadyMutation(
      setup.workstream.workstreamId,
      async () => {
        mutationHeld = true;
        await mutationGate;
      },
    );
    await waitUntil(() => mutationHeld);
    const pendingStep = coordinator.step(session.sessionId);
    await waitUntil(() => modelInvoked);
    const pendingPause = setup.runtime.pause(setup.workstream.workstreamId);
    releaseModel();
    releaseMutation();
    await holding;
    await pendingPause;

    await expect(pendingStep).rejects.toMatchObject<Partial<AgentCoordinatorError>>({
      code: "invalid-session-state",
    });
    expect(coordinator.get(session.sessionId).status).toBe("paused");
    expect(
      listCurrentObjects(setup.root, setup.workstream.branchId).filter(
        (object) =>
          object.objectType === "claim" &&
          (object.content as Record<string, unknown>).statement ===
            "must not be applied after pause",
      ),
    ).toHaveLength(0);
  });

  it("keeps a tool-interrupted session paused and resumable", async () => {
    const setup = await fixture("pause-tool-action", {
      allowedToolIds: ["core.delay"],
    });
    const adapter = new ScriptedModelAdapter({
      script: [
        {
          kind: "tool-call",
          toolId: "core.delay",
          input: { milliseconds: 5_000 },
        },
      ],
    });
    const { coordinator, session } = await coordinatorWith(setup, adapter);
    const pending = coordinator.step(session.sessionId);
    await waitUntil(
      () => setup.runtime.get(setup.workstream.workstreamId).status === "running",
    );
    await setup.runtime.pause(setup.workstream.workstreamId);

    await expect(pending).rejects.toMatchObject<Partial<WorkstreamRuntimeError>>({
      code: "interrupted",
    });
    expect(coordinator.get(session.sessionId).status).toBe("paused");
    expect(
      listCurrentObjects(setup.root, setup.workstream.branchId).filter(
        (object) =>
          object.objectType === "failure" &&
          (object.content as Record<string, unknown>).kind === "agent-action",
      ),
    ).toHaveLength(0);
    await expect(coordinator.resume(session.sessionId)).resolves.toMatchObject({
      status: "active",
    });
    expect(setup.runtime.get(setup.workstream.workstreamId).status).toBe("ready");
  });

  it("recovers an unaccounted model turn without replay or budget bypass", async () => {
    const setup = await fixture("turn-recovery");
    const adapter = new ScriptedModelAdapter({
      script: [
        {
          kind: "checkpoint",
          summary: "must not be invoked",
          nextSteps: [],
          evidenceObjectIds: [],
        },
      ],
    });
    const { coordinator, session } = await coordinatorWith(setup, adapter);
    const orphan = await putObject(setup.root, {
      branchId: setup.workstream.branchId,
      objectType: "run",
      content: {
        schemaVersion: 1,
        kind: "model-turn",
        sessionId: session.sessionId,
        workstreamId: session.workstreamId,
        status: "running",
        request: { estimatedInputTokens: 17 },
        steeringMessageIds: [],
        actionApplied: false,
      },
    });

    await expect(coordinator.recoverInterruptedTurns()).resolves.toEqual({
      recoveredSessionIds: [session.sessionId],
      interruptedModelTurnIds: [orphan.objectId],
      failureObjectIds: [expect.any(String)],
    });
    expect(coordinator.get(session.sessionId)).toMatchObject({
      status: "blocked",
      usage: { turns: 1, inputTokens: 17 },
      modelTurnIds: [orphan.objectId],
    });
    expect(setup.runtime.get(setup.workstream.workstreamId).status).toBe("paused");
    const recoveredTurn = listCurrentObjects(
      setup.root,
      setup.workstream.branchId,
    ).find((object) => object.objectId === orphan.objectId);
    expect(recoveredTurn?.content).toMatchObject({
      status: "interrupted",
      actionApplied: false,
      recovery: { previousStatus: "running" },
    });
    await expect(coordinator.recoverInterruptedTurns()).resolves.toEqual({
      recoveredSessionIds: [],
      interruptedModelTurnIds: [],
      failureObjectIds: [],
    });
  });
});
