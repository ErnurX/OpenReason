import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runCli, type CliIo } from "../src/index.js";

interface CapturedIo extends CliIo {
  readonly stdoutText: () => string;
  readonly stderrText: () => string;
}

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

function captureIo(): CapturedIo {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout: (text) => stdout.push(text),
    stderr: (text) => stderr.push(text),
    stdoutText: () => stdout.join(""),
    stderrText: () => stderr.join(""),
  };
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "reasoning-workbench-cli-"));
  temporaryRoots.push(root);
  return root;
}

async function runJson(
  args: readonly string[],
): Promise<{ code: number; output: Record<string, unknown> | unknown[] }> {
  const io = captureIo();
  const code = await runCli(args, io);
  expect(io.stderrText()).toBe("");
  return {
    code,
    output: JSON.parse(io.stdoutText()) as Record<string, unknown> | unknown[],
  };
}

function record(value: unknown): Record<string, unknown> {
  expect(value).toBeTypeOf("object");
  expect(value).not.toBeNull();
  expect(Array.isArray(value)).toBe(false);
  return value as Record<string, unknown>;
}

describe("Reasoning Workbench CLI", () => {
  it("prints help without touching project state", async () => {
    const io = captureIo();

    await expect(runCli(["--help"], io)).resolves.toBe(0);

    expect(io.stdoutText()).toContain("Reasoning Workbench local reasoning runtime");
    expect(io.stdoutText()).toContain("rw fixture rp001 <project-dir>");
    expect(io.stderrText()).toBe("");
  });

  it("drives a portable project through init, editing, history, rebuild, verify, and export", async () => {
    const root = await temporaryRoot();
    const projectRoot = join(root, "project");
    const exportRoot = join(root, "exported");

    const initialized = await runJson([
      "init",
      projectRoot,
      "--title",
      "CLI integration project",
    ]);
    expect(initialized.code).toBe(0);
    expect(initialized.output).toMatchObject({ root: resolve(projectRoot) });
    const initializedManifest = record(record(initialized.output).manifest);
    expect(initializedManifest.title).toBe("CLI integration project");
    const projectId = initializedManifest.projectId;
    const defaultBranchId = initializedManifest.defaultBranchId;

    const initialInfo = await runJson(["info", projectRoot]);
    expect(initialInfo.code).toBe(0);
    expect(initialInfo.output).toMatchObject({
      manifest: {
        projectId,
        defaultBranchId,
        title: "CLI integration project",
      },
      projection: {
        eventCount: 2,
        branchCount: 1,
        objectCount: 0,
      },
      branches: [{ name: "main" }],
      objects: [],
      edges: [],
    });

    const problem = await runJson([
      "object",
      "put",
      projectRoot,
      "--type",
      "problem",
      "--content",
      JSON.stringify({ question: "Can the conjecture survive finite testing?" }),
    ]);
    expect(problem.code).toBe(0);
    expect(problem.output).toMatchObject({
      objectType: "problem",
      branchId: defaultBranchId,
      version: 1,
      content: { question: "Can the conjecture survive finite testing?" },
    });

    const branch = await runJson([
      "branch",
      "create",
      projectRoot,
      "skeptical-check",
      "--from",
      "main",
    ]);
    expect(branch.code).toBe(0);
    expect(branch.output).toMatchObject({
      name: "skeptical-check",
      parentBranchId: defaultBranchId,
    });
    const branchId = record(branch.output).branchId;

    const contentFile = join(root, "claim.json");
    await writeFile(
      contentFile,
      `${JSON.stringify({ statement: "A finite test cannot prove universality" })}\n`,
      "utf8",
    );
    const claim = await runJson([
      "object",
      "put",
      projectRoot,
      "--type",
      "claim",
      "--branch",
      "skeptical-check",
      "--content-file",
      contentFile,
    ]);
    expect(claim.code).toBe(0);
    expect(claim.output).toMatchObject({
      objectType: "claim",
      branchId,
      version: 1,
      content: { statement: "A finite test cannot prove universality" },
    });

    const history = await runJson(["history", projectRoot]);
    expect(history.code).toBe(0);
    expect(history.output).toBeInstanceOf(Array);
    expect(history.output).toHaveLength(5);
    expect(
      (history.output as Array<Record<string, unknown>>).map(
        (event) => event.eventType,
      ),
    ).toEqual([
      "ProjectInitialized",
      "BranchCreated",
      "ObjectVersionCreated",
      "BranchCreated",
      "ObjectVersionCreated",
    ]);

    const verification = await runJson(["verify", projectRoot]);
    expect(verification.code).toBe(0);
    expect(verification.output).toMatchObject({
      ok: true,
      projectionMatchesEvents: true,
      issues: [],
    });

    await rm(join(projectRoot, ".reasoning", "state.sqlite"));
    const rebuilt = await runJson(["rebuild", projectRoot]);
    expect(rebuilt.code).toBe(0);
    expect(rebuilt.output).toMatchObject({
      projectId,
      defaultBranchId,
      eventCount: 5,
      branchCount: 2,
      objectCount: 3,
    });

    const exported = await runJson(["export", projectRoot, exportRoot]);
    expect(exported.code).toBe(0);
    expect(exported.output).toMatchObject({
      manifest: { projectId, title: "CLI integration project" },
      projection: { eventCount: 5, branchCount: 2, objectCount: 3 },
    });
    expect(
      JSON.parse(
        await readFile(join(exportRoot, "reasoning-project.json"), "utf8"),
      ),
    ).toMatchObject({ projectId, title: "CLI integration project" });

    const exportedVerification = await runJson(["verify", exportRoot]);
    expect(exportedVerification.code).toBe(0);
    expect(exportedVerification.output).toMatchObject({ ok: true, issues: [] });
  });

  it("creates the RP-001 reference fixture and exposes it through ordinary commands", async () => {
    const root = await temporaryRoot();
    const projectRoot = join(root, "rp001");

    const fixture = await runJson(["fixture", "rp001", projectRoot]);
    expect(fixture.code).toBe(0);
    expect(fixture.output).toMatchObject({ root: resolve(projectRoot) });
    expect(record(fixture.output).workstreamIds).toHaveLength(4);
    expect(record(fixture.output).problemId).toMatch(/^prb_/);
    expect(record(fixture.output).contextId).toMatch(/^ctx_/);
    expect(record(fixture.output).goalId).toMatch(/^gol_/);

    const info = await runJson(["info", projectRoot]);
    expect(info.output).toMatchObject({
      manifest: { title: "RP-001 — Euler Polynomial Investigation" },
      projection: {
        branchCount: 1,
        objectCount: 7,
        edgeCount: 6,
        eventCount: 15,
      },
    });

    const verification = await runJson(["verify", projectRoot]);
    expect(verification.code).toBe(0);
    expect(verification.output).toMatchObject({ ok: true, issues: [] });
  });

  it("exposes Stage 2 graph, impact, policy, diff, and safe merge services", async () => {
    const root = await temporaryRoot();
    const projectRoot = join(root, "stage2");
    const fixture = await runJson(["fixture", "rp001", projectRoot]);
    const problemId = String(record(fixture.output).problemId);

    const query = await runJson([
      "graph",
      "query",
      projectRoot,
      "--object-type",
      "workstream",
    ]);
    expect(record(query.output).objects).toHaveLength(4);

    const traversal = await runJson([
      "graph",
      "traverse",
      projectRoot,
      "--start",
      problemId,
      "--direction",
      "downstream",
      "--max-depth",
      "1",
    ]);
    expect(record(traversal.output).visits).toHaveLength(2);

    const impact = await runJson([
      "impact",
      projectRoot,
      "--changed",
      problemId,
    ]);
    expect(record(impact.output).affected).toHaveLength(5);
    const staleness = await runJson([
      "staleness",
      projectRoot,
      "--changed",
      problemId,
    ]);
    expect(record(staleness.output).classifications).toHaveLength(6);

    const policyPath = join(root, "completion-policy.json");
    await writeFile(
      policyPath,
      JSON.stringify({
        schemaVersion: 1,
        policyId: "rp001-stage2",
        name: "RP-001 structural gate",
        rules: [
          {
            ruleId: "four-workstreams",
            kind: "object_count",
            objectType: "workstream",
            min: 4,
          },
          { ruleId: "no-failures", kind: "no_open_failures" },
        ],
      }),
      "utf8",
    );
    const policy = await runJson([
      "policy",
      "evaluate",
      projectRoot,
      "--policy-file",
      policyPath,
    ]);
    expect(policy.output).toMatchObject({ passed: true, policyId: "rp001-stage2" });

    await runJson(["branch", "create", projectRoot, "candidate", "--from", "main"]);
    const evidence = await runJson([
      "object",
      "put",
      projectRoot,
      "--branch",
      "candidate",
      "--type",
      "evidence",
      "--content",
      JSON.stringify({ method: "finite enumeration" }),
    ]);
    const diff = await runJson([
      "branch",
      "diff",
      projectRoot,
      "candidate",
      "main",
    ]);
    expect(record(diff.output).objectChanges).toEqual([
      expect.objectContaining({
        objectId: record(evidence.output).objectId,
        status: "source-only",
      }),
    ]);
    const merge = await runJson([
      "branch",
      "merge",
      projectRoot,
      "candidate",
      "main",
    ]);
    expect(merge.output).toMatchObject({
      status: "merged",
      conflictObjectIds: [],
    });
    expect(record(merge.output).appliedObjectVersionIds).toHaveLength(1);
    expect((await runJson(["verify", projectRoot])).code).toBe(0);
  });

  it("runs a gated Stage 3 workstream with typed tools and artifact provenance", async () => {
    const root = await temporaryRoot();
    const projectRoot = join(root, "stage3");
    const fixture = await runJson(["fixture", "rp001", projectRoot]);
    const goalId = String(record(fixture.output).goalId);

    const tools = await runJson(["tools", "list"]);
    expect(tools.output).toBeInstanceOf(Array);
    expect(
      (tools.output as Array<Record<string, unknown>>).map(({ toolId }) => toolId),
    ).toEqual([
      "core.delay",
      "core.echo",
      "core.text-artifact",
      "execution.local",
    ]);

    const policyPath = join(root, "workstream-policy.json");
    await writeFile(
      policyPath,
      JSON.stringify({
        schemaVersion: 1,
        policyId: "stage3-workstream",
        name: "Typed-tool completion",
        rules: [
          {
            ruleId: "workstream-exists",
            kind: "object_count",
            objectType: "workstream",
            min: 5,
          },
          {
            ruleId: "artifact-exists",
            kind: "artifact_count",
            min: 1,
            mediaTypes: ["text/plain"],
          },
          { ruleId: "no-open-failures", kind: "no_open_failures" },
        ],
      }),
      "utf8",
    );
    const created = await runJson([
      "workstream",
      "create",
      projectRoot,
      "enumeration-runtime",
      "--goal",
      goalId,
      "--policy-file",
      policyPath,
      "--allow-tool",
      "core.echo,core.text-artifact",
      "--capability",
      "project.artifact.write",
      "--max-tool-calls",
      "3",
    ]);
    const workstreamId = String(record(created.output).workstreamId);
    expect(created.output).toMatchObject({ status: "ready", goalId });

    expect(
      (await runJson(["workstream", "pause", projectRoot, workstreamId])).output,
    ).toMatchObject({ status: "paused" });
    expect(
      (await runJson(["workstream", "resume", projectRoot, workstreamId])).output,
    ).toMatchObject({ status: "ready" });

    const echo = await runJson([
      "workstream",
      "run",
      projectRoot,
      workstreamId,
      "--tool",
      "core.echo",
      "--input",
      JSON.stringify({ value: 7 }),
    ]);
    expect(echo.output).toMatchObject({
      workstreamId,
      toolId: "core.echo",
      output: { value: 7 },
      artifacts: [],
    });

    const artifact = await runJson([
      "workstream",
      "run",
      projectRoot,
      workstreamId,
      "--tool",
      "core.text-artifact",
      "--input",
      JSON.stringify({
        text: "n=40 gives 41^2",
        logicalName: "counterexample.txt",
        mediaType: "text/plain",
      }),
    ]);
    expect(record(artifact.output).artifacts).toEqual([
      expect.objectContaining({
        logicalName: "counterexample.txt",
        mediaType: "text/plain",
        size: 15,
      }),
    ]);

    const status = await runJson([
      "workstream",
      "status",
      projectRoot,
      workstreamId,
    ]);
    expect(status.output).toMatchObject({
      status: "ready",
      usage: { toolCalls: 2, artifactBytes: 15, costMicros: 0 },
    });
    expect(
      (await runJson(["workstream", "complete", projectRoot, workstreamId]))
        .output,
    ).toMatchObject({
      status: "completed",
      completionEvaluation: { passed: true },
    });
    expect(
      (await runJson(["workstream", "list", projectRoot])).output,
    ).toEqual([expect.objectContaining({ workstreamId, status: "completed" })]);
    expect(
      (await runJson(["workstream", "recover", projectRoot])).output,
    ).toEqual({
      recoveredWorkstreamIds: [],
      interruptedRunIds: [],
      failureObjectIds: [],
    });
    expect((await runJson(["verify", projectRoot])).code).toBe(0);
  });

  it("compiles RP-001 context and runs a steerable scripted Stage 4 turn", async () => {
    const root = await temporaryRoot();
    const projectRoot = join(root, "stage4");
    const fixture = await runJson(["fixture", "rp001", projectRoot]);
    const goalId = String(record(fixture.output).goalId);
    const policyPath = join(root, "agent-policy.json");
    await writeFile(
      policyPath,
      JSON.stringify({
        schemaVersion: 1,
        policyId: "stage4-goal-visible",
        name: "Goal remains visible",
        rules: [
          {
            ruleId: "goal-visible",
            kind: "object_count",
            objectType: "goal",
            min: 1,
          },
        ],
      }),
      "utf8",
    );
    const workstream = await runJson([
      "workstream",
      "create",
      projectRoot,
      "scripted-agent",
      "--goal",
      goalId,
      "--policy-file",
      policyPath,
      "--allow-tool",
      "core.echo",
    ]);
    const workstreamId = String(record(workstream.output).workstreamId);
    const branchId = String(record(workstream.output).branchId);

    const context = await runJson([
      "context",
      "compile",
      projectRoot,
      "--branch",
      branchId,
      "--goal",
      goalId,
      "--query",
      "Euler polynomial first composite",
      "--max-characters",
      "1200",
      "--max-entries",
      "5",
    ]);
    expect(context.output).toMatchObject({
      branchId,
      goalId,
      maxCharacters: 1200,
      maxEntries: 5,
    });
    expect(String(record(context.output).digest)).toMatch(/^sha256:[0-9a-f]{64}$/);

    const scriptPath = join(root, "checkpoint-script.json");
    await writeFile(
      scriptPath,
      JSON.stringify([
        {
          kind: "checkpoint",
          summary: "Preserved the n=40 counterexample",
          nextSteps: ["Generalize the factorization"],
          evidenceObjectIds: [],
        },
      ]),
      "utf8",
    );
    const created = await runJson([
      "agent",
      "create",
      projectRoot,
      workstreamId,
      "--script-file",
      scriptPath,
      "--query",
      "first composite",
      "--max-turns",
      "2",
    ]);
    const sessionId = String(record(created.output).sessionId);
    expect(created.output).toMatchObject({
      workstreamId,
      branchId,
      goalId,
      status: "active",
    });

    const steering = await runJson([
      "agent",
      "steer",
      projectRoot,
      sessionId,
      "--instruction",
      "Keep the rejected universal claim as negative context.",
    ]);
    const decisionId = String(record(steering.output).decisionId);
    const run = await runJson([
      "agent",
      "run",
      projectRoot,
      sessionId,
      "--script-file",
      scriptPath,
    ]);
    expect(record(run.output).steps).toEqual([
      expect.objectContaining({
        request: expect.objectContaining({
          contextDigest: expect.stringMatching(/^sha256:/),
          steering: [expect.objectContaining({ decisionId })],
        }),
        outcome: expect.objectContaining({ kind: "checkpoint" }),
      }),
    ]);
    expect(
      (await runJson(["agent", "status", projectRoot, sessionId])).output,
    ).toMatchObject({
      status: "active",
      usage: { turns: 1 },
      consumedSteeringMessageIds: [decisionId],
    });
    expect(
      (await runJson(["agent", "list", projectRoot])).output,
    ).toEqual([expect.objectContaining({ sessionId })]);
    expect(
      (await runJson(["agent", "recover", projectRoot])).output,
    ).toEqual({
      recoveredSessionIds: [],
      interruptedModelTurnIds: [],
      failureObjectIds: [],
    });
    expect((await runJson(["verify", projectRoot])).code).toBe(0);
  });

  it("inspects, routes, attaches, and accounts Stage 5 provider configs without storing keys", async () => {
    const root = await temporaryRoot();
    const projectRoot = join(root, "stage5");
    const fixture = await runJson(["fixture", "rp001", projectRoot]);
    const goalId = String(record(fixture.output).goalId);
    const localConfig = {
      schemaVersion: 1,
      kind: "openai-compatible",
      adapterId: "local.math",
      model: "local-test-model",
      pricing: {
        inputMicrosPerMillionTokens: 0,
        outputMicrosPerMillionTokens: 0,
        currency: "USD",
      },
      profile: {
        maxContextTokens: 32_000,
        maxOutputTokens: 4_000,
        modalities: ["text"],
        structuredOutput: true,
        toolUse: true,
        strengths: { general: 60, mathematics: 70 },
        expectedLatencyMs: 100,
        privacy: "local",
      },
    };
    const externalConfig = {
      ...localConfig,
      adapterId: "external.math",
      model: "external-test-model",
      endpoint: "https://models.example.test/v1/chat/completions",
      credentialRef: "env:MODEL_API_KEY",
      paid: true,
      pricing: {
        inputMicrosPerMillionTokens: 1_000_000,
        outputMicrosPerMillionTokens: 2_000_000,
        currency: "USD",
      },
      profile: {
        ...localConfig.profile,
        strengths: { general: 80, mathematics: 99 },
        expectedLatencyMs: 300,
        privacy: "external-no-training",
      },
    };
    const localConfigPath = join(root, "local-model.json");
    const registryPath = join(root, "model-registry.json");
    await writeFile(localConfigPath, JSON.stringify(localConfig), "utf8");
    await writeFile(registryPath, JSON.stringify([localConfig, externalConfig]), "utf8");

    const inspected = await runJson([
      "models",
      "inspect",
      "--model-config-file",
      localConfigPath,
    ]);
    expect(inspected.output).toMatchObject({
      descriptor: {
        adapterId: "local.math",
        provider: "openai-compatible",
        configuration: {
          protocol: "openai-chat-completions-v1",
          endpoint: "http://127.0.0.1:11434/v1/chat/completions",
        },
      },
      profile: { adapterId: "local.math", privacy: "local" },
    });
    expect(JSON.stringify(inspected.output)).not.toContain("MODEL_API_KEY");

    expect((await runJson([
      "models",
      "route",
      "--registry-file",
      registryPath,
      "--task",
      "mathematics",
      "--input-tokens",
      "1000",
      "--output-tokens",
      "500",
      "--privacy",
      "local-only",
    ])).output).toMatchObject({ selectedAdapterId: "local.math" });

    const policyPath = join(root, "stage5-policy.json");
    await writeFile(policyPath, JSON.stringify({
      schemaVersion: 1,
      policyId: "stage5-provider",
      name: "Goal visible",
      rules: [{ ruleId: "goal", kind: "object_count", objectType: "goal", min: 1 }],
    }), "utf8");
    const workstream = await runJson([
      "workstream",
      "create",
      projectRoot,
      "live-model-ready",
      "--goal",
      goalId,
      "--policy-file",
      policyPath,
      "--allow-tool",
      "core.echo",
      "--capability",
      "network.access",
    ]);
    const workstreamId = String(record(workstream.output).workstreamId);
    const branchId = String(record(workstream.output).branchId);
    const session = await runJson([
      "agent",
      "create",
      projectRoot,
      workstreamId,
      "--model-config-file",
      localConfigPath,
    ]);
    expect(session.output).toMatchObject({
      workstreamId,
      branchId,
      adapter: { adapterId: "local.math" },
      status: "active",
    });

    await runJson([
      "object",
      "put",
      projectRoot,
      "--branch",
      branchId,
      "--type",
      "run",
      "--content",
      JSON.stringify({
        kind: "model-turn",
        adapter: record(inspected.output).descriptor,
        status: "succeeded",
        latencyMs: 12,
        usage: { inputTokens: 20, outputTokens: 5, costMicros: 0 },
      }),
    ]);
    expect((await runJson([
      "models",
      "usage",
      projectRoot,
      "--branch",
      branchId,
    ])).output).toMatchObject({
      totals: {
        calls: 1,
        succeeded: 1,
        inputTokens: 20,
        outputTokens: 5,
        costMicros: 0,
        latencyMs: 12,
      },
      byAdapter: [{ adapterId: "local.math", calls: 1 }],
    });
    expect((await runJson(["verify", projectRoot])).code).toBe(0);
  });

  it("inspects, promotes, and executes a Stage 6 immutable Python job", async () => {
    const root = await temporaryRoot();
    const projectRoot = join(root, "stage6");
    const fixture = await runJson(["fixture", "rp001", projectRoot]);
    const goalId = String(record(fixture.output).goalId);
    const policyPath = join(root, "stage6-policy.json");
    await writeFile(policyPath, JSON.stringify({
      schemaVersion: 1,
      policyId: "stage6-execution",
      name: "Goal remains visible",
      rules: [{ ruleId: "goal", kind: "object_count", objectType: "goal", min: 1 }],
    }), "utf8");
    const workstream = await runJson([
      "workstream",
      "create",
      projectRoot,
      "python-computation",
      "--goal",
      goalId,
      "--policy-file",
      policyPath,
      "--allow-tool",
      "execution.local",
      "--capability",
      "project.read,project.artifact.write,filesystem.read,filesystem.write,process.execute,compute.local",
      "--max-tool-calls",
      "3",
      "--max-wall-time-ms",
      "10000",
      "--max-artifact-bytes",
      "1048576",
    ]);
    const workstreamId = String(record(workstream.output).workstreamId);
    const jobPath = join(root, "job.json");
    const job = {
      schemaVersion: 1,
      program: { kind: "python", entrypoint: "main.py", arguments: [] },
      files: [{
        path: "main.py",
        mediaType: "text/x-python",
        content: "from pathlib import Path\nprint(42)\nPath('answer.txt').write_text('42')\n",
      }],
      inputs: [],
      outputs: [{
        path: "answer.txt",
        logicalName: "answer.txt",
        mediaType: "text/plain",
        required: true,
      }],
      environment: {},
      resources: {
        wallTimeMs: 2000,
        cpuTimeMs: 1000,
        memoryBytes: 268435456,
        maxLogBytes: 65536,
        maxOutputBytes: 1048576,
        maxProcesses: 1,
      },
      network: "deny",
      reproducibility: "deterministic",
      parameters: {},
    };
    await writeFile(jobPath, JSON.stringify(job), "utf8");

    const inspection = await runJson([
      "execution",
      "inspect",
      "--job-file",
      jobPath,
    ]);
    expect(inspection.output).toMatchObject({
      job: { program: { kind: "python", entrypoint: "main.py" } },
      jobDigest: expect.stringMatching(/^sha256:/),
    });
    expect((await runJson(["execution", "targets"])).output).toEqual([
      expect.objectContaining({ targetId: "local", kind: "local" }),
    ]);

    const transcriptPath = join(root, "transcript.json");
    await writeFile(transcriptPath, JSON.stringify({
      schemaVersion: 1,
      sessionId: "interactive-1",
      cells: [{ cellId: "compute", source: "print(6 * 7)" }],
    }), "utf8");
    expect((await runJson([
      "execution",
      "promote",
      "--transcript-file",
      transcriptPath,
    ])).output).toMatchObject({
      job: { source: { sessionId: "interactive-1" } },
      sourceDigest: expect.stringMatching(/^sha256:/),
    });

    const execution = await runJson([
      "execution",
      "run",
      projectRoot,
      workstreamId,
      "--job-file",
      jobPath,
      "--unsafe-process-only",
    ]);
    expect(execution.output).toMatchObject({
      workstreamId,
      toolId: "execution.local",
      output: { status: "succeeded", cached: false },
      artifacts: [
        expect.objectContaining({ logicalName: "stdout.log" }),
        expect.objectContaining({ logicalName: "stderr.log" }),
        expect.objectContaining({ logicalName: "answer.txt" }),
      ],
    });
    expect((await runJson(["verify", projectRoot])).code).toBe(0);
  });

  it("throws command and argument errors to an embedding caller", async () => {
    const root = await temporaryRoot();

    await expect(
      runCli(["init", join(root, "missing-title")], captureIo()),
    ).rejects.toThrow("Missing required option --title");
    await expect(runCli(["not-a-command"], captureIo())).rejects.toThrow(
      "Unknown command",
    );
  });

  it("formats human-readable output when --human is passed", async () => {
    const root = await temporaryRoot();
    const projectRoot = join(root, "rp001");

    const fixture = await runJson(["fixture", "rp001", projectRoot]);
    const contextId = (fixture.output as Record<string, unknown>).contextId as string;

    // Test info --human
    const infoIo = captureIo();
    expect(await runCli(["info", projectRoot, "--human"], infoIo)).toBe(0);
    expect(infoIo.stdoutText()).toContain("Project:");
    expect(infoIo.stdoutText()).toContain("Project ID:");
    expect(infoIo.stdoutText()).toContain("Branches");

    // Test history --human
    const historyIo = captureIo();
    expect(await runCli(["history", projectRoot, "--human"], historyIo)).toBe(0);
    expect(historyIo.stdoutText()).toContain("Project History");

    // Test graph query --human
    const graphIo = captureIo();
    expect(await runCli(["graph", "query", projectRoot, "--human"], graphIo)).toBe(0);
    expect(graphIo.stdoutText()).toContain("Graph Query:");
    expect(graphIo.stdoutText()).toContain("Objects:");

    // Test tools list --human
    const toolsIo = captureIo();
    expect(await runCli(["tools", "list", "--human"], toolsIo)).toBe(0);
    expect(toolsIo.stdoutText()).toContain("Available Execution Tools");

    // Test staleness --human
    const stalenessIo = captureIo();
    expect(
      await runCli(
        ["staleness", projectRoot, "--changed", contextId, "--human"],
        stalenessIo,
      ),
    ).toBe(0);
    expect(stalenessIo.stdoutText()).toContain("Staleness Report:");

    // Test cleanup --human
    const cleanupIo = captureIo();
    expect(
      await runCli(["cleanup", projectRoot, "--dry-run", "--human"], cleanupIo),
    ).toBe(0);
    expect(cleanupIo.stdoutText()).toContain("Project Cleanup Report (dry run)");
    expect(cleanupIo.stdoutText()).toContain("Total Files Cleaned:    0");
  });
});

