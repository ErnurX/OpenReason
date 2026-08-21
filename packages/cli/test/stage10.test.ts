import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runCli, type CliIo } from "../src/index.js";

function capturedIo(): { io: CliIo; text: () => string } {
  const stdout: string[] = [];
  return {
    io: { stdout: (text) => stdout.push(text), stderr: () => undefined },
    text: () => stdout.join(""),
  };
}

describe("Stage 10 CLI", () => {
  const sandboxes: string[] = [];

  afterEach(async () => {
    await Promise.all(sandboxes.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("lists packs/templates and reports built-in adapter conformance", async () => {
    const packs = capturedIo();
    expect(await runCli(["domain", "packs"], packs.io)).toBe(0);
    expect((JSON.parse(packs.text()) as Array<{ packId: string }>).map((pack) => pack.packId)).toEqual([
      "computational-reasoning",
      "pure-mathematics",
      "theoretical-physics",
    ]);

    const templates = capturedIo();
    expect(await runCli(["domain", "templates", "--pack", "pure-mathematics"], templates.io)).toBe(0);
    expect((JSON.parse(templates.text()) as Array<{ templateId: string }>).map((template) => template.templateId))
      .toEqual(["theorem-investigation", "conjecture-exploration", "formalization-project"]);

    const conformance = capturedIo();
    expect(await runCli(["domain", "conformance", "theoretical-physics"], conformance.io)).toBe(0);
    expect(JSON.parse(conformance.text())).toMatchObject({ packId: "theoretical-physics", passed: true });
  });

  it("creates, evaluates, and exports the RP-002 research package", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "rw-stage10-cli-"));
    sandboxes.push(sandbox);
    const projectRoot = join(sandbox, "rp002");
    const packageRoot = join(sandbox, "rp002-package");

    const create = capturedIo();
    expect(await runCli(["reference", "create", projectRoot, "RP-002"], create.io)).toBe(0);
    expect(JSON.parse(create.text())).toMatchObject({ referenceId: "RP-002" });

    const evaluate = capturedIo();
    expect(await runCli(["reference", "evaluate", projectRoot, "RP-002"], evaluate.io)).toBe(0);
    expect(JSON.parse(evaluate.text())).toMatchObject({ referenceId: "RP-002", passed: true });

    const build = capturedIo();
    expect(await runCli([
      "research-package", "build", projectRoot, packageRoot,
      "--reference", "RP-002",
    ], build.io)).toBe(0);
    expect(JSON.parse(build.text())).toMatchObject({
      destinationRoot: packageRoot,
      manifest: { referenceId: "RP-002", acceptance: { passed: true } },
    });
  }, 15_000);
});
