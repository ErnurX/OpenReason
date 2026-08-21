import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  ActorSchema,
  ArtifactReferenceSchema,
  EdgeEnvelopeSchema,
  EventSchema,
  ObjectEnvelopeSchema,
  canonicalJson,
  computeContentHash,
  createId,
  sha256Digest,
  utcNow,
  withEventHash,
  type Actor,
  type ArtifactReference,
  type Event,
} from "@reasoning-workbench/project-format";

import { FileSystemArtifactStore } from "./cas.js";
import { createBuiltInDomainPackRegistry, domainPackDigest } from "./domain-packs.js";
import { appendEventsBatch } from "./event-log.js";
import {
  deriveVerificationProfile,
  getWorkingPaper,
  listVisibleArtifacts,
  type VerificationProfile,
} from "./paper.js";
import {
  createProject,
  inspectProject,
  projectHistory,
  putObject,
  verifyProject,
} from "./project.js";
import {
  listCurrentObjects,
  listEdges,
  rebuildProjection,
  type EdgeProjection,
  type ObjectProjection,
} from "./projection.js";
import {
  evaluateReferenceProject,
  type ReferenceProjectId,
} from "./research-package.js";

export const PUBLICATION_RELEASE_CHECK_IDS = [
  "REL-001", "REL-002", "REL-003", "REL-004",
  "REL-005", "REL-006", "REL-007", "REL-008",
] as const;

const PASSED_RELEASE_GATE_SUMMARIES: Record<(typeof PUBLICATION_RELEASE_CHECK_IDS)[number], string> = {
  "REL-001": "The selected source project passed canonical integrity verification before snapshot capture.",
  "REL-002": "Reference-project assertions pass for the captured branch state.",
  "REL-003": "Every failure except closed/resolved and every normalized open paper gap requires an exact-version, visible human waiver; malformed working papers fail closed.",
  "REL-004": "All domain-template required artifact roles are present.",
  "REL-005": "Object/source/citation references and every edge endpoint resolve to the exact selected version.",
  "REL-006": "Existing verification profiles contain no failed or stale observation.",
  "REL-007": "Every selected artifact retains visible run/environment/input lineage; unscoped input bytes are rejected.",
  "REL-008": "A locally attributed human release decision is bound to this branch snapshot. It is not authentication or external-publication authorization.",
};

export interface PublicationReleaseCheck {
  readonly checkId: (typeof PUBLICATION_RELEASE_CHECK_IDS)[number];
  readonly passed: boolean;
  readonly summary: string;
  readonly objectIds: readonly string[];
}

export interface PublicationReleaseReport {
  readonly schemaVersion: 1;
  readonly kind: "publication-release-check";
  readonly projectId: string;
  readonly branchId: string;
  /** Selected branch lineage; no global or sibling event head is exported. */
  readonly sourceBranchSnapshotDigest: string;
  /** Commits to the source event head without disclosing sibling activity. */
  readonly sourceEventHeadCommitment: string;
  readonly reference: Awaited<ReturnType<typeof evaluateReferenceProject>>;
  readonly verificationProfiles: readonly VerificationProfile[];
  readonly checks: readonly PublicationReleaseCheck[];
  readonly passed: boolean;
  readonly digest: string;
}

/**
 * Local attribution only. This is not authentication and does not authorize
 * external publication.
 */
export interface PublicationAttributionDecision {
  readonly decisionObjectId: string;
  readonly decisionVersionId: string;
  readonly attributedBranchSnapshotDigest: string;
  readonly authorityBoundary: "trusted-local-transport";
}

export interface PublicationArtifactEntry {
  readonly artifactId: string;
  readonly digest: string;
  readonly role: string;
  readonly path: string;
  readonly lineage: {
    readonly producedByRunId: string;
    readonly environmentId: string;
    readonly inputs: readonly string[];
    readonly reproducibility: string;
  };
}

export interface DerivedFileEntry {
  readonly path: string;
  readonly digest: string;
  readonly size: number;
}

export interface DerivedFileInventory {
  readonly schemaVersion: 1;
  readonly kind: "publication-derived-file-inventory";
  readonly files: readonly DerivedFileEntry[];
  readonly digest: string;
}

export interface ReproductionPlanEntry {
  /** A bounded eligible candidate; this release format has no central-run designation. */
  readonly runObjectId: string;
  readonly runVersionId: string;
  readonly reproducibility: "deterministic" | "seeded";
  readonly replayMode: "inspect-export-only";
  readonly boundedBy: {
    readonly maxJobs: number;
    readonly network: "disabled";
    readonly externalEngineExecution: false;
  };
}

export interface ReproductionPolicy {
  readonly maxJobs: number;
  readonly network: "disabled";
  readonly externalEngineExecution: false;
  /** Stable, transparent candidate ordering rather than a research-priority claim. */
  readonly candidateSelection: "eligible-succeeded-deterministic-or-seeded-object-id-order";
  /** Researcher-designated central runs are intentionally not modeled yet. */
  readonly centralDesignation: "not-recorded";
}

interface PublicationEnvironmentEntry {
  readonly objectId: string;
  readonly versionId: string;
  readonly contentHash: string;
}

export interface SourceEdgeEntry {
  readonly edgeId: string;
  readonly edgeType: string;
  readonly fromObjectId: string;
  readonly fromVersionId: string;
  readonly toObjectId: string;
  readonly toVersionId: string;
  readonly contextId?: string;
  readonly metadata: Record<string, unknown>;
  /** Full selected source edge envelope, including extensions and provenance. */
  readonly envelope: Record<string, unknown>;
  /** Source event metadata excluding global event-chain fields. */
  readonly event: SourceEventProvenance;
}

/**
 * Preserved source-event provenance. New snapshot events necessarily receive
 * a new sequence, project ID, branch ID, previous hash, and event hash; the
 * remaining source metadata stays visible in both the source-state record and
 * the rebased snapshot event.
 */
export interface SourceEventProvenance {
  readonly eventId: string;
  readonly occurredAt: string;
  readonly actor: Actor;
  readonly schemaVersion: number;
  readonly sourceBranchId?: string;
  readonly causationId?: string;
  readonly correlationId?: string;
  readonly extensions: Record<string, unknown>;
}

export interface SourceObjectEntry {
  /** Full original ObjectEnvelope, including createdBy/createdAt/extensions. */
  readonly envelope: Record<string, unknown>;
  readonly event: SourceEventProvenance;
}

export interface SourceArtifactEntry {
  /** Full original ArtifactReference, including extension metadata. */
  readonly artifact: ArtifactReference;
  readonly event: SourceEventProvenance;
}

/** Complete selected-branch source state exported for offline verification. */
export interface BranchSourceState {
  readonly schemaVersion: 1;
  readonly kind: "branch-scoped-publication-source-state";
  readonly projectId: string;
  readonly branchId: string;
  /** All selected objects except local publication-attribution records. */
  readonly objects: readonly SourceObjectEntry[];
  /** Attribution records are exported but excluded from the bound state digest. */
  readonly attributionObjects: readonly SourceObjectEntry[];
  readonly artifacts: readonly SourceArtifactEntry[];
  readonly edges: readonly SourceEdgeEntry[];
  readonly sourceBranchSnapshotDigest: string;
  readonly sourceEventHeadCommitment: string;
}

export interface PublicationReleaseManifest {
  readonly schemaVersion: 1;
  readonly kind: "publication-release";
  readonly projectId: string;
  readonly branchId: string;
  readonly sourceBranchSnapshotDigest: string;
  readonly sourceEventHeadCommitment: string;
  readonly sourceState: {
    readonly path: "provenance/branch-source-state.json";
    readonly digest: string;
  };
  readonly canonicalSnapshot: {
    readonly root: "canonical";
    readonly projectId: string;
    readonly eventHead: { readonly sequence: number; readonly eventHash: string };
    /** The one new lineage decision created for this derived snapshot. */
    readonly lineageDecision: { readonly objectId: string; readonly versionId: string };
  };
  readonly attribution: PublicationAttributionDecision;
  readonly objects: readonly {
    readonly objectId: string;
    readonly versionId: string;
    readonly objectType: string;
    readonly contentHash: string;
  }[];
  readonly edges: readonly SourceEdgeEntry[];
  readonly artifacts: readonly PublicationArtifactEntry[];
  readonly checks: PublicationReleaseReport;
  readonly reproductionPolicy: ReproductionPolicy;
  readonly reproductionPlan: readonly ReproductionPlanEntry[];
  readonly derivedFiles: readonly DerivedFileEntry[];
  readonly inventory: {
    readonly path: "provenance/release-inventory.json";
    readonly digest: string;
  };
  readonly digest: string;
}

export interface BuiltPublicationRelease {
  readonly destinationRoot: string;
  readonly manifestPath: string;
  readonly manifest: PublicationReleaseManifest;
}

interface CapturedPublicationState {
  readonly projectId: string;
  readonly title: string;
  readonly branchId: string;
  /** Used only for race detection; never emitted in a release. */
  readonly sourceHead: { readonly sequence: number; readonly eventHash: string };
  readonly objects: readonly ObjectProjection[];
  readonly artifacts: readonly ArtifactReference[];
  readonly edges: readonly SourceEdgeEntry[];
  readonly sourceState: BranchSourceState;
  readonly sourceBranchSnapshotDigest: string;
  readonly sourceEventHeadCommitment: string;
  readonly integrity: Awaited<ReturnType<typeof verifyProject>>;
  readonly reference: Awaited<ReturnType<typeof evaluateReferenceProject>>;
}

interface OpenPaperGap {
  readonly documentObjectId: string;
  readonly documentVersionId: string;
  readonly gapId: string;
  readonly waivable: boolean;
  readonly reason: "open-gap" | "malformed-working-paper";
}

const RELEASE_DIRECTORIES = [
  "manuscript", "proofs", "code", "data", "figures",
  "environments", "verification", "provenance",
] as const;
const MANIFEST_PATH = "publication-release.json";
const INVENTORY_PATH = "provenance/release-inventory.json";
const SOURCE_STATE_PATH = "provenance/branch-source-state.json";
const PORTABLE_RELEASE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const WINDOWS_RESERVED_SEGMENT = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
const REPRODUCTION_NOT_EXECUTED_REASON = "The release validates a clean branch-scoped snapshot only. It lists bounded eligible run candidates, not researcher-designated central runs; optional external engines are not bundled, invoked, or claimed.";
const DEFAULT_REPRODUCTION_MAX_JOBS = 3;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  const expected = new Set(keys);
  const actual = Object.keys(value);
  if (actual.length !== expected.size || actual.some((key) => !expected.has(key))) {
    throw new Error("Unexpected or missing fields in " + label);
  }
}

function assertAllowedKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  const allowed = new Set(keys);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error("Unexpected fields in " + label);
  }
}

function contentKind(object: ObjectProjection, kind: string): boolean {
  return isRecord(object.content) && object.content.kind === kind;
}

function objectActorType(object: ObjectProjection): string | undefined {
  const actor = isRecord(object.envelope) ? object.envelope.createdBy : undefined;
  return isRecord(actor) && typeof actor.actorType === "string" ? actor.actorType : undefined;
}

function objectVersions(objects: readonly ObjectProjection[]): PublicationReleaseManifest["objects"] {
  return objects.map((object) => ({
    objectId: object.objectId,
    versionId: object.versionId,
    objectType: object.objectType,
    contentHash: object.contentHash,
  })).sort((left, right) => left.objectId.localeCompare(right.objectId));
}

function sourceObjectVersions(sourceState: BranchSourceState): PublicationReleaseManifest["objects"] {
  return allSourceObjects(sourceState).map((entry) => {
    const object = ObjectEnvelopeSchema.parse(entry.envelope);
    return {
      objectId: object.objectId,
      versionId: object.versionId,
      objectType: object.objectType,
      contentHash: object.contentHash,
    };
  }).sort((left, right) => left.objectId.localeCompare(right.objectId));
}

function sourceEnvironmentViews(sourceState: BranchSourceState): PublicationEnvironmentEntry[] {
  return allSourceObjects(sourceState).map((entry) => ObjectEnvelopeSchema.parse(entry.envelope))
    .filter((object) => object.objectType === "environment")
    .map((object) => ({
      objectId: object.objectId,
      versionId: object.versionId,
      contentHash: object.contentHash,
    }))
    .sort((left, right) => left.objectId.localeCompare(right.objectId));
}

interface IndexedSourceEvent<T> {
  readonly value: T;
  readonly provenance: SourceEventProvenance;
}

interface SourceEventIndex {
  readonly objects: ReadonlyMap<string, IndexedSourceEvent<Record<string, unknown>>>;
  readonly edges: ReadonlyMap<string, IndexedSourceEvent<Record<string, unknown>>>;
  readonly artifacts: ReadonlyMap<string, IndexedSourceEvent<ArtifactReference>>;
}

function sourceEventProvenance(event: Event): SourceEventProvenance {
  const {
    sequence: _sequence,
    eventId,
    eventType: _eventType,
    occurredAt,
    projectId: _projectId,
    branchId: sourceBranchId,
    actor,
    schemaVersion,
    payload: _payload,
    previousEventHash: _previousEventHash,
    eventHash: _eventHash,
    causationId,
    correlationId,
    ...extensions
  } = event;
  return {
    eventId,
    occurredAt,
    actor,
    schemaVersion,
    ...(sourceBranchId === undefined ? {} : { sourceBranchId }),
    ...(causationId === undefined ? {} : { causationId }),
    ...(correlationId === undefined ? {} : { correlationId }),
    extensions,
  };
}

function indexSourceEvents(events: readonly Event[]): SourceEventIndex {
  const objects = new Map<string, IndexedSourceEvent<Record<string, unknown>>>();
  const edges = new Map<string, IndexedSourceEvent<Record<string, unknown>>>();
  const artifacts = new Map<string, IndexedSourceEvent<ArtifactReference>>();
  for (const event of events) {
    const provenance = sourceEventProvenance(event);
    if (event.eventType === "ObjectVersionCreated") {
      const parsed = ObjectEnvelopeSchema.safeParse(event.payload.object);
      if (parsed.success) objects.set(parsed.data.versionId, { value: parsed.data, provenance });
    } else if (event.eventType === "EdgeCreated") {
      const parsed = EdgeEnvelopeSchema.safeParse(event.payload.edge);
      if (parsed.success) edges.set(parsed.data.edgeId, { value: parsed.data, provenance });
    } else if (event.eventType === "ArtifactRegistered") {
      const parsed = ArtifactReferenceSchema.safeParse(event.payload.artifact);
      if (parsed.success) artifacts.set(parsed.data.artifactId, { value: parsed.data, provenance });
    }
  }
  return { objects, edges, artifacts };
}

function sourceObjectEntries(
  objects: readonly ObjectProjection[],
  index: SourceEventIndex,
): SourceObjectEntry[] {
  return objects.map((object) => {
    const envelope = ObjectEnvelopeSchema.parse(object.envelope);
    const source = index.objects.get(envelope.versionId);
    if (source === undefined || canonicalJson(source.value) !== canonicalJson(envelope)) {
      throw new Error("Source object envelope is not recoverable from canonical history: " + object.objectId + "@" + object.versionId);
    }
    return { envelope, event: source.provenance };
  }).sort((left, right) => String(left.envelope.objectId).localeCompare(String(right.envelope.objectId)));
}

function edgeEntries(
  edges: readonly EdgeProjection[],
  index: SourceEventIndex,
): SourceEdgeEntry[] {
  return edges.map((edge) => {
    if (edge.fromVersionId === undefined || edge.toVersionId === undefined) {
      throw new Error("Release edge lacks an exact endpoint version: " + edge.edgeId);
    }
    const envelope = EdgeEnvelopeSchema.parse(edge.envelope);
    const source = index.edges.get(envelope.edgeId);
    if (source === undefined || canonicalJson(source.value) !== canonicalJson(envelope)) {
      throw new Error("Source edge envelope is not recoverable from canonical history: " + edge.edgeId);
    }
    if (
      envelope.from.objectId !== edge.fromObjectId ||
      envelope.from.versionId !== edge.fromVersionId ||
      envelope.to.objectId !== edge.toObjectId ||
      envelope.to.versionId !== edge.toVersionId
    ) {
      throw new Error("Projected edge does not match its canonical envelope: " + edge.edgeId);
    }
    return {
      edgeId: envelope.edgeId,
      edgeType: envelope.edgeType,
      fromObjectId: envelope.from.objectId,
      fromVersionId: envelope.from.versionId,
      toObjectId: envelope.to.objectId,
      toVersionId: envelope.to.versionId,
      ...(envelope.contextId === undefined ? {} : { contextId: envelope.contextId }),
      metadata: envelope.metadata,
      envelope,
      event: source.provenance,
    };
  }).sort((left, right) => left.edgeId.localeCompare(right.edgeId));
}

function sourceArtifactEntries(
  artifacts: readonly ArtifactReference[],
  index: SourceEventIndex,
): SourceArtifactEntry[] {
  return artifacts.map((artifact) => {
    const parsed = ArtifactReferenceSchema.parse(artifact);
    const source = index.artifacts.get(parsed.artifactId);
    if (source === undefined || canonicalJson(source.value) !== canonicalJson(parsed)) {
      throw new Error("Source artifact metadata is not recoverable from canonical history: " + parsed.artifactId);
    }
    return { artifact: parsed, event: source.provenance };
  }).sort((left, right) => left.artifact.artifactId.localeCompare(right.artifact.artifactId));
}

function isAttributionEnvelope(entry: SourceObjectEntry): boolean {
  return entry.envelope.objectType === "decision" &&
    isRecord(entry.envelope.content) &&
    entry.envelope.content.kind === "publication-release-attribution";
}

function sourceStateDigestPayload(
  projectId: string,
  branchId: string,
  objects: readonly SourceObjectEntry[],
  artifacts: readonly SourceArtifactEntry[],
  edges: readonly SourceEdgeEntry[],
) {
  return {
    schemaVersion: 1 as const,
    kind: "branch-scoped-publication-source-state" as const,
    projectId,
    branchId,
    objects,
    artifacts,
    edges,
  };
}

function branchSourceState(
  projectId: string,
  branchId: string,
  objects: readonly ObjectProjection[],
  artifacts: readonly ArtifactReference[],
  edges: readonly EdgeProjection[],
  history: readonly Event[],
  sourceHead: { readonly sequence: number; readonly eventHash: string },
): BranchSourceState {
  const index = indexSourceEvents(history);
  const allObjects = sourceObjectEntries(objects, index);
  const subjectObjects = allObjects.filter((entry) => !isAttributionEnvelope(entry));
  const attributionObjects = allObjects.filter(isAttributionEnvelope);
  const sourceArtifacts = sourceArtifactEntries(artifacts, index);
  const sourceEdges = edgeEntries(edges, index);
  const unsigned = sourceStateDigestPayload(
    projectId,
    branchId,
    subjectObjects,
    sourceArtifacts,
    sourceEdges,
  );
  const sourceBranchSnapshotDigest = computeContentHash(unsigned);
  return {
    ...unsigned,
    attributionObjects,
    sourceBranchSnapshotDigest,
    sourceEventHeadCommitment: computeContentHash({
      schemaVersion: 1,
      kind: "source-event-head-commitment",
      sourceHead,
      sourceBranchSnapshotDigest,
    }),
  };
}

function currentReferences(value: unknown, current: ReadonlyMap<string, ObjectProjection>, issues: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((item) => currentReferences(item, current, issues));
    return;
  }
  if (!isRecord(value)) return;
  if (typeof value.objectId === "string" && typeof value.versionId === "string") {
    const object = current.get(value.objectId);
    if (object === undefined || object.versionId !== value.versionId) {
      issues.push(value.objectId + "@" + value.versionId);
    }
  }
  Object.values(value).forEach((item) => currentReferences(item, current, issues));
}

function artifactRole(artifact: ArtifactReference): string {
  const name = artifact.logicalName.toLowerCase();
  if (name.endsWith(".lean") || name.includes("proof")) return "proofs";
  if (name.endsWith(".py") || name.endsWith(".ts") || name.endsWith(".r") || name.endsWith(".jl")) return "code";
  if (name.endsWith(".csv") || name.includes("dataset") || name.includes("trajectory") || name.includes("metrics")) return "data";
  if (artifact.mediaType.startsWith("image/") || name.endsWith(".svg")) return "figures";
  if (name.includes("provenance")) return "provenance";
  if (name.includes("paper") || name.endsWith(".md")) return "manuscript";
  return "verification";
}

function safeFileName(name: string): string {
  const normalized = name.normalize("NFKC").replace(/[^A-Za-z0-9._-]/gu, "_");
  const result = normalized.replace(/^\.+/u, "").slice(0, 120);
  return result.length === 0 ? "artifact" : result;
}

function artifactPath(artifact: ArtifactReference): string {
  const prefix = artifact.digest.slice("sha256:".length, "sha256:".length + 16);
  return artifactRole(artifact) + "/" + artifact.artifactId + "-" + prefix + "-" + safeFileName(artifact.logicalName);
}

function publicationArtifactEntry(artifact: ArtifactReference): PublicationArtifactEntry {
  return {
    artifactId: artifact.artifactId,
    digest: artifact.digest,
    role: artifactRole(artifact),
    path: artifactPath(artifact),
    lineage: {
      producedByRunId: artifact.producedByRunId,
      environmentId: artifact.environmentId,
      inputs: artifact.inputs,
      reproducibility: artifact.reproducibility,
    },
  };
}

function sourceArtifactViews(sourceState: BranchSourceState): PublicationArtifactEntry[] {
  return sourceState.artifacts
    .map((entry) => publicationArtifactEntry(entry.artifact))
    .sort((left, right) => left.artifactId.localeCompare(right.artifactId));
}

interface RequiredRoleResolution {
  readonly roles: readonly string[];
  readonly activationIssue?: string;
  readonly activationObjectIds: readonly string[];
}

function requiredRoles(objects: readonly ObjectProjection[]): RequiredRoleResolution {
  const activations = objects.filter((object) =>
    object.objectType === "decision" && contentKind(object, "domain-pack-activation"),
  );
  const activationObjectIds = activations.map((object) => object.objectId).sort((left, right) => left.localeCompare(right));
  if (activations.length !== 1) {
    return {
      roles: [],
      activationIssue: "Expected exactly one current domain-pack activation, found " + activations.length + ".",
      activationObjectIds,
    };
  }
  const activation = activations[0]!;
  const content = activation.content as Record<string, unknown>;
  const requiredFields = ["schemaVersion", "kind", "packId", "packVersion", "manifestDigest", "templateId", "adapterPolicy", "allowedBindingIds"] as const;
  if (
    content.schemaVersion !== 1 ||
    content.kind !== "domain-pack-activation" ||
    typeof content.packId !== "string" ||
    typeof content.packVersion !== "string" ||
    typeof content.manifestDigest !== "string" ||
    typeof content.templateId !== "string" ||
    content.adapterPolicy !== "deny-by-default" ||
    !Array.isArray(content.allowedBindingIds) ||
    !content.allowedBindingIds.every((bindingId) => typeof bindingId === "string")
  ) {
    return {
      roles: [],
      activationIssue: "Domain-pack activation has an invalid canonical shape.",
      activationObjectIds,
    };
  }
  try {
    assertExactKeys(content, requiredFields, "domain-pack activation");
  } catch {
    return {
      roles: [],
      activationIssue: "Domain-pack activation has an invalid canonical shape.",
      activationObjectIds,
    };
  }
  const pack = createBuiltInDomainPackRegistry().get(content.packId);
  if (pack === undefined) {
    return {
      roles: [],
      activationIssue: "Domain-pack activation names an unknown built-in pack: " + content.packId + ".",
      activationObjectIds,
    };
  }
  if (content.packVersion !== pack.version || content.manifestDigest !== domainPackDigest(pack)) {
    return {
      roles: [],
      activationIssue: "Domain-pack activation version or manifest digest does not match the built-in pack.",
      activationObjectIds,
    };
  }
  const template = pack.templates.find((candidate) => candidate.templateId === content.templateId);
  if (template === undefined) {
    return {
      roles: [],
      activationIssue: "Domain-pack activation names an unknown template for its pack: " + content.templateId + ".",
      activationObjectIds,
    };
  }
  return { roles: template.requiredArtifactRoles, activationObjectIds };
}

function satisfiesTemplateRole(role: string, artifacts: readonly ArtifactReference[], objects: readonly ObjectProjection[]): boolean {
  const names = artifacts.map((artifact) => artifact.logicalName.toLowerCase());
  switch (role) {
    case "code": return artifacts.some((artifact) => artifactRole(artifact) === "code");
    case "dataset": case "simulation-data": case "comparison-dataset": case "convergence-data": case "mesh": return artifacts.some((artifact) => artifactRole(artifact) === "data");
    case "figure": return artifacts.some((artifact) => artifactRole(artifact) === "figures");
    case "formal-source": return artifacts.some((artifact) => artifact.logicalName.endsWith(".lean"));
    case "build-log": return names.some((name) => name.includes("build") && name.endsWith(".log"));
    case "axiom-audit": return names.some((name) => name.includes("axiom") && name.endsWith(".json"));
    case "working-paper": case "informal-proof": case "proof": return names.some((name) => name.endsWith(".md")) || artifacts.some((artifact) => artifactRole(artifact) === "proofs");
    case "provenance-manifest": return names.some((name) => name.includes("provenance"));
    case "failure-report": return objects.some((object) => object.objectType === "failure");
    case "alignment-review": return objects.some((object) => object.objectType === "alignment" || object.objectType === "review");
    case "derivation": return objects.some((object) => object.objectType === "claim");
    case "physical-review": return objects.some((object) => contentKind(object, "physical-checks"));
    case "equations": return objects.some((object) => object.objectType === "claim");
    case "solver-code": return artifacts.some((artifact) => artifactRole(artifact) === "code");
    case "environment": return objects.some((object) => object.objectType === "environment");
    case "benchmark-results": return artifacts.some((artifact) => artifactRole(artifact) === "data");
    case "source-library": return objects.some((object) => object.objectType === "source");
    case "extraction-review": return objects.some((object) => object.objectType === "review");
    default: return false;
  }
}

function failureWaiverKey(objectId: string, versionId: string): string {
  return "failure:" + objectId + "@" + versionId;
}

function paperGapWaiverKey(gap: Pick<OpenPaperGap, "documentObjectId" | "documentVersionId" | "gapId">): string {
  return "paper-gap:" + gap.documentObjectId + "@" + gap.documentVersionId + "#" + gap.gapId;
}

function waiverTargets(objects: readonly ObjectProjection[]): Set<string> {
  const targets = new Set<string>();
  for (const object of objects) {
    if (object.objectType !== "decision" || !contentKind(object, "publication-waiver") || !isRecord(object.content)) continue;
    if (objectActorType(object) !== "human" || object.content.status !== "approved" || typeof object.content.rationale !== "string" || object.content.rationale.trim().length === 0) continue;
    const failure = object.content.waivedObjectRef;
    if (isRecord(failure) && typeof failure.objectId === "string" && typeof failure.versionId === "string") {
      targets.add(failureWaiverKey(failure.objectId, failure.versionId));
    }
    const paperGap = object.content.waivedPaperGap;
    if (isRecord(paperGap) && typeof paperGap.gapId === "string" && isRecord(paperGap.documentRef) && typeof paperGap.documentRef.objectId === "string" && typeof paperGap.documentRef.versionId === "string") {
      targets.add(paperGapWaiverKey({
        documentObjectId: paperGap.documentRef.objectId,
        documentVersionId: paperGap.documentRef.versionId,
        gapId: paperGap.gapId,
      }));
    }
  }
  return targets;
}

function rawUnresolvedPaperGaps(object: ObjectProjection): OpenPaperGap[] {
  if (!isRecord(object.content) || !Array.isArray(object.content.sections)) return [];
  const gaps: OpenPaperGap[] = [];
  for (const [sectionIndex, section] of object.content.sections.entries()) {
    if (!isRecord(section) || !Array.isArray(section.blocks)) continue;
    for (const [blockIndex, block] of section.blocks.entries()) {
      if (!isRecord(block) || block.kind !== "gap" || block.status === "resolved") continue;
      gaps.push({
        documentObjectId: object.objectId,
        documentVersionId: object.versionId,
        gapId: typeof block.gapId === "string" && block.gapId.length > 0
          ? block.gapId
          : "__malformed-gap-" + sectionIndex + "-" + blockIndex,
        waivable: true,
        reason: "open-gap",
      });
    }
  }
  return gaps;
}

function openPaperGaps(
  projectRoot: string,
  branchId: string,
  objects: readonly ObjectProjection[],
): OpenPaperGap[] {
  const gaps: OpenPaperGap[] = [];
  for (const object of objects) {
    if (object.objectType !== "document" || !contentKind(object, "working-paper")) continue;
    try {
      const paper = getWorkingPaper(projectRoot, branchId, object.objectId).paper;
      for (const section of paper.sections) {
        for (const block of section.blocks) {
          if (block.kind === "gap" && block.status !== "resolved") {
            gaps.push({
              documentObjectId: object.objectId,
              documentVersionId: object.versionId,
              gapId: block.gapId,
              waivable: true,
              reason: "open-gap",
            });
          }
        }
      }
    } catch {
      // Generic putObject can bypass the paper writer; any malformed selected
      // paper is a release gate, and raw non-resolved gap blocks remain visible.
      gaps.push(...rawUnresolvedPaperGaps(object));
      gaps.push({
        documentObjectId: object.objectId,
        documentVersionId: object.versionId,
        gapId: "__malformed-working-paper__",
        waivable: false,
        reason: "malformed-working-paper",
      });
    }
  }
  return gaps.sort((left, right) => paperGapWaiverKey(left).localeCompare(paperGapWaiverKey(right)));
}

function exactEdgeIssues(edges: readonly SourceEdgeEntry[], current: ReadonlyMap<string, ObjectProjection>): string[] {
  const issues: string[] = [];
  for (const edge of edges) {
    const from = current.get(edge.fromObjectId);
    const to = current.get(edge.toObjectId);
    if (from === undefined || from.versionId !== edge.fromVersionId || to === undefined || to.versionId !== edge.toVersionId) {
      issues.push(edge.edgeId);
    }
  }
  return issues;
}

/**
 * An edge is publishable only when its endpoints are the currently selected
 * exact versions.  An older visible edge is retained by the append-only source
 * project, but can be omitted from the derived snapshot when a current exact
 * replacement expresses the same relationship.
 */
function edgeRelationshipKey(edge: EdgeProjection): string {
  const envelope = EdgeEnvelopeSchema.parse(edge.envelope);
  return canonicalJson({
    edgeType: envelope.edgeType,
    fromObjectId: envelope.from.objectId,
    toObjectId: envelope.to.objectId,
    contextId: envelope.contextId ?? null,
  });
}

function edgeHasCurrentExactEndpoints(
  edge: EdgeProjection,
  current: ReadonlyMap<string, ObjectProjection>,
): boolean {
  return edge.fromVersionId !== undefined && edge.toVersionId !== undefined &&
    current.get(edge.fromObjectId)?.versionId === edge.fromVersionId &&
    current.get(edge.toObjectId)?.versionId === edge.toVersionId;
}

function selectedPublicationEdges(
  edges: readonly EdgeProjection[],
  objects: readonly ObjectProjection[],
): EdgeProjection[] {
  const current = new Map(objects.map((object) => [object.objectId, object]));
  const replacementKeys = new Set(
    edges.filter((edge) => edgeHasCurrentExactEndpoints(edge, current)).map(edgeRelationshipKey),
  );
  return edges.filter((edge) =>
    edgeHasCurrentExactEndpoints(edge, current) || !replacementKeys.has(edgeRelationshipKey(edge)),
  );
}

function sameHead(
  left: { readonly sequence: number; readonly eventHash: string },
  right: { readonly sequence: number; readonly eventHash: string },
): boolean {
  return left.sequence === right.sequence && left.eventHash === right.eventHash;
}

async function currentHead(projectRoot: string): Promise<{ sequence: number; eventHash: string }> {
  const event = (await projectHistory(projectRoot)).at(-1);
  if (event === undefined) throw new Error("Publication release requires a canonical event head");
  return { sequence: event.sequence, eventHash: event.eventHash };
}

async function capturePublicationState(
  projectRoot: string,
  options: { referenceId: ReferenceProjectId; branchId: string },
): Promise<CapturedPublicationState> {
  const before = await currentHead(projectRoot);
  const integrity = await verifyProject(projectRoot);
  if (!integrity.ok || integrity.manifest === undefined) {
    throw new Error("Cannot release an invalid project: " + integrity.issues.map((issue) => issue.message).join("; "));
  }
  const objects = listCurrentObjects(projectRoot, options.branchId);
  const artifacts = await listVisibleArtifacts(projectRoot, options.branchId);
  const edgeProjections = selectedPublicationEdges(
    listEdges(projectRoot, options.branchId),
    objects,
  );
  const reference = await evaluateReferenceProject(projectRoot, options);
  const history = await projectHistory(projectRoot);
  const tail = history.at(-1);
  if (tail === undefined) throw new Error("Publication release requires a canonical event head");
  const after = { sequence: tail.sequence, eventHash: tail.eventHash };
  if (!sameHead(before, after)) throw new Error("Source project changed while deriving the publication release; retry from a stable snapshot");
  const sourceState = branchSourceState(
    integrity.manifest.projectId,
    options.branchId,
    objects,
    artifacts,
    edgeProjections,
    history,
    after,
  );
  return {
    projectId: integrity.manifest.projectId,
    title: integrity.manifest.title,
    branchId: options.branchId,
    sourceHead: before,
    objects,
    artifacts,
    edges: sourceState.edges,
    sourceState,
    sourceBranchSnapshotDigest: sourceState.sourceBranchSnapshotDigest,
    sourceEventHeadCommitment: sourceState.sourceEventHeadCommitment,
    integrity,
    reference,
  };
}

function attributionFor(state: CapturedPublicationState): PublicationAttributionDecision | undefined {
  const decision = state.objects
    .filter((object) => object.objectType === "decision" && contentKind(object, "publication-release-attribution"))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
  if (decision === undefined || objectActorType(decision) !== "human" || !isRecord(decision.content)) return undefined;
  if (decision.content.status !== "recorded" || decision.content.authorityBoundary !== "trusted-local-transport" || decision.content.attributedBranchSnapshotDigest !== state.sourceBranchSnapshotDigest) return undefined;
  return {
    decisionObjectId: decision.objectId,
    decisionVersionId: decision.versionId,
    attributedBranchSnapshotDigest: state.sourceBranchSnapshotDigest,
    authorityBoundary: "trusted-local-transport",
  };
}

/**
 * Records local human attribution. Identity authentication and trusted
 * transport are obligations outside this API.
 */
export async function recordPublicationAttribution(
  projectRoot: string,
  options: { branchId: string; releaseLabel: string; actor: Actor },
): Promise<PublicationAttributionDecision> {
  if (options.actor.actorType !== "human") throw new Error("A publication release decision must be locally attributed to a human actor");
  const before = await currentHead(projectRoot);
  const verified = await verifyProject(projectRoot);
  if (!verified.ok || verified.manifest === undefined) throw new Error("Cannot record attribution for an invalid project");
  const objects = listCurrentObjects(projectRoot, options.branchId);
  const artifacts = await listVisibleArtifacts(projectRoot, options.branchId);
  const edgeProjections = selectedPublicationEdges(
    listEdges(projectRoot, options.branchId),
    objects,
  );
  const history = await projectHistory(projectRoot);
  const tail = history.at(-1);
  if (tail === undefined) throw new Error("Publication release requires a canonical event head");
  const after = { sequence: tail.sequence, eventHash: tail.eventHash };
  if (!sameHead(before, after)) throw new Error("Source project changed while recording release attribution; retry");
  const digest = branchSourceState(
    verified.manifest.projectId,
    options.branchId,
    objects,
    artifacts,
    edgeProjections,
    history,
    after,
  ).sourceBranchSnapshotDigest;
  const decision = await putObject(projectRoot, {
    branchId: options.branchId,
    objectType: "decision",
    actor: options.actor,
    content: {
      schemaVersion: 1,
      kind: "publication-release-attribution",
      status: "recorded",
      releaseLabel: options.releaseLabel,
      authorityBoundary: "trusted-local-transport",
      attributedBranchSnapshotDigest: digest,
      externalPublication: "not-performed",
      limitation: "Local actor attribution is not authentication and does not authorize external publication.",
    },
  });
  return {
    decisionObjectId: decision.objectId,
    decisionVersionId: decision.versionId,
    attributedBranchSnapshotDigest: digest,
    authorityBoundary: "trusted-local-transport",
  };
}

export async function checkPublicationRelease(
  projectRoot: string,
  options: { referenceId: ReferenceProjectId; branchId: string },
): Promise<PublicationReleaseReport> {
  const state = await capturePublicationState(projectRoot, options);
  const report = reportFromState(projectRoot, state);
  await assertSourceUnchanged(projectRoot, state.sourceHead);
  return report;
}

function verificationProfilesFor(
  projectRoot: string,
  branchId: string,
  objects: readonly ObjectProjection[],
): VerificationProfile[] {
  return objects
    .filter((object) => object.objectType === "claim" && isRecord(object.content) && typeof object.content.contextId === "string")
    .map((claim) => deriveVerificationProfile(projectRoot, {
      branchId,
      claimId: claim.objectId,
      contextId: (claim.content as Record<string, unknown>).contextId as string,
    }));
}

function reportFromState(projectRoot: string, state: CapturedPublicationState): PublicationReleaseReport {
  const current = new Map(state.objects.map((object) => [object.objectId, object]));
  const waivers = waiverTargets(state.objects);
  const unresolvedFailures = state.objects.filter((object) =>
    object.objectType === "failure" &&
    !(isRecord(object.content) && (object.content.status === "closed" || object.content.status === "resolved")) &&
    !waivers.has(failureWaiverKey(object.objectId, object.versionId))
  );
  const unresolvedGaps = openPaperGaps(projectRoot, state.branchId, state.objects)
    .filter((gap) => !gap.waivable || !waivers.has(paperGapWaiverKey(gap)));
  const references = objectReferenceIssues(state.objects);
  const citedSourceIssues = state.edges
    .filter((edge) => edge.edgeType === "cites" && current.get(edge.toObjectId)?.objectType !== "source")
    .map((edge) => edge.edgeId);
  const edgeIssues = exactEdgeIssues(state.edges, current);
  const profiles = verificationProfilesFor(projectRoot, state.branchId, state.objects);
  const profileIssues = profiles
    .filter((profile) => profile.dimensions.some((dimension) => dimension.observations.length > 0 && (dimension.status === "failed" || dimension.status === "stale")))
    .map((profile) => profile.claimId);
  const templateRoles = requiredRoles(state.objects);
  const missingRoles = templateRoles.roles.filter((role) => !satisfiesTemplateRole(role, state.artifacts, state.objects));
  const visibleDigests = new Set(state.artifacts.map((artifact) => artifact.digest));
  const lineageMissing = state.artifacts.filter((artifact) =>
    current.get(artifact.producedByRunId)?.objectType !== "run" ||
    current.get(artifact.environmentId)?.objectType !== "environment" ||
    artifact.inputs.some((digest) => !visibleDigests.has(digest))
  );
  const attribution = attributionFor(state);
  const checks: PublicationReleaseCheck[] = [
    { checkId: "REL-001", passed: state.integrity.ok, summary: "The selected source project passed canonical integrity verification before snapshot capture.", objectIds: [] },
    { checkId: "REL-002", passed: state.reference.passed, summary: "Reference-project assertions pass for the captured branch state.", objectIds: state.reference.assertions.filter((entry) => !entry.passed).flatMap((entry) => entry.evidenceObjectIds) },
    { checkId: "REL-003", passed: unresolvedFailures.length === 0 && unresolvedGaps.length === 0, summary: "Every failure except closed/resolved and every normalized open paper gap requires an exact-version, visible human waiver; malformed working papers fail closed.", objectIds: [...unresolvedFailures.map((object) => object.objectId), ...unresolvedGaps.map((gap) => gap.documentObjectId + "#" + gap.gapId)] },
    {
      checkId: "REL-004",
      passed: templateRoles.activationIssue === undefined && missingRoles.length === 0,
      summary: templateRoles.activationIssue ?? (missingRoles.length === 0 ? "All domain-template required artifact roles are present." : "Missing required roles: " + missingRoles.join(", ") + "."),
      objectIds: templateRoles.activationIssue === undefined ? [] : templateRoles.activationObjectIds,
    },
    { checkId: "REL-005", passed: references.length === 0 && citedSourceIssues.length === 0 && edgeIssues.length === 0, summary: "Object/source/citation references and every edge endpoint resolve to the exact selected version.", objectIds: [...references, ...citedSourceIssues, ...edgeIssues] },
    { checkId: "REL-006", passed: profileIssues.length === 0, summary: "Existing verification profiles contain no failed or stale observation.", objectIds: profileIssues },
    { checkId: "REL-007", passed: lineageMissing.length === 0, summary: "Every selected artifact retains visible run/environment/input lineage; unscoped input bytes are rejected.", objectIds: lineageMissing.map((artifact) => artifact.artifactId) },
    { checkId: "REL-008", passed: attribution !== undefined, summary: "A locally attributed human release decision is bound to this branch snapshot. It is not authentication or external-publication authorization.", objectIds: attribution === undefined ? [] : [attribution.decisionObjectId] },
  ];
  const unsigned = {
    schemaVersion: 1 as const,
    kind: "publication-release-check" as const,
    projectId: state.projectId,
    branchId: state.branchId,
    sourceBranchSnapshotDigest: state.sourceBranchSnapshotDigest,
    sourceEventHeadCommitment: state.sourceEventHeadCommitment,
    reference: state.reference,
    verificationProfiles: profiles,
    checks,
    passed: checks.every((check) => check.passed),
  };
  return { ...unsigned, digest: computeContentHash(unsigned) };
}

function boundedEligibleReproductionCandidates(objects: readonly ObjectProjection[], maxJobs: number): ReproductionPlanEntry[] {
  return objects.filter((object) =>
    object.objectType === "run" &&
    isRecord(object.content) &&
    object.content.status === "succeeded" &&
    (object.content.nondeterminism === "deterministic" || object.content.nondeterminism === "seeded")
  ).sort((left, right) => left.objectId.localeCompare(right.objectId))
    .slice(0, maxJobs)
    .map((object) => ({
      runObjectId: object.objectId,
      runVersionId: object.versionId,
      reproducibility: (object.content as Record<string, unknown>).nondeterminism as "deterministic" | "seeded",
      replayMode: "inspect-export-only" as const,
      boundedBy: { maxJobs, network: "disabled" as const, externalEngineExecution: false as const },
    }));
}

function checkedReproductionMaxJobs(value: number | undefined): number {
  const maxJobs = value ?? DEFAULT_REPRODUCTION_MAX_JOBS;
  if (!Number.isSafeInteger(maxJobs) || maxJobs < 1) {
    throw new Error("Publication reproduction maxJobs must be a positive safe integer");
  }
  return maxJobs;
}

function reproductionPolicy(maxJobs: number): ReproductionPolicy {
  return {
    maxJobs,
    network: "disabled",
    externalEngineExecution: false,
    candidateSelection: "eligible-succeeded-deterministic-or-seeded-object-id-order",
    centralDesignation: "not-recorded",
  };
}

async function ensureNewDestination(destination: string): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  try {
    // A non-recursive mkdir is the ownership claim for the release root.  In
    // particular, do not turn an EEXIST race into a successful export that
    // could later remove a directory created by another process.
    await mkdir(destination);
  } catch (error) {
    if (isRecord(error) && error.code === "EEXIST") {
      throw new Error("Publication destination must not already exist: " + destination);
    }
    throw error;
  }
}

async function assertSourceUnchanged(projectRoot: string, expected: CapturedPublicationState["sourceHead"]): Promise<void> {
  if (!sameHead(await currentHead(projectRoot), expected)) {
    throw new Error("Source project changed during publication export; incomplete release was removed");
  }
}

function allSourceObjects(sourceState: BranchSourceState): SourceObjectEntry[] {
  return [...sourceState.objects, ...sourceState.attributionObjects]
    .sort((left, right) => String(left.envelope.objectId).localeCompare(String(right.envelope.objectId)));
}

function rebasedObjectEnvelope(entry: SourceObjectEntry, branchId: string): Record<string, unknown> {
  const source = ObjectEnvelopeSchema.parse(entry.envelope);
  const { supersedesVersionId: _supersedesVersionId, ...withoutSupersedes } = source;
  // A branch-scoped snapshot contains only the selected version. Preserve its
  // stable version ID/content/envelope provenance while rebasing the local
  // display counter and dropping ancestry that is not exported.
  return ObjectEnvelopeSchema.parse({ ...withoutSupersedes, branchId, version: 1 });
}

function rebasedSnapshotEvent(
  projectId: string,
  branchId: string,
  previous: Event,
  eventType: "ObjectVersionCreated" | "EdgeCreated" | "ArtifactRegistered",
  payload: Record<string, unknown>,
  source: SourceEventProvenance,
): Event {
  return EventSchema.parse(withEventHash({
    ...source.extensions,
    sequence: previous.sequence + 1,
    eventId: createId("evt"),
    eventType,
    occurredAt: source.occurredAt,
    projectId,
    branchId,
    actor: source.actor,
    schemaVersion: source.schemaVersion,
    payload,
    ...(source.causationId === undefined ? {} : { causationId: source.causationId }),
    ...(source.correlationId === undefined ? {} : { correlationId: source.correlationId }),
    previousEventHash: previous.eventHash,
  }));
}

async function appendSourceStateToSnapshot(
  root: string,
  snapshotProjectId: string,
  branchId: string,
  sourceState: BranchSourceState,
): Promise<void> {
  const initial = (await projectHistory(root)).at(-1);
  if (initial === undefined) throw new Error("Generated branch snapshot lacks an initial event head");
  let previous: Event = initial;
  const events: Event[] = [];
  const append = (
    eventType: "ObjectVersionCreated" | "EdgeCreated" | "ArtifactRegistered",
    payload: Record<string, unknown>,
    source: SourceEventProvenance,
  ) => {
    previous = rebasedSnapshotEvent(snapshotProjectId, branchId, previous, eventType, payload, source);
    events.push(previous);
  };
  for (const object of allSourceObjects(sourceState)) {
    append("ObjectVersionCreated", { object: rebasedObjectEnvelope(object, branchId) }, object.event);
  }
  for (const edge of sourceState.edges) {
    append("EdgeCreated", { edge: EdgeEnvelopeSchema.parse(edge.envelope) }, edge.event);
  }
  for (const artifact of sourceState.artifacts) {
    append("ArtifactRegistered", { artifact: ArtifactReferenceSchema.parse(artifact.artifact) }, artifact.event);
  }
  await appendEventsBatch(root, events);
  await rebuildProjection(root);
}

function objectReferenceIssues(objects: readonly ObjectProjection[]): string[] {
  const current = new Map(objects.map((object) => [object.objectId, object]));
  const issues: string[] = [];
  objects.forEach((object) => currentReferences(object.content, current, issues));
  return [...new Set(issues)].sort((left, right) => left.localeCompare(right));
}

interface SnapshotLineageDecision {
  readonly objectId: string;
  readonly versionId: string;
}

interface SnapshotSemanticEvidence {
  readonly reference: Awaited<ReturnType<typeof evaluateReferenceProject>>;
  readonly verificationProfiles: readonly VerificationProfile[];
}

async function assertCanonicalSnapshotHasNoProjectionCache(
  root: string,
  relativeRoot = "",
): Promise<void> {
  const entries = await readdir(join(root, relativeRoot), { withFileTypes: true });
  for (const entry of entries) {
    const path = relativeRoot.length === 0 ? entry.name : relativeRoot + "/" + entry.name;
    if (entry.isSymbolicLink()) {
      throw new Error("Canonical snapshot contains a symbolic link: " + path);
    }
    if (entry.name === ".reasoning") {
      throw new Error("Canonical snapshot contains a disposable projection cache: " + path);
    }
    if (entry.isDirectory()) await assertCanonicalSnapshotHasNoProjectionCache(root, path);
    else if (!entry.isFile()) throw new Error("Canonical snapshot contains an unsupported entry: " + path);
  }
}

async function makeCopiedTreeWritable(root: string): Promise<void> {
  const entry = await lstat(root);
  if (entry.isSymbolicLink()) throw new Error("Temporary canonical inspection copy contains a symbolic link: " + root);
  if (entry.isDirectory()) {
    await chmod(root, 0o700);
    const children = await readdir(root, { withFileTypes: true });
    for (const child of children) await makeCopiedTreeWritable(join(root, child.name));
    return;
  }
  if (!entry.isFile()) throw new Error("Temporary canonical inspection copy contains an unsupported entry: " + root);
  await chmod(root, 0o600);
}

/**
 * Reopen canonical state only in an external, writable throwaway copy. A
 * release must stay read-only and must never accept a local SQLite projection.
 */
async function withExternalCanonicalInspection<T>(
  canonicalRoot: string,
  operation: (workspace: string) => Promise<T>,
): Promise<T> {
  await assertCanonicalSnapshotHasNoProjectionCache(canonicalRoot);
  const temporary = await mkdtemp(join(tmpdir(), "rw-publication-inspection-"));
  const workspace = join(temporary, "canonical");
  try {
    await cp(canonicalRoot, workspace, { recursive: true, errorOnExist: true });
    // Re-check the copied tree, not only the source tree, before opening a
    // projection. This also rejects a cache entry introduced while cp ran.
    await assertCanonicalSnapshotHasNoProjectionCache(workspace);
    await makeCopiedTreeWritable(workspace);
    return await operation(workspace);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function assertSnapshotLineageDecision(
  objects: readonly ObjectProjection[],
  lineageDecision: SnapshotLineageDecision,
): ObjectProjection {
  const lineage = objects.find((object) =>
    object.objectId === lineageDecision.objectId && object.versionId === lineageDecision.versionId,
  );
  if (lineage === undefined || !contentKind(lineage, "branch-scoped-release-source-lineage")) {
    throw new Error("Canonical snapshot lacks its recorded branch-scoped source-lineage decision");
  }
  return lineage;
}

async function assertSnapshotFidelity(
  canonicalRoot: string,
  sourceState: BranchSourceState,
  referenceId: ReferenceProjectId,
  lineageDecision: SnapshotLineageDecision,
): Promise<SnapshotSemanticEvidence> {
  return withExternalCanonicalInspection(canonicalRoot, async (root) => {
    const inspection = await inspectProject(root);
    const branchId = inspection.manifest.defaultBranchId;
    const current = listCurrentObjects(root, branchId);
    assertSnapshotLineageDecision(current, lineageDecision);
    const copiedObjects = current.filter((object) => object.objectId !== lineageDecision.objectId);
    const expectedObjects = allSourceObjects(sourceState);
    if (copiedObjects.length !== expectedObjects.length) {
      throw new Error("Branch snapshot object set differs from the selected source state");
    }
    const copiedById = new Map(copiedObjects.map((object) => [object.objectId, object]));
    for (const source of expectedObjects) {
      const sourceEnvelope = ObjectEnvelopeSchema.parse(source.envelope);
      const copied = copiedById.get(sourceEnvelope.objectId);
      const expectedEnvelope = rebasedObjectEnvelope(source, branchId);
      if (
        copied === undefined ||
        copied.versionId !== sourceEnvelope.versionId ||
        copied.contentHash !== sourceEnvelope.contentHash ||
        canonicalJson(copied.envelope) !== canonicalJson(expectedEnvelope)
      ) {
        throw new Error("Branch snapshot did not preserve source object envelope: " + sourceEnvelope.objectId);
      }
    }
    const copiedEdges = listEdges(root, branchId)
      .map((edge) => EdgeEnvelopeSchema.parse(edge.envelope))
      .sort((left, right) => left.edgeId.localeCompare(right.edgeId));
    const expectedEdges = sourceState.edges
      .map((edge) => EdgeEnvelopeSchema.parse(edge.envelope))
      .sort((left, right) => left.edgeId.localeCompare(right.edgeId));
    if (canonicalJson(copiedEdges) !== canonicalJson(expectedEdges)) {
      throw new Error("Branch snapshot did not preserve source edge envelopes");
    }
    const copiedArtifacts = (await listVisibleArtifacts(root, branchId))
      .map((artifact) => ArtifactReferenceSchema.parse(artifact))
      .sort((left, right) => left.artifactId.localeCompare(right.artifactId));
    const expectedArtifacts = sourceState.artifacts
      .map((entry) => ArtifactReferenceSchema.parse(entry.artifact))
      .sort((left, right) => left.artifactId.localeCompare(right.artifactId));
    if (canonicalJson(copiedArtifacts) !== canonicalJson(expectedArtifacts)) {
      throw new Error("Branch snapshot did not preserve source artifact metadata");
    }
    const referenceIssues = objectReferenceIssues(current);
    const edgeIssues = exactEdgeIssues(sourceState.edges, new Map(current.map((object) => [object.objectId, object])));
    if (referenceIssues.length > 0 || edgeIssues.length > 0) {
      throw new Error("Branch snapshot has stale exact references: " + [...referenceIssues, ...edgeIssues].join(", "));
    }
    for (const document of current) {
      if (document.objectType === "document" && contentKind(document, "working-paper")) {
        getWorkingPaper(root, branchId, document.objectId);
      }
    }
    const reference = await evaluateReferenceProject(root, { referenceId, branchId });
    if (!reference.passed) {
      throw new Error("Branch snapshot failed reference acceptance: " + reference.assertions.filter((entry) => !entry.passed).map((entry) => entry.assertionId).join(", "));
    }
    return {
      reference,
      verificationProfiles: verificationProfilesFor(root, branchId, current),
    };
  });
}

async function materializeCanonicalSnapshot(
  sourceRoot: string,
  destination: string,
  state: CapturedPublicationState,
  referenceId: ReferenceProjectId,
): Promise<{
  projectId: string;
  eventHead: { sequence: number; eventHash: string };
  lineageDecision: SnapshotLineageDecision;
}> {
  const root = join(destination, "canonical");
  const snapshot = await createProject(root, { title: "Release snapshot — " + state.title });
  const branchId = snapshot.manifest.defaultBranchId;
  const sourceStore = new FileSystemArtifactStore(sourceRoot);
  const snapshotStore = new FileSystemArtifactStore(root);
  const digests = new Set(state.artifacts.map((artifact) => artifact.digest));
  for (const artifact of state.artifacts) artifact.inputs.forEach((digest) => digests.add(digest));
  for (const digest of [...digests].sort()) {
    await snapshotStore.putBytes(await sourceStore.read(digest));
  }
  await appendSourceStateToSnapshot(root, snapshot.manifest.projectId, branchId, state.sourceState);
  const lineage = await putObject(root, {
    branchId,
    objectType: "decision",
    content: {
      schemaVersion: 1,
      kind: "branch-scoped-release-source-lineage",
      sourceProjectId: state.projectId,
      sourceBranchId: state.branchId,
      sourceBranchSnapshotDigest: state.sourceBranchSnapshotDigest,
      sourceEventHeadCommitment: state.sourceEventHeadCommitment,
      sourceStatePath: SOURCE_STATE_PATH,
      sourceStateDigest: state.sourceBranchSnapshotDigest,
      disclosure: "selected-branch-only",
    },
  });
  const lineageDecision = { objectId: lineage.objectId, versionId: lineage.versionId };
  await rm(join(root, ".reasoning"), { recursive: true, force: true });
  // CAS writes use this staging directory transiently; it is not canonical
  // artifact state and would violate the portable release-path grammar.
  await rm(join(root, "artifacts", "sha256", ".tmp"), { recursive: true, force: true });
  await assertSnapshotFidelity(root, state.sourceState, referenceId, lineageDecision);
  const verified = await verifyProject(root);
  if (!verified.ok) throw new Error("Generated branch snapshot is invalid: " + verified.issues.map((issue) => issue.message).join("; "));
  const event = (await projectHistory(root)).at(-1);
  if (event === undefined) throw new Error("Generated branch snapshot lacks an event head");
  return {
    projectId: snapshot.manifest.projectId,
    eventHead: { sequence: event.sequence, eventHash: event.eventHash },
    lineageDecision,
  };
}

async function writeArtifactViews(
  sourceRoot: string,
  destination: string,
  artifacts: readonly ArtifactReference[],
): Promise<PublicationArtifactEntry[]> {
  const store = new FileSystemArtifactStore(sourceRoot);
  const entries: PublicationArtifactEntry[] = [];
  for (const artifact of artifacts) {
    const entry = publicationArtifactEntry(artifact);
    const outputPath = releasePath(destination, entry.path);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, await store.read(artifact.digest), { flag: "wx" });
    entries.push(entry);
  }
  return entries.sort((left, right) => left.artifactId.localeCompare(right.artifactId));
}

async function walkFiles(root: string, relativeRoot = ""): Promise<DerivedFileEntry[]> {
  const entries = await readdir(join(root, relativeRoot), { withFileTypes: true });
  const result: DerivedFileEntry[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = relativeRoot.length === 0 ? entry.name : relativeRoot + "/" + entry.name;
    releasePath(root, path);
    if (entry.isSymbolicLink()) throw new Error("Release contains unsupported symbolic link: " + path);
    if (entry.isDirectory()) result.push(...await walkFiles(root, path));
    else if (entry.isFile()) {
      const bytes = await readFile(join(root, path));
      result.push({ path, digest: sha256Digest(bytes), size: bytes.byteLength });
    } else throw new Error("Release contains unsupported non-file entry: " + path);
  }
  return result;
}

function releasePath(root: string, path: string): string {
  if (
    path.length === 0 ||
    path.includes("\0") ||
    path.includes("\\") ||
    isAbsolute(path) ||
    /^[A-Za-z]:/u.test(path)
  ) {
    throw new Error("Unsafe release path: " + path);
  }
  const segments = path.split("/");
  if (segments.some((segment) =>
    segment.length === 0 ||
    segment === "." ||
    segment === ".." ||
    !PORTABLE_RELEASE_SEGMENT.test(segment) ||
    WINDOWS_RESERVED_SEGMENT.test(segment) ||
    segment.endsWith(".")
  )) {
    throw new Error("Unsafe release path: " + path);
  }
  const candidate = resolve(root, path);
  const pathFromRoot = relative(root, candidate);
  if (pathFromRoot === "" || pathFromRoot === ".." || pathFromRoot.startsWith(".." + sep)) throw new Error("Release path escapes root: " + path);
  return candidate;
}

function assertDerivedFileEntries(
  destination: string,
  value: unknown,
  label: string,
): readonly DerivedFileEntry[] {
  if (!Array.isArray(value)) throw new Error(label + " must contain a file array");
  const paths = new Set<string>();
  const entries = value.map((entry) => {
    if (!isRecord(entry) || typeof entry.path !== "string" || typeof entry.digest !== "string" || typeof entry.size !== "number" || !Number.isSafeInteger(entry.size) || entry.size < 0) {
      throw new Error(label + " contains an invalid file entry");
    }
    assertExactKeys(entry, ["path", "digest", "size"], label + " file entry");
    releasePath(destination, entry.path);
    if (paths.has(entry.path)) throw new Error(label + " contains a duplicate path: " + entry.path);
    paths.add(entry.path);
    return { path: entry.path, digest: entry.digest, size: entry.size };
  });
  return entries;
}

function assertReleaseManifestPaths(destination: string, manifest: PublicationReleaseManifest): void {
  const root = manifest as unknown as Record<string, unknown>;
  assertExactKeys(root, [
    "schemaVersion", "kind", "projectId", "branchId", "sourceBranchSnapshotDigest", "sourceEventHeadCommitment",
    "sourceState", "canonicalSnapshot", "attribution", "objects", "edges", "artifacts", "checks",
    "reproductionPolicy", "reproductionPlan", "derivedFiles", "inventory", "digest",
  ], "publication-release manifest");
  if (!isRecord(manifest.canonicalSnapshot) || typeof manifest.canonicalSnapshot.root !== "string" || typeof manifest.canonicalSnapshot.projectId !== "string") {
    throw new Error("Invalid publication-release canonical snapshot path");
  }
  assertExactKeys(manifest.canonicalSnapshot, ["root", "projectId", "eventHead", "lineageDecision"], "publication-release canonical snapshot");
  releasePath(destination, manifest.canonicalSnapshot.root);
  if (manifest.canonicalSnapshot.root !== "canonical") throw new Error("Invalid publication-release manifest shape");
  if (!isRecord(manifest.canonicalSnapshot.eventHead) || typeof manifest.canonicalSnapshot.eventHead.sequence !== "number" || !Number.isSafeInteger(manifest.canonicalSnapshot.eventHead.sequence) || manifest.canonicalSnapshot.eventHead.sequence < 1 || typeof manifest.canonicalSnapshot.eventHead.eventHash !== "string") {
    throw new Error("Invalid publication-release canonical snapshot event head");
  }
  assertExactKeys(manifest.canonicalSnapshot.eventHead, ["sequence", "eventHash"], "publication-release canonical snapshot event head");
  if (!isRecord(manifest.canonicalSnapshot.lineageDecision) || typeof manifest.canonicalSnapshot.lineageDecision.objectId !== "string" || typeof manifest.canonicalSnapshot.lineageDecision.versionId !== "string") {
    throw new Error("Invalid publication-release lineage decision reference");
  }
  assertExactKeys(manifest.canonicalSnapshot.lineageDecision, ["objectId", "versionId"], "publication-release lineage decision reference");
  if (!isRecord(manifest.inventory) || typeof manifest.inventory.path !== "string") {
    throw new Error("Invalid publication-release inventory path");
  }
  assertExactKeys(manifest.inventory, ["path", "digest"], "publication-release inventory");
  releasePath(destination, manifest.inventory.path);
  if (manifest.inventory.path !== INVENTORY_PATH) throw new Error("Invalid publication-release inventory path");
  assertDerivedFileEntries(destination, manifest.derivedFiles, "Publication manifest");
  if (!Array.isArray(manifest.artifacts)) throw new Error("Invalid publication-release artifact paths");
  for (const artifact of manifest.artifacts) {
    if (!isRecord(artifact) || typeof artifact.path !== "string") throw new Error("Invalid publication-release artifact path");
    releasePath(destination, artifact.path);
  }
  if (!isRecord(manifest.sourceState) || typeof manifest.sourceState.path !== "string") {
    throw new Error("Invalid publication-release source-state path");
  }
  assertExactKeys(manifest.sourceState, ["path", "digest"], "publication-release source-state");
  releasePath(destination, manifest.sourceState.path);
  if (manifest.sourceState.path !== SOURCE_STATE_PATH) throw new Error("Invalid publication-release source-state path");
}

async function writeDerivedInventory(destination: string): Promise<DerivedFileInventory> {
  const files = (await walkFiles(destination)).filter((entry) => entry.path !== MANIFEST_PATH && entry.path !== INVENTORY_PATH);
  const unsigned = { schemaVersion: 1 as const, kind: "publication-derived-file-inventory" as const, files };
  const inventory: DerivedFileInventory = { ...unsigned, digest: computeContentHash(unsigned) };
  await writeFile(releasePath(destination, INVENTORY_PATH), canonicalJson(inventory) + "\n", { flag: "wx" });
  return inventory;
}

function parseCanonicalDigest<T extends object>(value: T, label: string): T {
  if (!isRecord(value)) throw new Error("Invalid " + label + " shape");
  const { digest, ...unsigned } = value as Record<string, unknown>;
  if (typeof digest !== "string" || computeContentHash(unsigned) !== digest) throw new Error("Invalid " + label + " digest");
  return value;
}

function parseSourceEventProvenance(value: unknown, label: string): SourceEventProvenance {
  if (!isRecord(value) || typeof value.eventId !== "string" || typeof value.occurredAt !== "string" || typeof value.schemaVersion !== "number" || !Number.isSafeInteger(value.schemaVersion) || value.schemaVersion < 1 || !isRecord(value.extensions)) {
    throw new Error("Invalid " + label + " event provenance");
  }
  assertAllowedKeys(value, ["eventId", "occurredAt", "actor", "schemaVersion", "sourceBranchId", "causationId", "correlationId", "extensions"], label + " event provenance");
  const actor = ActorSchema.parse(value.actor);
  if (value.sourceBranchId !== undefined && typeof value.sourceBranchId !== "string") throw new Error("Invalid " + label + " source branch");
  if (value.causationId !== undefined && typeof value.causationId !== "string") throw new Error("Invalid " + label + " causation ID");
  if (value.correlationId !== undefined && typeof value.correlationId !== "string") throw new Error("Invalid " + label + " correlation ID");
  canonicalJson(value.extensions);
  return {
    eventId: value.eventId,
    occurredAt: value.occurredAt,
    actor,
    schemaVersion: value.schemaVersion,
    ...(value.sourceBranchId === undefined ? {} : { sourceBranchId: value.sourceBranchId }),
    ...(value.causationId === undefined ? {} : { causationId: value.causationId }),
    ...(value.correlationId === undefined ? {} : { correlationId: value.correlationId }),
    extensions: value.extensions,
  };
}

function parseSourceObjectEntry(value: unknown, label: string): SourceObjectEntry {
  if (!isRecord(value)) throw new Error("Invalid " + label + " object entry");
  assertExactKeys(value, ["envelope", "event"], label + " object entry");
  return {
    envelope: ObjectEnvelopeSchema.parse(value.envelope),
    event: parseSourceEventProvenance(value.event, label),
  };
}

function parseSourceArtifactEntry(value: unknown, label: string): SourceArtifactEntry {
  if (!isRecord(value)) throw new Error("Invalid " + label + " artifact entry");
  assertExactKeys(value, ["artifact", "event"], label + " artifact entry");
  return {
    artifact: ArtifactReferenceSchema.parse(value.artifact),
    event: parseSourceEventProvenance(value.event, label),
  };
}

function parseSourceEdgeEntry(value: unknown, label: string): SourceEdgeEntry {
  if (!isRecord(value)) throw new Error("Invalid " + label + " edge entry");
  assertAllowedKeys(value, ["edgeId", "edgeType", "fromObjectId", "fromVersionId", "toObjectId", "toVersionId", "contextId", "metadata", "envelope", "event"], label + " edge entry");
  const envelope = EdgeEnvelopeSchema.parse(value.envelope);
  const event = parseSourceEventProvenance(value.event, label);
  if (
    value.edgeId !== envelope.edgeId ||
    value.edgeType !== envelope.edgeType ||
    value.fromObjectId !== envelope.from.objectId ||
    value.fromVersionId !== envelope.from.versionId ||
    value.toObjectId !== envelope.to.objectId ||
    value.toVersionId !== envelope.to.versionId ||
    canonicalJson(value.metadata) !== canonicalJson(envelope.metadata) ||
    (value.contextId ?? undefined) !== envelope.contextId
  ) {
    throw new Error("Invalid " + label + " edge fields");
  }
  return {
    edgeId: envelope.edgeId,
    edgeType: envelope.edgeType,
    fromObjectId: envelope.from.objectId,
    fromVersionId: envelope.from.versionId,
    toObjectId: envelope.to.objectId,
    toVersionId: envelope.to.versionId,
    ...(envelope.contextId === undefined ? {} : { contextId: envelope.contextId }),
    metadata: envelope.metadata,
    envelope,
    event,
  };
}

function parseBranchSourceState(value: unknown): BranchSourceState {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.kind !== "branch-scoped-publication-source-state" || typeof value.projectId !== "string" || typeof value.branchId !== "string" || !Array.isArray(value.objects) || !Array.isArray(value.attributionObjects) || !Array.isArray(value.artifacts) || !Array.isArray(value.edges) || typeof value.sourceBranchSnapshotDigest !== "string" || typeof value.sourceEventHeadCommitment !== "string") {
    throw new Error("Invalid branch source-state record");
  }
  assertExactKeys(value, ["schemaVersion", "kind", "projectId", "branchId", "objects", "attributionObjects", "artifacts", "edges", "sourceBranchSnapshotDigest", "sourceEventHeadCommitment"], "branch source-state record");
  const objects = value.objects.map((entry, index) => parseSourceObjectEntry(entry, "source-state.objects[" + index + "]"));
  const attributionObjects = value.attributionObjects.map((entry, index) => parseSourceObjectEntry(entry, "source-state.attributionObjects[" + index + "]"));
  const artifacts = value.artifacts.map((entry, index) => parseSourceArtifactEntry(entry, "source-state.artifacts[" + index + "]"));
  const edges = value.edges.map((entry, index) => parseSourceEdgeEntry(entry, "source-state.edges[" + index + "]"));
  if (objects.some(isAttributionEnvelope) || attributionObjects.some((entry) => !isAttributionEnvelope(entry))) {
    throw new Error("Invalid branch source-state attribution partition");
  }
  const unsigned = sourceStateDigestPayload(value.projectId, value.branchId, objects, artifacts, edges);
  if (computeContentHash(unsigned) !== value.sourceBranchSnapshotDigest) {
    throw new Error("Branch source-state snapshot digest mismatch");
  }
  return {
    ...unsigned,
    attributionObjects,
    sourceBranchSnapshotDigest: value.sourceBranchSnapshotDigest,
    sourceEventHeadCommitment: value.sourceEventHeadCommitment,
  };
}

function parseManifestObjectVersions(value: unknown): PublicationReleaseManifest["objects"] {
  if (!Array.isArray(value)) throw new Error("Invalid publication manifest object inventory");
  const objectIds = new Set<string>();
  const parsed = value.map((entry) => {
    if (!isRecord(entry) || typeof entry.objectId !== "string" || typeof entry.versionId !== "string" || typeof entry.objectType !== "string" || typeof entry.contentHash !== "string") {
      throw new Error("Invalid publication manifest object inventory entry");
    }
    assertExactKeys(entry, ["objectId", "versionId", "objectType", "contentHash"], "publication manifest object inventory entry");
    if (objectIds.has(entry.objectId)) throw new Error("Publication manifest object inventory contains a duplicate object: " + entry.objectId);
    objectIds.add(entry.objectId);
    return {
      objectId: entry.objectId,
      versionId: entry.versionId,
      objectType: entry.objectType,
      contentHash: entry.contentHash,
    };
  });
  return parsed.sort((left, right) => left.objectId.localeCompare(right.objectId));
}

function parseManifestArtifacts(
  destination: string,
  value: unknown,
): PublicationArtifactEntry[] {
  if (!Array.isArray(value)) throw new Error("Invalid publication manifest artifact inventory");
  const artifactIds = new Set<string>();
  const paths = new Set<string>();
  const parsed = value.map((entry) => {
    if (!isRecord(entry) || typeof entry.artifactId !== "string" || typeof entry.digest !== "string" || typeof entry.role !== "string" || typeof entry.path !== "string" || !isRecord(entry.lineage) || typeof entry.lineage.producedByRunId !== "string" || typeof entry.lineage.environmentId !== "string" || !Array.isArray(entry.lineage.inputs) || !entry.lineage.inputs.every((input) => typeof input === "string") || typeof entry.lineage.reproducibility !== "string") {
      throw new Error("Invalid publication manifest artifact inventory entry");
    }
    assertExactKeys(entry, ["artifactId", "digest", "role", "path", "lineage"], "publication manifest artifact inventory entry");
    assertExactKeys(entry.lineage, ["producedByRunId", "environmentId", "inputs", "reproducibility"], "publication manifest artifact lineage");
    releasePath(destination, entry.path);
    if (artifactIds.has(entry.artifactId) || paths.has(entry.path)) {
      throw new Error("Publication manifest artifact inventory contains a duplicate artifact or path: " + entry.artifactId);
    }
    artifactIds.add(entry.artifactId);
    paths.add(entry.path);
    return {
      artifactId: entry.artifactId,
      digest: entry.digest,
      role: entry.role,
      path: entry.path,
      lineage: {
        producedByRunId: entry.lineage.producedByRunId,
        environmentId: entry.lineage.environmentId,
        inputs: entry.lineage.inputs,
        reproducibility: entry.lineage.reproducibility,
      },
    };
  });
  return parsed.sort((left, right) => left.artifactId.localeCompare(right.artifactId));
}

function normalizeVerificationProfiles(
  value: unknown,
  label: string,
  expectedBranchId?: string,
): unknown[] {
  if (!Array.isArray(value)) throw new Error("Invalid " + label + " verification profiles");
  const profileIds = new Set<string>();
  const normalized = value.map((profile) => {
    if (!isRecord(profile) || typeof profile.branchId !== "string" || typeof profile.claimId !== "string" || typeof profile.claimVersionId !== "string" || typeof profile.contextId !== "string" || typeof profile.contextVersionId !== "string" || !Array.isArray(profile.dimensions)) {
      throw new Error("Invalid " + label + " verification profile");
    }
    assertExactKeys(profile, ["branchId", "claimId", "claimVersionId", "contextId", "contextVersionId", "dimensions"], label + " verification profile");
    if (expectedBranchId !== undefined && profile.branchId !== expectedBranchId) {
      throw new Error("Publication verification profile belongs to a different branch: " + profile.claimId);
    }
    if (profileIds.has(profile.claimId)) throw new Error("Duplicate " + label + " verification profile: " + profile.claimId);
    profileIds.add(profile.claimId);
    const dimensions = new Set<string>();
    for (const dimension of profile.dimensions) {
      if (!isRecord(dimension) || typeof dimension.dimension !== "string" || typeof dimension.status !== "string" || !Array.isArray(dimension.currentEvidenceObjectIds) || !dimension.currentEvidenceObjectIds.every((id) => typeof id === "string") || !Array.isArray(dimension.staleEvidenceObjectIds) || !dimension.staleEvidenceObjectIds.every((id) => typeof id === "string") || !Array.isArray(dimension.observations)) {
        throw new Error("Invalid " + label + " verification dimension");
      }
      assertExactKeys(dimension, ["dimension", "status", "currentEvidenceObjectIds", "staleEvidenceObjectIds", "observations"], label + " verification dimension");
      if (dimensions.has(dimension.dimension)) throw new Error("Duplicate " + label + " verification dimension: " + dimension.dimension);
      dimensions.add(dimension.dimension);
      if (dimension.status === "failed" || dimension.status === "stale") {
        throw new Error("Publication verification profile contains failed or stale evidence: " + profile.claimId);
      }
      for (const observation of dimension.observations) {
        if (!isRecord(observation) || typeof observation.evidenceObjectId !== "string" || typeof observation.evidenceVersionId !== "string" || typeof observation.dimension !== "string" || typeof observation.outcome !== "string" || typeof observation.assurance !== "string" || typeof observation.summary !== "string" || typeof observation.claimVersionId !== "string" || typeof observation.contextVersionId !== "string" || typeof observation.stale !== "boolean" || !Array.isArray(observation.staleReasons) || !observation.staleReasons.every((reason) => typeof reason === "string")) {
          throw new Error("Invalid " + label + " verification observation");
        }
        assertAllowedKeys(observation, ["evidenceObjectId", "evidenceVersionId", "dimension", "outcome", "assurance", "summary", "artifactId", "claimVersionId", "contextVersionId", "sourceObjectId", "sourceVersionId", "anchorId", "stale", "staleReasons"], label + " verification observation");
      }
    }
    const { branchId: _branchId, ...withoutBranch } = profile;
    return withoutBranch;
  });
  return normalized.sort((left, right) =>
    String((left as Record<string, unknown>).claimId).localeCompare(String((right as Record<string, unknown>).claimId)),
  );
}

function assertReferenceEvaluationShape(value: unknown, label: string): void {
  if (!isRecord(value) || (value.referenceId !== "RP-001" && value.referenceId !== "RP-002" && value.referenceId !== "RP-003") || value.passed !== true || !Array.isArray(value.assertions)) {
    throw new Error("Invalid " + label + " reference evaluation");
  }
  assertExactKeys(value, ["referenceId", "passed", "assertions"], label + " reference evaluation");
  const assertionIds = new Set<string>();
  for (const assertion of value.assertions) {
    if (!isRecord(assertion) || typeof assertion.assertionId !== "string" || assertion.passed !== true || typeof assertion.summary !== "string" || !Array.isArray(assertion.evidenceObjectIds) || !assertion.evidenceObjectIds.every((id) => typeof id === "string") || !Array.isArray(assertion.evidenceArtifactIds) || !assertion.evidenceArtifactIds.every((id) => typeof id === "string")) {
      throw new Error("Invalid " + label + " reference assertion");
    }
    assertExactKeys(assertion, ["assertionId", "passed", "summary", "evidenceObjectIds", "evidenceArtifactIds"], label + " reference assertion");
    if (assertionIds.has(assertion.assertionId)) throw new Error("Duplicate " + label + " reference assertion: " + assertion.assertionId);
    assertionIds.add(assertion.assertionId);
  }
}

function assertReleaseCheckReportShape(
  report: Record<string, unknown>,
  manifest: PublicationReleaseManifest,
  sourceState: BranchSourceState,
): void {
  assertExactKeys(report, ["schemaVersion", "kind", "projectId", "branchId", "sourceBranchSnapshotDigest", "sourceEventHeadCommitment", "reference", "verificationProfiles", "checks", "passed", "digest"], "publication release check report");
  if (
    report.schemaVersion !== 1 ||
    report.kind !== "publication-release-check" ||
    report.projectId !== manifest.projectId ||
    report.branchId !== manifest.branchId ||
    report.sourceBranchSnapshotDigest !== sourceState.sourceBranchSnapshotDigest ||
    report.sourceEventHeadCommitment !== sourceState.sourceEventHeadCommitment ||
    report.passed !== true
  ) {
    throw new Error("Invalid publication release check report shape");
  }
  assertReferenceEvaluationShape(report.reference, "publication release check");
  if (!Array.isArray(report.checks) || report.checks.length !== PUBLICATION_RELEASE_CHECK_IDS.length) {
    throw new Error("Publication release check must contain every required gate exactly once");
  }
  const checkIds = new Set<string>();
  for (const check of report.checks) {
    if (!isRecord(check) || typeof check.checkId !== "string" || !(PUBLICATION_RELEASE_CHECK_IDS as readonly string[]).includes(check.checkId) || check.passed !== true || typeof check.summary !== "string" || check.summary.trim().length === 0 || !Array.isArray(check.objectIds) || !check.objectIds.every((id) => typeof id === "string")) {
      throw new Error("Invalid publication release gate entry");
    }
    assertExactKeys(check, ["checkId", "passed", "summary", "objectIds"], "publication release gate entry");
    if (checkIds.has(check.checkId)) throw new Error("Duplicate publication release gate: " + check.checkId);
    checkIds.add(check.checkId);
    const checkId = check.checkId as (typeof PUBLICATION_RELEASE_CHECK_IDS)[number];
    const expectedObjectIds = checkId === "REL-008" ? [manifest.attribution.decisionObjectId] : [];
    if (check.summary !== PASSED_RELEASE_GATE_SUMMARIES[checkId] || canonicalJson(check.objectIds) !== canonicalJson(expectedObjectIds)) {
      throw new Error("Publication release gate payload does not match its deterministic passed result: " + checkId);
    }
  }
  if (PUBLICATION_RELEASE_CHECK_IDS.some((checkId) => !checkIds.has(checkId))) {
    throw new Error("Publication release check is missing a required gate");
  }
  normalizeVerificationProfiles(report.verificationProfiles, "publication release check", manifest.branchId);
}

function parseReproductionPlan(value: unknown, label: string): ReproductionPlanEntry[] {
  if (!Array.isArray(value)) throw new Error("Invalid " + label + " reproduction plan");
  const refs = new Set<string>();
  return value.map((entry) => {
    if (!isRecord(entry) || typeof entry.runObjectId !== "string" || typeof entry.runVersionId !== "string" || (entry.reproducibility !== "deterministic" && entry.reproducibility !== "seeded") || entry.replayMode !== "inspect-export-only" || !isRecord(entry.boundedBy) || typeof entry.boundedBy.maxJobs !== "number" || !Number.isSafeInteger(entry.boundedBy.maxJobs) || entry.boundedBy.maxJobs < 1 || entry.boundedBy.network !== "disabled" || entry.boundedBy.externalEngineExecution !== false) {
      throw new Error("Invalid " + label + " reproduction plan entry");
    }
    assertExactKeys(entry, ["runObjectId", "runVersionId", "reproducibility", "replayMode", "boundedBy"], label + " reproduction plan entry");
    assertExactKeys(entry.boundedBy, ["maxJobs", "network", "externalEngineExecution"], label + " reproduction plan bound");
    const key = entry.runObjectId + "@" + entry.runVersionId;
    if (refs.has(key)) throw new Error("Duplicate " + label + " reproduction run reference: " + key);
    refs.add(key);
    return {
      runObjectId: entry.runObjectId,
      runVersionId: entry.runVersionId,
      reproducibility: entry.reproducibility,
      replayMode: entry.replayMode,
      boundedBy: {
        maxJobs: entry.boundedBy.maxJobs,
        network: entry.boundedBy.network,
        externalEngineExecution: entry.boundedBy.externalEngineExecution,
      },
    };
  });
}

function parseReproductionPolicy(value: unknown, label: string): ReproductionPolicy {
  if (!isRecord(value) || typeof value.maxJobs !== "number" || !Number.isSafeInteger(value.maxJobs) || value.maxJobs < 1 || value.network !== "disabled" || value.externalEngineExecution !== false || value.candidateSelection !== "eligible-succeeded-deterministic-or-seeded-object-id-order" || value.centralDesignation !== "not-recorded") {
    throw new Error("Invalid " + label + " reproduction policy");
  }
  assertExactKeys(value, ["maxJobs", "network", "externalEngineExecution", "candidateSelection", "centralDesignation"], label + " reproduction policy");
  return {
    maxJobs: value.maxJobs,
    network: value.network,
    externalEngineExecution: value.externalEngineExecution,
    candidateSelection: value.candidateSelection,
    centralDesignation: value.centralDesignation,
  };
}

function sourceObjectProjections(sourceState: BranchSourceState): ObjectProjection[] {
  return allSourceObjects(sourceState).map((entry) => {
    const object = ObjectEnvelopeSchema.parse(entry.envelope);
    return {
      branchId: object.branchId,
      objectId: object.objectId,
      objectType: object.objectType,
      versionId: object.versionId,
      version: object.version,
      createdAt: object.createdAt,
      contentHash: object.contentHash,
      content: object.content,
      envelope: object,
    };
  });
}

function assertReproductionPlanSourceBindings(
  plan: readonly ReproductionPlanEntry[],
  sourceState: BranchSourceState,
  policy: ReproductionPolicy,
): void {
  if (plan.length > policy.maxJobs || plan.some((entry) =>
    entry.boundedBy.maxJobs !== policy.maxJobs ||
    entry.boundedBy.network !== policy.network ||
    entry.boundedBy.externalEngineExecution !== policy.externalEngineExecution,
  )) {
    throw new Error("Publication reproduction plan exceeds or disagrees with its declared policy");
  }
  const expected = boundedEligibleReproductionCandidates(sourceObjectProjections(sourceState), policy.maxJobs);
  if (canonicalJson(plan) !== canonicalJson(expected)) {
    throw new Error("Publication reproduction plan does not match bounded eligible source run candidates");
  }
}

function parseEnvironmentViews(value: unknown): PublicationEnvironmentEntry[] {
  if (!Array.isArray(value)) throw new Error("Invalid release environment view");
  const objectIds = new Set<string>();
  const parsed = value.map((entry) => {
    if (!isRecord(entry) || typeof entry.objectId !== "string" || typeof entry.versionId !== "string" || typeof entry.contentHash !== "string") {
      throw new Error("Invalid release environment view entry");
    }
    assertExactKeys(entry, ["objectId", "versionId", "contentHash"], "release environment view entry");
    if (objectIds.has(entry.objectId)) throw new Error("Duplicate release environment view object: " + entry.objectId);
    objectIds.add(entry.objectId);
    return { objectId: entry.objectId, versionId: entry.versionId, contentHash: entry.contentHash };
  });
  return parsed.sort((left, right) => left.objectId.localeCompare(right.objectId));
}

function assertManifestSourceBindings(
  destination: string,
  manifest: PublicationReleaseManifest,
  sourceState: BranchSourceState,
  inventoryFiles: readonly DerivedFileEntry[],
): void {
  const manifestObjects = parseManifestObjectVersions(manifest.objects);
  const expectedObjects = sourceObjectVersions(sourceState);
  if (canonicalJson(manifest.objects) !== canonicalJson(expectedObjects) || canonicalJson(manifestObjects) !== canonicalJson(expectedObjects)) {
    throw new Error("Publication manifest objects do not match the selected source state");
  }
  if (!Array.isArray(manifest.edges)) throw new Error("Invalid publication manifest edge inventory");
  manifest.edges.forEach((edge, index) => parseSourceEdgeEntry(edge, "publication manifest edges[" + index + "]"));
  if (canonicalJson(manifest.edges) !== canonicalJson(sourceState.edges)) {
    throw new Error("Publication manifest edges do not match the selected source state");
  }
  const manifestArtifacts = parseManifestArtifacts(destination, manifest.artifacts);
  const expectedArtifacts = sourceArtifactViews(sourceState);
  if (canonicalJson(manifest.artifacts) !== canonicalJson(expectedArtifacts) || canonicalJson(manifestArtifacts) !== canonicalJson(expectedArtifacts)) {
    throw new Error("Publication manifest artifacts do not match the selected source state");
  }
  const inventoryByPath = new Map(inventoryFiles.map((entry) => [entry.path, entry]));
  for (const artifact of expectedArtifacts) {
    const inventory = inventoryByPath.get(artifact.path);
    if (inventory === undefined || inventory.digest !== artifact.digest) {
      throw new Error("Publication artifact view is not bound to its inventory digest: " + artifact.artifactId);
    }
    const source = sourceState.artifacts.find((entry) => entry.artifact.artifactId === artifact.artifactId)?.artifact;
    if (source === undefined || inventory.size !== source.size) {
      throw new Error("Publication artifact view is not bound to its source metadata: " + artifact.artifactId);
    }
  }
}

function referenceIdFromManifest(manifest: PublicationReleaseManifest): ReferenceProjectId {
  const reference = isRecord(manifest.checks) && isRecord(manifest.checks.reference)
    ? manifest.checks.reference.referenceId
    : undefined;
  if (reference !== "RP-001" && reference !== "RP-002" && reference !== "RP-003") {
    throw new Error("Invalid publication-release reference ID");
  }
  return reference;
}

function assertAttributionConsistency(
  manifest: PublicationReleaseManifest,
  sourceState: BranchSourceState,
): void {
  if (
    !isRecord(manifest.attribution) ||
    typeof manifest.attribution.decisionObjectId !== "string" ||
    typeof manifest.attribution.decisionVersionId !== "string" ||
    typeof manifest.attribution.attributedBranchSnapshotDigest !== "string" ||
    manifest.attribution.authorityBoundary !== "trusted-local-transport"
  ) {
    throw new Error("Invalid publication attribution shape");
  }
  assertExactKeys(manifest.attribution, ["decisionObjectId", "decisionVersionId", "attributedBranchSnapshotDigest", "authorityBoundary"], "publication attribution");
  if (manifest.attribution.attributedBranchSnapshotDigest !== manifest.sourceBranchSnapshotDigest) {
    throw new Error("Publication attribution does not bind the manifest source state");
  }
  const matched = sourceState.attributionObjects.find((entry) => {
    const envelope = ObjectEnvelopeSchema.parse(entry.envelope);
    return envelope.objectId === manifest.attribution.decisionObjectId && envelope.versionId === manifest.attribution.decisionVersionId;
  });
  if (matched === undefined) throw new Error("Publication attribution is absent from the source-state record");
  const envelope = ObjectEnvelopeSchema.parse(matched.envelope);
  if (!isRecord(envelope.content)) {
    throw new Error("Publication attribution is inconsistent with the source-state record");
  }
  assertExactKeys(envelope.content, ["schemaVersion", "kind", "status", "releaseLabel", "authorityBoundary", "attributedBranchSnapshotDigest", "externalPublication", "limitation"], "publication attribution decision content");
  if (
    envelope.createdBy.actorType !== "human" ||
    envelope.content.schemaVersion !== 1 ||
    envelope.content.kind !== "publication-release-attribution" ||
    envelope.content.status !== "recorded" ||
    typeof envelope.content.releaseLabel !== "string" ||
    envelope.content.releaseLabel.trim().length === 0 ||
    envelope.content.authorityBoundary !== "trusted-local-transport" ||
    envelope.content.attributedBranchSnapshotDigest !== manifest.sourceBranchSnapshotDigest ||
    envelope.content.externalPublication !== "not-performed" ||
    envelope.content.limitation !== "Local actor attribution is not authentication and does not authorize external publication." ||
    manifest.attribution.authorityBoundary !== "trusted-local-transport"
  ) {
    throw new Error("Publication attribution is inconsistent with the source-state record");
  }
}

async function assertReleaseConsistency(
  destination: string,
  manifest: PublicationReleaseManifest,
  inventoryFiles: readonly DerivedFileEntry[],
): Promise<void> {
  const sourceState = parseBranchSourceState(JSON.parse(await readFile(releasePath(destination, SOURCE_STATE_PATH), "utf8")) as unknown);
  if (
    manifest.projectId !== sourceState.projectId ||
    manifest.branchId !== sourceState.branchId ||
    manifest.sourceBranchSnapshotDigest !== sourceState.sourceBranchSnapshotDigest ||
    manifest.sourceEventHeadCommitment !== sourceState.sourceEventHeadCommitment ||
    manifest.sourceState.digest !== sourceState.sourceBranchSnapshotDigest
  ) {
    throw new Error("Publication manifest does not match the branch source-state record");
  }
  assertManifestSourceBindings(destination, manifest, sourceState, inventoryFiles);
  if (!isRecord(manifest.checks) || manifest.checks.sourceBranchSnapshotDigest !== manifest.sourceBranchSnapshotDigest || manifest.checks.sourceEventHeadCommitment !== manifest.sourceEventHeadCommitment) {
    throw new Error("Publication release check does not match manifest source lineage");
  }
  assertAttributionConsistency(manifest, sourceState);
  const releaseCheck = parseCanonicalDigest(JSON.parse(await readFile(releasePath(destination, "verification/release-check.json"), "utf8")) as Record<string, unknown>, "release check report");
  assertReleaseCheckReportShape(releaseCheck, manifest, sourceState);
  if (
    releaseCheck.digest !== manifest.checks.digest ||
    canonicalJson(releaseCheck) !== canonicalJson(manifest.checks) ||
    releaseCheck.sourceBranchSnapshotDigest !== manifest.sourceBranchSnapshotDigest ||
    releaseCheck.sourceEventHeadCommitment !== manifest.sourceEventHeadCommitment
  ) {
    throw new Error("Stored release check does not match publication manifest lineage");
  }
  const reproduction = parseCanonicalDigest(JSON.parse(await readFile(releasePath(destination, "verification/reproduction-report.json"), "utf8")) as Record<string, unknown>, "bounded reproduction report");
  assertExactKeys(reproduction, ["schemaVersion", "kind", "result", "reason", "reproductionPolicy", "plan", "digest"], "bounded reproduction report");
  if (reproduction.schemaVersion !== 1 || reproduction.kind !== "bounded-reproduction-report" || reproduction.result !== "not-executed" || reproduction.reason !== REPRODUCTION_NOT_EXECUTED_REASON) {
    throw new Error("Invalid bounded reproduction report semantics");
  }
  const reportPolicy = parseReproductionPolicy(reproduction.reproductionPolicy, "bounded reproduction report");
  const manifestPolicy = parseReproductionPolicy(manifest.reproductionPolicy, "publication manifest");
  if (canonicalJson(reproduction.reproductionPolicy) !== canonicalJson(reportPolicy) || canonicalJson(manifest.reproductionPolicy) !== canonicalJson(manifestPolicy) || canonicalJson(reportPolicy) !== canonicalJson(manifestPolicy)) {
    throw new Error("Stored reproduction policy does not match the publication manifest");
  }
  const reportPlan = parseReproductionPlan(reproduction.plan, "bounded reproduction report");
  const manifestPlan = parseReproductionPlan(manifest.reproductionPlan, "publication manifest");
  if (canonicalJson(reproduction.plan) !== canonicalJson(reportPlan) || canonicalJson(manifest.reproductionPlan) !== canonicalJson(manifestPlan) || canonicalJson(reportPlan) !== canonicalJson(manifestPlan)) {
    throw new Error("Stored reproduction plan does not match the publication manifest");
  }
  assertReproductionPlanSourceBindings(reportPlan, sourceState, reportPolicy);
  const artifactLineage = JSON.parse(await readFile(releasePath(destination, "provenance/artifact-lineage.json"), "utf8")) as unknown;
  const parsedArtifactLineage = parseManifestArtifacts(destination, artifactLineage);
  if (!Array.isArray(artifactLineage) || canonicalJson(artifactLineage) !== canonicalJson(manifest.artifacts) || canonicalJson(parsedArtifactLineage) !== canonicalJson(manifest.artifacts)) {
    throw new Error("Stored artifact lineage does not match the publication manifest");
  }
  const environments = JSON.parse(await readFile(releasePath(destination, "environments/release-environments.json"), "utf8")) as unknown;
  const parsedEnvironments = parseEnvironmentViews(environments);
  const expectedEnvironments = sourceEnvironmentViews(sourceState);
  if (canonicalJson(environments) !== canonicalJson(expectedEnvironments) || canonicalJson(parsedEnvironments) !== canonicalJson(expectedEnvironments)) {
    throw new Error("Release environment view does not match the selected source state");
  }
  const canonicalRoot = releasePath(destination, manifest.canonicalSnapshot.root);
  await withExternalCanonicalInspection(canonicalRoot, async (workspace) => {
    const inspection = await inspectProject(workspace);
    if (inspection.manifest.projectId !== manifest.canonicalSnapshot.projectId) {
      throw new Error("Canonical snapshot project ID does not match publication manifest");
    }
    const lineage = assertSnapshotLineageDecision(
      listCurrentObjects(workspace, inspection.manifest.defaultBranchId),
      manifest.canonicalSnapshot.lineageDecision,
    );
    const content = lineage.content;
    if (!isRecord(content)) {
      throw new Error("Canonical snapshot lineage decision does not match publication manifest");
    }
    assertExactKeys(content, ["schemaVersion", "kind", "sourceProjectId", "sourceBranchId", "sourceBranchSnapshotDigest", "sourceEventHeadCommitment", "sourceStatePath", "sourceStateDigest", "disclosure"], "canonical snapshot lineage decision content");
    if (content.schemaVersion !== 1 ||
      content.kind !== "branch-scoped-release-source-lineage" ||
      content.sourceProjectId !== manifest.projectId ||
      content.sourceBranchId !== manifest.branchId ||
      content.sourceBranchSnapshotDigest !== manifest.sourceBranchSnapshotDigest ||
      content.sourceEventHeadCommitment !== manifest.sourceEventHeadCommitment ||
      content.sourceStatePath !== SOURCE_STATE_PATH ||
      content.sourceStateDigest !== manifest.sourceState.digest ||
      content.disclosure !== "selected-branch-only"
    ) {
      throw new Error("Canonical snapshot lineage decision does not match publication manifest");
    }
    const head = (await projectHistory(workspace)).at(-1);
    if (head === undefined || head.sequence !== manifest.canonicalSnapshot.eventHead.sequence || head.eventHash !== manifest.canonicalSnapshot.eventHead.eventHash) {
      throw new Error("Canonical snapshot event head does not match publication manifest");
    }
  });
  const semantic = await assertSnapshotFidelity(canonicalRoot, sourceState, referenceIdFromManifest(manifest), manifest.canonicalSnapshot.lineageDecision);
  if (canonicalJson(releaseCheck.reference) !== canonicalJson(semantic.reference)) {
    throw new Error("Publication release reference evaluation does not match the reopened canonical snapshot");
  }
  if (canonicalJson(normalizeVerificationProfiles(releaseCheck.verificationProfiles, "publication release check", manifest.branchId)) !== canonicalJson(normalizeVerificationProfiles(semantic.verificationProfiles, "reopened canonical snapshot"))) {
    throw new Error("Publication verification profiles do not match the reopened canonical snapshot");
  }
}

async function assertDerivedInventory(destination: string, manifest: PublicationReleaseManifest): Promise<readonly DerivedFileEntry[]> {
  const inventory = parseCanonicalDigest(JSON.parse(await readFile(releasePath(destination, INVENTORY_PATH), "utf8")) as DerivedFileInventory, "release inventory");
  assertExactKeys(inventory as unknown as Record<string, unknown>, ["schemaVersion", "kind", "files", "digest"], "release inventory");
  const inventoryFiles = assertDerivedFileEntries(destination, inventory.files, "Release inventory");
  if (inventory.kind !== "publication-derived-file-inventory" || inventory.schemaVersion !== 1 || inventory.digest !== manifest.inventory.digest) throw new Error("Publication inventory does not match release manifest");
  if (canonicalJson(inventoryFiles) !== canonicalJson(assertDerivedFileEntries(destination, manifest.derivedFiles, "Publication manifest"))) throw new Error("Publication manifest file inventory differs from inventory artifact");
  const actual = await walkFiles(destination);
  const expected = new Set([...inventoryFiles.map((entry) => entry.path), INVENTORY_PATH, MANIFEST_PATH]);
  const actualPaths = new Set(actual.map((entry) => entry.path));
  const missing = [...expected].filter((path) => !actualPaths.has(path));
  const extras = [...actualPaths].filter((path) => !expected.has(path));
  if (missing.length > 0 || extras.length > 0) {
    throw new Error("Release inventory mismatch: missing=" + (missing.join(",") || "none") + "; extra=" + (extras.join(",") || "none"));
  }
  for (const entry of inventoryFiles) {
    const bytes = await readFile(releasePath(destination, entry.path));
    if (sha256Digest(bytes) !== entry.digest || bytes.byteLength !== entry.size) throw new Error("Release file integrity failure: " + entry.path);
  }
  return inventoryFiles;
}

function isInsidePath(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot === "" || (
    !isAbsolute(fromRoot) &&
    fromRoot !== ".." &&
    !fromRoot.startsWith(".." + sep)
  );
}

function lexicalCommonAncestor(left: string, right: string): string {
  let candidate = resolve(left);
  while (!isInsidePath(candidate, right)) {
    const parent = dirname(candidate);
    if (parent === candidate) return candidate;
    candidate = parent;
  }
  return candidate;
}

async function assertNoDestinationSymbolicLinkComponents(
  source: string,
  destination: string,
): Promise<void> {
  // Do not reject a shared platform-level alias (for example /var on macOS),
  // but reject every existing destination component after the two lexical
  // paths diverge. This closes aliases such as source-alias/release and an
  // alias with already-existing children.
  const common = lexicalCommonAncestor(source, destination);
  let cursor = common;
  const suffix = relative(common, destination);
  for (const segment of suffix.split(sep).filter((value) => value.length > 0)) {
    cursor = join(cursor, segment);
    try {
      const entry = await lstat(cursor);
      if (entry.isSymbolicLink()) {
        throw new Error("Publication destination must not traverse a symbolic-link ancestor: " + cursor);
      }
    } catch (error) {
      if (isRecord(error) && error.code === "ENOENT") return;
      throw error;
    }
  }
}

async function realDestinationCandidate(destination: string): Promise<string> {
  let ancestor = destination;
  const unresolved: string[] = [];
  for (;;) {
    try {
      const entry = await lstat(ancestor);
      // A destination root is claimed only after this check. In particular, a
      // user-controlled symlink parent cannot redirect a lexical sibling path
      // back into the source project between the containment decision and mkdir.
      if (entry.isSymbolicLink()) {
        throw new Error("Publication destination must not traverse a symbolic-link ancestor: " + ancestor);
      }
      return resolve(await realpath(ancestor), ...unresolved);
    } catch (error) {
      if (!isRecord(error) || error.code !== "ENOENT") throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw new Error("Publication destination has no existing filesystem ancestor: " + destination);
      unresolved.unshift(basename(ancestor));
      ancestor = parent;
    }
  }
}

async function releaseDestinationOutsideSource(projectRoot: string, destinationRoot: string): Promise<string> {
  const source = resolve(projectRoot);
  const destination = resolve(destinationRoot);
  await assertNoDestinationSymbolicLinkComponents(source, destination);
  const sourceReal = await realpath(source);
  const destinationReal = await realDestinationCandidate(destination);
  if (isInsidePath(source, destination) || isInsidePath(sourceReal, destinationReal)) {
    throw new Error("Publication destination must be outside the source project");
  }
  return destination;
}

export async function buildPublicationRelease(
  projectRoot: string,
  destinationRoot: string,
  options: { referenceId: ReferenceProjectId; branchId: string; maxJobs?: number },
): Promise<BuiltPublicationRelease> {
  const maxJobs = checkedReproductionMaxJobs(options.maxJobs);
  const policy = reproductionPolicy(maxJobs);
  const destination = await releaseDestinationOutsideSource(projectRoot, destinationRoot);
  const state = await capturePublicationState(projectRoot, options);
  const report = reportFromState(projectRoot, state);
  if (!report.passed) throw new Error("Publication release check failed: " + report.checks.filter((check) => !check.passed).map((check) => check.checkId).join(", "));
  let destinationCreated = false;
  try {
    await ensureNewDestination(destination);
    destinationCreated = true;
    await assertSourceUnchanged(projectRoot, state.sourceHead);
    for (const directory of RELEASE_DIRECTORIES) await mkdir(join(destination, directory), { recursive: true });
    const snapshot = await materializeCanonicalSnapshot(projectRoot, destination, state, options.referenceId);
    const artifacts = await writeArtifactViews(projectRoot, destination, state.artifacts);
    const plan = boundedEligibleReproductionCandidates(state.objects, maxJobs);
    const reproductionUnsigned = {
      schemaVersion: 1,
      kind: "bounded-reproduction-report",
      result: "not-executed",
      reason: REPRODUCTION_NOT_EXECUTED_REASON,
      reproductionPolicy: policy,
      plan,
    };
    const reproduction = { ...reproductionUnsigned, digest: computeContentHash(reproductionUnsigned) };
    await writeFile(releasePath(destination, "verification/release-check.json"), canonicalJson(report) + "\n", { flag: "wx" });
    await writeFile(releasePath(destination, "verification/reproduction-report.json"), canonicalJson(reproduction) + "\n", { flag: "wx" });
    await writeFile(releasePath(destination, "environments/release-environments.json"), canonicalJson(sourceEnvironmentViews(state.sourceState)) + "\n", { flag: "wx" });
    await writeFile(releasePath(destination, "provenance/artifact-lineage.json"), canonicalJson(artifacts) + "\n", { flag: "wx" });
    await writeFile(releasePath(destination, SOURCE_STATE_PATH), canonicalJson(state.sourceState) + "\n", { flag: "wx" });
    await assertSourceUnchanged(projectRoot, state.sourceHead);
    const inventory = await writeDerivedInventory(destination);
    const attribution = attributionFor(state);
    if (attribution === undefined) throw new Error("Publication attribution disappeared before export");
    const unsigned = {
      schemaVersion: 1 as const,
      kind: "publication-release" as const,
      projectId: state.projectId,
      branchId: state.branchId,
      sourceBranchSnapshotDigest: state.sourceBranchSnapshotDigest,
      sourceEventHeadCommitment: state.sourceEventHeadCommitment,
      sourceState: { path: SOURCE_STATE_PATH as "provenance/branch-source-state.json", digest: state.sourceBranchSnapshotDigest },
      canonicalSnapshot: {
        root: "canonical" as const,
        projectId: snapshot.projectId,
        eventHead: snapshot.eventHead,
        lineageDecision: snapshot.lineageDecision,
      },
      attribution,
      objects: objectVersions(state.objects),
      edges: state.edges,
      artifacts,
      checks: report,
      reproductionPolicy: policy,
      reproductionPlan: plan,
      derivedFiles: inventory.files,
      inventory: { path: INVENTORY_PATH as "provenance/release-inventory.json", digest: inventory.digest },
    };
    const manifest: PublicationReleaseManifest = { ...unsigned, digest: computeContentHash(unsigned) };
    await writeFile(releasePath(destination, MANIFEST_PATH), canonicalJson(manifest) + "\n", { flag: "wx" });
    await assertSourceUnchanged(projectRoot, state.sourceHead);
    return { destinationRoot: destination, manifestPath: join(destination, MANIFEST_PATH), manifest };
  } catch (error) {
    if (destinationCreated) {
      await rm(destination, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
    throw error;
  }
}

export async function inspectPublicationRelease(root: string): Promise<PublicationReleaseManifest> {
  const destination = resolve(root);
  const manifest = parseCanonicalDigest(JSON.parse(await readFile(releasePath(destination, MANIFEST_PATH), "utf8")) as PublicationReleaseManifest, "publication-release manifest");
  if (manifest.kind !== "publication-release" || manifest.schemaVersion !== 1) throw new Error("Invalid publication-release manifest shape");
  assertReleaseManifestPaths(destination, manifest);
  const inventoryFiles = await assertDerivedInventory(destination, manifest);
  await assertReleaseConsistency(destination, manifest, inventoryFiles);
  return manifest;
}

export async function reproducePublicationRelease(root: string): Promise<{ canonicalIntegrity: boolean; manifestIntegrity: boolean; reportPresent: boolean; execution: "not-attempted" }> {
  const destination = resolve(root);
  const manifest = await inspectPublicationRelease(destination);
  const canonical = await verifyProject(releasePath(destination, manifest.canonicalSnapshot.root));
  if (!canonical.ok) throw new Error("Branch-scoped canonical snapshot failed verification: " + canonical.issues.map((issue) => issue.message).join("; "));
  const report = parseCanonicalDigest(JSON.parse(await readFile(releasePath(destination, "verification/reproduction-report.json"), "utf8")) as Record<string, unknown>, "bounded reproduction report");
  const releaseCheck = parseCanonicalDigest(JSON.parse(await readFile(releasePath(destination, "verification/release-check.json"), "utf8")) as Record<string, unknown>, "release check report");
  if (releaseCheck.digest !== manifest.checks.digest || report.kind !== "bounded-reproduction-report") throw new Error("Release reports do not match the publication manifest");
  for (const artifact of manifest.artifacts) {
    const bytes = await readFile(releasePath(destination, artifact.path));
    if (sha256Digest(bytes) !== artifact.digest) throw new Error("Artifact view digest mismatch: " + artifact.path);
  }
  return { canonicalIntegrity: true, manifestIntegrity: true, reportPresent: true, execution: "not-attempted" };
}
