import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  addEdge,
  createBranch,
  createProject,
  diffBranches,
  listCurrentObjects,
  listEdges,
  mergeBranchSafe,
  projectHistory,
  putObject,
  verifyProject,
} from "../src/index.js";

describe("Stage 2 safe branch merge", () => {
  let sandboxRoot: string;
  let projectRoot: string;

  beforeEach(async () => {
    sandboxRoot = await mkdtemp(join(tmpdir(), "rw-merge-"));
    projectRoot = join(sandboxRoot, "project");
  });

  afterEach(async () => {
    await rm(sandboxRoot, { recursive: true, force: true });
  });

  it("diffs a child snapshot and safely adopts its objects and edges", async () => {
    const project = await createProject(projectRoot, { title: "Clean merge" });
    const main = project.manifest.defaultBranchId;
    const claim = await putObject(projectRoot, {
      branchId: main,
      objectType: "claim",
      content: { statement: "Every finite field has prime-power order" },
    });
    const context = await putObject(projectRoot, {
      branchId: main,
      objectType: "context",
      content: { domain: "finite fields" },
    });
    const branch = await createBranch(projectRoot, {
      name: "proof",
      baseBranchId: main,
    });
    const revisedClaim = await putObject(projectRoot, {
      branchId: branch.branchId,
      objectId: claim.objectId,
      objectType: "claim",
      content: {
        statement: "A finite field has order p^n",
        justification: "its additive group is a vector space over F_p",
      },
    });
    const evidence = await putObject(projectRoot, {
      branchId: branch.branchId,
      objectType: "evidence",
      content: { method: "additive-group argument" },
    });
    const edge = await addEdge(projectRoot, {
      branchId: branch.branchId,
      edgeType: "supports",
      fromObjectId: evidence.objectId,
      toObjectId: claim.objectId,
      contextId: context.objectId,
    });

    const before = await diffBranches(projectRoot, branch.branchId, main);
    expect(before.objectChanges).toEqual([
      expect.objectContaining({ objectId: claim.objectId, status: "source-only" }),
      expect.objectContaining({
        objectId: evidence.objectId,
        status: "source-only",
      }),
    ]);
    expect(before.sourceOnlyEdgeIds).toEqual([edge.edgeId]);

    const merged = await mergeBranchSafe(projectRoot, {
      sourceBranchId: branch.branchId,
      targetBranchId: main,
    });
    expect(merged.status).toBe("merged");
    expect(merged.appliedObjectVersionIds).toHaveLength(2);
    expect(merged.adoptedEdgeIds).toHaveLength(1);
    expect(merged.adoptedEdgeIds[0]).not.toBe(edge.edgeId);
    expect(merged.conflictObjectIds).toEqual([]);

    const mainObjects = listCurrentObjects(projectRoot, main);
    expect(mainObjects.find(({ objectId }) => objectId === claim.objectId)).toMatchObject({
      content: revisedClaim.content,
      version: 2,
    });
    expect(mainObjects.find(({ objectId }) => objectId === evidence.objectId)).toMatchObject({
      content: evidence.content,
      version: 1,
    });
    expect(listEdges(projectRoot, main)).toEqual([
      expect.objectContaining({
        edgeId: merged.adoptedEdgeIds[0],
        fromObjectId: evidence.objectId,
        toObjectId: claim.objectId,
        envelope: expect.objectContaining({
          "x-rw:merge": expect.objectContaining({ sourceEdgeId: edge.edgeId }),
        }),
      }),
    ]);
    expect((await projectHistory(projectRoot)).at(-1)?.eventType).toBe(
      "BranchMerged",
    );
    expect((await verifyProject(projectRoot)).ok).toBe(true);
  });

  it("records divergent edits as durable failure objects without partial adoption", async () => {
    const project = await createProject(projectRoot, {
      title: "Conflicting merge",
    });
    const main = project.manifest.defaultBranchId;
    const claim = await putObject(projectRoot, {
      branchId: main,
      objectType: "claim",
      content: { statement: "The bound is 10" },
    });
    const branch = await createBranch(projectRoot, {
      name: "alternative",
      baseBranchId: main,
    });
    const sourceEdit = await putObject(projectRoot, {
      branchId: branch.branchId,
      objectId: claim.objectId,
      objectType: "claim",
      content: { statement: "The bound is 12" },
    });
    const targetEdit = await putObject(projectRoot, {
      branchId: main,
      objectId: claim.objectId,
      objectType: "claim",
      content: { statement: "The bound is 11" },
    });

    const result = await mergeBranchSafe(projectRoot, {
      sourceBranchId: branch.branchId,
      targetBranchId: main,
    });
    expect(result.status).toBe("conflicted");
    expect(result.appliedObjectVersionIds).toEqual([]);
    expect(result.adoptedEdgeIds).toEqual([]);
    expect(result.conflictObjectIds).toHaveLength(1);

    const mainObjects = listCurrentObjects(projectRoot, main);
    expect(mainObjects.find(({ objectId }) => objectId === claim.objectId)).toMatchObject({
      versionId: targetEdit.versionId,
      content: targetEdit.content,
    });
    expect(mainObjects.find(({ objectId }) => objectId === result.conflictObjectIds[0])).toMatchObject({
      objectType: "failure",
      content: expect.objectContaining({
        kind: "merge-conflict",
        status: "open",
        objectId: claim.objectId,
        sourceVersionId: sourceEdit.versionId,
        targetVersionId: targetEdit.versionId,
      }),
    });
    expect((await verifyProject(projectRoot)).ok).toBe(true);
  });

  it("rejects merges that are not from a direct child into its parent", async () => {
    const project = await createProject(projectRoot, { title: "Merge direction" });
    const main = project.manifest.defaultBranchId;
    const child = await createBranch(projectRoot, {
      name: "child",
      baseBranchId: main,
    });
    await expect(diffBranches(projectRoot, main, child.branchId)).rejects.toThrow(
      "direct child branch",
    );
  });
});
