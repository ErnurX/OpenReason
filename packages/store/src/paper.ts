import {
  ArtifactReferenceSchema,
  canonicalJson,
  sha256Digest,
  type Actor,
  type ArtifactReference,
  type ObjectEnvelope,
} from "@reasoning-workbench/project-format";

import { computeImpact, type GraphPathStep, type ImpactResult } from "./graph.js";
import { diffBranches, type BranchDiff, type ObjectDiffStatus } from "./merge.js";
import {
  addEdge,
  projectHistory,
  putObject,
} from "./project.js";
import {
  getObjectHistory,
  listBranches,
  listCurrentObjects,
  listEdges,
  type EdgeProjection,
  type ObjectProjection,
} from "./projection.js";
import { redactSecretValue } from "./context.js";
import { FileSystemArtifactStore } from "./cas.js";

export const WORKING_PAPER_SCHEMA_VERSION = 1 as const;

export const VERIFICATION_DIMENSIONS = [
  "logical",
  "symbolic",
  "numerical",
  "physical",
  "source",
  "reproducibility",
  "human-review",
  "formal",
] as const;

export type VerificationDimension = (typeof VERIFICATION_DIMENSIONS)[number];
export type VerificationOutcome = "passed" | "failed" | "inconclusive";
export const VERIFICATION_ASSURANCE_LEVELS = [
  "reported",
  "support",
  "machine-checked",
  "human-reviewed",
  "formal-kernel",
] as const;
export type VerificationAssurance = (typeof VERIFICATION_ASSURANCE_LEVELS)[number];
export type VerificationDimensionStatus =
  | "missing"
  | "supported"
  | "verified"
  | "failed"
  | "inconclusive"
  | "stale";

export interface PaperContextReference {
  objectId: string;
  versionId: string;
}

export interface PaperObjectReference extends PaperContextReference {
  contextId: string;
  contextVersionId: string;
  mode: "live" | "pinned";
  field?: string;
}

export interface PaperAnnotation {
  annotationId: string;
  kind: "note" | "warning" | "todo";
  text: string;
  references: PaperObjectReference[];
}

export interface PaperMarkdownBlock {
  blockId: string;
  kind: "markdown";
  text: string;
}

export interface PaperEquationBlock {
  blockId: string;
  kind: "equation";
  latex: string;
  label?: string;
}

export interface PaperTransclusionBlock {
  blockId: string;
  kind: "transclusion";
  reference: PaperObjectReference;
  label?: string;
}

export interface PaperArtifactBlock {
  blockId: string;
  kind: "artifact";
  artifact: ArtifactReference;
  role: "figure" | "table" | "dataset" | "listing" | "other";
  caption: string;
  altText?: string;
}

export interface PaperCitationBlock {
  blockId: string;
  kind: "citation";
  source: PaperObjectReference;
  locator: string;
  text?: string;
}

export interface PaperGapBlock {
  blockId: string;
  kind: "gap";
  gapId: string;
  statement: string;
  status: "open" | "resolved";
  related: PaperObjectReference[];
}

export interface PaperInternalLinkBlock {
  blockId: string;
  kind: "internal-link";
  targetSectionId: string;
  label: string;
}

export type WorkingPaperBlock =
  | PaperMarkdownBlock
  | PaperEquationBlock
  | PaperTransclusionBlock
  | PaperArtifactBlock
  | PaperCitationBlock
  | PaperGapBlock
  | PaperInternalLinkBlock;

export interface WorkingPaperSection {
  sectionId: string;
  title: string;
  context: PaperContextReference;
  annotations: PaperAnnotation[];
  blocks: WorkingPaperBlock[];
}

export interface WorkingPaper {
  schemaVersion: typeof WORKING_PAPER_SCHEMA_VERSION;
  kind: "working-paper";
  title: string;
  context: PaperContextReference;
  sections: WorkingPaperSection[];
}

export interface PutWorkingPaperOptions {
  branchId: string;
  paper: unknown;
  paperId?: string;
  actor?: Actor;
}

export interface WorkingPaperRecord {
  object: ObjectProjection;
  paper: WorkingPaper;
}

export interface PaperReferenceRender {
  sectionId: string;
  blockId: string;
  objectId: string;
  objectType: string;
  contextId: string;
  boundContextVersionId: string;
  currentContextVersionId: string;
  mode: "live" | "pinned";
  boundVersionId: string;
  currentVersionId: string;
  renderedVersionId: string;
  status: "current" | "outdated";
}

export interface PaperWarning {
  code:
    | "context-version-changed"
    | "reference-version-changed"
    | "open-gap";
  sectionId?: string;
  blockId?: string;
  objectId?: string;
  message: string;
}

export interface WorkingPaperInspection {
  branchId: string;
  paperId: string;
  paperVersionId: string;
  warnings: PaperWarning[];
  outdatedReferences: PaperReferenceRender[];
  openGapIds: string[];
  verificationProfiles: VerificationProfile[];
}

export interface WorkingPaperRender extends WorkingPaperInspection {
  format: "markdown" | "latex";
  text: string;
  digest: `sha256:${string}`;
  references: PaperReferenceRender[];
}

export interface VerificationObservation {
  evidenceObjectId: string;
  evidenceVersionId: string;
  dimension: VerificationDimension;
  outcome: VerificationOutcome;
  assurance: VerificationAssurance;
  summary: string;
  artifactId?: string;
  claimVersionId: string;
  contextVersionId: string;
  stale: boolean;
  staleReasons: string[];
}

export interface VerificationDimensionProfile {
  dimension: VerificationDimension;
  status: VerificationDimensionStatus;
  currentEvidenceObjectIds: string[];
  staleEvidenceObjectIds: string[];
  observations: VerificationObservation[];
}

export interface VerificationProfile {
  branchId: string;
  claimId: string;
  claimVersionId: string;
  contextId: string;
  contextVersionId: string;
  dimensions: VerificationDimensionProfile[];
}

export interface PromoteArtifactToEvidenceOptions {
  branchId: string;
  claimId: string;
  contextId: string;
  artifactId: string;
  dimension: VerificationDimension;
  outcome: VerificationOutcome;
  summary: string;
  actor?: Actor;
}

export interface PromotedArtifactEvidence {
  evidence: ObjectEnvelope;
  edge: Awaited<ReturnType<typeof addEdge>>;
  artifact: ArtifactReference;
}

export interface RecordVerificationReviewOptions {
  branchId: string;
  claimId: string;
  contextId: string;
  outcome: VerificationOutcome;
  summary: string;
  actor?: Actor;
}

export interface RecordedVerificationReview {
  review: ObjectEnvelope;
  edge: Awaited<ReturnType<typeof addEdge>>;
}

export interface PaperImpactWarning {
  code:
    | "changed-reference"
    | "stale-dependency"
    | "stale-evidence"
    | "stale-review"
    | "stale-artifact-producer"
    | "reference-version-changed";
  sectionId: string;
  blockId: string;
  contextId: string;
  objectId: string;
  depth: number;
  changedObjectIds: string[];
  paths: GraphPathStep[][];
  message: string;
}

export interface PaperSectionImpact {
  sectionId: string;
  contextId: string;
  warnings: PaperImpactWarning[];
}

export interface WorkingPaperImpact {
  branchId: string;
  paperId: string;
  paperVersionId: string;
  changedObjectIds: string[];
  affectedSections: PaperSectionImpact[];
  impact: ImpactResult;
}

export type SemanticChangeCategory =
  | "statement"
  | "assumption"
  | "context"
  | "evidence"
  | "review"
  | "document"
  | "other";

export interface SemanticObjectChange {
  objectId: string;
  objectType?: string;
  status: ObjectDiffStatus;
  category: SemanticChangeCategory;
  changedFields: string[];
  sourceVersionId?: string;
  targetVersionId?: string;
  sourceStatement?: string;
  targetStatement?: string;
  sourceProofStatus?: string;
  targetProofStatus?: string;
}

export interface SemanticDependencyChange {
  side: "source" | "target";
  edgeId: string;
  edgeType: string;
  fromObjectId: string;
  toObjectId: string;
  contextId?: string;
}

export interface SemanticBranchComparison {
  sourceBranchId: string;
  targetBranchId: string;
  baseSequence: number;
  branchDiff: BranchDiff;
  objectChanges: SemanticObjectChange[];
  byCategory: Record<SemanticChangeCategory, string[]>;
  proofStatusChanges: string[];
  dependencyChanges: SemanticDependencyChange[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  return value;
}

function allowedKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new TypeError(`${label} contains unsupported field ${key}`);
    }
  }
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  if (value.includes("\0")) throw new TypeError(`${label} cannot contain NUL`);
  return value;
}

function optionalString(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : stringValue(value, label);
}

function arrayValue(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  return value;
}

function enumValue<T extends string>(
  value: unknown,
  values: readonly T[],
  label: string,
): T {
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw new TypeError(`${label} must be one of ${values.join(", ")}`);
  }
  return value as T;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function currentObjectMap(
  projectRoot: string,
  branchId: string,
): Map<string, ObjectProjection> {
  return new Map(
    listCurrentObjects(projectRoot, branchId).map((object) => [
      object.objectId,
      object,
    ]),
  );
}

function assertBranch(projectRoot: string, branchId: string): void {
  if (!listBranches(projectRoot).some((branch) => branch.branchId === branchId)) {
    throw new Error(`Branch does not exist: ${branchId}`);
  }
}

function visibleVersion(
  projectRoot: string,
  current: ObjectProjection,
  versionId: string,
): ObjectProjection | undefined {
  const history = new Map(
    getObjectHistory(projectRoot, current.objectId).map((version) => [
      version.versionId,
      version,
    ]),
  );
  const seen = new Set<string>();
  let cursor: string | undefined = current.versionId;
  while (cursor !== undefined && !seen.has(cursor)) {
    seen.add(cursor);
    if (cursor === versionId) return history.get(cursor);
    const supersedes: unknown = history.get(cursor)?.envelope.supersedesVersionId;
    cursor = typeof supersedes === "string" ? supersedes : undefined;
  }
  return undefined;
}

function contextReference(
  projectRoot: string,
  objects: ReadonlyMap<string, ObjectProjection>,
  value: unknown,
  label: string,
): PaperContextReference {
  const input = record(value, label);
  allowedKeys(input, ["objectId", "versionId"], label);
  const objectId = stringValue(input.objectId, `${label}.objectId`);
  const current = objects.get(objectId);
  if (current === undefined || current.objectType !== "context") {
    throw new Error(`${label} must name a visible context object: ${objectId}`);
  }
  const versionId = optionalString(input.versionId, `${label}.versionId`) ?? current.versionId;
  if (visibleVersion(projectRoot, current, versionId) === undefined) {
    throw new Error(`${label} version ${versionId} is not visible on this branch`);
  }
  return { objectId, versionId };
}

function objectReference(
  projectRoot: string,
  objects: ReadonlyMap<string, ObjectProjection>,
  value: unknown,
  defaultContext: PaperContextReference,
  label: string,
): PaperObjectReference {
  const input = record(value, label);
  allowedKeys(
    input,
    ["objectId", "versionId", "contextId", "contextVersionId", "mode", "field"],
    label,
  );
  const objectId = stringValue(input.objectId, `${label}.objectId`);
  const current = objects.get(objectId);
  if (current === undefined) {
    throw new Error(`${label} object ${objectId} is not visible on this branch`);
  }
  if (current.objectType === "document") {
    throw new Error(`${label} cannot recursively transclude a document`);
  }
  const versionId = optionalString(input.versionId, `${label}.versionId`) ?? current.versionId;
  if (visibleVersion(projectRoot, current, versionId) === undefined) {
    throw new Error(`${label} version ${versionId} is not visible on this branch`);
  }
  const contextId = optionalString(input.contextId, `${label}.contextId`) ?? defaultContext.objectId;
  const context = objects.get(contextId);
  if (context === undefined || context.objectType !== "context") {
    throw new Error(`${label}.contextId must name a visible context: ${contextId}`);
  }
  const contextVersionId = optionalString(
    input.contextVersionId,
    `${label}.contextVersionId`,
  ) ?? (contextId === defaultContext.objectId ? defaultContext.versionId : context.versionId);
  if (visibleVersion(projectRoot, context, contextVersionId) === undefined) {
    throw new Error(`${label} context version ${contextVersionId} is not visible on this branch`);
  }
  const declaredContext = isRecord(current.content)
    ? current.content.contextId
    : undefined;
  if (typeof declaredContext === "string" && declaredContext !== contextId) {
    throw new Error(
      `${label} context ${contextId} conflicts with ${objectId}'s declared context ${declaredContext}`,
    );
  }
  const mode = input.mode === undefined
    ? "live"
    : enumValue(input.mode, ["live", "pinned"] as const, `${label}.mode`);
  const field = optionalString(input.field, `${label}.field`);
  return {
    objectId,
    versionId,
    contextId,
    contextVersionId,
    mode,
    ...(field === undefined ? {} : { field }),
  };
}

async function visibleArtifacts(
  projectRoot: string,
  branchId: string,
): Promise<ArtifactReference[]> {
  assertBranch(projectRoot, branchId);
  const events = await projectHistory(projectRoot);
  const parents = new Map<string, { parentBranchId?: string; baseSequence: number }>();
  const heads = new Map<string, number>();
  for (const event of events) {
    if (event.eventType === "BranchCreated") {
      const child = event.payload.branchId;
      const parent = event.payload.baseBranchId;
      if (typeof child === "string") {
        parents.set(child, {
          ...(typeof parent === "string" ? { parentBranchId: parent } : {}),
          baseSequence: typeof parent === "string" ? (heads.get(parent) ?? 0) : 0,
        });
      }
    }
    if (event.branchId !== undefined) heads.set(event.branchId, event.sequence);
  }
  const cutoffs = new Map<string, number>();
  const visited = new Set<string>();
  let cursor: string | undefined = branchId;
  let cutoff = Number.POSITIVE_INFINITY;
  while (cursor !== undefined && !visited.has(cursor)) {
    visited.add(cursor);
    cutoffs.set(cursor, cutoff);
    const parent = parents.get(cursor);
    if (parent?.parentBranchId === undefined) break;
    cutoff = Math.min(cutoff, parent.baseSequence);
    cursor = parent.parentBranchId;
  }
  const artifacts = new Map<string, ArtifactReference>();
  for (const event of events) {
    if (event.eventType !== "ArtifactRegistered" || event.branchId === undefined) continue;
    const branchCutoff = cutoffs.get(event.branchId);
    if (branchCutoff === undefined || event.sequence > branchCutoff) continue;
    const parsed = ArtifactReferenceSchema.safeParse(event.payload.artifact);
    if (parsed.success) artifacts.set(parsed.data.artifactId, parsed.data);
  }
  return [...artifacts.values()].sort((left, right) =>
    compareStrings(left.artifactId, right.artifactId),
  );
}

export async function listVisibleArtifacts(
  projectRoot: string,
  branchId: string,
): Promise<ArtifactReference[]> {
  return visibleArtifacts(projectRoot, branchId);
}

function normalizeAnnotation(
  projectRoot: string,
  objects: ReadonlyMap<string, ObjectProjection>,
  value: unknown,
  context: PaperContextReference,
  label: string,
): PaperAnnotation {
  const input = record(value, label);
  allowedKeys(input, ["annotationId", "kind", "text", "references"], label);
  return {
    annotationId: stringValue(input.annotationId, `${label}.annotationId`),
    kind: enumValue(input.kind, ["note", "warning", "todo"] as const, `${label}.kind`),
    text: stringValue(input.text, `${label}.text`),
    references: (input.references === undefined
      ? []
      : arrayValue(input.references, `${label}.references`)
    ).map((reference, index) =>
      objectReference(
        projectRoot,
        objects,
        reference,
        context,
        `${label}.references[${index}]`,
      ),
    ),
  };
}

function normalizeBlock(
  projectRoot: string,
  objects: ReadonlyMap<string, ObjectProjection>,
  artifacts: ReadonlyMap<string, ArtifactReference>,
  value: unknown,
  context: PaperContextReference,
  label: string,
): WorkingPaperBlock {
  const input = record(value, label);
  const kind = stringValue(input.kind, `${label}.kind`);
  const blockId = stringValue(input.blockId, `${label}.blockId`);
  if (kind === "markdown") {
    allowedKeys(input, ["blockId", "kind", "text"], label);
    return { blockId, kind, text: stringValue(input.text, `${label}.text`) };
  }
  if (kind === "equation") {
    allowedKeys(input, ["blockId", "kind", "latex", "label"], label);
    const equationLabel = optionalString(input.label, `${label}.label`);
    return {
      blockId,
      kind,
      latex: stringValue(input.latex, `${label}.latex`),
      ...(equationLabel === undefined ? {} : { label: equationLabel }),
    };
  }
  if (kind === "transclusion") {
    allowedKeys(input, ["blockId", "kind", "reference", "label"], label);
    const transclusionLabel = optionalString(input.label, `${label}.label`);
    return {
      blockId,
      kind,
      reference: objectReference(
        projectRoot,
        objects,
        input.reference,
        context,
        `${label}.reference`,
      ),
      ...(transclusionLabel === undefined ? {} : { label: transclusionLabel }),
    };
  }
  if (kind === "artifact") {
    allowedKeys(input, ["blockId", "kind", "artifact", "role", "caption", "altText"], label);
    const artifactInput = record(input.artifact, `${label}.artifact`);
    const artifactId = stringValue(artifactInput.artifactId, `${label}.artifact.artifactId`);
    const artifact = artifacts.get(artifactId);
    if (artifact === undefined) {
      throw new Error(`${label} artifact ${artifactId} is not visible on this branch`);
    }
    if (
      artifactInput.digest !== undefined &&
      artifactInput.digest !== artifact.digest
    ) {
      throw new Error(`${label} artifact digest does not match canonical history`);
    }
    const altText = optionalString(input.altText, `${label}.altText`);
    return {
      blockId,
      kind,
      artifact,
      role: enumValue(
        input.role,
        ["figure", "table", "dataset", "listing", "other"] as const,
        `${label}.role`,
      ),
      caption: stringValue(input.caption, `${label}.caption`),
      ...(altText === undefined ? {} : { altText }),
    };
  }
  if (kind === "citation") {
    allowedKeys(input, ["blockId", "kind", "source", "locator", "text"], label);
    const source = objectReference(
      projectRoot,
      objects,
      input.source,
      context,
      `${label}.source`,
    );
    const sourceObject = objects.get(source.objectId);
    if (sourceObject?.objectType !== "source") {
      throw new Error(`${label}.source must name a source object`);
    }
    const citationText = optionalString(input.text, `${label}.text`);
    return {
      blockId,
      kind,
      source,
      locator: stringValue(input.locator, `${label}.locator`),
      ...(citationText === undefined ? {} : { text: citationText }),
    };
  }
  if (kind === "gap") {
    allowedKeys(input, ["blockId", "kind", "gapId", "statement", "status", "related"], label);
    return {
      blockId,
      kind,
      gapId: stringValue(input.gapId, `${label}.gapId`),
      statement: stringValue(input.statement, `${label}.statement`),
      status: enumValue(input.status, ["open", "resolved"] as const, `${label}.status`),
      related: (input.related === undefined
        ? []
        : arrayValue(input.related, `${label}.related`)
      ).map((reference, index) =>
        objectReference(
          projectRoot,
          objects,
          reference,
          context,
          `${label}.related[${index}]`,
        ),
      ),
    };
  }
  if (kind === "internal-link") {
    allowedKeys(input, ["blockId", "kind", "targetSectionId", "label"], label);
    return {
      blockId,
      kind,
      targetSectionId: stringValue(input.targetSectionId, `${label}.targetSectionId`),
      label: stringValue(input.label, `${label}.label`),
    };
  }
  throw new TypeError(`${label}.kind is unsupported: ${kind}`);
}

async function normalizeWorkingPaper(
  projectRoot: string,
  branchId: string,
  value: unknown,
): Promise<WorkingPaper> {
  assertBranch(projectRoot, branchId);
  if (canonicalJson(redactSecretValue(value)) !== canonicalJson(value)) {
    throw new TypeError("Working paper contains secret-like material");
  }
  const input = record(value, "paper");
  allowedKeys(input, ["schemaVersion", "kind", "title", "context", "sections"], "paper");
  if (input.schemaVersion !== WORKING_PAPER_SCHEMA_VERSION) {
    throw new TypeError(`paper.schemaVersion must be ${WORKING_PAPER_SCHEMA_VERSION}`);
  }
  if (input.kind !== "working-paper") {
    throw new TypeError("paper.kind must be working-paper");
  }
  const objects = currentObjectMap(projectRoot, branchId);
  const context = contextReference(projectRoot, objects, input.context, "paper.context");
  const artifactMap = new Map(
    (await visibleArtifacts(projectRoot, branchId)).map((artifact) => [
      artifact.artifactId,
      artifact,
    ]),
  );
  const sectionIds = new Set<string>();
  const blockIds = new Set<string>();
  const annotationIds = new Set<string>();
  const gapIds = new Set<string>();
  const sections = arrayValue(input.sections, "paper.sections").map((value, index) => {
    const label = `paper.sections[${index}]`;
    const section = record(value, label);
    allowedKeys(section, ["sectionId", "title", "context", "annotations", "blocks"], label);
    const sectionId = stringValue(section.sectionId, `${label}.sectionId`);
    if (sectionIds.has(sectionId)) throw new TypeError(`Duplicate sectionId: ${sectionId}`);
    sectionIds.add(sectionId);
    const sectionContext = section.context === undefined
      ? context
      : contextReference(projectRoot, objects, section.context, `${label}.context`);
    const annotations = (section.annotations === undefined
      ? []
      : arrayValue(section.annotations, `${label}.annotations`)
    ).map((annotation, annotationIndex) => {
      const normalized = normalizeAnnotation(
        projectRoot,
        objects,
        annotation,
        sectionContext,
        `${label}.annotations[${annotationIndex}]`,
      );
      if (annotationIds.has(normalized.annotationId)) {
        throw new TypeError(`Duplicate annotationId: ${normalized.annotationId}`);
      }
      annotationIds.add(normalized.annotationId);
      return normalized;
    });
    const blocks = arrayValue(section.blocks, `${label}.blocks`).map((block, blockIndex) => {
      const normalized = normalizeBlock(
        projectRoot,
        objects,
        artifactMap,
        block,
        sectionContext,
        `${label}.blocks[${blockIndex}]`,
      );
      if (blockIds.has(normalized.blockId)) {
        throw new TypeError(`Duplicate blockId: ${normalized.blockId}`);
      }
      blockIds.add(normalized.blockId);
      if (normalized.kind === "gap") {
        if (gapIds.has(normalized.gapId)) {
          throw new TypeError(`Duplicate gapId: ${normalized.gapId}`);
        }
        gapIds.add(normalized.gapId);
      }
      return normalized;
    });
    return {
      sectionId,
      title: stringValue(section.title, `${label}.title`),
      context: sectionContext,
      annotations,
      blocks,
    };
  });
  const store = new FileSystemArtifactStore(projectRoot);
  for (const section of sections) {
    for (const block of section.blocks) {
      if (block.kind === "internal-link" && !sectionIds.has(block.targetSectionId)) {
        throw new TypeError(
          `Internal link ${block.blockId} targets missing section ${block.targetSectionId}`,
        );
      }
      if (block.kind === "artifact") {
        const verification = await store.verify(block.artifact.digest);
        if (!verification.valid || verification.size !== block.artifact.size) {
          throw new Error(
            `Artifact ${block.artifact.artifactId} failed CAS integrity verification`,
          );
        }
      }
    }
  }
  return {
    schemaVersion: WORKING_PAPER_SCHEMA_VERSION,
    kind: "working-paper",
    title: stringValue(input.title, "paper.title"),
    context,
    sections,
  };
}

function assertStoredContext(value: unknown, label: string): void {
  const context = record(value, label);
  allowedKeys(context, ["objectId", "versionId"], label);
  stringValue(context.objectId, `${label}.objectId`);
  stringValue(context.versionId, `${label}.versionId`);
}

function assertStoredReference(value: unknown, label: string): void {
  const reference = record(value, label);
  allowedKeys(
    reference,
    ["objectId", "versionId", "contextId", "contextVersionId", "mode", "field"],
    label,
  );
  stringValue(reference.objectId, `${label}.objectId`);
  stringValue(reference.versionId, `${label}.versionId`);
  stringValue(reference.contextId, `${label}.contextId`);
  stringValue(reference.contextVersionId, `${label}.contextVersionId`);
  enumValue(reference.mode, ["live", "pinned"] as const, `${label}.mode`);
  optionalString(reference.field, `${label}.field`);
}

function assertStoredBlock(value: unknown, label: string): void {
  const block = record(value, label);
  const kind = stringValue(block.kind, `${label}.kind`);
  stringValue(block.blockId, `${label}.blockId`);
  if (kind === "markdown") {
    allowedKeys(block, ["blockId", "kind", "text"], label);
    stringValue(block.text, `${label}.text`);
    return;
  }
  if (kind === "equation") {
    allowedKeys(block, ["blockId", "kind", "latex", "label"], label);
    stringValue(block.latex, `${label}.latex`);
    optionalString(block.label, `${label}.label`);
    return;
  }
  if (kind === "transclusion") {
    allowedKeys(block, ["blockId", "kind", "reference", "label"], label);
    assertStoredReference(block.reference, `${label}.reference`);
    optionalString(block.label, `${label}.label`);
    return;
  }
  if (kind === "artifact") {
    allowedKeys(block, ["blockId", "kind", "artifact", "role", "caption", "altText"], label);
    ArtifactReferenceSchema.parse(block.artifact);
    enumValue(
      block.role,
      ["figure", "table", "dataset", "listing", "other"] as const,
      `${label}.role`,
    );
    stringValue(block.caption, `${label}.caption`);
    optionalString(block.altText, `${label}.altText`);
    return;
  }
  if (kind === "citation") {
    allowedKeys(block, ["blockId", "kind", "source", "locator", "text"], label);
    assertStoredReference(block.source, `${label}.source`);
    stringValue(block.locator, `${label}.locator`);
    optionalString(block.text, `${label}.text`);
    return;
  }
  if (kind === "gap") {
    allowedKeys(block, ["blockId", "kind", "gapId", "statement", "status", "related"], label);
    stringValue(block.gapId, `${label}.gapId`);
    stringValue(block.statement, `${label}.statement`);
    enumValue(block.status, ["open", "resolved"] as const, `${label}.status`);
    arrayValue(block.related, `${label}.related`).forEach((reference, index) =>
      assertStoredReference(reference, `${label}.related[${index}]`),
    );
    return;
  }
  if (kind === "internal-link") {
    allowedKeys(block, ["blockId", "kind", "targetSectionId", "label"], label);
    stringValue(block.targetSectionId, `${label}.targetSectionId`);
    stringValue(block.label, `${label}.label`);
    return;
  }
  throw new TypeError(`${label}.kind is unsupported: ${kind}`);
}

function parseStoredWorkingPaper(value: unknown): WorkingPaper {
  const input = record(value, "working paper content");
  allowedKeys(input, ["schemaVersion", "kind", "title", "context", "sections"], "working paper content");
  if (input.schemaVersion !== 1 || input.kind !== "working-paper") {
    throw new TypeError("Document is not a Stage 7 working paper");
  }
  stringValue(input.title, "working paper content.title");
  assertStoredContext(input.context, "working paper content.context");
  const sectionIds = new Set<string>();
  const blockIds = new Set<string>();
  for (const [index, sectionValue] of arrayValue(
    input.sections,
    "working paper content.sections",
  ).entries()) {
    const label = `working paper content.sections[${index}]`;
    const section = record(sectionValue, label);
    allowedKeys(section, ["sectionId", "title", "context", "annotations", "blocks"], label);
    const sectionId = stringValue(section.sectionId, `${label}.sectionId`);
    if (sectionIds.has(sectionId)) throw new TypeError(`Duplicate sectionId: ${sectionId}`);
    sectionIds.add(sectionId);
    stringValue(section.title, `${label}.title`);
    assertStoredContext(section.context, `${label}.context`);
    arrayValue(section.annotations, `${label}.annotations`).forEach((annotationValue, annotationIndex) => {
      const annotationLabel = `${label}.annotations[${annotationIndex}]`;
      const annotation = record(annotationValue, annotationLabel);
      allowedKeys(annotation, ["annotationId", "kind", "text", "references"], annotationLabel);
      stringValue(annotation.annotationId, `${annotationLabel}.annotationId`);
      enumValue(annotation.kind, ["note", "warning", "todo"] as const, `${annotationLabel}.kind`);
      stringValue(annotation.text, `${annotationLabel}.text`);
      arrayValue(annotation.references, `${annotationLabel}.references`).forEach(
        (reference, referenceIndex) =>
          assertStoredReference(
            reference,
            `${annotationLabel}.references[${referenceIndex}]`,
          ),
      );
    });
    arrayValue(section.blocks, `${label}.blocks`).forEach((block, blockIndex) => {
      assertStoredBlock(block, `${label}.blocks[${blockIndex}]`);
      const blockId = (block as Record<string, unknown>).blockId as string;
      if (blockIds.has(blockId)) throw new TypeError(`Duplicate blockId: ${blockId}`);
      blockIds.add(blockId);
    });
  }
  const cloned = JSON.parse(canonicalJson(input)) as WorkingPaper;
  for (const section of cloned.sections) {
    for (const block of section.blocks) {
      if (block.kind === "internal-link" && !sectionIds.has(block.targetSectionId)) {
        throw new TypeError(
          `Internal link ${block.blockId} targets missing section ${block.targetSectionId}`,
        );
      }
    }
  }
  return cloned;
}

export async function putWorkingPaper(
  projectRoot: string,
  options: PutWorkingPaperOptions,
): Promise<ObjectEnvelope> {
  const paper = await normalizeWorkingPaper(projectRoot, options.branchId, options.paper);
  return putObject(projectRoot, {
    branchId: options.branchId,
    objectType: "document",
    content: paper as unknown as Record<string, unknown>,
    ...(options.paperId === undefined ? {} : { objectId: options.paperId }),
    ...(options.actor === undefined ? {} : { actor: options.actor }),
  });
}

export function getWorkingPaper(
  projectRoot: string,
  branchId: string,
  paperId: string,
): WorkingPaperRecord {
  assertBranch(projectRoot, branchId);
  const object = currentObjectMap(projectRoot, branchId).get(paperId);
  if (object === undefined || object.objectType !== "document") {
    throw new Error(`Working paper ${paperId} is not visible on branch ${branchId}`);
  }
  return { object, paper: parseStoredWorkingPaper(object.content) };
}

function referencesInBlock(block: WorkingPaperBlock): PaperObjectReference[] {
  if (block.kind === "transclusion") return [block.reference];
  if (block.kind === "citation") return [block.source];
  if (block.kind === "gap") return block.related;
  return [];
}

function selectedReferenceVersion(
  projectRoot: string,
  current: ObjectProjection,
  reference: PaperObjectReference,
): ObjectProjection {
  if (reference.mode === "live") return current;
  const selected = visibleVersion(projectRoot, current, reference.versionId);
  if (selected === undefined) {
    throw new Error(
      `Bound version ${reference.versionId} of ${reference.objectId} is no longer visible`,
    );
  }
  return selected;
}

function referenceRender(
  projectRoot: string,
  objects: ReadonlyMap<string, ObjectProjection>,
  sectionId: string,
  blockId: string,
  reference: PaperObjectReference,
): PaperReferenceRender {
  const current = objects.get(reference.objectId);
  if (current === undefined) {
    throw new Error(`Referenced object ${reference.objectId} is no longer visible`);
  }
  const currentContext = objects.get(reference.contextId);
  if (currentContext === undefined || currentContext.objectType !== "context") {
    throw new Error(`Referenced context ${reference.contextId} is no longer visible`);
  }
  const rendered = selectedReferenceVersion(projectRoot, current, reference);
  return {
    sectionId,
    blockId,
    objectId: reference.objectId,
    objectType: current.objectType,
    contextId: reference.contextId,
    boundContextVersionId: reference.contextVersionId,
    currentContextVersionId: currentContext.versionId,
    mode: reference.mode,
    boundVersionId: reference.versionId,
    currentVersionId: current.versionId,
    renderedVersionId: rendered.versionId,
    status:
      current.versionId === reference.versionId &&
      currentContext.versionId === reference.contextVersionId
        ? "current"
        : "outdated",
  };
}

function contentText(object: ObjectProjection, field?: string): string {
  if (field !== undefined) {
    if (!isRecord(object.content) || typeof object.content[field] !== "string") {
      throw new Error(`${object.objectId}@${object.versionId} has no string field ${field}`);
    }
    return object.content[field] as string;
  }
  if (isRecord(object.content)) {
    for (const key of [
      "statement",
      "summary",
      "title",
      "name",
      "objective",
      "brief",
      "observation",
      "question",
      "description",
    ]) {
      if (typeof object.content[key] === "string") return object.content[key] as string;
    }
  }
  return `\`\`\`json\n${JSON.stringify(object.content, null, 2)}\n\`\`\``;
}

function sectionAnchor(sectionId: string): string {
  return sectionId
    .toLowerCase()
    .replace(/[^a-z0-9\p{L}]+/gu, "-")
    .replace(/^-|-$/gu, "");
}

function renderMarkdownBlock(
  projectRoot: string,
  objects: ReadonlyMap<string, ObjectProjection>,
  block: WorkingPaperBlock,
): string {
  if (block.kind === "markdown") return block.text;
  if (block.kind === "equation") {
    return `${block.label === undefined ? "" : `**${block.label}**\n\n`}$$\n${block.latex}\n$$`;
  }
  if (block.kind === "transclusion") {
    const current = objects.get(block.reference.objectId);
    if (current === undefined) throw new Error(`Missing transclusion ${block.reference.objectId}`);
    const selected = selectedReferenceVersion(projectRoot, current, block.reference);
    const label = block.label ?? current.objectType;
    return `> **${label}** \`${current.objectId}@${selected.versionId}\`  \n> ${contentText(selected, block.reference.field).replace(/\n/gu, "\n> ")}`;
  }
  if (block.kind === "artifact") {
    const target = `artifact:${block.artifact.digest}`;
    if (block.role === "figure") {
      return `![${block.altText ?? block.caption}](${target})\n\n*${block.caption}* \`${block.artifact.artifactId}\``;
    }
    return `[${block.caption}](${target}) \`${block.artifact.artifactId}\` (${block.role})`;
  }
  if (block.kind === "citation") {
    const current = objects.get(block.source.objectId);
    if (current === undefined) throw new Error(`Missing source ${block.source.objectId}`);
    const selected = selectedReferenceVersion(projectRoot, current, block.source);
    return `${block.text ?? contentText(selected, block.source.field)} [\`${selected.objectId}@${selected.versionId}\`, ${block.locator}]`;
  }
  if (block.kind === "gap") {
    const marker = block.status === "open" ? "WARNING" : "NOTE";
    return `> [!${marker}] Gap ${block.gapId} — ${block.status}\n> ${block.statement}`;
  }
  return `[${block.label}](#${sectionAnchor(block.targetSectionId)})`;
}

function latexEscape(value: string): string {
  const replacements: Record<string, string> = {
    "\\": "\\textbackslash{}",
    "{": "\\{",
    "}": "\\}",
    "$": "\\$",
    "&": "\\&",
    "#": "\\#",
    "_": "\\_",
    "%": "\\%",
    "~": "\\textasciitilde{}",
    "^": "\\textasciicircum{}",
  };
  return value.replace(/[\\{}$&#_%~^]/gu, (character) => replacements[character] ?? character);
}

function latexLabel(value: string): string {
  return value.replace(/[^A-Za-z0-9:.-]+/gu, "-");
}

function renderLatexBlock(
  projectRoot: string,
  objects: ReadonlyMap<string, ObjectProjection>,
  block: WorkingPaperBlock,
): string {
  if (block.kind === "markdown") return latexEscape(block.text);
  if (block.kind === "equation") {
    const label = latexLabel(block.label ?? block.blockId);
    return `\\begin{equation}\n${block.latex}\n\\label{eq:${label}}\n\\end{equation}`;
  }
  if (block.kind === "transclusion") {
    const current = objects.get(block.reference.objectId);
    if (current === undefined) throw new Error(`Missing transclusion ${block.reference.objectId}`);
    const selected = selectedReferenceVersion(projectRoot, current, block.reference);
    return [
      "\\begin{quote}",
      `\\textbf{${latexEscape(block.label ?? current.objectType)}} ` +
        `\\texttt{${latexEscape(`${current.objectId}@${selected.versionId}`)}}\\\\`,
      latexEscape(contentText(selected, block.reference.field)),
      "\\end{quote}",
    ].join("\n");
  }
  if (block.kind === "artifact") {
    return [
      block.role === "figure" ? "\\begin{figure}[ht]" : "\\begin{quote}",
      "\\centering",
      `\\texttt{${latexEscape(`artifact:${block.artifact.digest}`)}}\\\\`,
      block.role === "figure"
        ? `\\caption{${latexEscape(block.caption)}}`
        : latexEscape(block.caption),
      block.role === "figure" ? "\\end{figure}" : "\\end{quote}",
    ].join("\n");
  }
  if (block.kind === "citation") {
    const current = objects.get(block.source.objectId);
    if (current === undefined) throw new Error(`Missing source ${block.source.objectId}`);
    const selected = selectedReferenceVersion(projectRoot, current, block.source);
    return `${latexEscape(block.text ?? contentText(selected, block.source.field))} ` +
      `\\textnormal{[\\texttt{${latexEscape(`${selected.objectId}@${selected.versionId}`)}}, ` +
      `${latexEscape(block.locator)}]}`;
  }
  if (block.kind === "gap") {
    return [
      "\\begin{quote}",
      `\\textbf{Gap ${latexEscape(block.gapId)} --- ${latexEscape(block.status)}}\\\\`,
      latexEscape(block.statement),
      "\\end{quote}",
    ].join("\n");
  }
  return `\\hyperref[sec:${latexLabel(block.targetSectionId)}]{${latexEscape(block.label)}}`;
}

interface VerificationRecordContent {
  dimension: VerificationDimension;
  outcome: VerificationOutcome;
  assurance: VerificationAssurance;
  summary: string;
  claimRef: PaperContextReference;
  contextRef: PaperContextReference;
  artifactId?: string;
}

function verificationEvidenceContent(
  object: ObjectProjection,
): VerificationRecordContent | undefined {
  if (object.objectType !== "evidence" || !isRecord(object.content)) return undefined;
  if (
    object.content.kind !== "artifact-verification-evidence" &&
    object.content.kind !== "verification-result"
  ) return undefined;
  const dimension = object.content.dimension;
  const outcome = object.content.outcome;
  const assurance = object.content.assurance ?? "support";
  const summary = object.content.summary;
  const claimRef = object.content.claimRef;
  const contextRef = object.content.contextRef;
  if (
    typeof dimension !== "string" ||
    !VERIFICATION_DIMENSIONS.includes(dimension as VerificationDimension) ||
    typeof outcome !== "string" ||
    !(["passed", "failed", "inconclusive"] as const).includes(outcome as VerificationOutcome) ||
    typeof assurance !== "string" ||
    !VERIFICATION_ASSURANCE_LEVELS.includes(assurance as VerificationAssurance) ||
    typeof summary !== "string" ||
    !isRecord(claimRef) ||
    typeof claimRef.objectId !== "string" ||
    typeof claimRef.versionId !== "string" ||
    !isRecord(contextRef) ||
    typeof contextRef.objectId !== "string" ||
    typeof contextRef.versionId !== "string"
  ) {
    return undefined;
  }
  const artifact = object.content.artifact;
  const artifactId = isRecord(artifact) && typeof artifact.artifactId === "string"
    ? artifact.artifactId
    : undefined;
  return {
    dimension: dimension as VerificationDimension,
    outcome: outcome as VerificationOutcome,
    assurance: assurance as VerificationAssurance,
    summary,
    claimRef: {
      objectId: claimRef.objectId,
      versionId: claimRef.versionId,
    },
    contextRef: {
      objectId: contextRef.objectId,
      versionId: contextRef.versionId,
    },
    ...(artifactId === undefined ? {} : { artifactId }),
  };
}

function verificationReviewContent(
  object: ObjectProjection,
): VerificationRecordContent | undefined {
  if (object.objectType !== "review" || !isRecord(object.content)) return undefined;
  if (
    object.content.kind !== "verification-review" &&
    object.content.kind !== "independent-verification-review"
  ) return undefined;
  const outcome = object.content.outcome;
  const summary = object.content.summary;
  const claimRef = object.content.claimRef;
  const contextRef = object.content.contextRef;
  if (
    typeof outcome !== "string" ||
    !(["passed", "failed", "inconclusive"] as const).includes(outcome as VerificationOutcome) ||
    typeof summary !== "string" ||
    !isRecord(claimRef) ||
    typeof claimRef.objectId !== "string" ||
    typeof claimRef.versionId !== "string" ||
    !isRecord(contextRef) ||
    typeof contextRef.objectId !== "string" ||
    typeof contextRef.versionId !== "string"
  ) {
    return undefined;
  }
  return {
    dimension: "human-review",
    outcome: outcome as VerificationOutcome,
    assurance: "human-reviewed",
    summary,
    claimRef: { objectId: claimRef.objectId, versionId: claimRef.versionId },
    contextRef: { objectId: contextRef.objectId, versionId: contextRef.versionId },
  };
}

function verificationRecordContent(
  object: ObjectProjection,
): VerificationRecordContent | undefined {
  return verificationEvidenceContent(object) ?? verificationReviewContent(object);
}

function evidenceEdgeIsCurrent(
  edges: readonly EdgeProjection[],
  evidence: ObjectProjection,
  claim: ObjectProjection,
  contextId: string,
): boolean {
  return edges.some((edge) => {
    if (edge.envelope.contextId !== contextId) return false;
    if (edge.edgeType === "supports" || edge.edgeType === "refutes") {
      return edge.fromObjectId === evidence.objectId &&
        edge.fromVersionId === evidence.versionId &&
        edge.toObjectId === claim.objectId &&
        edge.toVersionId === claim.versionId;
    }
    if (edge.edgeType === "tested_by") {
      return edge.fromObjectId === claim.objectId &&
        edge.fromVersionId === claim.versionId &&
        edge.toObjectId === evidence.objectId &&
        edge.toVersionId === evidence.versionId;
    }
    return false;
  });
}

function verificationStatus(
  current: readonly VerificationObservation[],
  all: readonly VerificationObservation[],
): VerificationDimensionStatus {
  if (current.some((observation) => observation.outcome === "failed")) return "failed";
  if (
    current.some(
      (observation) =>
        observation.outcome === "passed" && observation.assurance === "formal-kernel",
    )
  ) return "verified";
  if (current.some((observation) => observation.outcome === "passed")) return "supported";
  if (current.some((observation) => observation.outcome === "inconclusive")) {
    return "inconclusive";
  }
  return all.length > 0 ? "stale" : "missing";
}

export function deriveVerificationProfile(
  projectRoot: string,
  options: { branchId: string; claimId: string; contextId: string },
): VerificationProfile {
  assertBranch(projectRoot, options.branchId);
  const objects = currentObjectMap(projectRoot, options.branchId);
  const claim = objects.get(options.claimId);
  if (claim === undefined || claim.objectType !== "claim") {
    throw new Error(`Claim ${options.claimId} is not visible on branch ${options.branchId}`);
  }
  const context = objects.get(options.contextId);
  if (context === undefined || context.objectType !== "context") {
    throw new Error(`Context ${options.contextId} is not visible on branch ${options.branchId}`);
  }
  const declaredContext = isRecord(claim.content) ? claim.content.contextId : undefined;
  if (typeof declaredContext === "string" && declaredContext !== context.objectId) {
    throw new Error(`Claim ${claim.objectId} is scoped to context ${declaredContext}`);
  }
  const edges = listEdges(projectRoot, options.branchId);
  const observations = [...objects.values()]
    .map((object) => ({
      object,
      content: verificationRecordContent(object),
    }))
    .filter(
      (entry): entry is {
        object: ObjectProjection;
        content: VerificationRecordContent;
      } =>
        entry.content !== undefined &&
        entry.content.claimRef.objectId === claim.objectId &&
        entry.content.contextRef.objectId === context.objectId,
    )
    .map(({ object, content }): VerificationObservation => {
      const staleReasons: string[] = [];
      if (content.claimRef.versionId !== claim.versionId) staleReasons.push("claim-version-changed");
      if (content.contextRef.versionId !== context.versionId) staleReasons.push("context-version-changed");
      if (!evidenceEdgeIsCurrent(edges, object, claim, context.objectId)) {
        staleReasons.push("exact-version-evidence-edge-missing");
      }
      return {
        evidenceObjectId: object.objectId,
        evidenceVersionId: object.versionId,
        dimension: content.dimension,
        outcome: content.outcome,
        assurance: content.assurance,
        summary: content.summary,
        ...(content.artifactId === undefined ? {} : { artifactId: content.artifactId }),
        claimVersionId: content.claimRef.versionId,
        contextVersionId: content.contextRef.versionId,
        stale: staleReasons.length > 0,
        staleReasons,
      };
    })
    .sort(
      (left, right) =>
        compareStrings(left.dimension, right.dimension) ||
        compareStrings(left.evidenceObjectId, right.evidenceObjectId),
    );
  const dimensions = VERIFICATION_DIMENSIONS.map((dimension) => {
    const selected = observations.filter((observation) => observation.dimension === dimension);
    const current = selected.filter((observation) => !observation.stale);
    return {
      dimension,
      status: verificationStatus(current, selected),
      currentEvidenceObjectIds: current.map((observation) => observation.evidenceObjectId),
      staleEvidenceObjectIds: selected
        .filter((observation) => observation.stale)
        .map((observation) => observation.evidenceObjectId),
      observations: selected,
    } satisfies VerificationDimensionProfile;
  });
  return {
    branchId: options.branchId,
    claimId: claim.objectId,
    claimVersionId: claim.versionId,
    contextId: context.objectId,
    contextVersionId: context.versionId,
    dimensions,
  };
}

export async function promoteArtifactToEvidence(
  projectRoot: string,
  options: PromoteArtifactToEvidenceOptions,
): Promise<PromotedArtifactEvidence> {
  assertBranch(projectRoot, options.branchId);
  enumValue(options.dimension, VERIFICATION_DIMENSIONS, "dimension");
  enumValue(options.outcome, ["passed", "failed", "inconclusive"] as const, "outcome");
  const summary = stringValue(options.summary, "summary");
  if (canonicalJson(redactSecretValue(summary)) !== canonicalJson(summary)) {
    throw new TypeError("Evidence summary contains secret-like material");
  }
  const objects = currentObjectMap(projectRoot, options.branchId);
  const claim = objects.get(options.claimId);
  if (claim === undefined || claim.objectType !== "claim") {
    throw new Error(`Claim ${options.claimId} is not visible on branch ${options.branchId}`);
  }
  const context = objects.get(options.contextId);
  if (context === undefined || context.objectType !== "context") {
    throw new Error(`Context ${options.contextId} is not visible on branch ${options.branchId}`);
  }
  const declaredContext = isRecord(claim.content) ? claim.content.contextId : undefined;
  if (typeof declaredContext === "string" && declaredContext !== context.objectId) {
    throw new Error(`Claim ${claim.objectId} is scoped to context ${declaredContext}`);
  }
  const artifact = (await visibleArtifacts(projectRoot, options.branchId)).find(
    (candidate) => candidate.artifactId === options.artifactId,
  );
  if (artifact === undefined) {
    throw new Error(`Artifact ${options.artifactId} is not visible on branch ${options.branchId}`);
  }
  const verification = await new FileSystemArtifactStore(projectRoot).verify(
    artifact.digest,
  );
  if (!verification.valid || verification.size !== artifact.size) {
    throw new Error(`Artifact ${artifact.artifactId} failed CAS integrity verification`);
  }
  const evidence = await putObject(projectRoot, {
    branchId: options.branchId,
    objectType: "evidence",
    content: {
      schemaVersion: 1,
      kind: "artifact-verification-evidence",
      dimension: options.dimension,
      outcome: options.outcome,
      assurance: "support",
      summary,
      claimRef: { objectId: claim.objectId, versionId: claim.versionId },
      contextRef: { objectId: context.objectId, versionId: context.versionId },
      artifact,
      provenance: {
        producedByRunId: artifact.producedByRunId,
        environmentId: artifact.environmentId,
        reproducibility: artifact.reproducibility,
      },
    },
    ...(options.actor === undefined ? {} : { actor: options.actor }),
  });
  const edgeType = options.outcome === "passed"
    ? "supports"
    : options.outcome === "failed"
      ? "refutes"
      : "tested_by";
  const edge = await addEdge(projectRoot, {
    branchId: options.branchId,
    edgeType,
    ...(edgeType === "tested_by"
      ? { fromObjectId: claim.objectId, toObjectId: evidence.objectId }
      : { fromObjectId: evidence.objectId, toObjectId: claim.objectId }),
    contextId: context.objectId,
    metadata: {
      verificationDimension: options.dimension,
      outcome: options.outcome,
      artifactId: artifact.artifactId,
    },
    ...(options.actor === undefined ? {} : { actor: options.actor }),
  });
  return { evidence, edge, artifact };
}

export async function recordVerificationReview(
  projectRoot: string,
  options: RecordVerificationReviewOptions,
): Promise<RecordedVerificationReview> {
  assertBranch(projectRoot, options.branchId);
  enumValue(options.outcome, ["passed", "failed", "inconclusive"] as const, "outcome");
  const summary = stringValue(options.summary, "summary");
  if (canonicalJson(redactSecretValue(summary)) !== canonicalJson(summary)) {
    throw new TypeError("Review summary contains secret-like material");
  }
  const objects = currentObjectMap(projectRoot, options.branchId);
  const claim = objects.get(options.claimId);
  if (claim === undefined || claim.objectType !== "claim") {
    throw new Error(`Claim ${options.claimId} is not visible on branch ${options.branchId}`);
  }
  const context = objects.get(options.contextId);
  if (context === undefined || context.objectType !== "context") {
    throw new Error(`Context ${options.contextId} is not visible on branch ${options.branchId}`);
  }
  const declaredContext = isRecord(claim.content) ? claim.content.contextId : undefined;
  if (typeof declaredContext === "string" && declaredContext !== context.objectId) {
    throw new Error(`Claim ${claim.objectId} is scoped to context ${declaredContext}`);
  }
  const review = await putObject(projectRoot, {
    branchId: options.branchId,
    objectType: "review",
    content: {
      schemaVersion: 1,
      kind: "verification-review",
      outcome: options.outcome,
      summary,
      claimRef: { objectId: claim.objectId, versionId: claim.versionId },
      contextRef: { objectId: context.objectId, versionId: context.versionId },
    },
    ...(options.actor === undefined ? {} : { actor: options.actor }),
  });
  const edgeType = options.outcome === "passed"
    ? "supports"
    : options.outcome === "failed"
      ? "refutes"
      : "tested_by";
  const edge = await addEdge(projectRoot, {
    branchId: options.branchId,
    edgeType,
    ...(edgeType === "tested_by"
      ? { fromObjectId: claim.objectId, toObjectId: review.objectId }
      : { fromObjectId: review.objectId, toObjectId: claim.objectId }),
    contextId: context.objectId,
    metadata: { verificationDimension: "human-review", outcome: options.outcome },
    ...(options.actor === undefined ? {} : { actor: options.actor }),
  });
  return { review, edge };
}

function inspectPaperReferences(
  projectRoot: string,
  branchId: string,
  record: WorkingPaperRecord,
): {
  references: PaperReferenceRender[];
  warnings: PaperWarning[];
  openGapIds: string[];
  verificationProfiles: VerificationProfile[];
} {
  const objects = currentObjectMap(projectRoot, branchId);
  const references: PaperReferenceRender[] = [];
  const warnings: PaperWarning[] = [];
  const currentContext = objects.get(record.paper.context.objectId);
  if (
    currentContext !== undefined &&
    currentContext.versionId !== record.paper.context.versionId
  ) {
    warnings.push({
      code: "context-version-changed",
      objectId: currentContext.objectId,
      message: `Paper context moved from ${record.paper.context.versionId} to ${currentContext.versionId}`,
    });
  }
  const openGapIds: string[] = [];
  const claimContexts = new Map<string, string>();
  for (const section of record.paper.sections) {
    const sectionContext = objects.get(section.context.objectId);
    if (
      sectionContext !== undefined &&
      sectionContext.versionId !== section.context.versionId
    ) {
      warnings.push({
        code: "context-version-changed",
        sectionId: section.sectionId,
        objectId: section.context.objectId,
        message: `Section context moved from ${section.context.versionId} to ${sectionContext.versionId}`,
      });
    }
    for (const annotation of section.annotations) {
      for (const reference of annotation.references) {
        const rendered = referenceRender(
          projectRoot,
          objects,
          section.sectionId,
          `annotation:${annotation.annotationId}`,
          reference,
        );
        references.push(rendered);
      }
    }
    for (const block of section.blocks) {
      for (const reference of referencesInBlock(block)) {
        const rendered = referenceRender(
          projectRoot,
          objects,
          section.sectionId,
          block.blockId,
          reference,
        );
        references.push(rendered);
        if (rendered.objectType === "claim") {
          claimContexts.set(rendered.objectId, rendered.contextId);
        }
      }
      if (block.kind === "gap" && block.status === "open") {
        openGapIds.push(block.gapId);
        warnings.push({
          code: "open-gap",
          sectionId: section.sectionId,
          blockId: block.blockId,
          message: `Open gap ${block.gapId}: ${block.statement}`,
        });
      }
    }
  }
  for (const reference of references) {
    if (reference.status === "outdated") {
      const changes = [
        ...(reference.boundVersionId === reference.currentVersionId
          ? []
          : [`object ${reference.boundVersionId} -> ${reference.currentVersionId}`]),
        ...(reference.boundContextVersionId === reference.currentContextVersionId
          ? []
          : [`context ${reference.boundContextVersionId} -> ${reference.currentContextVersionId}`]),
      ];
      warnings.push({
        code: "reference-version-changed",
        sectionId: reference.sectionId,
        blockId: reference.blockId,
        objectId: reference.objectId,
        message: `${reference.objectId} binding is outdated (${changes.join(", ")})`,
      });
    }
  }
  const verificationProfiles = [...claimContexts.entries()]
    .sort(([left], [right]) => compareStrings(left, right))
    .map(([claimId, contextId]) =>
      deriveVerificationProfile(projectRoot, { branchId, claimId, contextId }),
    );
  references.sort(
    (left, right) =>
      compareStrings(left.sectionId, right.sectionId) ||
      compareStrings(left.blockId, right.blockId) ||
      compareStrings(left.objectId, right.objectId),
  );
  warnings.sort((left, right) =>
    compareStrings(
      `${left.sectionId ?? ""}:${left.blockId ?? ""}:${left.code}:${left.objectId ?? ""}`,
      `${right.sectionId ?? ""}:${right.blockId ?? ""}:${right.code}:${right.objectId ?? ""}`,
    ),
  );
  return {
    references,
    warnings,
    openGapIds: [...new Set(openGapIds)].sort(compareStrings),
    verificationProfiles,
  };
}

export function inspectWorkingPaper(
  projectRoot: string,
  options: { branchId: string; paperId: string },
): WorkingPaperInspection {
  const record = getWorkingPaper(projectRoot, options.branchId, options.paperId);
  const inspected = inspectPaperReferences(projectRoot, options.branchId, record);
  return {
    branchId: options.branchId,
    paperId: record.object.objectId,
    paperVersionId: record.object.versionId,
    warnings: inspected.warnings,
    outdatedReferences: inspected.references.filter(
      (reference) => reference.status === "outdated",
    ),
    openGapIds: inspected.openGapIds,
    verificationProfiles: inspected.verificationProfiles,
  };
}

export function renderWorkingPaper(
  projectRoot: string,
  options: {
    branchId: string;
    paperId: string;
    format?: "markdown" | "latex";
  },
): WorkingPaperRender {
  const record = getWorkingPaper(projectRoot, options.branchId, options.paperId);
  const inspected = inspectPaperReferences(projectRoot, options.branchId, record);
  const objects = currentObjectMap(projectRoot, options.branchId);
  const format = options.format ?? "markdown";
  const lines: string[] = format === "markdown"
    ? [
        `# ${record.paper.title}`,
        "",
        `<!-- working-paper ${record.object.objectId}@${record.object.versionId}; context ${record.paper.context.objectId}@${record.paper.context.versionId} -->`,
      ]
    : [
        "\\documentclass{article}",
        "\\usepackage[T1]{fontenc}",
        "\\usepackage{amsmath}",
        "\\usepackage{hyperref}",
        `\\title{${latexEscape(record.paper.title)}}`,
        "\\begin{document}",
        "\\maketitle",
        `% working-paper ${record.object.objectId}@${record.object.versionId}; context ${record.paper.context.objectId}@${record.paper.context.versionId}`,
      ];
  for (const section of record.paper.sections) {
    if (format === "markdown") {
      lines.push("", `## ${section.title}`, "", `<a id="${sectionAnchor(section.sectionId)}"></a>`);
    } else {
      lines.push(
        "",
        `\\section{${latexEscape(section.title)}}`,
        `\\label{sec:${latexLabel(section.sectionId)}}`,
      );
    }
    for (const annotation of section.annotations) {
      if (format === "markdown") {
        lines.push(
          "",
          `> [!${annotation.kind === "note" ? "NOTE" : annotation.kind === "warning" ? "WARNING" : "IMPORTANT"}] ${annotation.annotationId}`,
          `> ${annotation.text.replace(/\n/gu, "\n> ")}`,
        );
      } else {
        lines.push(
          "",
          "\\begin{quote}",
          `\\textbf{${latexEscape(annotation.kind)} ${latexEscape(annotation.annotationId)}}\\\\`,
          latexEscape(annotation.text),
          "\\end{quote}",
        );
      }
    }
    for (const block of section.blocks) {
      lines.push(
        "",
        format === "markdown"
          ? renderMarkdownBlock(projectRoot, objects, block)
          : renderLatexBlock(projectRoot, objects, block),
      );
    }
  }
  if (format === "latex") lines.push("", "\\end{document}");
  const text = `${lines.join("\n").trim()}\n`;
  return {
    branchId: options.branchId,
    paperId: record.object.objectId,
    paperVersionId: record.object.versionId,
    format,
    text,
    digest: sha256Digest(text),
    references: inspected.references,
    warnings: inspected.warnings,
    outdatedReferences: inspected.references.filter(
      (reference) => reference.status === "outdated",
    ),
    openGapIds: inspected.openGapIds,
    verificationProfiles: inspected.verificationProfiles,
  };
}

function edgeContext(edge: EdgeProjection): string | undefined {
  return typeof edge.envelope.contextId === "string"
    ? edge.envelope.contextId
    : undefined;
}

function pathMatchesContext(
  path: readonly GraphPathStep[],
  contextId: string,
  edges: ReadonlyMap<string, EdgeProjection>,
): boolean {
  return path.every((step) => edgeContext(edges.get(step.edgeId)!) === contextId);
}

function impactWarningCode(objectType: string): PaperImpactWarning["code"] {
  if (objectType === "evidence") return "stale-evidence";
  if (objectType === "review") return "stale-review";
  return "stale-dependency";
}

export function analyzeWorkingPaperImpact(
  projectRoot: string,
  options: {
    branchId: string;
    paperId: string;
    changedObjectIds: readonly string[];
  },
): WorkingPaperImpact {
  const record = getWorkingPaper(projectRoot, options.branchId, options.paperId);
  const impact = computeImpact(projectRoot, {
    branchId: options.branchId,
    changedObjectIds: options.changedObjectIds,
  });
  const changed = new Set(impact.changedObjects.map((object) => object.objectId));
  const affected = new Map(impact.affected.map((entry) => [entry.object.objectId, entry]));
  const objects = currentObjectMap(projectRoot, options.branchId);
  const edges = new Map(
    listEdges(projectRoot, options.branchId).map((edge) => [edge.edgeId, edge]),
  );
  const affectedSections: PaperSectionImpact[] = [];
  for (const section of record.paper.sections) {
    const warnings: PaperImpactWarning[] = [];
    const addReferenceWarning = (blockId: string, reference: PaperObjectReference): void => {
      const object = objects.get(reference.objectId);
      if (object === undefined) return;
      const currentContext = objects.get(reference.contextId);
      if (
        object.versionId !== reference.versionId ||
        currentContext?.versionId !== reference.contextVersionId
      ) {
        warnings.push({
          code: "reference-version-changed",
          sectionId: section.sectionId,
          blockId,
          contextId: reference.contextId,
          objectId: reference.objectId,
          depth: 0,
          changedObjectIds: [],
          paths: [],
          message: `${reference.objectId} or its scoped context changed after this paper version was bound`,
        });
      }
      if (changed.has(reference.objectId)) {
        warnings.push({
          code: "changed-reference",
          sectionId: section.sectionId,
          blockId,
          contextId: reference.contextId,
          objectId: reference.objectId,
          depth: 0,
          changedObjectIds: [reference.objectId],
          paths: [],
          message: `Section directly references changed ${object.objectType} ${reference.objectId}`,
        });
        return;
      }
      const verificationBinding = verificationRecordContent(object);
      if (verificationBinding !== undefined) {
        const boundClaimId = verificationBinding.claimRef.objectId;
        const boundClaimImpact = affected.get(boundClaimId);
        const boundClaimReasons = boundClaimImpact?.reasons.filter((reason) =>
          pathMatchesContext(reason.path, reference.contextId, edges),
        ) ?? [];
        if (changed.has(boundClaimId) || boundClaimReasons.length > 0) {
          warnings.push({
            code: impactWarningCode(object.objectType),
            sectionId: section.sectionId,
            blockId,
            contextId: reference.contextId,
            objectId: reference.objectId,
            depth: changed.has(boundClaimId)
              ? 1
              : Math.min(...boundClaimReasons.map((reason) => reason.depth)) + 1,
            changedObjectIds: changed.has(boundClaimId)
              ? [boundClaimId]
              : [...new Set(boundClaimReasons.map((reason) => reason.changedObjectId))]
                  .sort(compareStrings),
            paths: boundClaimReasons.map((reason) => reason.path),
            message: `${object.objectType} ${reference.objectId} is bound to affected claim ${boundClaimId}`,
          });
          return;
        }
      }
      const entry = affected.get(reference.objectId);
      if (entry === undefined) return;
      const reasons = entry.reasons.filter((reason) =>
        pathMatchesContext(reason.path, reference.contextId, edges),
      );
      if (reasons.length === 0) return;
      warnings.push({
        code: impactWarningCode(object.objectType),
        sectionId: section.sectionId,
        blockId,
        contextId: reference.contextId,
        objectId: reference.objectId,
        depth: Math.min(...reasons.map((reason) => reason.depth)),
        changedObjectIds: [...new Set(reasons.map((reason) => reason.changedObjectId))].sort(compareStrings),
        paths: reasons.map((reason) => reason.path),
        message: `${object.objectType} ${reference.objectId} depends on changed scoped input`,
      });
    };
    addReferenceWarning("section-context", {
      objectId: section.context.objectId,
      versionId: section.context.versionId,
      contextId: section.context.objectId,
      contextVersionId: section.context.versionId,
      mode: "pinned",
    });
    for (const annotation of section.annotations) {
      for (const reference of annotation.references) {
        addReferenceWarning(`annotation:${annotation.annotationId}`, reference);
      }
    }
    for (const block of section.blocks) {
      for (const reference of referencesInBlock(block)) {
        addReferenceWarning(block.blockId, reference);
      }
      if (block.kind === "artifact") {
        const producerId = block.artifact.producedByRunId;
        const producerImpact = affected.get(producerId);
        const producerReasons = producerImpact?.reasons.filter((reason) =>
          pathMatchesContext(reason.path, section.context.objectId, edges),
        ) ?? [];
        if (changed.has(producerId) || producerReasons.length > 0) {
          warnings.push({
            code: "stale-artifact-producer",
            sectionId: section.sectionId,
            blockId: block.blockId,
            contextId: section.context.objectId,
            objectId: producerId,
            depth: changed.has(producerId)
              ? 0
              : Math.min(...producerReasons.map((reason) => reason.depth)),
            changedObjectIds: changed.has(producerId)
              ? [producerId]
              : [...new Set(producerReasons.map((reason) => reason.changedObjectId))]
                  .sort(compareStrings),
            paths: producerReasons.map((reason) => reason.path),
            message: `Artifact ${block.artifact.artifactId} was produced by affected run ${producerId}`,
          });
        }
      }
    }
    const deduplicated = [...new Map(
      warnings.map((warning) => [
        `${warning.code}:${warning.blockId}:${warning.objectId}`,
        warning,
      ]),
    ).values()].sort(
      (left, right) =>
        left.depth - right.depth ||
        compareStrings(`${left.blockId}:${left.objectId}:${left.code}`, `${right.blockId}:${right.objectId}:${right.code}`),
    );
    if (deduplicated.length > 0) {
      affectedSections.push({
        sectionId: section.sectionId,
        contextId: section.context.objectId,
        warnings: deduplicated,
      });
    }
  }
  return {
    branchId: options.branchId,
    paperId: record.object.objectId,
    paperVersionId: record.object.versionId,
    changedObjectIds: [...new Set(options.changedObjectIds)].sort(compareStrings),
    affectedSections,
    impact,
  };
}

function category(objectType: string | undefined): SemanticChangeCategory {
  if (objectType === "claim" || objectType === "definition" || objectType === "goal" || objectType === "problem") {
    return "statement";
  }
  if (objectType === "assumption") return "assumption";
  if (objectType === "context") return "context";
  if (
    objectType === "evidence" ||
    objectType === "run" ||
    objectType === "artifact" ||
    objectType === "source"
  ) return "evidence";
  if (objectType === "review") return "review";
  if (objectType === "document") return "document";
  return "other";
}

function topLevelChangedFields(left: unknown, right: unknown): string[] {
  const leftRecord = isRecord(left) ? left : { value: left };
  const rightRecord = isRecord(right) ? right : { value: right };
  return [...new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)])]
    .filter((key) => {
      const leftHas = Object.prototype.hasOwnProperty.call(leftRecord, key);
      const rightHas = Object.prototype.hasOwnProperty.call(rightRecord, key);
      return leftHas !== rightHas ||
        (leftHas && canonicalJson(leftRecord[key]) !== canonicalJson(rightRecord[key]));
    })
    .sort(compareStrings);
}

function semanticText(content: unknown): string | undefined {
  if (!isRecord(content)) return undefined;
  for (const key of ["statement", "title", "summary", "objective", "brief", "observation"]) {
    if (typeof content[key] === "string") return content[key] as string;
  }
  return undefined;
}

function proofStatus(content: unknown): string | undefined {
  if (!isRecord(content)) return undefined;
  for (const key of ["proofStatus", "verificationStatus", "status"]) {
    if (typeof content[key] === "string") return content[key] as string;
  }
  return undefined;
}

function semanticEdge(
  side: "source" | "target",
  edge: EdgeProjection,
): SemanticDependencyChange {
  const contextId = edgeContext(edge);
  return {
    side,
    edgeId: edge.edgeId,
    edgeType: edge.edgeType,
    fromObjectId: edge.fromObjectId,
    toObjectId: edge.toObjectId,
    ...(contextId === undefined ? {} : { contextId }),
  };
}

export async function compareResearchBranches(
  projectRoot: string,
  sourceBranchId: string,
  targetBranchId: string,
): Promise<SemanticBranchComparison> {
  const branchDiff = await diffBranches(projectRoot, sourceBranchId, targetBranchId);
  const sourceObjects = currentObjectMap(projectRoot, sourceBranchId);
  const targetObjects = currentObjectMap(projectRoot, targetBranchId);
  const objectChanges = branchDiff.objectChanges.map((change): SemanticObjectChange => {
    const source = sourceObjects.get(change.objectId);
    const target = targetObjects.get(change.objectId);
    const sourceStatement = semanticText(source?.content);
    const targetStatement = semanticText(target?.content);
    const sourceProofStatus = proofStatus(source?.content);
    const targetProofStatus = proofStatus(target?.content);
    return {
      objectId: change.objectId,
      ...(change.objectType === undefined ? {} : { objectType: change.objectType }),
      status: change.status,
      category: category(change.objectType),
      changedFields: topLevelChangedFields(source?.content, target?.content),
      ...(source?.versionId === undefined ? {} : { sourceVersionId: source.versionId }),
      ...(target?.versionId === undefined ? {} : { targetVersionId: target.versionId }),
      ...(sourceStatement === undefined ? {} : { sourceStatement }),
      ...(targetStatement === undefined ? {} : { targetStatement }),
      ...(sourceProofStatus === undefined ? {} : { sourceProofStatus }),
      ...(targetProofStatus === undefined ? {} : { targetProofStatus }),
    };
  });
  const categories: SemanticChangeCategory[] = [
    "statement",
    "assumption",
    "context",
    "evidence",
    "review",
    "document",
    "other",
  ];
  const byCategory = Object.fromEntries(
    categories.map((selected) => [
      selected,
      objectChanges
        .filter((change) => change.category === selected)
        .map((change) => change.objectId)
        .sort(compareStrings),
    ]),
  ) as Record<SemanticChangeCategory, string[]>;
  const proofStatusChanges = objectChanges
    .filter((change) => change.sourceProofStatus !== change.targetProofStatus)
    .map((change) => change.objectId)
    .sort(compareStrings);
  const sourceEdges = new Map(
    listEdges(projectRoot, sourceBranchId).map((edge) => [edge.edgeId, edge]),
  );
  const targetEdges = new Map(
    listEdges(projectRoot, targetBranchId).map((edge) => [edge.edgeId, edge]),
  );
  const dependencyChanges = [
    ...branchDiff.sourceOnlyEdgeIds.flatMap((edgeId) => {
      const edge = sourceEdges.get(edgeId);
      return edge === undefined ? [] : [semanticEdge("source", edge)];
    }),
    ...branchDiff.targetOnlyEdgeIds.flatMap((edgeId) => {
      const edge = targetEdges.get(edgeId);
      return edge === undefined ? [] : [semanticEdge("target", edge)];
    }),
  ].sort((left, right) =>
    compareStrings(`${left.side}:${left.edgeId}`, `${right.side}:${right.edgeId}`),
  );
  return {
    sourceBranchId,
    targetBranchId,
    baseSequence: branchDiff.baseSequence,
    branchDiff,
    objectChanges,
    byCategory,
    proofStatusChanges,
    dependencyChanges,
  };
}
