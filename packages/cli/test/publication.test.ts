import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createId } from "@reasoning-workbench/project-format";
import { afterEach, describe, expect, it } from "vitest";

import { runCli, type CliIo } from "../src/index.js";

function capturedIo(): { io: CliIo; text: () => string } {
  const stdout: string[] = [];
  return { io: { stdout: (text) => stdout.push(text), stderr: () => undefined }, text: () => stdout.join("") };
}

describe("publication CLI", () => {
  const sandboxes: string[] = [];

  afterEach(async () => {
    await Promise.all(sandboxes.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("records local attribution, checks, builds, inspects, and clean-checks a derived RP-002 release", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "rw-publication-cli-"));
    sandboxes.push(sandbox);
    const projectRoot = join(sandbox, "project");
    const releaseRoot = join(sandbox, "release");
    expect(await runCli(["reference", "create", projectRoot, "RP-002"], capturedIo().io)).toBe(0);

    const blocked = capturedIo();
    expect(await runCli(["publication", "check", projectRoot, "--reference", "RP-002"], blocked.io)).toBe(2);

    expect(await runCli([
      "publication", "attribute", projectRoot, "--label", "CLI review", "--actor-id", createId("hum"),
    ], capturedIo().io)).toBe(0);
    expect(await runCli(["publication", "check", projectRoot, "--reference", "RP-002"], capturedIo().io)).toBe(0);
    expect(await runCli(["publication", "build", projectRoot, releaseRoot, "--reference", "RP-002"], capturedIo().io)).toBe(0);
    expect(await runCli(["publication", "inspect", releaseRoot], capturedIo().io)).toBe(0);
    expect(await runCli(["publication", "reproduce", releaseRoot], capturedIo().io)).toBe(0);
  }, 60_000);
});
