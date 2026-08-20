import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createRp001Fixture,
  putObject,
  registerArtifactBytes,
} from "@reasoning-workbench/store";

import { runCli, type CliIo } from "../src/index.js";

function capturedIo(): { io: CliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: { stdout: (text) => stdout.push(text), stderr: (text) => stderr.push(text) },
  };
}

describe("Stage 8 CLI", () => {
  const sandboxes: string[] = [];

  afterEach(async () => {
    await Promise.all(
      sandboxes.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  it("lists verifier trust levels and verifies an RP-001 artifact with exact lineage", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "rw-stage8-cli-"));
    sandboxes.push(sandbox);
    const root = join(sandbox, "project");
    const fixture = await createRp001Fixture(root);
    const branchId = fixture.project.manifest.defaultBranchId;
    const claim = await putObject(root, {
      branchId,
      objectType: "claim",
      content: {
        statement: "n²+n+41 is prime for 0 <= n <= 39",
        contextId: fixture.context.objectId,
      },
    });
    const producer = await putObject(root, {
      branchId,
      objectType: "run",
      content: { kind: "enumeration", status: "succeeded" },
    });
    const environment = await putObject(root, {
      branchId,
      objectType: "environment",
      content: { kind: "execution-environment", runtime: "test" },
    });
    const artifact = await registerArtifactBytes(root, new TextEncoder().encode("39,1601,true\n"), {
      branchId,
      logicalName: "rp001.csv",
      mediaType: "text/csv",
      producedByRunId: producer.objectId,
      environmentId: environment.objectId,
    });

    const list = capturedIo();
    expect(await runCli(["verification", "list", "--human"], list.io)).toBe(0);
    expect(list.stdout.join("")).toContain("core.artifact-integrity");
    expect(list.stdout.join("")).toContain("formal/reported");

    const run = capturedIo();
    expect(await runCli([
      "verification",
      "run",
      root,
      "--claim",
      claim.objectId,
      "--context",
      fixture.context.objectId,
      "--verifier",
      "core.artifact-integrity",
      "--input",
      JSON.stringify({ artifactIds: [artifact.artifact.artifactId] }),
      "--artifact",
      artifact.artifact.artifactId,
    ], run.io)).toBe(0);
    const result = JSON.parse(run.stdout.join("")) as Record<string, any>;
    expect(result.result.outcome).toBe("passed");
    expect(result.evidence.content).toMatchObject({
      dimension: "reproducibility",
      assurance: "machine-checked",
    });

    const profile = capturedIo();
    expect(await runCli([
      "verification",
      "profile",
      root,
      claim.objectId,
      "--context",
      fixture.context.objectId,
      "--human",
    ], profile.io)).toBe(0);
    expect(profile.stdout.join("")).toContain("reproducibility");
    expect(profile.stdout.join("")).toContain("SUPPORTED");
  });
});
