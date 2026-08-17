import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runCli, type CliIo } from "../src/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function ioCapture(): CliIo & { text(): string } {
  const output: string[] = [];
  return {
    stdout: (text) => output.push(text),
    stderr: (text) => {
      throw new Error(`Unexpected stderr: ${text}`);
    },
    text: () => output.join(""),
  };
}

async function json(args: readonly string[]): Promise<Record<string, unknown>> {
  const io = ioCapture();
  await expect(runCli(args, io)).resolves.toBe(0);
  return JSON.parse(io.text()) as Record<string, unknown>;
}

function nested(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} is not an object`);
  }
  return value as Record<string, unknown>;
}

describe("Stage 7 CLI", () => {
  it("promotes evidence, authors and renders a live paper, reports impact, and compares semantics", async () => {
    const root = await mkdtemp(join(tmpdir(), "rw-cli-stage7-"));
    roots.push(root);
    const projectRoot = join(root, "project");
    const fixture = await json(["fixture", "rp001", projectRoot]);
    const contextId = String(fixture.contextId);
    const assumption = await json([
      "object", "put", projectRoot,
      "--type", "assumption",
      "--content", JSON.stringify({
        statement: "0 <= n <= 39",
        contextId,
      }),
    ]);
    const claim = await json([
      "object", "put", projectRoot,
      "--type", "claim",
      "--content", JSON.stringify({
        statement: "p(n) is prime for 0 <= n <= 39",
        contextId,
        proofStatus: "computed",
      }),
    ]);
    const run = await json([
      "object", "put", projectRoot,
      "--type", "run",
      "--content", JSON.stringify({ kind: "enumeration", status: "succeeded" }),
    ]);
    const environment = await json([
      "object", "put", projectRoot,
      "--type", "environment",
      "--content", JSON.stringify({ python: "3.13" }),
    ]);
    const dataPath = join(root, "range.csv");
    await writeFile(dataPath, "n,p,prime\n0,41,true\n39,1601,true\n", "utf8");
    const artifactResult = await json([
      "artifact", "add", projectRoot, dataPath,
      "--media-type", "text/csv",
      "--name", "range.csv",
      "--run-id", String(run.objectId),
      "--environment-id", String(environment.objectId),
    ]);
    const artifact = nested(artifactResult.artifact, "artifact");
    const promoted = await json([
      "evidence", "promote", projectRoot,
      "--claim", String(claim.objectId),
      "--context", contextId,
      "--artifact", String(artifact.artifactId),
      "--dimension", "numerical",
      "--outcome", "passed",
      "--summary", "The complete finite range was enumerated.",
    ]);
    const evidence = nested(promoted.evidence, "evidence");
    const reviewResult = await json([
      "review", "record", projectRoot,
      "--claim", String(claim.objectId),
      "--context", contextId,
      "--outcome", "passed",
      "--summary", "The reviewer accepted the finite scope, not a universal claim.",
    ]);
    const review = nested(reviewResult.review, "review");
    await json([
      "edge", "add", projectRoot,
      "--type", "depends_on",
      "--from", String(claim.objectId),
      "--to", String(assumption.objectId),
      "--context", contextId,
    ]);
    const paperPath = join(root, "paper.json");
    await writeFile(paperPath, JSON.stringify({
      schemaVersion: 1,
      kind: "working-paper",
      title: "Euler range",
      context: { objectId: contextId },
      sections: [{
        sectionId: "result",
        title: "Result",
        annotations: [{
          annotationId: "scope",
          kind: "warning",
          text: "This is a finite statement.",
          references: [{ objectId: String(assumption.objectId) }],
        }],
        blocks: [
          {
            blockId: "claim",
            kind: "transclusion",
            reference: { objectId: String(claim.objectId), field: "statement" },
          },
          {
            blockId: "evidence",
            kind: "transclusion",
            reference: { objectId: String(evidence.objectId) },
          },
          {
            blockId: "review",
            kind: "transclusion",
            reference: { objectId: String(review.objectId) },
          },
          {
            blockId: "data",
            kind: "artifact",
            artifact: { artifactId: String(artifact.artifactId) },
            role: "dataset",
            caption: "Complete range",
          },
        ],
      }],
    }), "utf8");
    const paper = await json([
      "paper", "put", projectRoot,
      "--paper-file", paperPath,
    ]);
    const paperId = String(paper.objectId);

    const rendered = await json(["paper", "render", projectRoot, paperId]);
    expect(rendered).toMatchObject({
      paperId,
      text: expect.stringContaining("p(n) is prime for 0 <= n <= 39"),
      references: expect.arrayContaining([
        expect.objectContaining({ objectId: claim.objectId, status: "current" }),
      ]),
    });
    expect(await json([
      "paper", "render", projectRoot, paperId, "--format", "latex",
    ])).toMatchObject({
      format: "latex",
      text: expect.stringContaining("\\documentclass{article}"),
    });
    expect(await json([
      "verification", "profile", projectRoot, String(claim.objectId),
      "--context", contextId,
    ])).toMatchObject({
      dimensions: expect.arrayContaining([
        expect.objectContaining({ dimension: "numerical", status: "supported" }),
        expect.objectContaining({ dimension: "human-review", status: "supported" }),
        expect.objectContaining({ dimension: "formal", status: "missing" }),
      ]),
    });

    await json([
      "object", "put", projectRoot,
      "--type", "assumption",
      "--object-id", String(assumption.objectId),
      "--content", JSON.stringify({ statement: "0 <= n < 40", contextId }),
    ]);
    const impact = await json([
      "paper", "impact", projectRoot, paperId,
      "--changed", String(assumption.objectId),
    ]);
    expect(impact).toMatchObject({
      affectedSections: [expect.objectContaining({
        sectionId: "result",
        warnings: expect.arrayContaining([
          expect.objectContaining({ code: "stale-dependency", objectId: claim.objectId }),
          expect.objectContaining({ code: "stale-evidence", objectId: evidence.objectId }),
          expect.objectContaining({ code: "stale-review", objectId: review.objectId }),
        ]),
      })],
    });

    const child = await json([
      "branch", "create", projectRoot, "counterexample", "--from", "main",
    ]);
    await json([
      "object", "put", projectRoot,
      "--branch", String(child.branchId),
      "--type", "claim",
      "--object-id", String(claim.objectId),
      "--content", JSON.stringify({
        statement: "p(40)=41^2 is composite",
        contextId,
        proofStatus: "refuted-boundary",
      }),
    ]);
    const semantic = await json([
      "branch", "semantic-diff", projectRoot, String(child.branchId), "main",
    ]);
    expect(nested(semantic.byCategory, "byCategory").statement).toEqual([claim.objectId]);
    expect(semantic.proofStatusChanges).toEqual([claim.objectId]);
    expect((await json(["verify", projectRoot])).ok).toBe(true);
  });
});
