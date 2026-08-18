import {
  deriveVerificationProfile,
  promoteArtifactToEvidence,
  recordVerificationReview,
  VERIFICATION_DIMENSIONS,
  type VerificationDimension,
} from "@reasoning-workbench/store";

import {
  option,
  outputJson,
  positional,
  resolveBranchId,
  verificationOutcome,
  type CliIo,
  type ParsedArguments,
} from "../helpers.js";

export async function handleEvidenceCommand(
  parsed: ParsedArguments,
  io: CliIo,
): Promise<number | null> {
  const command = parsed.positionals[0];

  if (command === "evidence" && parsed.positionals[1] === "promote") {
    const projectRoot = positional(parsed, 2, "project directory");
    const dimension = option(parsed, "dimension", true)!;
    if (!(VERIFICATION_DIMENSIONS as readonly string[]).includes(dimension)) {
      throw new Error(
        `--dimension must be one of ${VERIFICATION_DIMENSIONS.join(", ")}`,
      );
    }
    const outcome = verificationOutcome(option(parsed, "outcome", true)!);
    outputJson(
      io,
      await promoteArtifactToEvidence(projectRoot, {
        branchId: await resolveBranchId(projectRoot, option(parsed, "branch")),
        claimId: option(parsed, "claim", true)!,
        contextId: option(parsed, "context", true)!,
        artifactId: option(parsed, "artifact", true)!,
        dimension: dimension as VerificationDimension,
        outcome,
        summary: option(parsed, "summary", true)!,
      }),
    );
    return 0;
  }

  if (command === "review" && parsed.positionals[1] === "record") {
    const projectRoot = positional(parsed, 2, "project directory");
    outputJson(
      io,
      await recordVerificationReview(projectRoot, {
        branchId: await resolveBranchId(projectRoot, option(parsed, "branch")),
        claimId: option(parsed, "claim", true)!,
        contextId: option(parsed, "context", true)!,
        outcome: verificationOutcome(option(parsed, "outcome", true)!),
        summary: option(parsed, "summary", true)!,
      }),
    );
    return 0;
  }

  if (command === "verification" && parsed.positionals[1] === "profile") {
    const projectRoot = positional(parsed, 2, "project directory");
    outputJson(
      io,
      deriveVerificationProfile(projectRoot, {
        branchId: await resolveBranchId(projectRoot, option(parsed, "branch")),
        claimId: positional(parsed, 3, "claim ID"),
        contextId: option(parsed, "context", true)!,
      }),
    );
    return 0;
  }

  return null;
}
