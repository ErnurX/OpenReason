import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createProject,
  createRp001Fixture,
  deriveVerificationProfile,
  getLiteratureSource,
  groundClaimInLiterature,
  ingestLiteratureDocument,
  linkLiteratureCitation,
  listCurrentObjects,
  listLiteratureSources,
  LiteratureCatalogRegistry,
  LiteratureIngestionError,
  OpenAlexCatalogAdapter,
  putObject,
  resolveLiteratureAnchor,
  reviewLiteratureAnchor,
  searchLiterature,
  searchLiteratureCatalog,
  searchLiteratureNovelty,
  StaticLiteratureCatalogAdapter,
  verifyProject,
} from "../src/index.js";

describe("Stage 9 literature workspace", () => {
  const sandboxes: string[] = [];

  async function sandbox(name: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), `rw-stage9-${name}-`));
    sandboxes.push(root);
    return join(root, "project");
  }

  afterEach(async () => {
    await Promise.all(
      sandboxes.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  it("ingests a PDF with portable CAS provenance and exact machine-proposed page anchors", async () => {
    const root = await sandbox("pdf");
    const fixture = await createRp001Fixture(root);
    const branchId = fixture.project.manifest.defaultBranchId;
    const ingested = await ingestLiteratureDocument(root, {
      branchId,
      sourceKind: "pdf",
      logicalName: "euler.pdf",
      mediaType: "application/pdf",
      bytes: new TextEncoder().encode("%PDF-1.7 RP-001 fixture"),
      metadata: {
        title: "Euler polynomial note",
        authors: ["Reference Author"],
        year: 2024,
        identifiers: { doi: "10.0000/rp001" },
      },
      extractedText: "Introduction\fTheorem 1. For every integer n with 0 <= n <= 39, n^2+n+41 is prime.",
    });

    const record = getLiteratureSource(root, branchId, ingested.source.objectId);
    const theorem = record.source.anchors.find((anchor) => anchor.kind === "theorem")!;
    expect(record.source.artifact.digest).toBe(record.source.provenance.rawDigest);
    expect(record.source.provenance).toMatchObject({
      producedByRunId: ingested.run.objectId,
      environmentId: ingested.environment.objectId,
    });
    expect(theorem).toMatchObject({
      extractionState: "machine-proposed",
      locator: { page: 2 },
      scope: "universal",
    });
    expect(resolveLiteratureAnchor(root, {
      branchId,
      sourceId: ingested.source.objectId,
      anchorId: theorem.anchorId,
    }).uri).toContain(`#page=2&anchor=${theorem.anchorId}`);
    expect((await verifyProject(root)).ok).toBe(true);
  });

  it("searches theorem text and assumptions, then grounds a claim only after exact human review", async () => {
    const root = await sandbox("grounding");
    const fixture = await createRp001Fixture(root);
    const branchId = fixture.project.manifest.defaultBranchId;
    const assumption = await putObject(root, {
      branchId,
      objectType: "assumption",
      content: { statement: "n is an integer with 0 <= n <= 39", contextId: fixture.context.objectId },
    });
    const claim = await putObject(root, {
      branchId,
      objectType: "claim",
      content: {
        statement: "For every integer n with 0 <= n <= 39, n^2+n+41 is prime.",
        contextId: fixture.context.objectId,
      },
    });
    const ingested = await ingestLiteratureDocument(root, {
      branchId,
      sourceKind: "pdf",
      logicalName: "theorem.pdf",
      mediaType: "application/pdf",
      bytes: new TextEncoder().encode("source-v1"),
      metadata: {
        title: "Finite Euler theorem",
        authors: ["Ada Reference"],
        year: 2025,
        identifiers: { doi: "10.1234/euler" },
      },
      anchors: [{
        kind: "theorem",
        locator: { page: 7, theorem: "2.1" },
        text: "For every integer n with 0 <= n <= 39, n^2+n+41 is prime.",
        assumptions: ["n is an integer with 0 <= n <= 39"],
        scope: "universal",
      }],
    });
    const source = getLiteratureSource(root, branchId, ingested.source.objectId);
    const theorem = source.source.anchors.find((anchor) => anchor.kind === "theorem")!;

    const search = await searchLiterature(root, {
      branchId,
      query: "Euler prime polynomial",
      anchorKinds: ["theorem"],
      assumptionIds: [assumption.objectId],
    });
    expect(search[0]).toMatchObject({
      sourceId: source.object.objectId,
      anchorId: theorem.anchorId,
      reviewState: "unreviewed",
      assumptionScore: 1,
    });

    await reviewLiteratureAnchor(root, {
      branchId,
      sourceId: source.object.objectId,
      anchorId: theorem.anchorId,
      outcome: "accepted",
      summary: "Checked against page 7 of the stored artifact.",
    });
    const grounded = await groundClaimInLiterature(root, {
      branchId,
      claimId: claim.objectId,
      contextId: fixture.context.objectId,
      sourceId: source.object.objectId,
      anchorId: theorem.anchorId,
      quotedText: "n^2+n+41 is prime",
      expectedAuthors: ["Ada Reference"],
      expectedYear: 2025,
      expectedIdentifiers: { doi: "10.1234/euler" },
      claimAssumptions: ["n is an integer with 0 <= n <= 39"],
      claimScope: "universal",
      assessment: "supports",
      interpretation: "The reviewed theorem supports RP-001 on the exact finite domain.",
    });
    expect(grounded.assessment.outcome).toBe("passed");
    expect(grounded.evidence.content).toMatchObject({
      kind: "source-grounded-evidence",
      assurance: "human-reviewed",
      sourceRef: { objectId: source.object.objectId, versionId: source.object.versionId },
      anchorRef: { anchorId: theorem.anchorId, contentHash: theorem.contentHash },
    });
    expect(deriveVerificationProfile(root, {
      branchId,
      claimId: claim.objectId,
      contextId: fixture.context.objectId,
    }).dimensions.find((dimension) => dimension.dimension === "source")?.status).toBe("supported");

    await ingestLiteratureDocument(root, {
      branchId,
      sourceId: source.object.objectId,
      sourceKind: "pdf",
      logicalName: "theorem-v2.pdf",
      mediaType: "application/pdf",
      bytes: new TextEncoder().encode("source-v2"),
      metadata: source.source.metadata,
      anchors: [{
        kind: "theorem",
        locator: { page: 8, theorem: "2.1 revised" },
        text: "For every integer n with 0 <= n <= 38, n^2+n+41 is prime.",
        scope: "universal",
      }],
    });
    const stale = deriveVerificationProfile(root, {
      branchId,
      claimId: claim.objectId,
      contextId: fixture.context.objectId,
    }).dimensions.find((dimension) => dimension.dimension === "source")!;
    expect(stale.status).toBe("stale");
    expect(stale.observations[0]?.staleReasons).toContain("source-version-changed");
  });

  it("supports citation-graph discovery and reports novelty candidates without declaring novelty", async () => {
    const root = await sandbox("novelty");
    const fixture = await createRp001Fixture(root);
    const branchId = fixture.project.manifest.defaultBranchId;
    const sourceA = await ingestLiteratureDocument(root, {
      branchId,
      sourceKind: "text",
      logicalName: "prior.txt",
      mediaType: "text/plain",
      bytes: new TextEncoder().encode("Prior result"),
      metadata: { title: "Prime-producing Euler polynomial", authors: ["A"], year: 2020, identifiers: {} },
      anchors: [{ kind: "theorem", locator: { theorem: "A" }, text: "Every value n^2+n+41 is prime on the finite interval.", scope: "universal" }],
    });
    const sourceB = await ingestLiteratureDocument(root, {
      branchId,
      sourceKind: "text",
      logicalName: "survey.txt",
      mediaType: "text/plain",
      bytes: new TextEncoder().encode("Survey"),
      metadata: { title: "Survey of Euler polynomial", authors: ["B"], year: 2022, identifiers: {} },
    });
    await linkLiteratureCitation(root, {
      branchId,
      citingSourceId: sourceB.source.objectId,
      citedSourceId: sourceA.source.objectId,
    });
    const graphResults = await searchLiterature(root, {
      branchId,
      query: "Euler polynomial",
      mode: "citation",
      seedSourceIds: [sourceB.source.objectId],
    });
    expect(new Set(graphResults.map((result) => result.sourceId))).toEqual(
      new Set([sourceA.source.objectId, sourceB.source.objectId]),
    );

    const claim = await putObject(root, {
      branchId,
      objectType: "claim",
      content: { statement: "Every value n^2+n+41 is prime on a finite interval.", contextId: fixture.context.objectId },
    });
    const novelty = await searchLiteratureNovelty(root, {
      branchId,
      claimId: claim.objectId,
      contextId: fixture.context.objectId,
    });
    expect(novelty.conclusion).toBe("not-assessed");
    expect(novelty.candidates[0]?.conclusion).toBe("requires-human-review");
  });

  it("requires explicit catalog authorization and keeps live OpenAlex behind an adapter", async () => {
    const staticRegistry = new LiteratureCatalogRegistry().register(
      new StaticLiteratureCatalogAdapter({
        records: [{
          recordId: "doi:10.1/example",
          title: "A theorem on prime polynomials",
          authors: ["Catalog Author"],
          year: 2023,
          identifiers: { doi: "10.1/example" },
        }],
      }),
    );
    await expect(searchLiteratureCatalog(staticRegistry, {
      catalogId: "static.catalog",
      query: "prime polynomial",
      allowedCatalogIds: [],
      grantedCapabilities: [],
    })).rejects.toThrow("explicit allow-list");
    expect((await searchLiteratureCatalog(staticRegistry, {
      catalogId: "static.catalog",
      query: "prime polynomial",
      allowedCatalogIds: ["static.catalog"],
      grantedCapabilities: [],
    }))[0]?.recordId).toBe("doi:10.1/example");

    let requestedUrl = "";
    const openAlex = new OpenAlexCatalogAdapter(async (url) => {
      requestedUrl = url;
      return {
        ok: true,
        status: 200,
        async json() {
          return { results: [{
            id: "https://openalex.org/W1",
            title: "Exact theorem",
            publication_year: 2024,
            doi: "https://doi.org/10.2/exact",
            authorships: [{ author: { display_name: "Open Author" } }],
          }] };
        },
      };
    });
    const registry = new LiteratureCatalogRegistry().register(openAlex);
    await expect(searchLiteratureCatalog(registry, {
      catalogId: "openalex.works",
      query: "exact theorem",
      allowedCatalogIds: ["openalex.works"],
      grantedCapabilities: [],
    })).rejects.toThrow("network.access");
    const records = await searchLiteratureCatalog(registry, {
      catalogId: "openalex.works",
      query: "exact theorem",
      allowedCatalogIds: ["openalex.works"],
      grantedCapabilities: ["network.access"],
    });
    expect(requestedUrl).toContain("api.openalex.org/works");
    expect(records[0]?.identifiers.doi).toBe("10.2/exact");
  });

  it("preserves an ingestion failure and its run instead of erasing negative work", async () => {
    const root = await sandbox("failure");
    const project = await createProject(root, { title: "Stage 9 failure" });
    const branchId = project.manifest.defaultBranchId;
    const occupied = await putObject(root, {
      branchId,
      objectType: "claim",
      content: { statement: "occupied identity" },
    });
    let failure: LiteratureIngestionError | undefined;
    try {
      await ingestLiteratureDocument(root, {
        branchId,
        sourceId: occupied.objectId,
        sourceKind: "text",
        logicalName: "invalid.txt",
        mediaType: "text/plain",
        bytes: new TextEncoder().encode("negative result"),
        metadata: { title: "Invalid source", authors: [], identifiers: {} },
      });
    } catch (error) {
      failure = error as LiteratureIngestionError;
    }
    expect(failure).toBeInstanceOf(LiteratureIngestionError);
    const objects = listCurrentObjects(root, branchId);
    expect(objects.find((object) => object.objectId === failure?.runId)?.content).toMatchObject({
      kind: "literature-ingest-run",
      status: "failed",
    });
    expect(objects.find((object) => object.objectId === failure?.failureId)?.content).toMatchObject({
      kind: "literature-ingestion-failure",
      status: "open",
    });
    expect(listLiteratureSources(root, branchId)).toEqual([]);
  });
});
