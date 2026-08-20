import {
  EDGE_TYPES,
  OBJECT_TYPES,
  type EdgeType,
  type Event,
  type ObjectType,
} from "@reasoning-workbench/project-format";

import { inspectProject, projectHistory } from "./project.js";
import type { EdgeProjection, ObjectProjection } from "./projection.js";
import {
  deriveVerificationProfile,
  VERIFICATION_ASSURANCE_LEVELS,
  VERIFICATION_DIMENSIONS,
  type VerificationAssurance,
  type VerificationDimension,
} from "./paper.js";
import { analyzeReviewLoop } from "./verification.js";

interface CompletionRuleBase {
  readonly ruleId: string;
  readonly label?: string;
  /** Completion is always computed from project state by the evaluator. */
  readonly passed?: never;
}

export interface ObjectCountRule extends CompletionRuleBase {
  readonly kind: "object_count";
  readonly objectType: ObjectType;
  readonly min: number;
  readonly max?: number;
}

export interface EdgeCountRule extends CompletionRuleBase {
  readonly kind: "edge_count";
  readonly edgeType: EdgeType;
  readonly min: number;
  readonly fromObjectType?: ObjectType;
  readonly toObjectType?: ObjectType;
}

export interface EveryObjectHasEdgeRule extends CompletionRuleBase {
  readonly kind: "every_object_has_edge";
  readonly objectType: ObjectType;
  readonly direction: "incoming" | "outgoing";
  readonly edgeTypes: readonly EdgeType[];
  readonly otherObjectTypes?: readonly ObjectType[];
}

export interface NoOpenFailuresRule extends CompletionRuleBase {
  readonly kind: "no_open_failures";
}

export interface ArtifactCountRule extends CompletionRuleBase {
  readonly kind: "artifact_count";
  readonly min: number;
  readonly mediaTypes?: readonly string[];
}

export interface VerificationGateRule extends CompletionRuleBase {
  readonly kind: "verification_gate";
  readonly dimensions: readonly VerificationDimension[];
  readonly claimIds?: readonly string[];
  readonly requiredStatus?: "supported" | "verified";
  readonly allowedAssurances?: readonly VerificationAssurance[];
  readonly allowExplicitConjectures?: boolean;
}

export interface IndependentReviewRule extends CompletionRuleBase {
  readonly kind: "independent_review";
  readonly claimIds?: readonly string[];
  readonly minReviewers: number;
  readonly requireFreshContext?: boolean;
  readonly requireAdversarial?: boolean;
  readonly requireCrossModelFamily?: boolean;
  readonly allowExplicitConjectures?: boolean;
}

export interface ReviewLoopClearRule extends CompletionRuleBase {
  readonly kind: "review_loop_clear";
  readonly claimIds?: readonly string[];
  readonly repeatedObjectionLimit?: number;
  readonly noNewEvidenceLimit?: number;
  readonly claimCycleLimit?: number;
  readonly allowExplicitConjectures?: boolean;
}

export interface FormalAlignmentRule extends CompletionRuleBase {
  readonly kind: "formal_alignment";
  readonly claimIds?: readonly string[];
  readonly allowExplicitConjectures?: boolean;
}

/**
 * A closed, JSON-serializable set of Stage-2 completion predicates.
 *
 * There is intentionally no success field or actor override in this format.
 * Success is derived exclusively by {@link evaluateCompletionPolicy}.
 */
export type CompletionRule =
  | ObjectCountRule
  | EdgeCountRule
  | EveryObjectHasEdgeRule
  | NoOpenFailuresRule
  | ArtifactCountRule
  | VerificationGateRule
  | IndependentReviewRule
  | ReviewLoopClearRule
  | FormalAlignmentRule;

export interface CompletionPolicy {
  readonly schemaVersion: 1;
  readonly policyId: string;
  readonly name: string;
  readonly rules: readonly CompletionRule[];
  /** Completion is always computed from project state by the evaluator. */
  readonly passed?: never;
}

export interface CompletionRuleResult {
  readonly ruleId: string;
  readonly kind: CompletionRule["kind"];
  readonly passed: boolean;
  readonly reason: string;
  readonly observedObjectIds: readonly string[];
  readonly observedEdgeIds: readonly string[];
  readonly observedArtifactIds: readonly string[];
}

export interface CompletionPolicyEvaluation {
  readonly policyId: string;
  readonly branchId: string;
  readonly passed: boolean;
  readonly ruleResults: readonly CompletionRuleResult[];
}

export interface EvaluateCompletionPolicyOptions {
  readonly branchId: string;
  readonly policy: CompletionPolicy;
}

interface VisibleArtifact {
  readonly artifactId: string;
  readonly mediaType: string;
}

const objectTypes = new Set<string>(OBJECT_TYPES);
const edgeTypes = new Set<string>(EDGE_TYPES);
const verificationDimensions = new Set<string>(VERIFICATION_DIMENSIONS);
const verificationAssurances = new Set<string>(VERIFICATION_ASSURANCE_LEVELS);

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return Number(value);
}

function allowedKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const set = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!set.has(key)) {
      throw new TypeError(`${label} contains unsupported field ${JSON.stringify(key)}`);
    }
  }
}

function enumValue<T extends string>(
  value: unknown,
  values: ReadonlySet<string>,
  label: string,
): T {
  const checked = nonEmptyString(value, label);
  if (!values.has(checked)) throw new TypeError(`${label} is unsupported: ${checked}`);
  return checked as T;
}

function uniqueEnumArray<T extends string>(
  value: unknown,
  values: ReadonlySet<string>,
  label: string,
): readonly T[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty array`);
  }
  const checked = value.map((item, index) =>
    enumValue<T>(item, values, `${label}[${index}]`),
  );
  if (new Set(checked).size !== checked.length) {
    throw new TypeError(`${label} cannot contain duplicates`);
  }
  return checked;
}

function uniqueStringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty array`);
  }
  const checked = value.map((item, index) =>
    nonEmptyString(item, `${label}[${index}]`),
  );
  if (new Set(checked).size !== checked.length) {
    throw new TypeError(`${label} cannot contain duplicates`);
  }
  return checked;
}

function optionalBoolean(value: unknown, label: string): void {
  if (value !== undefined && typeof value !== "boolean") {
    throw new TypeError(`${label} must be boolean`);
  }
}

/** Rejects malformed policies and any attempt to inject a success result. */
export function assertCompletionPolicy(policy: unknown): asserts policy is CompletionPolicy {
  const value = record(policy, "completion policy");
  allowedKeys(value, ["schemaVersion", "policyId", "name", "rules"], "completion policy");
  if (value.schemaVersion !== 1) {
    throw new TypeError("completion policy.schemaVersion must be 1");
  }
  nonEmptyString(value.policyId, "completion policy.policyId");
  nonEmptyString(value.name, "completion policy.name");
  if (!Array.isArray(value.rules)) {
    throw new TypeError("completion policy.rules must be an array");
  }

  const ruleIds = new Set<string>();
  for (const [index, candidate] of value.rules.entries()) {
    const rule = record(candidate, `completion policy.rules[${index}]`);
    const label = `completion policy.rules[${index}]`;
    const ruleId = nonEmptyString(rule.ruleId, `${label}.ruleId`);
    if (ruleIds.has(ruleId)) throw new TypeError(`duplicate completion ruleId: ${ruleId}`);
    ruleIds.add(ruleId);
    if (rule.label !== undefined) nonEmptyString(rule.label, `${label}.label`);

    switch (rule.kind) {
      case "object_count": {
        allowedKeys(rule, ["ruleId", "label", "kind", "objectType", "min", "max"], label);
        enumValue<ObjectType>(rule.objectType, objectTypes, `${label}.objectType`);
        const minimum = nonNegativeInteger(rule.min, `${label}.min`);
        if (rule.max !== undefined) {
          const maximum = nonNegativeInteger(rule.max, `${label}.max`);
          if (maximum < minimum) throw new TypeError(`${label}.max must be >= min`);
        }
        break;
      }
      case "edge_count":
        allowedKeys(
          rule,
          ["ruleId", "label", "kind", "edgeType", "min", "fromObjectType", "toObjectType"],
          label,
        );
        enumValue<EdgeType>(rule.edgeType, edgeTypes, `${label}.edgeType`);
        nonNegativeInteger(rule.min, `${label}.min`);
        if (rule.fromObjectType !== undefined) {
          enumValue<ObjectType>(rule.fromObjectType, objectTypes, `${label}.fromObjectType`);
        }
        if (rule.toObjectType !== undefined) {
          enumValue<ObjectType>(rule.toObjectType, objectTypes, `${label}.toObjectType`);
        }
        break;
      case "every_object_has_edge":
        allowedKeys(
          rule,
          ["ruleId", "label", "kind", "objectType", "direction", "edgeTypes", "otherObjectTypes"],
          label,
        );
        enumValue<ObjectType>(rule.objectType, objectTypes, `${label}.objectType`);
        if (rule.direction !== "incoming" && rule.direction !== "outgoing") {
          throw new TypeError(`${label}.direction must be incoming or outgoing`);
        }
        uniqueEnumArray<EdgeType>(rule.edgeTypes, edgeTypes, `${label}.edgeTypes`);
        if (rule.otherObjectTypes !== undefined) {
          uniqueEnumArray<ObjectType>(
            rule.otherObjectTypes,
            objectTypes,
            `${label}.otherObjectTypes`,
          );
        }
        break;
      case "no_open_failures":
        allowedKeys(rule, ["ruleId", "label", "kind"], label);
        break;
      case "artifact_count":
        allowedKeys(rule, ["ruleId", "label", "kind", "min", "mediaTypes"], label);
        nonNegativeInteger(rule.min, `${label}.min`);
        if (rule.mediaTypes !== undefined) {
          uniqueStringArray(rule.mediaTypes, `${label}.mediaTypes`);
        }
        break;
      case "verification_gate":
        allowedKeys(
          rule,
          [
            "ruleId",
            "label",
            "kind",
            "dimensions",
            "claimIds",
            "requiredStatus",
            "allowedAssurances",
            "allowExplicitConjectures",
          ],
          label,
        );
        uniqueEnumArray<VerificationDimension>(
          rule.dimensions,
          verificationDimensions,
          `${label}.dimensions`,
        );
        if (rule.claimIds !== undefined) uniqueStringArray(rule.claimIds, `${label}.claimIds`);
        if (
          rule.requiredStatus !== undefined &&
          rule.requiredStatus !== "supported" &&
          rule.requiredStatus !== "verified"
        ) throw new TypeError(`${label}.requiredStatus must be supported or verified`);
        if (rule.allowedAssurances !== undefined) {
          uniqueEnumArray<VerificationAssurance>(
            rule.allowedAssurances,
            verificationAssurances,
            `${label}.allowedAssurances`,
          );
        }
        optionalBoolean(rule.allowExplicitConjectures, `${label}.allowExplicitConjectures`);
        break;
      case "independent_review":
        allowedKeys(
          rule,
          [
            "ruleId",
            "label",
            "kind",
            "claimIds",
            "minReviewers",
            "requireFreshContext",
            "requireAdversarial",
            "requireCrossModelFamily",
            "allowExplicitConjectures",
          ],
          label,
        );
        if (rule.claimIds !== undefined) uniqueStringArray(rule.claimIds, `${label}.claimIds`);
        if (nonNegativeInteger(rule.minReviewers, `${label}.minReviewers`) === 0) {
          throw new TypeError(`${label}.minReviewers must be positive`);
        }
        optionalBoolean(rule.requireFreshContext, `${label}.requireFreshContext`);
        optionalBoolean(rule.requireAdversarial, `${label}.requireAdversarial`);
        optionalBoolean(rule.requireCrossModelFamily, `${label}.requireCrossModelFamily`);
        optionalBoolean(rule.allowExplicitConjectures, `${label}.allowExplicitConjectures`);
        break;
      case "review_loop_clear":
        allowedKeys(
          rule,
          [
            "ruleId",
            "label",
            "kind",
            "claimIds",
            "repeatedObjectionLimit",
            "noNewEvidenceLimit",
            "claimCycleLimit",
            "allowExplicitConjectures",
          ],
          label,
        );
        if (rule.claimIds !== undefined) uniqueStringArray(rule.claimIds, `${label}.claimIds`);
        for (const key of ["repeatedObjectionLimit", "noNewEvidenceLimit", "claimCycleLimit"] as const) {
          if (rule[key] !== undefined && nonNegativeInteger(rule[key], `${label}.${key}`) === 0) {
            throw new TypeError(`${label}.${key} must be positive`);
          }
        }
        optionalBoolean(rule.allowExplicitConjectures, `${label}.allowExplicitConjectures`);
        break;
      case "formal_alignment":
        allowedKeys(
          rule,
          ["ruleId", "label", "kind", "claimIds", "allowExplicitConjectures"],
          label,
        );
        if (rule.claimIds !== undefined) uniqueStringArray(rule.claimIds, `${label}.claimIds`);
        optionalBoolean(rule.allowExplicitConjectures, `${label}.allowExplicitConjectures`);
        break;
      default:
        throw new TypeError(`${label}.kind is unsupported: ${String(rule.kind)}`);
    }
  }
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function objectTypeMap(objects: readonly ObjectProjection[]): ReadonlyMap<string, string> {
  return new Map(objects.map((object) => [object.objectId, object.objectType]));
}

function artifactRecord(event: Event): Record<string, unknown> | undefined {
  if (event.eventType !== "ArtifactRegistered") return undefined;
  const artifact = event.payload.artifact;
  return typeof artifact === "object" && artifact !== null && !Array.isArray(artifact)
    ? (artifact as Record<string, unknown>)
    : undefined;
}

/**
 * Reconstructs branch visibility for artifacts from canonical events. A child
 * sees its parent's artifacts only up to the parent's head at fork time.
 */
function visibleArtifacts(events: readonly Event[], branchId: string): VisibleArtifact[] {
  const parents = new Map<string, { parentBranchId?: string; baseSequence: number }>();
  const branchHeads = new Map<string, number>();

  for (const event of events) {
    if (event.eventType === "BranchCreated") {
      const createdBranchId = event.payload.branchId;
      const baseBranchId = event.payload.baseBranchId;
      if (typeof createdBranchId === "string") {
        parents.set(createdBranchId, {
          ...(typeof baseBranchId === "string" ? { parentBranchId: baseBranchId } : {}),
          baseSequence:
            typeof baseBranchId === "string" ? (branchHeads.get(baseBranchId) ?? 0) : 0,
        });
      }
    }
    if (event.branchId !== undefined) branchHeads.set(event.branchId, event.sequence);
  }

  const visibleUntil = new Map<string, number>();
  const visited = new Set<string>();
  let currentBranchId: string | undefined = branchId;
  let cutoff = Number.POSITIVE_INFINITY;
  while (currentBranchId !== undefined && !visited.has(currentBranchId)) {
    visited.add(currentBranchId);
    visibleUntil.set(currentBranchId, cutoff);
    const lineage = parents.get(currentBranchId);
    if (lineage?.parentBranchId === undefined) break;
    cutoff = Math.min(cutoff, lineage.baseSequence);
    currentBranchId = lineage.parentBranchId;
  }

  const artifacts = new Map<string, VisibleArtifact>();
  for (const event of events) {
    if (event.branchId === undefined) continue;
    const branchCutoff = visibleUntil.get(event.branchId);
    if (branchCutoff === undefined || event.sequence > branchCutoff) continue;
    const artifact = artifactRecord(event);
    if (artifact === undefined) continue;
    if (typeof artifact.artifactId !== "string" || typeof artifact.mediaType !== "string") {
      continue;
    }
    artifacts.set(artifact.artifactId, {
      artifactId: artifact.artifactId,
      mediaType: artifact.mediaType,
    });
  }
  return [...artifacts.values()].sort((left, right) =>
    left.artifactId.localeCompare(right.artifactId),
  );
}

function result(
  rule: CompletionRule,
  passed: boolean,
  reason: string,
  observations: {
    objectIds?: Iterable<string>;
    edgeIds?: Iterable<string>;
    artifactIds?: Iterable<string>;
  } = {},
): CompletionRuleResult {
  return {
    ruleId: rule.ruleId,
    kind: rule.kind,
    passed,
    reason,
    observedObjectIds: sortedUnique(observations.objectIds ?? []),
    observedEdgeIds: sortedUnique(observations.edgeIds ?? []),
    observedArtifactIds: sortedUnique(observations.artifactIds ?? []),
  };
}

function contentRecord(object: ObjectProjection): Record<string, unknown> | undefined {
  return typeof object.content === "object" && object.content !== null && !Array.isArray(object.content)
    ? object.content as Record<string, unknown>
    : undefined;
}

function explicitlyUnresolvedConjecture(object: ObjectProjection): boolean {
  const content = contentRecord(object);
  return content?.verificationDisposition === "conjecture" &&
    typeof content.unresolvedReason === "string" &&
    content.unresolvedReason.trim().length > 0;
}

function claimsForRule(
  claimIds: readonly string[] | undefined,
  allowExplicitConjectures: boolean | undefined,
  objects: readonly ObjectProjection[],
): { claims: ObjectProjection[]; missing: string[]; excluded: string[] } {
  const byId = new Map(objects.map((object) => [object.objectId, object]));
  const selectedIds = claimIds === undefined
    ? objects.filter((object) => object.objectType === "claim").map((object) => object.objectId)
    : [...claimIds];
  const missing: string[] = [];
  const excluded: string[] = [];
  const claims: ObjectProjection[] = [];
  for (const id of selectedIds.sort((left, right) => left.localeCompare(right))) {
    const object = byId.get(id);
    if (object === undefined || object.objectType !== "claim") {
      missing.push(id);
    } else if (allowExplicitConjectures === true && explicitlyUnresolvedConjecture(object)) {
      excluded.push(id);
    } else {
      claims.push(object);
    }
  }
  return { claims, missing, excluded };
}

function evaluateRule(
  rule: CompletionRule,
  objects: readonly ObjectProjection[],
  edges: readonly EdgeProjection[],
  artifacts: readonly VisibleArtifact[],
  projectRoot: string,
  branchId: string,
): CompletionRuleResult {
  const types = objectTypeMap(objects);

  switch (rule.kind) {
    case "object_count": { // Count current versions, never historical versions.
      const matched = objects.filter((object) => object.objectType === rule.objectType);
      const count = matched.length;
      const passed = count >= rule.min && (rule.max === undefined || count <= rule.max);
      const range =
        rule.max === undefined
          ? `at least ${rule.min}`
          : rule.min === rule.max
            ? `exactly ${rule.min}`
            : `between ${rule.min} and ${rule.max}`;
      return result(
        rule,
        passed,
        `Found ${count} visible ${rule.objectType} object(s); required ${range}.`,
        { objectIds: matched.map((object) => object.objectId) },
      );
    }
    case "edge_count": {
      const matched = edges.filter(
        (edge) =>
          edge.edgeType === rule.edgeType &&
          (rule.fromObjectType === undefined || types.get(edge.fromObjectId) === rule.fromObjectType) &&
          (rule.toObjectType === undefined || types.get(edge.toObjectId) === rule.toObjectType),
      );
      return result(
        rule,
        matched.length >= rule.min,
        `Found ${matched.length} visible ${rule.edgeType} edge(s); required at least ${rule.min}.`,
        {
          edgeIds: matched.map((edge) => edge.edgeId),
          objectIds: matched.flatMap((edge) => [edge.fromObjectId, edge.toObjectId]),
        },
      );
    }
    case "every_object_has_edge": {
      const targets = objects.filter((object) => object.objectType === rule.objectType);
      const allowedEdges = new Set<string>(rule.edgeTypes);
      const allowedOtherTypes =
        rule.otherObjectTypes === undefined
          ? undefined
          : new Set<string>(rule.otherObjectTypes);
      const qualifying = new Map<string, EdgeProjection[]>();
      for (const target of targets) {
        const matches = edges.filter((edge) => {
          if (!allowedEdges.has(edge.edgeType)) return false;
          const isIncoming = rule.direction === "incoming";
          const targetId = isIncoming ? edge.toObjectId : edge.fromObjectId;
          if (targetId !== target.objectId) return false;
          const otherId = isIncoming ? edge.fromObjectId : edge.toObjectId;
          return allowedOtherTypes === undefined || allowedOtherTypes.has(types.get(otherId) ?? "");
        });
        qualifying.set(target.objectId, matches);
      }
      const missing = targets
        .filter((target) => (qualifying.get(target.objectId)?.length ?? 0) === 0)
        .map((target) => target.objectId)
        .sort((left, right) => left.localeCompare(right));
      const matchingEdges = [...qualifying.values()].flat();
      const reason =
        missing.length === 0
          ? `Every visible ${rule.objectType} object has a qualifying ${rule.direction} edge.`
          : `${missing.length} visible ${rule.objectType} object(s) lack a qualifying ${rule.direction} edge: ${missing.join(", ")}.`;
      return result(rule, missing.length === 0, reason, {
        objectIds: targets.map((target) => target.objectId),
        edgeIds: matchingEdges.map((edge) => edge.edgeId),
      });
    }
    case "no_open_failures": {
      const failures = objects.filter((object) => object.objectType === "failure");
      const open = failures.filter((failure) => {
        const content = failure.content;
        const status =
          typeof content === "object" && content !== null && !Array.isArray(content)
            ? (content as Record<string, unknown>).status
            : undefined;
        return (
          typeof status !== "string" ||
          !["resolved", "closed"].includes(status.trim().toLowerCase())
        );
      });
      const openIds = sortedUnique(open.map((failure) => failure.objectId));
      const reason =
        openIds.length === 0
          ? `No open failure objects were found among ${failures.length} visible failure(s).`
          : `Found ${openIds.length} open failure object(s): ${openIds.join(", ")}.`;
      return result(rule, openIds.length === 0, reason, {
        objectIds: failures.map((failure) => failure.objectId),
      });
    }
    case "artifact_count": {
      const mediaTypes =
        rule.mediaTypes === undefined ? undefined : new Set<string>(rule.mediaTypes);
      const matched = artifacts.filter(
        (artifact) => mediaTypes === undefined || mediaTypes.has(artifact.mediaType),
      );
      const qualifier =
        rule.mediaTypes === undefined
          ? ""
          : ` with media type in [${[...rule.mediaTypes].sort().join(", ")}]`;
      return result(
        rule,
        matched.length >= rule.min,
        `Found ${matched.length} visible artifact(s)${qualifier}; required at least ${rule.min}.`,
        { artifactIds: matched.map((artifact) => artifact.artifactId) },
      );
    }
    case "verification_gate": {
      const selected = claimsForRule(
        rule.claimIds,
        rule.allowExplicitConjectures,
        objects,
      );
      const requiredStatus = rule.requiredStatus ?? "supported";
      const allowedAssurances = new Set<VerificationAssurance>(
        rule.allowedAssurances ?? ["support", "machine-checked", "human-reviewed", "formal-kernel"],
      );
      const gaps: string[] = selected.missing.map((id) => `${id}:missing-claim`);
      const evidenceIds: string[] = [];
      for (const claim of selected.claims) {
        const contextId = contentRecord(claim)?.contextId;
        if (typeof contextId !== "string") {
          gaps.push(`${claim.objectId}:missing-context`);
          continue;
        }
        let profile;
        try {
          profile = deriveVerificationProfile(projectRoot, {
            branchId,
            claimId: claim.objectId,
            contextId,
          });
        } catch {
          gaps.push(`${claim.objectId}:invalid-context`);
          continue;
        }
        for (const dimension of rule.dimensions) {
          const observed = profile.dimensions.find((entry) => entry.dimension === dimension)!;
          evidenceIds.push(...observed.currentEvidenceObjectIds);
          const eligible = observed.observations.filter(
            (observation) =>
              !observation.stale &&
              observation.outcome === "passed" &&
              allowedAssurances.has(observation.assurance),
          );
          const passes = requiredStatus === "verified"
            ? eligible.some((observation) => observation.assurance === "formal-kernel")
            : eligible.length > 0;
          if (!passes) {
            gaps.push(
              `${claim.objectId}:${dimension}:${observed.status}:no-allowed-assurance`,
            );
          }
        }
      }
      const passed = gaps.length === 0;
      return result(
        rule,
        passed,
        passed
          ? `All ${selected.claims.length} selected claim(s) satisfy ${rule.dimensions.join(", ")} at ${requiredStatus} status.`
          : `Verification gaps: ${gaps.sort().join(", ")}.`,
        {
          objectIds: [...selected.claims.map((claim) => claim.objectId), ...evidenceIds],
        },
      );
    }
    case "independent_review": {
      const selected = claimsForRule(rule.claimIds, rule.allowExplicitConjectures, objects);
      const gaps: string[] = selected.missing.map((id) => `${id}:missing-claim`);
      const reviewIds: string[] = [];
      for (const claim of selected.claims) {
        const contextId = contentRecord(claim)?.contextId;
        if (typeof contextId !== "string") {
          gaps.push(`${claim.objectId}:missing-context`);
          continue;
        }
        const qualifying = objects.filter((object) => {
          if (object.objectType !== "review") return false;
          const content = contentRecord(object);
          const claimRef = content !== undefined && typeof content.claimRef === "object" && content.claimRef !== null
            ? content.claimRef as Record<string, unknown>
            : undefined;
          const contextRef = content !== undefined && typeof content.contextRef === "object" && content.contextRef !== null
            ? content.contextRef as Record<string, unknown>
            : undefined;
          const reviewer = content !== undefined && typeof content.reviewer === "object" && content.reviewer !== null
            ? content.reviewer as Record<string, unknown>
            : undefined;
          const evidenceRefsCurrent = Array.isArray(content?.evidenceRefs) &&
            content.evidenceRefs.length > 0 &&
            content.evidenceRefs.every((reference) => {
              if (typeof reference !== "object" || reference === null || Array.isArray(reference)) {
                return false;
              }
              const ref = reference as Record<string, unknown>;
              const current = typeof ref.objectId === "string" ? objects.find(
                (candidate) => candidate.objectId === ref.objectId,
              ) : undefined;
              return current?.objectType === "evidence" && current.versionId === ref.versionId;
            });
          const sourceRefsCurrent = Array.isArray(content?.sourceRefs) &&
            content.sourceRefs.every((reference) => {
              if (typeof reference !== "object" || reference === null || Array.isArray(reference)) {
                return false;
              }
              const ref = reference as Record<string, unknown>;
              const current = typeof ref.objectId === "string" ? objects.find(
                (candidate) => candidate.objectId === ref.objectId,
              ) : undefined;
              return current?.objectType === "source" && current.versionId === ref.versionId;
            });
          return content?.kind === "independent-verification-review" &&
            content.outcome === "passed" &&
            evidenceRefsCurrent &&
            sourceRefsCurrent &&
            claimRef?.objectId === claim.objectId && claimRef.versionId === claim.versionId &&
            contextRef?.objectId === contextId &&
            (rule.requireFreshContext !== true || reviewer?.freshContext === true) &&
            (rule.requireAdversarial !== true || reviewer?.adversarial === true) &&
            (rule.requireCrossModelFamily !== true || reviewer?.crossModelFamily === true);
        });
        const reviewerIds = new Set(
          qualifying.flatMap((object) => {
            const reviewer = contentRecord(object)?.reviewer;
            return typeof reviewer === "object" && reviewer !== null &&
              typeof (reviewer as Record<string, unknown>).reviewerId === "string"
              ? [(reviewer as Record<string, unknown>).reviewerId as string]
              : [];
          }),
        );
        reviewIds.push(...qualifying.map((review) => review.objectId));
        if (reviewerIds.size < rule.minReviewers) {
          gaps.push(`${claim.objectId}:reviewers:${reviewerIds.size}/${rule.minReviewers}`);
        }
      }
      return result(
        rule,
        gaps.length === 0,
        gaps.length === 0
          ? `Every selected claim has at least ${rule.minReviewers} qualifying independent reviewer(s).`
          : `Independent review gaps: ${gaps.sort().join(", ")}.`,
        { objectIds: [...selected.claims.map((claim) => claim.objectId), ...reviewIds] },
      );
    }
    case "review_loop_clear": {
      const selected = claimsForRule(rule.claimIds, rule.allowExplicitConjectures, objects);
      const blocked = selected.missing.map((id) => `${id}:missing-claim`);
      const reviewIds: string[] = [];
      for (const claim of selected.claims) {
        const contextId = contentRecord(claim)?.contextId;
        if (typeof contextId !== "string") {
          blocked.push(`${claim.objectId}:missing-context`);
          continue;
        }
        const analysis = analyzeReviewLoop(projectRoot, {
          branchId,
          claimId: claim.objectId,
          contextId,
          ...(rule.repeatedObjectionLimit === undefined ? {} : { repeatedObjectionLimit: rule.repeatedObjectionLimit }),
          ...(rule.noNewEvidenceLimit === undefined ? {} : { noNewEvidenceLimit: rule.noNewEvidenceLimit }),
          ...(rule.claimCycleLimit === undefined ? {} : { claimCycleLimit: rule.claimCycleLimit }),
        });
        reviewIds.push(...analysis.reviewObjectIds);
        if (analysis.status !== "clear") {
          blocked.push(`${claim.objectId}:${analysis.signals.map((signal) => signal.code).join("+")}`);
        }
      }
      return result(
        rule,
        blocked.length === 0,
        blocked.length === 0
          ? "No selected claim is trapped in a detected review loop."
          : `Human escalation required: ${blocked.sort().join(", ")}.`,
        { objectIds: [...selected.claims.map((claim) => claim.objectId), ...reviewIds] },
      );
    }
    case "formal_alignment": {
      const selected = claimsForRule(rule.claimIds, rule.allowExplicitConjectures, objects);
      const gaps = selected.missing.map((id) => `${id}:missing-claim`);
      const alignmentIds: string[] = [];
      for (const claim of selected.claims) {
        const matching = objects.filter((object) => {
          if (object.objectType !== "alignment") return false;
          const content = contentRecord(object);
          const informal = content !== undefined && typeof content.informalClaimRef === "object" && content.informalClaimRef !== null
            ? content.informalClaimRef as Record<string, unknown>
            : undefined;
          const formal = content !== undefined && typeof content.formalClaimRef === "object" && content.formalClaimRef !== null
            ? content.formalClaimRef as Record<string, unknown>
            : undefined;
          const evidence = content !== undefined && typeof content.formalEvidenceRef === "object" && content.formalEvidenceRef !== null
            ? content.formalEvidenceRef as Record<string, unknown>
            : undefined;
          const context = content !== undefined && typeof content.contextRef === "object" && content.contextRef !== null
            ? content.contextRef as Record<string, unknown>
            : undefined;
          const currentFormal = typeof formal?.objectId === "string"
            ? objects.find((candidate) => candidate.objectId === formal.objectId)
            : undefined;
          const currentEvidence = typeof evidence?.objectId === "string"
            ? objects.find((candidate) => candidate.objectId === evidence.objectId)
            : undefined;
          const currentContext = typeof context?.objectId === "string"
            ? objects.find((candidate) => candidate.objectId === context.objectId)
            : undefined;
          return content?.kind === "formal-statement-alignment" &&
            content.outcome === "passed" &&
            informal?.objectId === claim.objectId && informal.versionId === claim.versionId &&
            currentFormal?.objectType === "claim" && currentFormal.versionId === formal?.versionId &&
            currentEvidence?.objectType === "evidence" && currentEvidence.versionId === evidence?.versionId &&
            currentContext?.objectType === "context" && currentContext.versionId === context?.versionId;
        });
        alignmentIds.push(...matching.map((alignment) => alignment.objectId));
        if (matching.length === 0) gaps.push(`${claim.objectId}:missing-current-alignment`);
      }
      return result(
        rule,
        gaps.length === 0,
        gaps.length === 0
          ? "Every selected informal claim has a current passed formal-statement alignment review."
          : `Formal alignment gaps: ${gaps.sort().join(", ")}.`,
        { objectIds: [...selected.claims.map((claim) => claim.objectId), ...alignmentIds] },
      );
    }
  }
}

/**
 * Evaluates every rule as a pure conjunction over one branch's accepted state.
 * The result contains no timestamp, actor, confidence, or caller-provided
 * status, so identical canonical state and policy produce identical output.
 */
export async function evaluateCompletionPolicy(
  projectRoot: string,
  options: EvaluateCompletionPolicyOptions,
): Promise<CompletionPolicyEvaluation> {
  nonEmptyString(options.branchId, "branchId");
  assertCompletionPolicy(options.policy);

  const inspection = await inspectProject(projectRoot);
  if (!inspection.branches.some((branch) => branch.branchId === options.branchId)) {
    throw new Error(`Branch does not exist: ${options.branchId}`);
  }
  const objects = inspection.objects
    .filter((object) => object.branchId === options.branchId)
    .sort((left, right) => left.objectId.localeCompare(right.objectId));
  const edges = inspection.edges
    .filter((edge) => edge.branchId === options.branchId)
    .sort((left, right) => left.edgeId.localeCompare(right.edgeId));
  const needsArtifacts = options.policy.rules.some((rule) => rule.kind === "artifact_count");
  const artifacts = needsArtifacts
    ? visibleArtifacts(await projectHistory(projectRoot), options.branchId)
    : [];
  const ruleResults = options.policy.rules.map((rule) =>
    evaluateRule(rule, objects, edges, artifacts, projectRoot, options.branchId),
  );

  return {
    policyId: options.policy.policyId,
    branchId: options.branchId,
    passed: ruleResults.every((rule) => rule.passed),
    ruleResults,
  };
}
