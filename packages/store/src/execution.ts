import { spawn } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { access, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { arch, platform, release, tmpdir } from "node:os";
import { dirname, isAbsolute, join, posix, resolve, sep } from "node:path";

import {
  canonicalJson,
  computeContentHash,
  type JsonValue,
  type ReproducibilityKind,
} from "@reasoning-workbench/project-format";

import {
  FileSystemArtifactStore,
  normalizeSha256Digest,
  sha256Digest as artifactSha256Digest,
} from "./cas.js";
import { projectHistory } from "./project.js";
import { listCurrentObjects } from "./projection.js";
import {
  ToolRegistry,
  createCoreToolRegistry,
  type ToolByteArtifact,
  type ToolCapability,
  type ToolDefinition,
  type ToolExecutionContext,
} from "./tools.js";

export const EXECUTION_STATUSES = [
  "succeeded",
  "failed",
  "timed-out",
  "cancelled",
  "resource-exceeded",
] as const;

export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];

export interface ExecutionResources {
  readonly wallTimeMs: number;
  readonly cpuTimeMs: number;
  readonly memoryBytes: number;
  readonly maxLogBytes: number;
  readonly maxOutputBytes: number;
  readonly maxProcesses: number;
}

export interface PythonExecutionProgram {
  readonly kind: "python";
  readonly entrypoint: string;
  readonly arguments: readonly string[];
}

export interface ProcessExecutionProgram {
  readonly kind: "process";
  readonly executable: string;
  readonly arguments: readonly string[];
}

export type ExecutionProgram = PythonExecutionProgram | ProcessExecutionProgram;

export interface ExecutionSourceFile {
  readonly path: string;
  readonly content: string;
  readonly mediaType: string;
}

export interface ExecutionInput {
  readonly digest: string;
  readonly path: string;
  readonly logicalName: string;
  readonly mediaType: string;
}

export interface ExecutionOutput {
  readonly path: string;
  readonly logicalName: string;
  readonly mediaType: string;
  readonly required: boolean;
}

export interface InteractivePromotionSource {
  readonly kind: "interactive-transcript";
  readonly sessionId: string;
  readonly cellDigests: readonly string[];
}

/** The normalized value is the immutable, hashable execution contract. */
export interface ExecutionJobSpec {
  readonly schemaVersion: 1;
  readonly program: ExecutionProgram;
  readonly files: readonly ExecutionSourceFile[];
  readonly inputs: readonly ExecutionInput[];
  readonly outputs: readonly ExecutionOutput[];
  readonly environment: Readonly<Record<string, string>>;
  readonly resources: ExecutionResources;
  readonly network: "deny";
  readonly reproducibility: ReproducibilityKind;
  readonly seed?: number;
  readonly parameters: Readonly<Record<string, JsonValue>>;
  readonly source?: InteractivePromotionSource;
}

export interface ExecutionArtifact {
  readonly logicalName: string;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
  readonly role: "stdout" | "stderr" | "output";
  readonly path?: string;
}

export interface ExecutionTargetDescriptor {
  readonly schemaVersion: 1;
  readonly targetId: string;
  readonly kind: "local" | "ssh";
  readonly version: string;
  readonly isolation: string;
  readonly requiredCapabilities: readonly ToolCapability[];
  readonly platform?: string;
  readonly architecture?: string;
  readonly configuration?: Readonly<Record<string, JsonValue>>;
}

export interface ExecutionTargetResult {
  readonly status: ExecutionStatus;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly durationMs: number;
  readonly diagnostics: readonly string[];
  readonly artifacts: readonly ExecutionArtifact[];
  readonly environment: Readonly<Record<string, JsonValue>>;
}

export interface ExecutionTargetAdapter {
  readonly descriptor: ExecutionTargetDescriptor;
  execute(
    job: ExecutionJobSpec,
    context: ToolExecutionContext,
  ): Promise<ExecutionTargetResult>;
}

export interface ExecutionResultOutput {
  readonly schemaVersion: 1;
  readonly kind: "execution-result";
  readonly jobDigest: string;
  readonly cacheKey: string;
  readonly targetId: string;
  readonly status: ExecutionStatus;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly durationMs: number;
  readonly cached: boolean;
  readonly sourceRunId?: string;
  readonly diagnostics: readonly string[];
  readonly artifacts: readonly {
    logicalName: string;
    mediaType: string;
    size: number;
    role: "stdout" | "stderr" | "output";
    path?: string;
  }[];
}

export interface InteractiveTranscriptCell {
  readonly cellId: string;
  readonly source: string;
}

export interface InteractiveTranscript {
  readonly schemaVersion: 1;
  readonly sessionId: string;
  readonly cells: readonly InteractiveTranscriptCell[];
  readonly inputs?: readonly unknown[];
  readonly outputs?: readonly unknown[];
  readonly environment?: Readonly<Record<string, string>>;
  readonly resources?: Partial<ExecutionResources>;
  readonly reproducibility?: ReproducibilityKind;
  readonly seed?: number;
  readonly parameters?: Readonly<Record<string, JsonValue>>;
}

export interface InteractivePromotion {
  readonly job: ExecutionJobSpec;
  readonly jobDigest: string;
  readonly sourceDigest: string;
}

const DEFAULT_RESOURCES: ExecutionResources = {
  wallTimeMs: 60_000,
  cpuTimeMs: 30_000,
  memoryBytes: 512 * 1024 * 1024,
  maxLogBytes: 1024 * 1024,
  maxOutputBytes: 16 * 1024 * 1024,
  maxProcesses: 1,
};

const MAX_JOB_BYTES = 8 * 1024 * 1024;
const MAX_JOB_ENTRIES = 1_024;
const MAX_INPUT_BYTES = 256 * 1024 * 1024;
const MAX_WALL_TIME_MS = 24 * 60 * 60 * 1_000;
const MAX_CPU_TIME_MS = 24 * 60 * 60 * 1_000;
const MAX_MEMORY_BYTES = 1024 * 1024 * 1024 * 1024;
const MAX_LOG_BYTES = 8 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_PROCESSES = 128;

const SECRET_NAME = /(?:^|_)(?:api_?key|secret|token|password|passwd|credential|private_?key)(?:$|_)/i;
const SECRET_VALUE = /(?:bearer\s+[A-Za-z0-9._~+/=-]{8,}|sk-[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/i;
const SHA256 = /^sha256:[0-9a-f]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(`${label} must be a plain object`);
  return value;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const known = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!known.has(key)) throw new TypeError(`${label} contains unsupported field ${key}`);
  }
}

function assertNoSecretMaterial(value: unknown, label: string): void {
  if (typeof value === "string") {
    if (SECRET_VALUE.test(value)) throw new TypeError(`${label} contains secret-like material`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoSecretMaterial(entry, `${label}[${index}]`));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    if (SECRET_NAME.test(key)) throw new TypeError(`${label} contains secret-like key ${key}`);
    assertNoSecretMaterial(entry, `${label}.${key}`);
  }
}

function stringValue(value: unknown, label: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    throw new TypeError(`${label} must be ${allowEmpty ? "a string" : "a non-empty string"}`);
  }
  if (value.includes("\0")) throw new TypeError(`${label} cannot contain NUL`);
  return value;
}

function stringArray(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  return value.map((entry, index) => stringValue(entry, `${label}[${index}]`, true));
}

function positiveInteger(value: unknown, label: string, fallback?: number): number {
  const selected = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(selected) || Number(selected) <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return Number(selected);
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return Number(value);
}

function workspacePath(value: unknown, label: string): string {
  const candidate = stringValue(value, label);
  if (
    isAbsolute(candidate) ||
    candidate.includes("\\") ||
    candidate === "." ||
    candidate.startsWith("./") ||
    posix.normalize(candidate) !== candidate ||
    candidate.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new TypeError(`${label} must be a normalized project-relative POSIX path`);
  }
  return candidate;
}

function sortedRecord<T>(input: Record<string, T>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(input).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function normalizedResources(value: unknown): ExecutionResources {
  const item = value === undefined ? {} : record(value, "job.resources");
  exactKeys(
    item,
    [
      "wallTimeMs",
      "cpuTimeMs",
      "memoryBytes",
      "maxLogBytes",
      "maxOutputBytes",
      "maxProcesses",
    ],
    "job.resources",
  );
  const resources = {
    wallTimeMs: positiveInteger(item.wallTimeMs, "job.resources.wallTimeMs", DEFAULT_RESOURCES.wallTimeMs),
    cpuTimeMs: positiveInteger(item.cpuTimeMs, "job.resources.cpuTimeMs", DEFAULT_RESOURCES.cpuTimeMs),
    memoryBytes: positiveInteger(item.memoryBytes, "job.resources.memoryBytes", DEFAULT_RESOURCES.memoryBytes),
    maxLogBytes: positiveInteger(item.maxLogBytes, "job.resources.maxLogBytes", DEFAULT_RESOURCES.maxLogBytes),
    maxOutputBytes: positiveInteger(item.maxOutputBytes, "job.resources.maxOutputBytes", DEFAULT_RESOURCES.maxOutputBytes),
    maxProcesses: positiveInteger(item.maxProcesses, "job.resources.maxProcesses", DEFAULT_RESOURCES.maxProcesses),
  };
  for (const [name, maximum] of [
    ["wallTimeMs", MAX_WALL_TIME_MS],
    ["cpuTimeMs", MAX_CPU_TIME_MS],
    ["memoryBytes", MAX_MEMORY_BYTES],
    ["maxLogBytes", MAX_LOG_BYTES],
    ["maxOutputBytes", MAX_OUTPUT_BYTES],
    ["maxProcesses", MAX_PROCESSES],
  ] as const) {
    if (resources[name] > maximum) {
      throw new TypeError(`job.resources.${name} exceeds the execution-plane maximum ${maximum}`);
    }
  }
  return resources;
}

function normalizedProgram(value: unknown): ExecutionProgram {
  const item = record(value, "job.program");
  const kind = stringValue(item.kind, "job.program.kind");
  if (kind === "python") {
    exactKeys(item, ["kind", "entrypoint", "arguments"], "job.program");
    const argumentsList = stringArray(item.arguments, "job.program.arguments");
    assertNoSecretMaterial(argumentsList, "job.program.arguments");
    return {
      kind,
      entrypoint: workspacePath(item.entrypoint, "job.program.entrypoint"),
      arguments: argumentsList,
    };
  }
  if (kind === "process") {
    exactKeys(item, ["kind", "executable", "arguments"], "job.program");
    const executable = stringValue(item.executable, "job.program.executable");
    if (!isAbsolute(executable)) {
      throw new TypeError("job.program.executable must be an absolute path");
    }
    const argumentsList = stringArray(item.arguments, "job.program.arguments");
    assertNoSecretMaterial(argumentsList, "job.program.arguments");
    return { kind, executable, arguments: argumentsList };
  }
  throw new TypeError("job.program.kind must be python or process");
}

function normalizedFiles(value: unknown): ExecutionSourceFile[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError("job.files must be an array");
  if (value.length > MAX_JOB_ENTRIES) throw new TypeError("job.files contains too many entries");
  const result = value.map((entry, index) => {
    const item = record(entry, `job.files[${index}]`);
    exactKeys(item, ["path", "content", "mediaType"], `job.files[${index}]`);
    const content = stringValue(item.content, `job.files[${index}].content`, true);
    assertNoSecretMaterial(content, `job.files[${index}].content`);
    return {
      path: workspacePath(item.path, `job.files[${index}].path`),
      content,
      mediaType:
        item.mediaType === undefined
          ? "text/plain; charset=utf-8"
          : stringValue(item.mediaType, `job.files[${index}].mediaType`),
    };
  });
  return result.sort((left, right) => left.path.localeCompare(right.path));
}

function normalizedInputs(value: unknown): ExecutionInput[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError("job.inputs must be an array");
  if (value.length > MAX_JOB_ENTRIES) throw new TypeError("job.inputs contains too many entries");
  const result = value.map((entry, index) => {
    const item = record(entry, `job.inputs[${index}]`);
    exactKeys(item, ["digest", "path", "logicalName", "mediaType"], `job.inputs[${index}]`);
    return {
      digest: normalizeSha256Digest(stringValue(item.digest, `job.inputs[${index}].digest`)),
      path: workspacePath(item.path, `job.inputs[${index}].path`),
      logicalName:
        item.logicalName === undefined
          ? workspacePath(item.path, `job.inputs[${index}].path`)
          : stringValue(item.logicalName, `job.inputs[${index}].logicalName`),
      mediaType:
        item.mediaType === undefined
          ? "application/octet-stream"
          : stringValue(item.mediaType, `job.inputs[${index}].mediaType`),
    };
  });
  return result.sort((left, right) => left.path.localeCompare(right.path));
}

function normalizedOutputs(value: unknown): ExecutionOutput[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError("job.outputs must be an array");
  if (value.length > MAX_JOB_ENTRIES) throw new TypeError("job.outputs contains too many entries");
  const result = value.map((entry, index) => {
    const item = record(entry, `job.outputs[${index}]`);
    exactKeys(item, ["path", "logicalName", "mediaType", "required"], `job.outputs[${index}]`);
    if (item.required !== undefined && typeof item.required !== "boolean") {
      throw new TypeError(`job.outputs[${index}].required must be boolean`);
    }
    return {
      path: workspacePath(item.path, `job.outputs[${index}].path`),
      logicalName: stringValue(item.logicalName, `job.outputs[${index}].logicalName`),
      mediaType: stringValue(item.mediaType, `job.outputs[${index}].mediaType`),
      required: item.required ?? true,
    };
  });
  return result.sort((left, right) => left.path.localeCompare(right.path));
}

function normalizedEnvironment(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  const item = record(value, "job.environment");
  const result: Record<string, string> = {};
  for (const [name, raw] of Object.entries(item)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new TypeError(`job.environment contains invalid variable name ${name}`);
    }
    if (SECRET_NAME.test(name)) {
      throw new TypeError(`job.environment cannot contain secret-like variable ${name}`);
    }
    const valueText = stringValue(raw, `job.environment.${name}`, true);
    if (SECRET_VALUE.test(valueText)) {
      throw new TypeError(`job.environment.${name} contains secret-like material`);
    }
    result[name] = valueText;
  }
  return sortedRecord(result);
}

function normalizedParameters(value: unknown): Record<string, JsonValue> {
  if (value === undefined) return {};
  const item = record(value, "job.parameters");
  canonicalJson(item);
  assertNoSecretMaterial(item, "job.parameters");
  return sortedRecord(item as Record<string, JsonValue>);
}

function normalizedSource(value: unknown): InteractivePromotionSource | undefined {
  if (value === undefined) return undefined;
  const item = record(value, "job.source");
  exactKeys(item, ["kind", "sessionId", "cellDigests"], "job.source");
  if (item.kind !== "interactive-transcript") {
    throw new TypeError("job.source.kind must be interactive-transcript");
  }
  if (!Array.isArray(item.cellDigests) || item.cellDigests.some((digest) => typeof digest !== "string" || !SHA256.test(digest))) {
    throw new TypeError("job.source.cellDigests must contain SHA-256 digests");
  }
  return {
    kind: "interactive-transcript",
    sessionId: stringValue(item.sessionId, "job.source.sessionId"),
    cellDigests: [...(item.cellDigests as string[])],
  };
}

export function normalizeExecutionJob(value: unknown): ExecutionJobSpec {
  const item = record(value, "job");
  exactKeys(
    item,
    [
      "schemaVersion",
      "program",
      "files",
      "inputs",
      "outputs",
      "environment",
      "resources",
      "network",
      "reproducibility",
      "seed",
      "parameters",
      "source",
    ],
    "job",
  );
  if (item.schemaVersion !== 1) throw new TypeError("job.schemaVersion must be 1");
  if (item.network !== undefined && item.network !== "deny") {
    throw new TypeError('job.network must be "deny"; network-enabled jobs are not supported');
  }
  const reproducibility = item.reproducibility ?? "deterministic";
  if (!(reproducibility === "deterministic" || reproducibility === "seeded" || reproducibility === "nondeterministic")) {
    throw new TypeError("job.reproducibility is unsupported");
  }
  const seed = item.seed === undefined ? undefined : nonNegativeInteger(item.seed, "job.seed");
  if (reproducibility === "seeded" && seed === undefined) {
    throw new TypeError("seeded jobs require job.seed");
  }
  if (reproducibility !== "seeded" && seed !== undefined) {
    throw new TypeError("job.seed is allowed only for seeded jobs");
  }

  const files = normalizedFiles(item.files);
  const inputs = normalizedInputs(item.inputs);
  const outputs = normalizedOutputs(item.outputs);
  const occupied = [...files, ...inputs].map((entry) => entry.path);
  if (new Set(occupied).size !== occupied.length) {
    throw new TypeError("job.files and job.inputs cannot target the same path twice");
  }
  const outputPaths = outputs.map((entry) => entry.path);
  if (new Set(outputPaths).size !== outputPaths.length) {
    throw new TypeError("job.outputs cannot contain duplicate paths");
  }
  const logicalNames = outputs.map((entry) => entry.logicalName);
  if (new Set(logicalNames).size !== logicalNames.length) {
    throw new TypeError("job.outputs cannot contain duplicate logical names");
  }
  if (logicalNames.some((name) => name === "stdout.log" || name === "stderr.log")) {
    throw new TypeError("job output logical names stdout.log and stderr.log are reserved");
  }

  const program = normalizedProgram(item.program);
  if (program.kind === "python" && !occupied.includes(program.entrypoint)) {
    throw new TypeError("Python entrypoint must be supplied in job.files or job.inputs");
  }
  const source = normalizedSource(item.source);
  const normalized: ExecutionJobSpec = {
    schemaVersion: 1,
    program,
    files,
    inputs,
    outputs,
    environment: normalizedEnvironment(item.environment),
    resources: normalizedResources(item.resources),
    network: "deny",
    reproducibility,
    ...(seed === undefined ? {} : { seed }),
    parameters: normalizedParameters(item.parameters),
    ...(source === undefined ? {} : { source }),
  };
  if (Buffer.byteLength(canonicalJson(normalized), "utf8") > MAX_JOB_BYTES) {
    throw new TypeError(`normalized job exceeds the ${MAX_JOB_BYTES}-byte limit`);
  }
  return normalized;
}

export function executionJobDigest(value: unknown): string {
  return computeContentHash(normalizeExecutionJob(value));
}

function jsonClone(value: unknown): JsonValue {
  return JSON.parse(canonicalJson(value)) as JsonValue;
}

function executableIdentity(path: string): Readonly<Record<string, JsonValue>> {
  try {
    const bytes = readFileSync(path);
    return {
      path,
      resolvedPath: realpathSync(path),
      digest: artifactSha256Digest(bytes),
      size: bytes.byteLength,
    };
  } catch {
    return { path, available: false };
  }
}

function resolveWorkspacePath(root: string, relativePath: string): string {
  const target = resolve(root, ...relativePath.split("/"));
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw new Error(`Workspace path escaped its root: ${relativePath}`);
  }
  return target;
}

async function assertArtifactInputsVisible(
  job: ExecutionJobSpec,
  context: ToolExecutionContext,
): Promise<void> {
  if (job.inputs.length === 0) return;
  if (context.projectRoot === undefined || context.branchId === undefined) {
    throw new Error("Artifact inputs require projectRoot and branchId execution context");
  }
  const events = await projectHistory(context.projectRoot);
  const parents = new Map<string, { parentBranchId?: string; baseSequence: number }>();
  const heads = new Map<string, number>();
  for (const event of events) {
    if (event.eventType === "BranchCreated") {
      const created = event.payload.branchId;
      const parent = event.payload.baseBranchId;
      if (typeof created === "string") {
        parents.set(created, {
          ...(typeof parent === "string" ? { parentBranchId: parent } : {}),
          baseSequence: typeof parent === "string" ? (heads.get(parent) ?? 0) : 0,
        });
      }
    }
    if (event.branchId !== undefined) heads.set(event.branchId, event.sequence);
  }

  const visibleUntil = new Map<string, number>();
  const visited = new Set<string>();
  let branchId: string | undefined = context.branchId;
  let cutoff = Number.POSITIVE_INFINITY;
  while (branchId !== undefined && !visited.has(branchId)) {
    visited.add(branchId);
    visibleUntil.set(branchId, cutoff);
    const lineage = parents.get(branchId);
    if (lineage?.parentBranchId === undefined) break;
    cutoff = Math.min(cutoff, lineage.baseSequence);
    branchId = lineage.parentBranchId;
  }

  const visibleDigests = new Set<string>();
  for (const event of events) {
    if (event.eventType !== "ArtifactRegistered" || event.branchId === undefined) continue;
    const branchCutoff = visibleUntil.get(event.branchId);
    if (branchCutoff === undefined || event.sequence > branchCutoff) continue;
    const artifact = event.payload.artifact;
    if (isRecord(artifact) && typeof artifact.digest === "string") {
      visibleDigests.add(artifact.digest);
    }
  }
  for (const input of job.inputs) {
    if (!visibleDigests.has(input.digest)) {
      throw new Error(
        `Artifact input ${input.digest} is not visible on branch ${context.branchId}`,
      );
    }
  }
}

async function materializeJob(root: string, job: ExecutionJobSpec, projectRoot?: string): Promise<void> {
  for (const file of job.files) {
    const path = resolveWorkspacePath(root, file.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.content, { encoding: "utf8", mode: 0o600, flag: "wx" });
  }
  if (job.inputs.length > 0 && projectRoot === undefined) {
    throw new Error("Artifact inputs require a projectRoot execution context");
  }
  const store = projectRoot === undefined ? undefined : new FileSystemArtifactStore(projectRoot);
  let totalInputBytes = 0;
  for (const input of job.inputs) {
    const verification = await store!.verify(input.digest);
    if (!verification.valid || verification.size === undefined) {
      // `read` produces the precise missing/corruption error.
      await store!.read(input.digest);
      throw new Error(`Artifact input could not be verified: ${input.digest}`);
    }
    totalInputBytes += verification.size;
    if (totalInputBytes > MAX_INPUT_BYTES) {
      throw new Error(`Artifact inputs exceed the ${MAX_INPUT_BYTES}-byte materialization limit`);
    }
    const bytes = await store!.read(input.digest);
    const path = resolveWorkspacePath(root, input.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes, { mode: 0o400, flag: "wx" });
  }
}

interface CapturedProcess {
  exitCode: number | null;
  signal: string | null;
  stdout: Uint8Array;
  stderr: Uint8Array;
  timedOut: boolean;
  aborted: boolean;
  logLimitExceeded: boolean;
  durationMs: number;
}

interface CapturedProcessOptions {
  readonly command: string;
  readonly arguments: readonly string[];
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly signal: AbortSignal;
  readonly wallTimeMs: number;
  readonly maxLogBytes: number;
  readonly stdin?: Uint8Array;
}

function terminateProcess(child: ReturnType<typeof spawn>): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  const timer = setTimeout(() => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }, 250);
  timer.unref();
}

async function runCapturedProcess(options: CapturedProcessOptions): Promise<CapturedProcess> {
  if (options.signal.aborted) throw options.signal.reason ?? new Error("Execution aborted");
  const started = Date.now();
  return new Promise<CapturedProcess>((resolvePromise, reject) => {
    const child = spawn(options.command, [...options.arguments], {
      cwd: options.cwd,
      env: options.environment,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let aborted = false;
    let logLimitExceeded = false;

    const append = (target: Buffer[], chunk: Buffer, isStdout: boolean): void => {
      const used = stdoutBytes + stderrBytes;
      const remaining = Math.max(0, options.maxLogBytes - used);
      if (remaining > 0) target.push(chunk.subarray(0, remaining));
      if (isStdout) stdoutBytes += Math.min(chunk.byteLength, remaining);
      else stderrBytes += Math.min(chunk.byteLength, remaining);
      if (chunk.byteLength > remaining && !logLimitExceeded) {
        logLimitExceeded = true;
        terminateProcess(child);
      }
    };
    child.stdout.on("data", (chunk: Buffer) => append(stdout, chunk, true));
    child.stderr.on("data", (chunk: Buffer) => append(stderr, chunk, false));
    child.once("error", reject);

    const timeout = setTimeout(() => {
      timedOut = true;
      terminateProcess(child);
    }, options.wallTimeMs);
    timeout.unref();
    const onAbort = (): void => {
      aborted = true;
      terminateProcess(child);
    };
    options.signal.addEventListener("abort", onAbort, { once: true });

    if (options.stdin === undefined) child.stdin.end();
    else child.stdin.end(options.stdin);

    child.once("close", (exitCode, signal) => {
      clearTimeout(timeout);
      options.signal.removeEventListener("abort", onAbort);
      resolvePromise({
        exitCode,
        signal,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        timedOut,
        aborted,
        logLimitExceeded,
        durationMs: Math.max(0, Date.now() - started),
      });
    });
  });
}

function shellLimits(resources: ExecutionResources): string {
  const cpuSeconds = Math.max(1, Math.ceil(resources.cpuTimeMs / 1_000));
  const outputBlocks = Math.max(1, Math.ceil(resources.maxOutputBytes / 512));
  return [
    `ulimit -t ${cpuSeconds}`,
    `ulimit -f ${outputBlocks}`,
    'exec "$@"',
  ].join("\n");
}

function macSandboxProfile(workspace: string): string {
  return [
    "(version 1)",
    "(deny default)",
    "(allow process-exec)",
    "(deny process-fork)",
    "(allow signal (target self))",
    "(allow file-read*",
    `  (subpath ${JSON.stringify(workspace)})`,
    '  (subpath "/usr")',
    '  (subpath "/bin")',
    '  (subpath "/System")',
    '  (subpath "/Library/Developer/CommandLineTools")',
    '  (subpath "/private/etc")',
    '  (subpath "/private/var/db/timezone")',
    '  (literal "/dev/null")',
    '  (literal "/dev/random")',
    '  (literal "/dev/urandom"))',
    `(allow file-write* (subpath ${JSON.stringify(workspace)}))`,
    "(allow sysctl-read)",
    "(allow mach-lookup)",
    "(deny network*)",
  ].join("\n");
}

export interface LocalExecutionTargetOptions {
  readonly targetId?: string;
  readonly pythonExecutable?: string;
  readonly sandboxExecutable?: string;
  /** Explicit development fallback; it does not satisfy filesystem isolation. */
  readonly isolation?: "required" | "process-only";
  readonly workspaceBaseDirectory?: string;
}

export class LocalExecutionTarget implements ExecutionTargetAdapter {
  public readonly descriptor: ExecutionTargetDescriptor;
  readonly #pythonExecutable: string;
  readonly #sandboxExecutable: string;
  readonly #isolation: "required" | "process-only";
  readonly #workspaceBaseDirectory: string;

  public constructor(options: LocalExecutionTargetOptions = {}) {
    this.#pythonExecutable = options.pythonExecutable ?? "/usr/bin/python3";
    this.#sandboxExecutable = options.sandboxExecutable ?? "/usr/bin/sandbox-exec";
    this.#isolation = options.isolation ?? "required";
    this.#workspaceBaseDirectory = options.workspaceBaseDirectory ?? tmpdir();
    this.descriptor = {
      schemaVersion: 1,
      targetId: options.targetId ?? "local",
      kind: "local",
      version: "1.0.0",
      isolation:
        this.#isolation === "process-only"
          ? "process-only-explicit-unsafe-fallback"
          : platform() === "darwin"
            ? "macos-sandbox-exec+posix-rlimits"
            : "unavailable-requires-macos",
      requiredCapabilities: [
        "project.read",
        "project.artifact.write",
        "filesystem.read",
        "filesystem.write",
        "process.execute",
        "compute.local",
      ],
      platform: platform(),
      architecture: arch(),
      configuration: {
        pythonExecutable: jsonClone(executableIdentity(this.#pythonExecutable)),
        sandboxExecutable: jsonClone(executableIdentity(this.#sandboxExecutable)),
        shellExecutable: jsonClone(executableIdentity("/bin/sh")),
        operatingSystemRelease: release(),
        isolationMode: this.#isolation,
      },
    };
  }

  public async execute(
    job: ExecutionJobSpec,
    context: ToolExecutionContext,
  ): Promise<ExecutionTargetResult> {
    if (this.#isolation === "required") {
      if (platform() !== "darwin") {
        throw new Error("The required local isolation backend is available only on macOS");
      }
      await access(this.#sandboxExecutable).catch(() => {
        throw new Error(`Required sandbox executable is unavailable: ${this.#sandboxExecutable}`);
      });
      if (job.resources.maxProcesses !== 1) {
        throw new Error("The macOS isolation backend currently enforces maxProcesses=1 only");
      }
    }
    await mkdir(this.#workspaceBaseDirectory, { recursive: true });
    const workspace = await mkdtemp(join(this.#workspaceBaseDirectory, "rw-exec-"));
    try {
      await assertArtifactInputsVisible(job, context);
      await materializeJob(workspace, job, context.projectRoot);
      const temporary = join(workspace, ".tmp");
      await mkdir(temporary, { recursive: true });
      const program = job.program;
      const command = program.kind === "python" ? this.#pythonExecutable : program.executable;
      const programArguments =
        program.kind === "python"
          ? [resolveWorkspacePath(workspace, program.entrypoint), ...program.arguments]
          : [...program.arguments];
      const wrapperArguments = [
        "-c",
        shellLimits(job.resources),
        "rw-job",
        command,
        ...programArguments,
      ];
      const spawnedCommand =
        this.#isolation === "required" ? this.#sandboxExecutable : "/bin/sh";
      const spawnedArguments =
        this.#isolation === "required"
          ? ["-p", macSandboxProfile(workspace), "/bin/sh", ...wrapperArguments]
          : wrapperArguments;
      const environment: NodeJS.ProcessEnv = {
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        HOME: workspace,
        TMPDIR: temporary,
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        PYTHONDONTWRITEBYTECODE: "1",
        PYTHONHASHSEED:
          job.reproducibility === "seeded"
            ? String(job.seed)
            : job.reproducibility === "deterministic"
              ? "0"
              : "random",
        RW_JOB_PARAMETERS_JSON: canonicalJson(job.parameters),
        ...(job.seed === undefined ? {} : { RW_JOB_SEED: String(job.seed) }),
        ...job.environment,
      };
      const captured = await runCapturedProcess({
        command: spawnedCommand,
        arguments: spawnedArguments,
        cwd: workspace,
        environment,
        signal: context.signal,
        wallTimeMs: job.resources.wallTimeMs,
        maxLogBytes: job.resources.maxLogBytes,
      });
      if (
        this.#isolation === "required" &&
        captured.exitCode !== 0 &&
        /^sandbox-exec:/mu.test(Buffer.from(captured.stderr).toString("utf8"))
      ) {
        throw new Error("The local OS sandbox could not be applied; the job was not executed");
      }
      const artifacts: ExecutionArtifact[] = [
        {
          logicalName: "stdout.log",
          mediaType: "text/plain; charset=utf-8",
          bytes: captured.stdout,
          role: "stdout",
        },
        {
          logicalName: "stderr.log",
          mediaType: "text/plain; charset=utf-8",
          bytes: captured.stderr,
          role: "stderr",
        },
      ];
      const diagnostics: string[] = [];
      let outputBytes = 0;
      for (const declared of job.outputs) {
        const path = resolveWorkspacePath(workspace, declared.path);
        let metadata;
        try {
          metadata = await lstat(path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            if (declared.required) diagnostics.push(`Required output is missing: ${declared.path}`);
            continue;
          }
          throw error;
        }
        if (!metadata.isFile() || metadata.isSymbolicLink()) {
          diagnostics.push(`Declared output is not a regular file: ${declared.path}`);
          continue;
        }
        outputBytes += metadata.size;
        if (outputBytes > job.resources.maxOutputBytes) {
          diagnostics.push("Declared outputs exceed resources.maxOutputBytes");
          break;
        }
        artifacts.push({
          logicalName: declared.logicalName,
          mediaType: declared.mediaType,
          bytes: await readFile(path),
          role: "output",
          path: declared.path,
        });
      }
      if (captured.logLimitExceeded) diagnostics.push("Captured logs exceeded resources.maxLogBytes");
      const status: ExecutionStatus = captured.aborted
        ? "cancelled"
        : captured.timedOut
          ? "timed-out"
          : captured.logLimitExceeded || outputBytes > job.resources.maxOutputBytes
            ? "resource-exceeded"
            : captured.exitCode === 0 && diagnostics.length === 0
              ? "succeeded"
              : "failed";
      return {
        status,
        exitCode: captured.exitCode,
        signal: captured.signal,
        durationMs: captured.durationMs,
        diagnostics,
        artifacts,
        environment: {
          schemaVersion: 1,
          kind: "execution-environment",
          target: jsonClone(this.descriptor),
          operatingSystem: platform(),
          operatingSystemRelease: release(),
          nodeVersion: process.version,
          command,
          arguments:
            program.kind === "python"
              ? [program.entrypoint, ...program.arguments]
              : [...program.arguments],
          variables: jsonClone(environment),
          resources: jsonClone(job.resources),
          network: job.network,
          isolationEnforced: this.#isolation === "required",
          memoryLimitEnforced: false,
        },
      };
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }
}

export interface SshExecutionRequest {
  readonly schemaVersion: 1;
  readonly job: ExecutionJobSpec;
  readonly jobDigest: string;
  readonly inputArtifacts: readonly {
    readonly digest: string;
    readonly contentBase64: string;
  }[];
}

export interface SshTransport {
  readonly descriptor?: Readonly<Record<string, JsonValue>>;
  execute(request: SshExecutionRequest, context: ToolExecutionContext): Promise<unknown>;
}

export interface NodeSshTransportOptions {
  readonly host: string;
  readonly user?: string;
  readonly port?: number;
  readonly sshExecutable?: string;
  readonly remoteCommand?: readonly string[];
  readonly maxResponseBytes?: number;
}

export class NodeSshTransport implements SshTransport {
  public readonly descriptor: Readonly<Record<string, JsonValue>>;
  readonly #destination: string;
  readonly #port: number;
  readonly #sshExecutable: string;
  readonly #remoteCommand: readonly string[];
  readonly #maxResponseBytes: number;

  public constructor(options: NodeSshTransportOptions) {
    const host = stringValue(options.host, "ssh.host");
    if (!/^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?|\[[0-9A-Fa-f:]+\])$/.test(host)) {
      throw new TypeError("ssh.host contains unsupported characters");
    }
    const user = options.user;
    if (user !== undefined && !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(user)) {
      throw new TypeError("ssh.user contains unsupported characters");
    }
    this.#destination = user === undefined ? host : `${user}@${host}`;
    this.#port = positiveInteger(options.port, "ssh.port", 22);
    if (this.#port > 65_535) throw new TypeError("ssh.port must be at most 65535");
    this.#sshExecutable = options.sshExecutable ?? "/usr/bin/ssh";
    this.#remoteCommand = options.remoteCommand ?? ["reasoning-workbench-worker", "execute-json"];
    if (
      this.#remoteCommand.length === 0 ||
      this.#remoteCommand.some((part) => !/^[A-Za-z0-9_./:-]+$/.test(part))
    ) {
      throw new TypeError("ssh.remoteCommand contains unsupported shell characters");
    }
    this.#maxResponseBytes = positiveInteger(
      options.maxResponseBytes,
      "ssh.maxResponseBytes",
      32 * 1024 * 1024,
    );
    this.descriptor = {
      schemaVersion: 1,
      kind: "ssh-cli-json-worker",
      destination: this.#destination,
      port: this.#port,
      sshExecutable: this.#sshExecutable,
      remoteCommand: [...this.#remoteCommand],
      maxResponseBytes: this.#maxResponseBytes,
    };
  }

  public async execute(
    request: SshExecutionRequest,
    context: ToolExecutionContext,
  ): Promise<unknown> {
    const captured = await runCapturedProcess({
      command: this.#sshExecutable,
      arguments: [
        "-F",
        "/dev/null",
        "-T",
        "-o",
        "BatchMode=yes",
        "-o",
        "ClearAllForwardings=yes",
        "-o",
        "ForwardAgent=no",
        "-o",
        "ForwardX11=no",
        "-o",
        "PermitLocalCommand=no",
        "-o",
        "ProxyCommand=none",
        "-o",
        "StrictHostKeyChecking=yes",
        "-p",
        String(this.#port),
        "--",
        this.#destination,
        this.#remoteCommand.join(" "),
      ],
      cwd: tmpdir(),
      environment: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C.UTF-8" },
      signal: context.signal,
      wallTimeMs: request.job.resources.wallTimeMs,
      maxLogBytes: this.#maxResponseBytes,
      stdin: Buffer.from(`${canonicalJson(request)}\n`, "utf8"),
    });
    if (captured.timedOut) throw new Error("Remote execution transport timed out");
    if (captured.logLimitExceeded) throw new Error("Remote execution response exceeded its byte limit");
    if (captured.exitCode !== 0) {
      throw new Error(`Remote execution transport exited with code ${captured.exitCode ?? "signal"}`);
    }
    try {
      return JSON.parse(Buffer.from(captured.stdout).toString("utf8")) as unknown;
    } catch {
      throw new Error("Remote execution worker returned invalid JSON");
    }
  }
}

export interface SshExecutionTargetOptions {
  readonly targetId: string;
  readonly transport: SshTransport;
}

function base64Bytes(value: unknown, label: string): Uint8Array {
  const encoded = stringValue(value, label, true);
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new TypeError(`${label} must be canonical base64`);
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded) throw new TypeError(`${label} must be canonical base64`);
  return bytes;
}

export class SshExecutionTarget implements ExecutionTargetAdapter {
  public readonly descriptor: ExecutionTargetDescriptor;
  readonly #transport: SshTransport;

  public constructor(options: SshExecutionTargetOptions) {
    if (!/^[a-z][a-z0-9-]*$/.test(options.targetId)) {
      throw new TypeError("SSH targetId must be a lowercase identifier");
    }
    this.#transport = options.transport;
    assertNoSecretMaterial(
      options.transport.descriptor ?? { kind: "injected-transport" },
      "SSH transport descriptor",
    );
    this.descriptor = {
      schemaVersion: 1,
      targetId: options.targetId,
      kind: "ssh",
      version: "1.0.0",
      isolation: "remote-worker-declared",
      requiredCapabilities: [
        "project.read",
        "project.artifact.write",
        "process.execute",
        "network.access",
        "secrets.read",
        "compute.remote",
      ],
      configuration: {
        transport: jsonClone(options.transport.descriptor ?? {
          kind: "injected-transport",
        }),
      },
    };
  }

  public async execute(
    job: ExecutionJobSpec,
    context: ToolExecutionContext,
  ): Promise<ExecutionTargetResult> {
    await assertArtifactInputsVisible(job, context);
    if (job.inputs.length > 0 && context.projectRoot === undefined) {
      throw new Error("Remote artifact inputs require a projectRoot execution context");
    }
    const store = context.projectRoot === undefined
      ? undefined
      : new FileSystemArtifactStore(context.projectRoot);
    const verifiedInputs: Array<{ input: ExecutionInput; size: number }> = [];
    let totalInputBytes = 0;
    for (const input of job.inputs) {
      const verification = await store!.verify(input.digest);
      if (!verification.valid || verification.size === undefined) {
        await store!.read(input.digest);
        throw new Error(`Artifact input could not be verified: ${input.digest}`);
      }
      totalInputBytes += verification.size;
      if (totalInputBytes > MAX_INPUT_BYTES) {
        throw new Error(`Artifact inputs exceed the ${MAX_INPUT_BYTES}-byte transport limit`);
      }
      verifiedInputs.push({ input, size: verification.size });
    }
    const inputArtifacts = await Promise.all(
      verifiedInputs.map(async ({ input }) => ({
        digest: input.digest,
        contentBase64: Buffer.from(await store!.read(input.digest)).toString("base64"),
      })),
    );
    const raw = record(
      await this.#transport.execute(
        {
          schemaVersion: 1,
          job,
          jobDigest: computeContentHash(job),
          inputArtifacts,
        },
        context,
      ),
      "remote execution response",
    );
    exactKeys(
      raw,
      ["schemaVersion", "jobDigest", "status", "exitCode", "signal", "durationMs", "diagnostics", "artifacts", "environment"],
      "remote execution response",
    );
    if (raw.schemaVersion !== 1) throw new TypeError("remote execution response.schemaVersion must be 1");
    if (raw.jobDigest !== computeContentHash(job)) {
      throw new TypeError("remote execution response.jobDigest does not match the requested job");
    }
    if (!(EXECUTION_STATUSES as readonly unknown[]).includes(raw.status)) {
      throw new TypeError("remote execution response.status is unsupported");
    }
    if (raw.exitCode !== null && (!Number.isSafeInteger(raw.exitCode) || Number(raw.exitCode) < 0)) {
      throw new TypeError("remote execution response.exitCode must be null or non-negative integer");
    }
    if (raw.signal !== null && typeof raw.signal !== "string") {
      throw new TypeError("remote execution response.signal must be null or string");
    }
    if (!Array.isArray(raw.diagnostics) || raw.diagnostics.some((item) => typeof item !== "string")) {
      throw new TypeError("remote execution response.diagnostics must be strings");
    }
    assertNoSecretMaterial(raw.diagnostics, "remote execution response.diagnostics");
    if (!Array.isArray(raw.artifacts)) throw new TypeError("remote execution response.artifacts must be an array");
    const artifacts = raw.artifacts.map((entry, index): ExecutionArtifact => {
      const item = record(entry, `remote execution response.artifacts[${index}]`);
      exactKeys(item, ["logicalName", "mediaType", "contentBase64", "role", "path"], `remote execution response.artifacts[${index}]`);
      if (!(item.role === "stdout" || item.role === "stderr" || item.role === "output")) {
        throw new TypeError(`remote execution response.artifacts[${index}].role is unsupported`);
      }
      const path = item.path === undefined ? undefined : workspacePath(item.path, `remote execution response.artifacts[${index}].path`);
      return {
        logicalName: stringValue(item.logicalName, `remote execution response.artifacts[${index}].logicalName`),
        mediaType: stringValue(item.mediaType, `remote execution response.artifacts[${index}].mediaType`),
        bytes: base64Bytes(item.contentBase64, `remote execution response.artifacts[${index}].contentBase64`),
        role: item.role,
        ...(path === undefined ? {} : { path }),
      };
    });
    const artifactNames = artifacts.map((artifact) => artifact.logicalName);
    if (new Set(artifactNames).size !== artifactNames.length) {
      throw new TypeError("remote execution response contains duplicate artifact logical names");
    }
    const stdout = artifacts.filter((artifact) => artifact.role === "stdout");
    const stderr = artifacts.filter((artifact) => artifact.role === "stderr");
    if (
      stdout.length !== 1 ||
      stderr.length !== 1 ||
      stdout[0]?.logicalName !== "stdout.log" ||
      stderr[0]?.logicalName !== "stderr.log"
    ) {
      throw new TypeError("remote execution response must contain exact stdout.log and stderr.log artifacts");
    }
    const logBytes = stdout[0]!.bytes.byteLength + stderr[0]!.bytes.byteLength;
    if (logBytes > job.resources.maxLogBytes) {
      throw new TypeError("remote execution response logs exceed job.resources.maxLogBytes");
    }
    let outputBytes = 0;
    for (const artifact of artifacts.filter((candidate) => candidate.role === "output")) {
      const declaration = job.outputs.find(
        (output) =>
          output.path === artifact.path &&
          output.logicalName === artifact.logicalName &&
          output.mediaType === artifact.mediaType,
      );
      if (declaration === undefined) {
        throw new TypeError(`remote execution returned undeclared output ${artifact.logicalName}`);
      }
      outputBytes += artifact.bytes.byteLength;
    }
    if (outputBytes > job.resources.maxOutputBytes) {
      throw new TypeError("remote execution outputs exceed job.resources.maxOutputBytes");
    }
    if (
      raw.status === "succeeded" &&
      job.outputs.some(
        (output) =>
          output.required &&
          !artifacts.some(
            (artifact) => artifact.role === "output" && artifact.path === output.path,
          ),
      )
    ) {
      throw new TypeError("successful remote execution omitted a required output");
    }
    const environment = record(raw.environment, "remote execution response.environment");
    canonicalJson(environment);
    assertNoSecretMaterial(environment, "remote execution response.environment");
    return {
      status: raw.status as ExecutionStatus,
      exitCode: raw.exitCode as number | null,
      signal: raw.signal as string | null,
      durationMs: nonNegativeInteger(raw.durationMs, "remote execution response.durationMs"),
      diagnostics: [...(raw.diagnostics as string[])],
      artifacts,
      environment: {
        schemaVersion: 1,
        kind: "execution-environment",
        target: jsonClone(this.descriptor),
        remote: jsonClone(environment),
        network: job.network,
      },
    };
  }
}

function cacheKey(job: ExecutionJobSpec, target: ExecutionTargetAdapter): string {
  return computeContentHash({
    schemaVersion: 1,
    kind: "execution-cache-key",
    job,
    target: target.descriptor,
    programExecutable:
      job.program.kind === "process"
        ? executableIdentity(job.program.executable)
        : null,
  });
}

interface CachedExecution {
  readonly runId: string;
  readonly output: Record<string, unknown>;
  readonly artifacts: readonly ToolByteArtifact[];
}

async function findCachedExecution(
  projectRoot: string,
  branchId: string,
  target: ExecutionTargetAdapter,
  job: ExecutionJobSpec,
  key: string,
): Promise<CachedExecution | undefined> {
  if (
    job.reproducibility === "nondeterministic" ||
    target.descriptor.kind === "ssh"
  ) {
    return undefined;
  }
  const candidates = listCurrentObjects(projectRoot, branchId)
    .filter((object) => object.objectType === "run")
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.objectId.localeCompare(left.objectId));
  for (const candidate of candidates) {
    if (!isRecord(candidate.content)) continue;
    const content = candidate.content;
    if (content.status !== "succeeded" || !isRecord(content.tool) || content.tool.toolId !== `execution.${target.descriptor.targetId}`) continue;
    if (!isRecord(content.output) || content.output.kind !== "execution-result" || content.output.cacheKey !== key || content.output.status !== "succeeded") continue;
    if (!Array.isArray(content.artifacts)) continue;
    const store = new FileSystemArtifactStore(projectRoot);
    const artifacts: ToolByteArtifact[] = [];
    for (const [index, rawArtifact] of content.artifacts.entries()) {
      if (!isRecord(rawArtifact)) throw new Error(`Cached run artifact ${index} is malformed`);
      const digest = normalizeSha256Digest(stringValue(rawArtifact.digest, `cached artifact ${index}.digest`));
      artifacts.push({
        logicalName: stringValue(rawArtifact.logicalName, `cached artifact ${index}.logicalName`),
        mediaType: stringValue(rawArtifact.mediaType, `cached artifact ${index}.mediaType`),
        bytes: await store.read(digest),
        reproducibility: job.reproducibility,
        inputs: job.inputs.map((input) => input.digest),
      });
    }
    return { runId: candidate.objectId, output: content.output, artifacts };
  }
  return undefined;
}

function resultOutput(
  jobDigest: string,
  key: string,
  target: ExecutionTargetAdapter,
  result: ExecutionTargetResult,
  cached: boolean,
  sourceRunId?: string,
): ExecutionResultOutput {
  return {
    schemaVersion: 1,
    kind: "execution-result",
    jobDigest,
    cacheKey: key,
    targetId: target.descriptor.targetId,
    status: result.status,
    exitCode: result.exitCode,
    signal: result.signal,
    durationMs: result.durationMs,
    cached,
    ...(sourceRunId === undefined ? {} : { sourceRunId }),
    diagnostics: [...result.diagnostics],
    artifacts: result.artifacts.map((artifact) => ({
      logicalName: artifact.logicalName,
      mediaType: artifact.mediaType,
      size: artifact.bytes.byteLength,
      role: artifact.role,
      ...(artifact.path === undefined ? {} : { path: artifact.path }),
    })),
  };
}

const EXECUTION_OUTPUT_SCHEMA = {
  type: "object",
  required: [
    "schemaVersion",
    "kind",
    "jobDigest",
    "cacheKey",
    "targetId",
    "status",
    "exitCode",
    "signal",
    "durationMs",
    "cached",
    "diagnostics",
    "artifacts",
  ],
  properties: {
    schemaVersion: { const: 1 },
    kind: { const: "execution-result" },
    jobDigest: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
    cacheKey: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
    targetId: { type: "string", minLength: 1 },
    status: { enum: [...EXECUTION_STATUSES] },
    exitCode: { type: ["integer", "null"], minimum: 0 },
    signal: { type: ["string", "null"] },
    durationMs: { type: "integer", minimum: 0 },
    cached: { type: "boolean" },
    sourceRunId: { type: "string", minLength: 1 },
    diagnostics: { type: "array", items: { type: "string" } },
    artifacts: { type: "array", items: { type: "object" } },
  },
  additionalProperties: false,
} as const;

export function createExecutionTool(target: ExecutionTargetAdapter): ToolDefinition {
  canonicalJson(target.descriptor);
  assertNoSecretMaterial(target.descriptor, "execution target descriptor");
  const toolId = `execution.${target.descriptor.targetId}`;
  return {
    contract: {
      schemaVersion: 1,
      toolId,
      name: `Execute on ${target.descriptor.targetId}`,
      version: target.descriptor.version,
      description: "Run an immutable, resource-bounded job and capture declared artifacts.",
      inputSchema: { type: "object" },
      outputSchema: EXECUTION_OUTPUT_SCHEMA,
      requiredCapabilities: [...target.descriptor.requiredCapabilities],
      sideEffects:
        target.descriptor.kind === "ssh"
          ? ["artifact.write", "process.execute", "network.access"]
          : ["artifact.write", "filesystem.write", "process.execute"],
      determinism: "nondeterministic",
      supportsCancellation: true,
      defaultTimeoutMs: 10 * 60_000,
    },
    prepareInput: (input) => jsonClone(normalizeExecutionJob(input)),
    execute: async (input, context) => {
      const job = normalizeExecutionJob(input);
      await assertArtifactInputsVisible(job, context);
      const digest = computeContentHash(job);
      const key = cacheKey(job, target);
      if (context.projectRoot !== undefined && context.branchId !== undefined) {
        const cached = await findCachedExecution(context.projectRoot, context.branchId, target, job, key);
        if (cached !== undefined) {
          const prior = cached.output;
          const restored: ExecutionTargetResult = {
            status: "succeeded",
            exitCode: typeof prior.exitCode === "number" ? prior.exitCode : null,
            signal: typeof prior.signal === "string" ? prior.signal : null,
            durationMs: 0,
            diagnostics: [],
            artifacts: cached.artifacts.map((artifact, index) => {
              const metadata = Array.isArray(prior.artifacts) && isRecord(prior.artifacts[index])
                ? prior.artifacts[index]
                : {};
              const role = metadata.role === "stdout" || metadata.role === "stderr" || metadata.role === "output"
                ? metadata.role
                : "output";
              return {
                logicalName: artifact.logicalName,
                mediaType: artifact.mediaType,
                bytes: artifact.bytes,
                role,
                ...(typeof metadata.path === "string" ? { path: metadata.path } : {}),
              };
            }),
            environment: {
              schemaVersion: 1,
              kind: "execution-cache-reuse",
              target: jsonClone(target.descriptor),
              job: jsonClone(job),
              jobDigest: digest,
              cacheKey: key,
              sourceRunId: cached.runId,
            },
          };
          return {
            output: jsonClone(resultOutput(digest, key, target, restored, true, cached.runId)),
            artifacts: cached.artifacts,
            environment: restored.environment,
          };
        }
      }
      const result = await target.execute(job, context);
      assertNoSecretMaterial(result.environment, "execution target environment");
      assertNoSecretMaterial(result.diagnostics, "execution target diagnostics");
      return {
        output: jsonClone(resultOutput(digest, key, target, result, false)),
        artifacts: result.artifacts.map((artifact) => ({
          logicalName: artifact.logicalName,
          mediaType: artifact.mediaType,
          bytes: artifact.bytes,
          reproducibility: job.reproducibility,
          inputs: job.inputs.map((input) => input.digest),
        })),
        environment: {
          ...result.environment,
          job: jsonClone(job),
          jobDigest: digest,
          cacheKey: key,
        },
      };
    },
  };
}

export class ExecutionTargetRegistry {
  readonly #targets = new Map<string, ExecutionTargetAdapter>();

  public register(target: ExecutionTargetAdapter): this {
    const id = target.descriptor.targetId;
    if (!/^[a-z][a-z0-9-]*$/.test(id)) throw new TypeError("Execution target ID is invalid");
    if (this.#targets.has(id)) throw new Error(`Execution target already registered: ${id}`);
    this.#targets.set(id, target);
    return this;
  }

  public get(targetId: string): ExecutionTargetAdapter | undefined {
    return this.#targets.get(targetId);
  }

  public list(): readonly ExecutionTargetAdapter[] {
    return [...this.#targets.values()].sort((left, right) => left.descriptor.targetId.localeCompare(right.descriptor.targetId));
  }

  public addTools(registry: ToolRegistry = createCoreToolRegistry()): ToolRegistry {
    for (const target of this.list()) registry.register(createExecutionTool(target));
    return registry;
  }
}

export function createExecutionToolRegistry(
  targets: readonly ExecutionTargetAdapter[] = [new LocalExecutionTarget()],
): ToolRegistry {
  const registry = new ExecutionTargetRegistry();
  for (const target of targets) registry.register(target);
  return registry.addTools();
}

export function promoteInteractiveTranscript(value: unknown): InteractivePromotion {
  const transcript = record(value, "transcript");
  exactKeys(
    transcript,
    [
      "schemaVersion",
      "sessionId",
      "cells",
      "inputs",
      "outputs",
      "environment",
      "resources",
      "reproducibility",
      "seed",
      "parameters",
    ],
    "transcript",
  );
  if (transcript.schemaVersion !== 1) throw new TypeError("transcript.schemaVersion must be 1");
  if (!Array.isArray(transcript.cells) || transcript.cells.length === 0) {
    throw new TypeError("transcript.cells must be a non-empty array");
  }
  const cellIds = new Set<string>();
  const cells = transcript.cells.map((entry, index) => {
    const cell = record(entry, `transcript.cells[${index}]`);
    exactKeys(cell, ["cellId", "source"], `transcript.cells[${index}]`);
    const cellId = stringValue(cell.cellId, `transcript.cells[${index}].cellId`);
    if (cellIds.has(cellId)) throw new TypeError(`Duplicate transcript cell ID: ${cellId}`);
    cellIds.add(cellId);
    return {
      cellId,
      source: stringValue(cell.source, `transcript.cells[${index}].source`, true),
    };
  });
  const cellDigests = cells.map((cell) => computeContentHash(cell));
  const source = cells
    .map((cell, index) => `# %% [${index + 1}] ${cell.cellId}\n${cell.source}`)
    .join("\n\n");
  const job = normalizeExecutionJob({
    schemaVersion: 1,
    program: { kind: "python", entrypoint: "main.py", arguments: [] },
    files: [
      {
        path: "main.py",
        mediaType: "text/x-python; charset=utf-8",
        content: `${source}\n`,
      },
    ],
    inputs: transcript.inputs ?? [],
    outputs: transcript.outputs ?? [],
    environment: transcript.environment ?? {},
    resources: transcript.resources ?? {},
    network: "deny",
    reproducibility: transcript.reproducibility ?? "deterministic",
    ...(transcript.seed === undefined ? {} : { seed: transcript.seed }),
    parameters: transcript.parameters ?? {},
    source: {
      kind: "interactive-transcript",
      sessionId: stringValue(transcript.sessionId, "transcript.sessionId"),
      cellDigests,
    },
  });
  return {
    job,
    jobDigest: computeContentHash(job),
    sourceDigest: computeContentHash({
      schemaVersion: 1,
      sessionId: transcript.sessionId,
      cells,
    }),
  };
}
