import { randomUUID } from "node:crypto";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  ActorSchema,
  ArtifactReferenceSchema,
  CURRENT_FORMAT_VERSION,
  EdgeEnvelopeSchema,
  EventSchema,
  HASH_ALGORITHM,
  ObjectEnvelopeSchema,
  PROJECT_FORMAT,
  ProjectManifestSchema,
  canonicalJson,
  computeContentHash,
  createId,
  createObjectId,
  utcNow,
  verifyContentHash,
  verifyEventHash,
  withEventHash,
  type Actor,
  type ArtifactReference,
  type EdgeEnvelope,
  type EdgeType,
  type Event,
  type KnownEventType,
  type ObjectEnvelope,
  type ObjectType,
  type ProjectManifest,
} from "@reasoning-workbench/project-format";

import {
  FileSystemArtifactStore,
  normalizeSha256Digest,
  type ArtifactStoreVerificationReport,
  type StoredArtifact,
} from "./cas.js";
import {
  appendEvent,
  initializeEventLog,
  readAcceptedEvents,
  verifyEventLog,
  type EventLogInspection,
} from "./event-log.js";
import {
  PROJECTION_RELATIVE_PATH,
  branchExists,
  getObjectHistory,
  getProjectProjection,
  listBranches,
  listCurrentObjects,
  listEdges,
  rebuildProjection,
  type BranchProjection,
  type EdgeProjection,
  type ObjectProjection,
  type ProjectProjection,
  type StoredEvent,
} from "./projection.js";

export const MANIFEST_FILE_NAME = "reasoning-project.json";
export const CANONICAL_DIRECTORIES = [
  "events",
  "objects",
  "documents",
  "code",
  "proofs",
  "sources",
  "environments",
  "artifacts",
] as const;

const DEFAULT_SYSTEM_ACTOR: Actor = ActorSchema.parse({
  actorType: "system",
  actorId: createId("sys"),
});

export interface CreateProjectOptions {
  title: string;
  actor?: Actor;
  defaultBranchName?: string;
  extensions?: Record<string, unknown>;
}

export interface CreatedProject {
  root: string;
  manifest: ProjectManifest;
  defaultBranch: BranchProjection;
  projection: ProjectProjection;
}

export interface CreateBranchOptions {
  name: string;
  baseBranchId?: string;
  actor?: Actor;
}

export interface PutObjectOptions {
  branchId: string;
  objectType: ObjectType;
  content: Record<string, unknown>;
  actor?: Actor;
  objectId?: string;
  extensions?: Record<string, unknown>;
}

export interface AddEdgeOptions {
  branchId: string;
  edgeType: EdgeType;
  fromObjectId: string;
  toObjectId: string;
  fromVersionId?: string;
  toVersionId?: string;
  contextId?: string;
  metadata?: Record<string, unknown>;
  actor?: Actor;
  extensions?: Record<string, unknown>;
}

export interface RegisterArtifactOptions {
  branchId: string;
  mediaType: string;
  logicalName: string;
  actor?: Actor;
  producedByRunId: string;
  environmentId: string;
  inputs?: string[];
  reproducibility?:
    | "deterministic"
    | "seeded"
    | "nondeterministic"
    | "externally-sourced";
  extensions?: Record<string, unknown>;
}

export interface RegisteredArtifact {
  receipt: StoredArtifact;
  artifact: ArtifactReference;
  event: Event;
}

interface PreparedArtifactRegistration {
  actor: Actor;
  branchId: string;
  artifactMetadata: Record<string, unknown>;
}

export interface ProjectInspection {
  manifest: ProjectManifest;
  projection: ProjectProjection;
  branches: BranchProjection[];
  objects: ObjectProjection[];
  edges: EdgeProjection[];
}

export interface VerificationIssue {
  scope: "manifest" | "events" | "artifacts" | "projection";
  code: string;
  message: string;
}

export interface ProjectVerification {
  ok: boolean;
  manifest?: ProjectManifest;
  eventLog: EventLogInspection;
  artifacts: ArtifactStoreVerificationReport;
  projectionMatchesEvents: boolean;
  issues: VerificationIssue[];
}

export interface Rp001Fixture {
  project: CreatedProject;
  problem: ObjectEnvelope;
  context: ObjectEnvelope;
  goal: ObjectEnvelope;
  workstreams: ObjectEnvelope[];
}

function checkedActor(actor: Actor | undefined): Actor {
  return ActorSchema.parse(actor ?? DEFAULT_SYSTEM_ACTOR);
}

function assertExtensionFields(
  extensions: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (extensions === undefined) return {};
  for (const key of Object.keys(extensions)) {
    if (!key.includes(":") && !key.startsWith("x-")) {
      throw new Error(
        `Extension field ${JSON.stringify(key)} must be namespaced (for example x-org:field)`,
      );
    }
  }
  return extensions;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeNewJson(path: string, value: unknown): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(dirname(path));
}

export async function loadManifest(projectRoot: string): Promise<ProjectManifest> {
  const raw = JSON.parse(
    await readFile(join(resolve(projectRoot), MANIFEST_FILE_NAME), "utf8"),
  ) as unknown;
  return ProjectManifestSchema.parse(raw);
}

function projectionHeadMatchesManifest(
  projection: ProjectProjection,
  manifest: ProjectManifest,
): boolean {
  let expectedFirstSequence = 1;
  let expectedEventCount = 0;
  let expectedLastSequence = 0;

  for (const segmentPath of manifest.eventSegments) {
    const match = /\/([0-9]{8,16})-([0-9]{8,16})\.jsonl$/.exec(
      segmentPath,
    );
    if (match === null) return false;
    const firstSequence = Number(match[1]);
    const lastSequence = Number(match[2]);
    if (
      !Number.isSafeInteger(firstSequence) ||
      !Number.isSafeInteger(lastSequence) ||
      firstSequence !== expectedFirstSequence ||
      lastSequence < firstSequence
    ) {
      return false;
    }
    expectedEventCount += lastSequence - firstSequence + 1;
    if (!Number.isSafeInteger(expectedEventCount)) return false;
    expectedLastSequence = lastSequence;
    expectedFirstSequence = lastSequence + 1;
  }

  return (
    projection.lastSequence === expectedLastSequence &&
    projection.eventCount === expectedEventCount
  );
}

async function ensureProjection(
  projectRoot: string,
  suppliedManifest?: ProjectManifest,
): Promise<ProjectProjection> {
  const root = resolve(projectRoot);
  const manifest = suppliedManifest ?? (await loadManifest(root));
  try {
    const projection = getProjectProjection(root);
    if (projectionHeadMatchesManifest(projection, manifest)) return projection;
  } catch {
    // Missing, schema-old, and unreadable projections all take the same replay
    // path as a readable cache whose accepted event head is stale.
  }
  // SQLite is a disposable projection. Opening or mutating a canonical-only
  // export must work without an explicit rebuild command first.
  return rebuildProjection(root);
}

function createProjectEvent(
  manifest: ProjectManifest,
  previousEvents: readonly Event[],
  eventType: KnownEventType,
  actor: Actor,
  payload: Record<string, unknown>,
  branchId?: string,
): Event {
  const previous = previousEvents.at(-1);
  const base: Record<string, unknown> = {
    sequence: (previous?.sequence ?? 0) + 1,
    eventId: createId("evt"),
    eventType,
    occurredAt: utcNow(),
    projectId: manifest.projectId,
    actor,
    schemaVersion: 1,
    payload,
  };
  if (branchId !== undefined) base.branchId = branchId;
  if (previous !== undefined) base.previousEventHash = previous.eventHash;
  return EventSchema.parse(withEventHash(base));
}

async function appendProjectEvent(
  projectRoot: string,
  eventType: KnownEventType,
  payload: Record<string, unknown>,
  actor: Actor,
  branchId?: string,
): Promise<Event> {
  // Event-log locking is authoritative. Retrying handles the benign race in
  // which another writer wins after we read the current tail.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const manifest = await loadManifest(projectRoot);
    const previousEvents = await readAcceptedEvents(projectRoot, manifest);
    const event = createProjectEvent(
      manifest,
      previousEvents,
      eventType,
      actor,
      payload,
      branchId,
    );
    try {
      const appended = await appendEvent(projectRoot, event);
      await rebuildProjection(projectRoot);
      return appended.event;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const sequenceRace = /sequence|previousEventHash|tail/i.test(message);
      if (!sequenceRace || attempt === 2) throw error;
    }
  }
  throw new Error("Unreachable append retry state");
}

export async function createProject(
  projectRoot: string,
  options: CreateProjectOptions,
): Promise<CreatedProject> {
  const root = resolve(projectRoot);
  const manifestPath = join(root, MANIFEST_FILE_NAME);
  await mkdir(root, { recursive: true });
  if (await pathExists(manifestPath)) {
    throw new Error(`Project already exists: ${manifestPath}`);
  }

  const actor = checkedActor(options.actor);
  const createdAt = utcNow();
  const defaultBranchId = createId("br");
  const manifest = ProjectManifestSchema.parse({
    format: PROJECT_FORMAT,
    formatVersion: CURRENT_FORMAT_VERSION,
    projectId: createId("prj"),
    title: options.title,
    createdAt,
    defaultBranchId,
    eventSegments: [],
    hashAlgorithm: HASH_ALGORITHM,
    ...assertExtensionFields(options.extensions),
  });

  for (const directory of CANONICAL_DIRECTORIES) {
    await mkdir(join(root, directory), { recursive: true });
  }
  await mkdir(join(root, ".reasoning", "runtime"), { recursive: true });
  await writeNewJson(manifestPath, manifest);
  await initializeEventLog(root);

  const initialized = createProjectEvent(
    manifest,
    [],
    "ProjectInitialized",
    actor,
    {
      title: manifest.title,
      formatVersion: manifest.formatVersion,
      defaultBranchId,
      createdAt: manifest.createdAt,
    },
  );
  await appendEvent(root, initialized);

  const branchEvent = createProjectEvent(
    await loadManifest(root),
    [initialized],
    "BranchCreated",
    actor,
    {
      branchId: defaultBranchId,
      name: options.defaultBranchName ?? "main",
    },
    defaultBranchId,
  );
  await appendEvent(root, branchEvent);
  const projection = await rebuildProjection(root);
  const defaultBranch = listBranches(root).find(
    (branch) => branch.branchId === defaultBranchId,
  );
  if (defaultBranch === undefined) {
    throw new Error("Default branch was not projected");
  }

  return {
    root,
    manifest: await loadManifest(root),
    defaultBranch,
    projection,
  };
}

export async function createBranch(
  projectRoot: string,
  options: CreateBranchOptions,
): Promise<BranchProjection> {
  const root = resolve(projectRoot);
  const manifest = await loadManifest(root);
  await ensureProjection(root, manifest);
  const branches = listBranches(root);
  const baseBranchId = options.baseBranchId ?? manifest.defaultBranchId;
  if (!branches.some((branch) => branch.branchId === baseBranchId)) {
    throw new Error(`Base branch does not exist: ${baseBranchId}`);
  }
  if (branches.some((branch) => branch.name === options.name)) {
    throw new Error(`Branch name already exists: ${options.name}`);
  }
  const branchId = createId("br");
  await appendProjectEvent(
    root,
    "BranchCreated",
    { branchId, name: options.name, baseBranchId },
    checkedActor(options.actor),
    branchId,
  );
  const branch = listBranches(root).find((candidate) => candidate.branchId === branchId);
  if (branch === undefined) throw new Error(`Branch was not projected: ${branchId}`);
  return branch;
}

function currentObject(
  projectRoot: string,
  branchId: string,
  objectId: string,
): ObjectProjection | undefined {
  return listCurrentObjects(projectRoot, branchId).find(
    (object) => object.objectId === objectId,
  );
}

export async function putObject(
  projectRoot: string,
  options: PutObjectOptions,
): Promise<ObjectEnvelope> {
  const root = resolve(projectRoot);
  await ensureProjection(root);
  if (!branchExists(root, options.branchId)) {
    throw new Error(`Branch does not exist: ${options.branchId}`);
  }
  const actor = checkedActor(options.actor);
  const objectId = options.objectId ?? createObjectId(options.objectType);
  const selected = currentObject(root, options.branchId, objectId);
  if (selected !== undefined && selected.objectType !== options.objectType) {
    throw new Error(
      `Object ${objectId} is ${selected.objectType}, not ${options.objectType}`,
    );
  }
  // Display versions advance within the branch lineage. Two sibling branches
  // may therefore both contain a v2; versionId remains the global identity.
  const version = (selected?.version ?? 0) + 1;
  const envelope = ObjectEnvelopeSchema.parse({
    objectId,
    objectType: options.objectType,
    versionId: createId("ver"),
    version,
    createdAt: utcNow(),
    createdBy: actor,
    branchId: options.branchId,
    content: options.content,
    contentHash: computeContentHash(options.content),
    ...(selected === undefined ? {} : { supersedesVersionId: selected.versionId }),
    ...assertExtensionFields(options.extensions),
  });

  await appendProjectEvent(
    root,
    "ObjectVersionCreated",
    { object: envelope },
    actor,
    options.branchId,
  );
  return envelope;
}

function resolveEndpoint(
  projectRoot: string,
  branchId: string,
  objectId: string,
  versionId: string | undefined,
): { objectId: string; versionId: string } {
  const selected = currentObject(projectRoot, branchId, objectId);
  if (selected === undefined) {
    throw new Error(`Object ${objectId} is not visible on branch ${branchId}`);
  }
  if (versionId !== undefined) {
    const history = new Map(
      getObjectHistory(projectRoot, objectId).map((version) => [
        version.versionId,
        version,
      ]),
    );
    let cursor: string | undefined = selected.versionId;
    const lineage = new Set<string>();
    while (cursor !== undefined && !lineage.has(cursor)) {
      lineage.add(cursor);
      const version = history.get(cursor);
      const supersedes = version?.envelope.supersedesVersionId;
      cursor = typeof supersedes === "string" ? supersedes : undefined;
    }
    if (!lineage.has(versionId)) {
      throw new Error(
        `Version ${versionId} is not visible in the ${branchId} lineage for object ${objectId}`,
      );
    }
  }
  return { objectId, versionId: versionId ?? selected.versionId };
}

export async function addEdge(
  projectRoot: string,
  options: AddEdgeOptions,
): Promise<EdgeEnvelope> {
  const root = resolve(projectRoot);
  await ensureProjection(root);
  if (!branchExists(root, options.branchId)) {
    throw new Error(`Branch does not exist: ${options.branchId}`);
  }
  const actor = checkedActor(options.actor);
  const edge = EdgeEnvelopeSchema.parse({
    edgeId: createId("edg"),
    edgeType: options.edgeType,
    from: resolveEndpoint(
      root,
      options.branchId,
      options.fromObjectId,
      options.fromVersionId,
    ),
    to: resolveEndpoint(
      root,
      options.branchId,
      options.toObjectId,
      options.toVersionId,
    ),
    ...(options.contextId === undefined ? {} : { contextId: options.contextId }),
    createdAt: utcNow(),
    createdBy: actor,
    metadata: options.metadata ?? {},
    ...assertExtensionFields(options.extensions),
  });
  await appendProjectEvent(
    root,
    "EdgeCreated",
    { edge },
    actor,
    options.branchId,
  );
  return edge;
}

async function prepareArtifactRegistration(
  projectRoot: string,
  store: FileSystemArtifactStore,
  options: RegisterArtifactOptions,
): Promise<PreparedArtifactRegistration> {
  const root = resolve(projectRoot);
  await ensureProjection(root);
  if (!branchExists(root, options.branchId)) {
    throw new Error(`Branch does not exist: ${options.branchId}`);
  }
  const actor = checkedActor(options.actor);
  const extensionFields = assertExtensionFields(options.extensions);
  const inputs = (options.inputs ?? []).map((digest) =>
    normalizeSha256Digest(digest),
  );
  const preview = ArtifactReferenceSchema.parse({
    artifactId: createId("art"),
    digest: `sha256:${"0".repeat(64)}`,
    mediaType: options.mediaType,
    size: 0,
    logicalName: options.logicalName,
    producedByRunId: options.producedByRunId,
    environmentId: options.environmentId,
    inputs,
    reproducibility: options.reproducibility ?? "deterministic",
    ...extensionFields,
  });

  // Zod loose objects preserve extension fields, so canonical JSON validation
  // is the additional guarantee that a later event hash cannot fail after the
  // output bytes have already been stored.
  canonicalJson(actor);
  canonicalJson(preview);

  const run = currentObject(root, options.branchId, preview.producedByRunId);
  if (run === undefined || run.objectType !== "run") {
    throw new Error(
      `Producing run ${preview.producedByRunId} is not a visible run object on branch ${options.branchId}`,
    );
  }
  const environment = currentObject(
    root,
    options.branchId,
    preview.environmentId,
  );
  if (environment === undefined || environment.objectType !== "environment") {
    throw new Error(
      `Environment ${preview.environmentId} is not a visible environment object on branch ${options.branchId}`,
    );
  }

  for (const input of preview.inputs) {
    const verification = await store.verify(input);
    if (!verification.valid) {
      throw new Error(
        `Artifact input ${input} is ${verification.failure ?? "invalid"}`,
      );
    }
  }

  const {
    artifactId: _previewArtifactId,
    digest: _previewDigest,
    size: _previewSize,
    ...artifactMetadata
  } = preview;
  return {
    actor,
    branchId: options.branchId,
    artifactMetadata,
  };
}

async function registerReceipt(
  projectRoot: string,
  receipt: StoredArtifact,
  prepared: PreparedArtifactRegistration,
): Promise<RegisteredArtifact> {
  const root = resolve(projectRoot);
  const artifact = ArtifactReferenceSchema.parse({
    artifactId: createId("art"),
    digest: receipt.digest,
    size: receipt.size,
    ...prepared.artifactMetadata,
  });
  const event = await appendProjectEvent(
    root,
    "ArtifactRegistered",
    { artifact },
    prepared.actor,
    prepared.branchId,
  );
  return { receipt, artifact, event };
}

export async function registerArtifactBytes(
  projectRoot: string,
  bytes: Uint8Array,
  options: RegisterArtifactOptions,
): Promise<RegisteredArtifact> {
  const store = new FileSystemArtifactStore(projectRoot);
  const prepared = await prepareArtifactRegistration(projectRoot, store, options);
  return registerReceipt(
    projectRoot,
    await store.putBytes(bytes),
    prepared,
  );
}

export async function registerArtifactFile(
  projectRoot: string,
  sourcePath: string,
  options: RegisterArtifactOptions,
): Promise<RegisteredArtifact> {
  const store = new FileSystemArtifactStore(projectRoot);
  const prepared = await prepareArtifactRegistration(projectRoot, store, options);
  return registerReceipt(
    projectRoot,
    await store.putFile(sourcePath),
    prepared,
  );
}

export async function inspectProject(projectRoot: string): Promise<ProjectInspection> {
  const root = resolve(projectRoot);
  const manifest = await loadManifest(root);
  await ensureProjection(root, manifest);
  return {
    manifest,
    projection: getProjectProjection(root),
    branches: listBranches(root),
    objects: listCurrentObjects(root),
    edges: listEdges(root),
  };
}

export async function projectHistory(projectRoot: string): Promise<Event[]> {
  const manifest = await loadManifest(projectRoot);
  return readAcceptedEvents(projectRoot, manifest);
}

function projectionSignature(projection: ProjectProjection): string {
  return canonicalJson(projection);
}

export async function verifyProject(projectRoot: string): Promise<ProjectVerification> {
  const root = resolve(projectRoot);
  const issues: VerificationIssue[] = [];
  const eventLog = await verifyEventLog(root);
  for (const issue of eventLog.issues) {
    issues.push({ scope: "events", code: issue.code, message: issue.message });
  }

  let manifest: ProjectManifest | undefined;
  try {
    manifest = await loadManifest(root);
  } catch (error) {
    issues.push({
      scope: "manifest",
      code: "invalid-manifest",
      message: error instanceof Error ? error.message : String(error),
    });
  }

  let previousHash: string | undefined;
  const acceptedObjectVersions = new Map<string, string>();
  const acceptedObjectTypes = new Map<string, string>();
  for (const event of eventLog.events) {
    const parsed = EventSchema.safeParse(event);
    if (!parsed.success) {
      issues.push({
        scope: "events",
        code: "event-schema",
        message: `Event ${String((event as { eventId?: unknown }).eventId)}: ${parsed.error.message}`,
      });
      continue;
    }
    if (!verifyEventHash(parsed.data)) {
      issues.push({
        scope: "events",
        code: "event-hash",
        message: `Event ${parsed.data.eventId} has an invalid hash`,
      });
    }
    if (
      previousHash !== undefined &&
      parsed.data.previousEventHash !== previousHash
    ) {
      issues.push({
        scope: "events",
        code: "event-chain",
        message: `Event ${parsed.data.eventId} does not reference the accepted tail`,
      });
    }
    previousHash = parsed.data.eventHash;

    if (parsed.data.eventType === "ObjectVersionCreated") {
      const object = ObjectEnvelopeSchema.safeParse(parsed.data.payload.object);
      if (object.success) {
        acceptedObjectVersions.set(
          object.data.versionId,
          object.data.objectId,
        );
        acceptedObjectTypes.set(object.data.objectId, object.data.objectType);
        if (
          !verifyContentHash(object.data.content, object.data.contentHash)
        ) {
          issues.push({
            scope: "events",
            code: "object-content-hash",
            message: `Object version ${object.data.versionId} has an invalid content hash`,
          });
        }
      }
    }
  }

  for (const event of eventLog.events) {
    if (event.eventType !== "EdgeCreated") continue;
    const edge = EdgeEnvelopeSchema.safeParse(event.payload.edge);
    if (!edge.success) continue;
    for (const [label, endpoint] of [
      ["from", edge.data.from],
      ["to", edge.data.to],
    ] as const) {
      const acceptedObjectId = acceptedObjectVersions.get(endpoint.versionId);
      if (acceptedObjectId === undefined) {
        issues.push({
          scope: "events",
          code: "edge-endpoint-missing",
          message: `Edge ${edge.data.edgeId} ${label} version ${endpoint.versionId} does not exist`,
        });
      } else if (acceptedObjectId !== endpoint.objectId) {
        issues.push({
          scope: "events",
          code: "edge-endpoint-object-mismatch",
          message: `Edge ${edge.data.edgeId} ${label} endpoint does not match version ${endpoint.versionId}`,
        });
      }
    }
  }

  const store = new FileSystemArtifactStore(root);
  const artifacts = await store.verifyAll();
  for (const entry of artifacts.artifacts) {
    if (!entry.valid) {
      issues.push({
        scope: "artifacts",
        code: entry.failure ?? "invalid-artifact",
        message: `Artifact ${entry.digest} failed verification`,
      });
    }
  }
  for (const entry of artifacts.invalidEntries) {
    issues.push({
      scope: "artifacts",
      code: "invalid-cas-entry",
      message: `Invalid CAS entry: ${entry}`,
    });
  }

  for (const event of eventLog.events) {
    if (event.eventType !== "ArtifactRegistered") continue;
    const artifact = ArtifactReferenceSchema.safeParse(event.payload.artifact);
    if (!artifact.success) continue;
    for (const [field, objectId, expectedType] of [
      ["producedByRunId", artifact.data.producedByRunId, "run"],
      ["environmentId", artifact.data.environmentId, "environment"],
    ] as const) {
      if (acceptedObjectTypes.get(objectId) !== expectedType) {
        issues.push({
          scope: "artifacts",
          code: "artifact-provenance-object",
          message: `Artifact ${artifact.data.artifactId} ${field} ${objectId} is not an accepted ${expectedType} object`,
        });
      }
    }
    const verification = await store.verify(artifact.data.digest);
    if (!verification.valid) {
      issues.push({
        scope: "artifacts",
        code: "referenced-artifact-invalid",
        message: `Referenced artifact ${artifact.data.digest} is ${verification.failure ?? "invalid"}`,
      });
    } else if (verification.size !== artifact.data.size) {
      issues.push({
        scope: "artifacts",
        code: "artifact-size-mismatch",
        message: `Referenced artifact ${artifact.data.digest} declares ${artifact.data.size} bytes but contains ${verification.size ?? "an unknown number of"}`,
      });
    }
  }

  let projectionMatchesEvents = false;
  const projectionPresent = await pathExists(
    join(root, PROJECTION_RELATIVE_PATH),
  );
  const verificationRoot = await mkdtemp(join(tmpdir(), "rw-projection-verify-"));
  try {
    const expected = await rebuildProjection(
      verificationRoot,
      eventLog.events as StoredEvent[],
    );
    if (!projectionPresent) {
      // Absence is valid: projections are disposable and canonical exports do
      // not contain local cache state. Successful replay above is the check.
      projectionMatchesEvents = true;
    } else {
      try {
        const actual = getProjectProjection(root);
        projectionMatchesEvents =
          projectionSignature(actual) === projectionSignature(expected);
        if (!projectionMatchesEvents) {
          issues.push({
            scope: "projection",
            code: "projection-diverged",
            message: "SQLite projection does not match a fresh event replay",
          });
        }
      } catch (error) {
        issues.push({
          scope: "projection",
          code: "projection-unreadable",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } catch (error) {
    issues.push({
      scope: "projection",
      code: "projection-rebuild-failed",
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    await rm(verificationRoot, { recursive: true, force: true });
  }

  return {
    ok: eventLog.valid && artifacts.ok && projectionMatchesEvents && issues.length === 0,
    ...(manifest === undefined ? {} : { manifest }),
    eventLog,
    artifacts,
    projectionMatchesEvents,
    issues,
  };
}

async function ensureEmptyDestination(destination: string): Promise<void> {
  if (!(await pathExists(destination))) {
    await mkdir(destination, { recursive: true });
    return;
  }
  const entries = await readdir(destination);
  if (entries.length !== 0) {
    throw new Error(`Export destination is not empty: ${destination}`);
  }
}

export async function exportProject(
  projectRoot: string,
  destinationRoot: string,
): Promise<ProjectInspection> {
  const source = resolve(projectRoot);
  const destination = resolve(destinationRoot);
  const pathFromSource = relative(source, destination);
  if (
    pathFromSource === "" ||
    (!pathFromSource.startsWith(`..${sep}`) && pathFromSource !== ".." && !isAbsolute(pathFromSource))
  ) {
    throw new Error("Export destination must be outside the source project");
  }

  // A schema-old or otherwise unreadable disposable cache must not prevent a
  // canonical export; ensureProjection refreshes it before integrity checks.
  await ensureProjection(source);
  const verified = await verifyProject(source);
  if (!verified.ok) {
    throw new Error(
      `Refusing to export an invalid project: ${verified.issues.map((issue) => issue.message).join("; ")}`,
    );
  }
  await ensureEmptyDestination(destination);
  await cp(join(source, MANIFEST_FILE_NAME), join(destination, MANIFEST_FILE_NAME));
  for (const directory of CANONICAL_DIRECTORIES) {
    const from = join(source, directory);
    const to = join(destination, directory);
    if (await pathExists(from)) await cp(from, to, { recursive: true });
  }
  let inspection: ProjectInspection;
  try {
    await rebuildProjection(destination);
    inspection = await inspectProject(destination);
  } finally {
    // Export only canonical state. The returned inspection proves the copied
    // event history can be replayed; a later open recreates this cache.
    await rm(join(destination, ".reasoning"), {
      recursive: true,
      force: true,
    });
  }
  return inspection;
}

export async function createRp001Fixture(projectRoot: string): Promise<Rp001Fixture> {
  const project = await createProject(projectRoot, {
    title: "RP-001 — Euler Polynomial Investigation",
  });
  const branchId = project.manifest.defaultBranchId;
  const problem = await putObject(project.root, {
    branchId,
    objectType: "problem",
    content: {
      reference: "RP-001",
      brief:
        "Investigate p(n)=n^2+n+41 for non-negative integers using computation, skeptical testing, and proof; preserve counterexamples and failed conjectures.",
      polynomial: "p(n) = n^2 + n + 41",
      domain: "non-negative integers",
    },
  });
  const context = await putObject(project.root, {
    branchId,
    objectType: "context",
    content: {
      domain: "non-negative integers",
      polynomial: "p(n) = n^2 + n + 41",
      primeDefinition:
        "integer greater than 1 with exactly two positive divisors",
    },
  });
  const goal = await putObject(project.root, {
    branchId,
    objectType: "goal",
    content: {
      statement:
        "Determine the strongest justified statements about primality and compositeness of p(n).",
      completionRequires: [
        "complete enumeration through n=200",
        "first composite value",
        "quantified infinite composite family",
        "skeptical review",
        "preserved failed universal conjecture",
      ],
    },
  });

  const workstreamSpecs = [
    {
      reference: "WS-001-A",
      name: "Enumeration",
      objective:
        "Evaluate and factor p(n) for 0 <= n <= 200; save code, environment, table, and first composite.",
    },
    {
      reference: "WS-001-B",
      name: "Pattern and proof",
      objective:
        "Explain the first composite and derive a precisely quantified infinite composite family.",
    },
    {
      reference: "WS-001-C",
      name: "Skeptical review",
      objective:
        "Attempt refutations, independently verify algebra, and preserve rejected conjectures.",
    },
    {
      reference: "WS-001-D",
      name: "Synthesis",
      objective:
        "Link claims to code, datasets, proofs, failures, and reviews in a working-paper section.",
    },
  ] as const;
  const workstreams: ObjectEnvelope[] = [];
  for (const spec of workstreamSpecs) {
    const workstream = await putObject(project.root, {
      branchId,
      objectType: "workstream",
      content: spec,
    });
    workstreams.push(workstream);
    await addEdge(project.root, {
      branchId,
      edgeType: "depends_on",
      fromObjectId: workstream.objectId,
      toObjectId: goal.objectId,
      contextId: context.objectId,
      metadata: { relation: "workstream contributes to goal" },
    });
  }
  await addEdge(project.root, {
    branchId,
    edgeType: "depends_on",
    fromObjectId: goal.objectId,
    toObjectId: problem.objectId,
    contextId: context.objectId,
  });
  await addEdge(project.root, {
    branchId,
    edgeType: "uses_definition",
    fromObjectId: goal.objectId,
    toObjectId: context.objectId,
    contextId: context.objectId,
  });

  return { project, problem, context, goal, workstreams };
}

export function absoluteProjectPath(path: string): string {
  return resolve(path);
}

export function newTemporaryExportName(): string {
  return `reasoning-project-export-${randomUUID()}`;
}
