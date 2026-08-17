import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  addEdge,
  createProject,
  createRp001Fixture,
  putObject,
  registerArtifactBytes,
} from "../src/index.js";
import {
  evaluateCompletionPolicy,
  type CompletionPolicy,
} from "../src/policy.js";

describe("completion policy evaluation", () => {
  const sandboxes: string[] = [];

  async function sandbox(name: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), `rw-policy-${name}-`));
    sandboxes.push(root);
    return join(root, "project");
  }

  afterEach(async () => {
    await Promise.all(
      sandboxes.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  it("passes an RP-001-like policy using graph state and registered artifacts", async () => {
    const root = await sandbox("rp001");
    const fixture = await createRp001Fixture(root);
    const branchId = fixture.project.manifest.defaultBranchId;
    const claim = await putObject(root, {
      branchId,
      objectType: "claim",
      content: { statement: "p(40) = 41^2 is composite" },
    });
    const evidence = await putObject(root, {
      branchId,
      objectType: "evidence",
      content: { method: "exact factorization", value: "41 * 41" },
    });
    await addEdge(root, {
      branchId,
      edgeType: "supports",
      fromObjectId: evidence.objectId,
      toObjectId: claim.objectId,
      contextId: fixture.context.objectId,
    });
    const run = await putObject(root, {
      branchId,
      objectType: "run",
      content: { command: "python enumerate.py", status: "succeeded" },
    });
    const environment = await putObject(root, {
      branchId,
      objectType: "environment",
      content: { runtime: "Python 3" },
    });
    const registration = await registerArtifactBytes(root, Buffer.from("n,p(n)\n40,1681\n"), {
      branchId,
      mediaType: "text/csv",
      logicalName: "enumeration.csv",
      producedByRunId: run.objectId,
      environmentId: environment.objectId,
    });

    const policy: CompletionPolicy = {
      schemaVersion: 1,
      policyId: "rp-001-completion",
      name: "RP-001 minimum evidence",
      rules: [
        { ruleId: "problem", kind: "object_count", objectType: "problem", min: 1, max: 1 },
        { ruleId: "workstreams", kind: "object_count", objectType: "workstream", min: 4 },
        {
          ruleId: "claim-evidence-count",
          kind: "edge_count",
          edgeType: "supports",
          fromObjectType: "evidence",
          toObjectType: "claim",
          min: 1,
        },
        {
          ruleId: "every-claim-supported",
          kind: "every_object_has_edge",
          objectType: "claim",
          direction: "incoming",
          edgeTypes: ["supports"],
          otherObjectTypes: ["evidence"],
        },
        { ruleId: "failures", kind: "no_open_failures" },
        { ruleId: "dataset", kind: "artifact_count", min: 1, mediaTypes: ["text/csv"] },
      ],
    };

    const evaluation = await evaluateCompletionPolicy(root, { branchId, policy });
    expect(evaluation.passed).toBe(true);
    expect(evaluation.ruleResults).toHaveLength(policy.rules.length);
    expect(evaluation.ruleResults.every((result) => result.passed)).toBe(true);
    expect(evaluation.ruleResults.at(-1)?.observedArtifactIds).toEqual([
      registration.artifact.artifactId,
    ]);
  });

  it("fails hard gates for missing objects and unresolved failure records", async () => {
    const root = await sandbox("failure");
    const project = await createProject(root, { title: "Failure gate" });
    const branchId = project.manifest.defaultBranchId;
    const blocked = await putObject(root, {
      branchId,
      objectType: "failure",
      content: { status: "blocked", attempted: ["direct proof"] },
    });
    const closed = await putObject(root, {
      branchId,
      objectType: "failure",
      content: { status: " CLOSED " },
    });
    const policy: CompletionPolicy = {
      schemaVersion: 1,
      policyId: "failure-gate",
      name: "No premature completion",
      rules: [
        { ruleId: "required-claim", kind: "object_count", objectType: "claim", min: 1 },
        { ruleId: "no-open-failures", kind: "no_open_failures" },
      ],
    };

    const evaluation = await evaluateCompletionPolicy(root, { branchId, policy });
    expect(evaluation.passed).toBe(false);
    expect(evaluation.ruleResults.map(({ passed }) => passed)).toEqual([false, false]);
    expect(evaluation.ruleResults[1]?.reason).toContain(blocked.objectId);
    expect(evaluation.ruleResults[1]?.reason).not.toContain(closed.objectId);
    expect(evaluation.ruleResults[1]?.observedObjectIds).toEqual(
      [blocked.objectId, closed.objectId].sort(),
    );
  });

  it("requires evidence-to-claim direction and endpoint types", async () => {
    const root = await sandbox("relations");
    const project = await createProject(root, { title: "Claim evidence relations" });
    const branchId = project.manifest.defaultBranchId;
    const context = await putObject(root, {
      branchId,
      objectType: "context",
      content: { domain: "integers" },
    });
    const evidence = await putObject(root, {
      branchId,
      objectType: "evidence",
      content: { method: "calculation" },
    });
    const supported = await putObject(root, {
      branchId,
      objectType: "claim",
      content: { statement: "supported" },
    });
    const unsupported = await putObject(root, {
      branchId,
      objectType: "claim",
      content: { statement: "still unsupported" },
    });
    const validEdge = await addEdge(root, {
      branchId,
      edgeType: "supports",
      fromObjectId: evidence.objectId,
      toObjectId: supported.objectId,
      contextId: context.objectId,
    });
    await addEdge(root, {
      branchId,
      edgeType: "supports",
      fromObjectId: unsupported.objectId,
      toObjectId: context.objectId,
      contextId: context.objectId,
    });
    const policy: CompletionPolicy = {
      schemaVersion: 1,
      policyId: "claim-support",
      name: "Every claim has evidence",
      rules: [
        {
          ruleId: "typed-support-count",
          kind: "edge_count",
          edgeType: "supports",
          min: 1,
          fromObjectType: "evidence",
          toObjectType: "claim",
        },
        {
          ruleId: "coverage",
          kind: "every_object_has_edge",
          objectType: "claim",
          direction: "incoming",
          edgeTypes: ["supports"],
          otherObjectTypes: ["evidence"],
        },
      ],
    };

    const evaluation = await evaluateCompletionPolicy(root, { branchId, policy });
    expect(evaluation.passed).toBe(false);
    expect(evaluation.ruleResults[0]).toMatchObject({
      passed: true,
      observedEdgeIds: [validEdge.edgeId],
    });
    expect(evaluation.ruleResults[1]).toMatchObject({
      passed: false,
      observedEdgeIds: [validEdge.edgeId],
      observedObjectIds: [supported.objectId, unsupported.objectId].sort(),
    });
    expect(evaluation.ruleResults[1]?.reason).toContain(unsupported.objectId);
  });

  it("returns stable sorted evidence and rejects caller-authored success", async () => {
    const root = await sandbox("determinism");
    const project = await createProject(root, { title: "Deterministic policy" });
    const branchId = project.manifest.defaultBranchId;
    const objectIds = [
      "clm_00000000000000000000000002",
      "clm_00000000000000000000000000",
      "clm_00000000000000000000000001",
    ];
    for (const objectId of objectIds) {
      await putObject(root, {
        branchId,
        objectId,
        objectType: "claim",
        content: { statement: objectId },
      });
    }
    const policy: CompletionPolicy = {
      schemaVersion: 1,
      policyId: "stable",
      name: "Stable result",
      rules: [
        { ruleId: "claims", kind: "object_count", objectType: "claim", min: 3 },
      ],
    };

    const first = await evaluateCompletionPolicy(root, { branchId, policy });
    const second = await evaluateCompletionPolicy(root, {
      branchId,
      policy: JSON.parse(JSON.stringify(policy)) as CompletionPolicy,
    });
    expect(second).toEqual(first);
    expect(first.ruleResults[0]?.observedObjectIds).toEqual([...objectIds].sort());

    const forged = { ...policy, passed: true } as unknown as CompletionPolicy;
    await expect(evaluateCompletionPolicy(root, { branchId, policy: forged })).rejects.toThrow(
      /unsupported field "passed"/,
    );
  });
});
