import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { canonicalJson, computeContentHash, createId, sha256Digest } from "@reasoning-workbench/project-format";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildPublicationRelease,
  checkPublicationRelease,
  addEdge,
  createBranch,
  createDomainReferenceFixture,
  evaluateReferenceProject,
  inspectPublicationRelease,
  inspectProject,
  listEdges,
  listCurrentObjects,
  putObject,
  putWorkingPaper,
  recordPublicationAttribution,
  registerArtifactBytes,
  reproducePublicationRelease,
  verifyProject,
} from "../src/index.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactCurrentReferences(
  value: unknown,
  current: ReadonlyMap<string, { readonly versionId: string }>,
  issues: string[],
): void {
  if (Array.isArray(value)) {
    value.forEach((entry) => exactCurrentReferences(entry, current, issues));
    return;
  }
  if (!isRecord(value)) return;
  if (typeof value.objectId === "string" && typeof value.versionId === "string") {
    if (current.get(value.objectId)?.versionId !== value.versionId) {
      issues.push(value.objectId + "@" + value.versionId);
    }
  }
  Object.values(value).forEach((entry) => exactCurrentReferences(entry, current, issues));
}

function canonicalWithDigest(value: Record<string, unknown>): Record<string, unknown> {
  const { digest: _digest, ...unsigned } = value;
  return { ...unsigned, digest: computeContentHash(unsigned) };
}

async function rewriteTrackedReleaseJson(
  releaseRoot: string,
  path: string,
  payload: unknown,
  mutateManifest: (manifest: Record<string, any>) => Record<string, unknown> = (manifest) => manifest,
): Promise<void> {
  const manifestPath = join(releaseRoot, "publication-release.json");
  const inventoryPath = join(releaseRoot, "provenance", "release-inventory.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, any>;
  const inventory = JSON.parse(await readFile(inventoryPath, "utf8")) as Record<string, any>;
  const text = canonicalJson(payload) + "\n";
  const bytes = new TextEncoder().encode(text);
  await writeFile(join(releaseRoot, path), text);
  const updatedInventory = canonicalWithDigest({
    ...inventory,
    files: inventory.files.map((entry: Record<string, unknown>) => entry.path === path
      ? { ...entry, digest: sha256Digest(bytes), size: bytes.byteLength }
      : entry),
  });
  const updatedManifest = canonicalWithDigest({
    ...mutateManifest(manifest),
    derivedFiles: updatedInventory.files,
    inventory: { ...manifest.inventory, digest: updatedInventory.digest },
  });
  await writeFile(inventoryPath, canonicalJson(updatedInventory) + "\n");
  await writeFile(manifestPath, canonicalJson(updatedManifest) + "\n");
}

describe("publication releases", () => {
  const sandboxes: string[] = [];

  async function sandbox(name: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), `rw-publication-${name}-`));
    sandboxes.push(root);
    return root;
  }

  afterEach(async () => {
    await Promise.all(sandboxes.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("requires local human attribution for every branch-scoped reference release", async () => {
    const root = await sandbox("references");
    for (const referenceId of ["RP-001", "RP-002", "RP-003"] as const) {
      const projectRoot = join(root, referenceId);
      const releaseRoot = join(root, `${referenceId}-release`);
      const fixture = await createDomainReferenceFixture(projectRoot, referenceId);
      const branchId = fixture.domain.project.manifest.defaultBranchId;
      const before = await checkPublicationRelease(projectRoot, { referenceId, branchId });
      expect(before.checks.find((check) => check.checkId === "REL-008")?.passed).toBe(false);

      await recordPublicationAttribution(projectRoot, {
        branchId,
        releaseLabel: `${referenceId} review release`,
        actor: { actorType: "human", actorId: createId("hum") },
      });
      expect((await checkPublicationRelease(projectRoot, { referenceId, branchId })).passed).toBe(true);
      const built = await buildPublicationRelease(projectRoot, releaseRoot, { referenceId, branchId });
      expect((await inspectPublicationRelease(releaseRoot)).digest).toBe(built.manifest.digest);
      expect((await verifyProject(join(releaseRoot, "canonical"))).ok).toBe(true);
      await Promise.all(["manuscript", "proofs", "code", "data", "figures", "environments", "verification", "provenance"]
        .map((directory) => access(join(releaseRoot, directory))));
      expect(await readdir(join(releaseRoot, "verification"))).toEqual(expect.arrayContaining([
        "release-check.json", "reproduction-report.json",
      ]));
      expect(await reproducePublicationRelease(releaseRoot)).toMatchObject({
        canonicalIntegrity: true,
        manifestIntegrity: true,
        execution: "not-attempted",
      });
    }
  }, 60_000);

  it("reopens RP-002 with exact source envelopes, references, alignment, review, and paper semantics", async () => {
    const root = await sandbox("rp002-semantic-reopen");
    const projectRoot = join(root, "project");
    const releaseRoot = join(root, "release");
    const fixture = await createDomainReferenceFixture(projectRoot, "RP-002");
    const branchId = fixture.domain.project.manifest.defaultBranchId;
    const sourceBeforePaper = listCurrentObjects(projectRoot, branchId);
    const alignment = sourceBeforePaper.find((object) => isRecord(object.content) && object.content.kind === "formal-statement-alignment")!;
    const review = sourceBeforePaper.find((object) => isRecord(object.content) && object.content.kind === "axiom-and-alignment-review")!;
    const context = fixture.domain.context;
    const paper = await putWorkingPaper(projectRoot, {
      branchId,
      paper: {
        schemaVersion: 1,
        kind: "working-paper",
        title: "RP-002 semantic reopen fixture",
        context: { objectId: context.objectId, versionId: context.versionId },
        sections: [{
          sectionId: "alignment-review",
          title: "Alignment and review",
          context: { objectId: context.objectId, versionId: context.versionId },
          annotations: [{
            annotationId: "review-note",
            kind: "note",
            text: "The independent review remains pinned.",
            references: [{
              objectId: review.objectId,
              versionId: review.versionId,
              contextId: context.objectId,
              contextVersionId: context.versionId,
              mode: "pinned",
            }],
          }],
          blocks: [{
            blockId: "alignment-transclusion",
            kind: "transclusion",
            reference: {
              objectId: alignment.objectId,
              versionId: alignment.versionId,
              contextId: context.objectId,
              contextVersionId: context.versionId,
              mode: "pinned",
            },
          }],
        }],
      },
    });
    await recordPublicationAttribution(projectRoot, {
      branchId,
      releaseLabel: "RP-002 semantic reopen",
      actor: { actorType: "human", actorId: createId("hum") },
    });
    await buildPublicationRelease(projectRoot, releaseRoot, { referenceId: "RP-002", branchId });

    const canonicalRoot = join(releaseRoot, "canonical");
    const reopened = await inspectProject(canonicalRoot);
    const snapshotObjects = listCurrentObjects(canonicalRoot, reopened.manifest.defaultBranchId);
    const current = new Map(snapshotObjects.map((object) => [object.objectId, object]));
    const issues: string[] = [];
    snapshotObjects.forEach((object) => exactCurrentReferences(object.content, current, issues));
    expect(issues).toEqual([]);
    expect((await evaluateReferenceProject(canonicalRoot, {
      referenceId: "RP-002",
      branchId: reopened.manifest.defaultBranchId,
    })).passed).toBe(true);

    const sourceObjects = listCurrentObjects(projectRoot, branchId);
    for (const source of [alignment, review, paper]) {
      const copied = snapshotObjects.find((object) => object.objectId === source.objectId)!;
      expect(copied.versionId).toBe(source.versionId);
      expect(copied.content).toEqual(source.content);
    }
    expect((await verifyProject(canonicalRoot)).ok).toBe(true);
    // inspectProject is a normal mutable-project API and recreates a local
    // projection. A release is clean only after that disposable cache is gone.
    await rm(join(canonicalRoot, ".reasoning"), { recursive: true, force: true });
    await expect(inspectPublicationRelease(releaseRoot)).resolves.toMatchObject({ kind: "publication-release" });
    await expect(reproducePublicationRelease(releaseRoot)).resolves.toMatchObject({ canonicalIntegrity: true });
  }, 30_000);

  it("reopens a read-only canonical snapshot externally and rejects every projection-cache payload", async () => {
    const root = await sandbox("readonly-canonical");
    const projectRoot = join(root, "project");
    const releaseRoot = join(root, "release");
    const fixture = await createDomainReferenceFixture(projectRoot, "RP-001");
    const branchId = fixture.domain.project.manifest.defaultBranchId;
    await recordPublicationAttribution(projectRoot, {
      branchId,
      releaseLabel: "read-only snapshot inspection",
      actor: { actorType: "human", actorId: createId("hum") },
    });
    await buildPublicationRelease(projectRoot, releaseRoot, { referenceId: "RP-001", branchId });
    const canonicalRoot = join(releaseRoot, "canonical");
    await chmod(canonicalRoot, 0o555);
    try {
      await expect(inspectPublicationRelease(releaseRoot)).resolves.toMatchObject({ kind: "publication-release" });
      await expect(reproducePublicationRelease(releaseRoot)).resolves.toMatchObject({ canonicalIntegrity: true });
      await expect(access(join(canonicalRoot, ".reasoning"))).rejects.toThrow();
    } finally {
      await chmod(canonicalRoot, 0o755);
    }
    await mkdir(join(canonicalRoot, ".reasoning"), { recursive: true });
    await writeFile(join(canonicalRoot, ".reasoning", "untracked-payload.sh"), "#!/bin/sh\necho unexpected\n");
    await expect(inspectPublicationRelease(releaseRoot)).rejects.toThrow("Unsafe release path: canonical/.reasoning");
  }, 30_000);

  it("fails closed for a missing or non-terminal failure status unless a visible human waiver is current", async () => {
    const root = await sandbox("gate");
    const projectRoot = join(root, "project");
    const fixture = await createDomainReferenceFixture(projectRoot, "RP-001");
    const branchId = fixture.domain.project.manifest.defaultBranchId;
    const failure = await putObject(projectRoot, {
      branchId,
      objectType: "failure",
      // A missing status is not evidence that a failure is resolved.
      content: { schemaVersion: 1, kind: "verification-gap", summary: "A required check is unresolved." },
    });
    await recordPublicationAttribution(projectRoot, {
      branchId,
      releaseLabel: "blocked release",
      actor: { actorType: "human", actorId: createId("hum") },
    });
    expect((await checkPublicationRelease(projectRoot, { referenceId: "RP-001", branchId })).checks
      .find((check) => check.checkId === "REL-003")?.passed).toBe(false);

    await putObject(projectRoot, {
      branchId,
      objectType: "decision",
      actor: { actorType: "agent", actorId: createId("agt") },
      content: { schemaVersion: 1, kind: "publication-waiver", status: "approved", waivedObjectRef: { objectId: failure.objectId, versionId: failure.versionId }, rationale: "Agents cannot waive release gates." },
    });
    await recordPublicationAttribution(projectRoot, {
      branchId,
      releaseLabel: "agent waiver rejected",
      actor: { actorType: "human", actorId: createId("hum") },
    });
    expect((await checkPublicationRelease(projectRoot, { referenceId: "RP-001", branchId })).checks
      .find((check) => check.checkId === "REL-003")?.passed).toBe(false);

    await putObject(projectRoot, {
      branchId,
      objectType: "decision",
      actor: { actorType: "human", actorId: createId("hum") },
      content: { schemaVersion: 1, kind: "publication-waiver", status: "approved", waivedObjectRef: { objectId: failure.objectId, versionId: failure.versionId }, rationale: "Visible acceptance fixture waiver." },
    });
    await recordPublicationAttribution(projectRoot, {
      branchId,
      releaseLabel: "human waiver reviewed",
      actor: { actorType: "human", actorId: createId("hum") },
    });
    expect((await checkPublicationRelease(projectRoot, { referenceId: "RP-001", branchId })).checks
      .find((check) => check.checkId === "REL-003")?.passed).toBe(true);

    await putObject(projectRoot, {
      branchId,
      objectId: failure.objectId,
      objectType: "failure",
      content: { ...(failure.content as Record<string, unknown>), status: "blocked", summary: "The waived version was superseded." },
    });
    await recordPublicationAttribution(projectRoot, {
      branchId,
      releaseLabel: "superseded waiver",
      actor: { actorType: "human", actorId: createId("hum") },
    });
    expect((await checkPublicationRelease(projectRoot, { referenceId: "RP-001", branchId })).checks
      .find((check) => check.checkId === "REL-003")?.passed).toBe(false);
  });

  it("gates typed open paper gaps unless the waiver binds the exact document version and gap", async () => {
    const root = await sandbox("paper-gap");
    const projectRoot = join(root, "project");
    const fixture = await createDomainReferenceFixture(projectRoot, "RP-001");
    const branchId = fixture.domain.project.manifest.defaultBranchId;
    const context = fixture.domain.context;
    const paper = await putWorkingPaper(projectRoot, {
      branchId,
      paper: {
        schemaVersion: 1,
        kind: "working-paper",
        title: "Gap fixture",
        context: { objectId: context.objectId, versionId: context.versionId },
        sections: [{
          sectionId: "open-gap",
          title: "Open gap",
          context: { objectId: context.objectId, versionId: context.versionId },
          annotations: [],
          blocks: [{
            blockId: "gap-1",
            kind: "gap",
            gapId: "GAP-001",
            statement: "This must remain visible.",
            status: "open",
            related: [],
          }],
        }],
      },
    });
    await recordPublicationAttribution(projectRoot, {
      branchId,
      releaseLabel: "paper gap blocked",
      actor: { actorType: "human", actorId: createId("hum") },
    });
    expect((await checkPublicationRelease(projectRoot, { referenceId: "RP-001", branchId })).checks
      .find((check) => check.checkId === "REL-003")?.passed).toBe(false);

    await putObject(projectRoot, {
      branchId,
      objectType: "decision",
      actor: { actorType: "human", actorId: createId("hum") },
      content: {
        schemaVersion: 1,
        kind: "publication-waiver",
        status: "approved",
        rationale: "Visible paper-gap waiver fixture.",
        waivedPaperGap: {
          documentRef: { objectId: paper.objectId, versionId: paper.versionId },
          gapId: "GAP-001",
        },
      },
    });
    await recordPublicationAttribution(projectRoot, {
      branchId,
      releaseLabel: "paper gap waived",
      actor: { actorType: "human", actorId: createId("hum") },
    });
    expect((await checkPublicationRelease(projectRoot, { referenceId: "RP-001", branchId })).checks
      .find((check) => check.checkId === "REL-003")?.passed).toBe(true);
  });

  it("fails closed when generic object writes create a malformed working-paper gap", async () => {
    const root = await sandbox("malformed-paper-gap");
    const projectRoot = join(root, "project");
    const fixture = await createDomainReferenceFixture(projectRoot, "RP-001");
    const branchId = fixture.domain.project.manifest.defaultBranchId;
    const context = fixture.domain.context;
    const malformed = await putObject(projectRoot, {
      branchId,
      objectType: "document",
      content: {
        schemaVersion: 1,
        kind: "working-paper",
        title: "Malformed gap fixture",
        context: { objectId: context.objectId, versionId: context.versionId },
        sections: [{
          sectionId: "malformed",
          title: "Malformed",
          context: { objectId: context.objectId, versionId: context.versionId },
          annotations: [],
          blocks: [{
            blockId: "gap-without-status",
            kind: "gap",
            gapId: "GAP-MISSING-STATUS",
            statement: "A generic write omitted the required normalized status.",
            related: [],
          }],
        }],
      },
    });
    await recordPublicationAttribution(projectRoot, {
      branchId,
      releaseLabel: "malformed paper blocked",
      actor: { actorType: "human", actorId: createId("hum") },
    });
    expect((await checkPublicationRelease(projectRoot, { referenceId: "RP-001", branchId })).checks
      .find((check) => check.checkId === "REL-003")?.passed).toBe(false);

    await putObject(projectRoot, {
      branchId,
      objectType: "decision",
      actor: { actorType: "human", actorId: createId("hum") },
      content: {
        schemaVersion: 1,
        kind: "publication-waiver",
        status: "approved",
        rationale: "A waiver cannot normalize malformed paper state.",
        waivedPaperGap: {
          documentRef: { objectId: malformed.objectId, versionId: malformed.versionId },
          gapId: "GAP-MISSING-STATUS",
        },
      },
    });
    await recordPublicationAttribution(projectRoot, {
      branchId,
      releaseLabel: "malformed paper remains blocked",
      actor: { actorType: "human", actorId: createId("hum") },
    });
    expect((await checkPublicationRelease(projectRoot, { referenceId: "RP-001", branchId })).checks
      .find((check) => check.checkId === "REL-003")?.passed).toBe(false);
  });

  it("fails REL-004 for a lexically first fake or ambiguous domain-pack activation", async () => {
    const root = await sandbox("ambiguous-domain-activation");
    const projectRoot = join(root, "project");
    const fixture = await createDomainReferenceFixture(projectRoot, "RP-001");
    const branchId = fixture.domain.project.manifest.defaultBranchId;
    const fake = await putObject(projectRoot, {
      branchId,
      objectId: "dec_00000000000000000000000000",
      objectType: "decision",
      content: {
        schemaVersion: 1,
        kind: "domain-pack-activation",
        packId: "unknown-pack",
        packVersion: "1.0.0",
        manifestDigest: "sha256:" + "0".repeat(64),
        templateId: "unknown-template",
        adapterPolicy: "deny-by-default",
        allowedBindingIds: [],
      },
    });
    await recordPublicationAttribution(projectRoot, {
      branchId,
      releaseLabel: "ambiguous domain activation blocked",
      actor: { actorType: "human", actorId: createId("hum") },
    });
    const report = await checkPublicationRelease(projectRoot, { referenceId: "RP-001", branchId });
    expect(report.checks.find((check) => check.checkId === "REL-002")?.passed).toBe(true);
    expect(report.checks.find((check) => check.checkId === "REL-004")).toMatchObject({
      passed: false,
      summary: "Expected exactly one current domain-pack activation, found 2.",
    });
    expect(report.checks.find((check) => check.checkId === "REL-004")?.objectIds[0]).toBe(fake.objectId);
    expect(report.passed).toBe(false);
  });

  it("uses collision-proof artifact views and rejects added, missing, or tampered release files", async () => {
    const root = await sandbox("inventory");
    const projectRoot = join(root, "project");
    const fixture = await createDomainReferenceFixture(projectRoot, "RP-001");
    const branchId = fixture.domain.project.manifest.defaultBranchId;
    const producer = fixture.artifacts[0]!;
    await registerArtifactBytes(projectRoot, new TextEncoder().encode("first"), {
      branchId,
      logicalName: "same-name.txt",
      mediaType: "text/plain",
      producedByRunId: producer.producedByRunId,
      environmentId: producer.environmentId,
      reproducibility: "deterministic",
    });
    await registerArtifactBytes(projectRoot, new TextEncoder().encode("second"), {
      branchId,
      logicalName: "same-name.txt",
      mediaType: "text/plain",
      producedByRunId: producer.producedByRunId,
      environmentId: producer.environmentId,
      reproducibility: "deterministic",
    });
    await recordPublicationAttribution(projectRoot, {
      branchId,
      releaseLabel: "inventory fixture",
      actor: { actorType: "human", actorId: createId("hum") },
    });
    const addedRelease = join(root, "added");
    const added = await buildPublicationRelease(projectRoot, addedRelease, { referenceId: "RP-001", branchId });
    const duplicatePaths = added.manifest.artifacts
      .filter((artifact) => artifact.path.endsWith("-same-name.txt"))
      .map((artifact) => artifact.path);
    expect(duplicatePaths).toHaveLength(2);
    expect(new Set(duplicatePaths).size).toBe(2);
    await writeFile(join(addedRelease, "unexpected.txt"), "extra");
    await expect(inspectPublicationRelease(addedRelease)).rejects.toThrow("extra=unexpected.txt");

    const tamperedRelease = join(root, "tampered");
    const tampered = await buildPublicationRelease(projectRoot, tamperedRelease, { referenceId: "RP-001", branchId });
    await writeFile(join(tamperedRelease, tampered.manifest.artifacts[0]!.path), "tampered");
    await expect(reproducePublicationRelease(tamperedRelease)).rejects.toThrow("Release file integrity failure");

    const missingRelease = join(root, "missing");
    const missing = await buildPublicationRelease(projectRoot, missingRelease, { referenceId: "RP-001", branchId });
    await rm(join(missingRelease, missing.manifest.artifacts[0]!.path));
    await expect(inspectPublicationRelease(missingRelease)).rejects.toThrow("missing=");
  }, 30_000);

  it("rejects a release destination nested in or equal to the source project before creating it", async () => {
    const root = await sandbox("nested-destination");
    const projectRoot = join(root, "project");
    const fixture = await createDomainReferenceFixture(projectRoot, "RP-001");
    const branchId = fixture.domain.project.manifest.defaultBranchId;
    await recordPublicationAttribution(projectRoot, {
      branchId,
      releaseLabel: "nested destination rejection",
      actor: { actorType: "human", actorId: createId("hum") },
    });
    const nestedRelease = join(projectRoot, "derived-release");
    await expect(buildPublicationRelease(projectRoot, nestedRelease, { referenceId: "RP-001", branchId }))
      .rejects.toThrow("outside the source project");
    await expect(access(nestedRelease)).rejects.toThrow();
    await expect(buildPublicationRelease(projectRoot, projectRoot, { referenceId: "RP-001", branchId }))
      .rejects.toThrow("outside the source project");
  });

  it("rejects a symlink alias that resolves a new destination back inside the source project", async () => {
    const root = await sandbox("symlink-destination");
    const projectRoot = join(root, "project");
    const fixture = await createDomainReferenceFixture(projectRoot, "RP-001");
    const branchId = fixture.domain.project.manifest.defaultBranchId;
    await recordPublicationAttribution(projectRoot, {
      branchId,
      releaseLabel: "symlink destination rejection",
      actor: { actorType: "human", actorId: createId("hum") },
    });
    const alias = join(root, "project-alias");
    await symlink(projectRoot, alias, "dir");
    const nestedViaAlias = join(alias, "derived-release");
    await expect(buildPublicationRelease(projectRoot, nestedViaAlias, { referenceId: "RP-001", branchId }))
      .rejects.toThrow("symbolic-link ancestor");
    await expect(access(join(projectRoot, "derived-release"))).rejects.toThrow();
  });

  it("preserves inherited lineage when a canonical release is attributed and released again", async () => {
    const root = await sandbox("second-generation");
    const projectRoot = join(root, "project");
    const firstRelease = join(root, "first-release");
    const secondRelease = join(root, "second-release");
    const fixture = await createDomainReferenceFixture(projectRoot, "RP-001");
    const branchId = fixture.domain.project.manifest.defaultBranchId;
    await recordPublicationAttribution(projectRoot, {
      branchId,
      releaseLabel: "first generation",
      actor: { actorType: "human", actorId: createId("hum") },
    });
    await buildPublicationRelease(projectRoot, firstRelease, { referenceId: "RP-001", branchId });
    const firstCanonical = join(firstRelease, "canonical");
    const reopened = await inspectProject(firstCanonical);
    const firstSnapshotBranch = reopened.manifest.defaultBranchId;
    await recordPublicationAttribution(firstCanonical, {
      branchId: firstSnapshotBranch,
      releaseLabel: "second generation",
      actor: { actorType: "human", actorId: createId("hum") },
    });
    await buildPublicationRelease(firstCanonical, secondRelease, {
      referenceId: "RP-001",
      branchId: firstSnapshotBranch,
    });
    await expect(inspectPublicationRelease(secondRelease)).resolves.toMatchObject({ kind: "publication-release" });
    const secondManifest = JSON.parse(await readFile(join(secondRelease, "publication-release.json"), "utf8")) as Record<string, any>;
    const secondInspection = await inspectProject(join(secondRelease, "canonical"));
    const lineageObjects = listCurrentObjects(join(secondRelease, "canonical"), secondInspection.manifest.defaultBranchId)
      .filter((object) => isRecord(object.content) && object.content.kind === "branch-scoped-release-source-lineage");
    expect(lineageObjects).toHaveLength(2);
    expect(lineageObjects.some((object) => object.objectId === secondManifest.canonicalSnapshot.lineageDecision.objectId)).toBe(true);
  }, 45_000);

  it("rejects portable-path grammar violations in parsed manifest, inventory, and artifact paths", async () => {
    const root = await sandbox("path-grammar");
    const projectRoot = join(root, "project");
    const releaseRoot = join(root, "release");
    const fixture = await createDomainReferenceFixture(projectRoot, "RP-001");
    const branchId = fixture.domain.project.manifest.defaultBranchId;
    await recordPublicationAttribution(projectRoot, {
      branchId,
      releaseLabel: "path grammar fixture",
      actor: { actorType: "human", actorId: createId("hum") },
    });
    await buildPublicationRelease(projectRoot, releaseRoot, { referenceId: "RP-001", branchId });
    const manifestPath = join(releaseRoot, "publication-release.json");
    const originalManifestText = await readFile(manifestPath, "utf8");
    const originalManifest = JSON.parse(originalManifestText) as Record<string, any>;
    for (const invalidPath of ["artifact\\view", "C:/drive", "//server/share", "a//b", "a/./b", "a/../b", "NUL/file"]) {
      const altered = canonicalWithDigest({
        ...originalManifest,
        artifacts: originalManifest.artifacts.map((artifact: Record<string, unknown>, index: number) =>
          index === 0 ? { ...artifact, path: invalidPath } : artifact,
        ),
      });
      await writeFile(manifestPath, canonicalJson(altered) + "\n");
      await expect(inspectPublicationRelease(releaseRoot)).rejects.toThrow("Unsafe release path");
    }

    const inventoryPath = join(releaseRoot, "provenance", "release-inventory.json");
    const originalInventoryText = await readFile(inventoryPath, "utf8");
    const originalInventory = JSON.parse(originalInventoryText) as Record<string, any>;
    const alteredInventory = canonicalWithDigest({
      ...originalInventory,
      files: originalInventory.files.map((entry: Record<string, unknown>, index: number) =>
        index === 0 ? { ...entry, path: "inventory\\escape" } : entry,
      ),
    });
    const inventoryManifest = canonicalWithDigest({
      ...originalManifest,
      inventory: { ...originalManifest.inventory, digest: alteredInventory.digest },
    });
    await writeFile(inventoryPath, canonicalJson(alteredInventory) + "\n");
    await writeFile(manifestPath, canonicalJson(inventoryManifest) + "\n");
    await expect(inspectPublicationRelease(releaseRoot)).rejects.toThrow("Unsafe release path");
  }, 30_000);

  it("recomputes the exported branch-source-state digest offline and rejects a deliberate mismatch", async () => {
    const root = await sandbox("source-state-digest");
    const projectRoot = join(root, "project");
    const releaseRoot = join(root, "release");
    const fixture = await createDomainReferenceFixture(projectRoot, "RP-002");
    const branchId = fixture.domain.project.manifest.defaultBranchId;
    await recordPublicationAttribution(projectRoot, {
      branchId,
      releaseLabel: "source state digest fixture",
      actor: { actorType: "human", actorId: createId("hum") },
    });
    await buildPublicationRelease(projectRoot, releaseRoot, { referenceId: "RP-002", branchId });
    const manifestPath = join(releaseRoot, "publication-release.json");
    const inventoryPath = join(releaseRoot, "provenance", "release-inventory.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, any>;
    const inventory = JSON.parse(await readFile(inventoryPath, "utf8")) as Record<string, any>;
    const sourceStatePath = join(releaseRoot, manifest.sourceState.path);
    const sourceState = JSON.parse(await readFile(sourceStatePath, "utf8")) as Record<string, unknown>;
    const tamperedStateText = canonicalJson({
      ...sourceState,
      sourceBranchSnapshotDigest: "sha256:" + "0".repeat(64),
    }) + "\n";
    await writeFile(sourceStatePath, tamperedStateText);
    const changedInventory = canonicalWithDigest({
      ...inventory,
      files: inventory.files.map((entry: Record<string, unknown>) => entry.path === manifest.sourceState.path
        ? {
          ...entry,
          digest: sha256Digest(new TextEncoder().encode(tamperedStateText)),
          size: new TextEncoder().encode(tamperedStateText).byteLength,
        }
        : entry),
    });
    const changedManifest = canonicalWithDigest({
      ...manifest,
      derivedFiles: changedInventory.files,
      inventory: { ...manifest.inventory, digest: changedInventory.digest },
    });
    await writeFile(inventoryPath, canonicalJson(changedInventory) + "\n");
    await writeFile(manifestPath, canonicalJson(changedManifest) + "\n");
    await expect(inspectPublicationRelease(releaseRoot)).rejects.toThrow("Branch source-state snapshot digest mismatch");
  }, 30_000);

  it("binds manifest object, edge, artifact, reproduction-plan, and artifact-lineage views to source state", async () => {
    const root = await sandbox("manifest-source-bindings");
    const projectRoot = join(root, "project");
    const releaseRoot = join(root, "release");
    const fixture = await createDomainReferenceFixture(projectRoot, "RP-001");
    const branchId = fixture.domain.project.manifest.defaultBranchId;
    await recordPublicationAttribution(projectRoot, {
      branchId,
      releaseLabel: "manifest bindings fixture",
      actor: { actorType: "human", actorId: createId("hum") },
    });
    await buildPublicationRelease(projectRoot, releaseRoot, { referenceId: "RP-001", branchId });
    const manifestPath = join(releaseRoot, "publication-release.json");
    const originalManifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, any>;
    expect(originalManifest.artifacts.length).toBeGreaterThan(0);
    const emptiedManifest = canonicalWithDigest({
      ...originalManifest,
      objects: [],
      edges: [],
      artifacts: [],
    });
    await writeFile(manifestPath, canonicalJson(emptiedManifest) + "\n");
    await expect(inspectPublicationRelease(releaseRoot)).rejects.toThrow("manifest objects do not match");

    const planMismatch = canonicalWithDigest({
      ...originalManifest,
      reproductionPlan: [{
        runObjectId: "run-mismatch",
        runVersionId: "ver-mismatch",
        reproducibility: "deterministic",
        replayMode: "inspect-export-only",
        boundedBy: { maxJobs: 1, network: "disabled", externalEngineExecution: false },
      }],
    });
    await writeFile(manifestPath, canonicalJson(planMismatch) + "\n");
    await expect(inspectPublicationRelease(releaseRoot)).rejects.toThrow("reproduction plan does not match");

    await writeFile(manifestPath, canonicalJson(originalManifest) + "\n");
    const inventoryPath = join(releaseRoot, "provenance", "release-inventory.json");
    const originalInventory = JSON.parse(await readFile(inventoryPath, "utf8")) as Record<string, any>;
    const artifactLineagePath = join(releaseRoot, "provenance", "artifact-lineage.json");
    const alteredLineageText = "[]\n";
    await writeFile(artifactLineagePath, alteredLineageText);
    const alteredInventory = canonicalWithDigest({
      ...originalInventory,
      files: originalInventory.files.map((entry: Record<string, unknown>) => entry.path === "provenance/artifact-lineage.json"
        ? {
          ...entry,
          digest: sha256Digest(new TextEncoder().encode(alteredLineageText)),
          size: new TextEncoder().encode(alteredLineageText).byteLength,
        }
        : entry),
    });
    const lineageManifest = canonicalWithDigest({
      ...originalManifest,
      derivedFiles: alteredInventory.files,
      inventory: { ...originalManifest.inventory, digest: alteredInventory.digest },
    });
    await writeFile(inventoryPath, canonicalJson(alteredInventory) + "\n");
    await writeFile(manifestPath, canonicalJson(lineageManifest) + "\n");
    await expect(inspectPublicationRelease(releaseRoot)).rejects.toThrow("artifact lineage does not match");
  }, 30_000);

  it("fails closed for fully rehashed report, reproduction, and environment-view semantic tampering", async () => {
    const root = await sandbox("semantic-report-tampering");
    const projectRoot = join(root, "project");
    const fixture = await createDomainReferenceFixture(projectRoot, "RP-002");
    const branchId = fixture.domain.project.manifest.defaultBranchId;
    await recordPublicationAttribution(projectRoot, {
      branchId,
      releaseLabel: "semantic report tampering fixture",
      actor: { actorType: "human", actorId: createId("hum") },
    });

    const emptyChecksRelease = join(root, "empty-checks");
    await buildPublicationRelease(projectRoot, emptyChecksRelease, { referenceId: "RP-002", branchId });
    const emptyChecks = JSON.parse(await readFile(join(emptyChecksRelease, "verification", "release-check.json"), "utf8")) as Record<string, any>;
    const alteredChecks = canonicalWithDigest({ ...emptyChecks, checks: [], passed: true });
    await rewriteTrackedReleaseJson(
      emptyChecksRelease,
      "verification/release-check.json",
      alteredChecks,
      (manifest) => ({ ...manifest, checks: alteredChecks }),
    );
    await expect(inspectPublicationRelease(emptyChecksRelease)).rejects.toThrow("every required gate exactly once");

    const forgedReferenceRelease = join(root, "forged-reference");
    await buildPublicationRelease(projectRoot, forgedReferenceRelease, { referenceId: "RP-002", branchId });
    const forgedReferenceReport = JSON.parse(await readFile(join(forgedReferenceRelease, "verification", "release-check.json"), "utf8")) as Record<string, any>;
    const alteredReference = canonicalWithDigest({
      ...forgedReferenceReport,
      reference: { ...forgedReferenceReport.reference, assertions: [] },
    });
    await rewriteTrackedReleaseJson(
      forgedReferenceRelease,
      "verification/release-check.json",
      alteredReference,
      (manifest) => ({ ...manifest, checks: alteredReference }),
    );
    await expect(inspectPublicationRelease(forgedReferenceRelease)).rejects.toThrow("reference evaluation does not match");

    const forgedProfilesRelease = join(root, "forged-profiles");
    await buildPublicationRelease(projectRoot, forgedProfilesRelease, { referenceId: "RP-002", branchId });
    const forgedProfilesReport = JSON.parse(await readFile(join(forgedProfilesRelease, "verification", "release-check.json"), "utf8")) as Record<string, any>;
    const alteredProfiles = canonicalWithDigest({ ...forgedProfilesReport, verificationProfiles: [] });
    await rewriteTrackedReleaseJson(
      forgedProfilesRelease,
      "verification/release-check.json",
      alteredProfiles,
      (manifest) => ({ ...manifest, checks: alteredProfiles }),
    );
    await expect(inspectPublicationRelease(forgedProfilesRelease)).rejects.toThrow("verification profiles do not match");

    const reproductionRelease = join(root, "forged-reproduction");
    await buildPublicationRelease(projectRoot, reproductionRelease, { referenceId: "RP-002", branchId });
    const reproduction = JSON.parse(await readFile(join(reproductionRelease, "verification", "reproduction-report.json"), "utf8")) as Record<string, unknown>;
    const alteredReproduction = canonicalWithDigest({
      ...reproduction,
      plan: [{
        runObjectId: "run-forged",
        runVersionId: "ver-forged",
        reproducibility: "deterministic",
        replayMode: "inspect-export-only",
        boundedBy: { maxJobs: 1, network: "enabled", externalEngineExecution: true },
      }],
    });
    await rewriteTrackedReleaseJson(reproductionRelease, "verification/reproduction-report.json", alteredReproduction);
    await expect(inspectPublicationRelease(reproductionRelease)).rejects.toThrow("Invalid bounded reproduction report reproduction plan entry");

    const environmentsRelease = join(root, "forged-environments");
    await buildPublicationRelease(projectRoot, environmentsRelease, { referenceId: "RP-002", branchId });
    await rewriteTrackedReleaseJson(environmentsRelease, "environments/release-environments.json", []);
    await expect(inspectPublicationRelease(environmentsRelease)).rejects.toThrow("environment view does not match");

    const profileBranchRelease = join(root, "forged-profile-branch");
    await buildPublicationRelease(projectRoot, profileBranchRelease, { referenceId: "RP-002", branchId });
    const profileBranchReport = JSON.parse(await readFile(join(profileBranchRelease, "verification", "release-check.json"), "utf8")) as Record<string, any>;
    expect(profileBranchReport.verificationProfiles.length).toBeGreaterThan(0);
    const alteredProfileBranch = canonicalWithDigest({
      ...profileBranchReport,
      verificationProfiles: profileBranchReport.verificationProfiles.map((profile: Record<string, unknown>, index: number) =>
        index === 0 ? { ...profile, branchId: "br_private_forged" } : profile),
    });
    await rewriteTrackedReleaseJson(
      profileBranchRelease,
      "verification/release-check.json",
      alteredProfileBranch,
      (manifest) => ({ ...manifest, checks: alteredProfileBranch }),
    );
    await expect(inspectPublicationRelease(profileBranchRelease)).rejects.toThrow("belongs to a different branch");

    const gatePayloadRelease = join(root, "forged-gate-payload");
    await buildPublicationRelease(projectRoot, gatePayloadRelease, { referenceId: "RP-002", branchId });
    const gatePayloadReport = JSON.parse(await readFile(join(gatePayloadRelease, "verification", "release-check.json"), "utf8")) as Record<string, any>;
    const alteredGatePayload = canonicalWithDigest({
      ...gatePayloadReport,
      checks: gatePayloadReport.checks.map((check: Record<string, unknown>) => check.checkId === "REL-001"
        ? { ...check, summary: "External engines and formal proofs were verified.", objectIds: ["obj_forged_evidence"] }
        : check),
    });
    await rewriteTrackedReleaseJson(
      gatePayloadRelease,
      "verification/release-check.json",
      alteredGatePayload,
      (manifest) => ({ ...manifest, checks: alteredGatePayload }),
    );
    await expect(inspectPublicationRelease(gatePayloadRelease)).rejects.toThrow("gate payload does not match");
  }, 60_000);

  it("requires a positive immutable reproduction policy and binds even an emptied plan to eligible source candidates", async () => {
    const root = await sandbox("reproduction-policy");
    const projectRoot = join(root, "project");
    const fixture = await createDomainReferenceFixture(projectRoot, "RP-001");
    const branchId = fixture.domain.project.manifest.defaultBranchId;
    await recordPublicationAttribution(projectRoot, {
      branchId,
      releaseLabel: "reproduction policy fixture",
      actor: { actorType: "human", actorId: createId("hum") },
    });
    const zeroDestination = join(root, "zero-jobs");
    await expect(buildPublicationRelease(projectRoot, zeroDestination, {
      referenceId: "RP-001",
      branchId,
      maxJobs: 0,
    })).rejects.toThrow("positive safe integer");
    await expect(access(zeroDestination)).rejects.toThrow();
    await expect(buildPublicationRelease(projectRoot, join(root, "negative-jobs"), {
      referenceId: "RP-001",
      branchId,
      maxJobs: -1,
    })).rejects.toThrow("positive safe integer");

    const releaseRoot = join(root, "release");
    await buildPublicationRelease(projectRoot, releaseRoot, { referenceId: "RP-001", branchId, maxJobs: 1 });
    const reproduction = JSON.parse(await readFile(join(releaseRoot, "verification", "reproduction-report.json"), "utf8")) as Record<string, any>;
    expect(reproduction.reproductionPolicy).toEqual({
      maxJobs: 1,
      network: "disabled",
      externalEngineExecution: false,
      candidateSelection: "eligible-succeeded-deterministic-or-seeded-object-id-order",
      centralDesignation: "not-recorded",
    });
    expect(reproduction.plan.length).toBeGreaterThan(0);
    const emptiedPlan = canonicalWithDigest({ ...reproduction, plan: [] });
    await rewriteTrackedReleaseJson(
      releaseRoot,
      "verification/reproduction-report.json",
      emptiedPlan,
      (manifest) => ({ ...manifest, reproductionPlan: [] }),
    );
    await expect(inspectPublicationRelease(releaseRoot)).rejects.toThrow("reproduction plan does not match bounded eligible source run candidates");
  }, 30_000);

  it("rejects unknown public fields that make authentication, authorization, or engine-execution claims", async () => {
    const root = await sandbox("false-public-claims");
    const projectRoot = join(root, "project");
    const releaseRoot = join(root, "release");
    const fixture = await createDomainReferenceFixture(projectRoot, "RP-001");
    const branchId = fixture.domain.project.manifest.defaultBranchId;
    await recordPublicationAttribution(projectRoot, {
      branchId,
      releaseLabel: "false public claims fixture",
      actor: { actorType: "human", actorId: createId("hum") },
    });
    await buildPublicationRelease(projectRoot, releaseRoot, { referenceId: "RP-001", branchId });
    const manifestPath = join(releaseRoot, "publication-release.json");
    const originalManifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, any>;

    await writeFile(manifestPath, canonicalJson(canonicalWithDigest({ ...originalManifest, authenticated: true })) + "\n");
    await expect(inspectPublicationRelease(releaseRoot)).rejects.toThrow("Unexpected or missing fields in publication-release manifest");

    const falseAuthorization = canonicalWithDigest({
      ...originalManifest,
      attribution: { ...originalManifest.attribution, externalPublicationAuthorized: true },
    });
    await writeFile(manifestPath, canonicalJson(falseAuthorization) + "\n");
    await expect(inspectPublicationRelease(releaseRoot)).rejects.toThrow("Unexpected or missing fields in publication attribution");

    await writeFile(manifestPath, canonicalJson(originalManifest) + "\n");
    const reproduction = JSON.parse(await readFile(join(releaseRoot, "verification", "reproduction-report.json"), "utf8")) as Record<string, unknown>;
    const falseEngineExecution = canonicalWithDigest({ ...reproduction, externalEnginesExecuted: true });
    await rewriteTrackedReleaseJson(releaseRoot, "verification/reproduction-report.json", falseEngineExecution);
    await expect(inspectPublicationRelease(releaseRoot)).rejects.toThrow("Unexpected or missing fields in bounded reproduction report");
  }, 30_000);

  it("does not disclose sibling branch objects in a selected-branch snapshot", async () => {
    const root = await sandbox("scope");
    const projectRoot = join(root, "project");
    const fixture = await createDomainReferenceFixture(projectRoot, "RP-001");
    const branchId = fixture.domain.project.manifest.defaultBranchId;
    const privateBranch = await createBranch(projectRoot, { name: "private", baseBranchId: branchId });
    const privateObject = await putObject(projectRoot, {
      branchId: privateBranch.branchId,
      objectType: "claim",
      content: { contextId: fixture.domain.context.objectId, kind: "private-sentinel", statement: "PRIVATE-ONLY-SENTINEL" },
    });
    await recordPublicationAttribution(projectRoot, {
      branchId,
      releaseLabel: "main branch only",
      actor: { actorType: "human", actorId: createId("hum") },
    });
    const releaseRoot = join(root, "release");
    const built = await buildPublicationRelease(projectRoot, releaseRoot, { referenceId: "RP-001", branchId });
    expect(JSON.stringify(built.manifest)).not.toContain(privateObject.objectId);
    expect(JSON.stringify(await inspectProject(join(releaseRoot, "canonical")))).not.toContain("PRIVATE-ONLY-SENTINEL");
  }, 20_000);

  it("atomically claims a new release root and preserves a concurrent winner", async () => {
    const root = await sandbox("destination-ownership");
    const projectRoot = join(root, "project");
    const fixture = await createDomainReferenceFixture(projectRoot, "RP-001");
    const branchId = fixture.domain.project.manifest.defaultBranchId;
    await recordPublicationAttribution(projectRoot, {
      branchId,
      releaseLabel: "single release-root owner",
      actor: { actorType: "human", actorId: createId("hum") },
    });
    const releaseRoot = join(root, "release");
    const results = await Promise.allSettled([
      buildPublicationRelease(projectRoot, releaseRoot, { referenceId: "RP-001", branchId }),
      buildPublicationRelease(projectRoot, releaseRoot, { referenceId: "RP-001", branchId }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    await expect(inspectPublicationRelease(releaseRoot)).resolves.toMatchObject({
      kind: "publication-release",
    });
  }, 30_000);

  it("omits a stale historical edge only when a current exact replacement has the same relationship", async () => {
    const root = await sandbox("edge-replacement");
    const projectRoot = join(root, "project");
    const releaseRoot = join(root, "release");
    const fixture = await createDomainReferenceFixture(projectRoot, "RP-001");
    const branchId = fixture.domain.project.manifest.defaultBranchId;
    const finite = listCurrentObjects(projectRoot, branchId)
      .find((object) => typeof object.content === "object" && object.content !== null && (object.content as Record<string, unknown>).kind === "finite-prime-range")!;
    const oldEdge = listEdges(projectRoot, branchId)
      .find((edge) => edge.fromObjectId === finite.objectId || edge.toObjectId === finite.objectId)!;
    await putObject(projectRoot, {
      branchId,
      objectId: finite.objectId,
      objectType: "claim",
      content: { ...(finite.content as Record<string, unknown>), statement: "The finite range was revised." },
    });
    const revisedFinite = listCurrentObjects(projectRoot, branchId)
      .find((object) => object.objectId === finite.objectId)!;
    const review = listCurrentObjects(projectRoot, branchId)
      .find((object) => isRecord(object.content) && object.content.kind === "skeptical-review")!;
    const reviewContent = review.content as Record<string, unknown>;
    await putObject(projectRoot, {
      branchId,
      objectId: review.objectId,
      objectType: "review",
      content: {
        ...reviewContent,
        claimRefs: (reviewContent.claimRefs as Array<Record<string, unknown>>).map((reference) =>
          reference.objectId === finite.objectId
            ? { ...reference, versionId: revisedFinite.versionId }
            : reference),
      },
    });
    const oldEnvelope = oldEdge.envelope as Record<string, unknown>;
    await addEdge(projectRoot, {
      branchId,
      edgeType: oldEdge.edgeType as Parameters<typeof addEdge>[1]["edgeType"],
      fromObjectId: oldEdge.fromObjectId,
      toObjectId: oldEdge.toObjectId,
      ...(typeof oldEnvelope.contextId === "string" ? { contextId: oldEnvelope.contextId } : {}),
      metadata: { replacementFor: oldEdge.edgeId },
    });
    await recordPublicationAttribution(projectRoot, {
      branchId,
      releaseLabel: "edge replacement release",
      actor: { actorType: "human", actorId: createId("hum") },
    });
    expect((await checkPublicationRelease(projectRoot, { referenceId: "RP-001", branchId })).checks
      .find((entry) => entry.checkId === "REL-005")?.passed).toBe(true);
    await expect(buildPublicationRelease(projectRoot, releaseRoot, { referenceId: "RP-001", branchId }))
      .resolves.toMatchObject({ destinationRoot: releaseRoot });
    await expect(inspectPublicationRelease(releaseRoot)).resolves.toMatchObject({ kind: "publication-release" });
  }, 30_000);

  it("rejects an edge whose endpoint is no longer the selected exact version", async () => {
    const root = await sandbox("edge-version");
    const projectRoot = join(root, "project");
    const fixture = await createDomainReferenceFixture(projectRoot, "RP-001");
    const branchId = fixture.domain.project.manifest.defaultBranchId;
    const finite = listCurrentObjects(projectRoot, branchId)
      .find((object) => typeof object.content === "object" && object.content !== null && (object.content as Record<string, unknown>).kind === "finite-prime-range")!;
    await putObject(projectRoot, {
      branchId,
      objectId: finite.objectId,
      objectType: "claim",
      content: { ...(finite.content as Record<string, unknown>), statement: "The finite range was restated." },
    });
    await recordPublicationAttribution(projectRoot, {
      branchId,
      releaseLabel: "edge version fixture",
      actor: { actorType: "human", actorId: createId("hum") },
    });
    const check = await checkPublicationRelease(projectRoot, { referenceId: "RP-001", branchId });
    expect(check.checks.find((entry) => entry.checkId === "REL-005")?.passed).toBe(false);
  });
});
