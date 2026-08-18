import {
  inspectModelUsage,
  type ModelModality,
  type ModelTaskType,
} from "@reasoning-workbench/store";

import {
  formatModelRoute,
  formatModelUsage,
} from "../formatters/human.js";
import {
  commaSeparated,
  configuredModel,
  configuredRegistry,
  nonNegativeInteger,
  option,
  outputFormatted,
  outputJson,
  positional,
  resolveBranchId,
  type CliIo,
  type ParsedArguments,
} from "../helpers.js";

export async function handleModelsCommand(
  parsed: ParsedArguments,
  io: CliIo,
): Promise<number | null> {
  const command = parsed.positionals[0];
  if (command !== "models") return null;

  const subCommand = parsed.positionals[1];

  if (subCommand === "inspect") {
    const configured = await configuredModel(option(parsed, "model-config-file", true)!);
    outputJson(io, {
      descriptor: configured.adapter.descriptor,
      profile: configured.profile,
      configDigest: configured.configDigest,
    });
    return 0;
  }

  if (subCommand === "route") {
    const registry = await configuredRegistry(option(parsed, "registry-file", true)!);
    const task = option(parsed, "task", true)!;
    const knownTasks = [
      "discovery",
      "mathematics",
      "physics",
      "formal-math",
      "coding",
      "review",
      "extraction",
      "general",
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
    const route = registry.route({
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
    });
    outputFormatted(parsed, io, route, formatModelRoute);
    return 0;
  }

  if (subCommand === "usage") {
    const projectRoot = positional(parsed, 2, "project directory");
    const usage = inspectModelUsage(
      projectRoot,
      await resolveBranchId(projectRoot, option(parsed, "branch")),
    );
    outputFormatted(parsed, io, usage, formatModelUsage);
    return 0;
  }

  return null;
}
