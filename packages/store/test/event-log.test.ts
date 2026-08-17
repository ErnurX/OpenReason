import {
  ProjectManifestSchema,
  createEvent,
  createId,
  utcNow,
  type Event,
  type ProjectManifest,
} from "@reasoning-workbench/project-format";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  EventLogIntegrityError,
  appendEvent,
  initializeEventLog,
  inspectEventLog,
  readAcceptedEvents,
  verifyEventLog,
} from "../src/event-log.js";

const TEST_TIME = Date.UTC(2026, 7, 14, 0, 0, 0);
const roots: string[] = [];

interface TestProject {
  root: string;
  manifest: ProjectManifest;
  projectId: ProjectManifest["projectId"];
  branchId: ProjectManifest["defaultBranchId"];
  actorId: ProjectManifest["projectId"];
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeProject(
  manifestFileName = "reasoning-project.json",
): Promise<TestProject> {
  const root = join(
    tmpdir(),
    `reasoning-workbench-event-log-${process.pid}-${createId("tmp", TEST_TIME)}`,
  );
  roots.push(root);
  await mkdir(root, { recursive: true });

  const projectId = createId("prj", TEST_TIME);
  const branchId = createId("br", TEST_TIME);
  const actorId = createId("usr", TEST_TIME);
  const manifest = ProjectManifestSchema.parse({
    format: "reasoning-project",
    formatVersion: "0.1.0",
    projectId,
    title: "Event log test",
    createdAt: utcNow(TEST_TIME),
    defaultBranchId: branchId,
    eventSegments: [],
    hashAlgorithm: "sha256",
    "org.reasoning-workbench.test": {
      mustSurviveManifestRewrite: true,
    },
  });
  await writeFile(join(root, manifestFileName), `${JSON.stringify(manifest, null, 2)}\n`);

  return { root, manifest, projectId, branchId, actorId };
}

function testEvent(
  project: TestProject,
  sequence: number,
  previousEvent?: Event,
): Event {
  return createEvent({
    sequence,
    eventId: createId("evt", TEST_TIME),
    eventType: "TestObservationRecorded",
    occurredAt: utcNow(TEST_TIME + sequence),
    projectId: project.projectId,
    branchId: project.branchId,
    actor: { actorType: "human", actorId: project.actorId },
    schemaVersion: 1,
    payload: { sequence, note: `observation-${sequence}` },
    ...(previousEvent === undefined ? {} : { previousEventHash: previousEvent.eventHash }),
  });
}

describe("event log", () => {
  it("accepts a durable segment only through an atomic manifest update", async () => {
    const project = await makeProject();
    const paths = await initializeEventLog(project.root);
    const event = testEvent(project, 1);

    const result = await appendEvent(project.root, event);

    expect(result.segmentPath).toBe("events/00000001-00000001.jsonl");
    expect(result.recoveredOrphanSegment).toBe(false);
    expect(await readAcceptedEvents(project.root)).toEqual([event]);

    const segment = await readFile(join(project.root, result.segmentPath), "utf8");
    expect(segment).toBe(`${JSON.stringify(event)}\n`);
    expect(paths.eventsDirectory).toBe(join(project.root, "events"));

    const rewrittenManifest = JSON.parse(
      await readFile(join(project.root, "reasoning-project.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(rewrittenManifest.eventSegments).toEqual([result.segmentPath]);
    expect(rewrittenManifest["org.reasoning-workbench.test"]).toEqual({
      mustSurviveManifestRewrite: true,
    });

    const verification = await verifyEventLog(project.root);
    expect(verification.valid).toBe(true);
    expect(verification.issues).toEqual([]);
  });

  it("never accepts a complete segment when interrupted before manifest commit", async () => {
    const project = await makeProject();
    const first = testEvent(project, 1);
    await appendEvent(project.root, first);
    const second = testEvent(project, 2, first);

    await expect(
      appendEvent(project.root, second, {
        hooks: {
          beforeManifestCommit: () => {
            throw new Error("injected crash before manifest commit");
          },
        },
      }),
    ).rejects.toThrow("injected crash before manifest commit");

    // The full segment is deliberately retained as failure evidence, but the
    // old manifest is still the sole acceptance boundary.
    expect(await readAcceptedEvents(project.root)).toEqual([first]);
    const interrupted = await inspectEventLog(project.root);
    expect(interrupted.valid).toBe(true);
    expect(interrupted.orphanSegments).toEqual(["events/00000002-00000002.jsonl"]);
    expect(interrupted.issues).toContainEqual(
      expect.objectContaining({ code: "ORPHAN_SEGMENT", severity: "warning" }),
    );

    // Hook failure also releases the lock. Retrying the exact event adopts the
    // already durable orphan rather than rewriting it.
    const retried = await appendEvent(project.root, second);
    expect(retried.recoveredOrphanSegment).toBe(true);
    expect(await readAcceptedEvents(project.root)).toEqual([first, second]);
    expect((await inspectEventLog(project.root)).orphanSegments).toEqual([]);
  });

  it("rejects truncated accepted JSONL even when its JSON remains parseable", async () => {
    const project = await makeProject();
    const appended = await appendEvent(project.root, testEvent(project, 1));
    const segmentPath = join(project.root, appended.segmentPath);
    const complete = await readFile(segmentPath, "utf8");
    await writeFile(segmentPath, complete.slice(0, -1));

    const report = await verifyEventLog(project.root);
    expect(report.valid).toBe(false);
    expect(report.issues).toContainEqual(
      expect.objectContaining({ code: "SEGMENT_TRUNCATED", severity: "error" }),
    );
    await expect(readAcceptedEvents(project.root)).rejects.toBeInstanceOf(
      EventLogIntegrityError,
    );
  });

  it("reports malformed JSON in an accepted segment", async () => {
    const project = await makeProject();
    const appended = await appendEvent(project.root, testEvent(project, 1));
    await writeFile(join(project.root, appended.segmentPath), "{not-json}\n");

    const report = await verifyEventLog(project.root);
    expect(report.valid).toBe(false);
    expect(report.issues).toContainEqual(
      expect.objectContaining({ code: "SEGMENT_JSON_INVALID", severity: "error" }),
    );
  });

  it("requires the next contiguous monotonic sequence and preserves accepted history", async () => {
    const project = await makeProject();
    const first = testEvent(project, 1);
    await appendEvent(project.root, first);

    for (const invalidSequence of [1, 3]) {
      await expect(
        appendEvent(project.root, testEvent(project, invalidSequence)),
      ).rejects.toMatchObject({
        issues: [expect.objectContaining({ code: "EVENT_SEQUENCE_NON_MONOTONIC" })],
      });
    }

    expect(await readAcceptedEvents(project.root)).toEqual([first]);
    expect((await readdir(join(project.root, "events"))).filter((name) => name.endsWith(".jsonl")))
      .toEqual(["00000001-00000001.jsonl"]);
  });

  it("rejects a schema-valid event whose canonical hash was altered", async () => {
    const project = await makeProject();
    const event = testEvent(project, 1);
    const tampered = {
      ...event,
      eventHash: `sha256:${"0".repeat(64)}`,
    };

    await expect(appendEvent(project.root, tampered)).rejects.toMatchObject({
      issues: [expect.objectContaining({ code: "EVENT_HASH_MISMATCH" })],
    });
    expect(await readAcceptedEvents(project.root)).toEqual([]);
  });

  it("can read the temporary project.json manifest name without changing semantics", async () => {
    const project = await makeProject("project.json");
    const event = testEvent(project, 1);

    await appendEvent(project.root, event);

    expect(await readAcceptedEvents(project.root)).toEqual([event]);
    await expect(readFile(join(project.root, "reasoning-project.json"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
