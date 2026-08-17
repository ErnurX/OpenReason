import type {
  EdgeType,
  ObjectType,
} from "@reasoning-workbench/project-format";

import {
  getObjectHistory,
  listCurrentObjects,
  listEdges,
  type EdgeProjection,
  type ObjectProjection,
} from "./projection.js";

export type EdgePropagationDirection = "from-to" | "to-from";

/**
 * Direction in which a change propagates through each canonical edge type.
 *
 * `to-from` means that `edge.from` depends on `edge.to`; `from-to` means that
 * the evidence/review at `edge.from` can change the interpretation of
 * `edge.to`. `supersedes` treats the superseded object as upstream of its
 * replacement.
 */
export const EDGE_PROPAGATION_DIRECTION = Object.freeze({
  depends_on: "to-from",
  uses_definition: "to-from",
  supports: "from-to",
  refutes: "from-to",
  derived_from: "to-from",
  tested_by: "to-from",
  formalizes: "to-from",
  cites: "to-from",
  produced_by: "to-from",
  contradicts: "from-to",
  supersedes: "to-from",
} as const satisfies Record<EdgeType, EdgePropagationDirection>);

export interface QueryGraphOptions {
  branchId: string;
  objectTypes?: readonly ObjectType[];
  edgeTypes?: readonly EdgeType[];
  contextId?: string;
}

export interface GraphQueryResult {
  branchId: string;
  objects: ObjectProjection[];
  edges: EdgeProjection[];
}

export interface TraverseGraphOptions {
  branchId: string;
  startObjectIds: readonly string[];
  direction: "upstream" | "downstream" | "both";
  edgeTypes?: readonly EdgeType[];
  maxDepth?: number;
}

export interface GraphPathStep {
  edgeId: string;
  edgeType: EdgeType;
  sourceObjectId: string;
  targetObjectId: string;
  sourceVersionId?: string;
  targetVersionId?: string;
  edgeFromObjectId: string;
  edgeToObjectId: string;
  edgeFromVersionId?: string;
  edgeToVersionId?: string;
  traversal: EdgePropagationDirection;
}

export interface GraphTraversalVisit {
  object: ObjectProjection;
  depth: number;
  path: GraphPathStep[];
}

export interface GraphTraversalResult {
  branchId: string;
  direction: TraverseGraphOptions["direction"];
  startObjectIds: string[];
  visits: GraphTraversalVisit[];
}

export interface ImpactReason {
  changedObjectId: string;
  depth: number;
  path: GraphPathStep[];
}

export interface ImpactedObject {
  object: ObjectProjection;
  depth: number;
  reasons: ImpactReason[];
}

export interface ImpactResult {
  branchId: string;
  changedObjects: ObjectProjection[];
  affected: ImpactedObject[];
}

export interface StalenessClassification {
  classification: "changed-input" | "stale-dependent";
  objectId: string;
  objectType: string;
  branchId: string;
  versionId: string;
  version: number;
  lineageVersionIds: string[];
  depth: number;
  edgePaths: GraphPathStep[][];
}

export interface StalenessReport {
  branchId: string;
  classifications: StalenessClassification[];
}

interface AdjacencyStep {
  targetObjectId: string;
  pathStep: GraphPathStep;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareObjects(left: ObjectProjection, right: ObjectProjection): number {
  return compareStrings(left.objectId, right.objectId);
}

function compareEdges(left: EdgeProjection, right: EdgeProjection): number {
  return compareStrings(left.edgeId, right.edgeId);
}

function edgeContextId(edge: EdgeProjection): string | undefined {
  const contextId = edge.envelope.contextId;
  return typeof contextId === "string" ? contextId : undefined;
}

function asKnownEdgeType(edge: EdgeProjection): EdgeType | undefined {
  return Object.prototype.hasOwnProperty.call(
    EDGE_PROPAGATION_DIRECTION,
    edge.edgeType,
  )
    ? (edge.edgeType as EdgeType)
    : undefined;
}

export function queryGraph(
  projectRoot: string,
  options: QueryGraphOptions,
): GraphQueryResult {
  const objectTypeFilter =
    options.objectTypes === undefined ? undefined : new Set(options.objectTypes);
  const edgeTypeFilter =
    options.edgeTypes === undefined ? undefined : new Set(options.edgeTypes);

  const objects = listCurrentObjects(projectRoot, options.branchId)
    .filter(
      (object) =>
        objectTypeFilter === undefined ||
        objectTypeFilter.has(object.objectType as ObjectType),
    )
    .sort(compareObjects);
  const selectedObjectIds = new Set(objects.map((object) => object.objectId));
  const edges = listEdges(projectRoot, options.branchId)
    .filter(
      (edge) =>
        (edgeTypeFilter === undefined ||
          edgeTypeFilter.has(edge.edgeType as EdgeType)) &&
        (options.contextId === undefined ||
          edgeContextId(edge) === options.contextId) &&
        selectedObjectIds.has(edge.fromObjectId) &&
        selectedObjectIds.has(edge.toObjectId),
    )
    .sort(compareEdges);

  return { branchId: options.branchId, objects, edges };
}

function validateTraversalOptions(options: TraverseGraphOptions): void {
  if (options.startObjectIds.length === 0) {
    throw new Error("startObjectIds must contain at least one object ID");
  }
  if (
    options.maxDepth !== undefined &&
    (!Number.isSafeInteger(options.maxDepth) || options.maxDepth < 0)
  ) {
    throw new Error("maxDepth must be a non-negative safe integer");
  }
}

function pathStep(
  edge: EdgeProjection,
  traversal: EdgePropagationDirection,
): GraphPathStep {
  const edgeType = asKnownEdgeType(edge);
  if (edgeType === undefined) {
    throw new Error(`Unsupported edge type in graph projection: ${edge.edgeType}`);
  }
  const followsStoredDirection = traversal === "from-to";
  const sourceVersionId = followsStoredDirection
    ? edge.fromVersionId
    : edge.toVersionId;
  const targetVersionId = followsStoredDirection
    ? edge.toVersionId
    : edge.fromVersionId;

  return {
    edgeId: edge.edgeId,
    edgeType,
    sourceObjectId: followsStoredDirection
      ? edge.fromObjectId
      : edge.toObjectId,
    targetObjectId: followsStoredDirection
      ? edge.toObjectId
      : edge.fromObjectId,
    ...(sourceVersionId === undefined ? {} : { sourceVersionId }),
    ...(targetVersionId === undefined ? {} : { targetVersionId }),
    edgeFromObjectId: edge.fromObjectId,
    edgeToObjectId: edge.toObjectId,
    ...(edge.fromVersionId === undefined
      ? {}
      : { edgeFromVersionId: edge.fromVersionId }),
    ...(edge.toVersionId === undefined
      ? {}
      : { edgeToVersionId: edge.toVersionId }),
    traversal,
  };
}

function addAdjacency(
  adjacency: Map<string, AdjacencyStep[]>,
  edge: EdgeProjection,
  traversal: EdgePropagationDirection,
): void {
  const step = pathStep(edge, traversal);
  const steps = adjacency.get(step.sourceObjectId) ?? [];
  steps.push({ targetObjectId: step.targetObjectId, pathStep: step });
  adjacency.set(step.sourceObjectId, steps);
}

function adjacencyFor(
  edges: readonly EdgeProjection[],
  direction: TraverseGraphOptions["direction"],
): Map<string, AdjacencyStep[]> {
  const adjacency = new Map<string, AdjacencyStep[]>();
  for (const edge of edges) {
    const edgeType = asKnownEdgeType(edge);
    if (edgeType === undefined) continue;
    const downstream = EDGE_PROPAGATION_DIRECTION[edgeType];
    const upstream: EdgePropagationDirection =
      downstream === "from-to" ? "to-from" : "from-to";
    if (direction === "downstream" || direction === "both") {
      addAdjacency(adjacency, edge, downstream);
    }
    if (direction === "upstream" || direction === "both") {
      addAdjacency(adjacency, edge, upstream);
    }
  }
  for (const steps of adjacency.values()) {
    steps.sort(
      (left, right) =>
        compareStrings(left.targetObjectId, right.targetObjectId) ||
        compareStrings(left.pathStep.edgeType, right.pathStep.edgeType) ||
        compareStrings(left.pathStep.edgeId, right.pathStep.edgeId) ||
        compareStrings(left.pathStep.traversal, right.pathStep.traversal),
    );
  }
  return adjacency;
}

export function traverseGraph(
  projectRoot: string,
  options: TraverseGraphOptions,
): GraphTraversalResult {
  validateTraversalOptions(options);
  const objects = listCurrentObjects(projectRoot, options.branchId);
  const objectsById = new Map(objects.map((object) => [object.objectId, object]));
  const startObjectIds = [...new Set(options.startObjectIds)].sort(compareStrings);
  for (const objectId of startObjectIds) {
    if (!objectsById.has(objectId)) {
      throw new Error(
        `Start object ${objectId} is not visible on branch ${options.branchId}`,
      );
    }
  }

  const edgeTypeFilter =
    options.edgeTypes === undefined ? undefined : new Set(options.edgeTypes);
  const edges = listEdges(projectRoot, options.branchId).filter(
    (edge) =>
      asKnownEdgeType(edge) !== undefined &&
      (edgeTypeFilter === undefined ||
        edgeTypeFilter.has(edge.edgeType as EdgeType)),
  );
  const adjacency = adjacencyFor(edges, options.direction);
  const visitsById = new Map<string, GraphTraversalVisit>();
  const queue: string[] = [];

  for (const objectId of startObjectIds) {
    const object = objectsById.get(objectId);
    if (object === undefined) continue;
    visitsById.set(objectId, { object, depth: 0, path: [] });
    queue.push(objectId);
  }

  let queueIndex = 0;
  while (queueIndex < queue.length) {
    const objectId = queue[queueIndex];
    queueIndex += 1;
    if (objectId === undefined) continue;
    const visit = visitsById.get(objectId);
    if (visit === undefined || visit.depth >= (options.maxDepth ?? Infinity)) {
      continue;
    }
    for (const step of adjacency.get(objectId) ?? []) {
      if (visitsById.has(step.targetObjectId)) continue;
      const object = objectsById.get(step.targetObjectId);
      if (object === undefined) continue;
      visitsById.set(step.targetObjectId, {
        object,
        depth: visit.depth + 1,
        path: [...visit.path, step.pathStep],
      });
      queue.push(step.targetObjectId);
    }
  }

  const visits = [...visitsById.values()].sort(
    (left, right) =>
      left.depth - right.depth || compareObjects(left.object, right.object),
  );
  return {
    branchId: options.branchId,
    direction: options.direction,
    startObjectIds,
    visits,
  };
}

export function computeImpact(
  projectRoot: string,
  options: { branchId: string; changedObjectIds: readonly string[] },
): ImpactResult {
  if (options.changedObjectIds.length === 0) {
    throw new Error("changedObjectIds must contain at least one object ID");
  }
  const changedObjectIds = [...new Set(options.changedObjectIds)].sort(compareStrings);
  const currentObjects = listCurrentObjects(projectRoot, options.branchId);
  const objectsById = new Map(
    currentObjects.map((object) => [object.objectId, object]),
  );
  const changedObjects = changedObjectIds.map((objectId) => {
    const object = objectsById.get(objectId);
    if (object === undefined) {
      throw new Error(
        `Changed object ${objectId} is not visible on branch ${options.branchId}`,
      );
    }
    return object;
  });

  const reasonsByObjectId = new Map<string, ImpactReason[]>();
  for (const changedObjectId of changedObjectIds) {
    const traversal = traverseGraph(projectRoot, {
      branchId: options.branchId,
      startObjectIds: [changedObjectId],
      direction: "downstream",
    });
    for (const visit of traversal.visits) {
      if (visit.depth === 0 || changedObjectIds.includes(visit.object.objectId)) {
        continue;
      }
      const reasons = reasonsByObjectId.get(visit.object.objectId) ?? [];
      reasons.push({
        changedObjectId,
        depth: visit.depth,
        path: visit.path,
      });
      reasonsByObjectId.set(visit.object.objectId, reasons);
    }
  }

  const affected = [...reasonsByObjectId.entries()]
    .map(([objectId, reasons]): ImpactedObject => {
      reasons.sort(
        (left, right) =>
          left.depth - right.depth ||
          compareStrings(left.changedObjectId, right.changedObjectId),
      );
      const object = objectsById.get(objectId);
      if (object === undefined) {
        throw new Error(`Impacted object disappeared from projection: ${objectId}`);
      }
      return { object, depth: reasons[0]?.depth ?? 0, reasons };
    })
    .sort(
      (left, right) =>
        left.depth - right.depth || compareObjects(left.object, right.object),
    );

  return { branchId: options.branchId, changedObjects, affected };
}

function lineageVersionIds(
  projectRoot: string,
  object: ObjectProjection,
): string[] {
  const history = new Map(
    getObjectHistory(projectRoot, object.objectId).map((version) => [
      version.versionId,
      version,
    ]),
  );
  const lineage: string[] = [];
  const seen = new Set<string>();
  let versionId: string | undefined = object.versionId;
  while (versionId !== undefined && !seen.has(versionId)) {
    seen.add(versionId);
    lineage.push(versionId);
    const version = history.get(versionId);
    const supersedesVersionId = version?.envelope.supersedesVersionId;
    versionId =
      typeof supersedesVersionId === "string"
        ? supersedesVersionId
        : undefined;
  }
  return lineage;
}

function classification(
  projectRoot: string,
  object: ObjectProjection,
  kind: StalenessClassification["classification"],
  depth: number,
  edgePaths: GraphPathStep[][],
): StalenessClassification {
  return {
    classification: kind,
    objectId: object.objectId,
    objectType: object.objectType,
    branchId: object.branchId,
    versionId: object.versionId,
    version: object.version,
    lineageVersionIds: lineageVersionIds(projectRoot, object),
    depth,
    edgePaths,
  };
}

/**
 * Computes a derived staleness view only. It deliberately appends no event and
 * mutates neither canonical state nor the disposable SQLite projection.
 */
export function deriveStaleness(
  projectRoot: string,
  options: { branchId: string; changedObjectIds: readonly string[] },
): StalenessReport {
  const impact = computeImpact(projectRoot, options);
  const classifications = [
    ...impact.changedObjects.map((object) =>
      classification(projectRoot, object, "changed-input", 0, []),
    ),
    ...impact.affected.map((affected) =>
      classification(
        projectRoot,
        affected.object,
        "stale-dependent",
        affected.depth,
        affected.reasons.map((reason) => reason.path),
      ),
    ),
  ].sort(
    (left, right) =>
      left.depth - right.depth || compareStrings(left.objectId, right.objectId),
  );
  return { branchId: options.branchId, classifications };
}
