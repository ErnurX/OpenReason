import { readFile } from "node:fs/promises";

import { type JsonValue } from "@reasoning-workbench/project-format";
import {
  createWorkstream,
  getWorkstream,
  listWorkstreams,
  WorkstreamRuntime,
  type CompletionPolicy,
} from "@reasoning-workbench/store";

import {
  formatWorkstreamList,
  formatWorkstreamStatus,
} from "../formatters/human.js";
import {
  capabilitiesOption,
  cliToolRegistry,
  commaSeparated,
  integerOption,
  nonNegativeInteger,
  option,
  outputFormatted,
  outputJson,
  positional,
  readJsonValue,
  resolveBranchId,
  type CliIo,
  type ParsedArguments,
} from "../helpers.js";

export async function handleWorkstreamCommand(
  parsed: ParsedArguments,
  io: CliIo,
): Promise<number | null> {
  const command = parsed.positionals[0];
  if (command !== "workstream") return null;

  const subCommand = parsed.positionals[1];

  if (subCommand === "create") {
    const projectRoot = positional(parsed, 2, "project directory");
    const policyPath = option(parsed, "policy-file", true)!;
    const policy = JSON.parse(await readFile(policyPath, "utf8")) as CompletionPolicy;
    const allowedToolIds = commaSeparated(
      option(parsed, "allow-tool", true)!,
      "--allow-tool",
    );
    const registry = cliToolRegistry();
    for (const toolId of allowedToolIds) {
      if (registry.get(toolId) === undefined) {
        throw new Error(`Tool is not available in the CLI registry: ${toolId}`);
      }
    }
    const baseReference = option(parsed, "from");
    outputJson(
      io,
      await createWorkstream(projectRoot, {
        name: positional(parsed, 3, "workstream name"),
        goalId: option(parsed, "goal", true)!,
        allowedToolIds,
        capabilities: capabilitiesOption(option(parsed, "capability")),
        budget: {
          maxToolCalls: integerOption(parsed, "max-tool-calls", 10),
          maxWallTimeMs: integerOption(parsed, "max-wall-time-ms", 300_000),
          maxArtifactBytes: integerOption(
            parsed,
            "max-artifact-bytes",
            10 * 1024 * 1024,
          ),
          maxCostMicros: integerOption(parsed, "max-cost-micros", 0),
        },
        completionPolicy: policy,
        ...(baseReference === undefined
          ? {}
          : { baseBranchId: await resolveBranchId(projectRoot, baseReference) }),
      }),
    );
    return 0;
  }

  if (subCommand === "list") {
    const workstreams = listWorkstreams(positional(parsed, 2, "project directory"));
    outputFormatted(parsed, io, workstreams, formatWorkstreamList);
    return 0;
  }

  if (subCommand === "status") {
    const workstream = getWorkstream(
      positional(parsed, 2, "project directory"),
      positional(parsed, 3, "workstream ID"),
    );
    outputFormatted(parsed, io, workstream, formatWorkstreamStatus);
    return 0;
  }

  if (subCommand === "run") {
    const projectRoot = positional(parsed, 2, "project directory");
    const timeoutText = option(parsed, "timeout-ms");
    const input = await readJsonValue(parsed, "input", "input-file");
    outputJson(
      io,
      await new WorkstreamRuntime(projectRoot, cliToolRegistry()).executeTool({
        workstreamId: positional(parsed, 3, "workstream ID"),
        toolId: option(parsed, "tool", true)!,
        input: input as JsonValue,
        ...(timeoutText === undefined
          ? {}
          : { timeoutMs: nonNegativeInteger(timeoutText, "--timeout-ms") }),
      }),
    );
    return 0;
  }

  if (
    (["pause", "resume", "cancel", "complete"] as const).includes(
      subCommand as "pause" | "resume" | "cancel" | "complete",
    )
  ) {
    const action = subCommand as
      | "pause"
      | "resume"
      | "cancel"
      | "complete";
    const projectRoot = positional(parsed, 2, "project directory");
    const runtime = new WorkstreamRuntime(projectRoot, cliToolRegistry());
    outputJson(
      io,
      await runtime[action](positional(parsed, 3, "workstream ID")),
    );
    return 0;
  }

  if (subCommand === "recover") {
    const projectRoot = positional(parsed, 2, "project directory");
    outputJson(
      io,
      await new WorkstreamRuntime(
        projectRoot,
        cliToolRegistry(),
      ).recoverInterruptedRuns(),
    );
    return 0;
  }

  return null;
}
