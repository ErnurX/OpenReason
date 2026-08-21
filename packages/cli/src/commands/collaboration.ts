import {
  ActorSchema,
  type Actor,
} from "@reasoning-workbench/project-format";
import {
  addCollaborationComment,
  authorizeBranchMerge,
  bootstrapProjectOwner,
  grantProjectMembership,
  mergeAcceptedBranch,
  readCollaborationState,
  recordReviewDecision,
  requestReview,
} from "@reasoning-workbench/store";

import {
  option,
  outputJson,
  positional,
  resolveBranchId,
  type CliIo,
  type ParsedArguments,
} from "../helpers.js";

function humanActor(actorId: string): Actor {
  return ActorSchema.parse({ actorType: "human", actorId });
}

function evidenceReferences(value: string): Array<{ objectId: string; versionId: string }> {
  const references = value.split(",").filter(Boolean).map((item) => {
    const separator = item.indexOf("@");
    if (separator <= 0 || separator === item.length - 1) {
      throw new Error("--evidence must be comma-separated object-id@version-id references");
    }
    return { objectId: item.slice(0, separator), versionId: item.slice(separator + 1) };
  });
  if (references.length === 0) throw new Error("--evidence requires at least one reference");
  return references;
}

export async function handleCollaborationCommand(
  parsed: ParsedArguments,
  io: CliIo,
): Promise<number | null> {
  if (parsed.positionals[0] !== "collab") return null;
  const subcommand = parsed.positionals[1];

  if (subcommand === "bootstrap") {
    const root = positional(parsed, 2, "project directory");
    outputJson(io, await bootstrapProjectOwner(root, humanActor(option(parsed, "actor", true)!)));
    return 0;
  }
  if (subcommand === "members") {
    const root = positional(parsed, 2, "project directory");
    outputJson(io, (await readCollaborationState(root, humanActor(option(parsed, "actor", true)!))).memberships);
    return 0;
  }
  if (subcommand === "member" && parsed.positionals[2] === "add") {
    const root = positional(parsed, 3, "project directory");
    outputJson(io, await grantProjectMembership(root, {
      actor: humanActor(option(parsed, "actor", true)!),
      member: humanActor(option(parsed, "member", true)!),
      role: option(parsed, "role", true)! as "owner" | "researcher" | "contributor" | "reviewer" | "compute-operator" | "viewer",
      reason: option(parsed, "reason", true)!,
    }));
    return 0;
  }
  if (subcommand === "comment") {
    const root = positional(parsed, 2, "project directory");
    outputJson(io, await addCollaborationComment(root, {
      actor: humanActor(option(parsed, "actor", true)!),
      branchId: await resolveBranchId(root, option(parsed, "branch")),
      objectId: option(parsed, "object", true)!,
      versionId: option(parsed, "version", true)!,
      body: option(parsed, "body", true)!,
    }));
    return 0;
  }
  if (subcommand === "comments") {
    const root = positional(parsed, 2, "project directory");
    outputJson(io, (await readCollaborationState(root, humanActor(option(parsed, "actor", true)!))).comments);
    return 0;
  }
  if (subcommand === "request-review") {
    const root = positional(parsed, 2, "project directory");
    outputJson(io, await requestReview(root, {
      actor: humanActor(option(parsed, "actor", true)!),
      branchId: await resolveBranchId(root, option(parsed, "branch")),
      statementObjectId: option(parsed, "statement", true)!,
      statementVersionId: option(parsed, "statement-version", true)!,
      evidence: evidenceReferences(option(parsed, "evidence", true)!),
      summary: option(parsed, "summary", true)!,
    }));
    return 0;
  }
  if (subcommand === "reviews") {
    const root = positional(parsed, 2, "project directory");
    outputJson(io, (await readCollaborationState(root, humanActor(option(parsed, "actor", true)!))).reviews);
    return 0;
  }
  if (subcommand === "decisions") {
    const root = positional(parsed, 2, "project directory");
    const state = await readCollaborationState(root, humanActor(option(parsed, "actor", true)!));
    outputJson(io, state.reviews.flatMap((review) => review.decisions));
    return 0;
  }
  if (subcommand === "replay") {
    const root = positional(parsed, 2, "project directory");
    outputJson(io, await readCollaborationState(root, humanActor(option(parsed, "actor", true)!)));
    return 0;
  }
  if (subcommand === "decide-review") {
    const root = positional(parsed, 2, "project directory");
    const outcome = option(parsed, "outcome", true)!;
    if (outcome !== "approved" && outcome !== "rejected") throw new Error("--outcome must be approved or rejected");
    outputJson(io, await recordReviewDecision(root, {
      actor: humanActor(option(parsed, "actor", true)!),
      reviewRequestId: option(parsed, "review", true)!,
      outcome,
      rationale: option(parsed, "rationale", true)!,
    }));
    return 0;
  }
  if (subcommand === "authorize-merge") {
    const root = positional(parsed, 2, "project directory");
    outputJson(io, await authorizeBranchMerge(root, {
      actor: humanActor(option(parsed, "actor", true)!),
      subject: humanActor(option(parsed, "subject", true)!),
      sourceBranchId: await resolveBranchId(root, option(parsed, "source", true)),
      targetBranchId: await resolveBranchId(root, option(parsed, "target", true)),
      reason: option(parsed, "reason", true)!,
    }));
    return 0;
  }
  if (subcommand === "merge") {
    const root = positional(parsed, 2, "project directory");
    outputJson(io, await mergeAcceptedBranch(root, {
      actor: humanActor(option(parsed, "actor", true)!),
      authorizationId: option(parsed, "authorization", true)!,
      sourceBranchId: await resolveBranchId(root, option(parsed, "source", true)),
      targetBranchId: await resolveBranchId(root, option(parsed, "target", true)),
    }));
    return 0;
  }
  return null;
}
