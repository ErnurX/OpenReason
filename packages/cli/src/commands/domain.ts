import { readFile } from "node:fs/promises";

import type { JsonValue } from "@reasoning-workbench/project-format";

import {
  authorizeDomainPackBindings,
  buildResearchPackage,
  createBuiltInDomainPackRegistry,
  createCoreToolRegistry,
  createCoreVerifierRegistry,
  createDomainReferenceFixture,
  evaluateReferenceProject,
  inspectDomainPackConformance,
  instantiateDomainTemplate,
  REFERENCE_PROJECT_IDS,
  TOOL_CAPABILITIES,
  type ReferenceProjectId,
  type ToolCapability,
} from "@reasoning-workbench/store";

import { parseJsonSafely } from "../errors.js";
import {
  commaSeparated,
  option,
  outputJson,
  positional,
  resolveBranchId,
  type CliIo,
  type ParsedArguments,
} from "../helpers.js";

function referenceId(value: string): ReferenceProjectId {
  if (!(REFERENCE_PROJECT_IDS as readonly string[]).includes(value)) {
    throw new Error(`reference project must be one of ${REFERENCE_PROJECT_IDS.join(", ")}`);
  }
  return value as ReferenceProjectId;
}

async function contextFile(path: string | undefined): Promise<Record<string, JsonValue> | undefined> {
  if (path === undefined) return undefined;
  const value = parseJsonSafely(await readFile(path, "utf8"), path);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must contain a JSON object`);
  }
  return value as Record<string, JsonValue>;
}

export async function handleDomainCommand(
  parsed: ParsedArguments,
  io: CliIo,
): Promise<number | null> {
  const command = parsed.positionals[0];
  const registry = createBuiltInDomainPackRegistry();

  if (command === "domain" && parsed.positionals[1] === "packs") {
    outputJson(io, registry.list());
    return 0;
  }

  if (command === "domain" && parsed.positionals[1] === "show") {
    const packId = positional(parsed, 2, "pack ID");
    const pack = registry.get(packId);
    if (pack === undefined) throw new Error(`Unknown domain pack: ${packId}`);
    outputJson(io, pack);
    return 0;
  }

  if (command === "domain" && parsed.positionals[1] === "templates") {
    const packId = option(parsed, "pack");
    const packs = packId === undefined
      ? registry.list()
      : [registry.get(packId) ?? (() => { throw new Error(`Unknown domain pack: ${packId}`); })()];
    outputJson(io, packs.flatMap((pack) => pack.templates.map((template) => ({
      packId: pack.packId,
      packVersion: pack.version,
      ...template,
    }))));
    return 0;
  }

  if (command === "domain" && parsed.positionals[1] === "conformance") {
    const packId = positional(parsed, 2, "pack ID");
    const pack = registry.get(packId);
    if (pack === undefined) throw new Error(`Unknown domain pack: ${packId}`);
    outputJson(io, inspectDomainPackConformance(pack, {
      tools: createCoreToolRegistry(),
      verifiers: createCoreVerifierRegistry(),
    }));
    return 0;
  }

  if (command === "domain" && parsed.positionals[1] === "authorize") {
    const projectRoot = positional(parsed, 2, "project directory");
    const capabilityOption = option(parsed, "capability");
    const grantedCapabilities = capabilityOption === undefined
      ? []
      : commaSeparated(capabilityOption, "--capability").map((capability) => {
        if (!(TOOL_CAPABILITIES as readonly string[]).includes(capability)) {
          throw new Error(`Unknown capability ${capability}`);
        }
        return capability as ToolCapability;
      });
    outputJson(io, await authorizeDomainPackBindings(projectRoot, registry, {
      branchId: await resolveBranchId(projectRoot, option(parsed, "branch")),
      packId: option(parsed, "pack", true)!,
      allowedBindingIds: commaSeparated(option(parsed, "allow-binding", true)!, "--allow-binding"),
      grantedCapabilities,
      tools: createCoreToolRegistry(),
      verifiers: createCoreVerifierRegistry(),
    }));
    return 0;
  }

  if (command === "domain" && parsed.positionals[1] === "init") {
    const projectRoot = positional(parsed, 2, "project directory");
    const context = await contextFile(option(parsed, "context-file"));
    const problem = option(parsed, "problem");
    const goal = option(parsed, "goal");
    outputJson(io, await instantiateDomainTemplate(projectRoot, registry, {
      packId: option(parsed, "pack", true)!,
      templateId: option(parsed, "template", true)!,
      title: option(parsed, "title", true)!,
      ...(context === undefined ? {} : { context }),
      ...(problem === undefined ? {} : { problem }),
      ...(goal === undefined ? {} : { goal }),
    }));
    return 0;
  }

  if (command === "reference" && parsed.positionals[1] === "create") {
    outputJson(io, await createDomainReferenceFixture(
      positional(parsed, 2, "project directory"),
      referenceId(positional(parsed, 3, "reference project ID")),
    ));
    return 0;
  }

  if (command === "reference" && parsed.positionals[1] === "evaluate") {
    const projectRoot = positional(parsed, 2, "project directory");
    outputJson(io, await evaluateReferenceProject(projectRoot, {
      referenceId: referenceId(positional(parsed, 3, "reference project ID")),
      branchId: await resolveBranchId(projectRoot, option(parsed, "branch")),
    }));
    return 0;
  }

  if (command === "research-package" && parsed.positionals[1] === "build") {
    const projectRoot = positional(parsed, 2, "project directory");
    outputJson(io, await buildResearchPackage(
      projectRoot,
      positional(parsed, 3, "destination directory"),
      {
        referenceId: referenceId(option(parsed, "reference", true)!),
        branchId: await resolveBranchId(projectRoot, option(parsed, "branch")),
      },
    ));
    return 0;
  }

  return null;
}
