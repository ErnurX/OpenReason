import { readFile } from "node:fs/promises";

import type { JsonValue } from "@reasoning-workbench/project-format";

import {
  analyzeReviewLoop,
  createCoreVerifierRegistry,
  createIndependentReviewPacket,
  enforceReviewLoopGuard,
  recordFormalAlignment,
  recordIndependentReview,
  recoverInterruptedVerifications,
  runVerification,
  type FormalAlignmentOptions,
  type RecordIndependentReviewOptions,
} from "@reasoning-workbench/store";

import {
  formatReviewLoop,
  formatVerificationRun,
  formatVerifierList,
} from "../formatters/human.js";
import {
  asJsonObject,
  option,
  outputFormatted,
  positional,
  readJsonValue,
  resolveBranchId,
  type CliIo,
  type ParsedArguments,
} from "../helpers.js";

function csv(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const entries = value.split(",").map((entry) => entry.trim()).filter(Boolean);
  if (entries.length === 0) throw new Error("Comma-separated option cannot be empty");
  return entries;
}

export async function handleVerificationCommand(
  parsed: ParsedArguments,
  io: CliIo,
): Promise<number | null> {
  if (parsed.positionals[0] !== "verification") return null;
  const action = parsed.positionals[1];
  const registry = createCoreVerifierRegistry();

  if (action === "list") {
    const contracts = registry.list().map((definition) => definition.contract);
    outputFormatted(parsed, io, contracts, formatVerifierList);
    return 0;
  }

  const projectRoot = positional(parsed, 2, "project directory");
  const branchId = await resolveBranchId(projectRoot, option(parsed, "branch"));

  if (action === "run") {
    const artifactIds = csv(option(parsed, "artifact"));
    const assumptionIds = csv(option(parsed, "assumption"));
    const result = await runVerification(projectRoot, registry, {
      branchId,
      claimId: option(parsed, "claim", true)!,
      contextId: option(parsed, "context", true)!,
      verifierId: option(parsed, "verifier", true)!,
      input: await readJsonValue(parsed, "input", "input-file") as JsonValue,
      ...(artifactIds === undefined ? {} : { artifactIds }),
      ...(assumptionIds === undefined ? {} : { assumptionIds }),
    });
    outputFormatted(parsed, io, result, formatVerificationRun);
    return 0;
  }

  if (action === "packet") {
    const evidenceObjectIds = csv(option(parsed, "evidence"));
    const sourceObjectIds = csv(option(parsed, "source"));
    const packet = createIndependentReviewPacket(projectRoot, {
      branchId,
      claimId: option(parsed, "claim", true)!,
      contextId: option(parsed, "context", true)!,
      ...(option(parsed, "problem") === undefined
        ? {}
        : { problemId: option(parsed, "problem")! }),
      ...(evidenceObjectIds === undefined ? {} : { evidenceObjectIds }),
      ...(sourceObjectIds === undefined ? {} : { sourceObjectIds }),
    });
    outputFormatted(parsed, io, packet);
    return 0;
  }

  if (action === "review") {
    const path = option(parsed, "review-file", true)!;
    const value = asJsonObject(await readFile(path, "utf8"), path);
    const recorded = await recordIndependentReview(projectRoot, {
      ...value,
      branchId,
    } as unknown as RecordIndependentReviewOptions);
    outputFormatted(parsed, io, recorded, formatVerificationRun);
    return 0;
  }

  if (action === "loop") {
    const options = {
      branchId,
      claimId: option(parsed, "claim", true)!,
      contextId: option(parsed, "context", true)!,
    };
    const result = parsed.options.has("enforce")
      ? await enforceReviewLoopGuard(projectRoot, options)
      : analyzeReviewLoop(projectRoot, options);
    outputFormatted(parsed, io, result, formatReviewLoop);
    return 0;
  }

  if (action === "align") {
    const path = option(parsed, "alignment-file", true)!;
    const value = asJsonObject(await readFile(path, "utf8"), path);
    const alignment = await recordFormalAlignment(projectRoot, {
      ...value,
      branchId,
    } as unknown as FormalAlignmentOptions);
    outputFormatted(parsed, io, alignment, formatVerificationRun);
    return 0;
  }

  if (action === "recover") {
    outputFormatted(
      parsed,
      io,
      await recoverInterruptedVerifications(projectRoot, { branchId }),
    );
    return 0;
  }

  return null;
}
