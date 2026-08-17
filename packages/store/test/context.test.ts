import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  canonicalJson,
  createEvent,
  createId,
  createObjectVersion,
  sha256Digest,
  type Event,
} from "@reasoning-workbench/project-format";
import { afterEach, describe, expect, it } from "vitest";

import {
  CONTEXT_BUNDLE_SCHEMA_VERSION,
  compileContext,
} from "../src/context.js";
import {
  addEdge,
  createBranch,
  createProject,
  createRp001Fixture,
  loadManifest,
  projectHistory,
  putObject,
} from "../src/project.js";
import { rebuildProjection } from "../src/projection.js";

describe("deterministic context compiler", () => {
  const sandboxes: string[] = [];

  async function newProjectRoot(label: string): Promise<string> {
    const sandbox = await mkdtemp(join(tmpdir(), `rw-context-${label}-`));
    sandboxes.push(sandbox);
    return join(sandbox, "project");
  }

  afterEach(async () => {
    await Promise.all(
      sandboxes.splice(0).map((sandbox) =>
        rm(sandbox, { recursive: true, force: true }),
      ),
    );
  });

  it("compiles RP-001 deterministically with stable exact back-references and hard bounds", async () => {
    const projectRoot = await newProjectRoot("rp001");
    const fixture = await createRp001Fixture(projectRoot);
    const branchId = fixture.project.manifest.defaultBranchId;
    const before = await projectHistory(projectRoot);

    const options = {
      branchId,
      goalId: fixture.goal.objectId,
      query: "first composite polynomial and skeptical review",
      maxCharacters: 1_200,
      maxEntries: 5,
    } as const;
    const first = compileContext(projectRoot, options);
    const second = compileContext(projectRoot, options);

    expect(first).toEqual(second);
    expect(first.schemaVersion).toBe(CONTEXT_BUNDLE_SCHEMA_VERSION);
    expect(first.usedCharacters).toBe(first.promptText.length);
    expect(first.usedCharacters).toBeLessThanOrEqual(options.maxCharacters);
    expect(first.entries.length).toBeLessThanOrEqual(options.maxEntries);
    expect(first.estimatedTokens).toBe(Math.ceil(first.usedCharacters / 4));
    expect(first.entries[0]).toMatchObject({
      objectId: fixture.goal.objectId,
      versionId: fixture.goal.versionId,
      contentHash: fixture.goal.contentHash,
      selectionReason: "goal",
      depth: 0,
    });
    for (const entry of first.entries) {
      expect(first.promptText.slice(entry.promptSpan.start, entry.promptSpan.end)).toBe(
        entry.text,
      );
      expect(entry.text).toContain(`[object:${entry.objectId}@${entry.versionId}]`);
    }

    const { digest: _digest, ...digestible } = first;
    expect(first.digest).toBe(sha256Digest(canonicalJson(digestible)));
    expect(first.omittedEntryCount).toBe(first.omittedObjectIds.length);
    expect(await projectHistory(projectRoot)).toEqual(before);

    const filtered = compileContext(projectRoot, {
      ...options,
      includeObjectTypes: ["failure"],
    });
    expect(filtered.entries.map((entry) => entry.objectId)).toEqual([
      fixture.goal.objectId,
    ]);
  });

  it("reserves relevant open failures as negative context and excludes closed failures", async () => {
    const projectRoot = await newProjectRoot("failure");
    const project = await createProject(projectRoot, { title: "Failure context" });
    const branchId = project.manifest.defaultBranchId;
    const goal = await putObject(projectRoot, {
      branchId,
      objectType: "goal",
      content: { statement: "Find a primality proof strategy" },
    });
    const openFailure = await putObject(projectRoot, {
      branchId,
      objectType: "failure",
      content: {
        status: "open",
        attemptedStrategy: "primality proof by checking finitely many examples",
        blocker: "finite enumeration cannot prove the universal statement",
      },
    });
    const closedFailure = await putObject(projectRoot, {
      branchId,
      objectType: "failure",
      content: {
        status: "resolved",
        attemptedStrategy: "primality proof by checking finitely many examples",
      },
    });

    const bundle = compileContext(projectRoot, {
      branchId,
      goalId: goal.objectId,
      query: "try a primality proof by checking finitely many examples",
      maxCharacters: 2_000,
      maxEntries: 2,
    });

    expect(bundle.entries.map((entry) => entry.objectId)).toEqual([
      goal.objectId,
      openFailure.objectId,
    ]);
    expect(bundle.entries[1]?.selectionReason).toBe("negative-context");
    expect(bundle.promptText).toContain("finite enumeration cannot prove");
    expect(bundle.entries.some((entry) => entry.objectId === closedFailure.objectId)).toBe(
      false,
    );
  });

  it("uses only current branch versions, isolates branches, and redacts secret-like keys", async () => {
    const projectRoot = await newProjectRoot("branch");
    const project = await createProject(projectRoot, { title: "Scoped context" });
    const mainBranchId = project.manifest.defaultBranchId;
    const goal = await putObject(projectRoot, {
      branchId: mainBranchId,
      objectType: "goal",
      content: { statement: "Assess the lattice strategy and credentials handling" },
    });
    const claimV1 = await putObject(projectRoot, {
      branchId: mainBranchId,
      objectType: "claim",
      content: { statement: "The old lattice statement" },
    });
    await addEdge(projectRoot, {
      branchId: mainBranchId,
      edgeType: "supports",
      fromObjectId: claimV1.objectId,
      toObjectId: goal.objectId,
    });
    const claimV2 = await putObject(projectRoot, {
      branchId: mainBranchId,
      objectId: claimV1.objectId,
      objectType: "claim",
      content: {
        statement: "The corrected lattice statement",
        apiKey: "sk-do-not-expose",
        nested: {
          authorization: "Bearer private-value",
          harmless: "retained; password=hunter2",
        },
      },
    });
    const child = await createBranch(projectRoot, {
      name: "private-child",
      baseBranchId: mainBranchId,
    });
    const childOnly = await putObject(projectRoot, {
      branchId: child.branchId,
      objectType: "claim",
      content: { statement: "child-only lattice conclusion" },
    });

    const main = compileContext(projectRoot, {
      branchId: mainBranchId,
      goalId: goal.objectId,
      query: "lattice credentials token=query-secret",
      maxCharacters: 2_000,
      maxEntries: 5,
    });

    const currentClaim = main.entries.find((entry) => entry.objectId === claimV1.objectId);
    expect(currentClaim?.versionId).toBe(claimV2.versionId);
    expect(currentClaim?.contentHash).toBe(claimV2.contentHash);
    expect(main.promptText).toContain("corrected lattice statement");
    expect(main.promptText).not.toContain("old lattice statement");
    expect(main.promptText).not.toContain("sk-do-not-expose");
    expect(main.promptText).not.toContain("Bearer private-value");
    expect(main.promptText).not.toContain("hunter2");
    expect(main.promptText).not.toContain("query-secret");
    expect(main.query).toBe("lattice credentials token=[REDACTED]");
    expect(main.promptText).toContain("[REDACTED]");
    expect(main.promptText).toContain("retained");
    expect(main.entries.some((entry) => entry.objectId === childOnly.objectId)).toBe(false);

    const childBundle = compileContext(projectRoot, {
      branchId: child.branchId,
      goalId: goal.objectId,
      query: "child-only lattice conclusion",
      maxCharacters: 2_000,
      maxEntries: 5,
    });
    expect(childBundle.entries.some((entry) => entry.objectId === childOnly.objectId)).toBe(
      true,
    );
  });

  it("rejects a goal that is absent or not a goal on the selected branch", async () => {
    const projectRoot = await newProjectRoot("goal");
    const project = await createProject(projectRoot, { title: "Goal validation" });
    const branchId = project.manifest.defaultBranchId;
    const claim = await putObject(projectRoot, {
      branchId,
      objectType: "claim",
      content: { statement: "Not a goal" },
    });

    expect(() =>
      compileContext(projectRoot, {
        branchId,
        goalId: claim.objectId,
        maxCharacters: 500,
        maxEntries: 2,
      }),
    ).toThrow(`Goal ${claim.objectId} is not visible on branch ${branchId}`);
  });

  it(
    "selects a deterministic bounded context from a synthetic 1,000-claim project without embeddings",
    async () => {
      const projectRoot = await newProjectRoot("scale");
      const project = await createProject(projectRoot, { title: "Large lexical corpus" });
      const branchId = project.manifest.defaultBranchId;
      const goal = await putObject(projectRoot, {
        branchId,
        objectType: "goal",
        content: { statement: "Find the relevant proposition in a large corpus" },
      });
      // One accepted JSONL segment keeps setup linear and mirrors the portable
      // canonical format without paying 1,000 intermediate projection rebuilds.
      const manifest = await loadManifest(projectRoot);
      const history = await projectHistory(projectRoot);
      const actor = {
        actorType: "system" as const,
        actorId: createId("sys"),
      };
      const events: Event[] = [];
      let previous = history.at(-1);
      for (let index = 0; index < 1_000; index += 1) {
        const object = createObjectVersion({
          branchId,
          objectType: "claim",
          createdBy: actor,
          content: {
            statement: `Background proposition ${index}`,
            ...(index === 731 ? { marker: "needle-result" } : {}),
          },
        });
        const event = createEvent({
          sequence: (previous?.sequence ?? 0) + 1,
          eventType: "ObjectVersionCreated",
          projectId: manifest.projectId,
          branchId,
          actor,
          payload: { object },
          ...(previous === undefined ? {} : { previousEventHash: previous.eventHash }),
        });
        events.push(event);
        previous = event;
      }
      const firstSequence = events[0]?.sequence;
      const lastSequence = events.at(-1)?.sequence;
      if (firstSequence === undefined || lastSequence === undefined) {
        throw new Error("Synthetic event segment was unexpectedly empty");
      }
      const segmentPath = `events/${String(firstSequence).padStart(8, "0")}-${String(lastSequence).padStart(8, "0")}.jsonl`;
      await writeFile(
        join(projectRoot, segmentPath),
        `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
        "utf8",
      );
      await writeFile(
        join(projectRoot, "reasoning-project.json"),
        `${JSON.stringify(
          { ...manifest, eventSegments: [...manifest.eventSegments, segmentPath] },
          null,
          2,
        )}\n`,
        "utf8",
      );
      await rebuildProjection(projectRoot);

      const options = {
        branchId,
        goalId: goal.objectId,
        query: "background proposition needle-result",
        maxCharacters: 900,
        maxEntries: 8,
      } as const;
      const first = compileContext(projectRoot, options);
      const second = compileContext(projectRoot, options);

      expect(second).toEqual(first);
      expect(first.entries).toHaveLength(options.maxEntries);
      expect(first.usedCharacters).toBeLessThanOrEqual(options.maxCharacters);
      expect(first.promptText).toContain("needle-result");
      expect(first.omittedEntryCount).toBeGreaterThan(900);
    },
    30_000,
  );
});
