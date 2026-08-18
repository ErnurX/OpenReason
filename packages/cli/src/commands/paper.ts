import {
  analyzeWorkingPaperImpact,
  inspectWorkingPaper,
  putWorkingPaper,
  renderWorkingPaper,
} from "@reasoning-workbench/store";

import {
  commaSeparated,
  option,
  outputJson,
  positional,
  readJsonValue,
  resolveBranchId,
  type CliIo,
  type ParsedArguments,
} from "../helpers.js";

export async function handlePaperCommand(
  parsed: ParsedArguments,
  io: CliIo,
): Promise<number | null> {
  const command = parsed.positionals[0];
  if (command !== "paper") return null;

  const subCommand = parsed.positionals[1];

  if (subCommand === "put") {
    const projectRoot = positional(parsed, 2, "project directory");
    const paperId = option(parsed, "paper-id");
    outputJson(
      io,
      await putWorkingPaper(projectRoot, {
        branchId: await resolveBranchId(projectRoot, option(parsed, "branch")),
        paper: await readJsonValue(parsed, "paper", "paper-file"),
        ...(paperId === undefined ? {} : { paperId }),
      }),
    );
    return 0;
  }

  if (subCommand === "render" || subCommand === "inspect") {
    const projectRoot = positional(parsed, 2, "project directory");
    const options = {
      branchId: await resolveBranchId(projectRoot, option(parsed, "branch")),
      paperId: positional(parsed, 3, "paper ID"),
    };
    const format = option(parsed, "format");
    if (
      format !== undefined &&
      format !== "markdown" &&
      format !== "latex"
    ) {
      throw new Error("--format must be markdown or latex");
    }
    outputJson(
      io,
      subCommand === "render"
        ? renderWorkingPaper(projectRoot, {
            ...options,
            ...(format === undefined
              ? {}
              : { format: format as "markdown" | "latex" }),
          })
        : inspectWorkingPaper(projectRoot, options),
    );
    return 0;
  }

  if (subCommand === "impact") {
    const projectRoot = positional(parsed, 2, "project directory");
    outputJson(
      io,
      analyzeWorkingPaperImpact(projectRoot, {
        branchId: await resolveBranchId(projectRoot, option(parsed, "branch")),
        paperId: positional(parsed, 3, "paper ID"),
        changedObjectIds: commaSeparated(
          option(parsed, "changed", true)!,
          "--changed",
        ),
      }),
    );
    return 0;
  }

  return null;
}
