import {
  EDGE_TYPES,
  OBJECT_TYPES,
  type EdgeType,
  type Event,
  type ObjectType,
} from "@reasoning-workbench/project-format";

import { inspectProject, projectHistory } from "./project.js";
import type { EdgeProjection, ObjectProjection } from "./projection.js";

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
  | ArtifactCountRule;

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

function evaluateRule(
  rule: CompletionRule,
  objects: readonly ObjectProjection[],
  edges: readonly EdgeProjection[],
  artifacts: readonly VisibleArtifact[],
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
    evaluateRule(rule, objects, edges, artifacts),
  );

  return {
    policyId: options.policy.policyId,
    branchId: options.branchId,
    passed: ruleResults.every((rule) => rule.passed),
    ruleResults,
  };
}
