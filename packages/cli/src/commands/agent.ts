import { ModelRegistry } from "@reasoning-workbench/store";

import {
  agentCoordinator,
  integerOption,
  option,
  outputJson,
  positional,
  selectedModelAdapter,
  type CliIo,
  type ParsedArguments,
} from "../helpers.js";

export async function handleAgentCommand(
  parsed: ParsedArguments,
  io: CliIo,
): Promise<number | null> {
  const command = parsed.positionals[0];
  if (command !== "agent") return null;

  const subCommand = parsed.positionals[1];

  if (subCommand === "create") {
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

  if (subCommand === "step" || subCommand === "run") {
    const projectRoot = positional(parsed, 2, "project directory");
    const adapter = await selectedModelAdapter(parsed);
    const coordinator = agentCoordinator(
      projectRoot,
      new ModelRegistry().register(adapter),
    );
    const sessionId = positional(parsed, 3, "agent session ID");
    outputJson(
      io,
      subCommand === "step"
        ? await coordinator.step(sessionId)
        : await coordinator.run(sessionId),
    );
    return 0;
  }

  if (subCommand === "steer") {
    const projectRoot = positional(parsed, 2, "project directory");
    const decisionId = await agentCoordinator(projectRoot).appendSteering(
      positional(parsed, 3, "agent session ID"),
      { instruction: option(parsed, "instruction", true)! },
    );
    outputJson(io, { decisionId });
    return 0;
  }

  if (subCommand === "status") {
    outputJson(
      io,
      agentCoordinator(positional(parsed, 2, "project directory")).get(
        positional(parsed, 3, "agent session ID"),
      ),
    );
    return 0;
  }

  if (subCommand === "list") {
    outputJson(
      io,
      agentCoordinator(positional(parsed, 2, "project directory")).list(),
    );
    return 0;
  }

  if (subCommand === "resume") {
    const projectRoot = positional(parsed, 2, "project directory");
    outputJson(
      io,
      await agentCoordinator(projectRoot).resume(
        positional(parsed, 3, "agent session ID"),
      ),
    );
    return 0;
  }

  if (subCommand === "recover") {
    outputJson(
      io,
      await agentCoordinator(
        positional(parsed, 2, "project directory"),
      ).recoverInterruptedTurns(),
    );
    return 0;
  }

  return null;
}
