import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createId, type Actor, type JsonValue } from "@reasoning-workbench/project-format";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CollaborationAuthorizationError,
  CollaborationConcurrencyError,
  StaleReviewError,
  activeMembershipFor,
  addCollaborationEdge,
  addCollaborationComment,
  auditListConsumedMergeAuthorizations,
  auditListProjectMemberships,
  auditListReviewDecisions,
  auditReviewRequestStates,
  authorizeBranchMerge,
  bootstrapProjectOwner,
  createCollaborationBranch,
  createDomainReferenceFixture,
  createProject,
  grantProjectMembership,
  isReviewRequestStale,
  mergeAcceptedBranch,
  permissionsForRole,
  projectHead,
  projectHistory,
  putObject,
  putCollaborationObject,
  readCollaborationState,
  recordReviewDecision,
  rebuildProjection,
  revokeProjectMembership,
  requestReview,
  inspectProject,
  listCurrentObjects,
  verifyProject,
} from "../src/index.js";

function human(): Actor {
  return { actorType: "human", actorId: createId("usr") };
}

function agent(): Actor {
  return { actorType: "agent", actorId: createId("agt") };
}

describe("Stage 11 collaboration", () => {
  let sandbox: string;
  let projectRoot: string;

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), "rw-collaboration-"));
    projectRoot = join(sandbox, "project");
    await createProject(projectRoot, { title: "RP-001 collaborative review" });
  });

  afterEach(async () => {
    await rm(sandbox, { recursive: true, force: true });
  });

  it("uses append-only human memberships and a deny-by-default role matrix", async () => {
    const owner = human();
    const contributor = human();
    const initialHead = await projectHead(projectRoot);
    const initial = await bootstrapProjectOwner(projectRoot, owner, { expectedHead: initialHead });
    const membership = await grantProjectMembership(projectRoot, {
      actor: owner,
      member: contributor,
      role: "contributor",
      reason: "finite-case exploration",
    });

    expect((await auditListProjectMemberships(projectRoot)).map((item) => item.role).sort()).toEqual([
      "contributor",
      "owner",
    ]);
    expect(await activeMembershipFor(projectRoot, contributor)).toMatchObject({ membershipId: membership.membershipId });
    expect(permissionsForRole("contributor")).not.toContain("branch:merge");
    expect(permissionsForRole("viewer")).toEqual(["project:view"]);
    const ownerPermissions = permissionsForRole("owner");
    expect(ownerPermissions).not.toContain("branch:merge");
    expect(Object.isFrozen(ownerPermissions)).toBe(true);
    expect(() => (ownerPermissions as unknown as string[]).push("branch:merge")).toThrow();
    expect(initial.grantEventId).toMatch(/^evt_/);

    const beforeDenied = (await projectHistory(projectRoot)).length;
    await expect(grantProjectMembership(projectRoot, {
      actor: contributor,
      member: human(),
      role: "viewer",
      reason: "must fail",
    })).rejects.toBeInstanceOf(CollaborationAuthorizationError);
    await expect(bootstrapProjectOwner(projectRoot, agent())).rejects.toBeInstanceOf(CollaborationAuthorizationError);
    await expect(authorizeBranchMerge(projectRoot, {
      actor: owner,
      subject: contributor,
      sourceBranchId: "br_01J00000000000000000000000",
      targetBranchId: "br_01J00000000000000000000001",
      reason: "contributors must never receive merge authority",
    })).rejects.toBeInstanceOf(CollaborationAuthorizationError);
    expect((await projectHistory(projectRoot)).length).toBe(beforeDenied);
  });

  it("forbids every collaboration writer, including the owner, from writing default state", async () => {
    const owner = human();
    await bootstrapProjectOwner(projectRoot, owner);
    const main = (await inspectProject(projectRoot)).manifest.defaultBranchId;
    const before = (await projectHistory(projectRoot)).length;

    await expect(putCollaborationObject(projectRoot, {
      actor: owner,
      branchId: main,
      objectType: "claim",
      content: { statement: "must be proposed on a work branch" },
    })).rejects.toBeInstanceOf(CollaborationAuthorizationError);
    await expect(addCollaborationEdge(projectRoot, {
      actor: owner,
      branchId: main,
      edgeType: "supports",
      fromObjectId: createId("evd"),
      toObjectId: createId("clm"),
    })).rejects.toBeInstanceOf(CollaborationAuthorizationError);
    expect((await projectHistory(projectRoot)).length).toBe(before);
  });

  it("does not revoke the final active owner and offers authorized transport reads", async () => {
    const owner = human();
    const viewer = human();
    const ownerMembership = await bootstrapProjectOwner(projectRoot, owner);
    await grantProjectMembership(projectRoot, { actor: owner, member: viewer, role: "viewer", reason: "read-only collaborator" });
    const before = (await projectHistory(projectRoot)).length;
    await expect(revokeProjectMembership(projectRoot, {
      actor: owner,
      membershipId: ownerMembership.membershipId,
      reason: "must preserve a project owner",
    })).rejects.toBeInstanceOf(CollaborationAuthorizationError);
    expect((await projectHistory(projectRoot)).length).toBe(before);

    const state = await readCollaborationState(projectRoot, viewer);
    expect(state.membership).toMatchObject({ role: "viewer", actor: viewer });
    await expect(readCollaborationState(projectRoot, agent())).rejects.toBeInstanceOf(CollaborationAuthorizationError);
  });

  it("anchors comments and reviews to exact RP-001 object versions and stales review after revision", async () => {
    const rp001Root = join(sandbox, "rp001-reference");
    const fixture = await createDomainReferenceFixture(rp001Root, "RP-001");
    const owner = human();
    const researcher = human();
    const reviewer = human();
    await bootstrapProjectOwner(rp001Root, owner);
    await grantProjectMembership(rp001Root, { actor: owner, member: researcher, role: "researcher", reason: "investigate" });
    await grantProjectMembership(rp001Root, { actor: owner, member: reviewer, role: "reviewer", reason: "independent review" });
    const main = fixture.domain.project.manifest.defaultBranchId;
    const branch = await createCollaborationBranch(rp001Root, {
      actor: researcher,
      name: "rp001-finite-check",
      baseBranchId: main,
    });
    const claim = fixture.claims.find(
      (candidate) => (candidate.content as Record<string, unknown>).reference === "RP-001-C01",
    )!;
    const evidence = listCurrentObjects(rp001Root, main).find(
      (candidate) => candidate.objectType === "evidence",
    )!;
    const comment = await addCollaborationComment(rp001Root, {
      actor: reviewer,
      branchId: branch.branchId,
      objectId: claim.objectId,
      versionId: claim.versionId,
      body: "Please check the n = 2 calculation.",
    });
    expect(comment.anchor).toMatchObject({ objectId: claim.objectId, versionId: claim.versionId, contentHash: claim.contentHash });

    const request = await requestReview(rp001Root, {
      actor: researcher,
      branchId: branch.branchId,
      statementObjectId: claim.objectId,
      statementVersionId: claim.versionId,
      evidence: [{ objectId: evidence.objectId, versionId: evidence.versionId }],
      summary: "Review the finite counterexample.",
    });
    const revised = await putCollaborationObject(rp001Root, {
      actor: researcher,
      branchId: branch.branchId,
      objectId: claim.objectId,
      objectType: "claim",
      content: {
        ...(claim.content as Record<string, JsonValue>),
        statement: "For every integer n with 0 <= n <= 39, p(n) is prime.",
      },
    });
    expect(await isReviewRequestStale(rp001Root, request)).toBe(true);
    const beforeStaleDecision = (await projectHistory(rp001Root)).length;
    await expect(recordReviewDecision(rp001Root, {
      actor: reviewer,
      reviewRequestId: request.reviewRequestId,
      outcome: "approved",
      rationale: "must not be recorded",
    })).rejects.toBeInstanceOf(StaleReviewError);
    expect((await projectHistory(rp001Root)).length).toBe(beforeStaleDecision);

    const fresh = await requestReview(rp001Root, {
      actor: researcher,
      branchId: branch.branchId,
      statementObjectId: revised.objectId,
      statementVersionId: revised.versionId,
      evidence: [{ objectId: evidence.objectId, versionId: evidence.versionId }],
      summary: "Review the corrected RP-001 statement.",
    });
    const decision = await recordReviewDecision(rp001Root, {
      actor: reviewer,
      reviewRequestId: fresh.reviewRequestId,
      outcome: "approved",
      rationale: "The exact counterexample supports the limited statement.",
    });
    expect(decision).toMatchObject({ outcome: "approved", reviewer });
    expect(await auditListReviewDecisions(rp001Root)).toEqual([
      expect.objectContaining({ reviewRequestId: fresh.reviewRequestId, reviewer, outcome: "approved" }),
    ]);
    const replayed = await auditReviewRequestStates(rp001Root);
    expect(replayed.find((state) => state.request.reviewRequestId === request.reviewRequestId)).toMatchObject({
      current: false,
      stale: true,
      decisions: [],
    });
    expect(replayed.find((state) => state.request.reviewRequestId === fresh.reviewRequestId)).toMatchObject({
      current: true,
      stale: false,
      decisions: [expect.objectContaining({ reviewDecisionId: decision.reviewDecisionId })],
    });
    expect((await readCollaborationState(rp001Root, reviewer)).reviews).toEqual(replayed);
    expect((await verifyProject(rp001Root)).ok).toBe(true);
  });

  it("rebuilds a crash-window projection before rejecting a stale review decision", async () => {
    const owner = human();
    const researcher = human();
    const reviewer = human();
    await bootstrapProjectOwner(projectRoot, owner);
    await grantProjectMembership(projectRoot, { actor: owner, member: researcher, role: "researcher", reason: "investigate" });
    await grantProjectMembership(projectRoot, { actor: owner, member: reviewer, role: "reviewer", reason: "independent review" });
    const main = (await inspectProject(projectRoot)).manifest.defaultBranchId;
    const branch = await createCollaborationBranch(projectRoot, { actor: researcher, name: "crash-window-review", baseBranchId: main });
    const claim = await putCollaborationObject(projectRoot, {
      actor: researcher,
      branchId: branch.branchId,
      objectType: "claim",
      content: { statement: "The first proof statement." },
    });
    const evidence = await putCollaborationObject(projectRoot, {
      actor: researcher,
      branchId: branch.branchId,
      objectType: "evidence",
      content: { method: "independent computation" },
    });
    const request = await requestReview(projectRoot, {
      actor: researcher,
      branchId: branch.branchId,
      statementObjectId: claim.objectId,
      statementVersionId: claim.versionId,
      evidence: [{ objectId: evidence.objectId, versionId: evidence.versionId }],
      summary: "Review the original exact statement.",
    });

    const projectionPath = join(projectRoot, ".reasoning", "state.sqlite");
    const staleProjectionPath = join(sandbox, "review-before-canonical-revision.sqlite");
    await cp(projectionPath, staleProjectionPath);
    await putObject(projectRoot, {
      actor: researcher,
      branchId: branch.branchId,
      objectId: claim.objectId,
      objectType: "claim",
      content: { statement: "The revised proof statement." },
    });
    await cp(staleProjectionPath, projectionPath, { force: true });

    const before = (await projectHistory(projectRoot)).length;
    await expect(recordReviewDecision(projectRoot, {
      actor: reviewer,
      reviewRequestId: request.reviewRequestId,
      outcome: "approved",
      rationale: "A stale cache must not approve the original version.",
    })).rejects.toBeInstanceOf(StaleReviewError);
    expect((await projectHistory(projectRoot)).length).toBe(before);
  });

  it("requires owner-issued, branch-head-bound merge authority and preserves merge provenance", async () => {
    const owner = human();
    const researcher = human();
    await bootstrapProjectOwner(projectRoot, owner);
    await grantProjectMembership(projectRoot, { actor: owner, member: researcher, role: "researcher", reason: "parallel proof" });
    const main = (await inspectProject(projectRoot)).manifest.defaultBranchId;
    const branch = await createCollaborationBranch(projectRoot, { actor: researcher, name: "proof", baseBranchId: main });
    await putCollaborationObject(projectRoot, {
      actor: researcher,
      branchId: branch.branchId,
      objectType: "claim",
      content: { statement: "RP-001 finite counterexample refutes the universal claim" },
    });
    await expect(mergeAcceptedBranch(projectRoot, {
      actor: researcher,
      authorizationId: createId("maz"),
      sourceBranchId: branch.branchId,
      targetBranchId: main,
    })).rejects.toBeInstanceOf(CollaborationAuthorizationError);

    const authorization = await authorizeBranchMerge(projectRoot, {
      actor: owner,
      subject: researcher,
      sourceBranchId: branch.branchId,
      targetBranchId: main,
      reason: "owner accepts reviewed branch merge",
    });
    const merged = await mergeAcceptedBranch(projectRoot, {
      actor: researcher,
      authorizationId: authorization.authorizationId,
      sourceBranchId: branch.branchId,
      targetBranchId: main,
    });
    expect(merged.status).toBe("merged");
    expect(merged.event.payload).toMatchObject({
      "x-rw:collaboration": { authorizationId: authorization.authorizationId },
    });
    expect((await verifyProject(projectRoot)).ok).toBe(true);
  });

  it("rechecks active membership and rejects a revoked merge actor without consuming authority", async () => {
    const owner = human();
    const researcher = human();
    await bootstrapProjectOwner(projectRoot, owner);
    const researcherMembership = await grantProjectMembership(projectRoot, {
      actor: owner,
      member: researcher,
      role: "researcher",
      reason: "parallel proof",
    });
    const main = (await inspectProject(projectRoot)).manifest.defaultBranchId;
    const branch = await createCollaborationBranch(projectRoot, { actor: researcher, name: "revoked-proof", baseBranchId: main });
    await putCollaborationObject(projectRoot, {
      actor: researcher,
      branchId: branch.branchId,
      objectType: "claim",
      content: { statement: "A revocation must block merge." },
    });
    const authorization = await authorizeBranchMerge(projectRoot, {
      actor: owner,
      subject: researcher,
      sourceBranchId: branch.branchId,
      targetBranchId: main,
      reason: "may merge until revoked",
    });
    await revokeProjectMembership(projectRoot, {
      actor: owner,
      membershipId: researcherMembership.membershipId,
      reason: "access withdrawn",
    });
    await expect(mergeAcceptedBranch(projectRoot, {
      actor: researcher,
      authorizationId: authorization.authorizationId,
      sourceBranchId: branch.branchId,
      targetBranchId: main,
    })).rejects.toBeInstanceOf(CollaborationAuthorizationError);
    expect(await auditListConsumedMergeAuthorizations(projectRoot)).toEqual([]);
  });

  it("binds merge authority to the exact subject and issuer membership grants", async () => {
    const issuer = human();
    const replacementOwner = human();
    const researcher = human();
    const issuerMembership = await bootstrapProjectOwner(projectRoot, issuer);
    await grantProjectMembership(projectRoot, { actor: issuer, member: replacementOwner, role: "owner", reason: "continuity owner" });
    const researcherMembership = await grantProjectMembership(projectRoot, {
      actor: issuer,
      member: researcher,
      role: "researcher",
      reason: "parallel proof",
    });
    const main = (await inspectProject(projectRoot)).manifest.defaultBranchId;
    const subjectBranch = await createCollaborationBranch(projectRoot, { actor: researcher, name: "subject-epoch", baseBranchId: main });
    await putCollaborationObject(projectRoot, {
      actor: researcher,
      branchId: subjectBranch.branchId,
      objectType: "claim",
      content: { statement: "The subject grant must stay exact." },
    });
    const subjectAuthorization = await authorizeBranchMerge(projectRoot, {
      actor: issuer,
      subject: researcher,
      sourceBranchId: subjectBranch.branchId,
      targetBranchId: main,
      reason: "subject epoch test",
    });
    await revokeProjectMembership(projectRoot, {
      actor: issuer,
      membershipId: researcherMembership.membershipId,
      reason: "withdraw and re-grant",
    });
    const regrantedResearcher = await grantProjectMembership(projectRoot, {
      actor: issuer,
      member: researcher,
      role: "researcher",
      reason: "new researcher epoch",
    });
    expect(regrantedResearcher.membershipId).not.toBe(researcherMembership.membershipId);
    await expect(mergeAcceptedBranch(projectRoot, {
      actor: researcher,
      authorizationId: subjectAuthorization.authorizationId,
      sourceBranchId: subjectBranch.branchId,
      targetBranchId: main,
    })).rejects.toBeInstanceOf(CollaborationAuthorizationError);

    const issuerBranch = await createCollaborationBranch(projectRoot, { actor: researcher, name: "issuer-epoch", baseBranchId: main });
    await putCollaborationObject(projectRoot, {
      actor: researcher,
      branchId: issuerBranch.branchId,
      objectType: "claim",
      content: { statement: "The issuing owner grant must stay exact." },
    });
    const issuerAuthorization = await authorizeBranchMerge(projectRoot, {
      actor: issuer,
      subject: researcher,
      sourceBranchId: issuerBranch.branchId,
      targetBranchId: main,
      reason: "issuer epoch test",
    });
    await revokeProjectMembership(projectRoot, {
      actor: replacementOwner,
      membershipId: issuerMembership.membershipId,
      reason: "rotate original owner membership",
    });
    const regrantedIssuer = await grantProjectMembership(projectRoot, {
      actor: replacementOwner,
      member: issuer,
      role: "owner",
      reason: "new owner epoch",
    });
    expect(regrantedIssuer.membershipId).not.toBe(issuerMembership.membershipId);
    await expect(mergeAcceptedBranch(projectRoot, {
      actor: researcher,
      authorizationId: issuerAuthorization.authorizationId,
      sourceBranchId: issuerBranch.branchId,
      targetBranchId: main,
    })).rejects.toBeInstanceOf(CollaborationAuthorizationError);
    expect(await auditListConsumedMergeAuthorizations(projectRoot)).toEqual([]);
  });

  it("commits adopted objects, edges, authorization consumption, and BranchMerged atomically and one-shot", async () => {
    const owner = human();
    const researcher = human();
    await bootstrapProjectOwner(projectRoot, owner);
    await grantProjectMembership(projectRoot, { actor: owner, member: researcher, role: "researcher", reason: "parallel proof" });
    const main = (await inspectProject(projectRoot)).manifest.defaultBranchId;
    const branch = await createCollaborationBranch(projectRoot, { actor: researcher, name: "atomic-proof", baseBranchId: main });
    const context = await putCollaborationObject(projectRoot, {
      actor: researcher,
      branchId: branch.branchId,
      objectType: "context",
      content: { domain: "RP-001 finite cases" },
    });
    const claim = await putCollaborationObject(projectRoot, {
      actor: researcher,
      branchId: branch.branchId,
      objectType: "claim",
      content: { statement: "The universal claim is refuted at n = 2." },
    });
    const evidence = await putCollaborationObject(projectRoot, {
      actor: researcher,
      branchId: branch.branchId,
      objectType: "evidence",
      content: { kind: "finite counterexample", n: 2 },
    });
    await addCollaborationEdge(projectRoot, {
      actor: researcher,
      branchId: branch.branchId,
      edgeType: "refutes",
      fromObjectId: evidence.objectId,
      toObjectId: claim.objectId,
      contextId: context.objectId,
    });
    const authorization = await authorizeBranchMerge(projectRoot, {
      actor: owner,
      subject: researcher,
      sourceBranchId: branch.branchId,
      targetBranchId: main,
      reason: "reviewed atomic promotion",
    });
    const before = await projectHistory(projectRoot);
    const merged = await mergeAcceptedBranch(projectRoot, {
      actor: researcher,
      authorizationId: authorization.authorizationId,
      sourceBranchId: branch.branchId,
      targetBranchId: main,
    });
    const appended = (await projectHistory(projectRoot)).slice(before.length);
    expect(appended.map((event) => event.sequence)).toEqual(
      appended.map((_, index) => before.length + index + 1),
    );
    expect(appended.at(-2)?.eventType).toBe("CollaborationMergeAuthorizationConsumed");
    expect(appended.at(-1)?.eventType).toBe("BranchMerged");
    expect(appended.filter((event) => event.eventType === "ObjectVersionCreated")).toHaveLength(3);
    expect(appended.filter((event) => event.eventType === "EdgeCreated")).toHaveLength(1);
    expect(await auditListConsumedMergeAuthorizations(projectRoot)).toEqual([
      expect.objectContaining({ authorizationId: authorization.authorizationId, mergeId: merged.mergeId, consumedBy: researcher }),
    ]);
    await rebuildProjection(projectRoot);
    expect((await verifyProject(projectRoot)).ok).toBe(true);
    await expect(mergeAcceptedBranch(projectRoot, {
      actor: researcher,
      authorizationId: authorization.authorizationId,
      sourceBranchId: branch.branchId,
      targetBranchId: main,
    })).rejects.toBeInstanceOf(CollaborationAuthorizationError);
  });

  it("fails a prepared merge when a concurrent canonical event advances the expected head", async () => {
    const owner = human();
    const researcher = human();
    await bootstrapProjectOwner(projectRoot, owner);
    await grantProjectMembership(projectRoot, { actor: owner, member: researcher, role: "researcher", reason: "parallel proof" });
    const main = (await inspectProject(projectRoot)).manifest.defaultBranchId;
    const branch = await createCollaborationBranch(projectRoot, { actor: researcher, name: "race-proof", baseBranchId: main });
    await putCollaborationObject(projectRoot, {
      actor: researcher,
      branchId: branch.branchId,
      objectType: "claim",
      content: { statement: "A concurrent event must invalidate merge preparation." },
    });
    const authorization = await authorizeBranchMerge(projectRoot, {
      actor: owner,
      subject: researcher,
      sourceBranchId: branch.branchId,
      targetBranchId: main,
      reason: "valid until canonical history changes",
    });
    const expectedHead = await projectHead(projectRoot);
    await grantProjectMembership(projectRoot, { actor: owner, member: human(), role: "viewer", reason: "advance global history" });
    await expect(mergeAcceptedBranch(projectRoot, {
      actor: researcher,
      authorizationId: authorization.authorizationId,
      sourceBranchId: branch.branchId,
      targetBranchId: main,
      expectedHead,
    })).rejects.toBeInstanceOf(CollaborationConcurrencyError);
    expect(await auditListConsumedMergeAuthorizations(projectRoot)).toEqual([]);
  });

  it("rebuilds a crash-window projection before rejecting a stale merge authorization", async () => {
    const owner = human();
    const researcher = human();
    await bootstrapProjectOwner(projectRoot, owner);
    await grantProjectMembership(projectRoot, { actor: owner, member: researcher, role: "researcher", reason: "parallel proof" });
    const main = (await inspectProject(projectRoot)).manifest.defaultBranchId;
    const branch = await createCollaborationBranch(projectRoot, { actor: researcher, name: "crash-window-merge", baseBranchId: main });
    const claim = await putCollaborationObject(projectRoot, {
      actor: researcher,
      branchId: branch.branchId,
      objectType: "claim",
      content: { statement: "The version explicitly authorized for merge." },
    });
    const authorization = await authorizeBranchMerge(projectRoot, {
      actor: owner,
      subject: researcher,
      sourceBranchId: branch.branchId,
      targetBranchId: main,
      reason: "authorize only the observed source head",
    });

    const projectionPath = join(projectRoot, ".reasoning", "state.sqlite");
    const staleProjectionPath = join(sandbox, "merge-before-canonical-revision.sqlite");
    await cp(projectionPath, staleProjectionPath);
    await putObject(projectRoot, {
      actor: researcher,
      branchId: branch.branchId,
      objectId: claim.objectId,
      objectType: "claim",
      content: { statement: "A later source revision was never authorized." },
    });
    await cp(staleProjectionPath, projectionPath, { force: true });

    const before = (await projectHistory(projectRoot)).length;
    await expect(mergeAcceptedBranch(projectRoot, {
      actor: researcher,
      authorizationId: authorization.authorizationId,
      sourceBranchId: branch.branchId,
      targetBranchId: main,
    })).rejects.toBeInstanceOf(CollaborationConcurrencyError);
    expect((await projectHistory(projectRoot)).length).toBe(before);
    expect(await auditListConsumedMergeAuthorizations(projectRoot)).toEqual([]);
  });

  it("fails optimistic writes when the expected canonical head has advanced", async () => {
    const owner = human();
    const researcher = human();
    await bootstrapProjectOwner(projectRoot, owner);
    await grantProjectMembership(projectRoot, { actor: owner, member: researcher, role: "researcher", reason: "write test" });
    const main = (await inspectProject(projectRoot)).manifest.defaultBranchId;
    const branch = await createCollaborationBranch(projectRoot, {
      actor: researcher,
      name: "stale-object-write",
      baseBranchId: main,
    });
    const staleHead = await projectHead(projectRoot);
    await grantProjectMembership(projectRoot, { actor: owner, member: human(), role: "viewer", reason: "first write" });
    await expect(grantProjectMembership(projectRoot, {
      actor: owner,
      member: human(),
      role: "viewer",
      reason: "stale write",
      expectedHead: staleHead,
    })).rejects.toBeInstanceOf(CollaborationConcurrencyError);
    await expect(putCollaborationObject(projectRoot, {
      actor: researcher,
      branchId: branch.branchId,
      objectType: "claim",
      content: { statement: "must not append after stale authorization" },
      expectedHead: staleHead,
    })).rejects.toBeInstanceOf(CollaborationConcurrencyError);
    await expect(createCollaborationBranch(projectRoot, {
      actor: researcher,
      name: "must-not-linearize-after-revocation-race",
      expectedHead: staleHead,
    })).rejects.toBeInstanceOf(CollaborationConcurrencyError);
  });
});
