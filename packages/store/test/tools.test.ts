import { describe, expect, it } from "vitest";

import {
  JsonSchemaValidationError,
  ToolAuthorizationError,
  ToolExecutionAbortedError,
  ToolRegistry,
  assertJsonSchema,
  assertToolContract,
  authorizeTool,
  createCoreToolRegistry,
  validateJsonSchema,
  type ToolContract,
  type ToolDefinition,
  type ToolExecutionContext,
} from "../src/tools.js";

function executionContext(signal = new AbortController().signal): ToolExecutionContext {
  return { signal, executionId: "exe_test" };
}

function contract(overrides: Partial<ToolContract> = {}): ToolContract {
  return {
    schemaVersion: 1,
    toolId: "test.identity",
    name: "Identity",
    version: "1.0.0",
    description: "A test tool with a complete contract.",
    inputSchema: { type: "string", minLength: 1 },
    outputSchema: { type: "string", minLength: 1 },
    requiredCapabilities: [],
    sideEffects: ["none"],
    determinism: "deterministic",
    supportsCancellation: false,
    defaultTimeoutMs: 1_000,
    ...overrides,
  };
}

function definition(overrides: Partial<ToolContract> = {}): ToolDefinition {
  return {
    contract: contract(overrides),
    async execute(input) {
      return { output: input };
    },
  };
}

describe("typed tool contracts and JSON Schema validation", () => {
  it("validates the supported nested schema subset with stable JSON-pointer issues", () => {
    const schema = {
      type: "object",
      properties: {
        mode: { enum: ["fast", "exact"] },
        config: {
          type: "object",
          properties: {
            label: { type: "string", minLength: 2, maxLength: 4, pattern: "^[a-z]+$" },
            count: { type: "integer", minimum: 1, maximum: 3 },
          },
          required: ["label", "count"],
          additionalProperties: false,
        },
        samples: {
          type: "array",
          minItems: 1,
          maxItems: 2,
          items: { type: "number", exclusiveMinimum: 0 },
        },
        fixed: { const: true },
      },
      required: ["mode", "config", "samples", "fixed"],
      additionalProperties: false,
    } as const;
    assertJsonSchema(schema);

    expect(validateJsonSchema(schema, {
      mode: "exact",
      config: { label: "abc", count: 2 },
      samples: [0.5, 2],
      fixed: true,
    })).toEqual([]);

    const issues = validateJsonSchema(schema, {
      extra: true,
      mode: "approximate",
      config: { label: "A", count: 4, surprise: 1 },
      samples: [0, 1, 2],
      fixed: false,
    });
    expect(issues.map(({ path, keyword }) => [path, keyword])).toEqual([
      ["/config/count", "maximum"],
      ["/config/label", "minLength"],
      ["/config/label", "pattern"],
      ["/config/surprise", "additionalProperties"],
      ["/fixed", "const"],
      ["/mode", "enum"],
      ["/samples", "maxItems"],
      ["/samples/0", "exclusiveMinimum"],
      ["/extra", "additionalProperties"],
    ]);
  });

  it("rejects unsupported schemas and incomplete or misleading contracts", () => {
    expect(() => assertJsonSchema({ type: "string", format: "uri" })).toThrow(
      /unsupported keyword "format"/,
    );
    expect(() => assertJsonSchema({ type: "array", minItems: 2, maxItems: 1 })).toThrow(
      /minItems must be <= maxItems/,
    );
    expect(() => assertToolContract({ ...contract(), schemaVersion: 2 })).toThrow(
      /schemaVersion must be 1/,
    );
    expect(() =>
      assertToolContract({
        ...contract(),
        requiredCapabilities: [],
        sideEffects: ["filesystem.write"],
      }),
    ).toThrow(/requires capability filesystem.write/);
    expect(() =>
      assertToolContract({ ...contract(), sideEffects: ["none", "spend"] }),
    ).toThrow(/cannot combine "none"/);
    expect(() =>
      assertToolContract({ ...contract(), sideEffects: ["spend"] }),
    ).toThrow(/requires capability spend/);
    expect(() =>
      assertToolContract({
        ...contract(),
        requiredCapabilities: ["spend"],
        sideEffects: ["spend"],
      }),
    ).not.toThrow();
  });
});

describe("tool authorization and registry", () => {
  it("requires both an explicit tool allow-list entry and every declared capability", () => {
    const artifactContract = createCoreToolRegistry().get("core.text-artifact")?.contract;
    expect(artifactContract).toBeDefined();
    if (artifactContract === undefined) throw new Error("missing core.text-artifact");

    expect(() =>
      authorizeTool(artifactContract, {
        allowedToolIds: [],
        grantedCapabilities: ["project.artifact.write"],
      }),
    ).toThrowError(ToolAuthorizationError);

    try {
      authorizeTool(artifactContract, {
        allowedToolIds: [artifactContract.toolId],
        grantedCapabilities: [],
      });
      throw new Error("authorization unexpectedly succeeded");
    } catch (error) {
      expect(error).toBeInstanceOf(ToolAuthorizationError);
      expect((error as ToolAuthorizationError).missingCapabilities).toEqual([
        "project.artifact.write",
      ]);
    }

    expect(() =>
      authorizeTool(artifactContract, {
        allowedToolIds: [artifactContract.toolId],
        grantedCapabilities: ["project.artifact.write"],
      }),
    ).not.toThrow();
  });

  it("registers unique contracts, lists deterministically, and validates I/O", async () => {
    const registry = new ToolRegistry()
      .register(definition({ toolId: "test.zeta" }))
      .register(definition({ toolId: "test.alpha" }));
    expect(registry.list().map(({ contract: item }) => item.toolId)).toEqual([
      "test.alpha",
      "test.zeta",
    ]);
    expect(() => registry.register(definition({ toolId: "test.alpha" }))).toThrow(
      /already registered/,
    );
    await expect(registry.execute("test.alpha", "ok", executionContext())).resolves.toEqual({
      output: "ok",
    });
    await expect(registry.execute("test.alpha", "", executionContext())).rejects.toBeInstanceOf(
      JsonSchemaValidationError,
    );
    await expect(registry.execute("test.missing", "ok", executionContext())).rejects.toThrow(
      /Unknown tool/,
    );

    registry.register({
      contract: contract({ toolId: "test.bad-output" }),
      async execute() {
        return { output: 42 };
      },
    } as ToolDefinition);
    await expect(
      registry.execute("test.bad-output", "valid input", executionContext()),
    ).rejects.toBeInstanceOf(JsonSchemaValidationError);
  });

  it("rejects malformed result costs and artifacts at the runtime boundary", async () => {
    const registry = new ToolRegistry();
    registry.register({
      contract: contract({ toolId: "test.malformed-result" }),
      async execute() {
        return {
          output: "ok",
          costMicros: -1,
          artifacts: [{
            logicalName: "not-bytes.txt",
            mediaType: "text/plain",
            bytes: "not bytes",
            reproducibility: "deterministic",
          }],
        } as never;
      },
    });
    await expect(
      registry.execute("test.malformed-result", "ok", executionContext()),
    ).rejects.toThrow(/bytes must be Uint8Array/);
  });
});

describe("core local tools", () => {
  it("echoes arbitrary JSON and produces deterministic UTF-8 artifact bytes", async () => {
    const registry = createCoreToolRegistry();
    expect(registry.list().map(({ contract: item }) => item.toolId)).toEqual([
      "core.delay",
      "core.echo",
      "core.text-artifact",
    ]);
    const value = { nested: [1, true, null, "x"] };
    await expect(registry.execute("core.echo", value, executionContext())).resolves.toEqual({
      output: value,
    });

    const artifact = await registry.execute(
      "core.text-artifact",
      { text: "π = 3.14159\n", logicalName: "result.txt" },
      executionContext(),
    );
    expect(artifact.output).toEqual({
      logicalName: "result.txt",
      mediaType: "text/plain; charset=utf-8",
      size: 13,
    });
    expect(artifact.artifacts).toHaveLength(1);
    expect(new TextDecoder().decode(artifact.artifacts?.[0]?.bytes)).toBe("π = 3.14159\n");
    expect(artifact.artifacts?.[0]).toMatchObject({
      logicalName: "result.txt",
      mediaType: "text/plain; charset=utf-8",
      reproducibility: "deterministic",
    });
  });

  it("cancels core.delay through AbortSignal and rejects pre-aborted calls", async () => {
    const registry = createCoreToolRegistry();
    const controller = new AbortController();
    const running = registry.execute(
      "core.delay",
      { milliseconds: 5_000 },
      executionContext(controller.signal),
    );
    controller.abort("stop requested");
    await expect(running).rejects.toBeInstanceOf(ToolExecutionAbortedError);

    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    await expect(
      registry.execute("core.echo", "ignored", executionContext(alreadyAborted.signal)),
    ).rejects.toBeInstanceOf(ToolExecutionAbortedError);
  });
});
