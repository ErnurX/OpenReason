import {
  cleanupProject,
  createProject,
  createRp001Fixture,
  exportProject,
  inspectProject,
  projectHistory,
  rebuildProjection,
  verifyProject,
} from "@reasoning-workbench/store";

import {
  formatCleanupReport,
  formatProjectHistory,
  formatProjectInfo,
} from "../formatters/human.js";
import {
  option,
  outputFormatted,
  outputJson,
  positional,
  type CliIo,
  type ParsedArguments,
} from "../helpers.js";

export async function handleProjectCommand(
  parsed: ParsedArguments,
  io: CliIo,
): Promise<number | null> {
  const command = parsed.positionals[0];

  if (command === "init") {
    const projectRoot = positional(parsed, 1, "project directory");
    const created = await createProject(projectRoot, {
      title: option(parsed, "title", true)!,
    });
    outputJson(io, created);
    return 0;
  }

  if (command === "info") {
    outputFormatted(
      parsed,
      io,
      await inspectProject(positional(parsed, 1, "project directory")),
      formatProjectInfo,
    );
    return 0;
  }

  if (command === "history") {
    outputFormatted(
      parsed,
      io,
      await projectHistory(positional(parsed, 1, "project directory")),
      formatProjectHistory,
    );
    return 0;
  }

  if (command === "verify") {
    const report = await verifyProject(positional(parsed, 1, "project directory"));
    outputJson(io, report);
    return report.ok ? 0 : 2;
  }

  if (command === "rebuild") {
    outputJson(io, await rebuildProjection(positional(parsed, 1, "project directory")));
    return 0;
  }

  if (command === "cleanup") {
    const projectRoot = positional(parsed, 1, "project directory");
    const dryRun = parsed.options.has("dry-run");
    const removeOrphanSegments = parsed.options.has("remove-orphans");
    const report = await cleanupProject(projectRoot, {
      dryRun,
      removeOrphanSegments,
    });
    outputFormatted(parsed, io, report, formatCleanupReport);
    return 0;
  }

  if (command === "export") {
    outputJson(
      io,
      await exportProject(
        positional(parsed, 1, "project directory"),
        positional(parsed, 2, "destination directory"),
      ),
    );
    return 0;
  }

  if (command === "fixture" && parsed.positionals[1] === "rp001") {
    const fixture = await createRp001Fixture(
      positional(parsed, 2, "project directory"),
    );
    outputJson(io, {
      root: fixture.project.root,
      projectId: fixture.project.manifest.projectId,
      defaultBranchId: fixture.project.manifest.defaultBranchId,
      problemId: fixture.problem.objectId,
      contextId: fixture.context.objectId,
      goalId: fixture.goal.objectId,
      workstreamIds: fixture.workstreams.map((item) => item.objectId),
    });
    return 0;
  }

  return null;
}
