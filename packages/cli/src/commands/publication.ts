import {
  buildPublicationRelease,
  checkPublicationRelease,
  inspectPublicationRelease,
  recordPublicationAttribution,
  reproducePublicationRelease,
  type ReferenceProjectId,
} from "@reasoning-workbench/store";

import { option, outputJson, positional, resolveBranchId, type CliIo, type ParsedArguments } from "../helpers.js";

function referenceId(value: string): ReferenceProjectId {
  if (!(["RP-001", "RP-002", "RP-003"] as const).includes(value as ReferenceProjectId)) {
    throw new Error("reference project must be one of RP-001, RP-002, RP-003");
  }
  return value as ReferenceProjectId;
}

export async function handlePublicationCommand(parsed: ParsedArguments, io: CliIo): Promise<number | null> {
  if (parsed.positionals[0] !== "publication") return null;
  const command = parsed.positionals[1];
  if (command === "attribute") {
    const projectRoot = positional(parsed, 2, "project directory");
    outputJson(io, await recordPublicationAttribution(projectRoot, {
      branchId: await resolveBranchId(projectRoot, option(parsed, "branch")),
      releaseLabel: option(parsed, "label", true)!,
      actor: { actorType: "human", actorId: option(parsed, "actor-id", true)! },
    }));
    return 0;
  }
  if (command === "check") {
    const projectRoot = positional(parsed, 2, "project directory");
    const report = await checkPublicationRelease(projectRoot, {
      referenceId: referenceId(option(parsed, "reference", true)!),
      branchId: await resolveBranchId(projectRoot, option(parsed, "branch")),
    });
    outputJson(io, report);
    return report.passed ? 0 : 2;
  }
  if (command === "build") {
    const projectRoot = positional(parsed, 2, "project directory");
    outputJson(io, await buildPublicationRelease(projectRoot, positional(parsed, 3, "destination directory"), {
      referenceId: referenceId(option(parsed, "reference", true)!),
      branchId: await resolveBranchId(projectRoot, option(parsed, "branch")),
    }));
    return 0;
  }
  if (command === "inspect") {
    outputJson(io, await inspectPublicationRelease(positional(parsed, 2, "release directory")));
    return 0;
  }
  if (command === "reproduce") {
    const report = await reproducePublicationRelease(positional(parsed, 2, "release directory"));
    outputJson(io, report);
    return report.canonicalIntegrity && report.manifestIntegrity ? 0 : 2;
  }
  return null;
}
