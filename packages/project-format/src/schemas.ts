import { z } from "zod";

export { z };

import {
  ACTOR_TYPES,
  CURRENT_FORMAT_VERSION,
  EDGE_TYPES,
  HASH_ALGORITHM,
  KNOWN_EVENT_TYPES,
  OBJECT_TYPES,
  PROJECT_FORMAT,
  REPRODUCIBILITY_KINDS,
  type KnownEventType,
} from "./constants.js";
import {
  ArtifactIdSchema,
  BranchIdSchema,
  CanonicalIdSchema,
  ContextIdSchema,
  EdgeIdSchema,
  EnvironmentIdSchema,
  EventIdSchema,
  JobIdSchema,
  MigrationIdSchema,
  ProjectIdSchema,
  RunIdSchema,
  VersionIdSchema,
} from "./ids.js";
import { UtcTimestampSchema } from "./time.js";

export const JsonValueSchema = z.json();
export const JsonObjectSchema = z.record(z.string(), JsonValueSchema);

export const Sha256DigestSchema = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/, "Expected a lowercase sha256 digest");
export const sha256DigestSchema = Sha256DigestSchema;

export const FormatVersionSchema = z
  .string()
  .regex(
    /^0\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/,
    "Unsupported or invalid project format version",
  );

export const ActorSchema = z.looseObject({
  actorType: z.enum(ACTOR_TYPES),
  actorId: CanonicalIdSchema,
});
export const actorSchema = ActorSchema;
export type Actor = z.infer<typeof ActorSchema>;

export const ProjectManifestSchema = z.looseObject({
  format: z.literal(PROJECT_FORMAT),
  formatVersion: FormatVersionSchema,
  projectId: ProjectIdSchema,
  title: z.string().trim().min(1),
  createdAt: UtcTimestampSchema,
  defaultBranchId: BranchIdSchema,
  eventSegments: z.array(
    z.string().regex(
      /^events\/[0-9]{8,16}-[0-9]{8,16}\.jsonl$/,
      "Event segments must be canonical project-relative JSONL paths",
    ),
  ),
  hashAlgorithm: z.literal(HASH_ALGORITHM),
});
export const projectManifestSchema = ProjectManifestSchema;
export type ProjectManifest = z.infer<typeof ProjectManifestSchema>;

export const ObjectTypeSchema = z.enum(OBJECT_TYPES);

export const ObjectEnvelopeSchema = z.looseObject({
  objectId: CanonicalIdSchema,
  objectType: ObjectTypeSchema,
  versionId: VersionIdSchema,
  version: z.number().int().positive(),
  createdAt: UtcTimestampSchema,
  createdBy: ActorSchema,
  branchId: BranchIdSchema,
  content: JsonObjectSchema,
  contentHash: Sha256DigestSchema,
  supersedesVersionId: VersionIdSchema.optional(),
});
export const objectEnvelopeSchema = ObjectEnvelopeSchema;
export type ObjectEnvelope = z.infer<typeof ObjectEnvelopeSchema>;

export const EdgeTypeSchema = z.enum(EDGE_TYPES);

export const ObjectVersionReferenceSchema = z.looseObject({
  objectId: CanonicalIdSchema,
  versionId: VersionIdSchema,
});
export type ObjectVersionReference = z.infer<typeof ObjectVersionReferenceSchema>;

export const EdgeEnvelopeSchema = z.looseObject({
  edgeId: EdgeIdSchema,
  edgeType: EdgeTypeSchema,
  from: ObjectVersionReferenceSchema,
  to: ObjectVersionReferenceSchema,
  // Structural edges (for example workstream -> goal) need not have a
  // mathematical context. Policies can require one for claim-bearing edges.
  contextId: ContextIdSchema.optional(),
  createdAt: UtcTimestampSchema,
  createdBy: ActorSchema,
  metadata: JsonObjectSchema,
});
export const edgeEnvelopeSchema = EdgeEnvelopeSchema;
export type EdgeEnvelope = z.infer<typeof EdgeEnvelopeSchema>;

export const ArtifactReferenceSchema = z.looseObject({
  artifactId: ArtifactIdSchema,
  digest: Sha256DigestSchema,
  mediaType: z.string().trim().min(1),
  size: z.number().int().nonnegative(),
  logicalName: z.string().trim().min(1),
  producedByRunId: RunIdSchema,
  environmentId: EnvironmentIdSchema,
  inputs: z.array(Sha256DigestSchema),
  reproducibility: z.enum(REPRODUCIBILITY_KINDS),
});
export const artifactReferenceSchema = ArtifactReferenceSchema;
export type ArtifactReference = z.infer<typeof ArtifactReferenceSchema>;

export const ProjectInitializedPayloadSchema = z.looseObject({
  title: z.string().trim().min(1),
  formatVersion: FormatVersionSchema.default(CURRENT_FORMAT_VERSION),
  defaultBranchId: BranchIdSchema,
  // Optional for forward compatibility with the first v0 writers. New writers
  // include it so a projection can reproduce the manifest timestamp exactly.
  createdAt: UtcTimestampSchema.optional(),
});
export type ProjectInitializedPayload = z.infer<typeof ProjectInitializedPayloadSchema>;

export const BranchCreatedPayloadSchema = z.looseObject({
  branchId: BranchIdSchema,
  name: z.string().trim().min(1),
  baseBranchId: BranchIdSchema.optional(),
});
export type BranchCreatedPayload = z.infer<typeof BranchCreatedPayloadSchema>;

export const ObjectVersionCreatedPayloadSchema = z.looseObject({
  object: ObjectEnvelopeSchema,
});
export type ObjectVersionCreatedPayload = z.infer<typeof ObjectVersionCreatedPayloadSchema>;

export const EdgeCreatedPayloadSchema = z.looseObject({
  edge: EdgeEnvelopeSchema,
});
export type EdgeCreatedPayload = z.infer<typeof EdgeCreatedPayloadSchema>;

export const ArtifactRegisteredPayloadSchema = z.looseObject({
  artifact: ArtifactReferenceSchema,
});
export type ArtifactRegisteredPayload = z.infer<typeof ArtifactRegisteredPayloadSchema>;

export const BranchMergedPayloadSchema = z.looseObject({
  mergeId: CanonicalIdSchema,
  sourceBranchId: BranchIdSchema,
  targetBranchId: BranchIdSchema,
  baseSequence: z.number().int().nonnegative(),
  sourceHeadSequence: z.number().int().positive(),
  targetHeadSequenceBefore: z.number().int().positive(),
  strategy: z.literal("safe"),
  status: z.enum(["merged", "conflicted"]),
  appliedObjectVersionIds: z.array(VersionIdSchema),
  adoptedEdgeIds: z.array(EdgeIdSchema),
  conflictObjectIds: z.array(CanonicalIdSchema),
});
export type BranchMergedPayload = z.infer<typeof BranchMergedPayloadSchema>;

export const MigrationAppliedPayloadSchema = z.looseObject({
  migrationId: MigrationIdSchema,
  fromFormatVersion: FormatVersionSchema,
  toFormatVersion: FormatVersionSchema,
});
export type MigrationAppliedPayload = z.infer<typeof MigrationAppliedPayloadSchema>;

export const KnownEventTypeSchema = z.enum(KNOWN_EVENT_TYPES);

export const KnownEventPayloadSchemas = {
  ProjectInitialized: ProjectInitializedPayloadSchema,
  BranchCreated: BranchCreatedPayloadSchema,
  ObjectVersionCreated: ObjectVersionCreatedPayloadSchema,
  EdgeCreated: EdgeCreatedPayloadSchema,
  ArtifactRegistered: ArtifactRegisteredPayloadSchema,
  BranchMerged: BranchMergedPayloadSchema,
  MigrationApplied: MigrationAppliedPayloadSchema,
} as const satisfies Record<KnownEventType, z.ZodType>;

const EventEnvelopeShape = {
  sequence: z.number().int().positive(),
  eventId: EventIdSchema,
  eventType: z.string().trim().min(1),
  occurredAt: UtcTimestampSchema,
  projectId: ProjectIdSchema,
  // ProjectInitialized has no branch yet. Other event kinds normally include
  // this field; event-specific business logic may require it.
  branchId: BranchIdSchema.optional(),
  actor: ActorSchema,
  causationId: EventIdSchema.optional(),
  correlationId: JobIdSchema.optional(),
  previousEventHash: Sha256DigestSchema.optional(),
  schemaVersion: z.number().int().positive(),
  payload: JsonObjectSchema,
  eventHash: Sha256DigestSchema,
} as const;

const EventDraftShape = {
  ...EventEnvelopeShape,
  eventHash: Sha256DigestSchema.optional(),
};

function isKnownEventType(value: string): value is KnownEventType {
  return (KNOWN_EVENT_TYPES as readonly string[]).includes(value);
}

/**
 * The open envelope accepts unknown event types and preserves their fields.
 * Payloads of known Stage-1 events receive their stricter typed validation.
 */
export const EventSchema = z.looseObject(EventEnvelopeShape).superRefine((event, context) => {
  if (!isKnownEventType(event.eventType)) return;
  const result = KnownEventPayloadSchemas[event.eventType].safeParse(event.payload);
  if (!result.success) {
    context.addIssue({
      code: "custom",
      path: ["payload"],
      message: `Invalid ${event.eventType} payload: ${z.prettifyError(result.error)}`,
    });
  }
});
export const eventSchema = EventSchema;
export type Event = z.infer<typeof EventSchema>;

export const EventDraftSchema = z.looseObject(EventDraftShape).superRefine((event, context) => {
  if (!isKnownEventType(event.eventType)) return;
  const result = KnownEventPayloadSchemas[event.eventType].safeParse(event.payload);
  if (!result.success) {
    context.addIssue({
      code: "custom",
      path: ["payload"],
      message: `Invalid ${event.eventType} payload: ${z.prettifyError(result.error)}`,
    });
  }
});
export type EventDraft = z.infer<typeof EventDraftSchema>;

function eventVariant<T extends KnownEventType>(
  eventType: T,
  payload: (typeof KnownEventPayloadSchemas)[T],
) {
  return z.looseObject({
    ...EventEnvelopeShape,
    eventType: z.literal(eventType),
    payload,
  });
}

export const KnownEventSchema = z.discriminatedUnion("eventType", [
  eventVariant("ProjectInitialized", ProjectInitializedPayloadSchema),
  eventVariant("BranchCreated", BranchCreatedPayloadSchema),
  eventVariant("ObjectVersionCreated", ObjectVersionCreatedPayloadSchema),
  eventVariant("EdgeCreated", EdgeCreatedPayloadSchema),
  eventVariant("ArtifactRegistered", ArtifactRegisteredPayloadSchema),
  eventVariant("BranchMerged", BranchMergedPayloadSchema),
  eventVariant("MigrationApplied", MigrationAppliedPayloadSchema),
]);
export const knownEventSchema = KnownEventSchema;
export type KnownEvent = z.infer<typeof KnownEventSchema>;

export function parseKnownEvent(event: Event): KnownEvent | undefined {
  const result = KnownEventSchema.safeParse(event);
  return result.success ? result.data : undefined;
}
