import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  PROJECTION_RELATIVE_PATH,
  getObjectHistory,
  getProjectProjection,
  listBranches,
  listCurrentObjects,
  listEdges,
  nextObjectVersion,
  rebuildProjection,
  type StoredEvent,
} from "./projection.js";

const PROJECT_ID = "prj_projection_test";
const MAIN_BRANCH_ID = "br_main";
const FORK_BRANCH_ID = "br_fork";
const OBJECT_ID = "clm_shared";
const TIMESTAMP = "2026-08-14T12:00:00.000Z";
const ACTOR = { actorType: "human", actorId: "usr_test" };

function digest(marker: string): string {
  return `sha256:${marker.padEnd(64, "0").slice(0, 64)}`;
}

function event(
  sequence: number,
  eventType: string,
  payload: Record<string, unknown>,
  branchId?: string,
): StoredEvent {
  return {
    sequence,
    eventId: `evt_${sequence}`,
    eventType,
    occurredAt: TIMESTAMP,
    projectId: PROJECT_ID,
    ...(branchId === undefined ? {} : { branchId }),
    actor: ACTOR,
    schemaVersion: 1,
    payload,
    eventHash: digest(String(sequence)),
  };
}

function projectInitialized(sequence = 1): StoredEvent {
  return event(sequence, "ProjectInitialized", {
    title: "Projection contract test",
    defaultBranchId: MAIN_BRANCH_ID,
    formatVersion: "0.1.0",
  });
}

function branchCreated(
  sequence: number,
  branchId: string,
  name: string,
  baseBranchId?: string,
): StoredEvent {
  return event(
    sequence,
    "BranchCreated",
    {
      branchId,
      name,
      ...(baseBranchId === undefined ? {} : { baseBranchId }),
    },
    branchId,
  );
}

function objectVersionCreated(
  sequence: number,
  branchId: string,
  versionId: string,
  version: number,
  statement: string,
): StoredEvent {
  const content = { statement };
  return event(
    sequence,
    "ObjectVersionCreated",
    {
      object: {
        objectId: OBJECT_ID,
        objectType: "claim",
        versionId,
        version,
        createdAt: TIMESTAMP,
        createdBy: ACTOR,
        branchId,
        content,
        contentHash: digest(versionId),
        ...(version === 1 ? {} : { supersedesVersionId: "ver_initial" }),
      },
    },
    branchId,
  );
}

function edgeCreated(
  sequence: number,
  branchId: string,
  edgeId: string,
  versionId = "ver_initial",
): StoredEvent {
  return event(
    sequence,
    "EdgeCreated",
    {
      edge: {
        edgeId,
        edgeType: "supports",
        from: { objectId: OBJECT_ID, versionId },
        to: { objectId: OBJECT_ID, versionId },
        createdAt: TIMESTAMP,
        createdBy: ACTOR,
        metadata: {},
      },
    },
    branchId,
  );
}

function baseEvents(): StoredEvent[] {
  return [
    projectInitialized(),
    branchCreated(2, MAIN_BRANCH_ID, "main"),
    objectVersionCreated(3, MAIN_BRANCH_ID, "ver_initial", 1, "initial"),
  ];
}

function branchingEvents(): StoredEvent[] {
  return [
    ...baseEvents(),
    branchCreated(4, FORK_BRANCH_ID, "fork", MAIN_BRANCH_ID),
    objectVersionCreated(5, MAIN_BRANCH_ID, "ver_main_second", 2, "main second"),
    // Independent branches may legitimately allocate the same display version
    // number. The stable versionId, not this number, is the durable identity.
    objectVersionCreated(6, FORK_BRANCH_ID, "ver_fork_second", 2, "fork second"),
  ];
}

function queryProjectedEvent(
  projectRoot: string,
  sequence: number,
): { eventType: string; body: Record<string, unknown> } | undefined {
  const db = new DatabaseSync(join(projectRoot, PROJECTION_RELATIVE_PATH), {
    readOnly: true,
  });
  try {
    const row = db
      .prepare(
        "SELECT event_type AS eventType, body_json AS bodyJson FROM events WHERE sequence = ?",
      )
      .get(sequence) as { eventType: string; bodyJson: string } | undefined;
    return row === undefined
      ? undefined
      : {
          eventType: row.eventType,
          body: JSON.parse(row.bodyJson) as Record<string, unknown>,
        };
  } finally {
    db.close();
  }
}

function observableProjection(projectRoot: string): unknown {
  return {
    project: getProjectProjection(projectRoot),
    branches: listBranches(projectRoot),
    objects: listCurrentObjects(projectRoot),
    history: getObjectHistory(projectRoot, OBJECT_ID),
    nextVersion: nextObjectVersion(projectRoot, MAIN_BRANCH_ID, OBJECT_ID),
  };
}

describe("SQLite project projection", () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "reasoning-workbench-projection-"));
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it("rebuilds an equivalent disposable projection after SQLite is deleted", async () => {
    const events = branchingEvents();
    await rebuildProjection(projectRoot, events);
    const before = observableProjection(projectRoot);

    await rm(join(projectRoot, PROJECTION_RELATIVE_PATH));
    await rebuildProjection(projectRoot, events);

    expect(observableProjection(projectRoot)).toEqual(before);
  });

  it("takes a branch snapshot and isolates later current-object changes", async () => {
    const events = [
      ...baseEvents(),
      branchCreated(4, FORK_BRANCH_ID, "fork", MAIN_BRANCH_ID),
      objectVersionCreated(5, MAIN_BRANCH_ID, "ver_main_second", 2, "main second"),
    ];
    await rebuildProjection(projectRoot, events);

    const main = listCurrentObjects(projectRoot, MAIN_BRANCH_ID);
    const fork = listCurrentObjects(projectRoot, FORK_BRANCH_ID);
    expect(main).toHaveLength(1);
    expect(fork).toHaveLength(1);
    expect(main[0]).toMatchObject({
      objectId: OBJECT_ID,
      versionId: "ver_main_second",
      version: 2,
      content: { statement: "main second" },
    });
    expect(fork[0]).toMatchObject({
      objectId: OBJECT_ID,
      versionId: "ver_initial",
      version: 1,
      content: { statement: "initial" },
    });
    expect(listBranches(projectRoot)).toEqual([
      expect.objectContaining({
        branchId: MAIN_BRANCH_ID,
        baseSequence: 2,
        headSequence: 5,
      }),
      expect.objectContaining({
        branchId: FORK_BRANCH_ID,
        parentBranchId: MAIN_BRANCH_ID,
        baseSequence: 3,
        headSequence: 4,
      }),
    ]);
  });

  it("keeps immutable history while each branch points at its current version", async () => {
    await rebuildProjection(projectRoot, branchingEvents());

    expect(listCurrentObjects(projectRoot, MAIN_BRANCH_ID)[0]).toMatchObject({
      versionId: "ver_main_second",
      version: 2,
    });
    expect(listCurrentObjects(projectRoot, FORK_BRANCH_ID)[0]).toMatchObject({
      versionId: "ver_fork_second",
      version: 2,
    });

    const history = getObjectHistory(projectRoot, OBJECT_ID);
    expect(history.map(({ versionId }) => versionId)).toEqual([
      "ver_initial",
      "ver_fork_second",
      "ver_main_second",
    ]);
    expect(history.map(({ content }) => content)).toEqual([
      { statement: "initial" },
      { statement: "fork second" },
      { statement: "main second" },
    ]);
    expect(nextObjectVersion(projectRoot, MAIN_BRANCH_ID, OBJECT_ID)).toBe(3);
    expect(nextObjectVersion(projectRoot, FORK_BRANCH_ID, OBJECT_ID)).toBe(3);
  });

  it("inherits the edge snapshot while isolating child-only edges", async () => {
    const events = [
      ...baseEvents(),
      edgeCreated(4, MAIN_BRANCH_ID, "edg_parent"),
      branchCreated(5, FORK_BRANCH_ID, "fork", MAIN_BRANCH_ID),
      edgeCreated(6, FORK_BRANCH_ID, "edg_child"),
    ];
    await rebuildProjection(projectRoot, events);

    expect(listEdges(projectRoot, MAIN_BRANCH_ID).map(({ edgeId }) => edgeId)).toEqual([
      "edg_parent",
    ]);
    expect(listEdges(projectRoot, FORK_BRANCH_ID).map(({ edgeId }) => edgeId)).toEqual([
      "edg_child",
      "edg_parent",
    ]);
  });

  it("rejects an edge that leaks a sibling-only object version", async () => {
    const events = [
      ...branchingEvents(),
      edgeCreated(7, FORK_BRANCH_ID, "edg_cross_branch", "ver_main_second"),
    ];

    await expect(rebuildProjection(projectRoot, events)).rejects.toThrow(
      /not visible in the br_fork lineage/,
    );
  });

  it("retains unknown events verbatim without inventing projection semantics", async () => {
    const unknown = event(
      4,
      "org.example/NotebookObservationRecorded",
      {
        observation: "kept for a newer reader",
        "org.example/extension": { version: 7 },
      },
      MAIN_BRANCH_ID,
    );
    await rebuildProjection(projectRoot, [...baseEvents(), unknown]);

    expect(getProjectProjection(projectRoot)).toMatchObject({
      lastSequence: 4,
      eventCount: 4,
      branchCount: 1,
      objectCount: 1,
    });
    expect(listCurrentObjects(projectRoot, MAIN_BRANCH_ID)).toHaveLength(1);
    expect(queryProjectedEvent(projectRoot, 4)).toEqual({
      eventType: unknown.eventType,
      body: unknown,
    });
  });

  it("rejects a sequence gap atomically and preserves the prior projection", async () => {
    await rebuildProjection(projectRoot, baseEvents());
    const accepted = observableProjection(projectRoot);
    const gapped = [
      projectInitialized(),
      branchCreated(3, MAIN_BRANCH_ID, "main"),
    ];

    await expect(rebuildProjection(projectRoot, gapped)).rejects.toThrow(
      "Event sequence gap: expected 2, got 3",
    );
    expect(observableProjection(projectRoot)).toEqual(accepted);
    await expect(readdir(join(projectRoot, ".reasoning"))).resolves.toEqual([
      "state.sqlite",
    ]);
  });
});
