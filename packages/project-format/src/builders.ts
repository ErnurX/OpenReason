import type { Actor, Event, ObjectEnvelope } from "./schemas.js";
import { EventDraftSchema, EventSchema, ObjectEnvelopeSchema } from "./schemas.js";
import type { ObjectType } from "./constants.js";
import { computeContentHash, withEventHash } from "./hashing.js";
import { createId, createObjectId, type CanonicalId } from "./ids.js";
import type { JsonValue } from "./json.js";
import { utcNow, type UtcTimestamp } from "./time.js";

export interface CreateEventInput {
  readonly sequence: number;
  readonly eventType: string;
  readonly projectId: CanonicalId;
  readonly branchId?: CanonicalId;
  readonly actor: Actor;
  readonly payload: Record<string, JsonValue>;
  readonly causationId?: CanonicalId;
  readonly correlationId?: CanonicalId;
  readonly previousEventHash?: `sha256:${string}`;
  readonly eventId?: CanonicalId;
  readonly occurredAt?: UtcTimestamp;
  readonly schemaVersion?: number;
}

/** Build, normalize, validate, and hash a canonical event in one operation. */
export function createEvent(input: CreateEventInput): Event {
  const candidate = {
    sequence: input.sequence,
    eventId: input.eventId ?? createId("evt"),
    eventType: input.eventType,
    occurredAt: input.occurredAt ?? utcNow(),
    projectId: input.projectId,
    actor: input.actor,
    schemaVersion: input.schemaVersion ?? 1,
    payload: input.payload,
    ...(input.branchId === undefined ? {} : { branchId: input.branchId }),
    ...(input.causationId === undefined ? {} : { causationId: input.causationId }),
    ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }),
    ...(input.previousEventHash === undefined
      ? {}
      : { previousEventHash: input.previousEventHash }),
  };
  const normalized = EventDraftSchema.parse(candidate);
  const { eventHash: _discarded, ...unhashed } = normalized;
  return EventSchema.parse(withEventHash(unhashed));
}

export interface CreateObjectVersionInput {
  readonly objectType: ObjectType;
  readonly branchId: CanonicalId;
  readonly createdBy: Actor;
  readonly content: Record<string, JsonValue>;
  readonly objectId?: CanonicalId;
  readonly versionId?: CanonicalId;
  readonly version?: number;
  readonly createdAt?: UtcTimestamp;
  readonly supersedesVersionId?: CanonicalId;
}

/** Build an immutable object envelope whose hash covers only its content. */
export function createObjectVersion(input: CreateObjectVersionInput): ObjectEnvelope {
  const candidate = {
    objectId: input.objectId ?? createObjectId(input.objectType),
    objectType: input.objectType,
    versionId: input.versionId ?? createId("ver"),
    version: input.version ?? 1,
    createdAt: input.createdAt ?? utcNow(),
    createdBy: input.createdBy,
    branchId: input.branchId,
    content: input.content,
    contentHash: computeContentHash(input.content),
    ...(input.supersedesVersionId === undefined
      ? {}
      : { supersedesVersionId: input.supersedesVersionId }),
  };
  return ObjectEnvelopeSchema.parse(candidate);
}

