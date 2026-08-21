#!/usr/bin/env -S node --no-warnings=ExperimentalWarning

import { pathToFileURL } from "node:url";

import { handleAgentCommand } from "./commands/agent.js";
import { handleBranchCommand } from "./commands/branch.js";
import { handleEvidenceCommand } from "./commands/evidence.js";
import { handleExecutionCommand } from "./commands/execution.js";
import { handleGraphCommand } from "./commands/graph.js";
import { handleLiteratureCommand } from "./commands/literature.js";
import { handleModelsCommand } from "./commands/models.js";
import { handleObjectsCommand } from "./commands/objects.js";
import { handlePaperCommand } from "./commands/paper.js";
import { handleProjectCommand } from "./commands/project.js";
import { handleWorkstreamCommand } from "./commands/workstream.js";
import { handleVerificationCommand } from "./commands/verification.js";
import { formatCliError } from "./errors.js";
import {
  parseArguments,
  processIo,
  type CliIo,
} from "./helpers.js";

export type { CliIo } from "./helpers.js";
export {
  formatCliError,
  formatJsonPath,
  formatZodError,
  isZodError,
  parseJsonSafely,
} from "./errors.js";

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
  rw verification list
  rw verification run <project-dir> --claim <claim-id> --context <context-id>
      --verifier <verifier-id> (--input <json> | --input-file <path>)
      [--artifact <id,...>] [--assumption <id,...>] [--branch <id-or-name>]
  rw verification packet <project-dir> --claim <claim-id> --context <context-id>
      [--evidence <id,...>] [--source <id,...>] [--branch <id-or-name>]
  rw verification review <project-dir> --review-file <path> [--branch <id-or-name>]
  rw verification loop <project-dir> --claim <claim-id> --context <context-id>
      [--enforce] [--branch <id-or-name>]
  rw verification align <project-dir> --alignment-file <path> [--branch <id-or-name>]
  rw verification recover <project-dir> [--branch <id-or-name>]
  rw paper put <project-dir> (--paper <json> | --paper-file <path>)
      [--paper-id <document-id>] [--branch <id-or-name>]
  rw paper render <project-dir> <paper-id> [--format <markdown|latex>]
      [--branch <id-or-name>]
  rw paper inspect <project-dir> <paper-id> [--branch <id-or-name>]
  rw paper impact <project-dir> <paper-id> --changed <object-id,...>
      [--branch <id-or-name>]
  rw literature ingest <project-dir> <file> [--metadata-file <path>]
      [--extracted-text-file <path>] [--kind <kind>] [--branch <id-or-name>]
  rw literature ingest-folder <project-dir> <folder> [--branch <id-or-name>]
  rw literature <list|show|open> <project-dir> [<source-id> [<anchor-id>]]
  rw literature search <project-dir> --query <text>
      [--mode <lexical|semantic|hybrid|citation>] [--anchor-kind <kind,...>]
      [--assumption <id,...>] [--seed-source <id,...>] [--limit <n>]
  rw literature review <project-dir> --source <id> --anchor <id>
      --outcome <accepted|rejected|revised> --summary <text>
  rw literature link <project-dir> --from <source-id> --to <source-id>
  rw literature cite <project-dir> --claim <id> --context <id> --citation-file <path>
  rw literature novelty <project-dir> --claim <id> --context <id> [--limit <n>]
  rw literature catalog-search --query <text> --allow-network [--limit <n>]
  rw literature catalog-ingest <project-dir> --record-file <path>
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
  rw cleanup <project-dir> [--dry-run] [--remove-orphans]
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

  const handlers = [
    handleProjectCommand,
    handleBranchCommand,
    handleObjectsCommand,
    handleEvidenceCommand,
    handleVerificationCommand,
    handlePaperCommand,
    handleLiteratureCommand,
    handleGraphCommand,
    handleModelsCommand,
    handleExecutionCommand,
    handleAgentCommand,
    handleWorkstreamCommand,
  ];

  for (const handler of handlers) {
    const result = await handler(parsed, io);
    if (result !== null) {
      return result;
    }
  }

  throw new Error("Unknown command. Run rw --help for usage.");
}

async function main(): Promise<void> {
  try {
    process.exitCode = await runCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`rw: ${formatCliError(error)}\n`);
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
