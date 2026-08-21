import {
  OBJECT_TYPES,
  canonicalJson,
  computeContentHash,
  type Actor,
  type JsonValue,
  type ObjectEnvelope,
  type ObjectType,
} from "@reasoning-workbench/project-format";

import { redactSecretValue } from "./context.js";
import { assertCompletionPolicy, type CompletionPolicy } from "./policy.js";
import {
  addEdge,
  createProject,
  putObject,
  type CreatedProject,
} from "./project.js";
import {
  TOOL_CAPABILITIES,
  type ToolCapability,
  type ToolRegistry,
} from "./tools.js";
import type { VerifierRegistry } from "./verification.js";

export const DOMAIN_PACK_KINDS = [
  "pure-mathematics",
  "theoretical-physics",
  "computational-reasoning",
] as const;
export type BuiltInDomainPackId = (typeof DOMAIN_PACK_KINDS)[number];

export const DOMAIN_TEMPLATE_IDS = [
  "theorem-investigation",
  "conjecture-exploration",
  "symbolic-derivation",
  "pde-study",
  "literature-synthesis",
  "formalization-project",
  "computational-experiment",
] as const;
export type BuiltInDomainTemplateId = (typeof DOMAIN_TEMPLATE_IDS)[number];

export interface DomainSemanticType {
  readonly typeId: string;
  readonly name: string;
  readonly mapsTo: ObjectType;
  readonly requiredFields: readonly string[];
}

export interface DomainAdapterBinding {
  readonly bindingId: string;
  readonly adapterKind: "tool" | "verifier";
  readonly adapterId: string;
  readonly purpose: string;
  readonly requiredCapabilities: readonly ToolCapability[];
  readonly optional: boolean;
}

export interface DomainTemplateWorkstream {
  readonly workstreamId: string;
  readonly name: string;
  readonly objective: string;
  readonly requiredBindingIds: readonly string[];
}

export interface DomainProjectTemplate {
  readonly templateId: string;
  readonly name: string;
  readonly description: string;
  readonly problemPrompt: string;
  readonly context: Readonly<Record<string, JsonValue>>;
  readonly goal: string;
  readonly workstreams: readonly DomainTemplateWorkstream[];
  readonly requiredArtifactRoles: readonly string[];
  readonly completionPolicy: CompletionPolicy;
}

export interface DomainPackManifest {
  readonly schemaVersion: 1;
  readonly packId: string;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly disciplines: readonly string[];
  readonly semanticTypes: readonly DomainSemanticType[];
  readonly adapters: readonly DomainAdapterBinding[];
  readonly templates: readonly DomainProjectTemplate[];
}

export interface DomainBindingCheck {
  readonly bindingId: string;
  readonly adapterKind: "tool" | "verifier";
  readonly adapterId: string;
  readonly optional: boolean;
  readonly available: boolean;
  readonly conforms: boolean;
  readonly issues: readonly string[];
}

export interface DomainPackConformanceReport {
  readonly packId: string;
  readonly version: string;
  readonly manifestDigest: string;
  readonly passed: boolean;
  readonly bindings: readonly DomainBindingCheck[];
}

export interface InstantiatedDomainProject {
  readonly project: CreatedProject;
  readonly pack: DomainPackManifest;
  readonly template: DomainProjectTemplate;
  readonly activation: ObjectEnvelope;
  readonly problem: ObjectEnvelope;
  readonly context: ObjectEnvelope;
  readonly goal: ObjectEnvelope;
  readonly workstreams: readonly ObjectEnvelope[];
}

export class DomainPackAuthorizationError extends Error {
  public readonly bindingId: string;

  public constructor(bindingId: string, message: string) {
    super(message);
    this.name = "DomainPackAuthorizationError";
    this.bindingId = bindingId;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  return value;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`${label} contains unsupported field ${key}`);
  }
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw new TypeError(`${label}.${key} is required`);
    }
  }
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  if (value.includes("\0")) throw new TypeError(`${label} cannot contain NUL`);
  return value.trim();
}

function identifier(value: unknown, label: string): string {
  const checked = nonEmpty(value, label);
  if (!/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u.test(checked)) {
    throw new TypeError(`${label} must be a lowercase dotted identifier`);
  }
  return checked;
}

function uniqueStrings(value: unknown, label: string, allowEmpty = false): string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    throw new TypeError(`${label} must be ${allowEmpty ? "an" : "a non-empty"} array`);
  }
  const result = value.map((item, index) => nonEmpty(item, `${label}[${index}]`));
  if (new Set(result).size !== result.length) throw new TypeError(`${label} cannot contain duplicates`);
  return result;
}

function capabilities(value: unknown, label: string): ToolCapability[] {
  return uniqueStrings(value, label, true).map((capability) => {
    if (!(TOOL_CAPABILITIES as readonly string[]).includes(capability)) {
      throw new TypeError(`${label} contains unsupported capability ${capability}`);
    }
    return capability as ToolCapability;
  }).sort();
}

function secretFree<T>(value: T, label: string): T {
  if (canonicalJson(redactSecretValue(value)) !== canonicalJson(value)) {
    throw new TypeError(`${label} contains secret-like material`);
  }
  return JSON.parse(canonicalJson(value)) as T;
}

function actorOption(actor: Actor | undefined): { actor?: Actor } {
  return actor === undefined ? {} : { actor };
}

export function assertDomainPackManifest(value: unknown): asserts value is DomainPackManifest {
  const pack = record(value, "domain pack");
  exactKeys(pack, [
    "schemaVersion", "packId", "name", "version", "description", "disciplines",
    "semanticTypes", "adapters", "templates",
  ], "domain pack");
  if (pack.schemaVersion !== 1) throw new TypeError("domain pack.schemaVersion must be 1");
  identifier(pack.packId, "domain pack.packId");
  nonEmpty(pack.name, "domain pack.name");
  nonEmpty(pack.version, "domain pack.version");
  nonEmpty(pack.description, "domain pack.description");
  uniqueStrings(pack.disciplines, "domain pack.disciplines");

  if (!Array.isArray(pack.semanticTypes) || pack.semanticTypes.length === 0) {
    throw new TypeError("domain pack.semanticTypes must be a non-empty array");
  }
  const semanticIds = new Set<string>();
  for (const [index, candidate] of pack.semanticTypes.entries()) {
    const semantic = record(candidate, `domain pack.semanticTypes[${index}]`);
    exactKeys(semantic, ["typeId", "name", "mapsTo", "requiredFields"], `domain pack.semanticTypes[${index}]`);
    const typeId = identifier(semantic.typeId, `domain pack.semanticTypes[${index}].typeId`);
    if (semanticIds.has(typeId)) throw new TypeError(`duplicate semantic type ${typeId}`);
    semanticIds.add(typeId);
    nonEmpty(semantic.name, `domain pack.semanticTypes[${index}].name`);
    if (!(OBJECT_TYPES as readonly unknown[]).includes(semantic.mapsTo)) {
      throw new TypeError(`domain pack.semanticTypes[${index}].mapsTo is unsupported`);
    }
    uniqueStrings(semantic.requiredFields, `domain pack.semanticTypes[${index}].requiredFields`, true);
  }

  if (!Array.isArray(pack.adapters)) throw new TypeError("domain pack.adapters must be an array");
  const bindingIds = new Set<string>();
  for (const [index, candidate] of pack.adapters.entries()) {
    const binding = record(candidate, `domain pack.adapters[${index}]`);
    exactKeys(binding, [
      "bindingId", "adapterKind", "adapterId", "purpose", "requiredCapabilities", "optional",
    ], `domain pack.adapters[${index}]`);
    const bindingId = identifier(binding.bindingId, `domain pack.adapters[${index}].bindingId`);
    if (bindingIds.has(bindingId)) throw new TypeError(`duplicate domain adapter binding ${bindingId}`);
    bindingIds.add(bindingId);
    if (binding.adapterKind !== "tool" && binding.adapterKind !== "verifier") {
      throw new TypeError(`domain pack.adapters[${index}].adapterKind is unsupported`);
    }
    identifier(binding.adapterId, `domain pack.adapters[${index}].adapterId`);
    nonEmpty(binding.purpose, `domain pack.adapters[${index}].purpose`);
    capabilities(binding.requiredCapabilities, `domain pack.adapters[${index}].requiredCapabilities`);
    if (typeof binding.optional !== "boolean") {
      throw new TypeError(`domain pack.adapters[${index}].optional must be boolean`);
    }
  }

  if (!Array.isArray(pack.templates) || pack.templates.length === 0) {
    throw new TypeError("domain pack.templates must be a non-empty array");
  }
  const templateIds = new Set<string>();
  for (const [index, candidate] of pack.templates.entries()) {
    const template = record(candidate, `domain pack.templates[${index}]`);
    exactKeys(template, [
      "templateId", "name", "description", "problemPrompt", "context", "goal",
      "workstreams", "requiredArtifactRoles", "completionPolicy",
    ], `domain pack.templates[${index}]`);
    const templateId = identifier(template.templateId, `domain pack.templates[${index}].templateId`);
    if (templateIds.has(templateId)) throw new TypeError(`duplicate domain template ${templateId}`);
    templateIds.add(templateId);
    nonEmpty(template.name, `domain pack.templates[${index}].name`);
    nonEmpty(template.description, `domain pack.templates[${index}].description`);
    nonEmpty(template.problemPrompt, `domain pack.templates[${index}].problemPrompt`);
    record(template.context, `domain pack.templates[${index}].context`);
    nonEmpty(template.goal, `domain pack.templates[${index}].goal`);
    uniqueStrings(template.requiredArtifactRoles, `domain pack.templates[${index}].requiredArtifactRoles`);
    assertCompletionPolicy(template.completionPolicy);
    if (!Array.isArray(template.workstreams) || template.workstreams.length === 0) {
      throw new TypeError(`domain pack.templates[${index}].workstreams must be non-empty`);
    }
    const workstreamIds = new Set<string>();
    for (const [workstreamIndex, rawWorkstream] of template.workstreams.entries()) {
      const workstream = record(rawWorkstream, `domain pack.templates[${index}].workstreams[${workstreamIndex}]`);
      exactKeys(workstream, ["workstreamId", "name", "objective", "requiredBindingIds"], `domain pack.templates[${index}].workstreams[${workstreamIndex}]`);
      const workstreamId = identifier(workstream.workstreamId, `workstreamId`);
      if (workstreamIds.has(workstreamId)) throw new TypeError(`duplicate workstream ${workstreamId}`);
      workstreamIds.add(workstreamId);
      nonEmpty(workstream.name, "workstream.name");
      nonEmpty(workstream.objective, "workstream.objective");
      for (const bindingId of uniqueStrings(workstream.requiredBindingIds, "workstream.requiredBindingIds", true)) {
        if (!bindingIds.has(bindingId)) throw new TypeError(`template ${templateId} references unknown binding ${bindingId}`);
      }
    }
  }
  secretFree(value, "domain pack");
}

export function domainPackDigest(manifest: DomainPackManifest): string {
  assertDomainPackManifest(manifest);
  return computeContentHash(manifest);
}

export class DomainPackRegistry {
  readonly #packs = new Map<string, DomainPackManifest>();

  public register(candidate: DomainPackManifest): this {
    assertDomainPackManifest(candidate);
    const manifest = secretFree(candidate, "domain pack");
    if (this.#packs.has(manifest.packId)) throw new Error(`Domain pack ${manifest.packId} is already registered`);
    const existingTemplateIds = new Set(this.list().flatMap((pack) => pack.templates.map((template) => template.templateId)));
    const duplicateTemplate = manifest.templates.find((template) => existingTemplateIds.has(template.templateId));
    if (duplicateTemplate !== undefined) {
      throw new Error(`Domain template ${duplicateTemplate.templateId} is already registered by another pack`);
    }
    this.#packs.set(manifest.packId, manifest);
    return this;
  }

  public get(packId: string): DomainPackManifest | undefined {
    return this.#packs.get(packId);
  }

  public list(): readonly DomainPackManifest[] {
    return [...this.#packs.values()].sort((left, right) => left.packId.localeCompare(right.packId));
  }

  public template(templateId: string): { pack: DomainPackManifest; template: DomainProjectTemplate } | undefined {
    for (const pack of this.list()) {
      const template = pack.templates.find((candidate) => candidate.templateId === templateId);
      if (template !== undefined) return { pack, template };
    }
    return undefined;
  }
}

export async function authorizeDomainPackBindings(
  projectRoot: string,
  registry: DomainPackRegistry,
  options: {
    branchId: string;
    packId: string;
    allowedBindingIds: readonly string[];
    grantedCapabilities: readonly ToolCapability[];
    tools?: ToolRegistry;
    verifiers?: VerifierRegistry;
    actor?: Actor;
  },
): Promise<ObjectEnvelope> {
  const pack = registry.get(options.packId);
  if (pack === undefined) throw new Error(`Unknown domain pack: ${options.packId}`);
  const allowedBindingIds = uniqueStrings(options.allowedBindingIds, "allowedBindingIds", true).sort();
  const grantedCapabilities = capabilities(options.grantedCapabilities, "grantedCapabilities");
  const granted = new Set(grantedCapabilities);
  const conformance = inspectDomainPackConformance(pack, {
    ...(options.tools === undefined ? {} : { tools: options.tools }),
    ...(options.verifiers === undefined ? {} : { verifiers: options.verifiers }),
  });
  const authorizedAdapters = allowedBindingIds.map((bindingId) => {
    const binding = pack.adapters.find((candidate) => candidate.bindingId === bindingId);
    if (binding === undefined) {
      throw new DomainPackAuthorizationError(bindingId, `Unknown binding ${bindingId} in pack ${pack.packId}`);
    }
    const check = conformance.bindings.find((candidate) => candidate.bindingId === bindingId)!;
    if (!check.available || !check.conforms) {
      throw new DomainPackAuthorizationError(
        bindingId,
        `Binding ${bindingId} is unavailable or non-conforming: ${check.issues.join(", ") || "adapter missing"}`,
      );
    }
    const missing = binding.requiredCapabilities.filter((capability) => !granted.has(capability));
    if (missing.length > 0) {
      throw new DomainPackAuthorizationError(
        bindingId,
        `Binding ${bindingId} requires missing capabilities: ${missing.join(", ")}`,
      );
    }
    const definition = binding.adapterKind === "tool"
      ? options.tools?.get(binding.adapterId)
      : options.verifiers?.get(binding.adapterId);
    return {
      bindingId,
      adapterKind: binding.adapterKind,
      adapterId: binding.adapterId,
      contractDigest: computeContentHash(definition!.contract),
    };
  });
  return putObject(projectRoot, {
    branchId: options.branchId,
    objectType: "decision",
    content: {
      schemaVersion: 1,
      kind: "domain-pack-binding-authorization",
      packId: pack.packId,
      packVersion: pack.version,
      manifestDigest: domainPackDigest(pack),
      policy: "explicit-allow-list",
      grantedCapabilities,
      authorizedAdapters,
    },
    ...actorOption(options.actor),
  });
}

export function inspectDomainPackConformance(
  manifest: DomainPackManifest,
  options: { tools?: ToolRegistry; verifiers?: VerifierRegistry },
): DomainPackConformanceReport {
  assertDomainPackManifest(manifest);
  const bindings = manifest.adapters.map((binding): DomainBindingCheck => {
    const definition = binding.adapterKind === "tool"
      ? options.tools?.get(binding.adapterId)
      : options.verifiers?.get(binding.adapterId);
    const available = definition !== undefined;
    const contract = definition?.contract;
    const actualCapabilities = new Set(contract?.requiredCapabilities ?? []);
    const missingCapabilities = binding.requiredCapabilities.filter(
      (capability) => !actualCapabilities.has(capability),
    );
    const issues = [
      ...(!available && !binding.optional ? ["required adapter is unavailable"] : []),
      ...(available && missingCapabilities.length > 0
        ? [`adapter contract omits capabilities: ${missingCapabilities.join(", ")}`]
        : []),
    ];
    return {
      bindingId: binding.bindingId,
      adapterKind: binding.adapterKind,
      adapterId: binding.adapterId,
      optional: binding.optional,
      available,
      conforms: issues.length === 0,
      issues,
    };
  });
  return {
    packId: manifest.packId,
    version: manifest.version,
    manifestDigest: domainPackDigest(manifest),
    passed: bindings.every((binding) => binding.conforms),
    bindings,
  };
}

function commonPolicy(templateId: string): CompletionPolicy {
  return {
    schemaVersion: 1,
    policyId: `template.${templateId}`,
    name: `${templateId} baseline completion`,
    rules: [
      { ruleId: "context", kind: "object_count", objectType: "context", min: 1 },
      { ruleId: "claim", kind: "object_count", objectType: "claim", min: 1 },
      { ruleId: "evidence", kind: "object_count", objectType: "evidence", min: 1 },
      { ruleId: "artifact", kind: "artifact_count", min: 1 },
    ],
  };
}

function template(
  templateId: BuiltInDomainTemplateId,
  name: string,
  description: string,
  problemPrompt: string,
  context: Readonly<Record<string, JsonValue>>,
  goal: string,
  requiredArtifactRoles: readonly string[],
  workstreams: readonly DomainTemplateWorkstream[],
): DomainProjectTemplate {
  return {
    templateId,
    name,
    description,
    problemPrompt,
    context,
    goal,
    workstreams,
    requiredArtifactRoles,
    completionPolicy: commonPolicy(templateId),
  };
}

const PURE_MATHEMATICS_PACK: DomainPackManifest = {
  schemaVersion: 1,
  packId: "pure-mathematics",
  name: "Pure Mathematics",
  version: "1.0.0",
  description: "Theorem, conjecture, counterexample, solver, CAS, and formalization workflows.",
  disciplines: ["algebra", "analysis", "discrete-mathematics", "formal-mathematics", "number-theory"],
  semanticTypes: [
    { typeId: "theorem", name: "Theorem", mapsTo: "claim", requiredFields: ["statement", "contextId"] },
    { typeId: "lemma", name: "Lemma", mapsTo: "claim", requiredFields: ["statement", "contextId"] },
    { typeId: "conjecture", name: "Conjecture", mapsTo: "claim", requiredFields: ["statement", "contextId", "verificationDisposition"] },
    { typeId: "counterexample", name: "Counterexample", mapsTo: "evidence", requiredFields: ["claimRef", "witness"] },
  ],
  adapters: [
    { bindingId: "formal-report", adapterKind: "verifier", adapterId: "core.formal-report", purpose: "Lean proof build and axiom report shape", requiredCapabilities: [], optional: false },
    { bindingId: "symbolic-report", adapterKind: "verifier", adapterId: "core.symbolic-report", purpose: "CAS and SMT report shape", requiredCapabilities: [], optional: false },
    { bindingId: "lean", adapterKind: "tool", adapterId: "math.lean", purpose: "Lean kernel and lake build adapter", requiredCapabilities: ["filesystem.read", "process.execute"], optional: true },
    { bindingId: "sage", adapterKind: "tool", adapterId: "math.sage", purpose: "Sage symbolic and number-theory adapter", requiredCapabilities: ["process.execute"], optional: true },
    { bindingId: "gap", adapterKind: "tool", adapterId: "math.gap", purpose: "GAP computational algebra adapter", requiredCapabilities: ["process.execute"], optional: true },
    { bindingId: "pari", adapterKind: "tool", adapterId: "math.pari-gp", purpose: "PARI/GP number-theory adapter", requiredCapabilities: ["process.execute"], optional: true },
    { bindingId: "smt", adapterKind: "tool", adapterId: "math.smt-sat", purpose: "SMT/SAT solver adapter", requiredCapabilities: ["process.execute"], optional: true },
  ],
  templates: [
    template("theorem-investigation", "Theorem investigation", "Develop and independently check a theorem and its lemmas.", "State the theorem, domain, and intended strength.", { discipline: "pure-mathematics", truthStatus: "open" }, "Produce the strongest reviewed theorem supported by explicit proof dependencies.", ["proof", "review", "provenance-manifest"], [
      { workstreamId: "proof", name: "Proof exploration", objective: "Develop proof strategies and explicit lemma dependencies.", requiredBindingIds: ["symbolic-report"] },
      { workstreamId: "counterexample", name: "Counterexample search", objective: "Search finite and solver-generated counterexamples.", requiredBindingIds: ["smt"] },
      { workstreamId: "review", name: "Independent review", objective: "Check quantifiers, assumptions, and proof gaps.", requiredBindingIds: [] },
    ]),
    template("conjecture-exploration", "Conjecture exploration", "Combine computation, counterexample search, revision, and proof.", "Record the conjecture without hiding plausible failure modes.", { discipline: "experimental-mathematics", truthStatus: "conjecture" }, "Refine or refute the conjecture while preserving negative results.", ["dataset", "code", "failure-report", "working-paper", "provenance-manifest"], [
      { workstreamId: "enumeration", name: "Enumeration", objective: "Generate complete bounded evidence and counterexamples.", requiredBindingIds: ["sage"] },
      { workstreamId: "proof", name: "Pattern and proof", objective: "State a precisely quantified strongest result.", requiredBindingIds: ["symbolic-report"] },
      { workstreamId: "skeptic", name: "Skeptical review", objective: "Attempt refutation and preserve rejected conjectures.", requiredBindingIds: ["smt"] },
      { workstreamId: "synthesis", name: "Synthesis", objective: "Link claims, evidence, failures, and reviews.", requiredBindingIds: [] },
    ]),
    template("formalization-project", "Formalization project", "Align an informal theorem with a kernel-checked declaration.", "State the exact informal theorem and formalization target.", { discipline: "formal-mathematics", proofAssistant: "adapter-selected" }, "Produce a kernel build, axiom audit, and exact statement-alignment review.", ["informal-proof", "formal-source", "build-log", "axiom-audit", "alignment-review", "provenance-manifest"], [
      { workstreamId: "informal-proof", name: "Informal proof", objective: "Develop a comprehensible proof and lemma structure.", requiredBindingIds: [] },
      { workstreamId: "formalization", name: "Formalization", objective: "Build the exact statement without proof holes.", requiredBindingIds: ["lean", "formal-report"] },
      { workstreamId: "alignment", name: "Statement alignment", objective: "Review domain, quantifiers, endpoints, and conclusion.", requiredBindingIds: [] },
      { workstreamId: "review", name: "Independent review", objective: "Audit axioms, build evidence, and alignment.", requiredBindingIds: [] },
    ]),
  ],
};

const THEORETICAL_PHYSICS_PACK: DomainPackManifest = {
  schemaVersion: 1,
  packId: "theoretical-physics",
  name: "Theoretical Physics",
  version: "1.0.0",
  description: "Units, conventions, tensors, differential equations, perturbation, simulation, and limit checks.",
  disciplines: ["classical-mechanics", "field-theory", "general-relativity", "mathematical-physics", "quantum-theory"],
  semanticTypes: [
    { typeId: "convention", name: "Convention", mapsTo: "context", requiredFields: ["name", "value"] },
    { typeId: "physical-law", name: "Physical law", mapsTo: "claim", requiredFields: ["statement", "contextId"] },
    { typeId: "limiting-case", name: "Limiting case", mapsTo: "evidence", requiredFields: ["claimRef", "limit"] },
    { typeId: "perturbation-order", name: "Perturbation order", mapsTo: "assumption", requiredFields: ["parameter", "order"] },
  ],
  adapters: [
    { bindingId: "physical-report", adapterKind: "verifier", adapterId: "core.physical-report", purpose: "Units, symmetry, conservation, limits, and perturbation report", requiredCapabilities: [], optional: false },
    { bindingId: "symbolic-report", adapterKind: "verifier", adapterId: "core.symbolic-report", purpose: "Symbolic derivation report", requiredCapabilities: [], optional: false },
    { bindingId: "numerical-report", adapterKind: "verifier", adapterId: "core.numerical-report", purpose: "Numerical convergence and sensitivity report", requiredCapabilities: [], optional: false },
    { bindingId: "sympy", adapterKind: "tool", adapterId: "physics.sympy", purpose: "Symbolic algebra and ODE adapter", requiredCapabilities: ["process.execute"], optional: true },
    { bindingId: "tensor", adapterKind: "tool", adapterId: "physics.tensor", purpose: "Cadabra/xAct tensor-algebra adapter", requiredCapabilities: ["process.execute"], optional: true },
    { bindingId: "pde", adapterKind: "tool", adapterId: "physics.ode-pde", purpose: "ODE/PDE solve and discretization adapter", requiredCapabilities: ["process.execute"], optional: true },
    { bindingId: "simulation", adapterKind: "tool", adapterId: "physics.simulation", purpose: "Pinned numerical simulation adapter", requiredCapabilities: ["compute.local", "process.execute"], optional: true },
  ],
  templates: [
    template("symbolic-derivation", "Symbolic derivation", "Derive, check dimensions and limits, reproduce numerically, and synthesize.", "State the physical system, conventions, and target derivation.", { discipline: "theoretical-physics", units: "explicit", conventions: {} }, "Produce a scoped derivation with dimensional, limiting-case, and numerical evidence.", ["derivation", "simulation-data", "figure", "physical-review", "provenance-manifest"], [
      { workstreamId: "derivation", name: "Symbolic derivation", objective: "Derive equations and analytic solutions under exact conventions.", requiredBindingIds: ["sympy", "symbolic-report"] },
      { workstreamId: "physical-review", name: "Physical review", objective: "Check units, signs, symmetry, conservation, and limits.", requiredBindingIds: ["physical-report"] },
      { workstreamId: "numerics", name: "Numerical reproduction", objective: "Compare analytic and numerical results with declared thresholds.", requiredBindingIds: ["simulation", "numerical-report"] },
      { workstreamId: "synthesis", name: "Synthesis", objective: "Trace figures and claims to exact computations and conventions.", requiredBindingIds: [] },
    ]),
    template("pde-study", "PDE study", "Track geometry, boundary data, discretization, convergence, and limiting cases.", "State the PDE, domain, boundary/initial data, and solution notion.", { discipline: "theoretical-physics", equationClass: "PDE", units: "explicit" }, "Establish scoped analytic and numerical conclusions with convergence evidence.", ["equations", "mesh", "solver-code", "convergence-data", "figure", "provenance-manifest"], [
      { workstreamId: "formulation", name: "Formulation", objective: "Fix geometry, conventions, equations, and boundary data.", requiredBindingIds: ["tensor"] },
      { workstreamId: "analysis", name: "Analysis", objective: "Derive analytic properties and limiting cases.", requiredBindingIds: ["symbolic-report", "physical-report"] },
      { workstreamId: "numerics", name: "Numerics", objective: "Run a pinned discretization and convergence study.", requiredBindingIds: ["pde", "numerical-report"] },
    ]),
  ],
};

const COMPUTATIONAL_REASONING_PACK: DomainPackManifest = {
  schemaVersion: 1,
  packId: "computational-reasoning",
  name: "Computational Reasoning",
  version: "1.0.0",
  description: "Optimization, benchmarks, algorithm search, complexity experiments, and reproducible datasets.",
  disciplines: ["algorithm-design", "benchmarking", "machine-learning", "optimization", "scientific-computing"],
  semanticTypes: [
    { typeId: "algorithm", name: "Algorithm", mapsTo: "definition", requiredFields: ["description", "inputs", "outputs"] },
    { typeId: "benchmark-result", name: "Benchmark result", mapsTo: "evidence", requiredFields: ["datasetRef", "metrics", "runRef"] },
    { typeId: "complexity-claim", name: "Complexity claim", mapsTo: "claim", requiredFields: ["statement", "contextId", "costModel"] },
    { typeId: "dataset", name: "Dataset", mapsTo: "evidence", requiredFields: ["artifactRef", "schema"] },
  ],
  adapters: [
    { bindingId: "code-report", adapterKind: "verifier", adapterId: "core.code-report", purpose: "Tests, static checks, property checks, and clean environment report", requiredCapabilities: [], optional: false },
    { bindingId: "numerical-report", adapterKind: "verifier", adapterId: "core.numerical-report", purpose: "Benchmark stability and independent implementation report", requiredCapabilities: [], optional: false },
    { bindingId: "artifact-integrity", adapterKind: "verifier", adapterId: "core.artifact-integrity", purpose: "Dataset and result lineage verification", requiredCapabilities: [], optional: false },
    { bindingId: "jax", adapterKind: "tool", adapterId: "compute.jax", purpose: "JAX optimization and accelerator adapter", requiredCapabilities: ["compute.local", "process.execute"], optional: true },
    { bindingId: "benchmark", adapterKind: "tool", adapterId: "compute.benchmark", purpose: "Reproducible benchmark-suite adapter", requiredCapabilities: ["process.execute"], optional: true },
    { bindingId: "algorithm-search", adapterKind: "tool", adapterId: "compute.algorithm-search", purpose: "Bounded algorithm-search adapter", requiredCapabilities: ["compute.local", "process.execute"], optional: true },
    { bindingId: "evolutionary-search", adapterKind: "tool", adapterId: "compute.evolutionary-search", purpose: "Seeded evolutionary-search adapter", requiredCapabilities: ["compute.local", "process.execute"], optional: true },
  ],
  templates: [
    template("computational-experiment", "Computational experiment", "Run a reproducible benchmark or optimization study with independent checks.", "State the algorithmic question, datasets, metrics, and compute budget.", { discipline: "computational-reasoning", reproducibility: "required" }, "Produce reproducible datasets, benchmarks, sensitivity evidence, and scoped conclusions.", ["code", "dataset", "benchmark-results", "environment", "provenance-manifest"], [
      { workstreamId: "implementation", name: "Implementation", objective: "Implement and test candidate algorithms.", requiredBindingIds: ["code-report"] },
      { workstreamId: "benchmark", name: "Benchmark", objective: "Run pinned datasets, metrics, and baselines.", requiredBindingIds: ["benchmark", "numerical-report"] },
      { workstreamId: "search", name: "Algorithm search", objective: "Explore bounded candidates without hiding failed runs.", requiredBindingIds: ["algorithm-search"] },
      { workstreamId: "reproduction", name: "Independent reproduction", objective: "Re-run central results and verify artifact lineage.", requiredBindingIds: ["artifact-integrity"] },
    ]),
    template("literature-synthesis", "Literature synthesis", "Combine exact-source retrieval with computational comparison tables.", "State the literature question and inclusion criteria.", { discipline: "computational-reasoning", sourceReview: "required" }, "Produce a source-grounded synthesis with exact citations and reproducible comparison data.", ["source-library", "extraction-review", "comparison-dataset", "working-paper", "provenance-manifest"], [
      { workstreamId: "retrieval", name: "Retrieval", objective: "Find and anchor relevant source statements.", requiredBindingIds: [] },
      { workstreamId: "comparison", name: "Comparison", objective: "Build a reproducible structured comparison dataset.", requiredBindingIds: ["benchmark"] },
      { workstreamId: "review", name: "Source review", objective: "Check exact locations, assumptions, and statement strength.", requiredBindingIds: [] },
    ]),
  ],
};

export function createBuiltInDomainPackRegistry(): DomainPackRegistry {
  return new DomainPackRegistry()
    .register(PURE_MATHEMATICS_PACK)
    .register(THEORETICAL_PHYSICS_PACK)
    .register(COMPUTATIONAL_REASONING_PACK);
}

export async function instantiateDomainTemplate(
  projectRoot: string,
  registry: DomainPackRegistry,
  options: {
    packId: string;
    templateId: string;
    title: string;
    problem?: string;
    context?: Readonly<Record<string, JsonValue>>;
    goal?: string;
    actor?: Actor;
  },
): Promise<InstantiatedDomainProject> {
  const pack = registry.get(options.packId);
  if (pack === undefined) throw new Error(`Unknown domain pack: ${options.packId}`);
  const templateValue = pack.templates.find((candidate) => candidate.templateId === options.templateId);
  if (templateValue === undefined) throw new Error(`Template ${options.templateId} does not belong to ${pack.packId}`);
  const project = await createProject(projectRoot, { title: nonEmpty(options.title, "title"), ...actorOption(options.actor) });
  const branchId = project.manifest.defaultBranchId;
  const activation = await putObject(projectRoot, {
    branchId,
    objectType: "decision",
    content: {
      schemaVersion: 1,
      kind: "domain-pack-activation",
      packId: pack.packId,
      packVersion: pack.version,
      manifestDigest: domainPackDigest(pack),
      templateId: templateValue.templateId,
      adapterPolicy: "deny-by-default",
      allowedBindingIds: [],
    },
    ...actorOption(options.actor),
  });
  const problem = await putObject(projectRoot, {
    branchId,
    objectType: "problem",
    content: {
      statement: options.problem ?? templateValue.problemPrompt,
      domainPack: { packId: pack.packId, version: pack.version, templateId: templateValue.templateId },
    },
    ...actorOption(options.actor),
  });
  const context = await putObject(projectRoot, {
    branchId,
    objectType: "context",
    content: secretFree({
      ...templateValue.context,
      ...(options.context ?? {}),
      domainPack: { packId: pack.packId, version: pack.version },
    }, "template context"),
    ...actorOption(options.actor),
  });
  const goal = await putObject(projectRoot, {
    branchId,
    objectType: "goal",
    content: {
      statement: options.goal ?? templateValue.goal,
      contextId: context.objectId,
      completionPolicy: templateValue.completionPolicy,
      requiredArtifactRoles: templateValue.requiredArtifactRoles,
      domainPack: { packId: pack.packId, version: pack.version, templateId: templateValue.templateId },
    },
    ...actorOption(options.actor),
  });
  const workstreams: ObjectEnvelope[] = [];
  for (const specification of templateValue.workstreams) {
    const workstream = await putObject(projectRoot, {
      branchId,
      objectType: "workstream",
      content: {
        kind: "domain-template-workstream",
        workstreamId: specification.workstreamId,
        name: specification.name,
        objective: specification.objective,
        requiredBindingIds: specification.requiredBindingIds,
        contextId: context.objectId,
        packId: pack.packId,
        templateId: templateValue.templateId,
      },
      ...actorOption(options.actor),
    });
    workstreams.push(workstream);
    await addEdge(projectRoot, {
      branchId,
      edgeType: "depends_on",
      fromObjectId: workstream.objectId,
      toObjectId: goal.objectId,
      contextId: context.objectId,
      metadata: { relation: "domain template workstream contributes to goal" },
      ...actorOption(options.actor),
    });
  }
  await addEdge(projectRoot, {
    branchId,
    edgeType: "depends_on",
    fromObjectId: goal.objectId,
    toObjectId: problem.objectId,
    contextId: context.objectId,
    ...actorOption(options.actor),
  });
  return { project, pack, template: templateValue, activation, problem, context, goal, workstreams };
}
