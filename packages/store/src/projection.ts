import { randomUUID } from "node:crypto";
import { mkdir, rename, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { canonicalJson } from "@reasoning-workbench/project-format";

import { readAcceptedEvents } from "./event-log.js";

export const PROJECTION_RELATIVE_PATH = ".reasoning/state.sqlite";
export const PROJECTION_SCHEMA_VERSION = 3;

const require = createRequire(import.meta.url);
let sqliteModule: typeof import("node:sqlite") | undefined;

function loadSqliteModule(): typeof import("node:sqlite") {
  if (sqliteModule !== undefined) {
    return sqliteModule;
  }
  // Suppress Node.js 22 ExperimentalWarning: SQLite is an experimental feature
  // so CLI commands and test suites run cleanly without stderr clutter.
  const originalEmitWarning = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...args: unknown[]) => {
    const message = typeof warning === "string" ? warning : warning?.message;
    if (typeof message === "string" && message.includes("SQLite is an experimental feature")) {
      return;
    }
    return (originalEmitWarning as (...a: unknown[]) => void).apply(process, [warning, ...args]);
  }) as typeof process.emitWarning;

  try {
    sqliteModule = require("node:sqlite") as typeof import("node:sqlite");
  } finally {
    process.emitWarning = originalEmitWarning;
  }
  return sqliteModule;
}

function openDatabase(
  path: string,
  options?: { readOnly?: boolean },
): DatabaseSync {
  const mod = loadSqliteModule();
  return options === undefined
    ? new mod.DatabaseSync(path)
    : new mod.DatabaseSync(path, options);
}

export interface StoredEvent {
  sequence: number;
  eventId: string;
  eventType: string;
  occurredAt: string;
  projectId: string;
  branchId?: string;
  actor: unknown;
  schemaVersion: number;
  payload: Record<string, unknown>;
  eventHash: string;
  [key: string]: unknown;
}

export interface ProjectProjection {
  projectionSchemaVersion: number;
  projectId: string;
  title: string;
  createdAt: string;
  defaultBranchId: string;
  formatVersion: string;
  lastSequence: number;
  eventCount: number;
  branchCount: number;
  objectCount: number;
  edgeCount: number;
  artifactCount: number;
}

export interface BranchProjection {
  branchId: string;
  name: string;
  parentBranchId?: string;
  createdAt: string;
  createdBy: unknown;
  baseSequence: number;
  headSequence: number;
}

export interface ObjectProjection {
  branchId: string;
  objectId: string;
  objectType: string;
  versionId: string;
  version: number;
  createdAt: string;
  contentHash: string;
  content: unknown;
  envelope: Record<string, unknown>;
}

export interface EdgeProjection {
  edgeId: string;
  branchId: string;
  edgeType: string;
  fromObjectId: string;
  fromVersionId?: string;
  toObjectId: string;
  toVersionId?: string;
  envelope: Record<string, unknown>;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(
  value: Record<string, unknown>,
  key: string,
  label: string,
): string {
  const field = value[key];
  if (typeof field !== "string" || field.length === 0) {
    throw new Error(`${label}.${key} must be a non-empty string`);
  }
  return field;
}

function requiredInteger(
  value: Record<string, unknown>,
  key: string,
  label: string,
): number {
  const field = value[key];
  if (!Number.isSafeInteger(field)) {
    throw new Error(`${label}.${key} must be a safe integer`);
  }
  return field as number;
}

function optionalString(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === "string" && field.length > 0 ? field : undefined;
}

function requiredStringArray(
  value: Record<string, unknown>,
  key: string,
  label: string,
): string[] {
  const field = value[key];
  if (!Array.isArray(field) || field.some((item) => typeof item !== "string")) {
    throw new Error(`${label}.${key} must be an array of strings`);
  }
  return field as string[];
}

function createSchema(db: DatabaseSync): void {
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = DELETE;
    PRAGMA synchronous = FULL;

    CREATE TABLE metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT;

    CREATE TABLE events (
      sequence INTEGER PRIMARY KEY,
      event_id TEXT NOT NULL UNIQUE,
      event_type TEXT NOT NULL,
      branch_id TEXT,
      occurred_at TEXT NOT NULL,
      event_hash TEXT NOT NULL,
      body_json TEXT NOT NULL
    ) STRICT;

    CREATE TABLE branches (
      branch_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      parent_branch_id TEXT,
      created_at TEXT NOT NULL,
      created_by_json TEXT NOT NULL,
      base_sequence INTEGER NOT NULL,
      head_sequence INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE object_versions (
      version_id TEXT PRIMARY KEY,
      object_id TEXT NOT NULL,
      object_type TEXT NOT NULL,
      version INTEGER NOT NULL,
      origin_branch_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      content_json TEXT NOT NULL,
      envelope_json TEXT NOT NULL,
      UNIQUE(origin_branch_id, object_id, version)
    ) STRICT;

    CREATE TABLE current_objects (
      branch_id TEXT NOT NULL,
      object_id TEXT NOT NULL,
      version_id TEXT NOT NULL REFERENCES object_versions(version_id),
      selected_at_sequence INTEGER NOT NULL,
      PRIMARY KEY(branch_id, object_id)
    ) STRICT;

    CREATE TABLE edges (
      edge_id TEXT PRIMARY KEY,
      origin_branch_id TEXT NOT NULL,
      edge_type TEXT NOT NULL,
      from_object_id TEXT NOT NULL,
      from_version_id TEXT,
      to_object_id TEXT NOT NULL,
      to_version_id TEXT,
      envelope_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE visible_edges (
      branch_id TEXT NOT NULL,
      edge_id TEXT NOT NULL REFERENCES edges(edge_id),
      selected_at_sequence INTEGER NOT NULL,
      PRIMARY KEY(branch_id, edge_id)
    ) STRICT;

    CREATE TABLE artifacts (
      artifact_id TEXT PRIMARY KEY,
      branch_id TEXT NOT NULL,
      digest TEXT NOT NULL,
      media_type TEXT NOT NULL,
      size INTEGER NOT NULL,
      envelope_json TEXT NOT NULL,
      registered_at_sequence INTEGER NOT NULL
    ) STRICT;

    CREATE INDEX object_versions_object_idx
      ON object_versions(object_id, version);
    CREATE INDEX object_versions_branch_type_idx
      ON object_versions(origin_branch_id, object_type);
    CREATE INDEX current_objects_branch_idx
      ON current_objects(branch_id, object_id);
    CREATE INDEX edges_origin_branch_idx
      ON edges(origin_branch_id, edge_type);
    CREATE INDEX edges_from_object_idx
      ON edges(from_object_id, edge_type);
    CREATE INDEX edges_to_object_idx
      ON edges(to_object_id, edge_type);
    CREATE INDEX visible_edges_branch_idx
      ON visible_edges(branch_id, edge_id);
    CREATE INDEX events_branch_seq_idx
      ON events(branch_id, sequence);
    CREATE INDEX artifacts_digest_idx
      ON artifacts(digest);
  `);
}

function setMetadata(db: DatabaseSync, key: string, value: string): void {
  db.prepare(
    "INSERT INTO metadata(key, value) VALUES (?, ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

function insertEvent(db: DatabaseSync, event: StoredEvent): void {
  db.prepare(
    `INSERT INTO events(
      sequence, event_id, event_type, branch_id, occurred_at, event_hash, body_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    event.sequence,
    event.eventId,
    event.eventType,
    event.branchId ?? null,
    event.occurredAt,
    event.eventHash,
    JSON.stringify(event),
  );
}

function applyProjectInitialized(db: DatabaseSync, event: StoredEvent): void {
  const payload = event.payload;
  setMetadata(db, "projectId", event.projectId);
  setMetadata(
    db,
    "title",
    requiredString(payload, "title", "ProjectInitialized.payload"),
  );
  setMetadata(
    db,
    "createdAt",
    optionalString(payload, "createdAt") ?? event.occurredAt,
  );
  setMetadata(
    db,
    "defaultBranchId",
    requiredString(payload, "defaultBranchId", "ProjectInitialized.payload"),
  );
  setMetadata(
    db,
    "formatVersion",
    requiredString(payload, "formatVersion", "ProjectInitialized.payload"),
  );
}

function applyBranchCreated(db: DatabaseSync, event: StoredEvent): void {
  const payload = event.payload;
  const branchId = requiredString(payload, "branchId", "BranchCreated.payload");
  const parentBranchId = optionalString(payload, "baseBranchId");
  let baseSequence = event.sequence;

  if (parentBranchId !== undefined) {
    const parent = db
      .prepare("SELECT head_sequence FROM branches WHERE branch_id = ?")
      .get(parentBranchId) as { head_sequence: number } | undefined;
    if (parent === undefined) {
      throw new Error(`Parent branch does not exist: ${parentBranchId}`);
    }
    // current_objects is copied from exactly this observed parent head. Later
    // parent events advance its pointer without changing the child snapshot.
    baseSequence = Number(parent.head_sequence);
  }

  db.prepare(
    `INSERT INTO branches(
      branch_id, name, parent_branch_id, created_at, created_by_json,
      base_sequence, head_sequence
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    branchId,
    requiredString(payload, "name", "BranchCreated.payload"),
    parentBranchId ?? null,
    event.occurredAt,
    JSON.stringify(event.actor),
    baseSequence,
    event.sequence,
  );

  if (parentBranchId !== undefined) {
    db.prepare(
      `INSERT INTO current_objects(
        branch_id, object_id, version_id, selected_at_sequence
      ) SELECT ?, object_id, version_id, ?
        FROM current_objects WHERE branch_id = ?`,
    ).run(branchId, event.sequence, parentBranchId);
    db.prepare(
      `INSERT INTO visible_edges(branch_id, edge_id, selected_at_sequence)
       SELECT ?, edge_id, ? FROM visible_edges WHERE branch_id = ?`,
    ).run(branchId, event.sequence, parentBranchId);
  }
}

function applyObjectVersionCreated(db: DatabaseSync, event: StoredEvent): void {
  const object = asRecord(
    event.payload.object,
    "ObjectVersionCreated.payload.object",
  );
  const branchId = requiredString(object, "branchId", "object");
  const objectId = requiredString(object, "objectId", "object");
  const versionId = requiredString(object, "versionId", "object");
  const objectType = requiredString(object, "objectType", "object");
  const version = requiredInteger(object, "version", "object");
  const supersedesVersionId = optionalString(object, "supersedesVersionId");
  const knownType = db
    .prepare(
      `SELECT object_type FROM object_versions
       WHERE object_id = ? LIMIT 1`,
    )
    .get(objectId) as { object_type: string } | undefined;
  if (knownType !== undefined && knownType.object_type !== objectType) {
    throw new Error(
      `Object ${objectId} cannot change type from ${knownType.object_type} to ${objectType}`,
    );
  }
  const selected = db
    .prepare(
      `SELECT v.version_id, v.version, v.object_type
       FROM current_objects c
       JOIN object_versions v ON v.version_id = c.version_id
       WHERE c.branch_id = ? AND c.object_id = ?`,
    )
    .get(branchId, objectId) as
    | { version_id: string; version: number; object_type: string }
    | undefined;
  if (selected === undefined) {
    if (version !== 1 || supersedesVersionId !== undefined) {
      throw new Error(
        `First visible version of object ${objectId} on branch ${branchId} must be v1 without supersedesVersionId`,
      );
    }
  } else if (
    version !== Number(selected.version) + 1 ||
    supersedesVersionId !== selected.version_id ||
    objectType !== selected.object_type
  ) {
    throw new Error(
      `Object ${objectId} update on branch ${branchId} must be v${Number(selected.version) + 1} superseding ${selected.version_id}`,
    );
  }

  db.prepare(
    `INSERT INTO object_versions(
      version_id, object_id, object_type, version, origin_branch_id,
      created_at, content_hash, content_json, envelope_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    versionId,
    objectId,
    objectType,
    version,
    branchId,
    requiredString(object, "createdAt", "object"),
    requiredString(object, "contentHash", "object"),
    JSON.stringify(object.content ?? {}),
    JSON.stringify(object),
  );

  db.prepare(
    `INSERT INTO current_objects(
      branch_id, object_id, version_id, selected_at_sequence
    ) VALUES (?, ?, ?, ?)
    ON CONFLICT(branch_id, object_id) DO UPDATE SET
      version_id = excluded.version_id,
      selected_at_sequence = excluded.selected_at_sequence`,
  ).run(branchId, objectId, versionId, event.sequence);
}

function endpoint(
  edge: Record<string, unknown>,
  key: "from" | "to",
): Record<string, unknown> {
  return asRecord(edge[key], `edge.${key}`);
}

function assertEndpointVisible(
  db: DatabaseSync,
  branchId: string,
  value: Record<string, unknown>,
  label: string,
): void {
  const objectId = requiredString(value, "objectId", label);
  const targetVersionId = requiredString(value, "versionId", label);
  const selected = db
    .prepare(
      `SELECT v.version_id
       FROM current_objects c
       JOIN object_versions v ON v.version_id = c.version_id
       WHERE c.branch_id = ? AND c.object_id = ?`,
    )
    .get(branchId, objectId) as { version_id: string } | undefined;
  if (selected === undefined) {
    throw new Error(`${label} object ${objectId} is not visible on branch ${branchId}`);
  }

  let cursor: string | undefined = selected.version_id;
  const visited = new Set<string>();
  while (cursor !== undefined && !visited.has(cursor)) {
    if (cursor === targetVersionId) return;
    visited.add(cursor);
    const row = db
      .prepare(
        `SELECT object_id, envelope_json
         FROM object_versions WHERE version_id = ?`,
      )
      .get(cursor) as { object_id: string; envelope_json: string } | undefined;
    if (row === undefined || row.object_id !== objectId) break;
    const envelope = JSON.parse(row.envelope_json) as Record<string, unknown>;
    cursor = optionalString(envelope, "supersedesVersionId");
  }
  throw new Error(
    `${label} version ${targetVersionId} is not visible in the ${branchId} lineage`,
  );
}

function applyEdgeCreated(db: DatabaseSync, event: StoredEvent): void {
  const edge = asRecord(event.payload.edge, "EdgeCreated.payload.edge");
  const from = endpoint(edge, "from");
  const to = endpoint(edge, "to");
  const branchId =
    optionalString(edge, "branchId") ??
    event.branchId ??
    (() => {
      throw new Error("EdgeCreated must identify a branch");
    })();

  assertEndpointVisible(db, branchId, from, "edge.from");
  assertEndpointVisible(db, branchId, to, "edge.to");
  const contextId = optionalString(edge, "contextId");
  if (contextId !== undefined) {
    const context = db
      .prepare(
        `SELECT v.object_type
         FROM current_objects c
         JOIN object_versions v ON v.version_id = c.version_id
         WHERE c.branch_id = ? AND c.object_id = ?`,
      )
      .get(branchId, contextId) as { object_type: string } | undefined;
    if (context?.object_type !== "context") {
      throw new Error(
        `Edge context ${contextId} is not a visible context object on branch ${branchId}`,
      );
    }
  }

  db.prepare(
    `INSERT INTO edges(
      edge_id, origin_branch_id, edge_type, from_object_id, from_version_id,
      to_object_id, to_version_id, envelope_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    requiredString(edge, "edgeId", "edge"),
    branchId,
    requiredString(edge, "edgeType", "edge"),
    requiredString(from, "objectId", "edge.from"),
    optionalString(from, "versionId") ?? null,
    requiredString(to, "objectId", "edge.to"),
    optionalString(to, "versionId") ?? null,
    JSON.stringify(edge),
    requiredString(edge, "createdAt", "edge"),
  );
  db.prepare(
    `INSERT INTO visible_edges(branch_id, edge_id, selected_at_sequence)
     VALUES (?, ?, ?)`,
  ).run(branchId, requiredString(edge, "edgeId", "edge"), event.sequence);
}

function applyArtifactRegistered(db: DatabaseSync, event: StoredEvent): void {
  const artifact = asRecord(
    event.payload.artifact,
    "ArtifactRegistered.payload.artifact",
  );
  const branchId =
    event.branchId ??
    (() => {
      throw new Error("ArtifactRegistered must identify a branch");
    })();
  for (const [field, expectedType] of [
    ["producedByRunId", "run"],
    ["environmentId", "environment"],
  ] as const) {
    const objectId = requiredString(artifact, field, "artifact");
    const visible = db
      .prepare(
        `SELECT v.object_type
         FROM current_objects c
         JOIN object_versions v ON v.version_id = c.version_id
         WHERE c.branch_id = ? AND c.object_id = ?`,
      )
      .get(branchId, objectId) as { object_type: string } | undefined;
    if (visible?.object_type !== expectedType) {
      throw new Error(
        `Artifact ${field} ${objectId} is not a visible ${expectedType} object on branch ${branchId}`,
      );
    }
  }
  db.prepare(
    `INSERT INTO artifacts(
      artifact_id, branch_id, digest, media_type, size, envelope_json,
      registered_at_sequence
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    requiredString(artifact, "artifactId", "artifact"),
    branchId,
    requiredString(artifact, "digest", "artifact"),
    requiredString(artifact, "mediaType", "artifact"),
    requiredInteger(artifact, "size", "artifact"),
    JSON.stringify(artifact),
    event.sequence,
  );
}

function applyBranchMerged(db: DatabaseSync, event: StoredEvent): void {
  const payload = event.payload;
  const mergeId = requiredString(payload, "mergeId", "BranchMerged.payload");
  const sourceBranchId = requiredString(
    payload,
    "sourceBranchId",
    "BranchMerged.payload",
  );
  const targetBranchId = requiredString(
    payload,
    "targetBranchId",
    "BranchMerged.payload",
  );
  if (event.branchId !== targetBranchId || sourceBranchId === targetBranchId) {
    throw new Error("BranchMerged must target a distinct event branch");
  }
  const source = db
    .prepare(
      `SELECT parent_branch_id, base_sequence FROM branches WHERE branch_id = ?`,
    )
    .get(sourceBranchId) as
    | { parent_branch_id: string | null; base_sequence: number }
    | undefined;
  if (
    source === undefined ||
    source.parent_branch_id !== targetBranchId ||
    Number(source.base_sequence) !==
      requiredInteger(payload, "baseSequence", "BranchMerged.payload")
  ) {
    throw new Error(
      `Stage 2 safe merge requires ${sourceBranchId} to be a direct child snapshot of ${targetBranchId}`,
    );
  }

  const status = requiredString(payload, "status", "BranchMerged.payload");
  const appliedVersionIds = requiredStringArray(
    payload,
    "appliedObjectVersionIds",
    "BranchMerged.payload",
  );
  const adoptedEdgeIds = requiredStringArray(
    payload,
    "adoptedEdgeIds",
    "BranchMerged.payload",
  );
  const conflictObjectIds = requiredStringArray(
    payload,
    "conflictObjectIds",
    "BranchMerged.payload",
  );
  if (
    (status === "merged" && conflictObjectIds.length !== 0) ||
    (status === "conflicted" &&
      (conflictObjectIds.length === 0 ||
        appliedVersionIds.length !== 0 ||
        adoptedEdgeIds.length !== 0))
  ) {
    throw new Error("BranchMerged status is inconsistent with its outcomes");
  }

  for (const versionId of appliedVersionIds) {
    const applied = db
      .prepare(
        `SELECT 1 FROM current_objects
         WHERE branch_id = ? AND version_id = ?`,
      )
      .get(targetBranchId, versionId);
    if (applied === undefined) {
      throw new Error(
        `Merged version ${versionId} is not current on target branch ${targetBranchId}`,
      );
    }
  }
  for (const objectId of conflictObjectIds) {
    const conflict = db
      .prepare(
        `SELECT v.object_type FROM current_objects c
         JOIN object_versions v ON v.version_id = c.version_id
         WHERE c.branch_id = ? AND c.object_id = ?`,
      )
      .get(targetBranchId, objectId) as { object_type: string } | undefined;
    if (conflict?.object_type !== "failure") {
      throw new Error(
        `Merge conflict ${objectId} is not a visible failure object on ${targetBranchId}`,
      );
    }
  }

  for (const edgeId of adoptedEdgeIds) {
    const targetEdge = db
      .prepare(
        `SELECT e.envelope_json FROM visible_edges v
         JOIN edges e ON e.edge_id = v.edge_id
         WHERE v.branch_id = ? AND v.edge_id = ?`,
      )
      .get(targetBranchId, edgeId) as { envelope_json: string } | undefined;
    if (targetEdge === undefined) {
      throw new Error(`Merged edge copy ${edgeId} is not visible on ${targetBranchId}`);
    }
    const edge = JSON.parse(targetEdge.envelope_json) as Record<string, unknown>;
    const provenance = asRecord(edge["x-rw:merge"], "edge.x-rw:merge");
    if (
      requiredString(provenance, "mergeId", "edge.x-rw:merge") !== mergeId ||
      requiredString(provenance, "sourceBranchId", "edge.x-rw:merge") !==
        sourceBranchId
    ) {
      throw new Error(`Merged edge copy ${edgeId} has inconsistent provenance`);
    }
    const sourceEdgeId = requiredString(
      provenance,
      "sourceEdgeId",
      "edge.x-rw:merge",
    );
    const sourceEdge = db
      .prepare(
        `SELECT e.edge_type, e.from_object_id, e.to_object_id, e.envelope_json
         FROM visible_edges v JOIN edges e ON e.edge_id = v.edge_id
         WHERE v.branch_id = ? AND v.edge_id = ?`,
      )
      .get(sourceBranchId, sourceEdgeId) as
      | {
          edge_type: string;
          from_object_id: string;
          to_object_id: string;
          envelope_json: string;
        }
      | undefined;
    const sourceEnvelope =
      sourceEdge === undefined
        ? undefined
        : (JSON.parse(sourceEdge.envelope_json) as Record<string, unknown>);
    if (
      sourceEdge === undefined ||
      sourceEnvelope === undefined ||
      sourceEdge.edge_type !== requiredString(edge, "edgeType", "edge") ||
      sourceEdge.from_object_id !==
        requiredString(endpoint(edge, "from"), "objectId", "edge.from") ||
      sourceEdge.to_object_id !==
        requiredString(endpoint(edge, "to"), "objectId", "edge.to") ||
      optionalString(sourceEnvelope, "contextId") !==
        optionalString(edge, "contextId") ||
      canonicalJson(sourceEnvelope.metadata ?? {}) !== canonicalJson(edge.metadata ?? {})
    ) {
      throw new Error(`Merged edge copy ${edgeId} does not match its source edge`);
    }
  }
}

export function applyEvent(db: DatabaseSync, event: StoredEvent): void {
  insertEvent(db, event);
  switch (event.eventType) {
    case "ProjectInitialized":
      applyProjectInitialized(db, event);
      break;
    case "BranchCreated":
      applyBranchCreated(db, event);
      break;
    case "ObjectVersionCreated":
      applyObjectVersionCreated(db, event);
      break;
    case "EdgeCreated":
      applyEdgeCreated(db, event);
      break;
    case "ArtifactRegistered":
      applyArtifactRegistered(db, event);
      break;
    case "BranchMerged":
      applyBranchMerged(db, event);
      break;
    case "MigrationApplied":
      break;
    default:
      // Unknown event types remain queryable and round-trippable. A projection
      // deliberately ignores semantics it does not understand.
      break;
  }

  if (event.branchId !== undefined) {
    db.prepare(
      `UPDATE branches
       SET head_sequence = MAX(head_sequence, ?)
       WHERE branch_id = ?`,
    ).run(event.sequence, event.branchId);
  }
  setMetadata(db, "lastSequence", String(event.sequence));
}

export async function rebuildProjection(
  projectRoot: string,
  providedEvents?: readonly StoredEvent[],
): Promise<ProjectProjection> {
  const target = join(projectRoot, PROJECTION_RELATIVE_PATH);
  await mkdir(dirname(target), { recursive: true });
  const temporary = join(dirname(target), `.state-${randomUUID()}.sqlite.tmp`);
  const events =
    providedEvents ?? ((await readAcceptedEvents(projectRoot)) as StoredEvent[]);
  const db = openDatabase(temporary);

  try {
    createSchema(db);
    db.exec("BEGIN IMMEDIATE");
    try {
      setMetadata(
        db,
        "projectionSchemaVersion",
        String(PROJECTION_SCHEMA_VERSION),
      );
      let expectedSequence = 1;
      for (const event of events) {
        if (event.sequence !== expectedSequence) {
          throw new Error(
            `Event sequence gap: expected ${expectedSequence}, got ${event.sequence}`,
          );
        }
        applyEvent(db, event);
        expectedSequence += 1;
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    db.close();
    await rename(temporary, target);
  } catch (error) {
    try {
      db.close();
    } catch {
      // The database may already be closed after a successful transaction.
    }
    await rm(temporary, { force: true });
    throw error;
  }

  return getProjectProjection(projectRoot);
}

function withDatabase<T>(projectRoot: string, callback: (db: DatabaseSync) => T): T {
  const db = openDatabase(join(projectRoot, PROJECTION_RELATIVE_PATH), {
    readOnly: true,
  });
  try {
    return callback(db);
  } finally {
    db.close();
  }
}

function metadata(db: DatabaseSync, key: string): string {
  const row = db.prepare("SELECT value FROM metadata WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  if (row === undefined) {
    throw new Error(`Projection metadata missing: ${key}`);
  }
  return row.value;
}

function count(db: DatabaseSync, table: string): number {
  const allowed = new Set([
    "events",
    "branches",
    "current_objects",
    "edges",
    "artifacts",
  ]);
  if (!allowed.has(table)) {
    throw new Error(`Unsupported projection table: ${table}`);
  }
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
    count: number;
  };
  return Number(row.count);
}

export function getProjectProjection(projectRoot: string): ProjectProjection {
  return withDatabase(projectRoot, (db) => {
    const projectionSchemaVersion = Number(
      metadata(db, "projectionSchemaVersion"),
    );
    if (projectionSchemaVersion !== PROJECTION_SCHEMA_VERSION) {
      throw new Error(
        `Projection schema ${projectionSchemaVersion} is unsupported; expected ${PROJECTION_SCHEMA_VERSION}`,
      );
    }
    return {
      projectionSchemaVersion,
      projectId: metadata(db, "projectId"),
      title: metadata(db, "title"),
      createdAt: metadata(db, "createdAt"),
      defaultBranchId: metadata(db, "defaultBranchId"),
      formatVersion: metadata(db, "formatVersion"),
      lastSequence: Number(metadata(db, "lastSequence")),
      eventCount: count(db, "events"),
      branchCount: count(db, "branches"),
      objectCount: count(db, "current_objects"),
      edgeCount: count(db, "edges"),
      artifactCount: count(db, "artifacts"),
    };
  });
}

export function listBranches(projectRoot: string): BranchProjection[] {
  return withDatabase(projectRoot, (db) => {
    const rows = db
      .prepare(
        `SELECT branch_id, name, parent_branch_id, created_at,
                created_by_json, base_sequence, head_sequence
         FROM branches ORDER BY base_sequence, branch_id`,
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      branchId: String(row.branch_id),
      name: String(row.name),
      ...(row.parent_branch_id === null
        ? {}
        : { parentBranchId: String(row.parent_branch_id) }),
      createdAt: String(row.created_at),
      createdBy: JSON.parse(String(row.created_by_json)) as unknown,
      baseSequence: Number(row.base_sequence),
      headSequence: Number(row.head_sequence),
    }));
  });
}

export function listCurrentObjects(
  projectRoot: string,
  branchId?: string,
): ObjectProjection[] {
  return withDatabase(projectRoot, (db) => {
    const base = `SELECT c.branch_id, v.object_id, v.object_type, v.version_id,
                         v.version, v.created_at, v.content_hash,
                         v.content_json, v.envelope_json
                  FROM current_objects c
                  JOIN object_versions v ON v.version_id = c.version_id`;
    const rows = (
      branchId === undefined
        ? db.prepare(`${base} ORDER BY c.branch_id, v.object_id`).all()
        : db
            .prepare(`${base} WHERE c.branch_id = ? ORDER BY v.object_id`)
            .all(branchId)
    ) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      branchId: String(row.branch_id),
      objectId: String(row.object_id),
      objectType: String(row.object_type),
      versionId: String(row.version_id),
      version: Number(row.version),
      createdAt: String(row.created_at),
      contentHash: String(row.content_hash),
      content: JSON.parse(String(row.content_json)) as unknown,
      envelope: JSON.parse(String(row.envelope_json)) as Record<string, unknown>,
    }));
  });
}

export function getObjectHistory(
  projectRoot: string,
  objectId: string,
): ObjectProjection[] {
  return withDatabase(projectRoot, (db) => {
    const rows = db
      .prepare(
        `SELECT origin_branch_id AS branch_id, object_id, object_type,
                version_id, version, created_at, content_hash,
                content_json, envelope_json
         FROM object_versions
         WHERE object_id = ?
         ORDER BY version, version_id`,
      )
      .all(objectId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      branchId: String(row.branch_id),
      objectId: String(row.object_id),
      objectType: String(row.object_type),
      versionId: String(row.version_id),
      version: Number(row.version),
      createdAt: String(row.created_at),
      contentHash: String(row.content_hash),
      content: JSON.parse(String(row.content_json)) as unknown,
      envelope: JSON.parse(String(row.envelope_json)) as Record<string, unknown>,
    }));
  });
}

export function listEdges(
  projectRoot: string,
  branchId?: string,
): EdgeProjection[] {
  return withDatabase(projectRoot, (db) => {
    const base = `SELECT e.edge_id, v.branch_id, e.edge_type,
                         e.from_object_id, e.from_version_id,
                         e.to_object_id, e.to_version_id, e.envelope_json
                  FROM visible_edges v
                  JOIN edges e ON e.edge_id = v.edge_id`;
    const rows = (
      branchId === undefined
        ? db.prepare(`${base} ORDER BY v.branch_id, e.edge_id`).all()
        : db
            .prepare(`${base} WHERE v.branch_id = ? ORDER BY e.edge_id`)
            .all(branchId)
    ) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      edgeId: String(row.edge_id),
      branchId: String(row.branch_id),
      edgeType: String(row.edge_type),
      fromObjectId: String(row.from_object_id),
      ...(row.from_version_id === null
        ? {}
        : { fromVersionId: String(row.from_version_id) }),
      toObjectId: String(row.to_object_id),
      ...(row.to_version_id === null
        ? {}
        : { toVersionId: String(row.to_version_id) }),
      envelope: JSON.parse(String(row.envelope_json)) as Record<string, unknown>,
    }));
  });
}

export function nextObjectVersion(
  projectRoot: string,
  branchId: string,
  objectId: string,
): number {
  return withDatabase(projectRoot, (db) => {
    const row = db
      .prepare(
        `SELECT COALESCE(v.version, 0) + 1 AS version
         FROM (SELECT 1) seed
         LEFT JOIN current_objects c
           ON c.branch_id = ? AND c.object_id = ?
         LEFT JOIN object_versions v ON v.version_id = c.version_id`,
      )
      .get(branchId, objectId) as { version: number };
    return Number(row.version);
  });
}

export function branchExists(projectRoot: string, branchId: string): boolean {
  return withDatabase(
    projectRoot,
    (db) =>
      db.prepare("SELECT 1 FROM branches WHERE branch_id = ?").get(branchId) !==
      undefined,
  );
}
