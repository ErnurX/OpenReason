import { readFile } from "node:fs/promises";

import {
  compileContext,
  computeImpact,
  deriveStaleness,
  evaluateCompletionPolicy,
  queryGraph,
  traverseGraph,
  type CompletionPolicy,
} from "@reasoning-workbench/store";

import {
  commaSeparated,
  edgeTypesOption,
  integerOption,
  nonNegativeInteger,
  objectTypesOption,
  option,
  outputJson,
  positional,
  resolveBranchId,
  type CliIo,
  type ParsedArguments,
} from "../helpers.js";

export async function handleGraphCommand(
  parsed: ParsedArguments,
  io: CliIo,
): Promise<number | null> {
  const command = parsed.positionals[0];

  if (command === "graph" && parsed.positionals[1] === "query") {
    const projectRoot = positional(parsed, 2, "project directory");
    const objectTypes = objectTypesOption(option(parsed, "object-type"));
    const edgeTypes = edgeTypesOption(option(parsed, "edge-type"));
    outputJson(
      io,
      queryGraph(projectRoot, {
        branchId: await resolveBranchId(projectRoot, option(parsed, "branch")),
        ...(objectTypes === undefined ? {} : { objectTypes }),
        ...(edgeTypes === undefined ? {} : { edgeTypes }),
        ...(option(parsed, "context") === undefined
          ? {}
          : { contextId: option(parsed, "context")! }),
      }),
    );
    return 0;
  }

  if (command === "graph" && parsed.positionals[1] === "traverse") {
    const projectRoot = positional(parsed, 2, "project directory");
    const direction = option(parsed, "direction", true)!;
    if (!(["upstream", "downstream", "both"] as const).includes(
      direction as "upstream" | "downstream" | "both",
    )) {
      throw new Error("--direction must be upstream, downstream, or both");
    }
    const edgeTypes = edgeTypesOption(option(parsed, "edge-type"));
    const maxDepthText = option(parsed, "max-depth");
    outputJson(
      io,
      traverseGraph(projectRoot, {
        branchId: await resolveBranchId(projectRoot, option(parsed, "branch")),
        startObjectIds: commaSeparated(
          option(parsed, "start", true)!,
          "--start",
        ),
        direction: direction as "upstream" | "downstream" | "both",
        ...(edgeTypes === undefined ? {} : { edgeTypes }),
        ...(maxDepthText === undefined
          ? {}
          : { maxDepth: nonNegativeInteger(maxDepthText, "--max-depth") }),
      }),
    );
    return 0;
  }

  if (command === "impact" || command === "staleness") {
    const projectRoot = positional(parsed, 1, "project directory");
    const options = {
      branchId: await resolveBranchId(projectRoot, option(parsed, "branch")),
      changedObjectIds: commaSeparated(
        option(parsed, "changed", true)!,
        "--changed",
      ),
    };
    outputJson(
      io,
      command === "impact"
        ? computeImpact(projectRoot, options)
        : deriveStaleness(projectRoot, options),
    );
    return 0;
  }

  if (command === "policy" && parsed.positionals[1] === "evaluate") {
    const projectRoot = positional(parsed, 2, "project directory");
    const policyPath = option(parsed, "policy-file", true)!;
    const policy = JSON.parse(await readFile(policyPath, "utf8")) as CompletionPolicy;
    outputJson(
      io,
      await evaluateCompletionPolicy(projectRoot, {
        branchId: await resolveBranchId(projectRoot, option(parsed, "branch")),
        policy,
      }),
    );
    return 0;
  }

  if (command === "context" && parsed.positionals[1] === "compile") {
    const projectRoot = positional(parsed, 2, "project directory");
    const query = option(parsed, "query");
    outputJson(
      io,
      compileContext(projectRoot, {
        branchId: await resolveBranchId(projectRoot, option(parsed, "branch")),
        goalId: option(parsed, "goal", true)!,
        maxCharacters: integerOption(parsed, "max-characters", 16_384),
        maxEntries: integerOption(parsed, "max-entries", 64),
        ...(query === undefined ? {} : { query }),
      }),
    );
    return 0;
  }

  return null;
}
