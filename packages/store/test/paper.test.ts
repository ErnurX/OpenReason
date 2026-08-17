import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ObjectEnvelope } from "@reasoning-workbench/project-format";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  addEdge,
  analyzeWorkingPaperImpact,
  compareResearchBranches,
  createBranch,
  createRp001Fixture,
  deriveVerificationProfile,
  FileSystemArtifactStore,
  getWorkingPaper,
  inspectWorkingPaper,
  listVisibleArtifacts,
  promoteArtifactToEvidence,
  putObject,
  putWorkingPaper,
  recordVerificationReview,
  registerArtifactBytes,
  renderWorkingPaper,
  verifyProject,
} from "../src/index.js";

interface Stage7Fixture {
  root: string;
  branchId: string;
  context: ObjectEnvelope;
  assumption: ObjectEnvelope;
  claim: ObjectEnvelope;
  run: ObjectEnvelope;
  environment: ObjectEnvelope;
  review: ObjectEnvelope;
  source: ObjectEnvelope;
  artifactId: string;
  evidence: ObjectEnvelope;
  paper: ObjectEnvelope;
}

async function stage7Fixture(root: string): Promise<Stage7Fixture> {
  const rp001 = await createRp001Fixture(root);
  const branchId = rp001.project.manifest.defaultBranchId;
  const context = rp001.context;
  const assumption = await putObject(root, {
    branchId,
    objectType: "assumption",
    content: {
      statement: "n is an integer with 0 <= n <= 39",
      contextId: context.objectId,
    },
  });
  const claim = await putObject(root, {
    branchId,
    objectType: "claim",
    content: {
      reference: "RP-001-C01",
      statement: "p(n) is prime for every integer 0 <= n <= 39",
      contextId: context.objectId,
      proofStatus: "computationally-supported",
      modelConfidence: 0.99,
    },
  });
  const run = await putObject(root, {
    branchId,
    objectType: "run",
    content: { kind: "enumeration", status: "succeeded" },
  });
  const environment = await putObject(root, {
    branchId,
    objectType: "environment",
    content: { kind: "execution-environment", python: "3.13" },
  });
  const registered = await registerArtifactBytes(
    root,
    new TextEncoder().encode("n,p,prime\n0,41,true\n39,1601,true\n"),
    {
      branchId,
      logicalName: "euler-range.csv",
      mediaType: "text/csv",
      producedByRunId: run.objectId,
      environmentId: environment.objectId,
      reproducibility: "deterministic",
    },
  );
  const promoted = await promoteArtifactToEvidence(root, {
    branchId,
    claimId: claim.objectId,
    contextId: context.objectId,
    artifactId: registered.artifact.artifactId,
    dimension: "numerical",
    outcome: "passed",
    summary: "Complete enumeration over the stated finite range passed.",
  });
  const recordedReview = await recordVerificationReview(root, {
    branchId,
    claimId: claim.objectId,
    contextId: context.objectId,
    outcome: "passed",
    summary: "The finite range and the universal conjecture are distinct.",
  });
  const review = recordedReview.review;
  const source = await putObject(root, {
    branchId,
    objectType: "source",
    content: {
      title: "Euler polynomial computation note",
      authors: ["RP-001 fixture"],
    },
  });
  await addEdge(root, {
    branchId,
    edgeType: "depends_on",
    fromObjectId: claim.objectId,
    toObjectId: assumption.objectId,
    contextId: context.objectId,
  });
  await addEdge(root, {
    branchId,
    edgeType: "depends_on",
    fromObjectId: run.objectId,
    toObjectId: assumption.objectId,
    contextId: context.objectId,
  });

  const paper = await putWorkingPaper(root, {
    branchId,
    paper: {
      schemaVersion: 1,
      kind: "working-paper",
      title: "Euler polynomial: finite range",
      context: { objectId: context.objectId },
      sections: [
        {
          sectionId: "finite-range",
          title: "Finite prime-producing range",
          annotations: [
            {
              annotationId: "scope-note",
              kind: "warning",
              text: "Finite evidence does not establish universal primality.",
              references: [{ objectId: assumption.objectId }],
            },
          ],
          blocks: [
            {
              blockId: "motivation",
              kind: "markdown",
              text: "The observed pattern is finite and must be scoped carefully.",
            },
            {
              blockId: "claim-c01",
              kind: "transclusion",
              label: "RP-001-C01",
              reference: { objectId: claim.objectId, mode: "live", field: "statement" },
            },
            {
              blockId: "equation-p",
              kind: "equation",
              latex: "p(n)=n^2+n+41",
              label: "Polynomial",
            },
            {
              blockId: "enumeration-evidence",
              kind: "transclusion",
              reference: { objectId: promoted.evidence.objectId },
            },
            {
              blockId: "skeptical-review",
              kind: "transclusion",
              reference: { objectId: review.objectId },
            },
            {
              blockId: "range-table",
              kind: "artifact",
              artifact: { artifactId: registered.artifact.artifactId },
              role: "table",
              caption: "Complete checked range",
            },
            {
              blockId: "source-note",
              kind: "citation",
              source: { objectId: source.objectId },
              locator: "Table 1, rows n=0..39",
              text: "The complete enumeration is recorded in the project source note.",
            },
            {
              blockId: "open-proof-gap",
              kind: "gap",
              gapId: "gap-symbolic-proof",
              statement: "A symbolic proof for the finite range is optional but absent.",
              status: "open",
              related: [{ objectId: claim.objectId, mode: "pinned" }],
            },
            {
              blockId: "back-link",
              kind: "internal-link",
              targetSectionId: "finite-range",
              label: "Return to the result",
            },
          ],
        },
      ],
    },
  });
  return {
    root,
    branchId,
    context,
    assumption,
    claim,
    run,
    environment,
    review,
    source,
    artifactId: registered.artifact.artifactId,
    evidence: promoted.evidence,
    paper,
  };
}

describe("Stage 7 living working paper", () => {
  let sandboxRoot: string;
  let projectRoot: string;

  beforeEach(async () => {
    sandboxRoot = await mkdtemp(join(tmpdir(), "rw-paper-"));
    projectRoot = join(sandboxRoot, "project");
  });

  afterEach(async () => {
    await rm(sandboxRoot, { recursive: true, force: true });
  });

  it("renders deterministic transclusions, equations, annotations, gaps, and CAS artifacts with exact backrefs", async () => {
    const fixture = await stage7Fixture(projectRoot);
    const first = renderWorkingPaper(projectRoot, {
      branchId: fixture.branchId,
      paperId: fixture.paper.objectId,
    });
    const second = renderWorkingPaper(projectRoot, {
      branchId: fixture.branchId,
      paperId: fixture.paper.objectId,
    });
    const latex = renderWorkingPaper(projectRoot, {
      branchId: fixture.branchId,
      paperId: fixture.paper.objectId,
      format: "latex",
    });

    expect(second).toEqual(first);
    expect(latex.format).toBe("latex");
    expect(latex.text).toContain("\\documentclass{article}");
    expect(latex.text).toContain("\\begin{equation}");
    expect(latex.text).toContain("\\texttt{artifact:sha256:");
    expect(latex.digest).not.toBe(first.digest);
    expect(first.text).toContain("p(n) is prime for every integer 0 <= n <= 39");
    expect(first.text).toContain("p(n)=n^2+n+41");
    expect(first.text).toContain("Table 1, rows n=0..39");
    expect(first.text).toContain(`artifact:sha256:`);
    expect(first.text).toContain(fixture.claim.objectId);
    expect(first.references).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          objectId: fixture.claim.objectId,
          boundVersionId: fixture.claim.versionId,
          currentVersionId: fixture.claim.versionId,
          boundContextVersionId: fixture.context.versionId,
          currentContextVersionId: fixture.context.versionId,
          status: "current",
        }),
        expect.objectContaining({ objectId: fixture.evidence.objectId }),
        expect.objectContaining({ objectId: fixture.review.objectId }),
      ]),
    );
    expect(first.openGapIds).toEqual(["gap-symbolic-proof"]);
    expect(first.warnings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "open-gap" })]),
    );
    expect(first.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect((await listVisibleArtifacts(projectRoot, fixture.branchId))).toEqual([
      expect.objectContaining({ artifactId: fixture.artifactId }),
    ]);
    expect((await verifyProject(projectRoot)).ok).toBe(true);
  });

  it("keeps confidence separate from the evidence vector and makes exact-version evidence stale after claim revision", async () => {
    const fixture = await stage7Fixture(projectRoot);
    const initial = deriveVerificationProfile(projectRoot, {
      branchId: fixture.branchId,
      claimId: fixture.claim.objectId,
      contextId: fixture.context.objectId,
    });
    expect(initial.dimensions.find(({ dimension }) => dimension === "numerical")).toMatchObject({
      status: "supported",
      currentEvidenceObjectIds: [fixture.evidence.objectId],
    });
    expect(initial.dimensions.find(({ dimension }) => dimension === "logical")).toMatchObject({
      status: "missing",
    });
    expect(initial.dimensions.find(({ dimension }) => dimension === "human-review")).toMatchObject({
      status: "supported",
      currentEvidenceObjectIds: [fixture.review.objectId],
    });
    expect(JSON.stringify(initial)).not.toContain("0.99");

    const revised = await putObject(projectRoot, {
      branchId: fixture.branchId,
      objectId: fixture.claim.objectId,
      objectType: "claim",
      content: {
        statement: "p(n) is prime for every integer 0 <= n < 40",
        contextId: fixture.context.objectId,
        proofStatus: "statement-revised",
      },
    });
    const after = deriveVerificationProfile(projectRoot, {
      branchId: fixture.branchId,
      claimId: fixture.claim.objectId,
      contextId: fixture.context.objectId,
    });
    expect(after.claimVersionId).toBe(revised.versionId);
    expect(after.dimensions.find(({ dimension }) => dimension === "numerical")).toMatchObject({
      status: "stale",
      currentEvidenceObjectIds: [],
      staleEvidenceObjectIds: [fixture.evidence.objectId],
    });
    expect(after.dimensions.find(({ dimension }) => dimension === "human-review")).toMatchObject({
      status: "stale",
      currentEvidenceObjectIds: [],
      staleEvidenceObjectIds: [fixture.review.objectId],
    });
    const inspection = inspectWorkingPaper(projectRoot, {
      branchId: fixture.branchId,
      paperId: fixture.paper.objectId,
    });
    expect(inspection.outdatedReferences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          objectId: fixture.claim.objectId,
          currentVersionId: revised.versionId,
        }),
      ]),
    );
    const rendered = renderWorkingPaper(projectRoot, {
      branchId: fixture.branchId,
      paperId: fixture.paper.objectId,
    });
    expect(rendered.text).toContain("0 <= n < 40");
    expect(rendered.references.find(({ blockId }) => blockId === "open-proof-gap")).toMatchObject({
      mode: "pinned",
      renderedVersionId: fixture.claim.versionId,
      status: "outdated",
    });

    const revisedContext = await putObject(projectRoot, {
      branchId: fixture.branchId,
      objectId: fixture.context.objectId,
      objectType: "context",
      content: {
        domain: "integers in the closed interval 0 <= n <= 39",
        polynomial: "p(n) = n^2 + n + 41",
      },
    });
    const contextDrift = inspectWorkingPaper(projectRoot, {
      branchId: fixture.branchId,
      paperId: fixture.paper.objectId,
    });
    expect(contextDrift.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "context-version-changed",
        objectId: fixture.context.objectId,
        message: expect.stringContaining(revisedContext.versionId),
      }),
    ]));
    expect(contextDrift.outdatedReferences.find(
      ({ objectId }) => objectId === fixture.claim.objectId,
    )).toMatchObject({
      boundContextVersionId: fixture.context.versionId,
      currentContextVersionId: revisedContext.versionId,
    });
  });

  it("maps a changed scoped assumption to proofs, computation, review, figure/table, and paper section", async () => {
    const fixture = await stage7Fixture(projectRoot);
    const otherContext = await putObject(projectRoot, {
      branchId: fixture.branchId,
      objectType: "context",
      content: { domain: "complex n" },
    });
    const crossContextClaim = await putObject(projectRoot, {
      branchId: fixture.branchId,
      objectType: "claim",
      content: { statement: "A deliberately cross-context claim" },
    });
    await addEdge(projectRoot, {
      branchId: fixture.branchId,
      edgeType: "depends_on",
      fromObjectId: crossContextClaim.objectId,
      toObjectId: fixture.assumption.objectId,
      contextId: otherContext.objectId,
    });
    const revisedPaper = JSON.parse(JSON.stringify(getWorkingPaper(
      projectRoot,
      fixture.branchId,
      fixture.paper.objectId,
    ).paper)) as {
      sections: Array<{ blocks: unknown[] }>;
    };
    revisedPaper.sections[0]!.blocks.push({
      blockId: "cross-context",
      kind: "transclusion",
      reference: { objectId: crossContextClaim.objectId },
    });
    await putWorkingPaper(projectRoot, {
      branchId: fixture.branchId,
      paperId: fixture.paper.objectId,
      paper: revisedPaper,
    });
    await putObject(projectRoot, {
      branchId: fixture.branchId,
      objectId: fixture.assumption.objectId,
      objectType: "assumption",
      content: {
        statement: "n is an integer with 0 <= n < 40",
        contextId: fixture.context.objectId,
      },
    });
    const report = analyzeWorkingPaperImpact(projectRoot, {
      branchId: fixture.branchId,
      paperId: fixture.paper.objectId,
      changedObjectIds: [fixture.assumption.objectId],
    });
    expect(report.affectedSections).toHaveLength(1);
    const codes = report.affectedSections[0]!.warnings.map(({ code }) => code);
    expect(codes).toEqual(expect.arrayContaining([
      "changed-reference",
      "stale-dependency",
      "stale-evidence",
      "stale-review",
      "stale-artifact-producer",
      "reference-version-changed",
    ]));
    expect(report.affectedSections[0]!.warnings.every(
      ({ contextId }) => contextId === fixture.context.objectId,
    )).toBe(true);
    expect(report.affectedSections[0]!.warnings.some(
      ({ objectId }) => objectId === crossContextClaim.objectId,
    )).toBe(false);
    expect(report.impact.affected.map(({ object }) => object.objectId)).toEqual(
      expect.arrayContaining([
        fixture.claim.objectId,
        fixture.run.objectId,
      ]),
    );
  });

  it("promotes only branch-visible artifacts and semantically compares a child branch with its parent", async () => {
    const fixture = await stage7Fixture(projectRoot);
    const child = await createBranch(projectRoot, {
      name: "alternative-scope",
      baseBranchId: fixture.branchId,
    });
    await putObject(projectRoot, {
      branchId: child.branchId,
      objectId: fixture.assumption.objectId,
      objectType: "assumption",
      content: {
        statement: "n is an integer with 0 <= n <= 40",
        contextId: fixture.context.objectId,
      },
    });
    await putObject(projectRoot, {
      branchId: child.branchId,
      objectId: fixture.claim.objectId,
      objectType: "claim",
      content: {
        statement: "The prime range ends before n=40",
        contextId: fixture.context.objectId,
        proofStatus: "refuted-at-boundary",
      },
    });
    const newEvidence = await putObject(projectRoot, {
      branchId: child.branchId,
      objectType: "evidence",
      content: { observation: "p(40)=1681=41^2", contextId: fixture.context.objectId },
    });
    await addEdge(projectRoot, {
      branchId: child.branchId,
      edgeType: "refutes",
      fromObjectId: newEvidence.objectId,
      toObjectId: fixture.claim.objectId,
      contextId: fixture.context.objectId,
    });

    const comparison = await compareResearchBranches(
      projectRoot,
      child.branchId,
      fixture.branchId,
    );
    expect(comparison.byCategory.assumption).toEqual([fixture.assumption.objectId]);
    expect(comparison.byCategory.statement).toEqual([fixture.claim.objectId]);
    expect(comparison.byCategory.evidence).toContain(newEvidence.objectId);
    expect(comparison.proofStatusChanges).toContain(fixture.claim.objectId);
    expect(comparison.objectChanges.find(({ objectId }) => objectId === fixture.claim.objectId)).toMatchObject({
      changedFields: expect.arrayContaining(["proofStatus", "statement"]),
      sourceStatement: "The prime range ends before n=40",
      targetStatement: "p(n) is prime for every integer 0 <= n <= 39",
    });
    expect(comparison.dependencyChanges).toEqual([
      expect.objectContaining({
        side: "source",
        edgeType: "refutes",
        fromObjectId: newEvidence.objectId,
      }),
    ]);

    const sibling = await createBranch(projectRoot, {
      name: "sibling-artifact",
      baseBranchId: fixture.branchId,
    });
    const siblingRun = await putObject(projectRoot, {
      branchId: sibling.branchId,
      objectType: "run",
      content: { kind: "sibling" },
    });
    const siblingEnvironment = await putObject(projectRoot, {
      branchId: sibling.branchId,
      objectType: "environment",
      content: { kind: "sibling" },
    });
    const siblingArtifact = await registerArtifactBytes(
      projectRoot,
      new TextEncoder().encode("private sibling result"),
      {
        branchId: sibling.branchId,
        logicalName: "sibling.txt",
        mediaType: "text/plain",
        producedByRunId: siblingRun.objectId,
        environmentId: siblingEnvironment.objectId,
      },
    );
    await expect(promoteArtifactToEvidence(projectRoot, {
      branchId: fixture.branchId,
      claimId: fixture.claim.objectId,
      contextId: fixture.context.objectId,
      artifactId: siblingArtifact.artifact.artifactId,
      dimension: "reproducibility",
      outcome: "passed",
      summary: "Should not cross sibling isolation.",
    })).rejects.toThrow("not visible");
  });

  it("rejects recursive papers, dangling internal links, context mismatch, and secret-like canonical prose", async () => {
    const fixture = await stage7Fixture(projectRoot);
    const otherContext = await putObject(projectRoot, {
      branchId: fixture.branchId,
      objectType: "context",
      content: { domain: "all complex values" },
    });
    const base = {
      schemaVersion: 1,
      kind: "working-paper",
      title: "Invalid",
      context: { objectId: fixture.context.objectId },
      sections: [{
        sectionId: "one",
        title: "One",
        blocks: [] as unknown[],
      }],
    };
    await expect(putWorkingPaper(projectRoot, {
      branchId: fixture.branchId,
      paper: {
        ...base,
        sections: [{
          ...base.sections[0],
          blocks: [{
            blockId: "recursive",
            kind: "transclusion",
            reference: { objectId: fixture.paper.objectId },
          }],
        }],
      },
    })).rejects.toThrow("recursively transclude");
    await expect(putWorkingPaper(projectRoot, {
      branchId: fixture.branchId,
      paper: {
        ...base,
        sections: [{
          ...base.sections[0],
          blocks: [{
            blockId: "missing-link",
            kind: "internal-link",
            targetSectionId: "absent",
            label: "Missing",
          }],
        }],
      },
    })).rejects.toThrow("targets missing section");
    await expect(putWorkingPaper(projectRoot, {
      branchId: fixture.branchId,
      paper: {
        ...base,
        sections: [{
          ...base.sections[0],
          context: { objectId: otherContext.objectId },
          blocks: [{
            blockId: "wrong-context",
            kind: "transclusion",
            reference: { objectId: fixture.claim.objectId },
          }],
        }],
      },
    })).rejects.toThrow("conflicts");
    await expect(putWorkingPaper(projectRoot, {
      branchId: fixture.branchId,
      paper: {
        ...base,
        sections: [{
          ...base.sections[0],
          blocks: [{ blockId: "secret", kind: "markdown", text: "api_key=sk-example-secret" }],
        }],
      },
    })).rejects.toThrow("secret-like");

    const malformed = await putObject(projectRoot, {
      branchId: fixture.branchId,
      objectType: "document",
      content: {
        schemaVersion: 1,
        kind: "working-paper",
        title: "Bypassed generic document",
        context: {},
        sections: [],
      },
    });
    expect(() => inspectWorkingPaper(projectRoot, {
      branchId: fixture.branchId,
      paperId: malformed.objectId,
    })).toThrow("context.objectId");

    const [artifact] = await listVisibleArtifacts(projectRoot, fixture.branchId);
    const store = new FileSystemArtifactStore(projectRoot);
    await writeFile(store.pathForDigest(artifact!.digest), "corrupted bytes", "utf8");
    await expect(promoteArtifactToEvidence(projectRoot, {
      branchId: fixture.branchId,
      claimId: fixture.claim.objectId,
      contextId: fixture.context.objectId,
      artifactId: fixture.artifactId,
      dimension: "reproducibility",
      outcome: "passed",
      summary: "This must fail before evidence is appended.",
    })).rejects.toThrow("CAS integrity");
  });
});
