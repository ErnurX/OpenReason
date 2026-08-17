import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ObjectEnvelope } from "@reasoning-workbench/project-format";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  addEdge,
  createProject,
  projectHistory,
  putObject,
} from "../src/index.js";
import {
  EDGE_PROPAGATION_DIRECTION,
  computeImpact,
  deriveStaleness,
  queryGraph,
  traverseGraph,
} from "../src/graph.js";

interface ReasoningGraphFixture {
  branchId: string;
  contextA: ObjectEnvelope;
  contextB: ObjectEnvelope;
  problem: ObjectEnvelope;
  assumption: ObjectEnvelope;
  definition: ObjectEnvelope;
  claim: ObjectEnvelope;
  claimB: ObjectEnvelope;
  evidence: ObjectEnvelope;
  goal: ObjectEnvelope;
}

async function createReasoningGraph(
  projectRoot: string,
): Promise<ReasoningGraphFixture> {
  const project = await createProject(projectRoot, {
    title: "RP-like graph analysis",
  });
  const branchId = project.manifest.defaultBranchId;
  const contextA = await putObject(projectRoot, {
    branchId,
    objectType: "context",
    content: { domain: "non-negative integers" },
  });
  const contextB = await putObject(projectRoot, {
    branchId,
    objectType: "context",
    content: { domain: "all integers" },
  });
  const problem = await putObject(projectRoot, {
    branchId,
    objectType: "problem",
    content: { statement: "Investigate p(n)=n^2+n+41" },
  });
  const assumption = await putObject(projectRoot, {
    branchId,
    objectType: "assumption",
    content: { statement: "n is a non-negative integer" },
  });
  const definition = await putObject(projectRoot, {
    branchId,
    objectType: "definition",
    content: { statement: "Prime means exactly two positive divisors" },
  });
  const claim = await putObject(projectRoot, {
    branchId,
    objectType: "claim",
    content: { statement: "p(n) is prime for 0 <= n < 40" },
  });
  const claimB = await putObject(projectRoot, {
    branchId,
    objectType: "claim",
    content: { statement: "p(40) is composite" },
  });
  const evidence = await putObject(projectRoot, {
    branchId,
    objectType: "evidence",
    content: { observation: "p(40)=1681=41^2" },
  });
  const goal = await putObject(projectRoot, {
    branchId,
    objectType: "goal",
    content: { statement: "State the strongest justified result" },
  });

  await addEdge(projectRoot, {
    branchId,
    edgeType: "depends_on",
    fromObjectId: claim.objectId,
    toObjectId: assumption.objectId,
    contextId: contextA.objectId,
  });
  await addEdge(projectRoot, {
    branchId,
    edgeType: "uses_definition",
    fromObjectId: claim.objectId,
    toObjectId: definition.objectId,
    contextId: contextA.objectId,
  });
  await addEdge(projectRoot, {
    branchId,
    edgeType: "supports",
    fromObjectId: evidence.objectId,
    toObjectId: claim.objectId,
    contextId: contextA.objectId,
  });
  await addEdge(projectRoot, {
    branchId,
    edgeType: "supports",
    fromObjectId: claim.objectId,
    toObjectId: goal.objectId,
    contextId: contextA.objectId,
  });
  await addEdge(projectRoot, {
    branchId,
    edgeType: "depends_on",
    fromObjectId: claimB.objectId,
    toObjectId: claim.objectId,
    contextId: contextA.objectId,
  });
  // Deliberate cycle: traversal must terminate and return each object once.
  await addEdge(projectRoot, {
    branchId,
    edgeType: "depends_on",
    fromObjectId: claim.objectId,
    toObjectId: claimB.objectId,
    contextId: contextA.objectId,
  });
  await addEdge(projectRoot, {
    branchId,
    edgeType: "refutes",
    fromObjectId: evidence.objectId,
    toObjectId: claimB.objectId,
    contextId: contextB.objectId,
  });
  await addEdge(projectRoot, {
    branchId,
    edgeType: "depends_on",
    fromObjectId: goal.objectId,
    toObjectId: problem.objectId,
    contextId: contextB.objectId,
  });

  return {
    branchId,
    contextA,
    contextB,
    problem,
    assumption,
    definition,
    claim,
    claimB,
    evidence,
    goal,
  };
}

describe("reasoning graph services", () => {
  let sandboxRoot: string;
  let projectRoot: string;
  let fixture: ReasoningGraphFixture;

  beforeEach(async () => {
    sandboxRoot = await mkdtemp(join(tmpdir(), "rw-graph-"));
    projectRoot = join(sandboxRoot, "project");
    fixture = await createReasoningGraph(projectRoot);
  });

  afterEach(async () => {
    await rm(sandboxRoot, { recursive: true, force: true });
  });

  it("queries a deterministic induced graph by context, object type, and edge type", () => {
    const contextA = queryGraph(projectRoot, {
      branchId: fixture.branchId,
      contextId: fixture.contextA.objectId,
    });
    expect(contextA.edges).toHaveLength(6);
    expect(
      contextA.edges.every(
        (edge) => edge.envelope.contextId === fixture.contextA.objectId,
      ),
    ).toBe(true);

    const claimsOnly = queryGraph(projectRoot, {
      branchId: fixture.branchId,
      contextId: fixture.contextA.objectId,
      objectTypes: ["claim"],
      edgeTypes: ["depends_on"],
    });
    expect(claimsOnly.objects.map((object) => object.objectId)).toEqual(
      [fixture.claim.objectId, fixture.claimB.objectId].sort(),
    );
    expect(claimsOnly.edges).toHaveLength(2);
    expect(
      claimsOnly.edges.map((edge) => edge.edgeId),
    ).toEqual(claimsOnly.edges.map((edge) => edge.edgeId).sort());

    const contextB = queryGraph(projectRoot, {
      branchId: fixture.branchId,
      contextId: fixture.contextB.objectId,
    });
    expect(contextB.edges.map((edge) => edge.edgeType).sort()).toEqual([
      "depends_on",
      "refutes",
    ]);
  });

  it("uses explicit propagation semantics in cycle-safe deterministic BFS with a depth bound", () => {
    expect(EDGE_PROPAGATION_DIRECTION).toMatchObject({
      depends_on: "to-from",
      uses_definition: "to-from",
      derived_from: "to-from",
      tested_by: "to-from",
      formalizes: "to-from",
      cites: "to-from",
      produced_by: "to-from",
      supports: "from-to",
      refutes: "from-to",
      contradicts: "from-to",
    });

    const bounded = traverseGraph(projectRoot, {
      branchId: fixture.branchId,
      startObjectIds: [fixture.assumption.objectId],
      direction: "downstream",
      maxDepth: 1,
    });
    expect(
      bounded.visits.map(({ object, depth }) => [object.objectId, depth]),
    ).toEqual([
      [fixture.assumption.objectId, 0],
      [fixture.claim.objectId, 1],
    ]);
    expect(bounded.visits[1]?.path[0]).toMatchObject({
      edgeType: "depends_on",
      sourceObjectId: fixture.assumption.objectId,
      targetObjectId: fixture.claim.objectId,
      traversal: "to-from",
    });

    const first = traverseGraph(projectRoot, {
      branchId: fixture.branchId,
      startObjectIds: [fixture.claim.objectId],
      direction: "both",
    });
    const second = traverseGraph(projectRoot, {
      branchId: fixture.branchId,
      startObjectIds: [fixture.claim.objectId],
      direction: "both",
    });
    expect(second).toEqual(first);
    const visitedIds = first.visits.map((visit) => visit.object.objectId);
    expect(new Set(visitedIds).size).toBe(visitedIds.length);
    expect(visitedIds).toContain(fixture.claimB.objectId);
    for (const visit of first.visits) {
      expect(visit.path).toHaveLength(visit.depth);
    }

    const upstreamDependencies = traverseGraph(projectRoot, {
      branchId: fixture.branchId,
      startObjectIds: [fixture.claim.objectId],
      direction: "upstream",
      edgeTypes: ["depends_on", "uses_definition"],
      maxDepth: 1,
    });
    expect(
      upstreamDependencies.visits
        .filter(({ depth }) => depth === 1)
        .map(({ object }) => object.objectId),
    ).toEqual(
      [
        fixture.assumption.objectId,
        fixture.claimB.objectId,
        fixture.definition.objectId,
      ].sort(),
    );
  });

  it("derives transitive multi-source impact and exact-version staleness without canonical writes", async () => {
    const revisedClaim = await putObject(projectRoot, {
      branchId: fixture.branchId,
      objectId: fixture.claim.objectId,
      objectType: "claim",
      content: {
        statement: "p(n) is prime for 0 <= n < 40, while p(40) is composite",
      },
    });
    const impact = computeImpact(projectRoot, {
      branchId: fixture.branchId,
      changedObjectIds: [fixture.evidence.objectId, fixture.assumption.objectId],
    });
    const impactedClaim = impact.affected.find(
      ({ object }) => object.objectId === fixture.claim.objectId,
    );
    expect(impactedClaim?.object.versionId).toBe(revisedClaim.versionId);
    expect(
      impactedClaim?.reasons.map((reason) => reason.changedObjectId).sort(),
    ).toEqual([fixture.assumption.objectId, fixture.evidence.objectId].sort());
    expect(
      impactedClaim?.reasons.map((reason) => reason.path[0]?.traversal).sort(),
    ).toEqual(["from-to", "to-from"]);
    expect(
      impact.affected.some(
        ({ object, depth }) => object.objectId === fixture.goal.objectId && depth === 2,
      ),
    ).toBe(true);

    const eventCountBefore = (await projectHistory(projectRoot)).length;
    const staleness = deriveStaleness(projectRoot, {
      branchId: fixture.branchId,
      changedObjectIds: [fixture.assumption.objectId],
    });
    const eventCountAfter = (await projectHistory(projectRoot)).length;
    expect(eventCountAfter).toBe(eventCountBefore);

    const staleClaim = staleness.classifications.find(
      ({ objectId }) => objectId === fixture.claim.objectId,
    );
    expect(staleClaim).toMatchObject({
      classification: "stale-dependent",
      versionId: revisedClaim.versionId,
      version: 2,
      depth: 1,
    });
    expect(staleClaim?.lineageVersionIds).toEqual([
      revisedClaim.versionId,
      fixture.claim.versionId,
    ]);
    expect(staleClaim?.edgePaths[0]?.[0]).toMatchObject({
      edgeType: "depends_on",
      sourceObjectId: fixture.assumption.objectId,
      targetObjectId: fixture.claim.objectId,
      targetVersionId: fixture.claim.versionId,
    });
  });
});
