import {
  access,
  copyFile,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  computeEventHash,
  createId,
  type Event,
} from "@reasoning-workbench/project-format";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  FileSystemArtifactStore,
  PROJECTION_RELATIVE_PATH,
  addEdge,
  createBranch,
  createProject,
  createRp001Fixture,
  exportProject,
  getObjectHistory,
  getProjectProjection,
  inspectProject,
  listBranches,
  listCurrentObjects,
  listEdges,
  loadManifest,
  projectHistory,
  putObject,
  rebuildProjection,
  registerArtifactBytes,
  verifyProject,
} from "../src/index.js";

function deepKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(deepKeys);
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, nested]) => [key, ...deepKeys(nested)]);
}

function observableProjection(projectRoot: string): unknown {
  return {
    project: getProjectProjection(projectRoot),
    branches: listBranches(projectRoot),
    objects: listCurrentObjects(projectRoot),
    edges: listEdges(projectRoot),
  };
}

describe("project service integration", () => {
  let sandboxRoot: string;
  let projectRoot: string;

  beforeEach(async () => {
    sandboxRoot = await mkdtemp(join(tmpdir(), "rw-project-integration-"));
    projectRoot = join(sandboxRoot, "project");
  });

  afterEach(async () => {
    await rm(sandboxRoot, { recursive: true, force: true });
  });

  it("creates and inspects a project while branch snapshots keep independent object versions", async () => {
    const created = await createProject(projectRoot, {
      title: "Branch isolation integration",
    });
    const mainBranchId = created.manifest.defaultBranchId;
    const first = await putObject(projectRoot, {
      branchId: mainBranchId,
      objectType: "claim",
      content: { statement: "p(n) is prime for every n >= 0" },
    });
    const staleProjection = join(sandboxRoot, "stale-state.sqlite");
    await copyFile(join(projectRoot, PROJECTION_RELATIVE_PATH), staleProjection);
    const fork = await createBranch(projectRoot, {
      name: "counterexample-search",
      baseBranchId: mainBranchId,
    });

    const mainSecond = await putObject(projectRoot, {
      branchId: mainBranchId,
      objectId: first.objectId,
      objectType: "claim",
      content: { statement: "p(n) is prime for 0 <= n < 40" },
    });
    expect(listCurrentObjects(projectRoot, fork.branchId)).toEqual([
      expect.objectContaining({
        objectId: first.objectId,
        versionId: first.versionId,
        version: 1,
      }),
    ]);

    // Simulate a process crash after event acceptance but before projection
    // refresh. The next mutation must replay the readable-but-stale cache.
    await copyFile(staleProjection, join(projectRoot, PROJECTION_RELATIVE_PATH));
    const forkSecond = await putObject(projectRoot, {
      branchId: fork.branchId,
      objectId: first.objectId,
      objectType: "claim",
      content: { statement: "p(40) = 41^2 is composite" },
    });

    expect(mainSecond).toMatchObject({
      version: 2,
      supersedesVersionId: first.versionId,
    });
    expect(forkSecond).toMatchObject({
      version: 2,
      supersedesVersionId: first.versionId,
    });
    expect(forkSecond.versionId).not.toBe(mainSecond.versionId);
    expect(listCurrentObjects(projectRoot, mainBranchId)).toEqual([
      expect.objectContaining({
        versionId: mainSecond.versionId,
        content: mainSecond.content,
      }),
    ]);
    expect(listCurrentObjects(projectRoot, fork.branchId)).toEqual([
      expect.objectContaining({
        versionId: forkSecond.versionId,
        content: forkSecond.content,
      }),
    ]);

    const history = getObjectHistory(projectRoot, first.objectId);
    expect(history).toHaveLength(3);
    expect(history.map(({ version }) => version).sort()).toEqual([1, 2, 2]);
    expect(new Set(history.map(({ versionId }) => versionId))).toHaveProperty(
      "size",
      3,
    );

    const inspection = await inspectProject(projectRoot);
    expect(inspection.manifest.title).toBe("Branch isolation integration");
    expect(inspection.branches).toHaveLength(2);
    expect(inspection.projection).toMatchObject({
      projectId: created.manifest.projectId,
      branchCount: 2,
      objectCount: 2,
    });
  });

  it("round-trips unknown namespaced manifest and object fields through append, canonical export, and reopen", async () => {
    const created = await createProject(projectRoot, {
      title: "Extension round trip",
      extensions: {
        "org.example:manifest": { revision: 7, enabled: true },
      },
    });
    const object = await putObject(projectRoot, {
      branchId: created.manifest.defaultBranchId,
      objectType: "problem",
      content: { question: "Which statements survive export?" },
      extensions: {
        "org.example:object": { opaque: ["alpha", 42] },
      },
    });
    // A later append forces another atomic manifest rewrite.
    await putObject(projectRoot, {
      branchId: created.manifest.defaultBranchId,
      objectType: "goal",
      content: { statement: "Preserve extension data exactly" },
    });

    expect(
      (await loadManifest(projectRoot))["org.example:manifest"],
    ).toEqual({ revision: 7, enabled: true });
    const sourceEvent = (await projectHistory(projectRoot)).find(
      (event) =>
        event.eventType === "ObjectVersionCreated" &&
        (event.payload.object as { objectId?: unknown } | undefined)?.objectId ===
          object.objectId,
    );
    expect(
      (sourceEvent?.payload.object as Record<string, unknown>)[
        "org.example:object"
      ],
    ).toEqual({ opaque: ["alpha", 42] });

    const exportedRoot = join(sandboxRoot, "clean-export");
    const exportedInspection = await exportProject(projectRoot, exportedRoot);
    expect(exportedInspection.manifest.projectId).toBe(created.manifest.projectId);
    await expect(access(join(exportedRoot, ".reasoning"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    // Verification replays canonical state without materializing a cache.
    const beforeOpenVerification = await verifyProject(exportedRoot);
    expect(beforeOpenVerification.ok).toBe(true);
    await expect(access(join(exportedRoot, ".reasoning"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    // Opening recreates the disposable projection from the exported events.
    const reopened = await inspectProject(exportedRoot);
    expect((await stat(join(exportedRoot, PROJECTION_RELATIVE_PATH))).isFile()).toBe(
      true,
    );
    expect(reopened.manifest["org.example:manifest"]).toEqual({
      revision: 7,
      enabled: true,
    });
    expect(
      reopened.objects.find(({ objectId }) => objectId === object.objectId)
        ?.envelope["org.example:object"],
    ).toEqual({ opaque: ["alpha", 42] });
    expect((await verifyProject(exportedRoot)).ok).toBe(true);
  });

  it("rebuilds an equivalent projection after state.sqlite is removed", async () => {
    const created = await createProject(projectRoot, {
      title: "Projection replay integration",
    });
    const branchId = created.manifest.defaultBranchId;
    const problem = await putObject(projectRoot, {
      branchId,
      objectType: "problem",
      content: { statement: "Investigate p(n)" },
    });
    const context = await putObject(projectRoot, {
      branchId,
      objectType: "context",
      content: { domain: "n >= 0" },
    });
    const goal = await putObject(projectRoot, {
      branchId,
      objectType: "goal",
      content: { statement: "Find the first composite" },
    });
    await addEdge(projectRoot, {
      branchId,
      edgeType: "depends_on",
      fromObjectId: goal.objectId,
      toObjectId: problem.objectId,
      contextId: context.objectId,
    });
    const before = observableProjection(projectRoot);

    await rm(join(projectRoot, PROJECTION_RELATIVE_PATH));
    await rebuildProjection(projectRoot);

    expect(observableProjection(projectRoot)).toEqual(before);
    expect((await verifyProject(projectRoot)).ok).toBe(true);
  });

  it("registers artifacts against real run and environment objects, validates inputs, and detects CAS corruption", async () => {
    const created = await createProject(projectRoot, {
      title: "Artifact lineage integration",
    });
    const branchId = created.manifest.defaultBranchId;
    const environment = await putObject(projectRoot, {
      branchId,
      objectType: "environment",
      content: {
        runtime: "node",
        version: process.version,
        lock: "pnpm-lock.yaml",
      },
    });
    const run = await putObject(projectRoot, {
      branchId,
      objectType: "run",
      content: {
        command: ["node", "enumerate.mjs"],
        inputs: [],
        environmentId: environment.objectId,
        permissions: { filesystem: "project-read" },
        nondeterminism: { kind: "deterministic" },
        parameters: { upperBound: 200 },
        seeds: [],
      },
    });

    const input = await registerArtifactBytes(
      projectRoot,
      new TextEncoder().encode("n,value\n0,41\n"),
      {
        branchId,
        mediaType: "text/csv",
        logicalName: "input.csv",
        producedByRunId: run.objectId,
        environmentId: environment.objectId,
      },
    );
    const output = await registerArtifactBytes(
      projectRoot,
      new TextEncoder().encode('{"firstComposite":{"n":40,"value":1681}}\n'),
      {
        branchId,
        mediaType: "application/json",
        logicalName: "enumeration-result.json",
        producedByRunId: run.objectId,
        environmentId: environment.objectId,
        inputs: [input.artifact.digest],
        reproducibility: "deterministic",
      },
    );

    expect(output.artifact).toMatchObject({
      producedByRunId: run.objectId,
      environmentId: environment.objectId,
      inputs: [input.artifact.digest],
    });
    expect(getProjectProjection(projectRoot).artifactCount).toBe(2);
    expect((await verifyProject(projectRoot)).ok).toBe(true);

    const store = new FileSystemArtifactStore(projectRoot);
    const artifactCount = (await store.list()).length;
    await expect(
      registerArtifactBytes(
        projectRoot,
        new TextEncoder().encode("must-not-be-written"),
        {
          branchId,
          mediaType: "application/octet-stream",
          logicalName: "orphan.bin",
          producedByRunId: createId("run"),
          environmentId: environment.objectId,
        },
      ),
    ).rejects.toThrow(/not a visible run object/);
    expect(await store.list()).toHaveLength(artifactCount);

    await writeFile(output.receipt.path, "corrupted bytes");
    const corrupted = await verifyProject(projectRoot);
    expect(corrupted.ok).toBe(false);
    expect(corrupted.artifacts.ok).toBe(false);
    expect(corrupted.issues).toContainEqual(
      expect.objectContaining({ scope: "artifacts" }),
    );
  });

  it("rejects semantic object corruption even when the tampered event is rehashed", async () => {
    const created = await createProject(projectRoot, {
      title: "Semantic verification integration",
    });
    await putObject(projectRoot, {
      branchId: created.manifest.defaultBranchId,
      objectType: "claim",
      content: { statement: "original statement" },
    });
    const manifest = await loadManifest(projectRoot);
    const segmentPath = join(projectRoot, manifest.eventSegments.at(-1)!);
    const event = JSON.parse(await readFile(segmentPath, "utf8")) as Event;
    const object = event.payload.object as {
      content: Record<string, unknown>;
    };
    object.content.statement = "tampered but rehashed";
    event.eventHash = computeEventHash(event);
    await writeFile(segmentPath, `${JSON.stringify(event)}\n`);

    const verification = await verifyProject(projectRoot);
    expect(verification.eventLog.valid).toBe(true);
    expect(verification.ok).toBe(false);
    expect(verification.issues).toContainEqual(
      expect.objectContaining({
        scope: "events",
        code: "object-content-hash",
      }),
    );
  });

  it("builds RP-001 with its problem, context, goal, four workstreams, and provider-neutral canonical keys", async () => {
    const fixture = await createRp001Fixture(projectRoot);
    expect(fixture.problem.objectType).toBe("problem");
    expect(fixture.context.objectType).toBe("context");
    expect(fixture.goal.objectType).toBe("goal");
    expect(fixture.workstreams).toHaveLength(4);
    expect(new Set(fixture.workstreams.map(({ objectId }) => objectId))).toHaveProperty(
      "size",
      4,
    );

    const inspection = await inspectProject(projectRoot);
    const objectTypes = inspection.objects.map(({ objectType }) => objectType);
    expect(objectTypes.filter((type) => type === "problem")).toHaveLength(1);
    expect(objectTypes.filter((type) => type === "context")).toHaveLength(1);
    expect(objectTypes.filter((type) => type === "goal")).toHaveLength(1);
    expect(objectTypes.filter((type) => type === "workstream")).toHaveLength(4);
    expect(objectTypes).toHaveLength(7);

    const canonicalState = {
      manifest: await loadManifest(projectRoot),
      events: await projectHistory(projectRoot),
    };
    const providerSpecificKeys = deepKeys(canonicalState).filter((key) =>
      /openai|anthropic|claude|gemini|provider|conversationid|modelid/i.test(key),
    );
    expect(providerSpecificKeys).toEqual([]);
    expect((await verifyProject(projectRoot)).ok).toBe(true);
  });
});
