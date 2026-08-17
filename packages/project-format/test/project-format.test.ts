import { describe, expect, it } from "vitest";

import {
  ActorSchema,
  ArtifactReferenceSchema,
  CURRENT_FORMAT_VERSION,
  EventSchema,
  ObjectEnvelopeSchema,
  ProjectManifestSchema,
  Sha256DigestSchema,
  UtcTimestampSchema,
  canonicalJson,
  computeContentHash,
  computeEventHash,
  createEvent,
  createId,
  createIdFactory,
  createObjectVersion,
  isUtcTimestamp,
  parseKnownEvent,
  sha256Digest,
  timestampFromId,
  utcNow,
  verifyContentHash,
  verifyEventHash,
  withEventHash,
  type Actor,
  type CanonicalId,
} from "../src/index.js";

const TEST_TIME = Date.parse("2026-08-14T00:00:00.000Z");

function id(prefix: string, offset = 0): CanonicalId {
  return createId(prefix, TEST_TIME + offset);
}

function actor(): Actor {
  return ActorSchema.parse({ actorType: "human", actorId: id("usr") });
}

describe("time-sortable canonical IDs", () => {
  it("issues opaque monotonic IDs and exposes their timestamp", () => {
    const factory = createIdFactory({
      now: () => TEST_TIME,
      random: (size) => new Uint8Array(size),
    });
    const first = factory.create("evt");
    const second = factory.create("evt");
    const afterClockRollback = factory.create("evt", TEST_TIME - 1_000);

    expect(first).toMatch(/^evt_[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
    expect([first, second, afterClockRollback]).toEqual(
      [...[first, second, afterClockRollback]].sort(),
    );
    expect(timestampFromId(first)).toBe(TEST_TIME);
  });

  it("rejects semantic data disguised as an ID prefix", () => {
    const factory = createIdFactory({ random: (size) => new Uint8Array(size) });
    expect(() => factory.create("OpenAI/claim", TEST_TIME)).toThrow(/prefix/i);
  });
});

describe("UTC timestamps", () => {
  it("accepts only valid UTC calendar instants", () => {
    expect(UtcTimestampSchema.parse("2026-08-14T00:00:00Z")).toBe(
      "2026-08-14T00:00:00Z",
    );
    expect(isUtcTimestamp("2026-08-14T00:00:00.123Z")).toBe(true);
    expect(isUtcTimestamp("2026-08-14T06:00:00+06:00")).toBe(false);
    expect(isUtcTimestamp("2026-02-30T00:00:00Z")).toBe(false);
    expect(utcNow(TEST_TIME)).toBe("2026-08-14T00:00:00.000Z");
  });

  it("rejects malformed, impossible, offset, and non-canonical timestamps", () => {
    for (const timestamp of [
      "2026-02-30T00:00:00Z",
      "2026-08-14T06:00:00+06:00",
      "2026-08-14T00:00:00.12Z",
      "2026-08-14 00:00:00Z",
    ]) {
      expect(UtcTimestampSchema.safeParse(timestamp).success, timestamp).toBe(false);
    }
  });
});

describe("canonical JSON and hashing", () => {
  it("sorts keys recursively without mutating the value", () => {
    const value = { z: 1, a: { d: 4, b: 2 }, list: [{ y: true, x: null }] };
    expect(canonicalJson(value)).toBe(
      '{"a":{"b":2,"d":4},"list":[{"x":null,"y":true}],"z":1}',
    );
    expect(Object.keys(value)).toEqual(["z", "a", "list"]);
  });

  it("rejects values outside the JSON data model", () => {
    expect(() => canonicalJson({ missing: undefined })).toThrow(/undefined/);
    expect(() => canonicalJson({ invalid: Number.NaN })).toThrow(/non-finite/);
    expect(() => canonicalJson(new Date())).toThrow(/plain objects/);
  });

  it("produces stable prefixed SHA-256 digests", () => {
    expect(sha256Digest("abc")).toBe(
      "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    const digest = computeContentHash({ b: 2, a: 1 });
    expect(digest).toBe(computeContentHash({ a: 1, b: 2 }));
    expect(digest).not.toBe(computeContentHash({ a: 1, b: 3 }));
    expect(verifyContentHash({ a: 1, b: 2 }, digest)).toBe(true);
  });

  it("rejects malformed SHA-256 digests", () => {
    for (const digest of [
      `sha256:${"a".repeat(63)}`,
      `sha256:${"A".repeat(64)}`,
      `sha512:${"a".repeat(64)}`,
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    ]) {
      expect(Sha256DigestSchema.safeParse(digest).success, digest).toBe(false);
    }
  });
});

describe("canonical schemas", () => {
  it("preserves namespaced manifest extensions during round-trip", () => {
    const manifest = ProjectManifestSchema.parse({
      format: "reasoning-project",
      formatVersion: CURRENT_FORMAT_VERSION,
      projectId: id("prj"),
      title: "Portable investigation",
      createdAt: "2026-08-14T00:00:00Z",
      defaultBranchId: id("br"),
      eventSegments: ["events/00000001-00000042.jsonl"],
      hashAlgorithm: "sha256",
      "org.example/import": { originalRevision: 7 },
    });
    const reopened = ProjectManifestSchema.parse(JSON.parse(JSON.stringify(manifest)));
    expect(reopened["org.example/import"]).toEqual({ originalRevision: 7 });
  });

  it("rejects a manifest from an unsupported major format version", () => {
    const result = ProjectManifestSchema.safeParse({
      format: "reasoning-project",
      formatVersion: "1.0.0",
      projectId: id("prj"),
      title: "Future project",
      createdAt: "2026-08-14T00:00:00Z",
      defaultBranchId: id("br"),
      eventSegments: [],
      hashAlgorithm: "sha256",
    });
    expect(result.success).toBe(false);
  });

  it("creates immutable object versions whose content hash is verifiable", () => {
    const object = createObjectVersion({
      objectType: "claim",
      branchId: id("br"),
      createdBy: actor(),
      createdAt: "2026-08-14T00:00:00Z",
      content: {
        statement: "Every finite counterexample was checked",
        "org.example/checker": { cases: 128 },
      },
    });
    expect(ObjectEnvelopeSchema.parse(object)).toEqual(object);
    expect(verifyContentHash(object.content, object.contentHash)).toBe(true);
  });

  it("preserves namespaced object-envelope extensions during round-trip", () => {
    const object = createObjectVersion({
      objectType: "claim",
      branchId: id("br"),
      createdBy: actor(),
      createdAt: "2026-08-14T00:00:00Z",
      content: { statement: "A portable claim" },
    });
    const extended = ObjectEnvelopeSchema.parse({
      ...object,
      "org.example/import": { originalObjectId: "legacy-claim-7" },
    });
    const reopened = ObjectEnvelopeSchema.parse(JSON.parse(JSON.stringify(extended)));
    expect(reopened["org.example/import"]).toEqual({
      originalObjectId: "legacy-claim-7",
    });
  });

  it("requires artifact lineage and reproducibility declarations", () => {
    const artifact = ArtifactReferenceSchema.parse({
      artifactId: id("art"),
      digest: sha256Digest("result"),
      mediaType: "application/json",
      size: 6,
      logicalName: "result.json",
      producedByRunId: id("run"),
      environmentId: id("env"),
      inputs: [sha256Digest("input")],
      reproducibility: "deterministic",
    });
    expect(artifact.reproducibility).toBe("deterministic");
    expect(
      ArtifactReferenceSchema.safeParse({ ...artifact, environmentId: undefined }).success,
    ).toBe(false);
  });

  it("emits Draft 2020-12 JSON Schema with required portable fields", () => {
    const jsonSchema = ProjectManifestSchema.toJSONSchema({ target: "draft-2020-12" });
    expect(jsonSchema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(jsonSchema.required).toContain("projectId");
    expect(jsonSchema.required).toContain("eventSegments");
  });
});

describe("open event envelope", () => {
  it("builds and verifies a known event without requiring a branch at initialization", () => {
    const event = createEvent({
      sequence: 1,
      eventId: id("evt"),
      eventType: "ProjectInitialized",
      occurredAt: "2026-08-14T00:00:00Z",
      projectId: id("prj"),
      actor: actor(),
      payload: {
        title: "Test project",
        formatVersion: CURRENT_FORMAT_VERSION,
        defaultBranchId: id("br"),
      },
    });
    expect(event.branchId).toBeUndefined();
    expect(verifyEventHash(event)).toBe(true);
    expect(computeEventHash(event)).toBe(event.eventHash);
    expect(verifyEventHash({ ...event, sequence: 2 })).toBe(false);
  });

  it("validates known payloads but preserves unknown future event types and fields", () => {
    const initial = createEvent({
      sequence: 2,
      eventId: id("evt", 1),
      eventType: "FutureVerifierReported",
      occurredAt: "2026-08-14T00:00:01Z",
      projectId: id("prj", 1),
      branchId: id("br", 1),
      actor: actor(),
      payload: { "org.example/result": { status: "inconclusive" } },
    });
    const extended = withEventHash({
      ...initial,
      "org.example/transport": { source: "offline-import" },
    });
    const reopened = EventSchema.parse(JSON.parse(JSON.stringify(extended)));
    expect(reopened["org.example/transport"]).toEqual({ source: "offline-import" });
    expect(reopened.payload).toEqual(initial.payload);
    expect(verifyEventHash(reopened)).toBe(true);

    const invalidKnown = withEventHash({
      ...initial,
      eventType: "BranchCreated",
      payload: {},
    });
    expect(EventSchema.safeParse(invalidKnown).success).toBe(false);
  });

  it("preserves namespaced fields on a typed event and payload during round-trip", () => {
    const event = withEventHash({
      sequence: 3,
      eventId: id("evt", 2),
      eventType: "BranchCreated",
      occurredAt: "2026-08-14T00:00:02Z",
      projectId: id("prj", 2),
      branchId: id("br", 2),
      actor: actor(),
      schemaVersion: 1,
      payload: {
        branchId: id("br", 3),
        name: "portable-branch",
        "org.example/import": { sourceBranch: "legacy-main" },
      },
      "org.example/transport": { source: "offline-import" },
    });
    const parsed = EventSchema.parse(event);
    const reopened = EventSchema.parse(JSON.parse(JSON.stringify(parsed)));

    expect(reopened["org.example/transport"]).toEqual({ source: "offline-import" });
    expect(reopened.payload["org.example/import"]).toEqual({
      sourceBranch: "legacy-main",
    });
    expect(verifyEventHash(reopened)).toBe(true);
  });

  it("validates and hashes a typed MigrationApplied event", () => {
    const event = createEvent({
      sequence: 4,
      eventId: id("evt", 4),
      eventType: "MigrationApplied",
      occurredAt: "2026-08-14T00:00:04Z",
      projectId: id("prj", 4),
      actor: actor(),
      payload: {
        migrationId: id("mig", 4),
        fromFormatVersion: "0.0.0",
        toFormatVersion: CURRENT_FORMAT_VERSION,
      },
    });

    expect(EventSchema.parse(event)).toEqual(event);
    expect(parseKnownEvent(event)).toMatchObject({
      eventType: "MigrationApplied",
      payload: {
        migrationId: expect.stringMatching(/^mig_/),
        fromFormatVersion: "0.0.0",
        toFormatVersion: CURRENT_FORMAT_VERSION,
      },
    });
    expect(verifyEventHash(event)).toBe(true);

    const malformed = withEventHash({
      ...event,
      payload: { migrationId: id("mig", 5), fromFormatVersion: "0.0.0" },
    });
    expect(EventSchema.safeParse(malformed).success).toBe(false);
  });
});
