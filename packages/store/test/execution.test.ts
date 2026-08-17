import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AgentCoordinator } from "../src/coordinator.js";
import {
  LocalExecutionTarget,
  SshExecutionTarget,
  createExecutionToolRegistry,
  executionJobDigest,
  normalizeExecutionJob,
  promoteInteractiveTranscript,
  type ExecutionJobSpec,
  type SshExecutionRequest,
  type SshTransport,
} from "../src/execution.js";
import { ModelRegistry, ScriptedModelAdapter } from "../src/model.js";
import type { CompletionPolicy } from "../src/policy.js";
import { createRp001Fixture, projectHistory, verifyProject } from "../src/project.js";
import { listCurrentObjects } from "../src/projection.js";
import { WorkstreamRuntime, createWorkstream } from "../src/runtime.js";
import type { ToolExecutionContext } from "../src/tools.js";

const completionPolicy: CompletionPolicy = {
  schemaVersion: 1,
  policyId: "goal-visible",
  name: "Goal remains visible",
  rules: [{ ruleId: "goal", kind: "object_count", objectType: "goal", min: 1 }],
};

function pythonJob(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    program: { kind: "python", entrypoint: "main.py", arguments: [] },
    files: [
      {
        path: "main.py",
        mediaType: "text/x-python; charset=utf-8",
        content: [
          "from pathlib import Path",
          "print('computed 6 * 7')",
          "Path('result.svg').write_text('<svg xmlns=\"http://www.w3.org/2000/svg\"><text>42</text></svg>')",
        ].join("\n"),
      },
    ],
    inputs: [],
    outputs: [
      {
        path: "result.svg",
        logicalName: "result.svg",
        mediaType: "image/svg+xml",
        required: true,
      },
    ],
    environment: { EXPERIMENT: "euler" },
    resources: {
      wallTimeMs: 5_000,
      cpuTimeMs: 2_000,
      memoryBytes: 256 * 1024 * 1024,
      maxLogBytes: 64 * 1024,
      maxOutputBytes: 1024 * 1024,
      maxProcesses: 1,
    },
    network: "deny",
    reproducibility: "deterministic",
    parameters: { n: 42 },
    ...overrides,
  };
}

describe("Stage 6 execution plane", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("normalizes immutable jobs and rejects traversal, undeclared entrypoints, and secrets", () => {
    const left = normalizeExecutionJob(pythonJob());
    const right = normalizeExecutionJob({
      ...pythonJob(),
      environment: { EXPERIMENT: "euler" },
      parameters: { n: 42 },
    });
    expect(left).toEqual(right);
    expect(executionJobDigest(left)).toBe(executionJobDigest(right));
    expect(() => normalizeExecutionJob({
      ...pythonJob(),
      files: [{ path: "../escape.py", content: "pass" }],
    })).toThrow("project-relative POSIX path");
    expect(() => normalizeExecutionJob({
      ...pythonJob(),
      environment: { API_KEY: "do-not-persist" },
    })).toThrow("secret-like variable");
    expect(() => normalizeExecutionJob({
      ...pythonJob(),
      parameters: { access_token: "do-not-persist" },
    })).toThrow("secret-like key");
    expect(() => normalizeExecutionJob({
      ...pythonJob(),
      reproducibility: "seeded",
    })).toThrow("require job.seed");
  });

  it("promotes an interactive transcript into an exact replayable Python job", () => {
    const promoted = promoteInteractiveTranscript({
      schemaVersion: 1,
      sessionId: "kernel-1",
      cells: [
        { cellId: "derive", source: "answer = 6 * 7" },
        { cellId: "observe", source: "print(answer)" },
      ],
      reproducibility: "seeded",
      seed: 7,
    });
    expect(promoted.job).toMatchObject({
      program: { kind: "python", entrypoint: "main.py" },
      reproducibility: "seeded",
      seed: 7,
      source: { kind: "interactive-transcript", sessionId: "kernel-1" },
    });
    expect(promoted.job.files[0]?.content).toContain("# %% [2] observe");
    expect(promoted.jobDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(promoted.sourceDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("executes an RP-001 Python job, captures lineage, and reuses deterministic CAS output", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "rw-execution-rp001-"));
    roots.push(sandbox);
    const projectRoot = join(sandbox, "project");
    const fixture = await createRp001Fixture(projectRoot);
    const registry = createExecutionToolRegistry([
      new LocalExecutionTarget({ isolation: "process-only" }),
    ]);
    const definition = registry.get("execution.local")!;
    const workstream = await createWorkstream(projectRoot, {
      name: "compute-euler-value",
      goalId: fixture.goal.objectId,
      allowedToolIds: [definition.contract.toolId],
      capabilities: [...definition.contract.requiredCapabilities],
      budget: {
        maxToolCalls: 6,
        maxWallTimeMs: 20_000,
        maxArtifactBytes: 2 * 1024 * 1024,
        maxCostMicros: 0,
      },
      completionPolicy,
    });
    const runtime = new WorkstreamRuntime(projectRoot, registry);

    await expect(runtime.executeTool({
      workstreamId: workstream.workstreamId,
      toolId: "execution.local",
      input: pythonJob({
        parameters: { api_key: "sk-supersecret123" },
      }) as never,
    })).rejects.toThrow("secret-like key");
    expect(runtime.get(workstream.workstreamId).usage.toolCalls).toBe(0);
    expect(JSON.stringify(await projectHistory(projectRoot))).not.toContain(
      "sk-supersecret123",
    );

    const first = await runtime.executeTool({
      workstreamId: workstream.workstreamId,
      toolId: "execution.local",
      input: pythonJob() as never,
    });
    expect(first.output).toMatchObject({
      kind: "execution-result",
      status: "succeeded",
      cached: false,
      targetId: "local",
    });
    expect(first.environmentId).not.toBe(workstream.environmentId);
    expect(first.artifacts.map((artifact) => artifact.logicalName)).toEqual([
      "stdout.log",
      "stderr.log",
      "result.svg",
    ]);

    const second = await runtime.executeTool({
      workstreamId: workstream.workstreamId,
      toolId: "execution.local",
      input: pythonJob() as never,
    });
    expect(second.output).toMatchObject({
      kind: "execution-result",
      status: "succeeded",
      cached: true,
      sourceRunId: first.runId,
      durationMs: 0,
    });
    expect(second.artifacts.map((artifact) => artifact.digest)).toEqual(
      first.artifacts.map((artifact) => artifact.digest),
    );
    const sourceArtifact = first.artifacts.find(
      (artifact) => artifact.logicalName === "result.svg",
    )!;
    const derivedJob = pythonJob({
      files: [{
        path: "main.py",
        content: "from pathlib import Path\nPath('copy.svg').write_bytes(Path('input.svg').read_bytes())",
      }],
      inputs: [{
        digest: sourceArtifact.digest,
        path: "input.svg",
        logicalName: "result.svg",
        mediaType: "image/svg+xml",
      }],
      outputs: [{
        path: "copy.svg",
        logicalName: "copy.svg",
        mediaType: "image/svg+xml",
        required: true,
      }],
    });
    const derived = await runtime.executeTool({
      workstreamId: workstream.workstreamId,
      toolId: "execution.local",
      input: derivedJob as never,
    });
    expect(derived.output).toMatchObject({ status: "succeeded", cached: false });
    const sibling = await createWorkstream(projectRoot, {
      name: "sibling-cannot-read-private-artifact",
      goalId: fixture.goal.objectId,
      allowedToolIds: [definition.contract.toolId],
      capabilities: [...definition.contract.requiredCapabilities],
      budget: {
        maxToolCalls: 1,
        maxWallTimeMs: 5_000,
        maxArtifactBytes: 1024 * 1024,
        maxCostMicros: 0,
      },
      completionPolicy,
    });
    await expect(runtime.executeTool({
      workstreamId: sibling.workstreamId,
      toolId: "execution.local",
      input: derivedJob as never,
    })).rejects.toMatchObject({ code: "tool-failed" });
    expect(runtime.get(sibling.workstreamId).status).toBe("blocked");
    const nondeterministicJob = pythonJob({
      reproducibility: "nondeterministic",
      parameters: { n: 42, sampling: "fresh" },
    });
    const nondeterministicFirst = await runtime.executeTool({
      workstreamId: workstream.workstreamId,
      toolId: "execution.local",
      input: nondeterministicJob as never,
    });
    const nondeterministicSecond = await runtime.executeTool({
      workstreamId: workstream.workstreamId,
      toolId: "execution.local",
      input: nondeterministicJob as never,
    });
    expect(nondeterministicFirst.output).toMatchObject({ cached: false });
    expect(nondeterministicSecond.output).toMatchObject({ cached: false });

    const environment = listCurrentObjects(projectRoot, workstream.branchId).find(
      (object) => object.objectId === first.environmentId,
    );
    expect(environment?.content).toMatchObject({
      kind: "tool-execution-environment",
      runId: first.runId,
      descriptor: {
        kind: "execution-environment",
        jobDigest: executionJobDigest(pythonJob()),
        isolationEnforced: false,
      },
    });
    const artifactEvents = (await projectHistory(projectRoot)).filter(
      (event) => event.eventType === "ArtifactRegistered",
    );
    expect(artifactEvents).toHaveLength(15);
    expect(artifactEvents[0]?.payload.artifact).toMatchObject({
      producedByRunId: first.runId,
      environmentId: first.environmentId,
      reproducibility: "deterministic",
      inputs: [],
    });
    expect(
      artifactEvents.find(
        (event) =>
          (event.payload.artifact as { producedByRunId?: string }).producedByRunId ===
          derived.runId,
      )?.payload.artifact,
    ).toMatchObject({ producedByRunId: derived.runId, inputs: [sourceArtifact.digest] });
    expect((await verifyProject(projectRoot)).ok).toBe(true);
  }, 30_000);

  it("normalizes one remote target through the same tool protocol", async () => {
    let observed: SshExecutionRequest | undefined;
    const transport: SshTransport = {
      execute: async (request) => {
        observed = request;
        return {
          schemaVersion: 1,
          jobDigest: request.jobDigest,
          status: "succeeded",
          exitCode: 0,
          signal: null,
          durationMs: 12,
          diagnostics: [],
          artifacts: [
            {
              logicalName: "stdout.log",
              mediaType: "text/plain",
              contentBase64: Buffer.from("42\n").toString("base64"),
              role: "stdout",
            },
            {
              logicalName: "stderr.log",
              mediaType: "text/plain",
              contentBase64: "",
              role: "stderr",
            },
            {
              logicalName: "result.svg",
              mediaType: "image/svg+xml",
              contentBase64: Buffer.from("<svg/>").toString("base64"),
              role: "output",
              path: "result.svg",
            },
          ],
          environment: { worker: "remote-test", imageDigest: "sha256:worker" },
        };
      },
    };
    const registry = createExecutionToolRegistry([
      new SshExecutionTarget({ targetId: "cluster", transport }),
    ]);
    const controller = new AbortController();
    const result = await registry.execute(
      "execution.cluster",
      pythonJob() as never,
      { signal: controller.signal } satisfies ToolExecutionContext,
    );
    expect(observed?.jobDigest).toBe(executionJobDigest(pythonJob()));
    expect(observed?.inputArtifacts).toEqual([]);
    expect(result.output).toMatchObject({
      targetId: "cluster",
      status: "succeeded",
      cached: false,
    });
    expect(result.artifacts?.[0]?.bytes).toEqual(Buffer.from("42\n"));
    expect(result.environment).toMatchObject({
      remote: { worker: "remote-test" },
      jobDigest: executionJobDigest(pythonJob()),
    });
  });

  it("returns timeout and negative execution evidence without losing logs", async () => {
    if (process.platform === "darwin") {
      await expect(
        new LocalExecutionTarget({
          sandboxExecutable: join(tmpdir(), "definitely-missing-sandbox-exec"),
        }).execute(normalizeExecutionJob(pythonJob()), {
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow("Required sandbox executable is unavailable");
    }
    const target = new LocalExecutionTarget({ isolation: "process-only" });
    const controller = new AbortController();
    const result = await target.execute(
      normalizeExecutionJob(pythonJob({
        files: [{ path: "main.py", content: "import time\nprint('before timeout', flush=True)\ntime.sleep(2)" }],
        outputs: [],
        resources: {
          wallTimeMs: 400,
          cpuTimeMs: 2_000,
          memoryBytes: 256 * 1024 * 1024,
          maxLogBytes: 64 * 1024,
          maxOutputBytes: 1024 * 1024,
          maxProcesses: 1,
        },
      })) as ExecutionJobSpec,
      { signal: controller.signal },
    );
    expect(result.status).toBe("timed-out");
    expect(Buffer.from(result.artifacts[0]!.bytes).toString("utf8")).toContain("before timeout");
  });

  it("lets an agent observe a failed computation and submit a corrected figure run", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "rw-execution-agent-"));
    roots.push(sandbox);
    const projectRoot = join(sandbox, "project");
    const fixture = await createRp001Fixture(projectRoot);
    const registry = createExecutionToolRegistry([
      new LocalExecutionTarget({ isolation: "process-only" }),
    ]);
    const definition = registry.get("execution.local")!;
    const workstream = await createWorkstream(projectRoot, {
      name: "debug-computation",
      goalId: fixture.goal.objectId,
      allowedToolIds: ["execution.local"],
      capabilities: [...definition.contract.requiredCapabilities],
      budget: {
        maxToolCalls: 4,
        maxWallTimeMs: 20_000,
        maxArtifactBytes: 2 * 1024 * 1024,
        maxCostMicros: 0,
      },
      completionPolicy,
    });
    const failedJob = pythonJob({
      files: [{
        path: "main.py",
        content: "raise RuntimeError('incorrect symbolic substitution')",
      }],
      outputs: [],
    });
    const correctedJob = pythonJob();
    const adapter = new ScriptedModelAdapter({
      script: [
        { kind: "tool-call", toolId: "execution.local", input: failedJob as never },
        { kind: "tool-call", toolId: "execution.local", input: correctedJob as never },
      ],
    });
    const coordinator = new AgentCoordinator(
      projectRoot,
      new WorkstreamRuntime(projectRoot, registry),
      new ModelRegistry().register(adapter),
    );
    const session = await coordinator.create({
      workstreamId: workstream.workstreamId,
      adapterId: adapter.descriptor.adapterId,
      limits: {
        maxTurns: 3,
        maxInputTokens: 100_000,
        maxOutputTokens: 10_000,
        maxCostMicros: 0,
        repeatedActionLimit: 3,
      },
      context: { maxCharacters: 20_000, maxEntries: 50 },
    });

    const failed = await coordinator.step(session.sessionId);
    expect(failed.outcome).toMatchObject({
      kind: "tool-run",
      execution: { output: { status: "failed" } },
    });
    const corrected = await coordinator.step(session.sessionId);
    expect(corrected.outcome).toMatchObject({
      kind: "tool-run",
      execution: {
        output: { status: "succeeded" },
        artifacts: expect.arrayContaining([
          expect.objectContaining({ logicalName: "result.svg", mediaType: "image/svg+xml" }),
        ]),
      },
    });
    expect(coordinator.get(session.sessionId).usage.turns).toBe(2);
  });
});
