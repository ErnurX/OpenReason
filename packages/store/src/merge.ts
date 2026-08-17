import {
  ActorSchema,
  EdgeEnvelopeSchema,
  ObjectEnvelopeSchema,
  canonicalJson,
  createEvent,
  createId,
  type Actor,
  type EdgeEnvelope,
  type Event,
  type JsonValue,
  type ObjectEnvelope,
  type Sha256Digest,
} from "@reasoning-workbench/project-format";

import { appendEvent, readAcceptedEvents } from "./event-log.js";
import {
  addEdge,
  loadManifest,
  projectHistory,
  putObject,
} from "./project.js";
import { listBranches, rebuildProjection } from "./projection.js";

type BranchView = {
  objects: Map<string, ObjectEnvelope>;
  edges: Map<string, EdgeEnvelope>;
};

export type ObjectDiffStatus =
  | "source-only"
  | "target-only"
  | "converged"
  | "conflict";

export interface ObjectDiff {
  objectId: string;
  objectType?: string;
  status: ObjectDiffStatus;
  baseVersionId?: string;
  sourceVersionId?: string;
  targetVersionId?: string;
  baseContentHash?: string;
  sourceContentHash?: string;
  targetContentHash?: string;
}

export interface BranchDiff {
  sourceBranchId: string;
  targetBranchId: string;
  baseSequence: number;
  objectChanges: ObjectDiff[];
  sourceOnlyEdgeIds: string[];
  targetOnlyEdgeIds: string[];
}

export interface SafeMergeResult extends BranchDiff {
  mergeId: string;
  status: "merged" | "conflicted";
  appliedObjectVersionIds: string[];
  adoptedEdgeIds: string[];
  conflictObjectIds: string[];
  event: Event;
}

interface MergeAnalysis {
  diff: BranchDiff;
  sourceView: BranchView;
}

const SYSTEM_ACTOR: Actor = ActorSchema.parse({
  actorType: "system",
  actorId: createId("sys"),
});

const OBJECT_ENVELOPE_KEYS = new Set([
  "objectId",
  "objectType",
  "versionId",
  "version",
  "createdAt",
  "createdBy",
  "branchId",
  "content",
  "contentHash",
  "supersedesVersionId",
]);

const EDGE_ENVELOPE_KEYS = new Set([
  "edgeId",
  "edgeType",
  "from",
  "to",
  "contextId",
  "createdAt",
  "createdBy",
  "metadata",
]);

function emptyView(): BranchView {
  return { objects: new Map(), edges: new Map() };
}

function cloneView(view: BranchView): BranchView {
  return {
    objects: new Map(view.objects),
    edges: new Map(view.edges),
  };
}

function sortedUnion<T>(left: Iterable<T>, right: Iterable<T>): T[] {
  return [...new Set([...left, ...right])].sort((a, b) =>
    String(a).localeCompare(String(b)),
  );
}

async function replayBranchViews(projectRoot: string): Promise<{
  views: Map<string, BranchView>;
  bases: Map<string, BranchView>;
}> {
  const views = new Map<string, BranchView>();
  const bases = new Map<string, BranchView>();
  for (const event of await projectHistory(projectRoot)) {
    if (event.eventType === "BranchCreated") {
      const branchId = event.payload.branchId;
      const baseBranchId = event.payload.baseBranchId;
      if (typeof branchId !== "string") continue;
      const base =
        typeof baseBranchId === "string"
          ? cloneView(views.get(baseBranchId) ?? emptyView())
          : emptyView();
      views.set(branchId, cloneView(base));
      bases.set(branchId, base);
      continue;
    }
    if (event.eventType === "ObjectVersionCreated") {
      const parsed = ObjectEnvelopeSchema.safeParse(event.payload.object);
      if (!parsed.success) continue;
      const view = views.get(parsed.data.branchId);
      view?.objects.set(parsed.data.objectId, parsed.data);
      continue;
    }
    if (event.eventType === "EdgeCreated" && event.branchId !== undefined) {
      const parsed = EdgeEnvelopeSchema.safeParse(event.payload.edge);
      if (!parsed.success) continue;
      views.get(event.branchId)?.edges.set(parsed.data.edgeId, parsed.data);
      continue;
    }
  }
  return { views, bases };
}

function mergeEdgeProvenance(
  edge: EdgeEnvelope,
): { sourceBranchId: string; sourceEdgeId: string } | undefined {
  const provenance = edge["x-rw:merge"];
  if (
    typeof provenance !== "object" ||
    provenance === null ||
    Array.isArray(provenance)
  ) {
    return undefined;
  }
  const fields = provenance as Record<string, unknown>;
  return typeof fields.sourceBranchId === "string" &&
    typeof fields.sourceEdgeId === "string"
    ? {
        sourceBranchId: fields.sourceBranchId,
        sourceEdgeId: fields.sourceEdgeId,
      }
    : undefined;
}

function sameLogicalEdge(left: EdgeEnvelope, right: EdgeEnvelope): boolean {
  return (
    left.edgeType === right.edgeType &&
    left.from.objectId === right.from.objectId &&
    left.to.objectId === right.to.objectId &&
    left.contextId === right.contextId &&
    canonicalJson(left.metadata) === canonicalJson(right.metadata)
  );
}

function summary(
  objectId: string,
  status: ObjectDiffStatus,
  base: ObjectEnvelope | undefined,
  source: ObjectEnvelope | undefined,
  target: ObjectEnvelope | undefined,
): ObjectDiff {
  return {
    objectId,
    ...((source ?? target ?? base) === undefined
      ? {}
      : { objectType: (source ?? target ?? base)!.objectType }),
    status,
    ...(base === undefined
      ? {}
      : {
          baseVersionId: base.versionId,
          baseContentHash: base.contentHash,
        }),
    ...(source === undefined
      ? {}
      : {
          sourceVersionId: source.versionId,
          sourceContentHash: source.contentHash,
        }),
    ...(target === undefined
      ? {}
      : {
          targetVersionId: target.versionId,
          targetContentHash: target.contentHash,
        }),
  };
}

async function analyzeMerge(
  projectRoot: string,
  sourceBranchId: string,
  targetBranchId: string,
): Promise<MergeAnalysis> {
  const branches = listBranches(projectRoot);
  const sourceBranch = branches.find((branch) => branch.branchId === sourceBranchId);
  const targetBranch = branches.find((branch) => branch.branchId === targetBranchId);
  if (sourceBranch === undefined || targetBranch === undefined) {
    throw new Error("Source and target branches must exist");
  }
  if (sourceBranch.parentBranchId !== targetBranchId) {
    throw new Error(
      "Stage 2 safe merge supports a direct child branch back into its parent",
    );
  }
  const { views, bases } = await replayBranchViews(projectRoot);
  const sourceView = views.get(sourceBranchId);
  const targetView = views.get(targetBranchId);
  const baseView = bases.get(sourceBranchId);
  if (sourceView === undefined || targetView === undefined || baseView === undefined) {
    throw new Error("Cannot reconstruct branch snapshots from canonical history");
  }

  const objectChanges: ObjectDiff[] = [];
  for (const objectId of sortedUnion(
    sortedUnion(baseView.objects.keys(), sourceView.objects.keys()),
    targetView.objects.keys(),
  )) {
    const base = baseView.objects.get(objectId);
    const source = sourceView.objects.get(objectId);
    const target = targetView.objects.get(objectId);
    const sourceChanged = source?.versionId !== base?.versionId;
    const targetChanged = target?.versionId !== base?.versionId;
    if (!sourceChanged && !targetChanged) continue;
    let status: ObjectDiffStatus;
    if (sourceChanged && !targetChanged) status = "source-only";
    else if (!sourceChanged && targetChanged) status = "target-only";
    else if (
      source !== undefined &&
      target !== undefined &&
      source.objectType === target.objectType &&
      source.contentHash === target.contentHash
    ) {
      status = "converged";
    } else status = "conflict";
    objectChanges.push(summary(objectId, status, base, source, target));
  }

  const targetCopiesBySource = new Set(
    [...targetView.edges.values()]
      .map((targetEdge) => {
        const provenance = mergeEdgeProvenance(targetEdge);
        if (provenance?.sourceBranchId !== sourceBranchId) return undefined;
        const sourceEdge = sourceView.edges.get(provenance.sourceEdgeId);
        return sourceEdge !== undefined && sameLogicalEdge(sourceEdge, targetEdge)
          ? provenance.sourceEdgeId
          : undefined;
      })
      .filter((edgeId): edgeId is string => edgeId !== undefined),
  );

  return {
    diff: {
      sourceBranchId,
      targetBranchId,
      baseSequence: sourceBranch.baseSequence,
      objectChanges,
      sourceOnlyEdgeIds: [...sourceView.edges.keys()]
        .filter(
          (edgeId) =>
            !targetView.edges.has(edgeId) && !targetCopiesBySource.has(edgeId),
        )
        .sort(),
      targetOnlyEdgeIds: [...targetView.edges.keys()]
        .filter((edgeId) => {
          if (sourceView.edges.has(edgeId)) return false;
          const targetEdge = targetView.edges.get(edgeId)!;
          const provenance = mergeEdgeProvenance(targetEdge);
          if (provenance?.sourceBranchId !== sourceBranchId) return true;
          const sourceEdge = sourceView.edges.get(provenance.sourceEdgeId);
          return sourceEdge === undefined || !sameLogicalEdge(sourceEdge, targetEdge);
        })
        .sort(),
    },
    sourceView,
  };
}

export async function diffBranches(
  projectRoot: string,
  sourceBranchId: string,
  targetBranchId: string,
): Promise<BranchDiff> {
  return (await analyzeMerge(projectRoot, sourceBranchId, targetBranchId)).diff;
}

function mergeExtensions(
  source: ObjectEnvelope,
  sourceBranchId: string,
  mergeId: string,
): Record<string, unknown> {
  const extensions: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (!OBJECT_ENVELOPE_KEYS.has(key) && (key.includes(":") || key.startsWith("x-"))) {
      extensions[key] = value;
    }
  }
  extensions["x-rw:merge"] = {
    mergeId,
    sourceBranchId,
    sourceVersionId: source.versionId,
  };
  return extensions;
}

function mergeEdgeExtensions(
  source: EdgeEnvelope,
  sourceBranchId: string,
  mergeId: string,
): Record<string, unknown> {
  const extensions: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (!EDGE_ENVELOPE_KEYS.has(key) && (key.includes(":") || key.startsWith("x-"))) {
      extensions[key] = value;
    }
  }
  extensions["x-rw:merge"] = {
    mergeId,
    sourceBranchId,
    sourceEdgeId: source.edgeId,
  };
  return extensions;
}

async function appendBranchMerged(
  projectRoot: string,
  actor: Actor,
  targetBranchId: string,
  payload: Record<string, unknown>,
): Promise<Event> {
  const manifest = await loadManifest(projectRoot);
  const events = await readAcceptedEvents(projectRoot, manifest);
  const previous = events.at(-1);
  const event = createEvent({
    sequence: (previous?.sequence ?? 0) + 1,
    eventType: "BranchMerged",
    projectId: manifest.projectId,
    branchId: targetBranchId,
    actor,
    payload: payload as Record<string, JsonValue>,
    ...(previous === undefined
      ? {}
      : { previousEventHash: previous.eventHash as Sha256Digest }),
  });
  const appended = await appendEvent(projectRoot, event);
  await rebuildProjection(projectRoot);
  return appended.event;
}

export async function mergeBranchSafe(
  projectRoot: string,
  options: {
    sourceBranchId: string;
    targetBranchId: string;
    actor?: Actor;
  },
): Promise<SafeMergeResult> {
  const actor = ActorSchema.parse(options.actor ?? SYSTEM_ACTOR);
  const analysis = await analyzeMerge(
    projectRoot,
    options.sourceBranchId,
    options.targetBranchId,
  );
  const branches = listBranches(projectRoot);
  const source = branches.find(
    (branch) => branch.branchId === options.sourceBranchId,
  )!;
  const target = branches.find(
    (branch) => branch.branchId === options.targetBranchId,
  )!;
  const mergeId = createId("mrg");
  const conflicts = analysis.diff.objectChanges.filter(
    (change) => change.status === "conflict",
  );
  const appliedObjectVersionIds: string[] = [];
  const conflictObjectIds: string[] = [];
  let adoptedEdgeIds: string[] = [];
  let status: "merged" | "conflicted" = "merged";

  if (conflicts.length > 0) {
    status = "conflicted";
    for (const conflict of conflicts) {
      const failure = await putObject(projectRoot, {
        branchId: options.targetBranchId,
        objectType: "failure",
        actor,
        content: {
          kind: "merge-conflict",
          status: "open",
          mergeId,
          sourceBranchId: options.sourceBranchId,
          targetBranchId: options.targetBranchId,
          objectId: conflict.objectId,
          ...(conflict.baseVersionId === undefined
            ? {}
            : { baseVersionId: conflict.baseVersionId }),
          ...(conflict.sourceVersionId === undefined
            ? {}
            : { sourceVersionId: conflict.sourceVersionId }),
          ...(conflict.targetVersionId === undefined
            ? {}
            : { targetVersionId: conflict.targetVersionId }),
          reason: "Both branches changed the same object to different content",
        },
        extensions: { "x-rw:merge": { mergeId } },
      });
      conflictObjectIds.push(failure.objectId);
    }
  } else {
    for (const change of analysis.diff.objectChanges) {
      if (change.status !== "source-only") continue;
      const sourceObject = analysis.sourceView.objects.get(change.objectId);
      if (sourceObject === undefined) {
        throw new Error(`Stage 2 does not support object deletion: ${change.objectId}`);
      }
      const applied = await putObject(projectRoot, {
        branchId: options.targetBranchId,
        objectId: sourceObject.objectId,
        objectType: sourceObject.objectType,
        content: sourceObject.content,
        actor,
        extensions: mergeExtensions(
          sourceObject,
          options.sourceBranchId,
          mergeId,
        ),
      });
      appliedObjectVersionIds.push(applied.versionId);
    }
    for (const sourceEdgeId of analysis.diff.sourceOnlyEdgeIds) {
      const sourceEdge = analysis.sourceView.edges.get(sourceEdgeId);
      if (sourceEdge === undefined) {
        throw new Error(`Source edge disappeared during merge: ${sourceEdgeId}`);
      }
      const adopted = await addEdge(projectRoot, {
        branchId: options.targetBranchId,
        edgeType: sourceEdge.edgeType,
        fromObjectId: sourceEdge.from.objectId,
        toObjectId: sourceEdge.to.objectId,
        ...(sourceEdge.contextId === undefined
          ? {}
          : { contextId: sourceEdge.contextId }),
        metadata: sourceEdge.metadata,
        actor,
        extensions: mergeEdgeExtensions(
          sourceEdge,
          options.sourceBranchId,
          mergeId,
        ),
      });
      adoptedEdgeIds.push(adopted.edgeId);
    }
  }

  const event = await appendBranchMerged(
    projectRoot,
    actor,
    options.targetBranchId,
    {
      mergeId,
      sourceBranchId: options.sourceBranchId,
      targetBranchId: options.targetBranchId,
      baseSequence: source.baseSequence,
      sourceHeadSequence: source.headSequence,
      targetHeadSequenceBefore: target.headSequence,
      strategy: "safe",
      status,
      appliedObjectVersionIds,
      adoptedEdgeIds,
      conflictObjectIds,
    },
  );

  return {
    ...analysis.diff,
    mergeId,
    status,
    appliedObjectVersionIds,
    adoptedEdgeIds,
    conflictObjectIds,
    event,
  };
}
