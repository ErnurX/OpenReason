import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  createEvent,
  createId,
  utcNow,
  ProjectManifestSchema,
  type Event,
} from "@reasoning-workbench/project-format";

import { appendEvent, initializeEventLog, readAcceptedEvents } from "../src/event-log.js";
import { cleanupProject } from "../src/cleanup.js";

const TEST_TIME = Date.UTC(2026, 7, 14, 0, 0, 0);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeTestProject() {
  const root = join(
    tmpdir(),
    `reasoning-workbench-cleanup-${process.pid}-${createId("tmp", TEST_TIME)}`,
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
    title: "Cleanup test project",
    createdAt: utcNow(TEST_TIME),
    defaultBranchId: branchId,
    eventSegments: [],
    hashAlgorithm: "sha256",
  });
  await writeFile(join(root, "reasoning-project.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  return { root, projectId, branchId, actorId };
}

function sampleEvent(project: { projectId: string; branchId: string; actorId: string }, sequence = 1): Event {
  return createEvent({
    sequence,
    eventId: createId("evt", TEST_TIME),
    eventType: "TestObservationRecorded",
    occurredAt: utcNow(TEST_TIME + sequence),
    projectId: project.projectId,
    branchId: project.branchId,
    actor: { actorType: "human", actorId: project.actorId },
    schemaVersion: 1,
    payload: { sequence },
  });
}

describe("project cleanup service", () => {
  it("removes staging files in events and .reasoning directories without touching accepted segments", async () => {
    const project = await makeTestProject();
    await initializeEventLog(project.root);

    const event = sampleEvent(project, 1);
    await appendEvent(project.root, event);

    // Create orphaned staging files
    const eventStaging = join(project.root, "events", "00000002-00000002.jsonl.tmp-test123");
    await writeFile(eventStaging, '{"temp": true}\n');

    const reasoningStaging = join(project.root, ".reasoning", "state.sqlite.tmp-test456");
    await writeFile(reasoningStaging, 'temp sqlite data');

    // Dry run check
    const dryReport = await cleanupProject(project.root, { dryRun: true });
    expect(dryReport.dryRun).toBe(true);
    expect(dryReport.stagingFilesRemoved).toContain("events/00000002-00000002.jsonl.tmp-test123");
    expect(dryReport.stagingFilesRemoved).toContain(".reasoning/state.sqlite.tmp-test456");
    expect(dryReport.totalFilesRemoved).toBe(2);

    // Files should still exist after dry run
    expect(await readdir(join(project.root, "events"))).toContain("00000002-00000002.jsonl.tmp-test123");

    // Real cleanup run
    const realReport = await cleanupProject(project.root, { dryRun: false });
    expect(realReport.dryRun).toBe(false);
    expect(realReport.totalFilesRemoved).toBe(2);

    // Staging files should now be removed
    const eventFiles = await readdir(join(project.root, "events"));
    expect(eventFiles).toEqual(["00000001-00000001.jsonl"]);

    // Accepted events remain readable and valid
    expect(await readAcceptedEvents(project.root)).toEqual([event]);
  });

  it("removes stale lock files left from terminated processes", async () => {
    const project = await makeTestProject();
    await initializeEventLog(project.root);

    const lockPath = join(project.root, ".reasoning", "event-log.lock");
    // Write lock with a dead PID (pid: 99999999)
    await writeFile(
      lockPath,
      JSON.stringify({
        token: "dead-token",
        pid: 99999999,
        hostname: "localhost",
        createdAt: new Date(Date.now() - 60000).toISOString(),
      }),
    );

    const report = await cleanupProject(project.root, { staleLockMs: 1000 });
    expect(report.staleLocksRemoved).toEqual([".reasoning/event-log.lock"]);
    expect(report.totalFilesRemoved).toBe(1);

    const entries = await readdir(join(project.root, ".reasoning"));
    expect(entries).not.toContain("event-log.lock");
  });

  it("removes orphan segments when explicitly requested", async () => {
    const project = await makeTestProject();
    await initializeEventLog(project.root);

    const event = sampleEvent(project, 1);
    await appendEvent(project.root, event);

    // Create an unaccepted orphan segment
    const orphanPath = join(project.root, "events", "00000099-00000099.jsonl");
    await writeFile(orphanPath, '{"orphan": true}\n');

    // Default cleanup leaves orphan segments intact
    const reportDefault = await cleanupProject(project.root, { removeOrphanSegments: false });
    expect(reportDefault.orphanSegmentsRemoved).toEqual([]);
    expect(await readdir(join(project.root, "events"))).toContain("00000099-00000099.jsonl");

    // Explicit cleanup removes orphan segments
    const reportOrphans = await cleanupProject(project.root, { removeOrphanSegments: true });
    expect(reportOrphans.orphanSegmentsRemoved).toEqual(["events/00000099-00000099.jsonl"]);
    expect(await readdir(join(project.root, "events"))).toEqual(["00000001-00000001.jsonl"]);
  });
});
