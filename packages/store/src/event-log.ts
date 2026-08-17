import {
  EventSchema,
  ProjectManifestSchema,
  verifyEventHash,
  type Event,
  type ProjectManifest,
} from "@reasoning-workbench/project-format";
import { randomBytes } from "node:crypto";
import {
  constants as fsConstants,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { hostname } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
  sep,
} from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export const CANONICAL_MANIFEST_FILE_NAME = "reasoning-project.json";
export const LEGACY_MANIFEST_FILE_NAME = "project.json";

const EVENTS_DIRECTORY_NAME = "events";
const EVENT_LOG_LOCK_RELATIVE_PATH = join(
  ".reasoning",
  "runtime",
  "event-log.append.lock",
);

export type EventLogIssueSeverity = "error" | "warning";

export interface EventLogIssue {
  code: string;
  severity: EventLogIssueSeverity;
  message: string;
  segmentPath?: string;
  line?: number;
  eventId?: string;
  expected?: unknown;
  actual?: unknown;
}

export interface SegmentInspection {
  segmentPath: string;
  accepted: boolean;
  exists: boolean;
  byteLength?: number;
  eventCount: number;
  firstSequence?: number;
  lastSequence?: number;
  issues: EventLogIssue[];
}

export interface EventLogInspection {
  valid: boolean;
  manifestPath: string;
  manifest?: ProjectManifest;
  events: Event[];
  segments: SegmentInspection[];
  orphanSegments: string[];
  issues: EventLogIssue[];
}

export interface EventLogPaths {
  projectRoot: string;
  manifestPath: string;
  eventsDirectory: string;
  lockPath: string;
}

export interface AppendHookContext {
  projectRoot: string;
  manifestPath: string;
  segmentPath: string;
  absoluteSegmentPath: string;
  event: Event;
}

export interface AppendEventHooks {
  /** The complete segment exists in a staging file, but is not durable yet. */
  afterSegmentStaged?: (context: AppendHookContext) => void | Promise<void>;
  /** The immutable segment is durable, but the manifest does not reference it yet. */
  afterSegmentCommitted?: (context: AppendHookContext) => void | Promise<void>;
  /** The replacement manifest is durable in staging, immediately before atomic rename. */
  beforeManifestCommit?: (context: AppendHookContext) => void | Promise<void>;
  /** The event is accepted. Exceptions here do not roll the accepted event back. */
  afterManifestCommitted?: (context: AppendHookContext) => void | Promise<void>;
}

export interface AppendEventOptions {
  manifestFileName?: string;
  hooks?: AppendEventHooks;
  lockTimeoutMs?: number;
  lockRetryMs?: number;
  staleLockMs?: number;
}

export interface AppendEventResult {
  event: Event;
  manifest: ProjectManifest;
  segmentPath: string;
  recoveredOrphanSegment: boolean;
}

export interface InspectEventLogOptions {
  manifestFileName?: string;
}

export class EventLogError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "EventLogError";
  }
}

export class EventLogLockedError extends EventLogError {
  public constructor(public readonly lockPath: string) {
    super(`Event log is locked: ${lockPath}`);
    this.name = "EventLogLockedError";
  }
}

export class EventLogIntegrityError extends EventLogError {
  public constructor(
    message: string,
    public readonly issues: readonly EventLogIssue[],
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "EventLogIntegrityError";
  }
}

interface LockRecord {
  token: string;
  pid: number;
  hostname: string;
  createdAt: string;
}

interface AcquiredLock {
  path: string;
  token: string;
}

interface StrictSegmentRead {
  text: string;
  byteLength: number;
  lines: string[];
}

/**
 * Creates only event-log runtime directories. A project manifest must be
 * created by the project service; this function never invents project state.
 */
export async function initializeEventLog(
  projectRoot: string,
  options: InspectEventLogOptions = {},
): Promise<EventLogPaths> {
  const absoluteProjectRoot = resolve(projectRoot);
  const eventsDirectory = join(absoluteProjectRoot, EVENTS_DIRECTORY_NAME);
  const lockPath = join(absoluteProjectRoot, EVENT_LOG_LOCK_RELATIVE_PATH);

  await mkdir(eventsDirectory, { recursive: true });
  await mkdir(dirname(lockPath), { recursive: true });

  return {
    projectRoot: absoluteProjectRoot,
    manifestPath: await resolveManifestPath(absoluteProjectRoot, options.manifestFileName),
    eventsDirectory,
    lockPath,
  };
}

/**
 * Appends one immutable JSONL segment and accepts it by atomically replacing
 * the manifest. A segment that survives a failure before the manifest rename
 * is intentionally an orphan and is never returned by readAcceptedEvents.
 */
export async function appendEvent(
  projectRoot: string,
  candidate: unknown,
  options: AppendEventOptions = {},
): Promise<AppendEventResult> {
  const paths = await initializeEventLog(projectRoot, options);
  const lock = await acquireLock(paths.lockPath, options);

  let segmentStagingPath: string | undefined;
  let manifestStagingPath: string | undefined;

  try {
    const manifest = await readManifest(paths.manifestPath);
    const event = parseEvent(candidate);

    if (event.projectId !== manifest.projectId) {
      throw new EventLogIntegrityError("Event belongs to a different project", [
        issue("EVENT_PROJECT_MISMATCH", "error", "Event projectId does not match manifest", {
          eventId: event.eventId,
          expected: manifest.projectId,
          actual: event.projectId,
        }),
      ]);
    }

    const acceptedEvents = await readAcceptedEvents(paths.projectRoot, manifest, {
      manifestFileName: basename(paths.manifestPath),
    });
    const previousEvent = acceptedEvents.at(-1);
    const expectedSequence = (previousEvent?.sequence ?? 0) + 1;

    if (event.sequence !== expectedSequence) {
      throw new EventLogIntegrityError("Event sequence is not the next accepted sequence", [
        issue(
          "EVENT_SEQUENCE_NON_MONOTONIC",
          "error",
          `Expected sequence ${expectedSequence}, received ${event.sequence}`,
          {
            eventId: event.eventId,
            expected: expectedSequence,
            actual: event.sequence,
          },
        ),
      ]);
    }

    if (
      event.previousEventHash !== undefined &&
      event.previousEventHash !== previousEvent?.eventHash
    ) {
      throw new EventLogIntegrityError("Event previousEventHash does not match history", [
        issue(
          "EVENT_PREVIOUS_HASH_MISMATCH",
          "error",
          "Event previousEventHash does not match the preceding accepted event",
          {
            eventId: event.eventId,
            expected: previousEvent?.eventHash ?? null,
            actual: event.previousEventHash,
          },
        ),
      ]);
    }

    const serializedEvent = `${JSON.stringify(event)}\n`;
    const destination = await chooseSegmentDestination(
      paths.eventsDirectory,
      event,
      serializedEvent,
    );
    const hookContext: AppendHookContext = {
      projectRoot: paths.projectRoot,
      manifestPath: paths.manifestPath,
      segmentPath: destination.relativePath,
      absoluteSegmentPath: destination.absolutePath,
      event,
    };

    if (!destination.reuseExisting) {
      segmentStagingPath = temporarySiblingPath(destination.absolutePath, lock.token);
      await writeDurableFile(segmentStagingPath, serializedEvent);
      await options.hooks?.afterSegmentStaged?.(hookContext);
      await rename(segmentStagingPath, destination.absolutePath);
      segmentStagingPath = undefined;
      await syncDirectory(paths.eventsDirectory);
    }

    await options.hooks?.afterSegmentCommitted?.(hookContext);

    const nextManifest = ProjectManifestSchema.parse({
      ...manifest,
      eventSegments: [...manifest.eventSegments, destination.relativePath],
    });
    const serializedManifest = `${JSON.stringify(nextManifest, null, 2)}\n`;
    manifestStagingPath = temporarySiblingPath(paths.manifestPath, lock.token);
    await writeDurableFile(manifestStagingPath, serializedManifest);
    await options.hooks?.beforeManifestCommit?.(hookContext);
    await rename(manifestStagingPath, paths.manifestPath);
    manifestStagingPath = undefined;
    await syncDirectory(dirname(paths.manifestPath));

    await options.hooks?.afterManifestCommitted?.(hookContext);

    return {
      event,
      manifest: nextManifest,
      segmentPath: destination.relativePath,
      recoveredOrphanSegment: destination.reuseExisting,
    };
  } finally {
    // Lock release must not be skipped even when cleanup of a staging file
    // encounters an independent filesystem error.
    const cleanupResults = await Promise.allSettled([
      removeIfPresent(segmentStagingPath),
      removeIfPresent(manifestStagingPath),
    ]);
    await releaseLock(lock);
    const cleanupFailure = cleanupResults.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (cleanupFailure !== undefined) {
      throw cleanupFailure.reason;
    }
  }
}

/**
 * Returns only events referenced by the atomically committed manifest. The
 * function rejects the complete read on any accepted-history corruption.
 */
export async function readAcceptedEvents(
  projectRoot: string,
  manifest?: ProjectManifest,
  options: InspectEventLogOptions = {},
): Promise<Event[]> {
  const inspection = await inspectEventLog(projectRoot, manifest, options);
  const errors = inspection.issues.filter(({ severity }) => severity === "error");

  if (errors.length > 0) {
    throw new EventLogIntegrityError(
      `Accepted event history failed integrity checks (${errors.length} error${errors.length === 1 ? "" : "s"})`,
      errors,
    );
  }

  return inspection.events;
}

/**
 * Inspects accepted segments and reports orphan/staging files left as crash
 * evidence. Orphans are warnings because they are outside accepted state.
 */
export async function inspectEventLog(
  projectRoot: string,
  suppliedManifest?: ProjectManifest,
  options: InspectEventLogOptions = {},
): Promise<EventLogInspection> {
  const absoluteProjectRoot = resolve(projectRoot);
  const manifestPath = await resolveManifestPath(
    absoluteProjectRoot,
    options.manifestFileName,
  );
  const eventsDirectory = join(absoluteProjectRoot, EVENTS_DIRECTORY_NAME);
  const issues: EventLogIssue[] = [];
  const segments: SegmentInspection[] = [];
  const events: Event[] = [];

  let manifest: ProjectManifest | undefined;
  if (suppliedManifest !== undefined) {
    try {
      manifest = ProjectManifestSchema.parse(suppliedManifest);
    } catch (error) {
      issues.push(
        issue("MANIFEST_INVALID", "error", formatUnknownError(error), {
          actual: suppliedManifest,
        }),
      );
    }
  } else {
    try {
      manifest = await readManifest(manifestPath);
    } catch (error) {
      issues.push(
        issue(
          errorCode(error) === "ENOENT" ? "MANIFEST_MISSING" : "MANIFEST_INVALID",
          "error",
          formatUnknownError(error),
        ),
      );
    }
  }

  const acceptedPaths = new Set<string>();
  let previousEvent: Event | undefined;

  if (manifest !== undefined) {
    for (const segmentPath of manifest.eventSegments) {
      const segmentIssues: EventLogIssue[] = [];
      const inspection: SegmentInspection = {
        segmentPath,
        accepted: true,
        exists: false,
        eventCount: 0,
        issues: segmentIssues,
      };
      segments.push(inspection);

      if (acceptedPaths.has(segmentPath)) {
        const duplicateIssue = issue(
          "SEGMENT_DUPLICATE",
          "error",
          "Manifest references the same event segment more than once",
          { segmentPath },
        );
        segmentIssues.push(duplicateIssue);
        issues.push(duplicateIssue);
        continue;
      }
      acceptedPaths.add(segmentPath);

      let absoluteSegmentPath: string;
      try {
        absoluteSegmentPath = resolveAcceptedSegmentPath(absoluteProjectRoot, segmentPath);
      } catch (error) {
        const pathIssue = issue(
          "SEGMENT_PATH_INVALID",
          "error",
          formatUnknownError(error),
          { segmentPath },
        );
        segmentIssues.push(pathIssue);
        issues.push(pathIssue);
        continue;
      }

      let strictSegment: StrictSegmentRead;
      try {
        strictSegment = await readSegmentStrict(absoluteSegmentPath);
        inspection.exists = true;
        inspection.byteLength = strictSegment.byteLength;
      } catch (error) {
        const code = errorCode(error);
        const readIssue = issue(
          code === "ENOENT" ? "SEGMENT_MISSING" : "SEGMENT_READ_FAILED",
          "error",
          formatUnknownError(error),
          { segmentPath },
        );
        segmentIssues.push(readIssue);
        issues.push(readIssue);
        continue;
      }

      if (!strictSegment.text.endsWith("\n")) {
        const truncatedIssue = issue(
          "SEGMENT_TRUNCATED",
          "error",
          "JSONL segment does not end with a newline",
          { segmentPath },
        );
        segmentIssues.push(truncatedIssue);
        issues.push(truncatedIssue);
      }

      if (strictSegment.lines.length === 0) {
        const emptyIssue = issue(
          "SEGMENT_EMPTY",
          "error",
          "Accepted event segment is empty",
          { segmentPath },
        );
        segmentIssues.push(emptyIssue);
        issues.push(emptyIssue);
      }

      for (const [lineIndex, line] of strictSegment.lines.entries()) {
        const lineNumber = lineIndex + 1;
        if (line.length === 0) {
          const blankIssue = issue(
            "SEGMENT_EMPTY_LINE",
            "error",
            "JSONL segment contains an empty line",
            { segmentPath, line: lineNumber },
          );
          segmentIssues.push(blankIssue);
          issues.push(blankIssue);
          continue;
        }

        let decoded: unknown;
        try {
          decoded = JSON.parse(line) as unknown;
        } catch (error) {
          const jsonIssue = issue(
            "SEGMENT_JSON_INVALID",
            "error",
            formatUnknownError(error),
            { segmentPath, line: lineNumber },
          );
          segmentIssues.push(jsonIssue);
          issues.push(jsonIssue);
          continue;
        }

        const parsed = EventSchema.safeParse(decoded);
        if (!parsed.success) {
          const schemaIssue = issue(
            "EVENT_SCHEMA_INVALID",
            "error",
            parsed.error.message,
            { segmentPath, line: lineNumber },
          );
          segmentIssues.push(schemaIssue);
          issues.push(schemaIssue);
          continue;
        }

        const event = parsed.data;
        inspection.eventCount += 1;
        inspection.firstSequence ??= event.sequence;
        inspection.lastSequence = event.sequence;
        events.push(event);

        if (!verifyEventHash(event)) {
          const hashIssue = issue(
            "EVENT_HASH_MISMATCH",
            "error",
            "Event hash does not match canonical event content",
            {
              segmentPath,
              line: lineNumber,
              eventId: event.eventId,
              actual: event.eventHash,
            },
          );
          segmentIssues.push(hashIssue);
          issues.push(hashIssue);
        }

        if (event.projectId !== manifest.projectId) {
          const projectIssue = issue(
            "EVENT_PROJECT_MISMATCH",
            "error",
            "Event projectId does not match manifest",
            {
              segmentPath,
              line: lineNumber,
              eventId: event.eventId,
              expected: manifest.projectId,
              actual: event.projectId,
            },
          );
          segmentIssues.push(projectIssue);
          issues.push(projectIssue);
        }

        const expectedSequence = (previousEvent?.sequence ?? 0) + 1;
        if (event.sequence !== expectedSequence) {
          const sequenceIssue = issue(
            "EVENT_SEQUENCE_NON_MONOTONIC",
            "error",
            `Expected sequence ${expectedSequence}, received ${event.sequence}`,
            {
              segmentPath,
              line: lineNumber,
              eventId: event.eventId,
              expected: expectedSequence,
              actual: event.sequence,
            },
          );
          segmentIssues.push(sequenceIssue);
          issues.push(sequenceIssue);
        }

        if (
          event.previousEventHash !== undefined &&
          event.previousEventHash !== previousEvent?.eventHash
        ) {
          const previousHashIssue = issue(
            "EVENT_PREVIOUS_HASH_MISMATCH",
            "error",
            "Event previousEventHash does not match preceding event",
            {
              segmentPath,
              line: lineNumber,
              eventId: event.eventId,
              expected: previousEvent?.eventHash ?? null,
              actual: event.previousEventHash,
            },
          );
          segmentIssues.push(previousHashIssue);
          issues.push(previousHashIssue);
        }

        previousEvent = event;
      }
    }
  }

  const orphanSegments: string[] = [];
  try {
    const entries = await readdir(eventsDirectory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }

      const segmentPath = `${EVENTS_DIRECTORY_NAME}/${entry.name}`;
      if (entry.name.endsWith(".jsonl") && !acceptedPaths.has(segmentPath)) {
        orphanSegments.push(segmentPath);
        issues.push(
          issue(
            "ORPHAN_SEGMENT",
            "warning",
            "Complete segment is not referenced by the manifest and is not accepted",
            { segmentPath },
          ),
        );
      } else if (entry.name.includes(".tmp-")) {
        issues.push(
          issue(
            "STAGING_FILE_PRESENT",
            "warning",
            "Staging file remains from an interrupted write and is not accepted",
            { segmentPath },
          ),
        );
      }
    }
  } catch (error) {
    if (errorCode(error) !== "ENOENT") {
      issues.push(issue("EVENTS_DIRECTORY_READ_FAILED", "error", formatUnknownError(error)));
    }
  }

  return {
    valid: !issues.some(({ severity }) => severity === "error"),
    manifestPath,
    ...(manifest === undefined ? {} : { manifest }),
    events,
    segments,
    orphanSegments: orphanSegments.sort(),
    issues,
  };
}

/** Alias emphasizing that the returned report is suitable for verification gates. */
export async function verifyEventLog(
  projectRoot: string,
  manifest?: ProjectManifest,
  options: InspectEventLogOptions = {},
): Promise<EventLogInspection> {
  return inspectEventLog(projectRoot, manifest, options);
}

async function readManifest(manifestPath: string): Promise<ProjectManifest> {
  const text = await readFile(manifestPath, "utf8");
  return ProjectManifestSchema.parse(JSON.parse(text) as unknown);
}

function parseEvent(candidate: unknown): Event {
  const event = EventSchema.parse(candidate);
  if (!verifyEventHash(event)) {
    throw new EventLogIntegrityError("Event hash does not match canonical content", [
      issue("EVENT_HASH_MISMATCH", "error", "Event hash does not match canonical event content", {
        eventId: event.eventId,
        actual: event.eventHash,
      }),
    ]);
  }
  return event;
}

async function resolveManifestPath(
  absoluteProjectRoot: string,
  explicitFileName?: string,
): Promise<string> {
  if (explicitFileName !== undefined) {
    if (
      explicitFileName.length === 0 ||
      isAbsolute(explicitFileName) ||
      basename(explicitFileName) !== explicitFileName
    ) {
      throw new EventLogError("manifestFileName must be a plain file name");
    }
    return join(absoluteProjectRoot, explicitFileName);
  }

  const canonicalPath = join(absoluteProjectRoot, CANONICAL_MANIFEST_FILE_NAME);
  if (await pathExists(canonicalPath)) {
    return canonicalPath;
  }

  const legacyPath = join(absoluteProjectRoot, LEGACY_MANIFEST_FILE_NAME);
  if (await pathExists(legacyPath)) {
    return legacyPath;
  }

  return canonicalPath;
}

async function chooseSegmentDestination(
  eventsDirectory: string,
  event: Event,
  serializedEvent: string,
): Promise<{ absolutePath: string; relativePath: string; reuseExisting: boolean }> {
  const sequence = String(event.sequence);
  const minimumWidth = Math.max(8, sequence.length);

  // Wider zero-padding stays inside the public segment-path schema while
  // giving recovery a non-destructive name if a conflicting orphan occupies
  // the normal eight-digit path.
  for (let width = minimumWidth; width <= 16; width += 1) {
    const paddedSequence = sequence.padStart(width, "0");
    const fileName = `${paddedSequence}-${paddedSequence}.jsonl`;
    const absolutePath = join(eventsDirectory, fileName);
    const contents = await readFileIfPresent(absolutePath);
    if (contents === undefined) {
      return segmentDestination(absolutePath, fileName, false);
    }
    if (contents === serializedEvent) {
      return segmentDestination(absolutePath, fileName, true);
    }
  }

  throw new EventLogError(`Could not allocate an immutable segment for ${event.eventId}`);
}

function segmentDestination(
  absolutePath: string,
  fileName: string,
  reuseExisting: boolean,
): { absolutePath: string; relativePath: string; reuseExisting: boolean } {
  return {
    absolutePath,
    relativePath: `${EVENTS_DIRECTORY_NAME}/${fileName}`,
    reuseExisting,
  };
}

function resolveAcceptedSegmentPath(projectRoot: string, segmentPath: string): string {
  if (isAbsolute(segmentPath)) {
    throw new EventLogError("Event segment path must be relative to the project");
  }

  const normalized = normalize(segmentPath);
  if (
    normalized === ".." ||
    normalized.startsWith(`..${sep}`) ||
    normalized === EVENTS_DIRECTORY_NAME ||
    !normalized.startsWith(`${EVENTS_DIRECTORY_NAME}${sep}`)
  ) {
    throw new EventLogError("Event segment path must remain inside events/");
  }

  const absolute = resolve(projectRoot, normalized);
  const fromRoot = relative(projectRoot, absolute);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new EventLogError("Event segment path escapes the project root");
  }
  return absolute;
}

async function readSegmentStrict(absolutePath: string): Promise<StrictSegmentRead> {
  const contents = await readFile(absolutePath);
  const text = contents.toString("utf8");
  const splitLines = text.split("\n");
  if (splitLines.at(-1) === "") {
    splitLines.pop();
  }
  return { text, byteLength: contents.byteLength, lines: splitLines };
}

async function writeDurableFile(path: string, contents: string): Promise<void> {
  const handle = await open(path, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(directory: string): Promise<void> {
  let handle;
  try {
    handle = await open(directory, fsConstants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    // Directory fsync is unavailable on a few supported filesystems. Atomic
    // rename still protects visibility; callers retain the strongest durability
    // the filesystem exposes.
    const code = errorCode(error);
    if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EPERM" && code !== "EISDIR") {
      throw error;
    }
  } finally {
    await handle?.close();
  }
}

async function acquireLock(
  lockPath: string,
  options: AppendEventOptions,
): Promise<AcquiredLock> {
  const token = randomToken();
  const timeoutMs = options.lockTimeoutMs ?? 5_000;
  const retryMs = options.lockRetryMs ?? 25;
  const staleLockMs = options.staleLockMs ?? 10 * 60_000;
  const startedAt = Date.now();

  for (;;) {
    let createdLock = false;
    try {
      const handle = await open(lockPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
      createdLock = true;
      const record: LockRecord = {
        token,
        pid: process.pid,
        hostname: hostname(),
        createdAt: new Date().toISOString(),
      };
      try {
        await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await syncDirectory(dirname(lockPath));
      return { path: lockPath, token };
    } catch (error) {
      if (createdLock) {
        // If persisting the ownership record itself fails, do not strand an
        // unreadable lock that would block recovery forever.
        await removeIfPresent(lockPath);
        throw error;
      }
      if (errorCode(error) !== "EEXIST") {
        throw error;
      }

      if (await removeStaleLock(lockPath, staleLockMs)) {
        continue;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        throw new EventLogLockedError(lockPath);
      }
      await delay(retryMs);
    }
  }
}

async function removeStaleLock(lockPath: string, staleLockMs: number): Promise<boolean> {
  let rawRecord: string;
  try {
    rawRecord = await readFile(lockPath, "utf8");
  } catch (error) {
    return errorCode(error) === "ENOENT";
  }

  let record: LockRecord | undefined;
  try {
    record = JSON.parse(rawRecord) as LockRecord;
  } catch {
    // A process can crash between O_EXCL creation and writing its ownership
    // record. Do not steal a fresh partial record, but recover it once stale.
    try {
      const lockStat = await stat(lockPath);
      if (Date.now() - lockStat.mtimeMs <= staleLockMs) {
        return false;
      }
      if ((await readFile(lockPath, "utf8")) !== rawRecord) {
        return false;
      }
      await unlink(lockPath);
      return true;
    } catch (error) {
      return errorCode(error) === "ENOENT";
    }
  }

  let stale = false;
  if (record.hostname === hostname() && Number.isSafeInteger(record.pid)) {
    stale = !isProcessAlive(record.pid);
  } else {
    try {
      const lockStat = await stat(lockPath);
      stale = Date.now() - lockStat.mtimeMs > staleLockMs;
    } catch (error) {
      return errorCode(error) === "ENOENT";
    }
  }

  if (!stale) {
    return false;
  }

  // Remove only the lock that was inspected, never a replacement lock.
  try {
    const current = JSON.parse(await readFile(lockPath, "utf8")) as LockRecord;
    if (current.token !== record.token) {
      return false;
    }
    await unlink(lockPath);
    return true;
  } catch (error) {
    return errorCode(error) === "ENOENT";
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}

async function releaseLock(lock: AcquiredLock): Promise<void> {
  try {
    const current = JSON.parse(await readFile(lock.path, "utf8")) as LockRecord;
    if (current.token === lock.token) {
      await unlink(lock.path);
      await syncDirectory(dirname(lock.path));
    }
  } catch (error) {
    if (errorCode(error) !== "ENOENT") {
      throw error;
    }
  }
}

function temporarySiblingPath(destination: string, token: string): string {
  return `${destination}.tmp-${token}-${randomToken()}`;
}

function randomToken(): string {
  return randomBytes(12).toString("hex");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function readFileIfPresent(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function removeIfPresent(path: string | undefined): Promise<void> {
  if (path === undefined) {
    return;
  }
  try {
    await unlink(path);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") {
      throw error;
    }
  }
}

function issue(
  code: string,
  severity: EventLogIssueSeverity,
  message: string,
  details: Omit<EventLogIssue, "code" | "severity" | "message"> = {},
): EventLogIssue {
  return { code, severity, message, ...details };
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
