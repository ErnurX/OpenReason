import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ArtifactCorruptionError,
  ArtifactNotFoundError,
  FileSystemArtifactStore,
  InvalidArtifactDigestError,
  normalizeSha256Digest,
  sha256Digest,
} from "./cas.js";

describe("FileSystemArtifactStore", () => {
  let projectRoot: string;
  let store: FileSystemArtifactStore;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "reasoning-workbench-cas-"));
    store = new FileSystemArtifactStore(projectRoot);
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it("stores, locates, verifies, and reads bytes by their SHA-256 digest", async () => {
    const bytes = new TextEncoder().encode("reasoning-workbench\n");
    const stored = await store.putBytes(bytes);
    const hexadecimalDigest = stored.digest.slice("sha256:".length);

    expect(stored).toMatchObject({
      digest: sha256Digest(bytes),
      algorithm: "sha256",
      size: bytes.byteLength,
      relativePath: `artifacts/sha256/${hexadecimalDigest.slice(0, 2)}/${hexadecimalDigest}`,
      alreadyPresent: false,
    });
    expect(store.pathForDigest(stored.digest)).toBe(stored.path);
    await expect(store.exists(stored.digest)).resolves.toBe(true);
    await expect(store.read(stored.digest)).resolves.toEqual(bytes);
    await expect(store.get(stored.digest)).resolves.toEqual(bytes);
    await expect(store.verify(stored.digest)).resolves.toMatchObject({
      digest: stored.digest,
      exists: true,
      valid: true,
      size: bytes.byteLength,
      actualDigest: stored.digest,
    });
  });

  it("deduplicates repeated puts without creating a second blob", async () => {
    const bytes = new TextEncoder().encode("same immutable bytes");
    const first = await store.putBytes(bytes);
    const second = await store.putBytes(bytes);

    expect(first.alreadyPresent).toBe(false);
    expect(second).toMatchObject({
      digest: first.digest,
      path: first.path,
      size: first.size,
      alreadyPresent: true,
    });
    await expect(store.list()).resolves.toHaveLength(1);
    await expect(store.verifyAll()).resolves.toMatchObject({
      ok: true,
      invalidEntries: [],
    });
  });

  it("detects corruption and never silently replaces corrupt accepted bytes", async () => {
    const original = new TextEncoder().encode("original artifact");
    const stored = await store.putBytes(original);
    await writeFile(stored.path, "tampered artifact");

    const verification = await store.verify(stored.digest);
    expect(verification).toMatchObject({
      digest: stored.digest,
      exists: true,
      valid: false,
      failure: "digest-mismatch",
    });
    expect(verification.actualDigest).not.toBe(stored.digest);
    await expect(store.read(stored.digest)).rejects.toBeInstanceOf(
      ArtifactCorruptionError,
    );
    await expect(store.putBytes(original)).rejects.toBeInstanceOf(
      ArtifactCorruptionError,
    );
    await expect(store.verifyAll()).resolves.toMatchObject({ ok: false });
  });

  it("normalizes hexadecimal case but rejects malformed or bare digests", async () => {
    const uppercase = `sha256:${"AB".repeat(32)}`;
    expect(normalizeSha256Digest(uppercase)).toBe(`sha256:${"ab".repeat(32)}`);

    for (const invalid of [
      "",
      "sha1:" + "a".repeat(64),
      "a".repeat(64),
      "sha256:abc",
      "sha256:" + "z".repeat(64),
      " sha256:" + "a".repeat(64),
    ]) {
      expect(() => normalizeSha256Digest(invalid)).toThrow(
        InvalidArtifactDigestError,
      );
      await expect(store.exists(invalid)).rejects.toBeInstanceOf(
        InvalidArtifactDigestError,
      );
    }

    const missing = `sha256:${"0".repeat(64)}`;
    await expect(store.read(missing)).rejects.toBeInstanceOf(
      ArtifactNotFoundError,
    );
    await expect(store.verify(missing)).resolves.toMatchObject({
      exists: false,
      valid: false,
      failure: "missing",
    });
  });

  it("streams a large file, keeps the source, and reports invalid CAS entries", async () => {
    const sourceDirectory = join(projectRoot, "source-inputs");
    const sourcePath = join(sourceDirectory, "dataset.bin");
    await mkdir(sourceDirectory, { recursive: true });

    const bytes = Buffer.allocUnsafe(5 * 1024 * 1024 + 137);
    for (let offset = 0; offset < bytes.length; offset += 1) {
      bytes[offset] = (offset * 31 + 17) % 251;
    }
    await writeFile(sourcePath, bytes);

    const stored = await store.putFile(sourcePath);
    const expectedDigest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    expect(stored).toMatchObject({
      digest: expectedDigest,
      size: bytes.byteLength,
      alreadyPresent: false,
    });
    await expect(store.putFile(sourcePath)).resolves.toMatchObject({
      digest: expectedDigest,
      alreadyPresent: true,
    });
    await expect(store.verify(stored.digest)).resolves.toMatchObject({
      valid: true,
      size: bytes.byteLength,
    });

    await writeFile(join(store.baseDirectory, "unexpected-entry"), "not a blob");
    const inventory = await store.listWithInvalidEntries();
    expect(inventory.artifacts).toHaveLength(1);
    expect(inventory.invalidEntries).toEqual([
      "artifacts/sha256/unexpected-entry",
    ]);
    await expect(store.verifyAll()).resolves.toMatchObject({
      ok: false,
      invalidEntries: ["artifacts/sha256/unexpected-entry"],
    });
  });
});
