import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { join, resolve } from "node:path";

const SHA256_PREFIX = "sha256:";
const SHA256_HEX_LENGTH = 64;
const SHA256_DIGEST_PATTERN = /^sha256:([0-9a-fA-F]{64})$/;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const SHA256_DIRECTORY_PATTERN = /^[0-9a-f]{2}$/;

export type Sha256Digest = `sha256:${string}`;

export interface StoredArtifact {
  /** Canonical, portable identity of the stored bytes. */
  digest: Sha256Digest;
  algorithm: "sha256";
  size: number;
  /** Project-relative canonical path, always using forward slashes. */
  relativePath: string;
  /** Local path for immediate filesystem use. Never persist this as identity. */
  path: string;
  /** True when an already valid blob satisfied this write. */
  alreadyPresent: boolean;
}

export type ArtifactVerificationFailure =
  | "missing"
  | "not-a-regular-file"
  | "digest-mismatch"
  | "unreadable";

export interface ArtifactVerification {
  digest: Sha256Digest;
  relativePath: string;
  path: string;
  exists: boolean;
  valid: boolean;
  size?: number;
  actualDigest?: Sha256Digest;
  failure?: ArtifactVerificationFailure;
  error?: string;
}

export interface ArtifactListResult {
  artifacts: StoredArtifact[];
  /** Entries below artifacts/sha256 that do not form valid CAS addresses. */
  invalidEntries: string[];
}

export interface ArtifactStoreVerificationReport {
  ok: boolean;
  artifacts: ArtifactVerification[];
  invalidEntries: string[];
}

export class InvalidArtifactDigestError extends TypeError {
  constructor(digest: string) {
    super(
      `Invalid SHA-256 artifact digest ${JSON.stringify(digest)}; expected sha256:<64 hexadecimal characters>`,
    );
    this.name = "InvalidArtifactDigestError";
  }
}

export class ArtifactNotFoundError extends Error {
  readonly digest: Sha256Digest;

  constructor(digest: Sha256Digest) {
    super(`Artifact ${digest} does not exist`);
    this.name = "ArtifactNotFoundError";
    this.digest = digest;
  }
}

export class ArtifactCorruptionError extends Error {
  readonly digest: Sha256Digest;
  readonly verification: ArtifactVerification;

  constructor(verification: ArtifactVerification) {
    super(
      `Artifact ${verification.digest} failed verification: ${verification.failure ?? "unknown failure"}`,
    );
    this.name = "ArtifactCorruptionError";
    this.digest = verification.digest;
    this.verification = verification;
  }
}

/**
 * Normalize a public artifact digest without accepting ambiguous bare hashes.
 */
export function normalizeSha256Digest(digest: string): Sha256Digest {
  const match = SHA256_DIGEST_PATTERN.exec(digest);
  if (match === null) {
    throw new InvalidArtifactDigestError(digest);
  }

  return `${SHA256_PREFIX}${match[1]!.toLowerCase()}`;
}

export function sha256Digest(bytes: Uint8Array): Sha256Digest {
  return `${SHA256_PREFIX}${createHash("sha256").update(bytes).digest("hex")}`;
}

/**
 * Filesystem-backed, immutable content-addressed storage.
 *
 * This layer stores bytes and returns a storage receipt. It deliberately does
 * not fabricate an Artifact project object: provenance, producing run, media
 * type, and logical name belong in the separately versioned Artifact record.
 */
export class FileSystemArtifactStore {
  readonly projectRoot: string;
  readonly baseDirectory: string;
  readonly stagingDirectory: string;

  constructor(projectRoot: string) {
    this.projectRoot = resolve(projectRoot);
    this.baseDirectory = join(this.projectRoot, "artifacts", "sha256");
    this.stagingDirectory = join(this.baseDirectory, ".tmp");
  }

  async putBytes(bytes: Uint8Array): Promise<StoredArtifact> {
    const digest = sha256Digest(bytes);
    await this.ensureStagingDirectory();
    const temporaryPath = this.newTemporaryPath();
    const handle = await open(temporaryPath, "wx", 0o600);

    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => undefined);
      await unlinkIfPresent(temporaryPath);
      throw error;
    }

    await handle.close();

    try {
      return await this.publishTemporaryFile(temporaryPath, digest, bytes.byteLength);
    } catch (error) {
      await unlinkIfPresent(temporaryPath);
      throw error;
    }
  }

  /**
   * Stream a file into the store so large artifacts need not be buffered in
   * memory. The source file is never moved or modified.
   */
  async putFile(sourcePath: string): Promise<StoredArtifact> {
    await this.ensureStagingDirectory();
    const temporaryPath = this.newTemporaryPath();
    const destinationHandle = await open(temporaryPath, "wx", 0o600);
    const hash = createHash("sha256");
    let size = 0;

    try {
      for await (const chunk of createReadStream(sourcePath)) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        hash.update(bytes);
        size += bytes.byteLength;
        await writeAll(destinationHandle, bytes);
      }
      await destinationHandle.sync();
    } catch (error) {
      await destinationHandle.close().catch(() => undefined);
      await unlinkIfPresent(temporaryPath);
      throw error;
    }

    await destinationHandle.close();
    const digest = `${SHA256_PREFIX}${hash.digest("hex")}` as Sha256Digest;

    try {
      return await this.publishTemporaryFile(temporaryPath, digest, size);
    } catch (error) {
      await unlinkIfPresent(temporaryPath);
      throw error;
    }
  }

  async read(digestInput: string): Promise<Uint8Array> {
    const digest = normalizeSha256Digest(digestInput);
    const path = this.pathForDigest(digest);

    let bytes: Buffer;
    try {
      const entry = await lstat(path);
      if (!entry.isFile()) {
        throw new ArtifactCorruptionError(
          this.failedVerification(digest, "not-a-regular-file"),
        );
      }
      bytes = await readFile(path);
    } catch (error) {
      if (error instanceof ArtifactCorruptionError) {
        throw error;
      }
      if (isErrno(error, "ENOENT")) {
        throw new ArtifactNotFoundError(digest);
      }
      throw error;
    }

    const actualDigest = sha256Digest(bytes);
    if (actualDigest !== digest) {
      throw new ArtifactCorruptionError({
        digest,
        relativePath: relativePathForDigest(digest),
        path,
        exists: true,
        valid: false,
        size: bytes.byteLength,
        actualDigest,
        failure: "digest-mismatch",
      });
    }

    // Avoid leaking Node's Buffer subclass through the portable byte API.
    return new Uint8Array(bytes);
  }

  async get(digest: string): Promise<Uint8Array> {
    return this.read(digest);
  }

  async exists(digestInput: string): Promise<boolean> {
    const digest = normalizeSha256Digest(digestInput);
    try {
      await lstat(this.pathForDigest(digest));
      return true;
    } catch (error) {
      if (isErrno(error, "ENOENT")) {
        return false;
      }
      throw error;
    }
  }

  async verify(digestInput: string): Promise<ArtifactVerification> {
    const digest = normalizeSha256Digest(digestInput);
    const path = this.pathForDigest(digest);

    try {
      const entry = await lstat(path);
      if (!entry.isFile()) {
        return this.failedVerification(digest, "not-a-regular-file");
      }

      const { digest: actualDigest, size } = await hashFile(path);
      if (actualDigest !== digest) {
        return {
          digest,
          relativePath: relativePathForDigest(digest),
          path,
          exists: true,
          valid: false,
          size,
          actualDigest,
          failure: "digest-mismatch",
        };
      }

      return {
        digest,
        relativePath: relativePathForDigest(digest),
        path,
        exists: true,
        valid: true,
        size,
        actualDigest,
      };
    } catch (error) {
      if (isErrno(error, "ENOENT")) {
        return this.failedVerification(digest, "missing");
      }

      return {
        ...this.failedVerification(digest, "unreadable"),
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async list(): Promise<StoredArtifact[]> {
    return (await this.scan()).artifacts;
  }

  async listWithInvalidEntries(): Promise<ArtifactListResult> {
    return this.scan();
  }

  async verifyAll(): Promise<ArtifactStoreVerificationReport> {
    const { artifacts, invalidEntries } = await this.scan();
    const verifications = await Promise.all(
      artifacts.map((artifact) => this.verify(artifact.digest)),
    );

    return {
      ok:
        invalidEntries.length === 0 &&
        verifications.every((verification) => verification.valid),
      artifacts: verifications,
      invalidEntries,
    };
  }

  pathForDigest(digestInput: string): string {
    const digest = normalizeSha256Digest(digestInput);
    const hexadecimalDigest = digest.slice(SHA256_PREFIX.length);
    return join(
      this.baseDirectory,
      hexadecimalDigest.slice(0, 2),
      hexadecimalDigest,
    );
  }

  private async ensureStagingDirectory(): Promise<void> {
    await mkdir(this.stagingDirectory, { recursive: true });
  }

  private newTemporaryPath(): string {
    return join(
      this.stagingDirectory,
      `${process.pid}-${Date.now()}-${randomUUID()}.tmp`,
    );
  }

  private async publishTemporaryFile(
    temporaryPath: string,
    digest: Sha256Digest,
    size: number,
  ): Promise<StoredArtifact> {
    const existing = await this.verify(digest);
    if (existing.exists) {
      if (!existing.valid) {
        throw new ArtifactCorruptionError(existing);
      }
      await unlinkIfPresent(temporaryPath);
      return this.receipt(digest, existing.size ?? size, true);
    }

    const destinationPath = this.pathForDigest(digest);
    const destinationDirectory = join(destinationPath, "..");
    await mkdir(destinationDirectory, { recursive: true });

    try {
      // The staging directory is below the same CAS root, so this publish is an
      // atomic rename on the target filesystem.
      await rename(temporaryPath, destinationPath);
    } catch (error) {
      // Some platforms refuse to replace a concurrently-created destination.
      // If another writer published the same valid bytes, this is idempotent.
      if (isErrno(error, "EEXIST") || isErrno(error, "EPERM")) {
        const raced = await this.verify(digest);
        if (raced.valid) {
          await unlinkIfPresent(temporaryPath);
          return this.receipt(digest, raced.size ?? size, true);
        }
      }
      throw error;
    }

    await syncDirectory(destinationDirectory);
    const published = await this.verify(digest);
    if (!published.valid) {
      throw new ArtifactCorruptionError(published);
    }

    return this.receipt(digest, published.size ?? size, false);
  }

  private receipt(
    digest: Sha256Digest,
    size: number,
    alreadyPresent: boolean,
  ): StoredArtifact {
    return {
      digest,
      algorithm: "sha256",
      size,
      relativePath: relativePathForDigest(digest),
      path: this.pathForDigest(digest),
      alreadyPresent,
    };
  }

  private failedVerification(
    digest: Sha256Digest,
    failure: ArtifactVerificationFailure,
  ): ArtifactVerification {
    return {
      digest,
      relativePath: relativePathForDigest(digest),
      path: this.pathForDigest(digest),
      exists: failure !== "missing",
      valid: false,
      failure,
    };
  }

  private async scan(): Promise<ArtifactListResult> {
    let prefixEntries;
    try {
      prefixEntries = await readdir(this.baseDirectory, { withFileTypes: true });
    } catch (error) {
      if (isErrno(error, "ENOENT")) {
        return { artifacts: [], invalidEntries: [] };
      }
      throw error;
    }

    const artifacts: StoredArtifact[] = [];
    const invalidEntries: string[] = [];

    for (const prefixEntry of prefixEntries) {
      if (prefixEntry.name === ".tmp") {
        // Interrupted writes are unaccepted staging data, not canonical blobs.
        continue;
      }

      const prefixRelativePath = `artifacts/sha256/${prefixEntry.name}`;
      if (
        !prefixEntry.isDirectory() ||
        !SHA256_DIRECTORY_PATTERN.test(prefixEntry.name)
      ) {
        invalidEntries.push(prefixRelativePath);
        continue;
      }

      const prefixPath = join(this.baseDirectory, prefixEntry.name);
      const digestEntries = await readdir(prefixPath, { withFileTypes: true });

      for (const digestEntry of digestEntries) {
        const relativePath = `${prefixRelativePath}/${digestEntry.name}`;
        if (
          !digestEntry.isFile() ||
          !SHA256_HEX_PATTERN.test(digestEntry.name) ||
          !digestEntry.name.startsWith(prefixEntry.name)
        ) {
          invalidEntries.push(relativePath);
          continue;
        }

        const digest = `${SHA256_PREFIX}${digestEntry.name}` as Sha256Digest;
        const entry = await stat(join(prefixPath, digestEntry.name));
        artifacts.push(this.receipt(digest, entry.size, true));
      }
    }

    artifacts.sort((left, right) => left.digest.localeCompare(right.digest));
    invalidEntries.sort();
    return { artifacts, invalidEntries };
  }
}

/** A concise alias for consumers that do not need the backend in the name. */
export { FileSystemArtifactStore as ContentAddressedArtifactStore };

function relativePathForDigest(digest: Sha256Digest): string {
  const hexadecimalDigest = digest.slice(SHA256_PREFIX.length);
  return `artifacts/sha256/${hexadecimalDigest.slice(0, 2)}/${hexadecimalDigest}`;
}

async function hashFile(
  path: string,
): Promise<{ digest: Sha256Digest; size: number }> {
  const hash = createHash("sha256");
  let size = 0;

  for await (const chunk of createReadStream(path)) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    hash.update(bytes);
    size += bytes.byteLength;
  }

  return {
    digest: `${SHA256_PREFIX}${hash.digest("hex")}` as Sha256Digest,
    size,
  };
}

async function writeAll(
  handle: Awaited<ReturnType<typeof open>>,
  bytes: Uint8Array,
): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await handle.write(
      bytes,
      offset,
      bytes.byteLength - offset,
    );
    if (bytesWritten === 0) {
      throw new Error("Could not make progress writing artifact staging file");
    }
    offset += bytesWritten;
  }
}

async function syncDirectory(path: string): Promise<void> {
  const directoryHandle = await open(path, "r");
  try {
    await directoryHandle.sync();
  } finally {
    await directoryHandle.close();
  }
}

async function unlinkIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!isErrno(error, "ENOENT")) {
      throw error;
    }
  }
}

function isErrno(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
