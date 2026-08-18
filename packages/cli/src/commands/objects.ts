import {
  addEdge,
  putObject,
  registerArtifactFile,
} from "@reasoning-workbench/store";

import {
  asJsonObject,
  edgeType,
  objectType,
  option,
  outputJson,
  positional,
  readContent,
  resolveBranchId,
  type CliIo,
  type ParsedArguments,
} from "../helpers.js";

export async function handleObjectsCommand(
  parsed: ParsedArguments,
  io: CliIo,
): Promise<number | null> {
  const command = parsed.positionals[0];

  if (command === "object" && parsed.positionals[1] === "put") {
    const projectRoot = positional(parsed, 2, "project directory");
    const objectId = option(parsed, "object-id");
    const object = await putObject(projectRoot, {
      branchId: await resolveBranchId(projectRoot, option(parsed, "branch")),
      objectType: objectType(option(parsed, "type", true)!),
      content: await readContent(parsed),
      ...(objectId === undefined ? {} : { objectId }),
    });
    outputJson(io, object);
    return 0;
  }

  if (command === "edge" && parsed.positionals[1] === "add") {
    const projectRoot = positional(parsed, 2, "project directory");
    const metadataText = option(parsed, "metadata");
    const edge = await addEdge(projectRoot, {
      branchId: await resolveBranchId(projectRoot, option(parsed, "branch")),
      edgeType: edgeType(option(parsed, "type", true)!),
      fromObjectId: option(parsed, "from", true)!,
      toObjectId: option(parsed, "to", true)!,
      contextId: option(parsed, "context", true)!,
      ...(metadataText === undefined
        ? {}
        : { metadata: asJsonObject(metadataText, "--metadata") }),
    });
    outputJson(io, edge);
    return 0;
  }

  if (command === "artifact" && parsed.positionals[1] === "add") {
    const projectRoot = positional(parsed, 2, "project directory");
    const result = await registerArtifactFile(
      projectRoot,
      positional(parsed, 3, "artifact file"),
      {
        branchId: await resolveBranchId(projectRoot, option(parsed, "branch")),
        mediaType: option(parsed, "media-type", true)!,
        logicalName: option(parsed, "name", true)!,
        producedByRunId: option(parsed, "run-id", true)!,
        environmentId: option(parsed, "environment-id", true)!,
      },
    );
    outputJson(io, result);
    return 0;
  }

  return null;
}
