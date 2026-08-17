import { describe, expect, it } from "vitest";

import { assertModelAdapterDescriptor, type ModelRequest } from "../src/model.js";
import {
  AnthropicMessagesAdapter,
  ModelProviderError,
  OpenAICompatibleAdapter,
  OpenAIResponsesAdapter,
  calculateModelCost,
  providerOutputTokenLimit,
  type FetchLike,
  type TokenPricing,
} from "../src/providers.js";

const pricing: TokenPricing = {
  inputMicrosPerMillionTokens: 2_000_000,
  outputMicrosPerMillionTokens: 3_000_000,
  currency: "USD",
};
const modelLimits = { maxContextTokens: 32_000, maxOutputTokens: 4_000 } as const;

function request(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    schemaVersion: 1,
    sessionId: "ses_test",
    turn: 1,
    workstreamId: "wst_test",
    branchId: "br_test",
    goalId: "gol_test",
    promptText: "[gol_test@golver_1 goal] Prove or refute the conjecture.",
    contextDigest: `sha256:${"0".repeat(64)}`,
    contextEntries: [],
    estimatedInputTokens: 10,
    limits: {
      remainingInputTokens: 100,
      remainingOutputTokens: 100,
      remainingCostMicros: 100,
    },
    steering: [],
    ...overrides,
  };
}

function json(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    ...init,
  });
}

describe("Stage 5 live model provider adapters", () => {
  it("calls OpenAI Responses with bounded structured output and measured cost", async () => {
    let captured: { url: string; headers: Headers; body: Record<string, unknown> } | undefined;
    const fetcher: FetchLike = async (input, init) => {
      captured = {
        url: String(input),
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      };
      return json({
        id: "resp_safe_1",
        output_text: JSON.stringify({
          kind: "checkpoint",
          summary: "Checked n=40",
          nextSteps: ["Factor the value"],
          evidenceObjectIds: [],
        }),
        usage: { input_tokens: 5, output_tokens: 7 },
      });
    };
    const adapter = new OpenAIResponsesAdapter({
      ...modelLimits,
      adapterId: "openai.math",
      model: "gpt-test",
      credentialRef: "env:OPENAI_API_KEY",
      pricing,
      fetch: fetcher,
      resolveCredential: () => "sk-super-secret",
    });

    const result = await adapter.invoke(request(), { signal: new AbortController().signal });

    expect(captured?.url).toBe("https://api.openai.com/v1/responses");
    expect(captured?.headers.get("authorization")).toBe("Bearer sk-super-secret");
    expect(captured?.body).toMatchObject({
      model: "gpt-test",
      max_output_tokens: 26,
      store: false,
      text: { format: { type: "json_schema", strict: false } },
    });
    expect(result).toMatchObject({
      providerRequestId: "resp_safe_1",
      action: { kind: "checkpoint", summary: "Checked n=40" },
      usage: { inputTokens: 5, outputTokens: 7, costMicros: 31 },
    });
    expect(JSON.stringify(adapter.descriptor)).not.toContain("sk-super-secret");
    expect(adapter.descriptor.configuration).toMatchObject({
      credentialRef: "env:OPENAI_API_KEY",
      protocol: "openai-responses-v1",
    });
  });

  it("uses Anthropic's forced tool contract and validates the returned action", async () => {
    let body: Record<string, unknown> | undefined;
    let headers: Headers | undefined;
    const fetcher: FetchLike = async (_input, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      headers = new Headers(init?.headers);
      return json({
        id: "msg_safe_1",
        content: [{
          type: "tool_use",
          id: "toolu_1",
          name: "submit_reasoning_action",
          input: {
            kind: "request-completion",
            rationale: "All executable checks can now run",
          },
        }],
        usage: { input_tokens: 11, output_tokens: 4 },
      });
    };
    const adapter = new AnthropicMessagesAdapter({
      ...modelLimits,
      adapterId: "anthropic.review",
      model: "claude-test",
      credentialRef: "env:ANTHROPIC_API_KEY",
      pricing,
      fetch: fetcher,
      resolveCredential: () => "anthropic-secret",
    });

    const result = await adapter.invoke(request(), { signal: new AbortController().signal });

    expect(headers?.get("x-api-key")).toBe("anthropic-secret");
    expect(headers?.get("anthropic-version")).toBe("2023-06-01");
    expect(body).toMatchObject({
      model: "claude-test",
      max_tokens: 26,
      tool_choice: { type: "tool", name: "submit_reasoning_action" },
    });
    expect(result.action).toEqual({
      kind: "request-completion",
      rationale: "All executable checks can now run",
    });
    expect(result.usage).toEqual({ inputTokens: 11, outputTokens: 4, costMicros: 34 });
  });

  it("supports credential-free loopback OpenAI-compatible servers", async () => {
    let capturedHeaders: Headers | undefined;
    let capturedBody: Record<string, unknown> | undefined;
    const fetcher: FetchLike = async (_input, init) => {
      capturedHeaders = new Headers(init?.headers);
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return json({
        id: "chatcmpl_local_1",
        choices: [{ message: { content: JSON.stringify({
          kind: "propose-object",
          objectType: "claim",
          content: { statement: "n=40 is a counterexample" },
          contextId: null,
        }) } }],
        usage: { prompt_tokens: 20, completion_tokens: 8 },
      });
    };
    const adapter = new OpenAICompatibleAdapter({
      ...modelLimits,
      adapterId: "local.extract",
      model: "local-model",
      pricing: {
        inputMicrosPerMillionTokens: 0,
        outputMicrosPerMillionTokens: 0,
        currency: "USD",
      },
      fetch: fetcher,
      maxTokensField: "max_completion_tokens",
    });

    const result = await adapter.invoke(request({
      limits: {
        remainingInputTokens: 100,
        remainingOutputTokens: 12,
        remainingCostMicros: 0,
      },
    }), { signal: new AbortController().signal });

    expect(capturedHeaders?.has("authorization")).toBe(false);
    expect(capturedBody).toMatchObject({
      model: "local-model",
      max_completion_tokens: 12,
      response_format: { type: "json_schema" },
    });
    expect(result.action).toEqual({
      kind: "propose-object",
      objectType: "claim",
      content: { statement: "n=40 is a counterexample" },
    });
    expect(adapter.descriptor.requiredCapabilities).toEqual(["network.access"]);
  });

  it("refuses unaffordable calls before resolving credentials or touching fetch", async () => {
    let credentialCalls = 0;
    let fetchCalls = 0;
    const adapter = new OpenAIResponsesAdapter({
      ...modelLimits,
      adapterId: "openai.budget",
      model: "gpt-test",
      credentialRef: "env:OPENAI_API_KEY",
      pricing,
      resolveCredential: () => {
        credentialCalls += 1;
        return "secret";
      },
      fetch: async () => {
        fetchCalls += 1;
        return json({});
      },
    });

    await expect(adapter.invoke(request({
      limits: {
        remainingInputTokens: 100,
        remainingOutputTokens: 100,
        remainingCostMicros: 1,
      },
    }), { signal: new AbortController().signal })).rejects.toMatchObject({
      code: "budget-exhausted",
    });
    expect(credentialCalls).toBe(0);
    expect(fetchCalls).toBe(0);
  });

  it("never includes an HTTP error body in the durable-facing error", async () => {
    const adapter = new OpenAIResponsesAdapter({
      ...modelLimits,
      adapterId: "openai.error",
      model: "gpt-test",
      credentialRef: "env:OPENAI_API_KEY",
      pricing,
      resolveCredential: () => "secret",
      fetch: async () => new Response(
        JSON.stringify({ error: "api_key=leaked-value" }),
        { status: 401, headers: { "x-request-id": "req_safe" } },
      ),
    });

    const error = await adapter.invoke(request(), {
      signal: new AbortController().signal,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ModelProviderError);
    expect(error).toMatchObject({ code: "http-error", status: 401, providerRequestId: "req_safe" });
    expect(String(error)).not.toContain("leaked-value");
  });

  it("uses integer micro-cost arithmetic and an exact output cap", () => {
    expect(calculateModelCost(1, 1, {
      inputMicrosPerMillionTokens: 1,
      outputMicrosPerMillionTokens: 1,
      currency: "USD",
    })).toBe(1);
    expect(providerOutputTokenLimit(request(), pricing, true)).toBe(26);
    expect(() => new OpenAIResponsesAdapter({
      ...modelLimits,
      adapterId: "bad.ref",
      model: "gpt-test",
      credentialRef: "sk-literal-secret",
      pricing,
    })).toThrow("credentialRef must be an opaque scheme reference");
    expect(() => new OpenAIResponsesAdapter({
      ...modelLimits,
      adapterId: "bad.hidden-tools",
      model: "gpt-test",
      credentialRef: "env:OPENAI_API_KEY",
      pricing,
      parameters: { tools: [{ type: "web_search" }] },
    })).toThrow("provider parameters cannot override \"tools\"");
    expect(() => assertModelAdapterDescriptor({
      schemaVersion: 1,
      adapterId: "third-party.bad-secret",
      provider: "third-party",
      model: "test",
      version: "1",
      configuration: { credentialRef: "literal-secret-value" },
      requiredCapabilities: ["secrets.read"],
      reproducibility: "externally-sourced",
    })).toThrow("opaque credential reference");
  });
});
