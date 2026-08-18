import {
  compareResearchBranches,
  createBranch,
  diffBranches,
  mergeBranchSafe,
} from "@reasoning-workbench/store";

import {
  option,
  outputJson,
  positional,
  resolveBranchId,
  type CliIo,
  type ParsedArguments,
} from "../helpers.js";

export async function handleBranchCommand(
  parsed: ParsedArguments,
  io: CliIo,
): Promise<number | null> {
  const command = parsed.positionals[0];
  if (command !== "branch") return null;

  const subCommand = parsed.positionals[1];

  if (subCommand === "create") {
    const projectRoot = positional(parsed, 2, "project directory");
    const baseReference = option(parsed, "from");
    const branch = await createBranch(projectRoot, {
      name: positional(parsed, 3, "branch name"),
      ...(baseReference === undefined
        ? {}
        : { baseBranchId: await resolveBranchId(projectRoot, baseReference) }),
    });
    outputJson(io, branch);
    return 0;
  }

  if (subCommand === "diff") {
    const projectRoot = positional(parsed, 2, "project directory");
    const sourceBranchId = await resolveBranchId(
      projectRoot,
      positional(parsed, 3, "source branch"),
    );
    const targetBranchId = await resolveBranchId(
      projectRoot,
      positional(parsed, 4, "target branch"),
    );
    outputJson(
      io,
      await diffBranches(projectRoot, sourceBranchId, targetBranchId),
    );
    return 0;
  }

  if (subCommand === "semantic-diff") {
    const projectRoot = positional(parsed, 2, "project directory");
    const sourceBranchId = await resolveBranchId(
      projectRoot,
      positional(parsed, 3, "source branch"),
    );
    const targetBranchId = await resolveBranchId(
      projectRoot,
      positional(parsed, 4, "target branch"),
    );
    outputJson(
      io,
      await compareResearchBranches(projectRoot, sourceBranchId, targetBranchId),
    );
    return 0;
  }

  if (subCommand === "merge") {
    const projectRoot = positional(parsed, 2, "project directory");
    const sourceBranchId = await resolveBranchId(
      projectRoot,
      positional(parsed, 3, "source branch"),
    );
    const targetBranchId = await resolveBranchId(
      projectRoot,
      positional(parsed, 4, "target branch"),
    );
    outputJson(
      io,
      await mergeBranchSafe(projectRoot, { sourceBranchId, targetBranchId }),
    );
    return 0;
  }

  return null;
}
