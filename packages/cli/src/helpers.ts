import { readFile } from "node:fs/promises";

import {
  EDGE_TYPES,
  OBJECT_TYPES,
  type EdgeType,
  type ObjectType,
} from "@reasoning-workbench/project-format";
import {
  AgentCoordinator,
  createConfiguredModel,
  createExecutionToolRegistry,
  inspectProject,
  LocalExecutionTarget,
  ModelGatewayRegistry,
  ModelRegistry,
  ScriptedModelAdapter,
  WorkstreamRuntime,
  TOOL_CAPABILITIES,
  type ConfiguredModel,
  type ModelAction,
  type ModelAdapter,
  type ModelAdapterConfig,
  type ModelResponse,
  type ToolCapability,
  type VerificationOutcome,
} from "@reasoning-workbench/store";

import { parseJsonSafely } from "./errors.js";

export interface CliIo {
  stdout(text: string): void;
  stderr(text: string): void;
}

export const processIo: CliIo = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

export interface ParsedArguments {
  positionals: string[];
  options: Map<string, string | true>;
}

export const BOOLEAN_OPTIONS = new Set([
  "allow-network",
  "dry-run",
  "enforce",
  "help",
  "human",
  "json",
  "remove-orphans",
  "require-tool-use",
  "unsafe-process-only",
]);

export function parseArguments(args: readonly string[]): ParsedArguments {
  const positionals: string[] = [];
  const options = new Map<string, string | true>();

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const equals = token.indexOf("=");
    if (equals >= 0) {
      const key = token.slice(2, equals);
      const value = token.slice(equals + 1);
      if (key.length === 0 || value.length === 0) {
        throw new Error(`Invalid option: ${token}`);
      }
      options.set(key, value);
      continue;
    }
    const key = token.slice(2);
    if (BOOLEAN_OPTIONS.has(key)) {
      options.set(key, true);
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Option --${key} requires a value`);
    }
    options.set(key, value);
    index += 1;
  }

  return { positionals, options };
}

export function option(
  parsed: ParsedArguments,
  name: string,
  required = false,
): string | undefined {
  const value = parsed.options.get(name);
  if (value === true) {
    throw new Error(`Option --${name} requires a value`);
  }
  if (value === undefined && required) {
    throw new Error(`Missing required option --${name}`);
  }
  return value;
}

export function positional(
  parsed: ParsedArguments,
  index: number,
  label: string,
): string {
  const value = parsed.positionals[index];
  if (value === undefined) throw new Error(`Missing ${label}`);
  return value;
}

export function outputJson(io: CliIo, value: unknown): void {
  io.stdout(`${JSON.stringify(value, null, 2)}\n`);
}

export function outputFormatted<T>(
  parsed: ParsedArguments,
  io: CliIo,
  value: T,
  formatHuman?: (value: T) => string,
): void {
  if (parsed.options.has("human") && formatHuman !== undefined) {
    io.stdout(`${formatHuman(value)}\n`);
  } else {
    outputJson(io, value);
  }
}

export function asJsonObject(text: string, label: string): Record<string, unknown> {
  const value = parseJsonSafely(text, label);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must contain a JSON object`);
  }
  return value as Record<string, unknown>;
}

export async function readContent(parsed: ParsedArguments): Promise<Record<string, unknown>> {
  const inline = option(parsed, "content");
  const path = option(parsed, "content-file");
  if (inline !== undefined && path !== undefined) {
    throw new Error("Use either --content or --content-file, not both");
  }
  if (inline === undefined && path === undefined) {
    throw new Error("Object content requires --content or --content-file");
  }
  return asJsonObject(
    inline ?? (await readFile(path!, "utf8")),
    path === undefined ? "--content" : path,
  );
}

export async function readJsonValue(
  parsed: ParsedArguments,
  inlineOption: string,
  fileOption: string,
): Promise<unknown> {
  const inline = option(parsed, inlineOption);
  const path = option(parsed, fileOption);
  if (inline !== undefined && path !== undefined) {
    throw new Error(`Use either --${inlineOption} or --${fileOption}, not both`);
  }
  if (inline === undefined && path === undefined) {
    throw new Error(`Requires --${inlineOption} or --${fileOption}`);
  }
  return parseJsonSafely(
    inline ?? (await readFile(path!, "utf8")),
    path === undefined ? `--${inlineOption}` : path,
  );
}

export async function scriptedAdapter(
  parsed: ParsedArguments,
): Promise<ScriptedModelAdapter> {
  const scriptPath = option(parsed, "script-file", true)!;
  const value = parseJsonSafely(await readFile(scriptPath, "utf8"), scriptPath);
  if (!Array.isArray(value)) {
    throw new Error(`${scriptPath} must contain a JSON array of model actions`);
  }
  return new ScriptedModelAdapter({
    script: value as readonly (ModelAction | ModelResponse)[],
  });
}

export async function configuredModel(path: string): Promise<ConfiguredModel> {
  return createConfiguredModel(
    parseJsonSafely(await readFile(path, "utf8"), path),
  );
}

export async function selectedModelAdapter(parsed: ParsedArguments): Promise<ModelAdapter> {
  const scriptPath = option(parsed, "script-file");
  const configPath = option(parsed, "model-config-file");
  if (scriptPath !== undefined && configPath !== undefined) {
    throw new Error("Use either --script-file or --model-config-file, not both");
  }
  if (scriptPath === undefined && configPath === undefined) {
    throw new Error("Model execution requires --script-file or --model-config-file");
  }
  return scriptPath === undefined
    ? (await configuredModel(configPath!)).adapter
    : scriptedAdapter(parsed);
}

export async function configuredRegistry(path: string): Promise<ModelGatewayRegistry> {
  const value = parseJsonSafely(await readFile(path, "utf8"), path);
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${path} must contain a non-empty JSON array of model configs`);
  }
  const registry = new ModelGatewayRegistry();
  for (const item of value as readonly ModelAdapterConfig[]) {
    registry.register(createConfiguredModel(item));
  }
  return registry;
}

export function cliToolRegistry() {
  return createExecutionToolRegistry([new LocalExecutionTarget()]);
}

export function agentCoordinator(
  projectRoot: string,
  models = new ModelRegistry(),
): AgentCoordinator {
  return new AgentCoordinator(
    projectRoot,
    new WorkstreamRuntime(projectRoot, cliToolRegistry()),
    models,
  );
}

export function objectType(value: string): ObjectType {
  if (!(OBJECT_TYPES as readonly string[]).includes(value)) {
    throw new Error(
      `Unknown object type ${JSON.stringify(value)}; expected one of ${OBJECT_TYPES.join(", ")}`,
    );
  }
  return value as ObjectType;
}

export function edgeType(value: string): EdgeType {
  if (!(EDGE_TYPES as readonly string[]).includes(value)) {
    throw new Error(
      `Unknown edge type ${JSON.stringify(value)}; expected one of ${EDGE_TYPES.join(", ")}`,
    );
  }
  return value as EdgeType;
}

export function verificationOutcome(value: string): VerificationOutcome {
  if (!(["passed", "failed", "inconclusive"] as const).includes(
    value as VerificationOutcome,
  )) {
    throw new Error("--outcome must be passed, failed, or inconclusive");
  }
  return value as VerificationOutcome;
}

export function commaSeparated(value: string, label: string): string[] {
  const values = [...new Set(value.split(",").map((item) => item.trim()))].filter(
    (item) => item.length > 0,
  );
  if (values.length === 0) throw new Error(`${label} must not be empty`);
  return values;
}

export function objectTypesOption(value: string | undefined): ObjectType[] | undefined {
  return value === undefined
    ? undefined
    : commaSeparated(value, "--object-type").map(objectType);
}

export function edgeTypesOption(value: string | undefined): EdgeType[] | undefined {
  return value === undefined
    ? undefined
    : commaSeparated(value, "--edge-type").map(edgeType);
}

export function nonNegativeInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return parsed;
}

export function integerOption(
  parsed: ParsedArguments,
  name: string,
  fallback: number,
): number {
  const value = option(parsed, name);
  return value === undefined ? fallback : nonNegativeInteger(value, `--${name}`);
}

export function capabilitiesOption(value: string | undefined): ToolCapability[] {
  if (value === undefined) return [];
  const known = new Set<string>(TOOL_CAPABILITIES);
  return commaSeparated(value, "--capability").map((capability) => {
    if (!known.has(capability)) {
      throw new Error(
        `Unknown capability ${JSON.stringify(capability)}; expected one of ${TOOL_CAPABILITIES.join(", ")}`,
      );
    }
    return capability as ToolCapability;
  });
}

export async function resolveBranchId(
  projectRoot: string,
  branchReference: string | undefined,
): Promise<string> {
  const inspection = await inspectProject(projectRoot);
  if (branchReference === undefined) return inspection.manifest.defaultBranchId;
  const matches = inspection.branches.filter(
    (branch) =>
      branch.branchId === branchReference || branch.name === branchReference,
  );
  if (matches.length === 0) {
    throw new Error(`Branch not found: ${branchReference}`);
  }
  if (matches.length > 1) {
    throw new Error(`Ambiguous branch name: ${branchReference}`);
  }
  return matches[0]!.branchId;
}
