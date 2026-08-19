export function formatProjectInfo(info: any): string {
  const manifest = info.manifest ?? {};
  const branches = info.branches ?? [];
  const lines: string[] = [];

  lines.push(`========================================================`);
  lines.push(` Project: ${manifest.title ?? "Untitled"}`);
  lines.push(`========================================================`);
  lines.push(`  Project ID:     ${manifest.projectId ?? "unknown"}`);
  lines.push(`  Default Branch: ${manifest.defaultBranchId ?? "unknown"}`);
  lines.push(`  Schema Version: ${manifest.schemaVersion ?? "unknown"}`);
  if (manifest.createdAt) {
    lines.push(`  Created At:     ${manifest.createdAt}`);
  }
  lines.push(``);
  lines.push(` Branches (${branches.length}):`);
  for (const b of branches) {
    const isDefault = b.branchId === manifest.defaultBranchId ? " (default)" : "";
    lines.push(`   * ${b.name ?? b.branchId} [${b.branchId}]${isDefault}`);
  }
  lines.push(``);
  if (info.objects !== undefined) {
    lines.push(` Objects in projection: ${info.objects.length}`);
  }
  if (info.edges !== undefined) {
    lines.push(` Edges in projection:   ${info.edges.length}`);
  }
  return lines.join("\n");
}

export function formatProjectHistory(history: any): string {
  const events = history.events ?? (Array.isArray(history) ? history : []);
  const lines: string[] = [];

  lines.push(`========================================================`);
  lines.push(` Project History (${events.length} events)`);
  lines.push(`========================================================`);
  for (const ev of events) {
    const seq = ev.sequenceNumber !== undefined ? `#${ev.sequenceNumber}` : "#?";
    const type = ev.type ?? "unknown";
    const ts = ev.timestamp ?? "";
    const branch = ev.branchId ? ` [branch: ${ev.branchId}]` : "";
    lines.push(`  ${seq.padEnd(6)} ${ts.padEnd(25)} ${type}${branch}`);
  }
  return lines.join("\n");
}

export function formatGraphQuery(result: any): string {
  const objects = result.objects ?? [];
  const edges = result.edges ?? [];
  const lines: string[] = [];

  lines.push(`========================================================`);
  lines.push(` Graph Query: ${objects.length} Objects, ${edges.length} Edges`);
  lines.push(`========================================================`);

  if (objects.length > 0) {
    lines.push(` Objects:`);
    for (const obj of objects) {
      const type = obj.type ?? obj.objectType ?? "object";
      const id = obj.objectId ?? obj.id ?? "unknown";
      const ver = obj.version !== undefined ? ` v${obj.version}` : "";
      lines.push(`   * [${type.toUpperCase()}] ${id}${ver}`);
    }
    lines.push(``);
  }

  if (edges.length > 0) {
    lines.push(` Edges:`);
    for (const edge of edges) {
      const type = edge.edgeType ?? edge.type ?? "edge";
      const from = edge.fromObjectId ?? edge.from ?? "?";
      const to = edge.toObjectId ?? edge.to ?? "?";
      const ctx = edge.contextId ? ` (context: ${edge.contextId})` : "";
      lines.push(`   * ${from} --[${type}]--> ${to}${ctx}`);
    }
  }
  return lines.join("\n");
}

export function formatGraphTraverse(result: any): string {
  const starts = result.startObjectIds ?? [];
  const direction = result.direction ?? "unknown";
  const visited = result.visitedObjects ?? result.objects ?? [];
  const edges = result.traversedEdges ?? result.edges ?? [];
  const lines: string[] = [];

  lines.push(`========================================================`);
  lines.push(` Graph Traversal (${direction}) from [${starts.join(", ")}]`);
  lines.push(`========================================================`);
  lines.push(` Reached ${visited.length} objects across ${edges.length} edges:`);
  for (const obj of visited) {
    const type = obj.type ?? obj.objectType ?? "object";
    const id = obj.objectId ?? obj.id ?? "unknown";
    lines.push(`   * [${type}] ${id}`);
  }
  return lines.join("\n");
}

export function formatImpact(impact: any): string {
  const staleObjects = impact.staleObjects ?? impact.affectedObjects ?? [];
  const lines: string[] = [];

  lines.push(`========================================================`);
  lines.push(` Impact Analysis: ${staleObjects.length} Affected Objects`);
  lines.push(`========================================================`);

  if (staleObjects.length === 0) {
    lines.push(`  No downstream objects are affected.`);
  } else {
    for (const obj of staleObjects) {
      const id = obj.objectId ?? obj.id ?? obj;
      const reason = obj.reason ? ` - ${obj.reason}` : "";
      const path = obj.path ? ` (path: ${Array.isArray(obj.path) ? obj.path.join(" -> ") : obj.path})` : "";
      lines.push(`   ! ${id}${reason}${path}`);
    }
  }
  return lines.join("\n");
}

export function formatStaleness(staleness: any): string {
  const staleObjects = staleness.staleObjects ?? staleness.stale ?? [];
  const lines: string[] = [];

  lines.push(`========================================================`);
  lines.push(` Staleness Report: ${staleObjects.length} Stale Objects`);
  lines.push(`========================================================`);

  if (staleObjects.length === 0) {
    lines.push(`  All objects are up to date.`);
  } else {
    for (const obj of staleObjects) {
      const id = typeof obj === "string" ? obj : (obj.objectId ?? obj.id ?? JSON.stringify(obj));
      const cause = obj.cause ? ` (caused by ${obj.cause})` : "";
      lines.push(`   ! ${id}${cause}`);
    }
  }
  return lines.join("\n");
}

export function formatVerificationProfile(profile: any): string {
  const lines: string[] = [];
  lines.push(`========================================================`);
  lines.push(` Verification Profile for Claim: ${profile.claimId ?? "unknown"}`);
  lines.push(` Context: ${profile.contextId ?? "unknown"}`);
  lines.push(`========================================================`);

  const dimensions = profile.dimensions ?? profile.vector ?? profile;
  const dimensionKeys = [
    "logical",
    "symbolic",
    "numerical",
    "source",
    "reproduction",
    "physical",
    "formal",
  ];

  lines.push(` Dimensions:`);
  for (const key of dimensionKeys) {
    const dim = dimensions[key] ?? { status: "missing" };
    const status = (dim.status ?? (dim.outcome ? dim.outcome : "missing")).toUpperCase();
    const tag = `[${status}]`.padEnd(16);
    const summary = dim.summary ? ` - ${dim.summary}` : "";
    lines.push(`   ${key.padEnd(14)} ${tag}${summary}`);
  }

  if (profile.unresolvedGaps && profile.unresolvedGaps.length > 0) {
    lines.push(``);
    lines.push(` Unresolved Gaps (${profile.unresolvedGaps.length}):`);
    for (const gap of profile.unresolvedGaps) {
      lines.push(`   * ${gap.summary ?? gap.gapId ?? JSON.stringify(gap)}`);
    }
  }
  return lines.join("\n");
}

export function formatPaperInspect(paper: any): string {
  const lines: string[] = [];
  lines.push(`========================================================`);
  lines.push(` Working Paper: ${paper.title ?? paper.paperId ?? "Untitled"}`);
  lines.push(`========================================================`);
  if (paper.paperId) lines.push(`  Paper ID:      ${paper.paperId}`);
  if (paper.version !== undefined) lines.push(`  Version:       ${paper.version}`);
  if (paper.sections) lines.push(`  Sections:      ${paper.sections.length}`);
  if (paper.transclusions) lines.push(`  Transclusions: ${paper.transclusions.length}`);
  if (paper.artifacts) lines.push(`  Artifacts:     ${paper.artifacts.length}`);
  if (paper.gaps) lines.push(`  Open Gaps:     ${paper.gaps.length}`);
  return lines.join("\n");
}

export function formatPaperImpact(impact: any): string {
  const lines: string[] = [];
  lines.push(`========================================================`);
  lines.push(` Working Paper Impact`);
  lines.push(`========================================================`);
  const staleSections = impact.staleSections ?? [];
  const staleTransclusions = impact.staleTransclusions ?? [];
  lines.push(`  Stale Sections:      ${staleSections.length}`);
  lines.push(`  Stale Transclusions: ${staleTransclusions.length}`);
  for (const item of staleTransclusions) {
    lines.push(`   ! Transclusion ${item.transclusionId ?? item.id ?? JSON.stringify(item)} is stale`);
  }
  return lines.join("\n");
}

export function formatModelUsage(usage: any): string {
  const lines: string[] = [];
  lines.push(`========================================================`);
  lines.push(` Model Token Usage & Cost`);
  lines.push(`========================================================`);
  const models = usage.models ?? (Array.isArray(usage) ? usage : [usage]);
  let totalCost = 0;
  for (const m of models) {
    const id = m.modelId ?? m.adapterId ?? "default";
    const inTokens = m.inputTokens ?? m.promptTokens ?? 0;
    const outTokens = m.outputTokens ?? m.completionTokens ?? 0;
    const cost = m.costMicros ?? 0;
    totalCost += cost;
    lines.push(`  Model: ${id}`);
    lines.push(`    Input tokens:  ${inTokens.toLocaleString()}`);
    lines.push(`    Output tokens: ${outTokens.toLocaleString()}`);
    lines.push(`    Cost (micros): ${cost.toLocaleString()} ($${(cost / 1_000_000).toFixed(4)})`);
  }
  lines.push(`--------------------------------------------------------`);
  lines.push(`  Total Cost: $${(totalCost / 1_000_000).toFixed(4)} (${totalCost.toLocaleString()} micros)`);
  return lines.join("\n");
}

export function formatModelRoute(route: any): string {
  const lines: string[] = [];
  lines.push(`========================================================`);
  lines.push(` Model Route Decision`);
  lines.push(`========================================================`);
  lines.push(`  Selected Adapter: ${route.adapterId ?? route.modelId ?? "unknown"}`);
  if (route.estimatedCostMicros !== undefined) {
    lines.push(`  Estimated Cost:   $${(route.estimatedCostMicros / 1_000_000).toFixed(4)} (${route.estimatedCostMicros} micros)`);
  }
  if (route.matchReason) {
    lines.push(`  Match Reason:     ${route.matchReason}`);
  }
  return lines.join("\n");
}

export function formatWorkstreamList(workstreams: any[]): string {
  const lines: string[] = [];
  lines.push(`========================================================`);
  lines.push(` Workstreams (${workstreams.length})`);
  lines.push(`========================================================`);
  for (const ws of workstreams) {
    const id = ws.objectId ?? ws.workstreamId ?? "unknown";
    const name = ws.name ?? "unnamed";
    const status = (ws.status ?? ws.state ?? "active").toUpperCase();
    const goal = ws.goalId ? ` [goal: ${ws.goalId}]` : "";
    lines.push(`  * [${status}] ${name} (${id})${goal}`);
  }
  return lines.join("\n");
}

export function formatWorkstreamStatus(ws: any): string {
  const lines: string[] = [];
  lines.push(`========================================================`);
  lines.push(` Workstream: ${ws.name ?? ws.objectId ?? "unknown"}`);
  lines.push(`========================================================`);
  lines.push(`  ID:          ${ws.objectId ?? ws.workstreamId ?? "unknown"}`);
  lines.push(`  Status:      ${(ws.status ?? ws.state ?? "unknown").toUpperCase()}`);
  lines.push(`  Goal ID:     ${ws.goalId ?? "none"}`);
  lines.push(`  Branch ID:   ${ws.branchId ?? "none"}`);
  if (ws.allowedToolIds) {
    lines.push(`  Tools:       ${ws.allowedToolIds.join(", ")}`);
  }
  if (ws.budget) {
    lines.push(`  Budget Limit: maxToolCalls=${ws.budget.maxToolCalls}, maxWallTimeMs=${ws.budget.maxWallTimeMs}`);
  }
  return lines.join("\n");
}

export function formatToolsList(tools: any[]): string {
  const lines: string[] = [];
  lines.push(`========================================================`);
  lines.push(` Available Execution Tools (${tools.length})`);
  lines.push(`========================================================`);
  for (const tool of tools) {
    const id = tool.toolId ?? "unknown";
    const caps = tool.capabilities ? ` [${tool.capabilities.join(", ")}]` : "";
    const desc = tool.description ? `\n      ${tool.description}` : "";
    lines.push(`  * ${id}${caps}${desc}`);
  }
  return lines.join("\n");
}

export function formatCleanupReport(report: any): string {
  const lines: string[] = [];
  const mode = report.dryRun ? " (dry run)" : "";
  lines.push(`========================================================`);
  lines.push(` Project Cleanup Report${mode}`);
  lines.push(`========================================================`);
  lines.push(`  Project Root:           ${report.projectRoot ?? "unknown"}`);
  lines.push(`  Total Files Cleaned:    ${report.totalFilesRemoved ?? 0}`);
  lines.push(`  Disk Space Freed:       ${report.freedBytes ?? 0} bytes`);

  if (report.stagingFilesRemoved && report.stagingFilesRemoved.length > 0) {
    lines.push(``);
    lines.push(`  Staging Files Cleaned:`);
    for (const f of report.stagingFilesRemoved) {
      lines.push(`   - ${f}`);
    }
  }

  if (report.orphanSegmentsRemoved && report.orphanSegmentsRemoved.length > 0) {
    lines.push(``);
    lines.push(`  Orphan Segments Cleaned:`);
    for (const f of report.orphanSegmentsRemoved) {
      lines.push(`   - ${f}`);
    }
  }

  if (report.staleLocksRemoved && report.staleLocksRemoved.length > 0) {
    lines.push(``);
    lines.push(`  Stale Locks Removed:`);
    for (const f of report.staleLocksRemoved) {
      lines.push(`   - ${f}`);
    }
  }

  return lines.join("\n");
}
