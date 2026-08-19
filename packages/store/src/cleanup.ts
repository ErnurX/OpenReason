import { readdir, rm, stat, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  EVENTS_DIRECTORY_NAME,
  EVENT_LOG_LOCK_RELATIVE_PATH,
  DEFAULT_STALE_LOCK_MS,
  inspectEventLog,
} from "./event-log.js";

export interface CleanupOptions {
  dryRun?: boolean;
  removeOrphanSegments?: boolean;
  staleLockMs?: number;
}

export interface CleanupReport {
  projectRoot: string;
  dryRun: boolean;
  stagingFilesRemoved: string[];
  orphanSegmentsRemoved: string[];
  staleLocksRemoved: string[];
  totalFilesRemoved: number;
  freedBytes: number;
}

async function isLockStale(lockPath: string, maxAgeMs: number): Promise<boolean> {
  try {
    const raw = await readFile(lockPath, "utf8");
    const record = JSON.parse(raw) as { pid?: number; createdAt?: string };
    if (record.createdAt !== undefined) {
      const age = Date.now() - Date.parse(record.createdAt);
      if (Number.isFinite(age) && age > maxAgeMs) {
        return true;
      }
    }
    if (typeof record.pid === "number") {
      try {
        process.kill(record.pid, 0);
        return false;
      } catch (err: unknown) {
        const error = err as { code?: string };
        if (error.code === "ESRCH") {
          return true;
        }
      }
    }
    return false;
  } catch {
    return true;
  }
}

export async function cleanupProject(
  projectRoot: string,
  options: CleanupOptions = {},
): Promise<CleanupReport> {
  const absoluteRoot = resolve(projectRoot);
  const dryRun = options.dryRun ?? false;
  const staleLockMs = options.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
  const removeOrphanSegments = options.removeOrphanSegments ?? false;

  const stagingFilesRemoved: string[] = [];
  const orphanSegmentsRemoved: string[] = [];
  const staleLocksRemoved: string[] = [];
  let freedBytes = 0;

  // 1. Inspect event log for orphan segments and events staging files
  const inspection = await inspectEventLog(absoluteRoot);

  const eventsDir = join(absoluteRoot, EVENTS_DIRECTORY_NAME);
  try {
    const entries = await readdir(eventsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const fullPath = join(eventsDir, entry.name);
      const relPath = `${EVENTS_DIRECTORY_NAME}/${entry.name}`;

      if (entry.name.includes(".tmp-")) {
        const fileStat = await stat(fullPath).catch(() => undefined);
        if (fileStat) freedBytes += fileStat.size;
        stagingFilesRemoved.push(relPath);
        if (!dryRun) {
          await rm(fullPath, { force: true });
        }
      } else if (removeOrphanSegments && inspection.orphanSegments.includes(relPath)) {
        const fileStat = await stat(fullPath).catch(() => undefined);
        if (fileStat) freedBytes += fileStat.size;
        orphanSegmentsRemoved.push(relPath);
        if (!dryRun) {
          await rm(fullPath, { force: true });
        }
      }
    }
  } catch {
    // Events directory might not exist yet
  }

  // 2. Inspect .reasoning directory (including subdirectories like runtime/) for staging files and lock files
  const reasoningDir = join(absoluteRoot, ".reasoning");
  async function scanReasoningDir(dir: string, relBase: string): Promise<void> {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        const relPath = `${relBase}/${entry.name}`;

        if (entry.isDirectory()) {
          await scanReasoningDir(fullPath, relPath);
        } else if (entry.isFile()) {
          if (entry.name.includes(".tmp-")) {
            const fileStat = await stat(fullPath).catch(() => undefined);
            if (fileStat) freedBytes += fileStat.size;
            stagingFilesRemoved.push(relPath);
            if (!dryRun) {
              await rm(fullPath, { force: true });
            }
          } else if (entry.name.endsWith(".lock")) {
            const lockStat = await stat(fullPath).catch(() => undefined);
            if (lockStat) {
              const stale = await isLockStale(fullPath, staleLockMs);
              if (stale) {
                freedBytes += lockStat.size;
                staleLocksRemoved.push(relPath);
                if (!dryRun) {
                  await rm(fullPath, { force: true });
                }
              }
            }
          }
        }
      }
    } catch {
      // Directory might not exist
    }
  }

  await scanReasoningDir(reasoningDir, ".reasoning");

  const totalFilesRemoved =
    stagingFilesRemoved.length +
    orphanSegmentsRemoved.length +
    staleLocksRemoved.length;

  return {
    projectRoot: absoluteRoot,
    dryRun,
    stagingFilesRemoved: stagingFilesRemoved.sort(),
    orphanSegmentsRemoved: orphanSegmentsRemoved.sort(),
    staleLocksRemoved: staleLocksRemoved.sort(),
    totalFilesRemoved,
    freedBytes,
  };
}
