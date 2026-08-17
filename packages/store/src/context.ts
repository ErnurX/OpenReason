import {
  OBJECT_TYPES,
  canonicalJson,
  sha256Digest,
  type ObjectType,
  type Sha256Digest,
} from "@reasoning-workbench/project-format";

import {
  listCurrentObjects,
  listEdges,
  type ObjectProjection,
} from "./projection.js";

export const CONTEXT_BUNDLE_SCHEMA_VERSION = 1 as const;

export interface CompileContextOptions {
  branchId: string;
  goalId: string;
  maxCharacters: number;
  maxEntries: number;
  query?: string;
  includeObjectTypes?: readonly ObjectType[];
}

export type ContextSelectionReason =
  | "goal"
  | "negative-context"
  | "graph"
  | "lexical";

export interface ContextPromptSpan {
  /** Inclusive UTF-16 character offset in ContextBundle.promptText. */
  start: number;
  /** Exclusive UTF-16 character offset in ContextBundle.promptText. */
  end: number;
}

export interface ContextEntry {
  objectId: string;
  versionId: string;
  objectType: string;
  contentHash: string;
  selectionReason: ContextSelectionReason;
  depth?: number;
  truncated: boolean;
  /** Exact text contributed by this entry, including its stable back-reference. */
  text: string;
  promptSpan: ContextPromptSpan;
}

export interface ContextBundle {
  schemaVersion: typeof CONTEXT_BUNDLE_SCHEMA_VERSION;
  branchId: string;
  goalId: string;
  query?: string;
  maxCharacters: number;
  maxEntries: number;
  promptText: string;
  usedCharacters: number;
  estimatedTokens: number;
  entries: ContextEntry[];
  omittedEntryCount: number;
  omittedObjectIds: string[];
  digest: Sha256Digest;
}

interface RankedCandidate {
  object: ObjectProjection;
  selectionReason: ContextSelectionReason;
  depth?: number;
  lexicalScore: number;
  redactedContent: unknown;
}

const SECRET_KEY_PARTS = [
  "secret",
  "token",
  "password",
  "passwd",
  "apikey",
  "authorization",
  "credential",
  "privatekey",
  "accesskey",
  "clientsecret",
  "cookie",
] as const;

const CLOSED_FAILURE_STATUSES = new Set([
  "closed",
  "dismissed",
  "resolved",
  "superseded",
  "overcome",
]);

const STOP_WORDS = new Set([
  "about",
  "after",
  "also",
  "been",
  "before",
  "being",
  "from",
  "have",
  "into",
  "that",
  "their",
  "there",
  "these",
  "this",
  "through",
  "using",
  "were",
  "what",
  "when",
  "where",
  "which",
  "while",
  "with",
]);

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertNonEmptyString(value: string, label: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
}

function assertBound(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
}

function isSecretLikeKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/gu, "");
  if (
    normalized.endsWith("id") ||
    normalized.endsWith("ref") ||
    normalized.endsWith("name")
  ) {
    return false;
  }
  return SECRET_KEY_PARTS.some(
    (part) => normalized === part || normalized.endsWith(part),
  );
}

/** Defensive sanitizer for user text that may later enter model context. */
export function redactSecretText(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, "Bearer [REDACTED]")
    .replace(
      /\b(secret|token|password|passwd|api[_-]?key|authorization|credential|private[_-]?key|access[_-]?key|client[_-]?secret|cookie)\b\s*[:=]\s*(?:Bearer\s+(?:\[REDACTED\]|[^\s,;}\]]+)|\[REDACTED\]|"[^"]*"|'[^']*'|[^\s,;}\]]+)/giu,
      "$1=[REDACTED]",
    );
}

export function redactSecretValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => redactSecretValue(item));
  if (typeof value === "string") return redactSecretText(value);
  if (typeof value !== "object" || value === null) return value;

  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    output[key] = isSecretLikeKey(key)
      ? "[REDACTED]"
      : redactSecretValue(child);
  }
  return output;
}

function tokens(value: unknown): Set<string> {
  const result = new Set<string>();
  const text = typeof value === "string" ? value : canonicalJson(value);
  for (const token of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (token.length >= 3 && !STOP_WORDS.has(token)) result.add(token);
  }
  return result;
}

function lexicalOverlap(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  let score = 0;
  for (const token of left) {
    if (right.has(token)) score += 1;
  }
  return score;
}

function graphDepths(
  goalId: string,
  objectsById: ReadonlyMap<string, ObjectProjection>,
  projectRoot: string,
  branchId: string,
): Map<string, number> {
  const adjacency = new Map<string, string[]>();
  const add = (from: string, to: string): void => {
    const neighbors = adjacency.get(from) ?? [];
    neighbors.push(to);
    adjacency.set(from, neighbors);
  };

  for (const edge of listEdges(projectRoot, branchId)) {
    if (
      !objectsById.has(edge.fromObjectId) ||
      !objectsById.has(edge.toObjectId)
    ) {
      continue;
    }
    add(edge.fromObjectId, edge.toObjectId);
    add(edge.toObjectId, edge.fromObjectId);
  }
  for (const neighbors of adjacency.values()) {
    neighbors.sort(compareStrings);
  }

  const depths = new Map<string, number>([[goalId, 0]]);
  const queue = [goalId];
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    if (current === undefined) continue;
    const nextDepth = (depths.get(current) ?? 0) + 1;
    for (const neighbor of adjacency.get(current) ?? []) {
      if (depths.has(neighbor)) continue;
      depths.set(neighbor, nextDepth);
      queue.push(neighbor);
    }
  }
  return depths;
}

function isOpenFailure(object: ObjectProjection): boolean {
  if (object.objectType !== "failure") return false;
  if (typeof object.content !== "object" || object.content === null) return true;
  const content = object.content as Record<string, unknown>;
  if (content.resolved === true || content.open === false) return false;
  const status = content.status;
  return !(
    typeof status === "string" &&
    CLOSED_FAILURE_STATUSES.has(status.trim().toLowerCase())
  );
}

function rankCandidates(
  objects: readonly ObjectProjection[],
  goal: ObjectProjection,
  depths: ReadonlyMap<string, number>,
  options: CompileContextOptions,
): RankedCandidate[] {
  const allowedTypes =
    options.includeObjectTypes === undefined
      ? undefined
      : new Set<string>(options.includeObjectTypes);
  const redactedGoal = redactSecretValue(goal.content);
  const relevanceTokens = tokens(
    options.query === undefined
      ? redactedGoal
      : [redactedGoal, options.query],
  );
  const candidates: RankedCandidate[] = [];

  for (const object of objects) {
    if (
      object.objectId !== goal.objectId &&
      allowedTypes !== undefined &&
      !allowedTypes.has(object.objectType)
    ) {
      continue;
    }
    const redactedContent = redactSecretValue(object.content);
    const lexicalScore = lexicalOverlap(tokens(redactedContent), relevanceTokens);
    const depth = depths.get(object.objectId);
    let selectionReason: ContextSelectionReason | undefined;
    if (object.objectId === goal.objectId) {
      selectionReason = "goal";
    } else if (object.objectType === "failure") {
      if (isOpenFailure(object) && (depth !== undefined || lexicalScore > 0)) {
        selectionReason = "negative-context";
      }
    } else if (depth !== undefined) {
      selectionReason = "graph";
    } else if (lexicalScore > 0) {
      selectionReason = "lexical";
    }
    if (selectionReason === undefined) continue;
    candidates.push({
      object,
      selectionReason,
      ...(depth === undefined ? {} : { depth }),
      lexicalScore,
      redactedContent,
    });
  }

  const reasonRank: Record<ContextSelectionReason, number> = {
    goal: 0,
    "negative-context": 1,
    graph: 2,
    lexical: 3,
  };
  return candidates.sort(
    (left, right) =>
      reasonRank[left.selectionReason] - reasonRank[right.selectionReason] ||
      (left.depth ?? Number.MAX_SAFE_INTEGER) -
        (right.depth ?? Number.MAX_SAFE_INTEGER) ||
      right.lexicalScore - left.lexicalScore ||
      compareStrings(left.object.objectType, right.object.objectType) ||
      compareStrings(left.object.objectId, right.object.objectId),
  );
}

function entryPrefix(candidate: RankedCandidate): string {
  return `[object:${candidate.object.objectId}@${candidate.object.versionId}]\n`;
}

function header(options: CompileContextOptions): string {
  const query =
    options.query === undefined ? "" : `query=${JSON.stringify(options.query)}\n`;
  return `branch=${options.branchId}\ngoal=${options.goalId}\n${query}`;
}

/**
 * Compile a deterministic, bounded model prompt from current branch objects.
 * This service only reads the disposable projection and never mutates canonical
 * project history.
 */
export function compileContext(
  projectRoot: string,
  options: CompileContextOptions,
): ContextBundle {
  assertNonEmptyString(projectRoot, "projectRoot");
  assertNonEmptyString(options.branchId, "branchId");
  assertNonEmptyString(options.goalId, "goalId");
  assertBound(options.maxCharacters, "maxCharacters");
  assertBound(options.maxEntries, "maxEntries");
  if (options.query !== undefined && typeof options.query !== "string") {
    throw new TypeError("query must be a string when supplied");
  }
  if (options.includeObjectTypes !== undefined) {
    if (!Array.isArray(options.includeObjectTypes)) {
      throw new TypeError("includeObjectTypes must be an array when supplied");
    }
    const knownTypes = new Set<string>(OBJECT_TYPES);
    const seen = new Set<string>();
    for (const type of options.includeObjectTypes) {
      if (!knownTypes.has(type)) {
        throw new TypeError(`Unsupported context object type: ${String(type)}`);
      }
      if (seen.has(type)) {
        throw new TypeError(`Duplicate context object type: ${type}`);
      }
      seen.add(type);
    }
  }
  const safeOptions: CompileContextOptions =
    options.query === undefined
      ? options
      : { ...options, query: redactSecretText(options.query) };

  const objects = listCurrentObjects(projectRoot, options.branchId);
  const objectsById = new Map(objects.map((object) => [object.objectId, object]));
  const goal = objectsById.get(options.goalId);
  if (goal === undefined || goal.objectType !== "goal") {
    throw new Error(
      `Goal ${options.goalId} is not visible on branch ${options.branchId}`,
    );
  }

  const depths = graphDepths(
    goal.objectId,
    objectsById,
    projectRoot,
    options.branchId,
  );
  const ranked = rankCandidates(objects, goal, depths, safeOptions);
  let promptText = header(safeOptions).slice(0, options.maxCharacters);
  const entries: ContextEntry[] = [];
  const includedObjectIds = new Set<string>();
  const entryLimit = Math.min(options.maxEntries, ranked.length);

  for (let index = 0; index < entryLimit; index += 1) {
    const candidate = ranked[index];
    if (candidate === undefined) continue;
    const available = options.maxCharacters - promptText.length;
    const prefix = entryPrefix(candidate);
    if (available < prefix.length) continue;

    // Fair-share allocation prevents an early large object from crowding a
    // reserved relevant failure out of an otherwise sufficiently large prompt.
    const remainingSlots = entryLimit - index;
    const allocation = Math.max(prefix.length, Math.floor(available / remainingSlots));
    const fullText = `${prefix}${canonicalJson(candidate.redactedContent)}\n`;
    const text = fullText.slice(0, Math.min(available, allocation));
    const start = promptText.length;
    promptText += text;
    const end = promptText.length;
    entries.push({
      objectId: candidate.object.objectId,
      versionId: candidate.object.versionId,
      objectType: candidate.object.objectType,
      contentHash: candidate.object.contentHash,
      selectionReason: candidate.selectionReason,
      ...(candidate.depth === undefined ? {} : { depth: candidate.depth }),
      truncated: text.length < fullText.length,
      text,
      promptSpan: { start, end },
    });
    includedObjectIds.add(candidate.object.objectId);
  }

  const omittedObjectIds = ranked
    .filter((candidate) => !includedObjectIds.has(candidate.object.objectId))
    .map((candidate) => candidate.object.objectId);
  const withoutDigest = {
    schemaVersion: CONTEXT_BUNDLE_SCHEMA_VERSION,
    branchId: options.branchId,
    goalId: options.goalId,
    ...(safeOptions.query === undefined ? {} : { query: safeOptions.query }),
    maxCharacters: options.maxCharacters,
    maxEntries: options.maxEntries,
    promptText,
    usedCharacters: promptText.length,
    estimatedTokens: Math.ceil(promptText.length / 4),
    entries,
    omittedEntryCount: omittedObjectIds.length,
    omittedObjectIds,
  };

  return {
    ...withoutDigest,
    digest: sha256Digest(canonicalJson(withoutDigest)),
  };
}
