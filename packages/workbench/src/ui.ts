export interface WorkbenchAsset {
  readonly contentType: string;
  readonly body: string;
}

const INDEX_HTML = String.raw`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="dark">
    <title>Reasoning Workbench</title>
    <link rel="stylesheet" href="/styles.css">
  </head>
  <body>
    <reasoning-workbench data-testid="workbench-shell">
      <div class="boot">Opening local research state…</div>
    </reasoning-workbench>
    <script type="module" src="/app.js"></script>
  </body>
</html>
`;

const STYLES_CSS = String.raw`:root {
  --bg: #0b1013;
  --panel: #11181d;
  --panel-2: #162027;
  --line: #27343c;
  --text: #eef3f0;
  --muted: #93a39e;
  --accent: #8fe0c1;
  --accent-2: #72a9ff;
  --warning: #f0c36b;
  --danger: #ff877f;
  --verified: #76df91;
  --working: #8ca0ae;
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

* { box-sizing: border-box; }
html, body { height: 100%; }
body { margin: 0; background: var(--bg); color: var(--text); overflow: hidden; }
button, input, select, textarea { font: inherit; }
button, select, input, textarea {
  color: var(--text);
  background: #0d1418;
  border: 1px solid var(--line);
  border-radius: 7px;
}
button { cursor: pointer; padding: 7px 11px; }
button:hover, button:focus-visible { border-color: var(--accent); outline: none; }
button.primary { background: var(--accent); color: #082018; border-color: var(--accent); font-weight: 700; }
button.ghost { background: transparent; }
input, select, textarea { padding: 8px 10px; width: 100%; }
textarea { min-height: 110px; resize: vertical; line-height: 1.45; }

.boot, .fatal { display: grid; place-items: center; height: 100vh; color: var(--muted); }
.fatal { color: var(--danger); padding: 40px; text-align: center; }
.shell { height: 100vh; display: grid; grid-template-rows: 64px minmax(0, 1fr) 218px; }
.project-header {
  display: grid;
  grid-template-columns: minmax(240px, 1fr) minmax(210px, 340px) auto;
  align-items: center;
  gap: 18px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--line);
  background: #0e1519;
}
.brand { display: flex; align-items: center; gap: 12px; min-width: 0; }
.mark { width: 31px; height: 31px; border: 1px solid #5c8878; border-radius: 9px; display: grid; place-items: center; color: var(--accent); font-family: ui-monospace, monospace; }
.title { font-weight: 740; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.subtitle { color: var(--muted); font-size: 12px; margin-top: 2px; }
.search { position: relative; }
.search input { padding-left: 32px; }
.search::before { content: "⌕"; position: absolute; left: 11px; top: 7px; color: var(--muted); z-index: 1; }
.header-actions { display: flex; align-items: center; gap: 8px; }
.header-actions select { width: 150px; }

.main-grid { min-height: 0; display: grid; grid-template-columns: 265px minmax(360px, 1fr) 355px; }
.navigator, .surface, .inspector { min-width: 0; min-height: 0; overflow: auto; }
.navigator { border-right: 1px solid var(--line); background: #0e1519; padding: 14px 10px 30px; }
.surface { background: var(--bg); }
.inspector { border-left: 1px solid var(--line); background: var(--panel); padding: 15px; }
.panel-heading { color: var(--muted); font-size: 11px; font-weight: 750; letter-spacing: .12em; text-transform: uppercase; padding: 2px 8px 10px; }
.nav-section { margin-bottom: 13px; }
.nav-section summary { color: #bcc8c4; cursor: pointer; list-style: none; padding: 5px 8px; display: flex; justify-content: space-between; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; }
.nav-section summary::-webkit-details-marker { display: none; }
.count { color: var(--muted); font-variant-numeric: tabular-nums; }
.nav-item { display: grid; grid-template-columns: 7px minmax(0, 1fr); gap: 8px; width: 100%; text-align: left; background: transparent; border-color: transparent; padding: 7px 8px; }
.nav-item:hover, .nav-item.active { background: var(--panel-2); border-color: var(--line); }
.nav-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--working); margin-top: 6px; }
.nav-label { min-width: 0; }
.nav-name { display: block; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 13px; }
.nav-meta { display: block; color: var(--muted); font-size: 10px; margin-top: 2px; font-family: ui-monospace, monospace; }
.nav-empty { padding: 4px 9px; }

.tabs { position: sticky; top: 0; z-index: 2; display: flex; gap: 3px; border-bottom: 1px solid var(--line); background: rgba(11,16,19,.96); padding: 10px 15px 0; }
.tab { border: 0; border-bottom: 2px solid transparent; border-radius: 0; background: transparent; color: var(--muted); padding: 8px 12px 10px; }
.tab.active { color: var(--text); border-bottom-color: var(--accent); }
.surface-body { padding: 24px clamp(18px, 4vw, 52px) 70px; max-width: 1040px; margin: 0 auto; }
.eyebrow { color: var(--accent); text-transform: uppercase; letter-spacing: .12em; font-size: 11px; font-weight: 800; }
h1 { font-family: Georgia, "Times New Roman", serif; font-weight: 500; font-size: clamp(28px, 4vw, 44px); line-height: 1.08; margin: 9px 0 13px; }
h2 { font-size: 17px; margin: 0 0 13px; }
h3 { font-size: 13px; margin: 0 0 9px; color: #c7d0cd; }
.lead { color: #b7c3bf; font-size: 15px; line-height: 1.65; max-width: 700px; }
.stats { display: grid; grid-template-columns: repeat(4, minmax(100px, 1fr)); gap: 10px; margin: 25px 0; }
.stat, .card { border: 1px solid var(--line); background: var(--panel); border-radius: 10px; }
.stat { padding: 14px; }
.stat-value { font-size: 26px; font-weight: 720; }
.stat-label { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .07em; margin-top: 4px; }
.card-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.card { padding: 16px; }
.card p { color: #bac4c1; margin: 6px 0 0; line-height: 1.5; }
.object-content { border-left: 2px solid var(--accent); padding-left: 18px; margin-top: 25px; }
.content-section { margin-top: 28px; }
.prose { white-space: pre-wrap; line-height: 1.7; color: #d8dfdc; }
.document-view { max-width: 760px; }
.document-body { font-family: Georgia, "Times New Roman", serif; font-size: 18px; line-height: 1.75; white-space: pre-wrap; }
pre { overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; background: #0b1114; padding: 11px; border: 1px solid var(--line); border-radius: 8px; color: #c8d5d0; font-size: 11px; line-height: 1.45; }
.empty { border: 1px dashed var(--line); color: var(--muted); padding: 18px; border-radius: 9px; }

.badge { display: inline-flex; align-items: center; gap: 5px; border: 1px solid var(--line); border-radius: 999px; padding: 3px 8px; font-size: 10px; font-weight: 800; letter-spacing: .04em; text-transform: uppercase; }
.badge::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.status-working, .status-ready, .status-proposal, .status-missing, .status-registered { color: var(--working); }
.status-supported, .status-passed, .status-completed, .status-current { color: var(--accent); }
.status-verified { color: var(--verified); }
.status-failed, .status-open, .status-blocked { color: var(--danger); }
.status-inconclusive, .status-mixed, .status-stale, .status-paused, .status-waived { color: var(--warning); }
.nav-dot.status-supported, .nav-dot.status-passed, .nav-dot.status-completed { background: var(--accent); }
.nav-dot.status-verified { background: var(--verified); }
.nav-dot.status-failed, .nav-dot.status-open, .nav-dot.status-blocked { background: var(--danger); }
.nav-dot.status-inconclusive, .nav-dot.status-mixed, .nav-dot.status-stale, .nav-dot.status-paused { background: var(--warning); }

.inspector-title { font-size: 18px; margin: 3px 0 6px; overflow-wrap: anywhere; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10px; color: var(--muted); overflow-wrap: anywhere; }
.inspector-section { border-top: 1px solid var(--line); margin-top: 15px; padding-top: 14px; }
.kv { display: grid; grid-template-columns: 78px minmax(0, 1fr); gap: 5px 9px; font-size: 11px; margin: 7px 0; }
.kv dt { color: var(--muted); }
.kv dd { margin: 0; overflow-wrap: anywhere; }
.edge-row, .history-row { border-left: 2px solid var(--line); padding: 4px 0 4px 10px; margin: 7px 0; font-size: 11px; }
.dimension-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.dimension { border: 1px solid var(--line); border-radius: 6px; padding: 7px; font-size: 10px; }

.activity { border-top: 1px solid var(--line); background: #0e1519; min-height: 0; display: grid; grid-template-rows: 39px minmax(0, 1fr); }
.activity-header { display: flex; align-items: center; justify-content: space-between; padding: 0 15px; border-bottom: 1px solid var(--line); }
.activity-header h2 { margin: 0; font-size: 12px; text-transform: uppercase; letter-spacing: .08em; }
.activity-body { min-height: 0; overflow: auto; display: grid; grid-template-columns: 1.4fr .8fr .8fr; }
.activity-column { min-width: 0; padding: 10px 14px; border-right: 1px solid var(--line); overflow: auto; }
.activity-column:last-child { border-right: 0; }
.activity-row { display: grid; grid-template-columns: 65px minmax(0, 1fr) auto; gap: 9px; padding: 5px 0; border-bottom: 1px solid rgba(39,52,60,.5); font-size: 11px; }
.activity-time { color: var(--muted); font-variant-numeric: tabular-nums; }
.activity-type { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

dialog { width: min(540px, calc(100vw - 30px)); background: var(--panel); border: 1px solid #39505b; border-radius: 12px; color: var(--text); padding: 0; box-shadow: 0 20px 90px #000; }
dialog::backdrop { background: rgba(0,0,0,.68); }
.dialog-head { padding: 16px 19px; border-bottom: 1px solid var(--line); font-weight: 750; }
.dialog-body { padding: 18px 19px; display: grid; gap: 13px; }
label { display: grid; gap: 6px; color: #c4ceca; font-size: 12px; }
.dialog-actions { display: flex; justify-content: flex-end; gap: 8px; padding-top: 5px; }
.form-error { color: var(--danger); font-size: 12px; min-height: 16px; }
.toast { position: fixed; right: 18px; bottom: 230px; background: #1b292f; border: 1px solid #41606b; padding: 10px 14px; border-radius: 8px; z-index: 9; box-shadow: 0 8px 30px #000; font-size: 12px; }

@media (max-width: 1050px) {
  .main-grid { grid-template-columns: 230px minmax(360px, 1fr); }
  .inspector { display: none; }
  .activity-body { grid-template-columns: 1fr 1fr; }
  .activity-column:last-child { display: none; }
}
@media (max-width: 760px) {
  body { overflow: auto; }
  .shell { height: auto; min-height: 100vh; grid-template-rows: auto auto auto; }
  .project-header { grid-template-columns: 1fr; gap: 8px; }
  .header-actions { flex-wrap: wrap; }
  .main-grid { grid-template-columns: 1fr; }
  .navigator { border-right: 0; border-bottom: 1px solid var(--line); max-height: 280px; }
  .surface { min-height: 560px; }
  .stats { grid-template-columns: 1fr 1fr; }
  .card-grid { grid-template-columns: 1fr; }
  .activity { min-height: 390px; }
  .activity-body { grid-template-columns: 1fr; }
  .activity-column { border-right: 0; border-bottom: 1px solid var(--line); }
  .activity-column:last-child { display: block; }
  .toast { bottom: 18px; }
}
`;

export const WORKBENCH_STATE_JS = String.raw`export function beginBranchSwitch(state) {
  state.loadGeneration = (state.loadGeneration || 0) + 1;
  state.activeId = null;
  state.activeArtifactId = null;
  state.detail = null;
  state.tab = "overview";
  return state.loadGeneration;
}

export function applyWorkspaceLoad(state, generation, workspace, verification) {
  if (generation !== state.loadGeneration) return false;
  state.workspace = workspace;
  state.verification = verification;
  return true;
}

export function applyObjectDetail(state, generation, branchId, objectId, detail) {
  if (
    generation !== state.loadGeneration ||
    !state.workspace ||
    state.workspace.branchId !== branchId ||
    state.activeId !== objectId
  ) return false;
  state.detail = detail;
  return true;
}

export function claimAggregateStatus(profile) {
  if (!profile || !Array.isArray(profile.dimensions)) return "proposal";
  const dimensions = profile.dimensions;
  const statuses = dimensions.map(function (dimension) { return dimension.status; });
  if (statuses.includes("failed")) return "failed";
  if (statuses.includes("stale")) return "stale";
  if (statuses.includes("inconclusive")) return "inconclusive";

  const required = Array.isArray(profile.requiredDimensions) ? profile.requiredDimensions : [];
  const explicitlyFull = profile.fullProfile === true && required.length > 0;
  if (explicitlyFull && required.every(function (name) {
    const dimension = dimensions.find(function (candidate) { return candidate.dimension === name; });
    return dimension && dimension.status === "verified";
  })) return "verified";

  const current = statuses.filter(function (status) {
    return status === "supported" || status === "verified";
  });
  if (current.includes("supported") && current.includes("verified")) return "mixed";
  if (current.length > 0) return "supported";
  return "proposal";
}

export function typedObjectRequest(branchId, fields) {
  const type = String(fields.objectType);
  const body = String(fields.body);
  const content = {
    title: String(fields.title),
    body: body,
    status: type === "failure" ? "open" : type === "claim" ? "proposal" : "working"
  };
  if (type === "claim") {
    content.contextId = String(fields.contextId || "");
    content.statement = body;
  }
  if (type === "goal") content.goal = body;
  if (type === "source") content.locator = body;
  return { branchId: branchId, objectType: type, content: content };
}
`;

const APP_JS = String.raw`import {
  applyObjectDetail,
  applyWorkspaceLoad,
  beginBranchSwitch,
  claimAggregateStatus,
  typedObjectRequest
} from "/state.js";

const root = document.querySelector("reasoning-workbench");
const state = {
  token: "",
  workspace: null,
  verification: null,
  detail: null,
  activeId: null,
  activeArtifactId: null,
  tab: "overview",
  query: "",
  loadGeneration: 0
};

function esc(value) {
  return String(value == null ? "" : value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function contentRecord(object) {
  return object && object.content && typeof object.content === "object" ? object.content : {};
}

function objectTitle(object) {
  const content = contentRecord(object);
  return content.title || content.name || content.statement || content.question || content.summary || content.text || object.objectId;
}

function objectBody(object) {
  const content = contentRecord(object);
  return content.body || content.statement || content.question || content.summary || content.description || content.text || JSON.stringify(content, null, 2);
}

function profileFor(objectId) {
  return (state.workspace.verificationProfiles || []).find(function (profile) { return profile.claimId === objectId; });
}

function objectStatus(object) {
  const content = contentRecord(object);
  if (object.objectType === "failure") return content.status === "resolved" ? "current" : "open";
  if (object.objectType === "workstream") return content.status || "ready";
  if (object.objectType === "evidence" || object.objectType === "review") return content.outcome || content.status || "proposal";
  if (object.objectType === "claim") return claimAggregateStatus(profileFor(object.objectId));
  return content.status || "working";
}

function badge(status) {
  const normalized = String(status || "working").toLowerCase().replace(/[^a-z-]/g, "-");
  return '<span class="badge status-' + esc(normalized) + '">' + esc(status || "working") + '</span>';
}

async function api(path, options) {
  const settings = Object.assign({}, options || {});
  settings.headers = Object.assign({}, settings.headers || {}, { Authorization: "Bearer " + state.token });
  const response = await fetch(path, settings);
  const body = await response.json().catch(function () { return {}; });
  if (!response.ok) throw new Error(body.error || "Request failed with " + response.status);
  return body;
}

function readToken() {
  const fragment = new URLSearchParams(location.hash.slice(1));
  const token = fragment.get("token");
  if (token) {
    sessionStorage.setItem("rw-workbench-token", token);
    history.replaceState(null, "", location.pathname + location.search);
    return token;
  }
  return sessionStorage.getItem("rw-workbench-token") || "";
}

function relevantObjects(types) {
  const query = state.query.trim().toLowerCase();
  return state.workspace.objects.filter(function (object) {
    if (!types.includes(object.objectType)) return false;
    if (!query) return true;
    return (object.objectId + " " + objectTitle(object) + " " + JSON.stringify(object.content)).toLowerCase().includes(query);
  });
}

const sections = [
  ["Problem & goals", ["problem", "goal"]],
  ["Workstreams", ["workstream"]],
  ["Claims & context", ["claim", "assumption", "definition", "context"]],
  ["Sources", ["source"]],
  ["Artifacts", ["artifact", "run"]],
  ["Documents", ["document"]]
];

function navItem(object) {
  const status = objectStatus(object);
  return '<button class="nav-item ' + (state.activeId === object.objectId ? "active" : "") + '" data-object-id="' + esc(object.objectId) + '">' +
    '<span class="nav-dot status-' + esc(status) + '"></span><span class="nav-label">' +
    '<span class="nav-name">' + esc(objectTitle(object)) + '</span>' +
    '<span class="nav-meta">' + esc(object.objectType) + ' · v' + esc(object.version) + '</span></span></button>';
}

function artifactNavItem(artifact) {
  return '<button class="nav-item ' + (state.activeArtifactId === artifact.artifactId ? "active" : "") + '" data-artifact-id="' + esc(artifact.artifactId) + '">' +
    '<span class="nav-dot status-registered"></span><span class="nav-label"><span class="nav-name">' + esc(artifact.logicalName) + '</span>' +
    '<span class="nav-meta">' + esc(artifact.mediaType) + ' · ' + esc(artifact.size) + ' bytes</span></span></button>';
}

function renderNavigator() {
  let html = '<div class="panel-heading">Navigator</div>';
  const branches = state.workspace.branches.filter(function (branch) {
    return !state.query || (branch.name + " " + branch.branchId).toLowerCase().includes(state.query.toLowerCase());
  });
  html += '<details class="nav-section" open><summary><span>Branches</span><span class="count">' + branches.length + '</span></summary>';
  html += branches.map(function (branch) {
    return '<button class="nav-item" data-branch-id="' + esc(branch.branchId) + '"><span class="nav-dot ' + (branch.branchId === state.workspace.branchId ? "status-supported" : "") + '"></span><span class="nav-label"><span class="nav-name">' + esc(branch.name) + '</span><span class="nav-meta">' + esc(branch.branchId) + '</span></span></button>';
  }).join("") || '<div class="empty">No branches match.</div>';
  html += '</details>';
  sections.forEach(function (section) {
    const objects = relevantObjects(section[1]);
    const artifacts = section[0] === "Artifacts" ? state.workspace.artifacts.filter(function (artifact) {
      if (!state.query) return true;
      return (artifact.artifactId + " " + artifact.logicalName + " " + artifact.mediaType + " " + artifact.digest).toLowerCase().includes(state.query.toLowerCase());
    }) : [];
    html += '<details class="nav-section" open><summary><span>' + esc(section[0]) + '</span><span class="count">' + (objects.length + artifacts.length) + '</span></summary>';
    html += objects.map(navItem).join("") + artifacts.map(artifactNavItem).join("") || '<div class="nav-meta nav-empty">No items</div>';
    html += '</details>';
  });
  return html;
}

function overviewSurface() {
  const summary = state.workspace.summary;
  const recentClaims = state.workspace.objects.filter(function (item) { return item.objectType === "claim"; }).slice(0, 4);
  const failures = state.workspace.objects.filter(function (item) { return item.objectType === "failure" && objectStatus(item) !== "current"; });
  return '<div class="eyebrow">Project cockpit · current branch</div>' +
    '<h1>' + esc(state.workspace.manifest.title) + '</h1>' +
    '<p class="lead">A branch-scoped view of durable research objects. Status colors summarize evidence without turning visual polish or model confidence into verification.</p>' +
    '<div class="stats">' +
      '<div class="stat"><div class="stat-value">' + esc(summary.byType.goal) + '</div><div class="stat-label">Goals</div></div>' +
      '<div class="stat"><div class="stat-value">' + esc(summary.byType.claim) + '</div><div class="stat-label">Claims</div></div>' +
      '<div class="stat"><div class="stat-value">' + esc(summary.runningWorkstreams) + '</div><div class="stat-label">Running</div></div>' +
      '<div class="stat"><div class="stat-value">' + esc(summary.openFailures) + '</div><div class="stat-label">Open failures</div></div>' +
    '</div>' +
    '<div class="card-grid">' +
      '<section class="card"><h2>Claims & assurance</h2>' + (recentClaims.length ? recentClaims.map(function (claim) {
        return '<button class="nav-item" data-object-id="' + esc(claim.objectId) + '"><span class="nav-dot status-' + esc(objectStatus(claim)) + '"></span><span class="nav-label"><span class="nav-name">' + esc(objectTitle(claim)) + '</span><span class="nav-meta">' + badge(objectStatus(claim)) + '</span></span></button>';
      }).join("") : '<div class="empty">No claims on this branch.</div>') + '</section>' +
      '<section class="card"><h2>Visible blockers</h2>' + (failures.length ? failures.map(function (failure) {
        return '<button class="nav-item" data-object-id="' + esc(failure.objectId) + '"><span class="nav-dot status-open"></span><span class="nav-label"><span class="nav-name">' + esc(objectTitle(failure)) + '</span><span class="nav-meta">open failure</span></span></button>';
      }).join("") : '<div class="empty">No open failure objects.</div>') + '</section>' +
    '</div>';
}

function objectSurface(object) {
  if (!object) return overviewSurface();
  const content = contentRecord(object);
  const isDocument = object.objectType === "document";
  if (state.tab === "document" && isDocument) {
    return '<article class="document-view"><div class="eyebrow">Living document · exact version ' + esc(object.version) + '</div><h1>' + esc(objectTitle(object)) + '</h1><div class="document-body">' + esc(objectBody(object)) + '</div></article>';
  }
  return '<div class="eyebrow">' + esc(object.objectType) + ' · branch projection</div>' +
    '<h1>' + esc(objectTitle(object)) + '</h1>' +
    '<div>' + badge(objectStatus(object)) + '</div>' +
    '<div class="object-content"><div class="prose">' + esc(objectBody(object)) + '</div></div>' +
    '<section class="content-section"><h2>Typed content</h2><pre>' + esc(JSON.stringify(content, null, 2)) + '</pre></section>';
}

function artifactSurface(artifact) {
  return '<div class="eyebrow">Immutable artifact · content addressed</div><h1>' + esc(artifact.logicalName) + '</h1>' +
    '<div>' + badge("registered") + '</div><div class="object-content"><p class="lead">' + esc(artifact.mediaType) + ' · ' + esc(artifact.size) + ' bytes</p><pre>' + esc(artifact.digest) + '</pre></div>' +
    '<section class="content-section"><h2>Provenance</h2><dl class="kv"><dt>Run</dt><dd class="mono">' + esc(artifact.producedByRunId) + '</dd><dt>Environment</dt><dd class="mono">' + esc(artifact.environmentId) + '</dd><dt>Behavior</dt><dd>' + esc(artifact.reproducibility) + '</dd></dl></section>';
}

function renderSurface() {
  const active = state.workspace.objects.find(function (item) { return item.objectId === state.activeId; });
  const activeArtifact = state.workspace.artifacts.find(function (item) { return item.artifactId === state.activeArtifactId; });
  const documentDisabled = !active || active.objectType !== "document";
  return '<div class="tabs" role="tablist" data-testid="research-surface-tabs">' +
    '<button class="tab ' + (state.tab === "overview" ? "active" : "") + '" data-tab="overview">Overview</button>' +
    '<button class="tab ' + (state.tab === "object" ? "active" : "") + '" data-tab="object">Readable object</button>' +
    '<button class="tab ' + (state.tab === "document" ? "active" : "") + '" data-tab="document" ' + (documentDisabled ? "disabled" : "") + '>Document</button>' +
    '</div><div class="surface-body">' + (state.tab === "overview" ? overviewSurface() : activeArtifact ? artifactSurface(activeArtifact) : objectSurface(active)) + '</div>';
}

function verificationGrid(profile) {
  if (!profile) return '<div class="empty">No exact-version verification observations.</div>';
  return '<div class="dimension-grid">' + profile.dimensions.map(function (dimension) {
    return '<div class="dimension"><div>' + esc(dimension.dimension) + '</div>' + badge(dimension.status) + '</div>';
  }).join("") + '</div>';
}

function evidenceObservations(profile) {
  if (!profile) return '<div class="empty">No evidence is bound to this exact claim/context pair.</div>';
  const observations = profile.dimensions.flatMap(function (dimension) { return dimension.observations; });
  if (!observations.length) return '<div class="empty">No evidence is bound to this exact claim/context pair.</div>';
  return observations.map(function (observation) {
    return '<button class="nav-item" data-object-id="' + esc(observation.evidenceObjectId) + '"><span class="nav-dot status-' + esc(observation.stale ? "stale" : observation.outcome) + '"></span><span class="nav-label">' +
      '<span class="nav-name">' + esc(observation.summary) + '</span><span class="nav-meta">' + esc(observation.dimension) + ' · ' + esc(observation.assurance) + ' · ' + esc(observation.outcome) + '</span>' +
      '<span class="nav-meta">' + esc(observation.evidenceObjectId) + ' @ ' + esc(observation.evidenceVersionId) + '</span>' +
      (observation.stale ? '<span class="nav-meta">stale: ' + esc(observation.staleReasons.join(", ")) + '</span>' : '') + '</span></button>';
  }).join("");
}

function renderInspector() {
  const artifact = state.workspace.artifacts.find(function (item) { return item.artifactId === state.activeArtifactId; });
  if (artifact) {
    return '<div class="panel-heading">Claim / Object Inspector</div><div class="eyebrow">artifact</div><div class="inspector-title">' + esc(artifact.logicalName) + '</div>' + badge("registered") +
      '<dl class="kv"><dt>Artifact</dt><dd class="mono">' + esc(artifact.artifactId) + '</dd><dt>Digest</dt><dd class="mono">' + esc(artifact.digest) + '</dd><dt>Media</dt><dd>' + esc(artifact.mediaType) + '</dd><dt>Size</dt><dd>' + esc(artifact.size) + ' bytes</dd></dl>' +
      '<section class="inspector-section"><h3>Exact provenance</h3><dl class="kv"><dt>Run</dt><dd class="mono">' + esc(artifact.producedByRunId) + '</dd><dt>Environment</dt><dd class="mono">' + esc(artifact.environmentId) + '</dd><dt>Behavior</dt><dd>' + esc(artifact.reproducibility) + '</dd><dt>Inputs</dt><dd>' + esc((artifact.inputs || []).join(", ") || "none") + '</dd></dl></section>' +
      '<section class="inspector-section"><h3>History</h3><div class="empty">Artifacts are immutable; lineage is recorded by the registration event.</div></section>';
  }
  if (!state.detail) {
    return '<div class="panel-heading">Claim / Object Inspector</div><div class="empty">Choose any durable object to inspect exact content, evidence, edges, and history.</div>';
  }
  const detail = state.detail;
  const object = detail.current;
  const inbound = detail.edges.filter(function (edge) { return edge.toObjectId === object.objectId; });
  const outbound = detail.edges.filter(function (edge) { return edge.fromObjectId === object.objectId; });
  return '<div class="panel-heading">Claim / Object Inspector</div>' +
    '<div class="eyebrow">' + esc(object.objectType) + '</div><div class="inspector-title">' + esc(objectTitle(object)) + '</div>' + badge(objectStatus(object)) +
    '<dl class="kv"><dt>Object</dt><dd class="mono">' + esc(object.objectId) + '</dd><dt>Version</dt><dd>v' + esc(object.version) + '<div class="mono">' + esc(object.versionId) + '</div></dd><dt>Hash</dt><dd class="mono">' + esc(object.contentHash) + '</dd><dt>Created</dt><dd>' + esc(new Date(object.createdAt).toLocaleString()) + '</dd></dl>' +
    '<section class="inspector-section"><h3>Verification summary</h3>' + verificationGrid(detail.verificationProfile) + '</section>' +
    '<section class="inspector-section"><h3>Exact evidence</h3>' + evidenceObservations(detail.verificationProfile) + '</section>' +
    '<section class="inspector-section"><h3>Evidence & edges</h3>' +
      (inbound.length + outbound.length ? inbound.concat(outbound).map(function (edge) {
        const direction = edge.toObjectId === object.objectId ? "incoming" : "outgoing";
        const other = direction === "incoming" ? edge.fromObjectId : edge.toObjectId;
        return '<div class="edge-row"><strong>' + esc(edge.edgeType) + '</strong> · ' + esc(direction) + '<div class="mono">' + esc(other) + '</div><div class="mono">' + esc(edge.edgeId) + '</div></div>';
      }).join("") : '<div class="empty">No visible edges.</div>') + '</section>' +
    '<section class="inspector-section"><h3>Exact content</h3><pre>' + esc(JSON.stringify(object.content, null, 2)) + '</pre></section>' +
    '<section class="inspector-section"><h3>History</h3>' + detail.history.map(function (version) {
      return '<div class="history-row"><strong>v' + esc(version.version) + '</strong> · ' + esc(new Date(version.createdAt).toLocaleString()) + '<div class="mono">origin ' + esc(version.branchId) + '</div><div class="mono">' + esc(version.versionId) + '</div><div class="mono">' + esc(version.contentHash) + '</div></div>';
    }).join("") + '</section>';
}

function renderActivity() {
  const runs = state.workspace.objects.filter(function (item) { return item.objectType === "run" || item.objectType === "workstream"; });
  const failures = state.workspace.objects.filter(function (item) { return item.objectType === "failure"; });
  const integrity = state.verification && state.verification.ok ? "passed" : "failed";
  return '<div class="activity-header"><h2>Activity · events, runs & failures</h2><div>Project integrity ' + badge(integrity) + '</div></div><div class="activity-body">' +
    '<section class="activity-column"><h3>Recent canonical events</h3>' + state.workspace.events.slice(0, 30).map(function (event) {
      return '<div class="activity-row"><span class="activity-time">#' + esc(event.sequence) + '</span><span class="activity-type">' + esc(event.eventType) + '</span><span class="activity-time">' + esc(new Date(event.occurredAt).toLocaleTimeString()) + '</span></div>';
    }).join("") + '</section>' +
    '<section class="activity-column"><h3>Runs / workstreams</h3>' + (runs.length ? runs.map(function (run) {
      return '<button class="nav-item" data-object-id="' + esc(run.objectId) + '"><span class="nav-dot status-' + esc(objectStatus(run)) + '"></span><span class="nav-label"><span class="nav-name">' + esc(objectTitle(run)) + '</span><span class="nav-meta">' + badge(objectStatus(run)) + '</span></span></button>';
    }).join("") : '<div class="empty">No run records.</div>') + '</section>' +
    '<section class="activity-column"><h3>Failures / unresolved</h3>' + (failures.length ? failures.map(function (failure) {
      return '<button class="nav-item" data-object-id="' + esc(failure.objectId) + '"><span class="nav-dot status-' + esc(objectStatus(failure)) + '"></span><span class="nav-label"><span class="nav-name">' + esc(objectTitle(failure)) + '</span><span class="nav-meta">' + badge(objectStatus(failure)) + '</span></span></button>';
    }).join("") : '<div class="empty">No failure objects.</div>') + '</section></div>';
}

function dialogMarkup() {
  const contexts = state.workspace.objects.filter(function (item) { return item.objectType === "context"; });
  return '<dialog id="branch-dialog"><form method="dialog" id="branch-form"><div class="dialog-head">Create isolated branch</div><div class="dialog-body">' +
    '<label>Branch name<input name="name" required maxlength="80" placeholder="e.g. alternative-proof"></label>' +
    '<label>Fork from<select name="baseBranchId">' + state.workspace.branches.map(function (branch) { return '<option value="' + esc(branch.branchId) + '" ' + (branch.branchId === state.workspace.branchId ? "selected" : "") + '>' + esc(branch.name) + '</option>'; }).join("") + '</select></label>' +
    '<div class="form-error"></div><div class="dialog-actions"><button value="cancel">Cancel</button><button class="primary" value="default">Create branch</button></div></div></form></dialog>' +
    '<dialog id="object-dialog"><form method="dialog" id="object-form"><div class="dialog-head">Add typed project object</div><div class="dialog-body">' +
    '<label>Type<select name="objectType">' + ["goal", "context", "definition", "assumption", "claim", "source", "decision", "failure", "document"].map(function (type) { return '<option value="' + type + '">' + type + '</option>'; }).join("") + '</select></label>' +
    '<label>Title<input name="title" required maxlength="180" placeholder="A concise navigable title"></label>' +
    '<label>Statement or note<textarea name="body" required maxlength="12000" placeholder="Write the durable typed content here—no JSON required."></textarea></label>' +
    '<label id="context-field" hidden>Claim context<select name="contextId"><option value="">Choose a context</option>' + contexts.map(function (context) { return '<option value="' + esc(context.objectId) + '">' + esc(objectTitle(context)) + '</option>'; }).join("") + '</select></label>' +
    '<div class="form-error"></div><div class="dialog-actions"><button value="cancel">Cancel</button><button class="primary" value="default">Add object</button></div></div></form></dialog>';
}

function render() {
  if (!state.workspace) return;
  const branch = state.workspace.branches.find(function (item) { return item.branchId === state.workspace.branchId; });
  root.innerHTML = '<div class="shell">' +
    '<header class="project-header" data-testid="project-header"><div class="brand"><div class="mark">∴</div><div><div class="title">' + esc(state.workspace.manifest.title) + '</div><div class="subtitle">Local workbench · canonical state stays on disk</div></div></div>' +
    '<div class="search"><input id="search" type="search" value="' + esc(state.query) + '" placeholder="Search objects, IDs, content…" aria-label="Search and filter"></div>' +
    '<div class="header-actions"><select id="branch-select" aria-label="Current branch">' + state.workspace.branches.map(function (item) { return '<option value="' + esc(item.branchId) + '" ' + (item.branchId === state.workspace.branchId ? "selected" : "") + '>' + esc(item.name) + '</option>'; }).join("") + '</select><button id="new-branch">New branch</button><button id="new-object" class="primary">Add object</button></div></header>' +
    '<main class="main-grid"><nav class="navigator" data-testid="navigator">' + renderNavigator() + '</nav><section class="surface" data-testid="research-surface">' + renderSurface() + '</section><aside class="inspector" data-testid="object-inspector">' + renderInspector() + '</aside></main>' +
    '<section class="activity" data-testid="activity-panel">' + renderActivity() + '</section></div>' + dialogMarkup();
  wireEvents();
}

async function loadWorkspace(branchId) {
  const generation = beginBranchSwitch(state);
  if (state.workspace) render();
  const suffix = branchId ? "?branch=" + encodeURIComponent(branchId) : "";
  const results = await Promise.all([api("/api/workspace" + suffix), api("/api/verification")]);
  if (!applyWorkspaceLoad(state, generation, results[0], results[1])) return false;
  render();
  return true;
}

async function selectObject(objectId) {
  const generation = state.loadGeneration;
  const branchId = state.workspace.branchId;
  state.activeId = objectId;
  state.activeArtifactId = null;
  state.tab = state.workspace.objects.find(function (item) { return item.objectId === objectId; }).objectType === "document" ? "document" : "object";
  const detail = await api("/api/objects/" + encodeURIComponent(objectId) + "?branch=" + encodeURIComponent(branchId));
  if (!applyObjectDetail(state, generation, branchId, objectId, detail)) return;
  render();
}

function selectArtifact(artifactId) {
  state.activeId = null;
  state.activeArtifactId = artifactId;
  state.detail = null;
  state.tab = "object";
  render();
}

function toast(message) {
  const element = document.createElement("div");
  element.className = "toast";
  element.textContent = message;
  document.body.append(element);
  setTimeout(function () { element.remove(); }, 2400);
}

function setFormBusy(form, busy) {
  form.querySelectorAll("button, input, select, textarea").forEach(function (control) {
    control.disabled = busy;
  });
}

function wireEvents() {
  document.querySelectorAll("[data-object-id]").forEach(function (button) {
    button.addEventListener("click", function () { void selectObject(button.dataset.objectId); });
  });
  document.querySelectorAll("[data-artifact-id]").forEach(function (button) {
    button.addEventListener("click", function () { selectArtifact(button.dataset.artifactId); });
  });
  document.querySelectorAll("[data-branch-id]").forEach(function (button) {
    button.addEventListener("click", function () { void loadWorkspace(button.dataset.branchId); });
  });
  document.querySelectorAll("[data-tab]").forEach(function (button) {
    button.addEventListener("click", function () { state.tab = button.dataset.tab; render(); });
  });
  document.querySelector("#branch-select").addEventListener("change", function (event) { void loadWorkspace(event.target.value); });
  document.querySelector("#search").addEventListener("input", function (event) {
    const cursor = event.target.selectionStart;
    state.query = event.target.value;
    render();
    const next = document.querySelector("#search");
    next.focus();
    next.setSelectionRange(cursor, cursor);
  });
  document.querySelector("#new-branch").addEventListener("click", function () { document.querySelector("#branch-dialog").showModal(); });
  document.querySelector("#new-object").addEventListener("click", function () { document.querySelector("#object-dialog").showModal(); });
  const objectType = document.querySelector('#object-form [name="objectType"]');
  objectType.addEventListener("change", function () {
    document.querySelector("#context-field").hidden = objectType.value !== "claim";
  });
  document.querySelector("#branch-form").addEventListener("submit", function (event) {
    event.preventDefault();
    const form = event.currentTarget;
    const submitter = event.submitter;
    if (submitter && submitter.value === "cancel") { document.querySelector("#branch-dialog").close(); return; }
    const data = new FormData(form);
    setFormBusy(form, true);
    void api("/api/branches", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: data.get("name"), baseBranchId: data.get("baseBranchId") }) })
      .then(function (branch) { document.querySelector("#branch-dialog").close(); toast("Branch created"); return loadWorkspace(branch.branchId); })
      .catch(function (error) { setFormBusy(form, false); form.querySelector(".form-error").textContent = error.message; });
  });
  document.querySelector("#object-form").addEventListener("submit", function (event) {
    event.preventDefault();
    const form = event.currentTarget;
    const submitter = event.submitter;
    if (submitter && submitter.value === "cancel") { document.querySelector("#object-dialog").close(); return; }
    const data = new FormData(form);
    const request = typedObjectRequest(state.workspace.branchId, {
      objectType: data.get("objectType"),
      title: data.get("title"),
      body: data.get("body"),
      contextId: data.get("contextId")
    });
    setFormBusy(form, true);
    void api("/api/objects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request) })
      .then(function (object) { document.querySelector("#object-dialog").close(); toast("Typed object added"); return loadWorkspace(state.workspace.branchId).then(function (applied) { return applied ? selectObject(object.objectId) : undefined; }); })
      .catch(function (error) { setFormBusy(form, false); form.querySelector(".form-error").textContent = error.message; });
  });
}

async function boot() {
  state.token = readToken();
  if (!state.token) throw new Error("This workbench launch URL has no session token. Run rw workbench again.");
  await loadWorkspace();
}

boot().catch(function (error) {
  root.innerHTML = '<div class="fatal"><div><h1>Workbench unavailable</h1><p>' + esc(error.message) + '</p></div></div>';
});
`;

export const WORKBENCH_ASSETS: Readonly<Record<string, WorkbenchAsset>> = {
  "/index.html": { contentType: "text/html; charset=utf-8", body: INDEX_HTML },
  "/styles.css": { contentType: "text/css; charset=utf-8", body: STYLES_CSS },
  "/state.js": { contentType: "text/javascript; charset=utf-8", body: WORKBENCH_STATE_JS },
  "/app.js": { contentType: "text/javascript; charset=utf-8", body: APP_JS },
};
