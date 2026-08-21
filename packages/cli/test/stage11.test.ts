import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createId, type Actor } from "@reasoning-workbench/project-format";
import { bootstrapProjectOwner, createProject } from "@reasoning-workbench/store";
import { afterEach, describe, expect, it } from "vitest";

import { runCli, type CliIo } from "../src/index.js";

function human(): Actor {
  return { actorType: "human", actorId: createId("usr") };
}

function capture(): { io: CliIo; text: () => string } {
  const stdout: string[] = [];
  return {
    io: { stdout: (text) => stdout.push(text), stderr: () => undefined },
    text: () => stdout.join(""),
  };
}

describe("Stage 11 collaboration CLI", () => {
  const sandboxes: string[] = [];

  afterEach(async () => {
    await Promise.all(sandboxes.splice(0).map((sandbox) => rm(sandbox, { recursive: true, force: true })));
  });

  it("replays authorized collaboration state rather than exposing raw audit reads", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "rw-stage11-cli-"));
    sandboxes.push(sandbox);
    const root = join(sandbox, "project");
    const owner = human();
    await createProject(root, { title: "CLI collaboration replay" });
    await bootstrapProjectOwner(root, owner);

    const replay = capture();
    expect(await runCli(["collab", "replay", root, "--actor", owner.actorId], replay.io)).toBe(0);
    expect(JSON.parse(replay.text())).toMatchObject({
      actor: owner,
      membership: { role: "owner" },
      memberships: [expect.objectContaining({ actor: owner, role: "owner" })],
      reviews: [],
    });

    const rawRead = capture();
    await expect(runCli(["collab", "members", root], rawRead.io)).rejects.toThrow("Missing required option --actor");
  });
});
