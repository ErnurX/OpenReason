import {
  ActorSchema,
  createEvent,
  createId,
  type Actor,
  type Event,
  type JsonValue,
  type Sha256Digest,
} from "@reasoning-workbench/project-format";

import { appendEvent } from "./event-log.js";
import { MergeConcurrencyError, mergeBranchSafe, type SafeMergeResult } from "./merge.js";
import {
  ProjectConcurrencyError,
  addEdge,
  createBranch,
  ensureProjectionAtHead,
  loadManifest,
  projectHistory,
  putObject,
} from "./project.js";
import { getObjectHistory, listBranches, listCurrentObjects, rebuildProjection } from "./projection.js";

/** Canonical, human project roles. Agents are deliberately not members. */
export const COLLABORATION_ROLES = Object.freeze([
  "owner",
  "researcher",
  "contributor",
  "reviewer",
  "compute-operator",
  "viewer",
] as const);
export type CollaborationRole = (typeof COLLABORATION_ROLES)[number];

export const COLLABORATION_ACTIONS = Object.freeze([
  "project:view",
  "project:manage-members",
  "branch:create",
  "object:write",
  "comment:create",
  "review:request",
  "review:decide",
  "compute:operate",
  "branch:merge",
] as const);
export type CollaborationAction = (typeof COLLABORATION_ACTIONS)[number];

export interface ProjectHead {
  readonly sequence: number;
  readonly eventHash: string;
}

export interface ProjectMembership {
  readonly membershipId: string;
  readonly actor: Actor;
  readonly role: CollaborationRole;
  readonly grantedBy: Actor;
  readonly grantedAt: string;
  readonly grantEventId: string;
  readonly revokedAt?: string;
  readonly revokedBy?: Actor;
  readonly revokeEventId?: string;
}

export interface ObjectVersionAnchor {
  readonly objectId: string;
  readonly versionId: string;
  readonly contentHash: string;
}

export interface CollaborationComment {
  readonly commentId: string;
  readonly branchId: string;
  readonly anchor: ObjectVersionAnchor;
  readonly body: string;
  readonly createdBy: Actor;
  readonly createdAt: string;
  readonly eventId: string;
}

export interface ReviewRequest {
  readonly reviewRequestId: string;
  readonly branchId: string;
  readonly statement: ObjectVersionAnchor;
  readonly evidence: readonly ObjectVersionAnchor[];
  readonly requestedBy: Actor;
  readonly requestedAt: string;
  readonly summary: string;
  readonly eventId: string;
}

export interface ReviewDecision {
  readonly reviewDecisionId: string;
  readonly reviewRequestId: string;
  readonly outcome: "approved" | "rejected";
  readonly reviewer: Actor;
  readonly rationale: string;
  readonly decidedAt: string;
  readonly eventId: string;
}

export interface MergeAuthorization {
  readonly authorizationId: string;
  readonly subject: Actor;
  /** Exact active grant required to consume this authorization. */
  readonly subjectMembershipId: string;
  readonly subjectGrantEventId: string;
  readonly sourceBranchId: string;
  readonly targetBranchId: string;
  readonly sourceHeadSequence: number;
  readonly targetHeadSequence: number;
  readonly decidedBy: Actor;
  /** Exact owner grant that issued this authorization. */
  readonly issuerMembershipId: string;
  readonly issuerGrantEventId: string;
  readonly reason: string;
  readonly decidedAt: string;
  readonly eventId: string;
}

export interface ConsumedMergeAuthorization {
  readonly authorizationId: string;
  readonly mergeId: string;
  readonly sourceBranchId: string;
  readonly targetBranchId: string;
  readonly consumedBy: Actor;
  readonly consumedAt: string;
  readonly eventId: string;
}

export interface ReviewRequestState {
  readonly request: ReviewRequest;
  readonly current: boolean;
  readonly stale: boolean;
  readonly decisions: readonly ReviewDecision[];
}

export interface AuthorizedCollaborationRead {
  readonly actor: Actor;
  readonly membership: ProjectMembership;
  readonly head: ProjectHead;
  readonly memberships: readonly ProjectMembership[];
  readonly comments: readonly CollaborationComment[];
  readonly reviews: readonly ReviewRequestState[];
  readonly mergeAuthorizations: readonly MergeAuthorization[];
}

export class CollaborationAuthorizationError extends Error {}
export class CollaborationConcurrencyError extends Error {}
export class StaleReviewError extends Error {}

const ROLE_PERMISSIONS: Readonly<Record<CollaborationRole, readonly CollaborationAction[]>> = Object.freeze({
  // Merge is deliberately absent: accepted-state merge is a one-shot
  // authorization decision, not a role capability.
  owner: Object.freeze(COLLABORATION_ACTIONS.filter((action) => action !== "branch:merge")),
  researcher: Object.freeze(["project:view", "branch:create", "object:write", "comment:create", "review:request"] as const),
  contributor: Object.freeze(["project:view", "branch:create", "object:write", "comment:create", "review:request"] as const),
  reviewer: Object.freeze(["project:view", "comment:create", "review:decide"] as const),
  "compute-operator": Object.freeze(["project:view", "compute:operate"] as const),
  viewer: Object.freeze(["project:view"] as const),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: Record<string, unknown>, key: string, label: string): string {
  const candidate = value[key];
  if (typeof candidate !== "string" || candidate.trim().length === 0) {
    throw new TypeError(`${label}.${key} must be a non-empty string`);
  }
  return candidate;
}

function role(value: unknown, label: string): CollaborationRole {
  if (typeof value !== "string" || !(COLLABORATION_ROLES as readonly string[]).includes(value)) {
    throw new TypeError(`${label} must be one of ${COLLABORATION_ROLES.join(", ")}`);
  }
  return value as CollaborationRole;
}

function humanActor(value: Actor, label: string): Actor {
  const actor = ActorSchema.parse(value);
  if (actor.actorType !== "human") {
    throw new CollaborationAuthorizationError(`${label} must be a human actor`);
  }
  return actor;
}

function sameActor(left: Actor, right: Actor): boolean {
  return left.actorType === right.actorType && left.actorId === right.actorId;
}

function asAnchor(value: unknown, label: string): ObjectVersionAnchor {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  return {
    objectId: requiredString(value, "objectId", label),
    versionId: requiredString(value, "versionId", label),
    contentHash: requiredString(value, "contentHash", label),
  };
}

function actorJson(actor: Actor): Record<string, JsonValue> {
  return { actorType: actor.actorType, actorId: actor.actorId };
}

function anchorJson(anchor: ObjectVersionAnchor): Record<string, JsonValue> {
  return {
    objectId: anchor.objectId,
    versionId: anchor.versionId,
    contentHash: anchor.contentHash,
  };
}

function parseMembership(event: Event): ProjectMembership | undefined {
  if (event.eventType !== "CollaborationMembershipGranted") return undefined;
  const payload = event.payload;
  if (!isRecord(payload) || !isRecord(payload.member)) return undefined;
  try {
    return {
      membershipId: requiredString(payload, "membershipId", "membership"),
      actor: humanActor(ActorSchema.parse(payload.member), "membership.member"),
      role: role(payload.role, "membership.role"),
      grantedBy: humanActor(event.actor, "membership grant actor"),
      grantedAt: event.occurredAt,
      grantEventId: event.eventId,
    };
  } catch {
    return undefined;
  }
}

function appendRevoke(memberships: Map<string, ProjectMembership>, event: Event): void {
  if (event.eventType !== "CollaborationMembershipRevoked") return;
  const membershipId = isRecord(event.payload)
    ? event.payload.membershipId
    : undefined;
  if (typeof membershipId !== "string") return;
  const membership = memberships.get(membershipId);
  if (membership === undefined) return;
  memberships.set(membershipId, {
    ...membership,
    revokedAt: event.occurredAt,
    revokedBy: event.actor,
    revokeEventId: event.eventId,
  });
}

export async function projectHead(projectRoot: string): Promise<ProjectHead> {
  return ensureProjectionAtHead(projectRoot);
}

async function collaborationHead(
  projectRoot: string,
  expectedHead?: ProjectHead,
): Promise<ProjectHead> {
  try {
    return await ensureProjectionAtHead(projectRoot, expectedHead);
  } catch (error) {
    if (error instanceof ProjectConcurrencyError) {
      throw new CollaborationConcurrencyError("Project head changed; re-authorize and retry", { cause: error });
    }
    throw error;
  }
}

/**
 * Raw, unauthenticated audit replay. It is for local repair/forensics only;
 * network transports must use {@link readCollaborationState}.
 */
export async function auditListProjectMemberships(projectRoot: string): Promise<ProjectMembership[]> {
  const memberships = new Map<string, ProjectMembership>();
  for (const event of await projectHistory(projectRoot)) {
    const membership = parseMembership(event);
    if (membership !== undefined) memberships.set(membership.membershipId, membership);
    appendRevoke(memberships, event);
  }
  return [...memberships.values()].sort((left, right) =>
    left.membershipId.localeCompare(right.membershipId),
  );
}

export async function activeMembershipFor(
  projectRoot: string,
  actor: Actor,
): Promise<ProjectMembership | undefined> {
  const checked = ActorSchema.parse(actor);
  return (await auditListProjectMemberships(projectRoot)).find(
    (membership) => membership.revokedAt === undefined && sameActor(membership.actor, checked),
  );
}

/** @deprecated Raw audit replay; transports must use readCollaborationState. */
export const listProjectMemberships = auditListProjectMemberships;

export async function authorizeCollaboration(
  projectRoot: string,
  actor: Actor,
  action: CollaborationAction,
): Promise<ProjectMembership> {
  const checked = humanActor(actor, "collaboration actor");
  const membership = await activeMembershipFor(projectRoot, checked);
  if (membership === undefined || !ROLE_PERMISSIONS[membership.role].includes(action)) {
    throw new CollaborationAuthorizationError(
      `Denied ${action}: ${checked.actorId} has no active role granting that capability`,
    );
  }
  return membership;
}

async function appendCollaborationEvent(
  projectRoot: string,
  eventType: string,
  actor: Actor,
  payload: Record<string, JsonValue>,
  branchId?: string,
  expectedHead?: ProjectHead,
): Promise<Event> {
  const manifest = await loadManifest(projectRoot);
  const history = await projectHistory(projectRoot);
  const previous = history.at(-1);
  if (previous === undefined) throw new Error("Project has no accepted event head");
  if (
    expectedHead !== undefined &&
    (expectedHead.sequence !== previous.sequence || expectedHead.eventHash !== previous.eventHash)
  ) {
    throw new CollaborationConcurrencyError("Project head changed; re-read state before retrying");
  }
  const event = createEvent({
    sequence: previous.sequence + 1,
    eventType,
    projectId: manifest.projectId,
    ...(branchId === undefined ? {} : { branchId }),
    actor,
    payload,
    previousEventHash: previous.eventHash as Sha256Digest,
  });
  try {
    const appended = (await appendEvent(projectRoot, event)).event;
    await rebuildProjection(projectRoot);
    return appended;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/sequence|previousEventHash|tail/i.test(message)) {
      throw new CollaborationConcurrencyError("Project head changed; re-read state before retrying", { cause: error });
    }
    throw error;
  }
}

export async function bootstrapProjectOwner(
  projectRoot: string,
  actor: Actor,
  options: { expectedHead?: ProjectHead } = {},
): Promise<ProjectMembership> {
  const owner = humanActor(actor, "initial owner");
  const expectedHead = await collaborationHead(projectRoot, options.expectedHead);
  if ((await auditListProjectMemberships(projectRoot)).length > 0) {
    throw new CollaborationAuthorizationError("Project membership is already initialized");
  }
  const membershipId = createId("mbr");
  const event = await appendCollaborationEvent(projectRoot, "CollaborationMembershipGranted", owner, {
    membershipId,
    member: actorJson(owner),
    role: "owner",
    reason: "initial project owner",
  }, undefined, expectedHead);
  return {
    membershipId,
    actor: owner,
    role: "owner",
    grantedBy: owner,
    grantedAt: event.occurredAt,
    grantEventId: event.eventId,
  };
}

export async function grantProjectMembership(
  projectRoot: string,
  options: {
    actor: Actor;
    member: Actor;
    role: CollaborationRole;
    reason: string;
    expectedHead?: ProjectHead;
  },
): Promise<ProjectMembership> {
  const grantor = humanActor(options.actor, "membership grantor");
  const member = humanActor(options.member, "member");
  const expectedHead = await collaborationHead(projectRoot, options.expectedHead);
  await authorizeCollaboration(projectRoot, grantor, "project:manage-members");
  if (await activeMembershipFor(projectRoot, member)) {
    throw new Error(`Actor ${member.actorId} already has an active membership`);
  }
  const membershipId = createId("mbr");
  const event = await appendCollaborationEvent(projectRoot, "CollaborationMembershipGranted", grantor, {
    membershipId,
    member: actorJson(member),
    role: role(options.role, "membership role"),
    reason: nonEmptyText(options.reason, "membership reason"),
  }, undefined, expectedHead);
  return {
    membershipId,
    actor: member,
    role: options.role,
    grantedBy: grantor,
    grantedAt: event.occurredAt,
    grantEventId: event.eventId,
  };
}

export async function revokeProjectMembership(
  projectRoot: string,
  options: { actor: Actor; membershipId: string; reason: string; expectedHead?: ProjectHead },
): Promise<ProjectMembership> {
  const grantor = humanActor(options.actor, "membership revoker");
  const expectedHead = await collaborationHead(projectRoot, options.expectedHead);
  await authorizeCollaboration(projectRoot, grantor, "project:manage-members");
  const memberships = await auditListProjectMemberships(projectRoot);
  const membership = memberships.find(
    (candidate) => candidate.membershipId === options.membershipId,
  );
  if (membership === undefined || membership.revokedAt !== undefined) {
    throw new Error(`Active membership ${options.membershipId} does not exist`);
  }
  if (
    membership.role === "owner" &&
    memberships.filter((candidate) => candidate.role === "owner" && candidate.revokedAt === undefined).length === 1
  ) {
    throw new CollaborationAuthorizationError("Cannot revoke the last active owner");
  }
  const event = await appendCollaborationEvent(projectRoot, "CollaborationMembershipRevoked", grantor, {
    membershipId: membership.membershipId,
    reason: nonEmptyText(options.reason, "revocation reason"),
  }, undefined, expectedHead);
  return { ...membership, revokedAt: event.occurredAt, revokedBy: grantor, revokeEventId: event.eventId };
}

function nonEmptyText(value: string, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new TypeError(`${label} must be non-empty`);
  return value;
}

function nonNegativeSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return Number(value);
}

function anchorFor(
  projectRoot: string,
  objectId: string,
  versionId: string,
  expectedType?: string,
  branchId?: string,
): ObjectVersionAnchor {
  const history = getObjectHistory(projectRoot, objectId);
  const object = history.find((item) => item.versionId === versionId);
  if (object === undefined) throw new Error(`Object version ${objectId}@${versionId} does not exist`);
  if (expectedType !== undefined && object.objectType !== expectedType) {
    throw new Error(`Object ${objectId}@${versionId} must be a ${expectedType}`);
  }
  if (branchId !== undefined) {
    const current = listCurrentObjects(projectRoot, branchId).find((item) => item.objectId === objectId);
    const byVersionId = new Map(history.map((item) => [item.versionId, item]));
    const seen = new Set<string>();
    let cursor = current?.versionId;
    while (cursor !== undefined && !seen.has(cursor)) {
      if (cursor === versionId) return { objectId, versionId, contentHash: object.contentHash };
      seen.add(cursor);
      const envelope = byVersionId.get(cursor)?.envelope;
      const supersedes = envelope?.supersedesVersionId;
      cursor = typeof supersedes === "string" ? supersedes : undefined;
    }
    throw new Error(`Object version ${objectId}@${versionId} is not visible on branch ${branchId}`);
  }
  return { objectId, versionId, contentHash: object.contentHash };
}

function branchExists(projectRoot: string, branchId: string): void {
  if (!listBranches(projectRoot).some((branch) => branch.branchId === branchId)) {
    throw new Error(`Branch ${branchId} does not exist`);
  }
}

export async function addCollaborationComment(
  projectRoot: string,
  options: { actor: Actor; branchId: string; objectId: string; versionId: string; body: string; expectedHead?: ProjectHead },
): Promise<CollaborationComment> {
  const actor = humanActor(options.actor, "comment author");
  const expectedHead = await collaborationHead(projectRoot, options.expectedHead);
  await authorizeCollaboration(projectRoot, actor, "comment:create");
  branchExists(projectRoot, options.branchId);
  const anchor = anchorFor(projectRoot, options.objectId, options.versionId, undefined, options.branchId);
  const commentId = createId("cmt");
  const event = await appendCollaborationEvent(projectRoot, "CollaborationCommentAdded", actor, {
    commentId,
    anchor: anchorJson(anchor),
    body: nonEmptyText(options.body, "comment body"),
  }, options.branchId, expectedHead);
  return { commentId, branchId: options.branchId, anchor, body: options.body, createdBy: actor, createdAt: event.occurredAt, eventId: event.eventId };
}

/** Role-checked branch creation for collaboration transports. */
export async function createCollaborationBranch(
  projectRoot: string,
  options: { actor: Actor; name: string; baseBranchId?: string; expectedHead?: ProjectHead },
) {
  const actor = humanActor(options.actor, "branch creator");
  const expectedHead = await collaborationHead(projectRoot, options.expectedHead);
  await authorizeCollaboration(projectRoot, actor, "branch:create");
  try {
    return await createBranch(projectRoot, {
      name: options.name,
      ...(options.baseBranchId === undefined ? {} : { baseBranchId: options.baseBranchId }),
      actor,
      expectedHead,
    });
  } catch (error) {
    if (error instanceof ProjectConcurrencyError) {
      throw new CollaborationConcurrencyError("Project head changed; re-authorize and retry", { cause: error });
    }
    throw error;
  }
}

/** Role-checked typed-object proposal/promotion for collaboration transports. */
export async function putCollaborationObject(
  projectRoot: string,
  options: {
    actor: Actor;
    branchId: string;
    objectType: Parameters<typeof putObject>[1]["objectType"];
    content: Record<string, JsonValue>;
    objectId?: string;
    expectedHead?: ProjectHead;
  },
) {
  const actor = humanActor(options.actor, "object writer");
  const expectedHead = await collaborationHead(projectRoot, options.expectedHead);
  await authorizeCollaboration(projectRoot, actor, "object:write");
  const manifest = await loadManifest(projectRoot);
  if (options.branchId === manifest.defaultBranchId) {
    throw new CollaborationAuthorizationError(
      "Collaboration writers cannot write accepted/default state directly; use an authorized merge",
    );
  }
  try {
    return await putObject(projectRoot, { ...options, actor, expectedHead });
  } catch (error) {
    if (error instanceof ProjectConcurrencyError) {
      throw new CollaborationConcurrencyError("Project head changed; re-authorize and retry", { cause: error });
    }
    throw error;
  }
}

/** Role-checked edge creation for collaboration transports. */
export async function addCollaborationEdge(
  projectRoot: string,
  options: {
    actor: Actor;
    branchId: string;
    edgeType: Parameters<typeof addEdge>[1]["edgeType"];
    fromObjectId: string;
    toObjectId: string;
    fromVersionId?: string;
    toVersionId?: string;
    contextId?: string;
    metadata?: Record<string, JsonValue>;
    expectedHead?: ProjectHead;
  },
) {
  const actor = humanActor(options.actor, "edge writer");
  const expectedHead = await collaborationHead(projectRoot, options.expectedHead);
  await authorizeCollaboration(projectRoot, actor, "object:write");
  const manifest = await loadManifest(projectRoot);
  if (options.branchId === manifest.defaultBranchId) {
    throw new CollaborationAuthorizationError(
      "Collaboration writers cannot write accepted/default state directly; use an authorized merge",
    );
  }
  try {
    return await addEdge(projectRoot, { ...options, actor, expectedHead });
  } catch (error) {
    if (error instanceof ProjectConcurrencyError) {
      throw new CollaborationConcurrencyError("Project head changed; re-authorize and retry", { cause: error });
    }
    throw error;
  }
}

/** Raw audit replay; transports must use readCollaborationState. */
export async function auditListCollaborationComments(projectRoot: string): Promise<CollaborationComment[]> {
  const comments: CollaborationComment[] = [];
  for (const event of await projectHistory(projectRoot)) {
    if (event.eventType !== "CollaborationCommentAdded" || event.branchId === undefined || !isRecord(event.payload)) continue;
    try {
      comments.push({
        commentId: requiredString(event.payload, "commentId", "comment"),
        branchId: event.branchId,
        anchor: asAnchor(event.payload.anchor, "comment.anchor"),
        body: requiredString(event.payload, "body", "comment"),
        createdBy: event.actor,
        createdAt: event.occurredAt,
        eventId: event.eventId,
      });
    } catch { /* Preserve invalid foreign events in history, but do not present them as comments. */ }
  }
  return comments;
}

/** @deprecated Raw audit replay; transports must use readCollaborationState. */
export const listCollaborationComments = auditListCollaborationComments;

export async function requestReview(
  projectRoot: string,
  options: {
    actor: Actor;
    branchId: string;
    statementObjectId: string;
    statementVersionId: string;
    evidence: readonly { objectId: string; versionId: string }[];
    summary: string;
    expectedHead?: ProjectHead;
  },
): Promise<ReviewRequest> {
  const actor = humanActor(options.actor, "review requester");
  const expectedHead = await collaborationHead(projectRoot, options.expectedHead);
  await authorizeCollaboration(projectRoot, actor, "review:request");
  branchExists(projectRoot, options.branchId);
  if (options.evidence.length === 0) throw new TypeError("review request requires at least one exact evidence version");
  const statement = anchorFor(projectRoot, options.statementObjectId, options.statementVersionId, "claim", options.branchId);
  const evidence = options.evidence.map((item) => anchorFor(projectRoot, item.objectId, item.versionId, "evidence", options.branchId));
  if (new Set(evidence.map((item) => item.versionId)).size !== evidence.length) {
    throw new TypeError("review request cannot repeat an evidence version");
  }
  const reviewRequestId = createId("rrq");
  const event = await appendCollaborationEvent(projectRoot, "CollaborationReviewRequested", actor, {
    reviewRequestId,
    statement: anchorJson(statement),
    evidence: evidence.map(anchorJson),
    summary: nonEmptyText(options.summary, "review summary"),
  }, options.branchId, expectedHead);
  return { reviewRequestId, branchId: options.branchId, statement, evidence, requestedBy: actor, requestedAt: event.occurredAt, summary: options.summary, eventId: event.eventId };
}

/** Raw audit replay; transports must use readCollaborationState. */
export async function auditListReviewRequests(projectRoot: string): Promise<ReviewRequest[]> {
  const reviews: ReviewRequest[] = [];
  for (const event of await projectHistory(projectRoot)) {
    if (event.eventType !== "CollaborationReviewRequested" || event.branchId === undefined || !isRecord(event.payload)) continue;
    try {
      const rawEvidence = event.payload.evidence;
      if (!Array.isArray(rawEvidence) || rawEvidence.length === 0) continue;
      reviews.push({
        reviewRequestId: requiredString(event.payload, "reviewRequestId", "review request"),
        branchId: event.branchId,
        statement: asAnchor(event.payload.statement, "review request.statement"),
        evidence: rawEvidence.map((value, index) => asAnchor(value, `review request.evidence[${index}]`)),
        requestedBy: event.actor,
        requestedAt: event.occurredAt,
        summary: requiredString(event.payload, "summary", "review request"),
        eventId: event.eventId,
      });
    } catch { /* Foreign malformed events do not become typed review requests. */ }
  }
  return reviews;
}

/** @deprecated Raw audit replay; transports must use readCollaborationState. */
export const listReviewRequests = auditListReviewRequests;

function isReviewRequestStaleInProjection(projectRoot: string, request: ReviewRequest): boolean {
  const visible = new Map(listCurrentObjects(projectRoot, request.branchId).map((object) => [object.objectId, object]));
  return [request.statement, ...request.evidence].some((anchor) =>
    visible.get(anchor.objectId)?.versionId !== anchor.versionId,
  );
}

/** Checks staleness only after refreshing the disposable projection from canonical history. */
export async function isReviewRequestStale(projectRoot: string, request: ReviewRequest): Promise<boolean> {
  await ensureProjectionAtHead(projectRoot);
  return isReviewRequestStaleInProjection(projectRoot, request);
}

export async function recordReviewDecision(
  projectRoot: string,
  options: { actor: Actor; reviewRequestId: string; outcome: "approved" | "rejected"; rationale: string; expectedHead?: ProjectHead },
): Promise<ReviewDecision> {
  const reviewer = humanActor(options.actor, "reviewer");
  const expectedHead = await collaborationHead(projectRoot, options.expectedHead);
  await authorizeCollaboration(projectRoot, reviewer, "review:decide");
  const request = (await auditListReviewRequests(projectRoot)).find((item) => item.reviewRequestId === options.reviewRequestId);
  if (request === undefined) throw new Error(`Review request ${options.reviewRequestId} does not exist`);
  if (sameActor(request.requestedBy, reviewer)) {
    throw new CollaborationAuthorizationError("A requester cannot decide their own review");
  }
  // Refresh independently of the write precondition so a completed revision
  // is reported as stale rather than being hidden behind an old SQLite cache.
  await collaborationHead(projectRoot);
  if (isReviewRequestStaleInProjection(projectRoot, request)) {
    throw new StaleReviewError(`Review request ${request.reviewRequestId} is stale after a statement or evidence revision`);
  }
  if (options.outcome !== "approved" && options.outcome !== "rejected") throw new TypeError("review outcome must be approved or rejected");
  const reviewDecisionId = createId("rde");
  const event = await appendCollaborationEvent(projectRoot, "CollaborationReviewDecided", reviewer, {
    reviewDecisionId,
    reviewRequestId: request.reviewRequestId,
    outcome: options.outcome,
    rationale: nonEmptyText(options.rationale, "review rationale"),
  }, request.branchId, expectedHead);
  return { reviewDecisionId, reviewRequestId: request.reviewRequestId, outcome: options.outcome, reviewer, rationale: options.rationale, decidedAt: event.occurredAt, eventId: event.eventId };
}

/** Raw audit replay; transports must use readCollaborationState. */
export async function auditListReviewDecisions(projectRoot: string): Promise<ReviewDecision[]> {
  const decisions: ReviewDecision[] = [];
  for (const event of await projectHistory(projectRoot)) {
    if (event.eventType !== "CollaborationReviewDecided" || !isRecord(event.payload)) continue;
    try {
      const outcome = event.payload.outcome;
      if (outcome !== "approved" && outcome !== "rejected") continue;
      decisions.push({
        reviewDecisionId: requiredString(event.payload, "reviewDecisionId", "review decision"),
        reviewRequestId: requiredString(event.payload, "reviewRequestId", "review decision"),
        outcome,
        reviewer: humanActor(event.actor, "review decision actor"),
        rationale: requiredString(event.payload, "rationale", "review decision"),
        decidedAt: event.occurredAt,
        eventId: event.eventId,
      });
    } catch {
      // Retain malformed foreign events in canonical history, but never
      // elevate them into a typed decision projection.
    }
  }
  return decisions;
}

/** @deprecated Raw audit replay; transports must use readCollaborationState. */
export const listReviewDecisions = auditListReviewDecisions;

/** Recomputes current/stale status from exact anchors during every replay. */
export async function auditReviewRequestStates(projectRoot: string): Promise<ReviewRequestState[]> {
  await ensureProjectionAtHead(projectRoot);
  const [requests, decisions] = await Promise.all([
    auditListReviewRequests(projectRoot),
    auditListReviewDecisions(projectRoot),
  ]);
  return requests.map((request) => {
    const matching = decisions.filter((decision) => decision.reviewRequestId === request.reviewRequestId);
    const stale = isReviewRequestStaleInProjection(projectRoot, request);
    return { request, current: !stale, stale, decisions: matching };
  });
}

/**
 * Authorization-aware replay intended for collaboration transports. Raw audit
 * functions above deliberately remain separately named for offline repair.
 */
export async function readCollaborationState(
  projectRoot: string,
  actor: Actor,
): Promise<AuthorizedCollaborationRead> {
  const checked = humanActor(actor, "collaboration reader");
  const membership = await authorizeCollaboration(projectRoot, checked, "project:view");
  const head = await projectHead(projectRoot);
  const [memberships, comments, reviews, mergeAuthorizations] = await Promise.all([
    auditListProjectMemberships(projectRoot),
    auditListCollaborationComments(projectRoot),
    auditReviewRequestStates(projectRoot),
    auditListMergeAuthorizations(projectRoot),
  ]);
  return { actor: checked, membership, head, memberships, comments, reviews, mergeAuthorizations };
}

export async function authorizeBranchMerge(
  projectRoot: string,
  options: { actor: Actor; subject: Actor; sourceBranchId: string; targetBranchId: string; reason: string; expectedHead?: ProjectHead },
): Promise<MergeAuthorization> {
  const owner = humanActor(options.actor, "merge authorizer");
  const subject = humanActor(options.subject, "merge subject");
  const expectedHead = await collaborationHead(projectRoot, options.expectedHead);
  const ownerMembership = await authorizeCollaboration(projectRoot, owner, "project:manage-members");
  const subjectMembership = await authorizeCollaboration(projectRoot, subject, "project:view");
  if (subjectMembership.role !== "owner" && subjectMembership.role !== "researcher") {
    throw new CollaborationAuthorizationError(
      "Only an owner or researcher may receive accepted-state merge authority",
    );
  }
  branchExists(projectRoot, options.sourceBranchId);
  branchExists(projectRoot, options.targetBranchId);
  const source = listBranches(projectRoot).find((branch) => branch.branchId === options.sourceBranchId)!;
  const target = listBranches(projectRoot).find((branch) => branch.branchId === options.targetBranchId)!;
  // The authorization itself is a target-branch event. Bind the decision to
  // that post-decision head so the authorization remains usable once and only
  // until either branch receives another event.
  const postDecisionTargetHead = expectedHead.sequence + 1;
  const authorizationId = createId("maz");
  const event = await appendCollaborationEvent(projectRoot, "CollaborationAuthorizationDecided", owner, {
    authorizationId,
    action: "branch:merge",
    subject: actorJson(subject),
    subjectMembershipId: subjectMembership.membershipId,
    subjectGrantEventId: subjectMembership.grantEventId,
    sourceBranchId: source.branchId,
    targetBranchId: target.branchId,
    sourceHeadSequence: source.headSequence,
    targetHeadSequence: postDecisionTargetHead,
    issuerMembershipId: ownerMembership.membershipId,
    issuerGrantEventId: ownerMembership.grantEventId,
    granted: true,
    reason: nonEmptyText(options.reason, "merge authorization reason"),
  }, target.branchId, expectedHead);
  return {
    authorizationId,
    subject,
    subjectMembershipId: subjectMembership.membershipId,
    subjectGrantEventId: subjectMembership.grantEventId,
    sourceBranchId: source.branchId,
    targetBranchId: target.branchId,
    sourceHeadSequence: source.headSequence,
    targetHeadSequence: postDecisionTargetHead,
    decidedBy: owner,
    issuerMembershipId: ownerMembership.membershipId,
    issuerGrantEventId: ownerMembership.grantEventId,
    reason: options.reason,
    decidedAt: event.occurredAt,
    eventId: event.eventId,
  };
}

/** Raw audit replay; transports must use readCollaborationState. */
export async function auditListMergeAuthorizations(projectRoot: string): Promise<MergeAuthorization[]> {
  const result: MergeAuthorization[] = [];
  for (const event of await projectHistory(projectRoot)) {
    if (event.eventType !== "CollaborationAuthorizationDecided" || !isRecord(event.payload)) continue;
    const payload = event.payload;
    try {
      if (payload.action !== "branch:merge" || payload.granted !== true) continue;
      result.push({
        authorizationId: requiredString(payload, "authorizationId", "merge authorization"),
        subject: humanActor(ActorSchema.parse(payload.subject), "merge authorization subject"),
        subjectMembershipId: requiredString(payload, "subjectMembershipId", "merge authorization"),
        subjectGrantEventId: requiredString(payload, "subjectGrantEventId", "merge authorization"),
        sourceBranchId: requiredString(payload, "sourceBranchId", "merge authorization"),
        targetBranchId: requiredString(payload, "targetBranchId", "merge authorization"),
        sourceHeadSequence: nonNegativeSafeInteger(payload.sourceHeadSequence, "merge authorization.sourceHeadSequence"),
        targetHeadSequence: nonNegativeSafeInteger(payload.targetHeadSequence, "merge authorization.targetHeadSequence"),
        decidedBy: humanActor(event.actor, "merge authorization actor"),
        issuerMembershipId: requiredString(payload, "issuerMembershipId", "merge authorization"),
        issuerGrantEventId: requiredString(payload, "issuerGrantEventId", "merge authorization"),
        reason: requiredString(payload, "reason", "merge authorization"),
        decidedAt: event.occurredAt,
        eventId: event.eventId,
      });
    } catch { /* Ignore malformed foreign event while retaining it in canonical history. */ }
  }
  return result;
}

/** @deprecated Raw audit replay; transports must use readCollaborationState. */
export const listMergeAuthorizations = auditListMergeAuthorizations;

/** Raw audit replay of authorizations consumed in an atomic merge batch. */
export async function auditListConsumedMergeAuthorizations(
  projectRoot: string,
): Promise<ConsumedMergeAuthorization[]> {
  const consumed: ConsumedMergeAuthorization[] = [];
  for (const event of await projectHistory(projectRoot)) {
    if (event.eventType !== "CollaborationMergeAuthorizationConsumed" || !isRecord(event.payload)) continue;
    try {
      consumed.push({
        authorizationId: requiredString(event.payload, "authorizationId", "merge authorization consumption"),
        mergeId: requiredString(event.payload, "mergeId", "merge authorization consumption"),
        sourceBranchId: requiredString(event.payload, "sourceBranchId", "merge authorization consumption"),
        targetBranchId: requiredString(event.payload, "targetBranchId", "merge authorization consumption"),
        consumedBy: humanActor(event.actor, "merge authorization consumer"),
        consumedAt: event.occurredAt,
        eventId: event.eventId,
      });
    } catch {
      // Preserve invalid foreign events in audit history without treating one
      // as a consumption record.
    }
  }
  return consumed;
}

export async function mergeAcceptedBranch(
  projectRoot: string,
  options: {
    actor: Actor;
    authorizationId: string;
    sourceBranchId: string;
    targetBranchId: string;
    expectedHead?: ProjectHead;
  },
): Promise<SafeMergeResult> {
  const actor = humanActor(options.actor, "merge actor");
  // Capture before authorization checks. If revocation races this merge, the
  // batch below either linearizes before it or fails its head precondition.
  const expectedHead = await collaborationHead(projectRoot, options.expectedHead);
  const authorization = (await auditListMergeAuthorizations(projectRoot)).find(
    (item) => item.authorizationId === options.authorizationId,
  );
  if (authorization === undefined) throw new CollaborationAuthorizationError("A granted merge authorization is required");
  if ((await auditListConsumedMergeAuthorizations(projectRoot)).some(
    (consumed) => consumed.authorizationId === authorization.authorizationId,
  )) {
    throw new CollaborationAuthorizationError("Merge authorization has already been consumed");
  }
  if (!sameActor(authorization.subject, actor)) throw new CollaborationAuthorizationError("Merge authorization belongs to a different actor");
  const [actorMembership, authorizerMembership] = await Promise.all([
    activeMembershipFor(projectRoot, actor),
    activeMembershipFor(projectRoot, authorization.decidedBy),
  ]);
  if (
    (actorMembership?.role !== "owner" && actorMembership?.role !== "researcher") ||
    actorMembership?.membershipId !== authorization.subjectMembershipId ||
    actorMembership?.grantEventId !== authorization.subjectGrantEventId
  ) {
    throw new CollaborationAuthorizationError(
      "Merge actor no longer holds the exact active owner/researcher membership that was authorized",
    );
  }
  if (
    authorizerMembership?.role !== "owner" ||
    authorizerMembership?.membershipId !== authorization.issuerMembershipId ||
    authorizerMembership?.grantEventId !== authorization.issuerGrantEventId
  ) {
    throw new CollaborationAuthorizationError(
      "Merge authorization issuer no longer holds the exact active owner membership that issued it",
    );
  }
  if (authorization.sourceBranchId !== options.sourceBranchId || authorization.targetBranchId !== options.targetBranchId) {
    throw new CollaborationAuthorizationError("Merge authorization scope does not match the requested branches");
  }
  const source = listBranches(projectRoot).find((branch) => branch.branchId === options.sourceBranchId);
  const target = listBranches(projectRoot).find((branch) => branch.branchId === options.targetBranchId);
  if (source?.headSequence !== authorization.sourceHeadSequence || target?.headSequence !== authorization.targetHeadSequence) {
    throw new CollaborationConcurrencyError("Merge authorization is stale because a branch head changed");
  }
  try {
    return await mergeBranchSafe(projectRoot, {
      sourceBranchId: options.sourceBranchId,
      targetBranchId: options.targetBranchId,
      actor,
      expectedHead,
      collaborationAuthorizationId: authorization.authorizationId,
    });
  } catch (error) {
    if (error instanceof MergeConcurrencyError) {
      throw new CollaborationConcurrencyError("Project head changed; re-authorize and retry", { cause: error });
    }
    throw error;
  }
}

/** Exposed for audit UIs and tests; no role has an implicit merge capability. */
export function permissionsForRole(roleName: CollaborationRole): readonly CollaborationAction[] {
  return Object.freeze([...ROLE_PERMISSIONS[role(roleName, "role")]]);
}
