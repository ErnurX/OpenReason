import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";

import {
  getLiteratureSource,
  groundClaimInLiterature,
  ingestCatalogRecord,
  ingestLiteratureFile,
  ingestLiteratureFolder,
  LITERATURE_ANCHOR_KINDS,
  LITERATURE_SCOPES,
  LITERATURE_SOURCE_KINDS,
  linkLiteratureCitation,
  listLiteratureSources,
  LiteratureCatalogRegistry,
  OpenAlexCatalogAdapter,
  resolveLiteratureAnchor,
  reviewLiteratureAnchor,
  searchLiterature,
  searchLiteratureCatalog,
  searchLiteratureNovelty,
  type LiteratureCatalogRecord,
  type LiteratureScope,
} from "@reasoning-workbench/store";

import { parseJsonSafely } from "../errors.js";
import {
  commaSeparated,
  integerOption,
  option,
  outputJson,
  positional,
  resolveBranchId,
  type CliIo,
  type ParsedArguments,
} from "../helpers.js";

function jsonObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must contain a JSON object`);
  }
  return value as Record<string, unknown>;
}

async function jsonFile(path: string): Promise<Record<string, unknown>> {
  return jsonObject(parseJsonSafely(await readFile(path, "utf8"), path), path);
}

function oneOf<T extends string>(value: string, allowed: readonly T[], label: string): T {
  if (!allowed.includes(value as T)) {
    throw new Error(`${label} must be one of ${allowed.join(", ")}`);
  }
  return value as T;
}

function stringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${label} must be an array of strings`);
  }
  return value as string[];
}

export async function handleLiteratureCommand(
  parsed: ParsedArguments,
  io: CliIo,
): Promise<number | null> {
  if (parsed.positionals[0] !== "literature") return null;
  const subCommand = parsed.positionals[1];

  if (subCommand === "ingest") {
    const projectRoot = positional(parsed, 2, "project directory");
    const file = positional(parsed, 3, "source file");
    const metadataPath = option(parsed, "metadata-file");
    const extractedPath = option(parsed, "extracted-text-file");
    const kind = option(parsed, "kind");
    outputJson(io, await ingestLiteratureFile(projectRoot, file, {
      branchId: await resolveBranchId(projectRoot, option(parsed, "branch")),
      metadata: metadataPath === undefined
        ? { title: basename(file, extname(file)), authors: [], identifiers: {} }
        : await jsonFile(metadataPath),
      ...(extractedPath === undefined ? {} : { extractedText: await readFile(extractedPath, "utf8") }),
      ...(kind === undefined ? {} : { sourceKind: oneOf(kind, LITERATURE_SOURCE_KINDS, "--kind") }),
    }));
    return 0;
  }

  if (subCommand === "ingest-folder") {
    const projectRoot = positional(parsed, 2, "project directory");
    outputJson(io, await ingestLiteratureFolder(
      projectRoot,
      positional(parsed, 3, "source folder"),
      { branchId: await resolveBranchId(projectRoot, option(parsed, "branch")) },
    ));
    return 0;
  }

  if (subCommand === "list") {
    const projectRoot = positional(parsed, 2, "project directory");
    outputJson(io, listLiteratureSources(projectRoot, await resolveBranchId(projectRoot, option(parsed, "branch"))));
    return 0;
  }

  if (subCommand === "show") {
    const projectRoot = positional(parsed, 2, "project directory");
    outputJson(io, getLiteratureSource(
      projectRoot,
      await resolveBranchId(projectRoot, option(parsed, "branch")),
      positional(parsed, 3, "source ID"),
    ));
    return 0;
  }

  if (subCommand === "open") {
    const projectRoot = positional(parsed, 2, "project directory");
    outputJson(io, resolveLiteratureAnchor(projectRoot, {
      branchId: await resolveBranchId(projectRoot, option(parsed, "branch")),
      sourceId: positional(parsed, 3, "source ID"),
      anchorId: positional(parsed, 4, "anchor ID"),
    }));
    return 0;
  }

  if (subCommand === "search") {
    const projectRoot = positional(parsed, 2, "project directory");
    const anchorKinds = option(parsed, "anchor-kind");
    const assumptions = option(parsed, "assumption");
    const seeds = option(parsed, "seed-source");
    outputJson(io, await searchLiterature(projectRoot, {
      branchId: await resolveBranchId(projectRoot, option(parsed, "branch")),
      query: option(parsed, "query", true)!,
      mode: oneOf(option(parsed, "mode") ?? "hybrid", ["lexical", "semantic", "hybrid", "citation"] as const, "--mode"),
      ...(anchorKinds === undefined ? {} : {
        anchorKinds: commaSeparated(anchorKinds, "--anchor-kind")
          .map((kind) => oneOf(kind, LITERATURE_ANCHOR_KINDS, "--anchor-kind")),
      }),
      ...(assumptions === undefined ? {} : { assumptionIds: commaSeparated(assumptions, "--assumption") }),
      ...(seeds === undefined ? {} : { seedSourceIds: commaSeparated(seeds, "--seed-source") }),
      limit: integerOption(parsed, "limit", 20),
      maxDepth: integerOption(parsed, "max-depth", 2),
    }));
    return 0;
  }

  if (subCommand === "review") {
    const projectRoot = positional(parsed, 2, "project directory");
    const reviewedText = option(parsed, "reviewed-text");
    outputJson(io, await reviewLiteratureAnchor(projectRoot, {
      branchId: await resolveBranchId(projectRoot, option(parsed, "branch")),
      sourceId: option(parsed, "source", true)!,
      anchorId: option(parsed, "anchor", true)!,
      outcome: oneOf(option(parsed, "outcome", true)!, ["accepted", "rejected", "revised"] as const, "--outcome"),
      summary: option(parsed, "summary", true)!,
      ...(reviewedText === undefined ? {} : { reviewedText }),
    }));
    return 0;
  }

  if (subCommand === "link") {
    const projectRoot = positional(parsed, 2, "project directory");
    const anchorId = option(parsed, "anchor");
    outputJson(io, await linkLiteratureCitation(projectRoot, {
      branchId: await resolveBranchId(projectRoot, option(parsed, "branch")),
      citingSourceId: option(parsed, "from", true)!,
      citedSourceId: option(parsed, "to", true)!,
      ...(anchorId === undefined ? {} : { anchorId }),
    }));
    return 0;
  }

  if (subCommand === "cite") {
    const projectRoot = positional(parsed, 2, "project directory");
    const citation = await jsonFile(option(parsed, "citation-file", true)!);
    outputJson(io, await groundClaimInLiterature(projectRoot, {
      branchId: await resolveBranchId(projectRoot, option(parsed, "branch")),
      claimId: option(parsed, "claim", true)!,
      contextId: option(parsed, "context", true)!,
      sourceId: String(citation.sourceId ?? ""),
      anchorId: String(citation.anchorId ?? ""),
      quotedText: String(citation.quotedText ?? ""),
      expectedAuthors: stringList(citation.expectedAuthors, "expectedAuthors"),
      expectedYear: Number(citation.expectedYear),
      expectedIdentifiers: jsonObject(citation.expectedIdentifiers ?? {}, "expectedIdentifiers") as Record<string, string>,
      claimAssumptions: stringList(citation.claimAssumptions, "claimAssumptions"),
      claimScope: oneOf(String(citation.claimScope ?? ""), LITERATURE_SCOPES, "claimScope") as LiteratureScope,
      assessment: oneOf(String(citation.assessment ?? ""), ["supports", "refutes", "inconclusive"] as const, "assessment"),
      interpretation: String(citation.interpretation ?? ""),
    }));
    return 0;
  }

  if (subCommand === "novelty") {
    const projectRoot = positional(parsed, 2, "project directory");
    outputJson(io, await searchLiteratureNovelty(projectRoot, {
      branchId: await resolveBranchId(projectRoot, option(parsed, "branch")),
      claimId: option(parsed, "claim", true)!,
      contextId: option(parsed, "context", true)!,
      limit: integerOption(parsed, "limit", 10),
    }));
    return 0;
  }

  if (subCommand === "catalog-search") {
    const catalogId = option(parsed, "catalog") ?? "openalex.works";
    const allowNetwork = parsed.options.has("allow-network");
    const registry = new LiteratureCatalogRegistry().register(new OpenAlexCatalogAdapter());
    outputJson(io, await searchLiteratureCatalog(registry, {
      catalogId,
      query: option(parsed, "query", true)!,
      limit: integerOption(parsed, "limit", 10),
      allowedCatalogIds: allowNetwork ? [catalogId] : [],
      grantedCapabilities: allowNetwork ? ["network.access"] : [],
    }));
    return 0;
  }

  if (subCommand === "catalog-ingest") {
    const projectRoot = positional(parsed, 2, "project directory");
    outputJson(io, await ingestCatalogRecord(projectRoot, {
      branchId: await resolveBranchId(projectRoot, option(parsed, "branch")),
      record: await jsonFile(option(parsed, "record-file", true)!) as unknown as LiteratureCatalogRecord,
    }));
    return 0;
  }

  throw new Error("Unknown literature command. Run rw --help for usage.");
}
