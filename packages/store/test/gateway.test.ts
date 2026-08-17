import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { computeContentHash } from "@reasoning-workbench/project-format";

import {
  AgentCoordinator,
  type AgentSessionLimits,
} from "../src/coordinator.js";
import {
  ModelGatewayRegistry,
  createConfiguredModel,
  inspectModelUsage,
} from "../src/gateway.js";
import { ModelRegistry } from "../src/model.js";
import type { CompletionPolicy } from "../src/policy.js";
import { createRp001Fixture, projectHistory, putObject } from "../src/project.js";
import { WorkstreamRuntime, createWorkstream } from "../src/runtime.js";
import { createCoreToolRegistry } from "../src/tools.js";

function config(
  adapterId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: "openai-compatible",
    adapterId,
    model: `${adapterId}-model`,
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
      strengths: { general: 60, mathematics: 60 },
      expectedLatencyMs: 200,
      privacy: "local",
    },
    ...overrides,
  };
}

describe("Stage 5 model capability routing and usage", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("builds a provider from secret-free config and binds its exact digest", () => {
    const configured = createConfiguredModel({
      ...config("openai.discovery", {
        kind: "openai-responses",
        model: "gpt-test",
        credentialRef: "env:OPENAI_API_KEY",
      }),
    });

    expect(configured.adapter.descriptor).toMatchObject({
      adapterId: "openai.discovery",
      provider: "openai",
      configuration: { credentialRef: "env:OPENAI_API_KEY" },
    });
    expect(configured.profile.adapterId).toBe("openai.discovery");
    expect(configured.configDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(JSON.stringify(configured)).not.toContain("sk-");
  });

  it("rejects embedded credentials instead of silently redacting config", () => {
    expect(() => createConfiguredModel({
      ...config("bad.secret"),
      apiKey: "sk-do-not-store",
    })).toThrow(/unsupported field apiKey|secret-like material/u);
    expect(() => createConfiguredModel({
      ...config("bad.parameter"),
      parameters: { apiKey: "sk-do-not-store" },
    })).toThrow("secret-like material");
  });

  it("routes deterministically by hard constraints, privacy, quality, cost, and latency", () => {
    const gateway = new ModelGatewayRegistry()
      .register(createConfiguredModel(config("local.extract", {
        profile: {
          ...config("x").profile as Record<string, unknown>,
          strengths: { general: 50, mathematics: 55, extraction: 95 },
          expectedLatencyMs: 100,
          privacy: "local",
        },
      })))
      .register(createConfiguredModel(config("external.math", {
        endpoint: "https://models.example.test/v1/chat/completions",
        credentialRef: "env:MODEL_KEY",
        paid: true,
        pricing: {
          inputMicrosPerMillionTokens: 1_000_000,
          outputMicrosPerMillionTokens: 2_000_000,
          currency: "USD",
        },
        profile: {
          ...config("x").profile as Record<string, unknown>,
          strengths: { general: 80, mathematics: 98 },
          expectedLatencyMs: 500,
          privacy: "external-no-training",
        },
      })));

    expect(gateway.route({
      task: "mathematics",
      estimatedInputTokens: 1_000,
      requestedOutputTokens: 500,
      requireStructuredOutput: true,
      privacy: "external-allowed",
      weights: { quality: 1, cost: 0, latency: 0 },
    }).selectedAdapterId).toBe("external.math");
    expect(gateway.route({
      task: "mathematics",
      estimatedInputTokens: 1_000,
      requestedOutputTokens: 500,
      privacy: "local-only",
    }).selectedAdapterId).toBe("local.extract");
    expect(() => gateway.route({
      task: "physics",
      estimatedInputTokens: 40_000,
      requestedOutputTokens: 5_000,
    })).toThrow("No registered model satisfies");
  });

  it("aggregates durable RP-001 model turns without provider APIs", async () => {
    const root = await mkdtemp(join(tmpdir(), "rw-gateway-usage-"));
    roots.push(root);
    const projectRoot = join(root, "project");
    const fixture = await createRp001Fixture(projectRoot);
    const branchId = fixture.project.manifest.defaultBranchId;
    const adapter = {
      schemaVersion: 1,
      adapterId: "openai.math",
      provider: "openai",
      model: "gpt-test",
      version: "1.0.0",
      configuration: {},
      requiredCapabilities: ["network.access"],
      reproducibility: "externally-sourced",
    };
    await putObject(projectRoot, {
      branchId,
      objectType: "run",
      content: {
        kind: "model-turn",
        adapter,
        status: "succeeded",
        startedAt: "2026-08-15T00:00:00.000Z",
        finishedAt: "2026-08-15T00:00:00.125Z",
        usage: { inputTokens: 100, outputTokens: 25, costMicros: 42 },
      },
    });
    await putObject(projectRoot, {
      branchId,
      objectType: "run",
      content: {
        kind: "model-turn",
        adapter,
        status: "failed",
        latencyMs: 50,
      },
    });

    expect(inspectModelUsage(projectRoot, branchId)).toEqual({
      schemaVersion: 1,
      branchId,
      totals: {
        calls: 2,
        succeeded: 1,
        failed: 1,
        interrupted: 0,
        running: 0,
        inputTokens: 100,
        outputTokens: 25,
        costMicros: 42,
        latencyMs: 175,
      },
      byAdapter: [{
        adapterId: "openai.math",
        descriptorDigest: computeContentHash(adapter as unknown as Record<string, unknown>),
        provider: "openai",
        model: "gpt-test",
        calls: 2,
        succeeded: 1,
        failed: 1,
        interrupted: 0,
        running: 0,
        inputTokens: 100,
        outputTokens: 25,
        costMicros: 42,
        latencyMs: 175,
      }],
    });
  });

  it("runs a mocked live provider through the RP-001 coordinator without persisting its key", async () => {
    const root = await mkdtemp(join(tmpdir(), "rw-gateway-e2e-"));
    roots.push(root);
    const projectRoot = join(root, "project");
    const fixture = await createRp001Fixture(projectRoot);
    const policy: CompletionPolicy = {
      schemaVersion: 1,
      policyId: "stage5-e2e",
      name: "Goal visible",
      rules: [{ ruleId: "goal", kind: "object_count", objectType: "goal", min: 1 }],
    };
    const workstream = await createWorkstream(projectRoot, {
      name: "mocked-live-openai",
      goalId: fixture.goal.objectId,
      allowedToolIds: [],
      capabilities: ["network.access", "secrets.read", "spend"],
      budget: {
        maxToolCalls: 1,
        maxWallTimeMs: 20_000,
        maxArtifactBytes: 1_000,
        maxCostMicros: 100,
      },
      completionPolicy: policy,
    });
    const secret = "sk-never-persist-this";
    let providerOutputCap = 0;
    const configured = createConfiguredModel({
      ...config("openai.e2e", {
        kind: "openai-responses",
        credentialRef: "env:OPENAI_API_KEY",
        pricing: {
          inputMicrosPerMillionTokens: 10_000,
          outputMicrosPerMillionTokens: 20_000,
          currency: "USD",
        },
        profile: {
          ...config("x").profile as Record<string, unknown>,
          privacy: "external-no-training",
        },
      }),
    }, {
      resolveCredential: () => secret,
      fetch: async (_input, init) => {
        expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${secret}`);
        providerOutputCap = Number(
          (JSON.parse(String(init?.body)) as Record<string, unknown>).max_output_tokens,
        );
        return new Response(JSON.stringify({
          id: "resp_e2e_safe",
          output_text: JSON.stringify({
            kind: "checkpoint",
            summary: "Live adapter contract reached the coordinator",
            nextSteps: ["Continue from the durable checkpoint"],
            evidenceObjectIds: [],
          }),
          usage: { input_tokens: 100, output_tokens: 20 },
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    const runtime = new WorkstreamRuntime(projectRoot, createCoreToolRegistry());
    const coordinator = new AgentCoordinator(
      projectRoot,
      runtime,
      new ModelRegistry().register(configured.adapter),
    );
    const limits: AgentSessionLimits = {
      maxTurns: 2,
      maxInputTokens: 100_000,
      maxOutputTokens: 10_000,
      maxCostMicros: 1_000,
      repeatedActionLimit: 2,
    };
    const session = await coordinator.create({
      workstreamId: workstream.workstreamId,
      adapterId: configured.adapter.descriptor.adapterId,
      limits,
      context: { maxCharacters: 10_000, maxEntries: 30 },
    });

    const step = await coordinator.step(session.sessionId);

    expect(step.outcome.kind).toBe("checkpoint");
    expect(step.response.usage).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      costMicros: 2,
    });
    expect(providerOutputCap).toBeGreaterThan(0);
    expect(providerOutputCap).toBeLessThan(limits.maxOutputTokens);
    expect(runtime.get(workstream.workstreamId)).toMatchObject({
      usage: { costMicros: 2 },
      externalCostCharges: [{ runId: step.modelTurnId, costMicros: 2 }],
    });
    await expect(runtime.chargeExternalCost({
      workstreamId: workstream.workstreamId,
      runId: step.modelTurnId,
      costMicros: 2,
    })).resolves.toMatchObject({ charged: false });
    expect(runtime.get(workstream.workstreamId).usage.costMicros).toBe(2);
    const report = inspectModelUsage(projectRoot, workstream.branchId);
    expect(report.totals).toMatchObject({ calls: 1, succeeded: 1, costMicros: 2 });
    expect(JSON.stringify(await projectHistory(projectRoot))).not.toContain(secret);
  });
});
