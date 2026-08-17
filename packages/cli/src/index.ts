#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import {
  EDGE_TYPES,
  OBJECT_TYPES,
  type EdgeType,
  type JsonValue,
  type ObjectType,
} from "@reasoning-workbench/project-format";
import {
  AgentCoordinator,
  addEdge,
  analyzeWorkingPaperImpact,
  compareResearchBranches,
  compileContext,
  computeImpact,
  createConfiguredModel,
  createExecutionToolRegistry,
  createBranch,
  createProject,
  createRp001Fixture,
  createWorkstream,
  deriveStaleness,
  deriveVerificationProfile,
  diffBranches,
  evaluateCompletionPolicy,
  exportProject,
  inspectProject,
  mergeBranchSafe,
  getWorkstream,
  listWorkstreams,
  inspectModelUsage,
  inspectWorkingPaper,
  LocalExecutionTarget,
  ModelGatewayRegistry,
  ModelRegistry,
  projectHistory,
  promoteArtifactToEvidence,
  putObject,
  putWorkingPaper,
  normalizeExecutionJob,
  executionJobDigest,
  promoteInteractiveTranscript,
  queryGraph,
  rebuildProjection,
  recordVerificationReview,
  registerArtifactFile,
  renderWorkingPaper,
  ScriptedModelAdapter,
  traverseGraph,
  verifyProject,
  WorkstreamRuntime,
  TOOL_CAPABILITIES,
  VERIFICATION_DIMENSIONS,
  type CompletionPolicy,
  type ConfiguredModel,
  type ModelAdapter,
  type ModelAction,
  type ModelAdapterConfig,
  type ModelModality,
  type ModelResponse,
  type ModelTaskType,
  type ToolCapability,
  type VerificationDimension,
  type VerificationOutcome,
} from "@reasoning-workbench/store";

export interface CliIo {
  stdout(text: string): void;
  stderr(text: string): void;
}

const processIo: CliIo = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

interface ParsedArguments {
  positionals: string[];
  options: Map<string, string | true>;
}

const BOOLEAN_OPTIONS = new Set([
  "help",
  "json",
  "require-tool-use",
  "unsafe-process-only",
]);

function parseArguments(args: readonly string[]): ParsedArguments {
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

function option(
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

function positional(
  parsed: ParsedArguments,
  index: number,
  label: string,
): string {
  const value = parsed.positionals[index];
  if (value === undefined) throw new Error(`Missing ${label}`);
  return value;
}

function outputJson(io: CliIo, value: unknown): void {
  io.stdout(`${JSON.stringify(value, null, 2)}\n`);
}

function asJsonObject(text: string, label: string): Record<string, unknown> {
  const value = JSON.parse(text) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must contain a JSON object`);
  }
  return value as Record<string, unknown>;
}

async function readContent(parsed: ParsedArguments): Promise<Record<string, unknown>> {
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

async function readJsonValue(
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
  return JSON.parse(inline ?? (await readFile(path!, "utf8"))) as unknown;
}

async function scriptedAdapter(
  parsed: ParsedArguments,
): Promise<ScriptedModelAdapter> {
  const scriptPath = option(parsed, "script-file", true)!;
  const value = JSON.parse(await readFile(scriptPath, "utf8")) as unknown;
  if (!Array.isArray(value)) {
    throw new Error(`${scriptPath} must contain a JSON array of model actions`);
  }
  return new ScriptedModelAdapter({
    script: value as readonly (ModelAction | ModelResponse)[],
  });
}

async function configuredModel(path: string): Promise<ConfiguredModel> {
  return createConfiguredModel(
    JSON.parse(await readFile(path, "utf8")) as unknown,
  );
}

async function selectedModelAdapter(parsed: ParsedArguments): Promise<ModelAdapter> {
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

async function configuredRegistry(path: string): Promise<ModelGatewayRegistry> {
  const value = JSON.parse(await readFile(path, "utf8")) as unknown;
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${path} must contain a non-empty JSON array of model configs`);
  }
  const registry = new ModelGatewayRegistry();
  for (const item of value as readonly ModelAdapterConfig[]) {
    registry.register(createConfiguredModel(item));
  }
  return registry;
}

function agentCoordinator(
  projectRoot: string,
  models = new ModelRegistry(),
): AgentCoordinator {
  return new AgentCoordinator(
    projectRoot,
    new WorkstreamRuntime(projectRoot, cliToolRegistry()),
    models,
  );
}

function cliToolRegistry() {
  return createExecutionToolRegistry([new LocalExecutionTarget()]);
}

function objectType(value: string): ObjectType {
  if (!(OBJECT_TYPES as readonly string[]).includes(value)) {
    throw new Error(
      `Unknown object type ${JSON.stringify(value)}; expected one of ${OBJECT_TYPES.join(", ")}`,
    );
  }
  return value as ObjectType;
}

function edgeType(value: string): EdgeType {
  if (!(EDGE_TYPES as readonly string[]).includes(value)) {
    throw new Error(
      `Unknown edge type ${JSON.stringify(value)}; expected one of ${EDGE_TYPES.join(", ")}`,
    );
  }
  return value as EdgeType;
}

function verificationOutcome(value: string): VerificationOutcome {
  if (!( ["passed", "failed", "inconclusive"] as const).includes(
    value as VerificationOutcome,
  )) {
    throw new Error("--outcome must be passed, failed, or inconclusive");
  }
  return value as VerificationOutcome;
}

function commaSeparated(value: string, label: string): string[] {
  const values = [...new Set(value.split(",").map((item) => item.trim()))].filter(
    (item) => item.length > 0,
  );
  if (values.length === 0) throw new Error(`${label} must not be empty`);
  return values;
}

function objectTypesOption(value: string | undefined): ObjectType[] | undefined {
  return value === undefined
    ? undefined
    : commaSeparated(value, "--object-type").map(objectType);
}

function edgeTypesOption(value: string | undefined): EdgeType[] | undefined {
  return value === undefined
    ? undefined
    : commaSeparated(value, "--edge-type").map(edgeType);
}

function nonNegativeInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return parsed;
}

function integerOption(
  parsed: ParsedArguments,
  name: string,
  fallback: number,
): number {
  const value = option(parsed, name);
  return value === undefined ? fallback : nonNegativeInteger(value, `--${name}`);
}

function capabilitiesOption(value: string | undefined): ToolCapability[] {
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

async function resolveBranchId(
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

const HELP = `Reasoning Workbench local reasoning runtime

Usage:
  rw init <project-dir> --title <title>
  rw info <project-dir>
  rw branch create <project-dir> <name> [--from <branch-id-or-name>]
  rw branch diff <project-dir> <source> <target>
  rw branch semantic-diff <project-dir> <source> <target>
  rw branch merge <project-dir> <source> <target>
  rw object put <project-dir> --type <type> [--branch <id-or-name>]
      (--content <json> | --content-file <path>) [--object-id <id>]
  rw edge add <project-dir> --type <type> --from <object-id> --to <object-id>
      --context <context-id> [--branch <id-or-name>] [--metadata <json>]
  rw artifact add <project-dir> <file> --media-type <type> --name <logical-name>
      --run-id <run-id> --environment-id <env-id> [--branch <id-or-name>]
  rw evidence promote <project-dir> --claim <claim-id> --context <context-id>
      --artifact <artifact-id> --dimension <dimension> --outcome <outcome>
      --summary <text> [--branch <id-or-name>]
  rw review record <project-dir> --claim <claim-id> --context <context-id>
      --outcome <outcome> --summary <text> [--branch <id-or-name>]
  rw verification profile <project-dir> <claim-id> --context <context-id>
      [--branch <id-or-name>]
  rw paper put <project-dir> (--paper <json> | --paper-file <path>)
      [--paper-id <document-id>] [--branch <id-or-name>]
  rw paper render <project-dir> <paper-id> [--format <markdown|latex>]
      [--branch <id-or-name>]
  rw paper inspect <project-dir> <paper-id> [--branch <id-or-name>]
  rw paper impact <project-dir> <paper-id> --changed <object-id,...>
      [--branch <id-or-name>]
  rw history <project-dir>
  rw graph query <project-dir> [--branch <id-or-name>]
      [--object-type <type,...>] [--edge-type <type,...>] [--context <id>]
  rw graph traverse <project-dir> --start <object-id,...>
      --direction <upstream|downstream|both> [--max-depth <n>]
      [--branch <id-or-name>] [--edge-type <type,...>]
  rw impact <project-dir> --changed <object-id,...> [--branch <id-or-name>]
  rw staleness <project-dir> --changed <object-id,...> [--branch <id-or-name>]
  rw policy evaluate <project-dir> --policy-file <path> [--branch <id-or-name>]
  rw context compile <project-dir> --goal <goal-id> [--branch <id-or-name>]
      [--query <text>] [--max-characters <n>] [--max-entries <n>]
  rw models inspect --model-config-file <path>
  rw models route --registry-file <path> --task <task>
      --input-tokens <n> --output-tokens <n>
      [--privacy <local-only|no-training-or-local|external-allowed>]
      [--modality <text,image,audio>] [--require-tool-use]
      [--max-cost-micros <n>]
  rw models usage <project-dir> [--branch <id-or-name>]
  rw execution inspect --job-file <path>
  rw execution promote --transcript-file <path>
  rw execution run <project-dir> <workstream-id> --job-file <path>
      [--timeout-ms <n>] [--unsafe-process-only]
  rw execution targets
  rw agent create <project-dir> <workstream-id>
      (--script-file <path> | --model-config-file <path>)
      [--query <text>] [--max-turns <n>] [--max-input-tokens <n>]
      [--max-output-tokens <n>] [--max-model-cost-micros <n>]
      [--repeated-action-limit <n>] [--max-characters <n>] [--max-entries <n>]
  rw agent <step|run> <project-dir> <session-id>
      (--script-file <path> | --model-config-file <path>)
  rw agent steer <project-dir> <session-id> --instruction <text>
  rw agent <status|resume> <project-dir> <session-id>
  rw agent list <project-dir>
  rw agent recover <project-dir>
  rw tools list
  rw workstream create <project-dir> <name> --goal <goal-id>
      --policy-file <path> --allow-tool <tool-id,...> [--capability <cap,...>]
      [--from <branch-id-or-name>] [--max-tool-calls <n>]
      [--max-wall-time-ms <n>] [--max-artifact-bytes <n>] [--max-cost-micros <n>]
  rw workstream list <project-dir>
  rw workstream status <project-dir> <workstream-id>
  rw workstream run <project-dir> <workstream-id> --tool <tool-id>
      (--input <json> | --input-file <path>) [--timeout-ms <n>]
  rw workstream <pause|resume|cancel|complete> <project-dir> <workstream-id>
  rw workstream recover <project-dir>
  rw verify <project-dir>
  rw rebuild <project-dir>
  rw export <project-dir> <destination-dir>
  rw fixture rp001 <project-dir>
`;

export async function runCli(
  args: readonly string[],
  io: CliIo = processIo,
): Promise<number> {
  const parsed = parseArguments(args);
  if (
    parsed.options.has("help") ||
    parsed.positionals.length === 0 ||
    parsed.positionals[0] === "help"
  ) {
    io.stdout(HELP);
    return 0;
  }

  const command = parsed.positionals[0]!;
  if (command === "init") {
    const projectRoot = positional(parsed, 1, "project directory");
    const created = await createProject(projectRoot, {
      title: option(parsed, "title", true)!,
    });
    outputJson(io, created);
    return 0;
  }

  if (command === "info") {
    outputJson(io, await inspectProject(positional(parsed, 1, "project directory")));
    return 0;
  }

  if (command === "branch" && parsed.positionals[1] === "create") {
    const projectRoot = positional(parsed, 2, "project directory");
    const baseReference = option(parsed, "from");
    const branch = await createBranch(projectRoot, {
      name: positional(parsed, 3, "branch name"),
      ...(baseReference === undefined
        ? {}
        : { baseBranchId: await resolveBranchId(projectRoot, baseReference) }),
    });
    outputJson(io, branch);
    return 0;
  }

  if (command === "branch" && parsed.positionals[1] === "diff") {
    const projectRoot = positional(parsed, 2, "project directory");
    const sourceBranchId = await resolveBranchId(
      projectRoot,
      positional(parsed, 3, "source branch"),
    );
    const targetBranchId = await resolveBranchId(
      projectRoot,
      positional(parsed, 4, "target branch"),
    );
    outputJson(
      io,
      await diffBranches(projectRoot, sourceBranchId, targetBranchId),
    );
    return 0;
  }

  if (command === "branch" && parsed.positionals[1] === "semantic-diff") {
    const projectRoot = positional(parsed, 2, "project directory");
    const sourceBranchId = await resolveBranchId(
      projectRoot,
      positional(parsed, 3, "source branch"),
    );
    const targetBranchId = await resolveBranchId(
      projectRoot,
      positional(parsed, 4, "target branch"),
    );
    outputJson(
      io,
      await compareResearchBranches(projectRoot, sourceBranchId, targetBranchId),
    );
    return 0;
  }

  if (command === "branch" && parsed.positionals[1] === "merge") {
    const projectRoot = positional(parsed, 2, "project directory");
    const sourceBranchId = await resolveBranchId(
      projectRoot,
      positional(parsed, 3, "source branch"),
    );
    const targetBranchId = await resolveBranchId(
      projectRoot,
      positional(parsed, 4, "target branch"),
    );
    outputJson(
      io,
      await mergeBranchSafe(projectRoot, { sourceBranchId, targetBranchId }),
    );
    return 0;
  }

  if (command === "object" && parsed.positionals[1] === "put") {
    const projectRoot = positional(parsed, 2, "project directory");
    const objectId = option(parsed, "object-id");
    const object = await putObject(projectRoot, {
      branchId: await resolveBranchId(projectRoot, option(parsed, "branch")),
      objectType: objectType(option(parsed, "type", true)!),
      content: await readContent(parsed),
      ...(objectId === undefined ? {} : { objectId }),
    });
    outputJson(io, object);
    return 0;
  }

  if (command === "edge" && parsed.positionals[1] === "add") {
    const projectRoot = positional(parsed, 2, "project directory");
    const metadataText = option(parsed, "metadata");
    const edge = await addEdge(projectRoot, {
      branchId: await resolveBranchId(projectRoot, option(parsed, "branch")),
      edgeType: edgeType(option(parsed, "type", true)!),
      fromObjectId: option(parsed, "from", true)!,
      toObjectId: option(parsed, "to", true)!,
      contextId: option(parsed, "context", true)!,
      ...(metadataText === undefined
        ? {}
        : { metadata: asJsonObject(metadataText, "--metadata") }),
    });
    outputJson(io, edge);
    return 0;
  }

  if (command === "artifact" && parsed.positionals[1] === "add") {
    const projectRoot = positional(parsed, 2, "project directory");
    const result = await registerArtifactFile(
      projectRoot,
      positional(parsed, 3, "artifact file"),
      {
        branchId: await resolveBranchId(projectRoot, option(parsed, "branch")),
        mediaType: option(parsed, "media-type", true)!,
        logicalName: option(parsed, "name", true)!,
        producedByRunId: option(parsed, "run-id", true)!,
        environmentId: option(parsed, "environment-id", true)!,
      },
    );
    outputJson(io, result);
    return 0;
  }

  if (command === "evidence" && parsed.positionals[1] === "promote") {
    const projectRoot = positional(parsed, 2, "project directory");
    const dimension = option(parsed, "dimension", true)!;
    if (!(VERIFICATION_DIMENSIONS as readonly string[]).includes(dimension)) {
      throw new Error(
        `--dimension must be one of ${VERIFICATION_DIMENSIONS.join(", ")}`,
      );
    }
    const outcome = verificationOutcome(option(parsed, "outcome", true)!);
    outputJson(
      io,
      await promoteArtifactToEvidence(projectRoot, {
        branchId: await resolveBranchId(projectRoot, option(parsed, "branch")),
        claimId: option(parsed, "claim", true)!,
        contextId: option(parsed, "context", true)!,
        artifactId: option(parsed, "artifact", true)!,
        dimension: dimension as VerificationDimension,
        outcome,
        summary: option(parsed, "summary", true)!,
      }),
    );
    return 0;
  }

  if (command === "review" && parsed.positionals[1] === "record") {
    const projectRoot = positional(parsed, 2, "project directory");
    outputJson(
      io,
      await recordVerificationReview(projectRoot, {
        branchId: await resolveBranchId(projectRoot, option(parsed, "branch")),
        claimId: option(parsed, "claim", true)!,
        contextId: option(parsed, "context", true)!,
        outcome: verificationOutcome(option(parsed, "outcome", true)!),
        summary: option(parsed, "summary", true)!,
      }),
    );
    return 0;
  }

  if (command === "verification" && parsed.positionals[1] === "profile") {
    const projectRoot = positional(parsed, 2, "project directory");
    outputJson(
      io,
      deriveVerificationProfile(projectRoot, {
        branchId: await resolveBranchId(projectRoot, option(parsed, "branch")),
        claimId: positional(parsed, 3, "claim ID"),
        contextId: option(parsed, "context", true)!,
      }),
    );
    return 0;
  }

  if (command === "paper" && parsed.positionals[1] === "put") {
    const projectRoot = positional(parsed, 2, "project directory");
    const paperId = option(parsed, "paper-id");
    outputJson(
      io,
      await putWorkingPaper(projectRoot, {
        branchId: await resolveBranchId(projectRoot, option(parsed, "branch")),
        paper: await readJsonValue(parsed, "paper", "paper-file"),
        ...(paperId === undefined ? {} : { paperId }),
      }),
    );
    return 0;
  }

  if (
    command === "paper" &&
    (parsed.positionals[1] === "render" || parsed.positionals[1] === "inspect")
  ) {
    const projectRoot = positional(parsed, 2, "project directory");
    const options = {
      branchId: await resolveBranchId(projectRoot, option(parsed, "branch")),
      paperId: positional(parsed, 3, "paper ID"),
    };
    const format = option(parsed, "format");
    if (
      format !== undefined &&
      format !== "markdown" &&
      format !== "latex"
    ) {
      throw new Error("--format must be markdown or latex");
    }
    outputJson(
      io,
      parsed.positionals[1] === "render"
        ? renderWorkingPaper(projectRoot, {
            ...options,
            ...(format === undefined
              ? {}
              : { format: format as "markdown" | "latex" }),
          })
        : inspectWorkingPaper(projectRoot, options),
    );
    return 0;
  }

  if (command === "paper" && parsed.positionals[1] === "impact") {
    const projectRoot = positional(parsed, 2, "project directory");
    outputJson(
      io,
      analyzeWorkingPaperImpact(projectRoot, {
        branchId: await resolveBranchId(projectRoot, option(parsed, "branch")),
        paperId: positional(parsed, 3, "paper ID"),
        changedObjectIds: commaSeparated(
          option(parsed, "changed", true)!,
          "--changed",
        ),
      }),
    );
    return 0;
  }

  if (command === "history") {
    outputJson(io, await projectHistory(positional(parsed, 1, "project directory")));
    return 0;
  }

  if (command === "graph" && parsed.positionals[1] === "query") {
    const projectRoot = positional(parsed, 2, "project directory");
    const objectTypes = objectTypesOption(option(parsed, "object-type"));
    const edgeTypes = edgeTypesOption(option(parsed, "edge-type"));
    outputJson(
      io,
      queryGraph(projectRoot, {
        branchId: await resolveBranchId(projectRoot, option(parsed, "branch")),
        ...(objectTypes === undefined ? {} : { objectTypes }),
        ...(edgeTypes === undefined ? {} : { edgeTypes }),
        ...(option(parsed, "context") === undefined
          ? {}
          : { contextId: option(parsed, "context")! }),
      }),
    );
    return 0;
  }

  if (command === "graph" && parsed.positionals[1] === "traverse") {
    const projectRoot = positional(parsed, 2, "project directory");
    const direction = option(parsed, "direction", true)!;
    if (!(["upstream", "downstream", "both"] as const).includes(
      direction as "upstream" | "downstream" | "both",
    )) {
      throw new Error("--direction must be upstream, downstream, or both");
    }
    const edgeTypes = edgeTypesOption(option(parsed, "edge-type"));
    const maxDepthText = option(parsed, "max-depth");
    outputJson(
      io,
      traverseGraph(projectRoot, {
        branchId: await resolveBranchId(projectRoot, option(parsed, "branch")),
        startObjectIds: commaSeparated(
          option(parsed, "start", true)!,
          "--start",
        ),
        direction: direction as "upstream" | "downstream" | "both",
        ...(edgeTypes === undefined ? {} : { edgeTypes }),
        ...(maxDepthText === undefined
          ? {}
          : { maxDepth: nonNegativeInteger(maxDepthText, "--max-depth") }),
      }),
    );
    return 0;
  }

  if (command === "impact" || command === "staleness") {
    const projectRoot = positional(parsed, 1, "project directory");
    const options = {
      branchId: await resolveBranchId(projectRoot, option(parsed, "branch")),
      changedObjectIds: commaSeparated(
        option(parsed, "changed", true)!,
        "--changed",
      ),
    };
    outputJson(
      io,
      command === "impact"
        ? computeImpact(projectRoot, options)
        : deriveStaleness(projectRoot, options),
    );
    return 0;
  }

  if (command === "policy" && parsed.positionals[1] === "evaluate") {
    const projectRoot = positional(parsed, 2, "project directory");
    const policyPath = option(parsed, "policy-file", true)!;
    const policy = JSON.parse(await readFile(policyPath, "utf8")) as CompletionPolicy;
    outputJson(
      io,
      await evaluateCompletionPolicy(projectRoot, {
        branchId: await resolveBranchId(projectRoot, option(parsed, "branch")),
        policy,
      }),
    );
    return 0;
  }

  if (command === "context" && parsed.positionals[1] === "compile") {
    const projectRoot = positional(parsed, 2, "project directory");
    const query = option(parsed, "query");
    outputJson(
      io,
      compileContext(projectRoot, {
        branchId: await resolveBranchId(projectRoot, option(parsed, "branch")),
        goalId: option(parsed, "goal", true)!,
        maxCharacters: integerOption(parsed, "max-characters", 16_384),
        maxEntries: integerOption(parsed, "max-entries", 64),
        ...(query === undefined ? {} : { query }),
      }),
    );
    return 0;
  }

  if (command === "models" && parsed.positionals[1] === "inspect") {
    const configured = await configuredModel(option(parsed, "model-config-file", true)!);
    outputJson(io, {
      descriptor: configured.adapter.descriptor,
      profile: configured.profile,
      configDigest: configured.configDigest,
    });
    return 0;
  }

  if (command === "models" && parsed.positionals[1] === "route") {
    const registry = await configuredRegistry(option(parsed, "registry-file", true)!);
    const task = option(parsed, "task", true)!;
    const knownTasks = [
      "discovery", "mathematics", "physics", "formal-math",
      "coding", "review", "extraction", "general",
    ] as const;
    if (!(knownTasks as readonly string[]).includes(task)) {
      throw new Error(`--task must be one of ${knownTasks.join(", ")}`);
    }
    const privacy = option(parsed, "privacy");
    const knownPrivacy = ["local-only", "no-training-or-local", "external-allowed"] as const;
    if (privacy !== undefined && !(knownPrivacy as readonly string[]).includes(privacy)) {
      throw new Error(`--privacy must be one of ${knownPrivacy.join(", ")}`);
    }
    const modalities = option(parsed, "modality") === undefined
      ? undefined
      : commaSeparated(option(parsed, "modality")!, "--modality");
    const knownModalities = ["text", "image", "audio"] as const;
    if (modalities?.some((item) => !(knownModalities as readonly string[]).includes(item))) {
      throw new Error(`--modality must contain only ${knownModalities.join(", ")}`);
    }
    const maxCostText = option(parsed, "max-cost-micros");
    outputJson(io, registry.route({
      task: task as ModelTaskType,
      estimatedInputTokens: nonNegativeInteger(
        option(parsed, "input-tokens", true)!,
        "--input-tokens",
      ),
      requestedOutputTokens: nonNegativeInteger(
        option(parsed, "output-tokens", true)!,
        "--output-tokens",
      ),
      requireStructuredOutput: true,
      ...(parsed.options.has("require-tool-use") ? { requireToolUse: true } : {}),
      ...(privacy === undefined
        ? {}
        : { privacy: privacy as "local-only" | "no-training-or-local" | "external-allowed" }),
      ...(modalities === undefined ? {} : { requiredModalities: modalities as ModelModality[] }),
      ...(maxCostText === undefined
        ? {}
        : { maxEstimatedCostMicros: nonNegativeInteger(maxCostText, "--max-cost-micros") }),
    }));
    return 0;
  }

  if (command === "models" && parsed.positionals[1] === "usage") {
    const projectRoot = positional(parsed, 2, "project directory");
    outputJson(
      io,
      inspectModelUsage(
        projectRoot,
        await resolveBranchId(projectRoot, option(parsed, "branch")),
      ),
    );
    return 0;
  }

  if (command === "execution" && parsed.positionals[1] === "inspect") {
    const path = option(parsed, "job-file", true)!;
    const job = normalizeExecutionJob(JSON.parse(await readFile(path, "utf8")) as unknown);
    outputJson(io, { job, jobDigest: executionJobDigest(job) });
    return 0;
  }

  if (command === "execution" && parsed.positionals[1] === "promote") {
    const path = option(parsed, "transcript-file", true)!;
    outputJson(
      io,
      promoteInteractiveTranscript(JSON.parse(await readFile(path, "utf8")) as unknown),
    );
    return 0;
  }

  if (command === "execution" && parsed.positionals[1] === "targets") {
    outputJson(io, [new LocalExecutionTarget().descriptor]);
    return 0;
  }

  if (command === "execution" && parsed.positionals[1] === "run") {
    const projectRoot = positional(parsed, 2, "project directory");
    const jobPath = option(parsed, "job-file", true)!;
    const timeoutText = option(parsed, "timeout-ms");
    const job = normalizeExecutionJob(
      JSON.parse(await readFile(jobPath, "utf8")) as unknown,
    );
    const executionRegistry = parsed.options.has("unsafe-process-only")
      ? createExecutionToolRegistry([
          new LocalExecutionTarget({ isolation: "process-only" }),
        ])
      : cliToolRegistry();
    outputJson(
      io,
      await new WorkstreamRuntime(projectRoot, executionRegistry).executeTool({
        workstreamId: positional(parsed, 3, "workstream ID"),
        toolId: "execution.local",
        input: job as unknown as JsonValue,
        ...(timeoutText === undefined
          ? {}
          : { timeoutMs: nonNegativeInteger(timeoutText, "--timeout-ms") }),
      }),
    );
    return 0;
  }

  if (command === "agent" && parsed.positionals[1] === "create") {
    const projectRoot = positional(parsed, 2, "project directory");
    const adapter = await selectedModelAdapter(parsed);
    const query = option(parsed, "query");
    outputJson(
      io,
      await agentCoordinator(
        projectRoot,
        new ModelRegistry().register(adapter),
      ).create({
        workstreamId: positional(parsed, 3, "workstream ID"),
        adapterId: adapter.descriptor.adapterId,
        limits: {
          maxTurns: integerOption(parsed, "max-turns", 8),
          maxInputTokens: integerOption(parsed, "max-input-tokens", 100_000),
          maxOutputTokens: integerOption(parsed, "max-output-tokens", 20_000),
          maxCostMicros: integerOption(parsed, "max-model-cost-micros", 0),
          repeatedActionLimit: integerOption(parsed, "repeated-action-limit", 3),
        },
        context: {
          maxCharacters: integerOption(parsed, "max-characters", 16_384),
          maxEntries: integerOption(parsed, "max-entries", 64),
          ...(query === undefined ? {} : { query }),
        },
      }),
    );
    return 0;
  }

  if (
    command === "agent" &&
    (parsed.positionals[1] === "step" || parsed.positionals[1] === "run")
  ) {
    const projectRoot = positional(parsed, 2, "project directory");
    const adapter = await selectedModelAdapter(parsed);
    const coordinator = agentCoordinator(
      projectRoot,
      new ModelRegistry().register(adapter),
    );
    const sessionId = positional(parsed, 3, "agent session ID");
    outputJson(
      io,
      parsed.positionals[1] === "step"
        ? await coordinator.step(sessionId)
        : await coordinator.run(sessionId),
    );
    return 0;
  }

  if (command === "agent" && parsed.positionals[1] === "steer") {
    const projectRoot = positional(parsed, 2, "project directory");
    const decisionId = await agentCoordinator(projectRoot).appendSteering(
      positional(parsed, 3, "agent session ID"),
      { instruction: option(parsed, "instruction", true)! },
    );
    outputJson(io, { decisionId });
    return 0;
  }

  if (command === "agent" && parsed.positionals[1] === "status") {
    outputJson(
      io,
      agentCoordinator(positional(parsed, 2, "project directory")).get(
        positional(parsed, 3, "agent session ID"),
      ),
    );
    return 0;
  }

  if (command === "agent" && parsed.positionals[1] === "list") {
    outputJson(
      io,
      agentCoordinator(positional(parsed, 2, "project directory")).list(),
    );
    return 0;
  }

  if (command === "agent" && parsed.positionals[1] === "resume") {
    const projectRoot = positional(parsed, 2, "project directory");
    outputJson(
      io,
      await agentCoordinator(projectRoot).resume(
        positional(parsed, 3, "agent session ID"),
      ),
    );
    return 0;
  }

  if (command === "agent" && parsed.positionals[1] === "recover") {
    outputJson(
      io,
      await agentCoordinator(
        positional(parsed, 2, "project directory"),
      ).recoverInterruptedTurns(),
    );
    return 0;
  }

  if (command === "tools" && parsed.positionals[1] === "list") {
    outputJson(
      io,
      cliToolRegistry()
        .list()
        .map((definition) => definition.contract),
    );
    return 0;
  }

  if (command === "workstream" && parsed.positionals[1] === "create") {
    const projectRoot = positional(parsed, 2, "project directory");
    const policyPath = option(parsed, "policy-file", true)!;
    const policy = JSON.parse(await readFile(policyPath, "utf8")) as CompletionPolicy;
    const allowedToolIds = commaSeparated(
      option(parsed, "allow-tool", true)!,
      "--allow-tool",
    );
    const registry = cliToolRegistry();
    for (const toolId of allowedToolIds) {
      if (registry.get(toolId) === undefined) {
        throw new Error(`Tool is not available in the CLI registry: ${toolId}`);
      }
    }
    const baseReference = option(parsed, "from");
    outputJson(
      io,
      await createWorkstream(projectRoot, {
        name: positional(parsed, 3, "workstream name"),
        goalId: option(parsed, "goal", true)!,
        allowedToolIds,
        capabilities: capabilitiesOption(option(parsed, "capability")),
        budget: {
          maxToolCalls: integerOption(parsed, "max-tool-calls", 10),
          maxWallTimeMs: integerOption(parsed, "max-wall-time-ms", 300_000),
          maxArtifactBytes: integerOption(
            parsed,
            "max-artifact-bytes",
            10 * 1024 * 1024,
          ),
          maxCostMicros: integerOption(parsed, "max-cost-micros", 0),
        },
        completionPolicy: policy,
        ...(baseReference === undefined
          ? {}
          : { baseBranchId: await resolveBranchId(projectRoot, baseReference) }),
      }),
    );
    return 0;
  }

  if (command === "workstream" && parsed.positionals[1] === "list") {
    outputJson(
      io,
      listWorkstreams(positional(parsed, 2, "project directory")),
    );
    return 0;
  }

  if (command === "workstream" && parsed.positionals[1] === "status") {
    outputJson(
      io,
      getWorkstream(
        positional(parsed, 2, "project directory"),
        positional(parsed, 3, "workstream ID"),
      ),
    );
    return 0;
  }

  if (command === "workstream" && parsed.positionals[1] === "run") {
    const projectRoot = positional(parsed, 2, "project directory");
    const timeoutText = option(parsed, "timeout-ms");
    const input = await readJsonValue(parsed, "input", "input-file");
    outputJson(
      io,
      await new WorkstreamRuntime(projectRoot, cliToolRegistry()).executeTool({
        workstreamId: positional(parsed, 3, "workstream ID"),
        toolId: option(parsed, "tool", true)!,
        input: input as JsonValue,
        ...(timeoutText === undefined
          ? {}
          : { timeoutMs: nonNegativeInteger(timeoutText, "--timeout-ms") }),
      }),
    );
    return 0;
  }

  if (
    command === "workstream" &&
    (["pause", "resume", "cancel", "complete"] as const).includes(
      parsed.positionals[1] as "pause" | "resume" | "cancel" | "complete",
    )
  ) {
    const action = parsed.positionals[1] as
      | "pause"
      | "resume"
      | "cancel"
      | "complete";
    const projectRoot = positional(parsed, 2, "project directory");
    const runtime = new WorkstreamRuntime(projectRoot, cliToolRegistry());
    outputJson(
      io,
      await runtime[action](positional(parsed, 3, "workstream ID")),
    );
    return 0;
  }

  if (command === "workstream" && parsed.positionals[1] === "recover") {
    const projectRoot = positional(parsed, 2, "project directory");
    outputJson(
      io,
      await new WorkstreamRuntime(
        projectRoot,
        cliToolRegistry(),
      ).recoverInterruptedRuns(),
    );
    return 0;
  }

  if (command === "verify") {
    const report = await verifyProject(positional(parsed, 1, "project directory"));
    outputJson(io, report);
    return report.ok ? 0 : 2;
  }

  if (command === "rebuild") {
    outputJson(io, await rebuildProjection(positional(parsed, 1, "project directory")));
    return 0;
  }

  if (command === "export") {
    outputJson(
      io,
      await exportProject(
        positional(parsed, 1, "project directory"),
        positional(parsed, 2, "destination directory"),
      ),
    );
    return 0;
  }

  if (command === "fixture" && parsed.positionals[1] === "rp001") {
    const fixture = await createRp001Fixture(
      positional(parsed, 2, "project directory"),
    );
    outputJson(io, {
      root: fixture.project.root,
      projectId: fixture.project.manifest.projectId,
      defaultBranchId: fixture.project.manifest.defaultBranchId,
      problemId: fixture.problem.objectId,
      contextId: fixture.context.objectId,
      goalId: fixture.goal.objectId,
      workstreamIds: fixture.workstreams.map((item) => item.objectId),
    });
    return 0;
  }

  throw new Error(`Unknown command. Run rw --help for usage.`);
}

async function main(): Promise<void> {
  try {
    process.exitCode = await runCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `rw: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(invokedPath).href
) {
  await main();
}
