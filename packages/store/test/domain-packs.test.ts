import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  authorizeDomainPackBindings,
  buildResearchPackage,
  createBuiltInDomainPackRegistry,
  createCoreToolRegistry,
  createCoreVerifierRegistry,
  createDomainReferenceFixture,
  DOMAIN_TEMPLATE_IDS,
  DomainPackRegistry,
  domainPackDigest,
  evaluateReferenceProject,
  inspectDomainPackConformance,
  instantiateDomainTemplate,
  listCurrentObjects,
  putObject,
  ToolRegistry,
  verifyProject,
  type DomainPackManifest,
} from "../src/index.js";

describe("Stage 10 domain packs", () => {
  const sandboxes: string[] = [];

  async function sandbox(name: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), `rw-stage10-${name}-`));
    sandboxes.push(root);
    return root;
  }

  afterEach(async () => {
    await Promise.all(sandboxes.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("registers three provider-neutral packs and all seven domain templates", () => {
    const registry = createBuiltInDomainPackRegistry();
    expect(registry.list().map((pack) => pack.packId)).toEqual([
      "computational-reasoning",
      "pure-mathematics",
      "theoretical-physics",
    ]);
    expect(registry.list().flatMap((pack) => pack.templates.map((template) => template.templateId)).sort())
      .toEqual([...DOMAIN_TEMPLATE_IDS].sort());
    expect(registry.get("pure-mathematics")?.adapters.map((binding) => binding.adapterId))
      .toEqual(expect.arrayContaining(["math.lean", "math.sage", "math.gap", "math.pari-gp", "math.smt-sat"]));
    expect(registry.get("theoretical-physics")?.adapters.map((binding) => binding.adapterId))
      .toEqual(expect.arrayContaining(["physics.sympy", "physics.tensor", "physics.ode-pde", "physics.simulation"]));
    expect(registry.get("computational-reasoning")?.adapters.map((binding) => binding.adapterId))
      .toEqual(expect.arrayContaining(["compute.jax", "compute.benchmark", "compute.algorithm-search", "compute.evolutionary-search"]));
  });

  it("checks required core contracts while keeping external engines optional and deny-by-default", () => {
    const packs = createBuiltInDomainPackRegistry();
    for (const pack of packs.list()) {
      const report = inspectDomainPackConformance(pack, {
        tools: createCoreToolRegistry(),
        verifiers: createCoreVerifierRegistry(),
      });
      expect(report.passed).toBe(true);
      expect(report.bindings.filter((binding) => !binding.optional).every((binding) => binding.available)).toBe(true);
      expect(report.bindings.some((binding) => binding.optional && !binding.available)).toBe(true);
    }

    const incompleteLean = new ToolRegistry().register({
      contract: {
        schemaVersion: 1,
        toolId: "math.lean",
        name: "Incomplete Lean adapter",
        version: "1.0.0",
        description: "Conformance fixture intentionally omits filesystem.read.",
        inputSchema: true,
        outputSchema: true,
        requiredCapabilities: ["process.execute"],
        sideEffects: ["process.execute"],
        determinism: "deterministic",
        supportsCancellation: true,
        defaultTimeoutMs: 1_000,
      },
      async execute(input) { return { output: input }; },
    });
    const report = inspectDomainPackConformance(packs.get("pure-mathematics")!, {
      tools: incompleteLean,
      verifiers: createCoreVerifierRegistry(),
    });
    expect(report.passed).toBe(false);
    expect(report.bindings.find((binding) => binding.adapterId === "math.lean")?.issues)
      .toEqual(["adapter contract omits capabilities: filesystem.read"]);
  });

  it("accepts a third-party pack without core edits and instantiates a portable template", async () => {
    const root = await sandbox("extension");
    const projectRoot = join(root, "project");
    const manifest: DomainPackManifest = {
      schemaVersion: 1,
      packId: "category-theory",
      name: "Category Theory",
      version: "1.0.0",
      description: "Third-party conformance fixture.",
      disciplines: ["category-theory"],
      semanticTypes: [{ typeId: "natural-transformation", name: "Natural transformation", mapsTo: "definition", requiredFields: ["statement"] }],
      adapters: [],
      templates: [{
        templateId: "diagram-chase",
        name: "Diagram chase",
        description: "Investigate a commutative diagram.",
        problemPrompt: "State the diagram and target morphism equality.",
        context: { discipline: "category-theory" },
        goal: "Produce a reviewed diagram chase.",
        workstreams: [{ workstreamId: "proof", name: "Proof", objective: "Chase the diagram.", requiredBindingIds: [] }],
        requiredArtifactRoles: ["proof"],
        completionPolicy: {
          schemaVersion: 1,
          policyId: "template.diagram-chase",
          name: "Diagram chase completion",
          rules: [{ ruleId: "claim", kind: "object_count", objectType: "claim", min: 1 }],
        },
      }],
    };
    const registry = new DomainPackRegistry().register(manifest);
    expect(domainPackDigest(registry.get("category-theory")!)).toMatch(/^sha256:[0-9a-f]{64}$/u);
    const instantiated = await instantiateDomainTemplate(projectRoot, registry, {
      packId: "category-theory",
      templateId: "diagram-chase",
      title: "Third-party pack project",
    });
    expect(instantiated.activation.content).toMatchObject({
      kind: "domain-pack-activation",
      adapterPolicy: "deny-by-default",
      allowedBindingIds: [],
    });
    expect(instantiated.workstreams).toHaveLength(1);
    expect((await verifyProject(projectRoot)).ok).toBe(true);

    expect(() => new DomainPackRegistry().register({
      ...manifest,
      description: "apiKey=not-allowed",
    })).toThrow("secret-like");
  });

  it("persists only explicitly authorized, available, capability-conforming adapters", async () => {
    const root = await sandbox("authorization");
    const projectRoot = join(root, "project");
    const registry = createBuiltInDomainPackRegistry();
    const instantiated = await instantiateDomainTemplate(projectRoot, registry, {
      packId: "pure-mathematics",
      templateId: "formalization-project",
      title: "Authorized formalization",
    });
    const decision = await authorizeDomainPackBindings(projectRoot, registry, {
      branchId: instantiated.project.manifest.defaultBranchId,
      packId: "pure-mathematics",
      allowedBindingIds: ["formal-report"],
      grantedCapabilities: [],
      tools: createCoreToolRegistry(),
      verifiers: createCoreVerifierRegistry(),
    });
    expect(decision.content).toMatchObject({
      kind: "domain-pack-binding-authorization",
      policy: "explicit-allow-list",
      authorizedAdapters: [{ bindingId: "formal-report", adapterId: "core.formal-report" }],
    });
    await expect(authorizeDomainPackBindings(projectRoot, registry, {
      branchId: instantiated.project.manifest.defaultBranchId,
      packId: "pure-mathematics",
      allowedBindingIds: ["lean"],
      grantedCapabilities: ["filesystem.read", "process.execute"],
      tools: createCoreToolRegistry(),
      verifiers: createCoreVerifierRegistry(),
    })).rejects.toThrow("unavailable or non-conforming");
  });

  it("drives RP-001, RP-002, and RP-003 through canonical state into verifiable research packages", async () => {
    const root = await sandbox("references");
    for (const referenceId of ["RP-001", "RP-002", "RP-003"] as const) {
      const projectRoot = join(root, referenceId.toLowerCase());
      const exportRoot = join(root, `${referenceId.toLowerCase()}-package`);
      const fixture = await createDomainReferenceFixture(projectRoot, referenceId);
      const branchId = fixture.domain.project.manifest.defaultBranchId;
      const evaluation = await evaluateReferenceProject(projectRoot, { referenceId, branchId });
      expect(evaluation.passed, JSON.stringify(evaluation.assertions, null, 2)).toBe(true);
      expect(evaluation.assertions.every((result) => result.assertionId.startsWith(`${referenceId}-A`))).toBe(true);
      const built = await buildResearchPackage(projectRoot, exportRoot, { referenceId, branchId });
      expect(built.manifest.acceptance.passed).toBe(true);
      expect(built.manifest.artifacts.length).toBeGreaterThanOrEqual(5);
      expect(built.manifest.digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
      expect(JSON.parse(await readFile(built.manifestPath, "utf8"))).toEqual(built.manifest);
      expect((await verifyProject(exportRoot)).ok).toBe(true);
    }
  }, 30_000);

  it("refuses to package a reference project after a required scientific result regresses", async () => {
    const root = await sandbox("regression");
    const projectRoot = join(root, "project");
    const exportRoot = join(root, "package");
    const fixture = await createDomainReferenceFixture(projectRoot, "RP-003");
    const branchId = fixture.domain.project.manifest.defaultBranchId;
    const numerical = listCurrentObjects(projectRoot, branchId)
      .find((object) => typeof object.content === "object" && object.content !== null && (object.content as Record<string, unknown>).kind === "numerical-reproduction")!;
    await putObject(projectRoot, {
      branchId,
      objectId: numerical.objectId,
      objectType: "evidence",
      content: { ...(numerical.content as Record<string, unknown>), maxRelativeEnergyDrift: 1e-3 },
    });
    const evaluation = await evaluateReferenceProject(projectRoot, { referenceId: "RP-003", branchId });
    expect(evaluation.assertions.find((result) => result.assertionId === "RP-003-A04")?.passed).toBe(false);
    await expect(buildResearchPackage(projectRoot, exportRoot, { referenceId: "RP-003", branchId }))
      .rejects.toThrow("RP-003-A04");
  });
});
