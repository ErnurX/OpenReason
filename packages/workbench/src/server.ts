import { randomBytes, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { platform } from "node:os";
import { resolve } from "node:path";

import {
  CANONICAL_ID_PATTERN,
  OBJECT_TYPES,
  createId,
  type Actor,
  type ObjectType,
} from "@reasoning-workbench/project-format";
import {
  createBranch,
  deriveVerificationProfile,
  getObjectHistory,
  inspectProject,
  listCurrentObjects,
  listEdges,
  listVisibleArtifacts,
  loadManifest,
  projectHistory,
  putObject,
  verifyProject,
} from "@reasoning-workbench/store";

import { WORKBENCH_ASSETS } from "./ui.js";

const LOOPBACK_HOST = "127.0.0.1";
const MAX_REQUEST_BYTES = 64 * 1024;
const projectMutationTails = new Map<string, Promise<void>>();
const MUTABLE_OBJECT_TYPES = [
  "problem",
  "goal",
  "context",
  "definition",
  "assumption",
  "claim",
  "source",
  "decision",
  "failure",
  "document",
] as const satisfies readonly ObjectType[];

export interface StartWorkbenchOptions {
  readonly projectRoot: string;
  readonly port?: number;
}

export interface WorkbenchServer {
  readonly projectRoot: string;
  readonly host: typeof LOOPBACK_HOST;
  readonly port: number;
  readonly origin: string;
  /** URL uses a fragment so the token is not included in an HTTP request. */
  readonly url: string;
  readonly sessionToken: string;
  readonly actorId: string;
  readonly closed: Promise<void>;
  close(): Promise<void>;
}

interface RequestContext {
  readonly projectRoot: string;
  readonly sessionToken: string;
  readonly actor: Actor;
  readonly origin: string;
}

class HttpError extends Error {
  public constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

function json(
  response: ServerResponse,
  status: number,
  value: unknown,
): void {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  });
  response.end(`${JSON.stringify(value)}\n`);
}

function safeRequestPath(rawUrl: string | undefined): { pathname: string; search: URLSearchParams } {
  if (rawUrl === undefined || !rawUrl.startsWith("/")) {
    throw new HttpError(400, "Invalid request target");
  }
  const rawPath = rawUrl.split("?", 1)[0]!;
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    throw new HttpError(400, "Invalid URL encoding");
  }
  if (
    decoded.includes("\\") ||
    decoded.includes("\0") ||
    decoded.split("/").some((segment) => segment === "." || segment === "..") ||
    decoded.slice(1).includes("//")
  ) {
    throw new HttpError(400, "Unsafe request path");
  }
  const url = new URL(rawUrl, "http://127.0.0.1");
  return { pathname: url.pathname, search: url.searchParams };
}

function requestIsLoopback(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress;
  return address === LOOPBACK_HOST || address === `::ffff:${LOOPBACK_HOST}`;
}

function authorized(request: IncomingMessage, token: string): boolean {
  const header = request.headers.authorization;
  if (header === undefined || !header.startsWith("Bearer ")) return false;
  const supplied = header.slice("Bearer ".length);
  const expectedBytes = Buffer.from(token);
  const suppliedBytes = Buffer.from(supplied);
  return suppliedBytes.length === expectedBytes.length &&
    timingSafeEqual(suppliedBytes, expectedBytes);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpError(400, `${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function allowedKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new HttpError(400, `${label} contains unsupported field ${JSON.stringify(key)}`);
    }
  }
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new HttpError(400, `${label} must be a non-empty string`);
  }
  if (value.includes("\0")) throw new HttpError(400, `${label} cannot contain NUL`);
  return value.trim();
}

async function requestJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim();
  if (contentType !== "application/json") {
    throw new HttpError(415, "Mutations require application/json");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_REQUEST_BYTES) {
      throw new HttpError(413, `Request body exceeds ${MAX_REQUEST_BYTES} bytes`);
    }
    chunks.push(bytes);
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new HttpError(400, "Request body must be valid JSON");
  }
  return record(value, "request body");
}

function branchIdFor(
  branches: Awaited<ReturnType<typeof inspectProject>>["branches"],
  candidate: string | null,
  fallback: string,
): string {
  if (candidate === null || candidate.length === 0) return fallback;
  const branch = branches.find(
    (item) => item.branchId === candidate || item.name === candidate,
  );
  if (branch === undefined) throw new HttpError(404, `Branch not found: ${candidate}`);
  return branch.branchId;
}

function mutationHttpError(error: unknown): unknown {
  if (error instanceof HttpError) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (/branch name already exists/iu.test(message)) {
    return new HttpError(409, message);
  }
  if (/branch does not exist|branch not found/iu.test(message)) {
    return new HttpError(404, message);
  }
  if (/not visible on branch|branch lineage|stale/iu.test(message)) {
    return new HttpError(409, message);
  }
  return error;
}

async function withProjectMutation<T>(
  context: RequestContext,
  operation: () => Promise<T>,
): Promise<T> {
  const predecessor = projectMutationTails.get(context.projectRoot) ?? Promise.resolve();
  const run = predecessor.then(operation, operation);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  projectMutationTails.set(context.projectRoot, tail);
  void tail.then(() => {
    if (projectMutationTails.get(context.projectRoot) === tail) {
      projectMutationTails.delete(context.projectRoot);
    }
  });
  try {
    return await run;
  } catch (error) {
    throw mutationHttpError(error);
  }
}

function objectContextId(content: unknown): string | undefined {
  if (typeof content !== "object" || content === null || Array.isArray(content)) return undefined;
  const value = (content as Record<string, unknown>).contextId;
  return typeof value === "string" ? value : undefined;
}

async function workspace(projectRoot: string, requestedBranch: string | null) {
  const inspection = await inspectProject(projectRoot);
  const branchId = branchIdFor(
    inspection.branches,
    requestedBranch,
    inspection.manifest.defaultBranchId,
  );
  const objects = listCurrentObjects(projectRoot, branchId);
  const edges = listEdges(projectRoot, branchId);
  const verificationProfiles = objects
    .filter((object) => object.objectType === "claim")
    .flatMap((claim) => {
      const contextId = objectContextId(claim.content);
      if (contextId === undefined) return [];
      try {
        return [deriveVerificationProfile(projectRoot, {
          branchId,
          claimId: claim.objectId,
          contextId,
        })];
      } catch {
        return [];
      }
    });
  const byType = Object.fromEntries(
    OBJECT_TYPES.map((type) => [
      type,
      objects.filter((object) => object.objectType === type).length,
    ]),
  );
  return {
    manifest: inspection.manifest,
    projection: inspection.projection,
    branchId,
    branches: inspection.branches,
    objects,
    edges,
    artifacts: await listVisibleArtifacts(projectRoot, branchId),
    events: (await projectHistory(projectRoot)).slice(-250).reverse(),
    verificationProfiles,
    summary: {
      byType,
      openFailures: objects.filter(
        (object) => object.objectType === "failure" &&
          (typeof object.content !== "object" || object.content === null ||
            (object.content as Record<string, unknown>).status !== "resolved"),
      ).length,
      runningWorkstreams: objects.filter(
        (object) => object.objectType === "workstream" &&
          typeof object.content === "object" && object.content !== null &&
          (object.content as Record<string, unknown>).status === "running",
      ).length,
    },
  };
}

async function objectDetail(
  projectRoot: string,
  branchId: string,
  objectId: string,
) {
  if (!CANONICAL_ID_PATTERN.test(objectId)) {
    throw new HttpError(400, "Object ID is not canonical");
  }
  const current = listCurrentObjects(projectRoot, branchId).find(
    (object) => object.objectId === objectId,
  );
  if (current === undefined) throw new HttpError(404, `Object not found: ${objectId}`);
  const edges = listEdges(projectRoot, branchId).filter(
    (edge) => edge.fromObjectId === objectId || edge.toObjectId === objectId,
  );
  const contextId = current.objectType === "claim"
    ? objectContextId(current.content)
    : undefined;
  let verificationProfile;
  if (contextId !== undefined) {
    try {
      verificationProfile = deriveVerificationProfile(projectRoot, {
        branchId,
        claimId: objectId,
        contextId,
      });
    } catch {
      verificationProfile = undefined;
    }
  }
  return {
    current,
    history: getObjectHistory(projectRoot, objectId).slice().reverse(),
    edges,
    ...(verificationProfile === undefined ? {} : { verificationProfile }),
  };
}

async function mutateBranch(request: IncomingMessage, context: RequestContext) {
  const body = await requestJson(request);
  allowedKeys(body, ["name", "baseBranchId"], "branch request");
  const name = requiredString(body.name, "branch request.name");
  if (name.length > 80) throw new HttpError(400, "branch request.name is too long");
  const inspection = await inspectProject(context.projectRoot);
  if (inspection.branches.some((branch) => branch.name === name)) {
    throw new HttpError(409, `Branch name already exists: ${name}`);
  }
  const baseBranchId = body.baseBranchId === undefined
    ? inspection.manifest.defaultBranchId
    : branchIdFor(
      inspection.branches,
      requiredString(body.baseBranchId, "branch request.baseBranchId"),
      inspection.manifest.defaultBranchId,
    );
  return createBranch(context.projectRoot, {
    name,
    baseBranchId,
    actor: context.actor,
  });
}

async function mutateObject(request: IncomingMessage, context: RequestContext) {
  const body = await requestJson(request);
  allowedKeys(body, ["branchId", "objectType", "content"], "object request");
  const requestedBranch = requiredString(body.branchId, "object request.branchId");
  const inspection = await inspectProject(context.projectRoot);
  const branchId = branchIdFor(
    inspection.branches,
    requestedBranch,
    inspection.manifest.defaultBranchId,
  );
  const objectType = requiredString(body.objectType, "object request.objectType");
  if (!(MUTABLE_OBJECT_TYPES as readonly string[]).includes(objectType)) {
    throw new HttpError(
      400,
      `object request.objectType must be one of ${MUTABLE_OBJECT_TYPES.join(", ")}`,
    );
  }
  const content = record(body.content, "object request.content");
  if (objectType === "claim") {
    const contextId = requiredString(content.contextId, "claim content.contextId");
    const contextObject = listCurrentObjects(context.projectRoot, branchId).find(
      (object) => object.objectId === contextId && object.objectType === "context",
    );
    if (contextObject === undefined) {
      throw new HttpError(400, "claim content.contextId must name a visible context");
    }
  }
  return putObject(context.projectRoot, {
    branchId,
    objectType: objectType as (typeof MUTABLE_OBJECT_TYPES)[number],
    content,
    actor: context.actor,
  });
}

async function handleApi(
  request: IncomingMessage,
  response: ServerResponse,
  context: RequestContext,
  pathname: string,
  search: URLSearchParams,
): Promise<void> {
  if (!authorized(request, context.sessionToken)) {
    response.setHeader("www-authenticate", "Bearer");
    json(response, 401, { error: "Unauthorized" });
    return;
  }
  const origin = request.headers.origin;
  if (origin !== undefined && origin !== context.origin) {
    throw new HttpError(403, "Cross-origin requests are not allowed");
  }

  if (request.method === "GET" && pathname === "/api/workspace") {
    json(response, 200, await workspace(context.projectRoot, search.get("branch")));
    return;
  }
  if (request.method === "GET" && pathname === "/api/verification") {
    json(response, 200, await verifyProject(context.projectRoot));
    return;
  }
  const objectMatch = /^\/api\/objects\/([^/]+)$/u.exec(pathname);
  if (request.method === "GET" && objectMatch !== null) {
    const inspection = await inspectProject(context.projectRoot);
    const branchId = branchIdFor(
      inspection.branches,
      search.get("branch"),
      inspection.manifest.defaultBranchId,
    );
    json(
      response,
      200,
      await objectDetail(context.projectRoot, branchId, objectMatch[1]!),
    );
    return;
  }
  if (request.method === "POST" && pathname === "/api/branches") {
    json(
      response,
      201,
      await withProjectMutation(context, () => mutateBranch(request, context)),
    );
    return;
  }
  if (request.method === "POST" && pathname === "/api/objects") {
    json(
      response,
      201,
      await withProjectMutation(context, () => mutateObject(request, context)),
    );
    return;
  }
  throw new HttpError(404, "API route not found");
}

function serveAsset(response: ServerResponse, pathname: string): void {
  const asset = WORKBENCH_ASSETS[pathname];
  if (asset === undefined) throw new HttpError(404, "Asset not found");
  response.writeHead(200, {
    "cache-control": "no-store",
    "content-security-policy": [
      "default-src 'self'",
      "connect-src 'self'",
      "img-src 'self' data:",
      "script-src 'self'",
      "style-src 'self'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join("; "),
    "content-type": asset.contentType,
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  });
  response.end(asset.body);
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  context: RequestContext,
): Promise<void> {
  if (!requestIsLoopback(request)) throw new HttpError(403, "Loopback access only");
  if (request.headers.host !== context.origin.slice("http://".length)) {
    throw new HttpError(403, "Invalid Host header");
  }
  const { pathname, search } = safeRequestPath(request.url);
  if (pathname.startsWith("/api/")) {
    await handleApi(request, response, context, pathname, search);
    return;
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    throw new HttpError(405, "Method not allowed");
  }
  serveAsset(response, pathname === "/" ? "/index.html" : pathname);
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolveListen, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen({ host: LOOPBACK_HOST, port, exclusive: true }, () => {
      server.off("error", onError);
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Workbench server did not receive a TCP address"));
        return;
      }
      resolveListen(address.port);
    });
  });
}

export async function startWorkbenchServer(
  options: StartWorkbenchOptions,
): Promise<WorkbenchServer> {
  const projectRoot = resolve(options.projectRoot);
  await loadManifest(projectRoot);
  const requestedPort = options.port ?? 0;
  if (!Number.isSafeInteger(requestedPort) || requestedPort < 0 || requestedPort > 65_535) {
    throw new TypeError("Workbench port must be an integer from 0 through 65535");
  }
  const sessionToken = randomBytes(32).toString("base64url");
  // The client cannot choose this actor. Possession of the launch token is
  // treated as local administrative authority and stamped server-side.
  const actor: Actor = { actorType: "human", actorId: createId("hum") };
  let context: RequestContext | undefined;
  const server = createServer((request, response) => {
    if (context === undefined) {
      json(response, 503, { error: "Workbench is starting" });
      return;
    }
    void handleRequest(request, response, context).catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      const status = error instanceof HttpError ? error.status : 500;
      const message = error instanceof Error ? error.message : String(error);
      json(response, status, { error: status === 500 ? "Internal server error" : message });
    });
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  const port = await listen(server, requestedPort);
  const origin = `http://${LOOPBACK_HOST}:${port}`;
  context = {
    projectRoot,
    sessionToken,
    actor,
    origin,
  };
  let settleClosed!: () => void;
  const closed = new Promise<void>((resolveClosed) => {
    settleClosed = resolveClosed;
  });
  server.once("close", settleClosed);
  return {
    projectRoot,
    host: LOOPBACK_HOST,
    port,
    origin,
    url: `${origin}/#token=${encodeURIComponent(sessionToken)}`,
    sessionToken,
    actorId: actor.actorId,
    closed,
    close: () => new Promise<void>((resolveClose, reject) => {
      if (!server.listening) {
        resolveClose();
        return;
      }
      server.close((error) => error === undefined ? resolveClose() : reject(error));
    }),
  };
}

export function openWorkbenchInBrowser(url: string): void {
  const command = platform() === "darwin"
    ? { executable: "open", args: [url] }
    : platform() === "win32"
      ? { executable: "cmd", args: ["/c", "start", "", url] }
      : { executable: "xdg-open", args: [url] };
  const child = spawn(command.executable, command.args, {
    detached: true,
    stdio: "ignore",
  });
  child.on("error", () => undefined);
  child.unref();
}
