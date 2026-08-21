import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createRp001Fixture } from "@reasoning-workbench/store";

import { runCli, type CliIo } from "../src/index.js";

function capturedIo(): { io: CliIo; text: () => string } {
  const stdout: string[] = [];
  return {
    io: { stdout: (text) => stdout.push(text), stderr: () => undefined },
    text: () => stdout.join(""),
  };
}

describe("Stage 9 CLI", () => {
  const sandboxes: string[] = [];

  afterEach(async () => {
    await Promise.all(sandboxes.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("ingests, searches, and opens the exact RP-001 theorem anchor", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "rw-stage9-cli-"));
    sandboxes.push(sandbox);
    const root = join(sandbox, "project");
    await createRp001Fixture(root);
    const sourcePath = join(sandbox, "rp001.tex");
    const metadataPath = join(sandbox, "metadata.json");
    await writeFile(sourcePath, String.raw`\section{Finite range}
\begin{theorem}[Euler-39]
For every integer n with 0 <= n <= 39, n^2+n+41 is prime.
\end{theorem}
`, "utf8");
    await writeFile(metadataPath, JSON.stringify({
      title: "RP-001 finite theorem",
      authors: ["Reference Author"],
      year: 2025,
      identifiers: { doi: "10.0000/rp001" },
    }), "utf8");

    const ingest = capturedIo();
    expect(await runCli([
      "literature", "ingest", root, sourcePath,
      "--metadata-file", metadataPath,
    ], ingest.io)).toBe(0);
    const sourceId = JSON.parse(ingest.text()).source.objectId as string;

    const search = capturedIo();
    expect(await runCli([
      "literature", "search", root,
      "--query", "Euler prime polynomial",
      "--anchor-kind", "theorem",
    ], search.io)).toBe(0);
    const results = JSON.parse(search.text()) as Array<Record<string, unknown>>;
    expect(results[0]).toMatchObject({ sourceId, anchorKind: "theorem", reviewState: "unreviewed" });

    const open = capturedIo();
    expect(await runCli([
      "literature", "open", root, sourceId, String(results[0]!.anchorId),
    ], open.io)).toBe(0);
    expect(JSON.parse(open.text())).toMatchObject({
      sourceId,
      anchor: { anchorId: results[0]!.anchorId, extractionState: "machine-proposed" },
    });
  });

  it("does not authorize live catalog access without an explicit network flag", async () => {
    const output = capturedIo();
    await expect(runCli([
      "literature", "catalog-search", "--query", "Euler polynomial",
    ], output.io)).rejects.toThrow("explicit allow-list");
  });
});
