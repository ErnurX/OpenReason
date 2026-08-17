import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { CompletionPolicy } from "../src/policy.js";
import {
  createProject,
  projectHistory,
  putObject,
  verifyProject,
} from "../src/project.js";
import { listCurrentObjects } from "../src/projection.js";
import {
  WorkstreamRuntime,
  WorkstreamRuntimeError,
  createWorkstream,
  type WorkstreamBudget,
} from "../src/runtime.js";
import { ToolRegistry, createCoreToolRegistry } from "../src/tools.js";

const generousBudget: WorkstreamBudget = {
  maxToolCalls: 20,
  maxWallTimeMs: 20_000,
  maxArtifactBytes: 1_000_000,
  maxCostMicros: 1_000_000,
};

const completionPolicy: CompletionPolicy = {
  schemaVersion: 1,
  policyId: "goal-visible",
  name: "A goal remains visible",
  rules: [
    {
      ruleId: "goal",
      kind: "object_count",
      objectType: "goal",
      min: 1,
    },
  ],
};

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for runtime state");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("Stage 3 branch-scoped workstream runtime", () => {
  const sandboxes: string[] = [];

  async function fixture(name: string): Promise<{
    root: string;
    goalId: string;
    baseBranchId: string;
  }> {
    const sandbox = await mkdtemp(join(tmpdir(), `rw-runtime-${name}-`));
    sandboxes.push(sandbox);
    const root = join(sandbox, "project");
    const project = await createProject(root, { title: name });
    const goal = await putObject(root, {
      branchId: project.manifest.defaultBranchId,
      objectType: "goal",
      content: { statement: `Goal for ${name}` },
    });
    return {
      root,
      goalId: goal.objectId,
      baseBranchId: project.manifest.defaultBranchId,
    };
  }

  async function makeWorkstream(
    root: string,
    goalId: string,
    registry: ToolRegistry,
    toolIds: readonly string[],
    budget: WorkstreamBudget = generousBudget,
    name = "exploration",
  ) {
    const capabilities = [
      ...new Set(
        toolIds.flatMap(
          (toolId) => registry.get(toolId)?.contract.requiredCapabilities ?? [],
        ),
      ),
    ];
    return createWorkstream(root, {
      name,
      goalId,
      allowedToolIds: toolIds,
      capabilities,
      budget,
      completionPolicy,
    });
  }

  afterEach(async () => {
    await Promise.all(
      sandboxes.splice(0).map((sandbox) =>
        rm(sandbox, { recursive: true, force: true }),
      ),
    );
  });

  it("creates an isolated branch and denies unauthorized tools without a run", async () => {
    const { root, goalId, baseBranchId } = await fixture("authorization");
    const registry = createCoreToolRegistry();
    const workstream = await makeWorkstream(root, goalId, registry, []);
    const runtime = new WorkstreamRuntime(root, registry);

    expect(workstream.branchId).not.toBe(baseBranchId);
    expect(workstream.status).toBe("ready");
    expect(workstream.usage.toolCalls).toBe(0);
    const environment = listCurrentObjects(root, workstream.branchId).find(
      (object) => object.objectId === workstream.environmentId,
    );
    expect(environment).toMatchObject({ objectType: "environment" });
    expect(environment?.content).toMatchObject({
      workstreamId: workstream.workstreamId,
      branchId: workstream.branchId,
      nodeVersion: process.version,
      platform: process.platform,
      architecture: process.arch,
      isolation: "application-policy-only",
    });
    expect(
      listCurrentObjects(root, baseBranchId).some(
        (object) =>
          object.objectId === workstream.workstreamId ||
          object.objectId === workstream.environmentId,
      ),
    ).toBe(false);

    await expect(
      runtime.executeTool({
        workstreamId: workstream.workstreamId,
        toolId: "core.echo",
        input: { value: 7 },
      }),
    ).rejects.toThrow();
    expect(runtime.get(workstream.workstreamId).usage.toolCalls).toBe(0);
    expect(
      listCurrentObjects(root, workstream.branchId).filter(
        (object) => object.objectType === "run",
      ),
    ).toHaveLength(0);
  });

  it("records exact echo input and content-addressed artifact lineage", async () => {
    const { root, goalId } = await fixture("provenance");
    const registry = createCoreToolRegistry();
    const workstream = await makeWorkstream(
      root,
      goalId,
      registry,
      ["core.echo", "core.text-artifact"],
    );
    const runtime = new WorkstreamRuntime(root, registry);

    const echo = await runtime.executeTool({
      workstreamId: workstream.workstreamId,
      toolId: "core.echo",
      input: { value: { n: 41, exact: true } },
    });
    expect(echo.output).toEqual({ value: { n: 41, exact: true } });

    const artifact = await runtime.executeTool({
      workstreamId: workstream.workstreamId,
      toolId: "core.text-artifact",
      input: { text: "41 * 41 = 1681", logicalName: "factorization.txt" },
    });
    expect(artifact.artifacts).toHaveLength(1);
    expect(artifact.artifacts[0]?.digest).toMatch(/^sha256:[0-9a-f]{64}$/);

    const runs = listCurrentObjects(root, workstream.branchId).filter(
      (object) => object.objectType === "run",
    );
    const echoRun = runs.find((run) => run.objectId === echo.runId);
    const artifactRun = runs.find((run) => run.objectId === artifact.runId);
    expect(echoRun?.content).toMatchObject({
      workstreamId: workstream.workstreamId,
      environmentId: workstream.environmentId,
      input: { value: { n: 41, exact: true } },
      status: "succeeded",
      tool: {
        toolId: "core.echo",
        determinism: "deterministic",
        requiredCapabilities: [],
      },
    });
    expect(artifactRun?.content).toMatchObject({
      status: "succeeded",
      artifacts: [
        {
          artifactId: artifact.artifacts[0]?.artifactId,
          digest: artifact.artifacts[0]?.digest,
        },
      ],
    });
    const artifactEvent = (await projectHistory(root)).find(
      (event) =>
        event.eventType === "ArtifactRegistered" &&
        (event.payload.artifact as { artifactId?: string }).artifactId ===
          artifact.artifacts[0]?.artifactId,
    );
    expect(artifactEvent?.payload.artifact).toMatchObject({
      producedByRunId: artifact.runId,
      environmentId: workstream.environmentId,
    });
    expect((await verifyProject(root)).ok).toBe(true);
  });

  it("blocks artifact output before CAS when the hard byte budget is exceeded", async () => {
    const { root, goalId } = await fixture("artifact-budget");
    const registry = createCoreToolRegistry();
    const workstream = await makeWorkstream(
      root,
      goalId,
      registry,
      ["core.text-artifact"],
      { ...generousBudget, maxArtifactBytes: 3 },
    );
    const runtime = new WorkstreamRuntime(root, registry);

    await expect(
      runtime.executeTool({
        workstreamId: workstream.workstreamId,
        toolId: "core.text-artifact",
        input: { text: "too large", logicalName: "large.txt" },
      }),
    ).rejects.toMatchObject({ code: "budget-exceeded" });

    const current = runtime.get(workstream.workstreamId);
    expect(current.status).toBe("blocked");
    expect(current.usage.toolCalls).toBe(1);
    expect(
      (await projectHistory(root)).filter(
        (event) => event.eventType === "ArtifactRegistered",
      ),
    ).toHaveLength(0);
    expect(
      listCurrentObjects(root, workstream.branchId).filter(
        (object) => object.objectType === "failure",
      ),
    ).toHaveLength(1);
  });

  it("records an actual cost overrun as a blocked durable failure", async () => {
    const { root, goalId } = await fixture("cost-budget");
    const registry = new ToolRegistry().register({
      contract: {
        schemaVersion: 1,
        toolId: "test.cost",
        name: "Cost probe",
        version: "1.0.0",
        description: "Reports provider cost after execution",
        inputSchema: { type: "object", additionalProperties: false },
        outputSchema: { type: "object", additionalProperties: false },
        requiredCapabilities: ["spend"],
        sideEffects: ["spend"],
        determinism: "nondeterministic",
        supportsCancellation: false,
        defaultTimeoutMs: 1_000,
      },
      async execute() {
        return { output: {}, costMicros: 101 };
      },
    });
    const workstream = await makeWorkstream(
      root,
      goalId,
      registry,
      ["test.cost"],
      { ...generousBudget, maxCostMicros: 100 },
    );
    const runtime = new WorkstreamRuntime(root, registry);

    await expect(
      runtime.executeTool({
        workstreamId: workstream.workstreamId,
        toolId: "test.cost",
        input: {},
      }),
    ).rejects.toMatchObject({ code: "budget-exceeded" });
    expect(runtime.get(workstream.workstreamId)).toMatchObject({
      status: "blocked",
      usage: { toolCalls: 1, costMicros: 101 },
    });
    expect(
      listCurrentObjects(root, workstream.branchId).find(
        (object) => object.objectType === "run",
      )?.content,
    ).toMatchObject({
      status: "failed",
      usage: { costMicros: 101 },
    });
  });

  it("cleans active reservations after schema failure so a resumed run can proceed", async () => {
    const { root, goalId } = await fixture("schema-cleanup");
    const registry = createCoreToolRegistry();
    const workstream = await makeWorkstream(root, goalId, registry, ["core.delay"]);
    const runtimeA = new WorkstreamRuntime(root, registry);
    const runtimeB = new WorkstreamRuntime(root, registry);

    await expect(
      runtimeA.executeTool({
        workstreamId: workstream.workstreamId,
        toolId: "core.delay",
        input: { wrong: true },
      }),
    ).rejects.toBeInstanceOf(WorkstreamRuntimeError);
    expect(runtimeB.get(workstream.workstreamId).status).toBe("blocked");

    await runtimeB.resume(workstream.workstreamId);
    const result = await runtimeB.executeTool({
      workstreamId: workstream.workstreamId,
      toolId: "core.delay",
      input: { milliseconds: 0 },
    });
    expect(result.output).toEqual({ elapsedMilliseconds: 0 });
  });

  it("turns a timeout into a durable failed run, failure object, and blocked workstream", async () => {
    const { root, goalId } = await fixture("timeout");
    const registry = new ToolRegistry().register({
      contract: {
        schemaVersion: 1,
        toolId: "test.timeout",
        name: "Timeout probe",
        version: "1.0.0",
        description: "Deliberately exceeds its runtime timeout",
        inputSchema: { type: "object", additionalProperties: false },
        outputSchema: { type: "object", additionalProperties: false },
        requiredCapabilities: [],
        sideEffects: ["none"],
        determinism: "deterministic",
        supportsCancellation: false,
        defaultTimeoutMs: 20,
      },
      async execute() {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
        return { output: {} };
      },
    });
    const workstream = await makeWorkstream(root, goalId, registry, ["test.timeout"]);
    const runtime = new WorkstreamRuntime(root, registry);

    const failure = await runtime
      .executeTool({
        workstreamId: workstream.workstreamId,
        toolId: "test.timeout",
        input: {},
      })
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "tool-timeout" });
    expect(runtime.get(workstream.workstreamId).status).toBe("blocked");

    const objects = listCurrentObjects(root, workstream.branchId);
    expect(objects.find((object) => object.objectType === "run")?.content).toMatchObject({
      status: "failed",
      error: { phase: "tool-timeout" },
    });
    expect(objects.find((object) => object.objectType === "failure")?.content).toMatchObject({
      status: "open",
      phase: "tool-timeout",
    });
  });

  it("pauses and cancels abort-aware executions without losing their run records", async () => {
    const { root, goalId } = await fixture("control");
    const registry = createCoreToolRegistry();
    const workstream = await makeWorkstream(root, goalId, registry, ["core.delay"]);
    const runtime = new WorkstreamRuntime(root, registry);

    const pausing = runtime.executeTool({
      workstreamId: workstream.workstreamId,
      toolId: "core.delay",
      input: { milliseconds: 1_000 },
    });
    await waitUntil(() => runtime.get(workstream.workstreamId).status === "running");
    await runtime.pause(workstream.workstreamId);
    await expect(pausing).rejects.toMatchObject({ code: "interrupted" });
    expect(runtime.get(workstream.workstreamId).status).toBe("paused");

    await runtime.resume(workstream.workstreamId);
    const cancelling = runtime.executeTool({
      workstreamId: workstream.workstreamId,
      toolId: "core.delay",
      input: { milliseconds: 1_000 },
    });
    await waitUntil(() => runtime.get(workstream.workstreamId).status === "running");
    await runtime.cancel(workstream.workstreamId);
    await expect(cancelling).rejects.toMatchObject({ code: "interrupted" });
    expect(runtime.get(workstream.workstreamId).status).toBe("cancelled");

    const statuses = listCurrentObjects(root, workstream.branchId)
      .filter((object) => object.objectType === "run")
      .map((run) => (run.content as { status: string }).status)
      .sort();
    expect(statuses).toEqual(["cancelled", "interrupted"]);
  });

  it("recovers durable running state as interrupted, paused, and failed", async () => {
    const { root, goalId } = await fixture("recovery");
    const registry = createCoreToolRegistry();
    const workstream = await makeWorkstream(root, goalId, registry, ["core.delay"]);
    const run = await putObject(root, {
      branchId: workstream.branchId,
      objectType: "run",
      content: {
        schemaVersion: 1,
        workstreamId: workstream.workstreamId,
        branchId: workstream.branchId,
        environmentId: workstream.environmentId,
        tool: { toolId: "core.delay" },
        input: { milliseconds: 1_000 },
        permissions: {},
        status: "running",
        reservedAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
        artifacts: [],
      },
    });
    const projected = listCurrentObjects(root, workstream.branchId).find(
      (object) => object.objectId === workstream.workstreamId,
    );
    await putObject(root, {
      branchId: workstream.branchId,
      objectId: workstream.workstreamId,
      objectType: "workstream",
      content: {
        ...(projected?.content as Record<string, unknown>),
        status: "running",
        activeRunId: run.objectId,
        usage: { ...workstream.usage, toolCalls: 1 },
        updatedAt: new Date().toISOString(),
      },
    });

    const runtime = new WorkstreamRuntime(root, registry);
    const recovered = await runtime.recoverInterruptedRuns();
    expect(recovered.recoveredWorkstreamIds).toEqual([workstream.workstreamId]);
    expect(recovered.interruptedRunIds).toEqual([run.objectId]);
    expect(recovered.failureObjectIds).toHaveLength(1);
    expect(runtime.get(workstream.workstreamId).status).toBe("paused");
    expect(
      listCurrentObjects(root, workstream.branchId).find(
        (object) => object.objectId === run.objectId,
      )?.content,
    ).toMatchObject({
      status: "interrupted",
      error: { phase: "recovery" },
    });
  });

  it("persists the machine-derived completion evaluation in the completed version", async () => {
    const { root, goalId } = await fixture("completion");
    const registry = createCoreToolRegistry();
    const workstream = await makeWorkstream(root, goalId, registry, []);
    const runtime = new WorkstreamRuntime(root, registry);

    await runtime.pause(workstream.workstreamId);
    await expect(runtime.complete(workstream.workstreamId)).rejects.toMatchObject<
      Partial<WorkstreamRuntimeError>
    >({ code: "invalid-state" });
    await runtime.resume(workstream.workstreamId);
    const completed = await runtime.complete(workstream.workstreamId);
    expect(completed.status).toBe("completed");
    expect(completed.completionEvaluation).toMatchObject({
      policyId: completionPolicy.policyId,
      branchId: workstream.branchId,
      passed: true,
      ruleResults: [
        {
          ruleId: "goal",
          passed: true,
          observedObjectIds: [goalId],
        },
      ],
    });
    const stored = listCurrentObjects(root, workstream.branchId).find(
      (object) => object.objectId === workstream.workstreamId,
    );
    expect(stored?.content).toMatchObject({
      status: "completed",
      completionEvaluation: { passed: true },
    });
  });

  it("runs three isolated workstream handlers concurrently", async () => {
    const { root, goalId } = await fixture("parallel");
    let active = 0;
    let maximumActive = 0;
    const registry = new ToolRegistry().register({
      contract: {
        schemaVersion: 1,
        toolId: "test.parallel",
        name: "Parallel probe",
        version: "1.0.0",
        description: "Measures concurrent handler execution",
        inputSchema: {
          type: "object",
          properties: { milliseconds: { type: "integer", minimum: 1 } },
          required: ["milliseconds"],
          additionalProperties: false,
        },
        outputSchema: {
          type: "object",
          properties: { ok: { type: "boolean" } },
          required: ["ok"],
          additionalProperties: false,
        },
        requiredCapabilities: [],
        sideEffects: ["none"],
        determinism: "deterministic",
        supportsCancellation: true,
        defaultTimeoutMs: 2_000,
      },
      async execute(input, context) {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        try {
          const milliseconds = (input as { milliseconds: number }).milliseconds;
          await new Promise<void>((resolveDelay, reject) => {
            const timer = setTimeout(resolveDelay, milliseconds);
            context.signal.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                reject(context.signal.reason);
              },
              { once: true },
            );
          });
          return { output: { ok: true } };
        } finally {
          active -= 1;
        }
      },
    });
    const workstreams = await Promise.all(
      ["one", "two", "three"].map((name) =>
        makeWorkstream(root, goalId, registry, ["test.parallel"], generousBudget, name),
      ),
    );
    const runtimes = workstreams.map(() => new WorkstreamRuntime(root, registry));

    const results = await Promise.all(
      workstreams.map((workstream, index) =>
        runtimes[index]!.executeTool({
          workstreamId: workstream.workstreamId,
          toolId: "test.parallel",
          input: { milliseconds: 1_000 },
        }),
      ),
    );
    expect(results).toHaveLength(3);
    expect(maximumActive).toBe(3);
    expect(new Set(workstreams.map(({ branchId }) => branchId)).size).toBe(3);
  });
});
