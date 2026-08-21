import { request } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createRp001Fixture,
  inspectProject,
  projectHistory,
} from "@reasoning-workbench/store";

import {
  startWorkbenchServer,
  type WorkbenchServer,
} from "../src/server.js";
import {
  WORKBENCH_ASSETS,
  WORKBENCH_STATE_JS,
} from "../src/ui.js";

const roots: string[] = [];
const servers: WorkbenchServer[] = [];

interface BrowserStateModule {
  beginBranchSwitch(state: Record<string, unknown>): number;
  applyObjectDetail(
    state: Record<string, unknown>,
    generation: number,
    branchId: string,
    objectId: string,
    detail: unknown,
  ): boolean;
  applyWorkspaceLoad(
    state: Record<string, unknown>,
    generation: number,
    workspace: unknown,
    verification: unknown,
  ): boolean;
  claimAggregateStatus(profile: unknown): string;
  typedObjectRequest(
    branchId: string,
    fields: Record<string, unknown>,
  ): Record<string, unknown>;
}

async function browserStateModule(): Promise<BrowserStateModule> {
  const encoded = Buffer.from(WORKBENCH_STATE_JS).toString("base64");
  return import(`data:text/javascript;base64,${encoded}#${Date.now()}`) as Promise<BrowserStateModule>;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixtureServer(): Promise<{
  server: WorkbenchServer;
  projectRoot: string;
  fixture: Awaited<ReturnType<typeof createRp001Fixture>>;
}> {
  const root = await mkdtemp(join(tmpdir(), "rw-workbench-test-"));
  roots.push(root);
  const projectRoot = join(root, "project");
  const fixture = await createRp001Fixture(projectRoot);
  const server = await startWorkbenchServer({ projectRoot });
  servers.push(server);
  return { server, projectRoot, fixture };
}

function apiHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

async function rawRequest(
  server: WorkbenchServer,
  path: string,
): Promise<{ status: number | undefined; body: string }> {
  return new Promise((resolveRequest, reject) => {
    const outgoing = request({
      host: server.host,
      port: server.port,
      method: "GET",
      path,
      headers: { host: `${server.host}:${server.port}` },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolveRequest({
        status: response.statusCode,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    outgoing.on("error", reject);
    outgoing.end();
  });
}

describe("local workbench HTTP API", () => {
  it("binds only to IPv4 loopback and creates an unguessable per-launch token", async () => {
    const { server, projectRoot } = await fixtureServer();
    const second = await startWorkbenchServer({ projectRoot });
    servers.push(second);

    expect(server.host).toBe("127.0.0.1");
    expect(server.origin).toBe(`http://127.0.0.1:${server.port}`);
    expect(server.url).toBe(`${server.origin}/#token=${server.sessionToken}`);
    expect(server.sessionToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(second.sessionToken).not.toBe(server.sessionToken);
    expect(server.actorId).toMatch(/^hum_/u);
  });

  it("requires the launch token for every API read", async () => {
    const { server } = await fixtureServer();

    const missing = await fetch(`${server.origin}/api/workspace`);
    const wrong = await fetch(`${server.origin}/api/workspace`, {
      headers: apiHeaders("x".repeat(43)),
    });
    const accepted = await fetch(`${server.origin}/api/workspace`, {
      headers: apiHeaders(server.sessionToken),
    });

    expect(missing.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({
      manifest: { title: "RP-001 — Euler Polynomial Investigation" },
      summary: { byType: { goal: 1, workstream: 4 } },
    });
  });

  it("rejects traversal request targets without exposing project files", async () => {
    const { server } = await fixtureServer();

    const parentTraversal = await rawRequest(
      server,
      "/..%2Freasoning-project.json",
    );
    const backslashTraversal = await rawRequest(
      server,
      "/assets%5C..%5Creasoning-project.json",
    );

    expect(parentTraversal.status).toBe(400);
    expect(backslashTraversal.status).toBe(400);
    expect(parentTraversal.body).not.toContain("Euler Polynomial Investigation");
  });

  it("reads a branch workspace and exact object version, evidence edges, and history", async () => {
    const { server, fixture } = await fixtureServer();
    const workspace = await fetch(`${server.origin}/api/workspace?branch=main`, {
      headers: apiHeaders(server.sessionToken),
    });
    const detail = await fetch(
      `${server.origin}/api/objects/${fixture.goal.objectId}?branch=main`,
      { headers: apiHeaders(server.sessionToken) },
    );

    expect(await workspace.json()).toMatchObject({
      branchId: fixture.project.manifest.defaultBranchId,
      projection: { eventCount: 15 },
      edges: expect.any(Array),
      events: expect.any(Array),
    });
    expect(await detail.json()).toMatchObject({
      current: {
        objectId: fixture.goal.objectId,
        versionId: fixture.goal.versionId,
        contentHash: fixture.goal.contentHash,
      },
      history: [{ versionId: fixture.goal.versionId }],
      edges: expect.any(Array),
    });
  });

  it("creates a branch and typed object while stamping the trusted session actor", async () => {
    const { server, projectRoot, fixture } = await fixtureServer();
    const branchResponse = await fetch(`${server.origin}/api/branches`, {
      method: "POST",
      headers: {
        ...apiHeaders(server.sessionToken),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "ui-alternative",
        baseBranchId: fixture.project.manifest.defaultBranchId,
      }),
    });
    expect(branchResponse.status).toBe(201);
    const branch = await branchResponse.json() as { branchId: string };

    const stateHelpers = await browserStateModule();
    const formRequest = stateHelpers.typedObjectRequest(branch.branchId, {
      objectType: "goal",
      title: "Inspect the exceptional set",
      body: "Characterize counterexamples before proposing a proof.",
    });
    const objectResponse = await fetch(`${server.origin}/api/objects`, {
      method: "POST",
      headers: {
        ...apiHeaders(server.sessionToken),
        "content-type": "application/json",
      },
      body: JSON.stringify(formRequest),
    });
    expect(objectResponse.status).toBe(201);
    const object = await objectResponse.json() as {
      objectId: string;
      createdBy: { actorId: string };
    };

    expect(object.objectId).toMatch(/^gol_/u);
    expect(object.createdBy.actorId).toBe(server.actorId);
    expect((await inspectProject(projectRoot)).branches).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "ui-alternative" })]),
    );
    expect((await projectHistory(projectRoot)).at(-1)).toMatchObject({
      eventType: "ObjectVersionCreated",
      actor: { actorType: "human", actorId: server.actorId },
      branchId: branch.branchId,
    });
  });

  it("serializes concurrent branch creates and reports the duplicate as a conflict", async () => {
    const { server, projectRoot } = await fixtureServer();
    const requestBranch = () => fetch(`${server.origin}/api/branches`, {
      method: "POST",
      headers: {
        ...apiHeaders(server.sessionToken),
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "same-name" }),
    });

    const responses = await Promise.all([requestBranch(), requestBranch()]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    expect(
      (await inspectProject(projectRoot)).branches.filter(
        (branch) => branch.name === "same-name",
      ),
    ).toHaveLength(1);
  });

  it("maps missing branch mutations to not-found responses", async () => {
    const { server } = await fixtureServer();
    const missingBranchId = "br_01K39Q1G000000000000000000";
    const headers = {
      ...apiHeaders(server.sessionToken),
      "content-type": "application/json",
    };

    const branch = await fetch(`${server.origin}/api/branches`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "missing-base", baseBranchId: missingBranchId }),
    });
    const object = await fetch(`${server.origin}/api/objects`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        branchId: missingBranchId,
        objectType: "goal",
        content: { title: "not written" },
      }),
    });

    expect(branch.status).toBe(404);
    expect(object.status).toBe(404);
  });

  it("does not accept client-selected actors or cross-origin mutations", async () => {
    const { server, fixture } = await fixtureServer();
    const arbitraryActor = await fetch(`${server.origin}/api/objects`, {
      method: "POST",
      headers: {
        ...apiHeaders(server.sessionToken),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        branchId: fixture.project.manifest.defaultBranchId,
        objectType: "goal",
        content: { title: "goal" },
        actor: { actorType: "human", actorId: "supplied-by-client" },
      }),
    });
    const crossOrigin = await fetch(`${server.origin}/api/branches`, {
      method: "POST",
      headers: {
        ...apiHeaders(server.sessionToken),
        "content-type": "application/json",
        origin: "https://attacker.example",
      },
      body: JSON.stringify({ name: "not-created" }),
    });

    expect(arbitraryActor.status).toBe(400);
    expect(crossOrigin.status).toBe(403);
  });
});

describe("workbench static UI contract", () => {
  it("ships the required navigable product surfaces and status language", () => {
    const html = WORKBENCH_ASSETS["/index.html"]!.body;
    const script = WORKBENCH_ASSETS["/app.js"]!.body;
    const css = WORKBENCH_ASSETS["/styles.css"]!.body;

    expect(html).toContain("reasoning-workbench");
    expect(script).toContain('data-testid="project-header"');
    expect(script).toContain('data-testid="navigator"');
    expect(script).toContain('data-testid="research-surface"');
    expect(script).toContain('data-testid="object-inspector"');
    expect(script).toContain('data-testid="activity-panel"');
    for (const label of [
      "Problem & goals",
      "Workstreams",
      "Branches",
      "Claims & context",
      "Sources",
      "Artifacts",
      "Documents",
      "Exact content",
      "Exact evidence",
      "Evidence & edges",
      "History",
      "Verification summary",
      "Search and filter",
      "Add typed project object",
    ]) {
      expect(script).toContain(label);
    }
    for (const status of ["working", "supported", "mixed", "verified", "failed", "stale"] ) {
      expect(css).toContain(`status-${status}`);
    }
    expect(css).toContain(".nav-name { display: block;");
    expect(css).toContain(".nav-meta { display: block;");
    expect(script).toContain("beginBranchSwitch(state)");
    expect(script).toContain("typedObjectRequest(state.workspace.branchId");
  });

  it("serves a strict static shell without reflecting the launch token", async () => {
    const { server } = await fixtureServer();
    const response = await fetch(`${server.origin}/index.html`);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(body).not.toContain(server.sessionToken);
  });
});

describe("workbench executable browser state", () => {
  it("clears exact detail on branch switch and rejects stale workspace/detail responses", async () => {
    const helpers = await browserStateModule();
    const state: Record<string, unknown> = {
      loadGeneration: 3,
      workspace: { branchId: "br_old" },
      verification: { ok: true },
      activeId: "clm_old",
      activeArtifactId: "art_old",
      detail: { current: { branchId: "br_old", versionId: "ver_old" } },
      tab: "object",
    };

    const generation = helpers.beginBranchSwitch(state);
    expect(generation).toBe(4);
    expect(state).toMatchObject({
      activeId: null,
      activeArtifactId: null,
      detail: null,
      tab: "overview",
    });
    expect(
      helpers.applyWorkspaceLoad(
        state,
        3,
        { branchId: "br_old" },
        { ok: false },
      ),
    ).toBe(false);
    expect(
      helpers.applyObjectDetail(
        state,
        3,
        "br_old",
        "clm_old",
        { current: { versionId: "ver_stale" } },
      ),
    ).toBe(false);
    expect(
      helpers.applyWorkspaceLoad(
        state,
        generation,
        { branchId: "br_new" },
        { ok: true },
      ),
    ).toBe(true);
    expect(state.workspace).toEqual({ branchId: "br_new" });
    expect(state.detail).toBeNull();
  });

  it("aggregates claim assurance conservatively with explicit precedence", async () => {
    const helpers = await browserStateModule();
    const profile = (statuses: readonly string[], extra = {}) => ({
      dimensions: statuses.map((status, index) => ({
        dimension: `dimension-${index}`,
        status,
      })),
      ...extra,
    });

    expect(helpers.claimAggregateStatus(profile(["verified", "missing"]))).toBe("supported");
    expect(helpers.claimAggregateStatus(profile(["verified", "supported"]))).toBe("mixed");
    expect(helpers.claimAggregateStatus(profile(["inconclusive", "supported"]))).toBe("inconclusive");
    expect(helpers.claimAggregateStatus(profile(["stale", "inconclusive", "verified"]))).toBe("stale");
    expect(helpers.claimAggregateStatus(profile(["failed", "stale", "verified"]))).toBe("failed");
    expect(helpers.claimAggregateStatus(profile(["missing", "missing"]))).toBe("proposal");
    expect(helpers.claimAggregateStatus({
      fullProfile: true,
      requiredDimensions: ["logical", "formal"],
      dimensions: [
        { dimension: "logical", status: "verified" },
        { dimension: "formal", status: "verified" },
      ],
    })).toBe("verified");
  });
});
