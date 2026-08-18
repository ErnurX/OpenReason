import { readFile } from "node:fs/promises";

import { type JsonValue } from "@reasoning-workbench/project-format";
import {
  createExecutionToolRegistry,
  executionJobDigest,
  LocalExecutionTarget,
  normalizeExecutionJob,
  promoteInteractiveTranscript,
  WorkstreamRuntime,
} from "@reasoning-workbench/store";

import {
  cliToolRegistry,
  nonNegativeInteger,
  option,
  outputJson,
  positional,
  type CliIo,
  type ParsedArguments,
} from "../helpers.js";

export async function handleExecutionCommand(
  parsed: ParsedArguments,
  io: CliIo,
): Promise<number | null> {
  const command = parsed.positionals[0];

  if (command === "tools" && parsed.positionals[1] === "list") {
    outputJson(
      io,
      cliToolRegistry()
        .list()
        .map((definition) => definition.contract),
    );
    return 0;
  }

  if (command !== "execution") return null;

  const subCommand = parsed.positionals[1];

  if (subCommand === "inspect") {
    const path = option(parsed, "job-file", true)!;
    const job = normalizeExecutionJob(JSON.parse(await readFile(path, "utf8")) as unknown);
    outputJson(io, { job, jobDigest: executionJobDigest(job) });
    return 0;
  }

  if (subCommand === "promote") {
    const path = option(parsed, "transcript-file", true)!;
    outputJson(
      io,
      promoteInteractiveTranscript(JSON.parse(await readFile(path, "utf8")) as unknown),
    );
    return 0;
  }

  if (subCommand === "targets") {
    outputJson(io, [new LocalExecutionTarget().descriptor]);
    return 0;
  }

  if (subCommand === "run") {
    const projectRoot = positional(parsed, 2, "project directory");
    const jobPath = option(parsed, "job-file", true)!;
    const timeoutText = option(parsed, "timeout-ms");
    const job = normalizeExecutionJob(
      JSON.parse(await readFile(jobPath, "utf8")) as unknown,
    );
    const executionRegistry = parsed.options.has("unsafe-process-only")
      ? createExecutionToolRegistry([
          new LocalExecutionTarget({ isolation: "process-only" }),
        ])
      : cliToolRegistry();
    outputJson(
      io,
      await new WorkstreamRuntime(projectRoot, executionRegistry).executeTool({
        workstreamId: positional(parsed, 3, "workstream ID"),
        toolId: "execution.local",
        input: job as unknown as JsonValue,
        ...(timeoutText === undefined
          ? {}
          : { timeoutMs: nonNegativeInteger(timeoutText, "--timeout-ms") }),
      }),
    );
    return 0;
  }

  return null;
}
