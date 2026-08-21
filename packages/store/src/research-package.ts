import { rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  canonicalJson,
  computeContentHash,
  type Actor,
  type ArtifactReference,
  type JsonValue,
  type ObjectEnvelope,
} from "@reasoning-workbench/project-format";

import { FileSystemArtifactStore } from "./cas.js";
import {
  createBuiltInDomainPackRegistry,
  instantiateDomainTemplate,
  type InstantiatedDomainProject,
} from "./domain-packs.js";
import { listVisibleArtifacts } from "./paper.js";
import {
  addEdge,
  exportProject,
  projectHistory,
  putObject,
  registerArtifactBytes,
  verifyProject,
} from "./project.js";
import {
  listCurrentObjects,
  listEdges,
  type ObjectProjection,
} from "./projection.js";

export const REFERENCE_PROJECT_IDS = ["RP-001", "RP-002", "RP-003"] as const;
export type ReferenceProjectId = (typeof REFERENCE_PROJECT_IDS)[number];

export interface ReferenceAcceptanceResult {
  readonly assertionId: string;
  readonly passed: boolean;
  readonly summary: string;
  readonly evidenceObjectIds: readonly string[];
  readonly evidenceArtifactIds: readonly string[];
}

export interface ReferenceProjectEvaluation {
  readonly referenceId: ReferenceProjectId;
  readonly passed: boolean;
  readonly assertions: readonly ReferenceAcceptanceResult[];
}

export interface ResearchPackageManifest {
  readonly schemaVersion: 1;
  readonly kind: "research-package";
  readonly referenceId: ReferenceProjectId;
  readonly projectId: string;
  readonly title: string;
  readonly branchId: string;
  readonly createdAt: string;
  readonly domainPack: {
    readonly packId: string;
    readonly packVersion: string;
    readonly manifestDigest: string;
    readonly templateId: string;
  };
  readonly eventHead: { readonly sequence: number; readonly eventHash: string };
  readonly objects: readonly {
    readonly objectId: string;
    readonly versionId: string;
    readonly objectType: string;
    readonly contentHash: string;
  }[];
  readonly artifacts: readonly ArtifactReference[];
  readonly unresolvedFailures: readonly { readonly objectId: string; readonly versionId: string }[];
  readonly acceptance: ReferenceProjectEvaluation;
  readonly digest: string;
}

export interface BuiltResearchPackage {
  readonly destinationRoot: string;
  readonly manifestPath: string;
  readonly manifest: ResearchPackageManifest;
}

export interface DomainReferenceFixture {
  readonly referenceId: ReferenceProjectId;
  readonly domain: InstantiatedDomainProject;
  readonly claims: readonly ObjectEnvelope[];
  readonly artifacts: readonly ArtifactReference[];
}

interface ArtifactDraft {
  readonly logicalName: string;
  readonly mediaType: string;
  readonly text: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function actorOption(actor: Actor | undefined): { actor?: Actor } {
  return actor === undefined ? {} : { actor };
}

function asReferenceId(value: string): ReferenceProjectId {
  if (!(REFERENCE_PROJECT_IDS as readonly string[]).includes(value)) {
    throw new TypeError(`referenceId must be one of ${REFERENCE_PROJECT_IDS.join(", ")}`);
  }
  return value as ReferenceProjectId;
}

function contentKind(object: ObjectProjection, kind: string): boolean {
  return isRecord(object.content) && object.content.kind === kind;
}

function assertion(
  assertionId: string,
  passed: boolean,
  summary: string,
  objects: readonly ObjectProjection[] = [],
  artifacts: readonly ArtifactReference[] = [],
): ReferenceAcceptanceResult {
  return {
    assertionId,
    passed,
    summary,
    evidenceObjectIds: objects.map((object) => object.objectId).sort(),
    evidenceArtifactIds: artifacts.map((artifact) => artifact.artifactId).sort(),
  };
}

async function registerFixtureArtifacts(
  projectRoot: string,
  branchId: string,
  referenceId: ReferenceProjectId,
  drafts: readonly ArtifactDraft[],
  actor?: Actor,
): Promise<ArtifactReference[]> {
  const environment = await putObject(projectRoot, {
    branchId,
    objectType: "environment",
    content: {
      schemaVersion: 1,
      kind: "reference-project-environment",
      referenceId,
      runtime: "portable-fixture",
      dependencies: [],
    },
    ...actorOption(actor),
  });
  let run = await putObject(projectRoot, {
    branchId,
    objectType: "run",
    content: {
      schemaVersion: 1,
      kind: "reference-project-run",
      referenceId,
      status: "running",
      environmentId: environment.objectId,
      permissions: ["project.artifact.write"],
      nondeterminism: "deterministic",
    },
    ...actorOption(actor),
  });
  const artifacts: ArtifactReference[] = [];
  for (const draft of drafts) {
    const registered = await registerArtifactBytes(
      projectRoot,
      new TextEncoder().encode(draft.text),
      {
        branchId,
        logicalName: draft.logicalName,
        mediaType: draft.mediaType,
        producedByRunId: run.objectId,
        environmentId: environment.objectId,
        reproducibility: "deterministic",
        ...actorOption(actor),
      },
    );
    artifacts.push(registered.artifact);
  }
  run = await putObject(projectRoot, {
    branchId,
    objectId: run.objectId,
    objectType: "run",
    content: {
      ...(run.content as Record<string, JsonValue>),
      status: "succeeded",
      artifactIds: artifacts.map((artifact) => artifact.artifactId),
    },
    ...actorOption(actor),
  });
  return artifacts;
}

async function createRp001(
  projectRoot: string,
  actor?: Actor,
): Promise<DomainReferenceFixture> {
  const domain = await instantiateDomainTemplate(
    projectRoot,
    createBuiltInDomainPackRegistry(),
    {
      packId: "pure-mathematics",
      templateId: "conjecture-exploration",
      title: "RP-001 — Euler Polynomial Investigation",
      problem: "Investigate p(n)=n^2+n+41 for non-negative integers while preserving failed conjectures.",
      context: {
        domain: "non-negative integers",
        polynomial: "p(n)=n^2+n+41",
        primeDefinition: "integer greater than 1 with exactly two positive divisors",
      },
      ...actorOption(actor),
    },
  );
  const branchId = domain.project.manifest.defaultBranchId;
  const universal = await putObject(projectRoot, {
    branchId,
    objectType: "claim",
    content: {
      reference: "RP-001-rejected",
      kind: "universal-primality-conjecture",
      statement: "For every non-negative integer n, n^2+n+41 is prime.",
      contextId: domain.context.objectId,
      status: "refuted",
    },
    ...actorOption(actor),
  });
  const finite = await putObject(projectRoot, {
    branchId,
    objectType: "claim",
    content: {
      reference: "RP-001-C01",
      kind: "finite-prime-range",
      statement: "For every integer n with 0 <= n <= 39, p(n) is prime.",
      contextId: domain.context.objectId,
      range: { min: 0, max: 39, inclusive: true },
    },
    ...actorOption(actor),
  });
  const counterexample = await putObject(projectRoot, {
    branchId,
    objectType: "claim",
    content: {
      reference: "RP-001-C02",
      kind: "first-composite",
      statement: "p(40)=1681=41^2 is the first composite value.",
      contextId: domain.context.objectId,
      n: 40,
      value: 1681,
      factors: [41, 41],
    },
    ...actorOption(actor),
  });
  const family = await putObject(projectRoot, {
    branchId,
    objectType: "claim",
    content: {
      reference: "RP-001-C03",
      kind: "infinite-composite-family",
      statement: "For every integer k >= 1, p(41k)=41(41k^2+k+1) is composite.",
      contextId: domain.context.objectId,
      kMin: 1,
      formula: "p(41k)=41(41k^2+k+1)",
    },
    ...actorOption(actor),
  });
  const artifacts = await registerFixtureArtifacts(projectRoot, branchId, "RP-001", [
    { logicalName: "rp001-enumeration.py", mediaType: "text/x-python", text: "for n in range(201):\n    print(n, n*n+n+41)\n" },
    { logicalName: "rp001-complete-range.csv", mediaType: "text/csv", text: "n,p,prime,factors\n0,41,true,41\n39,1601,true,1601\n40,1681,false,41*41\n" },
    { logicalName: "rp001-skeptical-review.md", mediaType: "text/markdown", text: "Finite evidence does not establish universal primality; n=40 refutes it.\n" },
    { logicalName: "rp001-working-paper.md", mediaType: "text/markdown", text: "# Euler polynomial\nThe finite range and infinite composite family are distinct claims.\n" },
    { logicalName: "rp001-provenance.json", mediaType: "application/json", text: "{\"referenceId\":\"RP-001\",\"reproducibility\":\"deterministic\"}\n" },
  ], actor);
  const evidence = await putObject(projectRoot, {
    branchId,
    objectType: "evidence",
    content: {
      schemaVersion: 1,
      kind: "complete-range-enumeration",
      outcome: "passed",
      range: { min: 0, max: 200 },
      artifactIds: artifacts.map((artifact) => artifact.artifactId),
      contextId: domain.context.objectId,
    },
    ...actorOption(actor),
  });
  await addEdge(projectRoot, {
    branchId,
    edgeType: "supports",
    fromObjectId: evidence.objectId,
    toObjectId: finite.objectId,
    contextId: domain.context.objectId,
    ...actorOption(actor),
  });
  await addEdge(projectRoot, {
    branchId,
    edgeType: "refutes",
    fromObjectId: evidence.objectId,
    toObjectId: universal.objectId,
    contextId: domain.context.objectId,
    ...actorOption(actor),
  });
  await putObject(projectRoot, {
    branchId,
    objectType: "failure",
    content: {
      schemaVersion: 1,
      kind: "rejected-universal-conjecture",
      status: "closed",
      claimRef: { objectId: universal.objectId, versionId: universal.versionId },
      counterexampleRef: { objectId: counterexample.objectId, versionId: counterexample.versionId },
    },
    ...actorOption(actor),
  });
  await putObject(projectRoot, {
    branchId,
    objectType: "review",
    content: {
      schemaVersion: 1,
      kind: "skeptical-review",
      outcome: "passed",
      summary: "The finite range cannot justify the rejected universal claim; k >= 1 is explicit.",
      claimRefs: [finite, counterexample, family].map((claim) => ({ objectId: claim.objectId, versionId: claim.versionId })),
    },
    ...actorOption(actor),
  });
  return { referenceId: "RP-001", domain, claims: [universal, finite, counterexample, family], artifacts };
}

async function createRp002(projectRoot: string, actor?: Actor): Promise<DomainReferenceFixture> {
  const domain = await instantiateDomainTemplate(projectRoot, createBuiltInDomainPackRegistry(), {
    packId: "pure-mathematics",
    templateId: "formalization-project",
    title: "RP-002 — Finite-Sum Formalization in Lean",
    problem: "Prove and formalize the inclusive finite-sum identity over Nat.",
    context: { domain: "natural numbers", rangeSemantics: "inclusive 0 through n", proofAssistant: "Lean 4" },
    ...actorOption(actor),
  });
  const branchId = domain.project.manifest.defaultBranchId;
  const informal = await putObject(projectRoot, {
    branchId,
    objectType: "claim",
    content: {
      reference: "RP-002-informal",
      kind: "theorem",
      statement: "For every n : Nat, 2 * (sum k for k=0,...,n) = n * (n+1).",
      contextId: domain.context.objectId,
    },
    ...actorOption(actor),
  });
  const formal = await putObject(projectRoot, {
    branchId,
    objectType: "claim",
    content: {
      reference: "RP-002-formal",
      kind: "formal-claim",
      language: "Lean 4",
      statement: "theorem twice_sum_zero_through_n (n : Nat) : 2 * (∑ k in Finset.range (n + 1), k) = n * (n + 1)",
      contextId: domain.context.objectId,
    },
    ...actorOption(actor),
  });
  const artifacts = await registerFixtureArtifacts(projectRoot, branchId, "RP-002", [
    { logicalName: "FiniteSum.lean", mediaType: "text/x-lean", text: "import Mathlib\n\ntheorem twice_sum_zero_through_n (n : Nat) :\n    2 * (∑ k in Finset.range (n + 1), k) = n * (n + 1) := by\n  induction n with\n  | zero => simp\n  | succ n ih => simp [Finset.sum_range_succ, ih, Nat.mul_add, Nat.add_mul]\n" },
    { logicalName: "lean-build.log", mediaType: "text/plain", text: "Build completed successfully; proof holes: 0\n" },
    { logicalName: "axiom-audit.json", mediaType: "application/json", text: "{\"projectAxioms\":[],\"status\":\"passed\"}\n" },
    { logicalName: "informal-proof.md", mediaType: "text/markdown", text: "Induct on n and add the next endpoint n+1.\n" },
    { logicalName: "rp002-provenance.json", mediaType: "application/json", text: "{\"referenceId\":\"RP-002\",\"toolchain\":\"Lean 4 + mathlib (fixture)\"}\n" },
  ], actor);
  const formalEvidence = await putObject(projectRoot, {
    branchId,
    objectType: "evidence",
    content: {
      schemaVersion: 1,
      kind: "formal-kernel-fixture-evidence",
      outcome: "passed",
      assurance: "formal-kernel",
      claimRef: { objectId: formal.objectId, versionId: formal.versionId },
      checks: ["kernel-build", "proof-holes", "axiom-audit", "dependency-graph", "compiler-output"],
      artifactIds: artifacts.map((artifact) => artifact.artifactId),
    },
    ...actorOption(actor),
  });
  await addEdge(projectRoot, {
    branchId,
    edgeType: "supports",
    fromObjectId: formalEvidence.objectId,
    toObjectId: formal.objectId,
    contextId: domain.context.objectId,
    ...actorOption(actor),
  });
  await putObject(projectRoot, {
    branchId,
    objectType: "alignment",
    content: {
      schemaVersion: 1,
      kind: "formal-statement-alignment",
      outcome: "passed",
      informalClaimRef: { objectId: informal.objectId, versionId: informal.versionId },
      formalClaimRef: { objectId: formal.objectId, versionId: formal.versionId },
      contextRef: { objectId: domain.context.objectId, versionId: domain.context.versionId },
      checks: ["domain", "quantifiers", "inclusive-endpoint", "conclusion"],
    },
    ...actorOption(actor),
  });
  await putObject(projectRoot, {
    branchId,
    objectType: "review",
    content: {
      schemaVersion: 1,
      kind: "axiom-and-alignment-review",
      outcome: "passed",
      summary: "No project axioms or proof holes; inclusive range and Nat domain align.",
      evidenceRef: { objectId: formalEvidence.objectId, versionId: formalEvidence.versionId },
    },
    ...actorOption(actor),
  });
  return { referenceId: "RP-002", domain, claims: [informal, formal], artifacts };
}

async function createRp003(projectRoot: string, actor?: Actor): Promise<DomainReferenceFixture> {
  const domain = await instantiateDomainTemplate(projectRoot, createBuiltInDomainPackRegistry(), {
    packId: "theoretical-physics",
    templateId: "symbolic-derivation",
    title: "RP-003 — Harmonic Oscillator Research Cycle",
    problem: "Derive and reproduce the one-dimensional harmonic oscillator under explicit SI conventions.",
    context: {
      units: "SI", timeDomain: "t >= 0", coordinate: "q(t) [m]", mass: "m > 0 [kg]",
      springConstant: "k > 0 [N/m]", initialConditions: { q0: "A", qDot0: 0 },
      referenceParameters: { mKg: 2, kNewtonPerMeter: 8, aMeter: 0.1 },
    },
    ...actorOption(actor),
  });
  const branchId = domain.project.manifest.defaultBranchId;
  const equation = await putObject(projectRoot, {
    branchId,
    objectType: "claim",
    content: { reference: "RP-003-C01", kind: "equation-of-motion", statement: "m q_ddot + k q = 0", restoringSign: "positive-k-on-left", contextId: domain.context.objectId },
    ...actorOption(actor),
  });
  const solution = await putObject(projectRoot, {
    branchId,
    objectType: "claim",
    content: { reference: "RP-003-C02", kind: "analytic-solution", statement: "omega=sqrt(k/m), q(t)=A cos(omega t)", contextId: domain.context.objectId, initialConditionsSatisfied: true },
    ...actorOption(actor),
  });
  const energy = await putObject(projectRoot, {
    branchId,
    objectType: "claim",
    content: { reference: "RP-003-C03", kind: "conserved-energy", statement: "E=(m/2)q_dot^2+(k/2)q^2 is constant", contextId: domain.context.objectId },
    ...actorOption(actor),
  });
  const artifacts = await registerFixtureArtifacts(projectRoot, branchId, "RP-003", [
    { logicalName: "oscillator.py", mediaType: "text/x-python", text: "# pinned high-accuracy integration and analytic comparison\n" },
    { logicalName: "trajectory.csv", mediaType: "text/csv", text: "t,q_numeric,q_analytic,energy\n0,0.1,0.1,0.04\n31.4159,0.1,0.1,0.04\n" },
    { logicalName: "metrics.json", mediaType: "application/json", text: "{\"periods\":10,\"maxAbsDisplacementErrorMeter\":2e-8,\"maxRelativeEnergyDrift\":4e-8}\n" },
    { logicalName: "comparison.svg", mediaType: "image/svg+xml", text: "<svg xmlns=\"http://www.w3.org/2000/svg\" role=\"img\"><title>analytic and numerical q(t)</title></svg>\n" },
    { logicalName: "rp003-provenance.json", mediaType: "application/json", text: "{\"referenceId\":\"RP-003\",\"parameters\":{\"m\":2,\"k\":8,\"A\":0.1}}\n" },
  ], actor);
  const physicalEvidence = await putObject(projectRoot, {
    branchId,
    objectType: "evidence",
    content: {
      schemaVersion: 1, kind: "physical-checks", outcome: "passed", contextId: domain.context.objectId,
      checks: { units: true, restoringSign: true, initialConditions: true, conservation: true, limitingCaseKToZero: true },
      claimRefs: [equation, solution, energy].map((claim) => ({ objectId: claim.objectId, versionId: claim.versionId })),
    },
    ...actorOption(actor),
  });
  const numericalEvidence = await putObject(projectRoot, {
    branchId,
    objectType: "evidence",
    content: {
      schemaVersion: 1, kind: "numerical-reproduction", outcome: "passed", contextId: domain.context.objectId,
      periods: 10, maxAbsDisplacementErrorMeter: 2e-8, maxRelativeEnergyDrift: 4e-8,
      thresholds: { maxAbsDisplacementErrorMeter: 1e-6, maxRelativeEnergyDrift: 1e-6 },
      artifactIds: artifacts.map((artifact) => artifact.artifactId),
    },
    ...actorOption(actor),
  });
  for (const claim of [equation, solution, energy]) {
    await addEdge(projectRoot, {
      branchId,
      edgeType: "supports",
      fromObjectId: physicalEvidence.objectId,
      toObjectId: claim.objectId,
      contextId: domain.context.objectId,
      ...actorOption(actor),
    });
  }
  await addEdge(projectRoot, {
    branchId,
    edgeType: "supports",
    fromObjectId: numericalEvidence.objectId,
    toObjectId: solution.objectId,
    contextId: domain.context.objectId,
    ...actorOption(actor),
  });
  await putObject(projectRoot, {
    branchId,
    objectType: "failure",
    content: {
      schemaVersion: 1,
      kind: "rejected-potential-sign-error",
      status: "closed",
      injectedLagrangian: "L=(m/2)q_dot^2+(k/2)q^2",
      rejection: "Wrong restoring sign; fails stability and limiting-case review.",
      evidenceRef: { objectId: physicalEvidence.objectId, versionId: physicalEvidence.versionId },
    },
    ...actorOption(actor),
  });
  return { referenceId: "RP-003", domain, claims: [equation, solution, energy], artifacts };
}

export async function createDomainReferenceFixture(
  projectRoot: string,
  referenceId: ReferenceProjectId,
  actor?: Actor,
): Promise<DomainReferenceFixture> {
  switch (asReferenceId(referenceId)) {
    case "RP-001": return createRp001(projectRoot, actor);
    case "RP-002": return createRp002(projectRoot, actor);
    case "RP-003": return createRp003(projectRoot, actor);
  }
}

async function artifactText(
  projectRoot: string,
  artifacts: readonly ArtifactReference[],
  logicalName: string,
): Promise<string | undefined> {
  const artifact = artifacts.find((candidate) => candidate.logicalName === logicalName);
  if (artifact === undefined) return undefined;
  return new TextDecoder().decode(await new FileSystemArtifactStore(projectRoot).read(artifact.digest));
}

function artifactsNamed(artifacts: readonly ArtifactReference[], names: readonly string[]): ArtifactReference[] {
  const expected = new Set(names);
  return artifacts.filter((artifact) => expected.has(artifact.logicalName));
}

async function evaluateRp001(
  objects: readonly ObjectProjection[],
  artifacts: readonly ArtifactReference[],
  edges: ReturnType<typeof listEdges>,
): Promise<ReferenceAcceptanceResult[]> {
  const universal = objects.find((object) => contentKind(object, "universal-primality-conjecture"));
  const failure = objects.find((object) => contentKind(object, "rejected-universal-conjecture"));
  const first = objects.find((object) => contentKind(object, "first-composite"));
  const finite = objects.find((object) => contentKind(object, "finite-prime-range"));
  const family = objects.find((object) => contentKind(object, "infinite-composite-family"));
  const review = objects.find((object) => contentKind(object, "skeptical-review"));
  const finiteRange = isRecord(finite?.content) && isRecord(finite.content.range) ? finite.content.range : undefined;
  const firstContent = isRecord(first?.content) ? first.content : undefined;
  const familyContent = isRecord(family?.content) ? family.content : undefined;
  const required = artifactsNamed(artifacts, ["rp001-enumeration.py", "rp001-complete-range.csv", "rp001-skeptical-review.md", "rp001-working-paper.md", "rp001-provenance.json"]);
  const finiteSupported = finite !== undefined && edges.some((edge) => edge.edgeType === "supports" && edge.toObjectId === finite.objectId);
  return [
    assertion("RP-001-A01", universal !== undefined && failure !== undefined && isRecord(universal.content) && universal.content.status === "refuted", "Rejected universal conjecture is retained with its failure record.", [universal, failure].filter(Boolean) as ObjectProjection[]),
    assertion("RP-001-A02", firstContent?.n === 40 && firstContent.value === 1681 && canonicalJson(firstContent.factors) === "[41,41]", "First composite is n=40, 1681=41*41.", first === undefined ? [] : [first]),
    assertion("RP-001-A03", finiteRange?.min === 0 && finiteRange.max === 39 && finiteSupported, "Finite claim is scoped to 0..39 and has exact support.", finite === undefined ? [] : [finite]),
    assertion("RP-001-A04", familyContent?.kMin === 1 && familyContent.formula === "p(41k)=41(41k^2+k+1)", "Infinite composite family is quantified for k>=1.", family === undefined ? [] : [family]),
    assertion("RP-001-A05", required.length === 5, "Code, dataset, review, paper, and provenance artifacts are present.", [], required),
    assertion("RP-001-A06", review !== undefined, "Skeptical review records why finite evidence was insufficient.", review === undefined ? [] : [review]),
  ];
}

async function evaluateRp002(
  projectRoot: string,
  objects: readonly ObjectProjection[],
  artifacts: readonly ArtifactReference[],
): Promise<ReferenceAcceptanceResult[]> {
  const formal = objects.find((object) => isRecord(object.content) && object.content.reference === "RP-002-formal");
  const formalStatement = isRecord(formal?.content) ? String(formal.content.statement ?? "") : "";
  const sourceArtifact = artifacts.find((artifact) => artifact.logicalName === "FiniteSum.lean");
  const source = await artifactText(projectRoot, artifacts, "FiniteSum.lean") ?? "";
  const build = await artifactText(projectRoot, artifacts, "lean-build.log") ?? "";
  const axiom = await artifactText(projectRoot, artifacts, "axiom-audit.json") ?? "";
  const evidence = objects.find((object) => contentKind(object, "formal-kernel-fixture-evidence"));
  const alignment = objects.find((object) => contentKind(object, "formal-statement-alignment"));
  const alignmentContent = isRecord(alignment?.content) ? alignment.content : undefined;
  const informalRef = isRecord(alignmentContent?.informalClaimRef) ? alignmentContent.informalClaimRef : undefined;
  const formalRef = isRecord(alignmentContent?.formalClaimRef) ? alignmentContent.formalClaimRef : undefined;
  const informal = objects.find((object) => object.objectId === informalRef?.objectId);
  const exactAlignment = alignmentContent?.outcome === "passed" && informal?.versionId === informalRef?.versionId && formal?.versionId === formalRef?.versionId;
  const required = artifactsNamed(artifacts, ["FiniteSum.lean", "lean-build.log", "axiom-audit.json", "informal-proof.md", "rp002-provenance.json"]);
  return [
    assertion("RP-002-A01", formalStatement.includes("n : Nat") && formalStatement.includes("Finset.range (n + 1)"), "Formal statement uses Nat and the inclusive range.", formal === undefined ? [] : [formal]),
    assertion("RP-002-A02", sourceArtifact !== undefined && !/\b(sorry|admit)\b/u.test(source) && build.includes("successfully") && evidence !== undefined, "Lean source contains no proof holes and has a successful build record.", evidence === undefined ? [] : [evidence], sourceArtifact === undefined ? [] : [sourceArtifact]),
    assertion("RP-002-A03", axiom.includes('"projectAxioms":[]') && axiom.includes('"status":"passed"'), "Axiom audit reports no project-introduced axioms.", [], artifactsNamed(artifacts, ["axiom-audit.json"])),
    assertion("RP-002-A04", exactAlignment, "Separate alignment checks exact informal/formal versions.", alignment === undefined ? [] : [alignment]),
    assertion("RP-002-A05", exactAlignment, "Alignment is current for both exact claim versions.", alignment === undefined ? [] : [alignment]),
    assertion("RP-002-A06", required.length === 5, "Formal source, build, audit, proof, and provenance are exportable.", [], required),
  ];
}

async function evaluateRp003(
  objects: readonly ObjectProjection[],
  artifacts: readonly ArtifactReference[],
): Promise<ReferenceAcceptanceResult[]> {
  const equation = objects.find((object) => contentKind(object, "equation-of-motion"));
  const solution = objects.find((object) => contentKind(object, "analytic-solution"));
  const physical = objects.find((object) => contentKind(object, "physical-checks"));
  const numerical = objects.find((object) => contentKind(object, "numerical-reproduction"));
  const failure = objects.find((object) => contentKind(object, "rejected-potential-sign-error"));
  const equationContent = isRecord(equation?.content) ? equation.content : undefined;
  const physicalChecks = isRecord(physical?.content) && isRecord(physical.content.checks) ? physical.content.checks : undefined;
  const numericalContent = isRecord(numerical?.content) ? numerical.content : undefined;
  const required = artifactsNamed(artifacts, ["oscillator.py", "trajectory.csv", "metrics.json", "comparison.svg", "rp003-provenance.json"]);
  return [
    assertion("RP-003-A01", equationContent?.statement === "m q_ddot + k q = 0" && equationContent.restoringSign === "positive-k-on-left", "Equation of motion has the restoring sign.", equation === undefined ? [] : [equation]),
    assertion("RP-003-A02", physicalChecks?.units === true && physicalChecks.restoringSign === true, "SI dimension and sign checks pass.", physical === undefined ? [] : [physical]),
    assertion("RP-003-A03", physicalChecks?.initialConditions === true && physicalChecks.conservation === true && solution !== undefined, "Analytic solution satisfies the equation, initial data, and conservation checks.", [physical, solution].filter(Boolean) as ObjectProjection[]),
    assertion("RP-003-A04", Number(numericalContent?.periods) >= 10 && Number(numericalContent?.maxAbsDisplacementErrorMeter) <= 1e-6 && Number(numericalContent?.maxRelativeEnergyDrift) <= 1e-6, "Ten-period numerical run meets displacement and energy thresholds.", numerical === undefined ? [] : [numerical]),
    assertion("RP-003-A05", required.some((artifact) => artifact.logicalName === "comparison.svg") && numerical !== undefined, "Figure is traced through the numerical evidence and artifact lineage.", numerical === undefined ? [] : [numerical], artifactsNamed(artifacts, ["comparison.svg", "trajectory.csv", "oscillator.py"])),
    assertion("RP-003-A06", failure !== undefined && isRecord(failure.content) && failure.content.status === "closed", "Injected wrong-sign potential is preserved and rejected.", failure === undefined ? [] : [failure]),
    assertion("RP-003-A07", required.length === 5, "Code, trajectory, metrics, figure, and provenance are exportable.", [], required),
  ];
}

export async function evaluateReferenceProject(
  projectRoot: string,
  options: { referenceId: ReferenceProjectId; branchId: string },
): Promise<ReferenceProjectEvaluation> {
  const referenceId = asReferenceId(options.referenceId);
  const objects = listCurrentObjects(projectRoot, options.branchId);
  const artifacts = await listVisibleArtifacts(projectRoot, options.branchId);
  const edges = listEdges(projectRoot, options.branchId);
  const assertions = referenceId === "RP-001"
    ? await evaluateRp001(objects, artifacts, edges)
    : referenceId === "RP-002"
      ? await evaluateRp002(projectRoot, objects, artifacts)
      : await evaluateRp003(objects, artifacts);
  return { referenceId, passed: assertions.every((result) => result.passed), assertions };
}

function activationFrom(objects: readonly ObjectProjection[]): ResearchPackageManifest["domainPack"] {
  const activation = objects.find((object) => contentKind(object, "domain-pack-activation"));
  if (activation === undefined || !isRecord(activation.content)) {
    throw new Error("Research package requires a domain-pack activation record");
  }
  const fields = ["packId", "packVersion", "manifestDigest", "templateId"] as const;
  for (const field of fields) {
    if (typeof activation.content[field] !== "string") throw new Error(`Domain-pack activation is missing ${field}`);
  }
  return {
    packId: String(activation.content.packId),
    packVersion: String(activation.content.packVersion),
    manifestDigest: String(activation.content.manifestDigest),
    templateId: String(activation.content.templateId),
  };
}

export async function buildResearchPackage(
  projectRoot: string,
  destinationRoot: string,
  options: { referenceId: ReferenceProjectId; branchId: string },
): Promise<BuiltResearchPackage> {
  const verification = await verifyProject(projectRoot);
  if (!verification.ok || verification.manifest === undefined) {
    throw new Error(`Cannot package an invalid project: ${verification.issues.map((issue) => issue.message).join("; ")}`);
  }
  const acceptance = await evaluateReferenceProject(projectRoot, options);
  if (!acceptance.passed) {
    const failed = acceptance.assertions.filter((result) => !result.passed).map((result) => result.assertionId);
    throw new Error(`Reference acceptance failed: ${failed.join(", ")}`);
  }
  const inspection = await exportProject(projectRoot, destinationRoot);
  const objects = listCurrentObjects(projectRoot, options.branchId);
  const artifacts = await listVisibleArtifacts(projectRoot, options.branchId);
  const events = await projectHistory(projectRoot);
  const head = events.at(-1);
  if (head === undefined) throw new Error("Cannot package a project without events");
  const unsigned = {
    schemaVersion: 1 as const,
    kind: "research-package" as const,
    referenceId: options.referenceId,
    projectId: inspection.manifest.projectId,
    title: inspection.manifest.title,
    branchId: options.branchId,
    createdAt: inspection.manifest.createdAt,
    domainPack: activationFrom(objects),
    eventHead: { sequence: head.sequence, eventHash: head.eventHash },
    objects: objects.map((object) => ({
      objectId: object.objectId,
      versionId: object.versionId,
      objectType: object.objectType,
      contentHash: object.contentHash,
    })).sort((left, right) => left.objectId.localeCompare(right.objectId)),
    artifacts,
    unresolvedFailures: objects
      .filter((object) => object.objectType === "failure" && isRecord(object.content) && object.content.status === "open")
      .map((object) => ({ objectId: object.objectId, versionId: object.versionId }))
      .sort((left, right) => left.objectId.localeCompare(right.objectId)),
    acceptance,
  };
  const manifest: ResearchPackageManifest = {
    ...unsigned,
    digest: computeContentHash(unsigned),
  };
  const destination = resolve(destinationRoot);
  const manifestPath = join(destination, "research-package.json");
  const temporaryPath = join(destination, `.research-package.${process.pid}.tmp`);
  await writeFile(temporaryPath, `${canonicalJson(manifest)}\n`, { encoding: "utf8", flag: "wx" });
  await rename(temporaryPath, manifestPath);
  return { destinationRoot: destination, manifestPath, manifest };
}
