import { readFile, readdir } from "node:fs/promises";
import { arch, platform } from "node:os";
import { basename, extname, join, resolve } from "node:path";

import {
  ArtifactReferenceSchema,
  canonicalJson,
  computeContentHash,
  type Actor,
  type ArtifactReference,
  type JsonValue,
  type ObjectEnvelope,
} from "@reasoning-workbench/project-format";

import { sha256Digest as artifactDigest } from "./cas.js";
import { redactSecretValue } from "./context.js";
import {
  addEdge,
  putObject,
  registerArtifactBytes,
  type RegisteredArtifact,
} from "./project.js";
import {
  listBranches,
  listCurrentObjects,
  listEdges,
  type ObjectProjection,
} from "./projection.js";
import { TOOL_CAPABILITIES, type ToolCapability } from "./tools.js";

export const LITERATURE_SOURCE_KINDS = [
  "pdf",
  "latex",
  "bibtex",
  "webpage",
  "catalog-record",
  "text",
] as const;
export type LiteratureSourceKind = (typeof LITERATURE_SOURCE_KINDS)[number];

export const LITERATURE_ANCHOR_KINDS = [
  "document",
  "page",
  "section",
  "theorem",
  "definition",
  "equation",
  "figure",
  "reference",
  "paragraph",
] as const;
export type LiteratureAnchorKind = (typeof LITERATURE_ANCHOR_KINDS)[number];

export const LITERATURE_SCOPES = [
  "example",
  "existential",
  "conditional",
  "universal",
] as const;
export type LiteratureScope = (typeof LITERATURE_SCOPES)[number];

export interface LiteratureMetadata {
  readonly title: string;
  readonly authors: readonly string[];
  readonly year?: number;
  readonly identifiers: Readonly<Record<string, string>>;
  readonly url?: string;
  readonly abstract?: string;
}

export interface LiteratureLocator {
  readonly page?: number;
  readonly section?: string;
  readonly theorem?: string;
  readonly equation?: string;
  readonly figure?: string;
  readonly label?: string;
  readonly startOffset?: number;
  readonly endOffset?: number;
}

export interface LiteratureAnchorDraft {
  readonly kind: LiteratureAnchorKind;
  readonly locator: LiteratureLocator;
  readonly text: string;
  readonly assumptions?: readonly string[];
  readonly scope?: LiteratureScope;
  readonly extractionMethod?: string;
}

export interface LiteratureAnchor extends LiteratureAnchorDraft {
  readonly anchorId: string;
  readonly assumptions: readonly string[];
  readonly extractionMethod: string;
  readonly extractionState: "machine-proposed";
  readonly contentHash: string;
}

export interface LiteratureReference {
  readonly title?: string;
  readonly citationKey?: string;
  readonly doi?: string;
  readonly arxiv?: string;
}

export interface LiteratureSource {
  readonly schemaVersion: 1;
  readonly kind: "literature-source";
  readonly sourceKind: LiteratureSourceKind;
  readonly metadata: LiteratureMetadata;
  readonly artifact: ArtifactReference;
  readonly anchors: readonly LiteratureAnchor[];
  readonly references: readonly LiteratureReference[];
  readonly provenance: {
    readonly producedByRunId: string;
    readonly environmentId: string;
    readonly ingestorId: string;
    readonly ingestorVersion: string;
    readonly rawDigest: string;
    readonly extractionDigest: string;
  };
}

export interface LiteratureSourceRecord {
  readonly object: ObjectProjection;
  readonly source: LiteratureSource;
}

export interface IngestLiteratureOptions {
  readonly branchId: string;
  readonly sourceKind: LiteratureSourceKind;
  readonly logicalName: string;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
  readonly metadata: unknown;
  readonly extractedText?: string;
  readonly anchors?: readonly LiteratureAnchorDraft[];
  readonly references?: readonly LiteratureReference[];
  readonly sourceId?: string;
  readonly ingestorId?: string;
  readonly ingestorVersion?: string;
  readonly actor?: Actor;
}

export interface IngestedLiterature {
  readonly source: ObjectEnvelope;
  readonly artifact: RegisteredArtifact;
  readonly run: ObjectEnvelope;
  readonly environment: ObjectEnvelope;
}

export class LiteratureIngestionError extends Error {
  public readonly runId: string;
  public readonly failureId: string;

  public constructor(message: string, runId: string, failureId: string) {
    super(message);
    this.name = "LiteratureIngestionError";
    this.runId = runId;
    this.failureId = failureId;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  return value;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  if (value.includes("\0")) throw new TypeError(`${label} cannot contain NUL`);
  return value.trim();
}

function optionalString(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : stringValue(value, label);
}

function stringArray(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  const result = value.map((item, index) => stringValue(item, `${label}[${index}]`));
  if (new Set(result).size !== result.length) throw new TypeError(`${label} cannot contain duplicates`);
  return result;
}

function safeInteger(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    throw new TypeError(`${label} must be a safe integer >= ${minimum}`);
  }
  return Number(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`${label} contains unsupported field ${key}`);
  }
}

function enumValue<T extends string>(value: unknown, values: readonly T[], label: string): T {
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw new TypeError(`${label} must be one of ${values.join(", ")}`);
  }
  return value as T;
}

function jsonClone<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}

function secretFree<T>(value: T, label: string): T {
  if (canonicalJson(redactSecretValue(value)) !== canonicalJson(value)) {
    throw new TypeError(`${label} contains secret-like material`);
  }
  return jsonClone(value);
}

function actorOption(actor: Actor | undefined): { actor?: Actor } {
  return actor === undefined ? {} : { actor };
}

function branchObjects(projectRoot: string, branchId: string): Map<string, ObjectProjection> {
  if (!listBranches(projectRoot).some((branch) => branch.branchId === branchId)) {
    throw new Error(`Branch does not exist: ${branchId}`);
  }
  return new Map(
    listCurrentObjects(projectRoot, branchId).map((object) => [object.objectId, object]),
  );
}

function exactObject(
  objects: ReadonlyMap<string, ObjectProjection>,
  objectId: string,
  objectType: string,
): ObjectProjection {
  const object = objects.get(objectId);
  if (object === undefined || object.objectType !== objectType) {
    throw new Error(`${objectType} ${objectId} is not visible on the branch`);
  }
  return object;
}

function normalizeMetadata(value: unknown): LiteratureMetadata {
  const metadata = record(value, "literature metadata");
  exactKeys(metadata, ["title", "authors", "year", "identifiers", "url", "abstract"], "literature metadata");
  const authors = stringArray(metadata.authors, "literature metadata.authors");
  const identifiersInput = metadata.identifiers === undefined
    ? {}
    : record(metadata.identifiers, "literature metadata.identifiers");
  const identifiers = Object.fromEntries(
    Object.entries(identifiersInput)
      .map(([key, identifier]) => [
        stringValue(key, "identifier kind").toLowerCase(),
        stringValue(identifier, `identifier ${key}`),
      ] as const)
      .sort(([left], [right]) => left.localeCompare(right)),
  );
  const year = metadata.year === undefined
    ? undefined
    : safeInteger(metadata.year, "literature metadata.year", 1);
  return secretFree({
    title: stringValue(metadata.title, "literature metadata.title"),
    authors,
    ...(year === undefined ? {} : { year }),
    identifiers,
    ...(optionalString(metadata.url, "literature metadata.url") === undefined
      ? {}
      : { url: optionalString(metadata.url, "literature metadata.url")! }),
    ...(optionalString(metadata.abstract, "literature metadata.abstract") === undefined
      ? {}
      : { abstract: optionalString(metadata.abstract, "literature metadata.abstract")! }),
  }, "literature metadata");
}

function normalizeLocator(value: unknown, label: string): LiteratureLocator {
  const locator = record(value, label);
  exactKeys(
    locator,
    ["page", "section", "theorem", "equation", "figure", "label", "startOffset", "endOffset"],
    label,
  );
  const page = locator.page === undefined ? undefined : safeInteger(locator.page, `${label}.page`, 1);
  const startOffset = locator.startOffset === undefined
    ? undefined
    : safeInteger(locator.startOffset, `${label}.startOffset`);
  const endOffset = locator.endOffset === undefined
    ? undefined
    : safeInteger(locator.endOffset, `${label}.endOffset`);
  if (startOffset !== undefined && endOffset !== undefined && endOffset < startOffset) {
    throw new TypeError(`${label}.endOffset must be >= startOffset`);
  }
  return {
    ...(page === undefined ? {} : { page }),
    ...(optionalString(locator.section, `${label}.section`) === undefined ? {} : { section: optionalString(locator.section, `${label}.section`)! }),
    ...(optionalString(locator.theorem, `${label}.theorem`) === undefined ? {} : { theorem: optionalString(locator.theorem, `${label}.theorem`)! }),
    ...(optionalString(locator.equation, `${label}.equation`) === undefined ? {} : { equation: optionalString(locator.equation, `${label}.equation`)! }),
    ...(optionalString(locator.figure, `${label}.figure`) === undefined ? {} : { figure: optionalString(locator.figure, `${label}.figure`)! }),
    ...(optionalString(locator.label, `${label}.label`) === undefined ? {} : { label: optionalString(locator.label, `${label}.label`)! }),
    ...(startOffset === undefined ? {} : { startOffset }),
    ...(endOffset === undefined ? {} : { endOffset }),
  };
}

function normalizeReference(value: unknown, index: number): LiteratureReference {
  const reference = record(value, `references[${index}]`);
  exactKeys(reference, ["title", "citationKey", "doi", "arxiv"], `references[${index}]`);
  const normalized = {
    ...(optionalString(reference.title, `references[${index}].title`) === undefined ? {} : { title: optionalString(reference.title, `references[${index}].title`)! }),
    ...(optionalString(reference.citationKey, `references[${index}].citationKey`) === undefined ? {} : { citationKey: optionalString(reference.citationKey, `references[${index}].citationKey`)! }),
    ...(optionalString(reference.doi, `references[${index}].doi`) === undefined ? {} : { doi: optionalString(reference.doi, `references[${index}].doi`)! }),
    ...(optionalString(reference.arxiv, `references[${index}].arxiv`) === undefined ? {} : { arxiv: optionalString(reference.arxiv, `references[${index}].arxiv`)! }),
  };
  if (Object.keys(normalized).length === 0) throw new TypeError(`references[${index}] must identify a source`);
  return normalized;
}

function normalizeText(text: string): string {
  return text.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function statementScope(text: string): LiteratureScope {
  const normalized = text.toLowerCase();
  if (/\b(for all|every|any|∀)\b/u.test(normalized)) return "universal";
  if (/\b(there exists|some|∃)\b/u.test(normalized)) return "existential";
  if (/\b(if|assuming|provided that|whenever)\b/u.test(normalized)) return "conditional";
  return "example";
}

function automaticAnchors(
  sourceKind: LiteratureSourceKind,
  metadata: LiteratureMetadata,
  text: string | undefined,
): LiteratureAnchorDraft[] {
  const anchors: LiteratureAnchorDraft[] = [{
    kind: "document",
    locator: { label: "document" },
    text: [metadata.title, metadata.abstract].filter(Boolean).join("\n\n"),
    extractionMethod: sourceKind === "catalog-record" ? "catalog-metadata" : "document-metadata",
  }];
  if (text === undefined || normalizeText(text).length === 0) return anchors;
  if (text.length > 5_000_000) throw new TypeError("extractedText exceeds 5,000,000 characters");

  const addStatements = (body: string, base: LiteratureLocator, method: string): void => {
    const patterns: Array<[LiteratureAnchorKind, RegExp]> = [
      ["theorem", /(?:^|\n)\s*(?:theorem|lemma|proposition|corollary)\s*([\w.-]*)\s*[:.]?\s*([^\n]{3,2000})/giu],
      ["definition", /(?:^|\n)\s*definition\s*([\w.-]*)\s*[:.]?\s*([^\n]{3,2000})/giu],
      ["equation", /(?:^|\n)\s*(?:equation\s*([\w.-]*)\s*[:.]?\s*)?([^\n]*[=≈≃≤≥][^\n]{1,1000})/giu],
      ["figure", /(?:^|\n)\s*(?:figure|fig\.)\s*([\w.-]*)\s*[:.]?\s*([^\n]{3,1000})/giu],
    ];
    for (const [kind, pattern] of patterns) {
      for (const match of body.matchAll(pattern)) {
        const label = normalizeText(match[1] ?? "");
        const statement = normalizeText(match[2] ?? match[0]);
        if (statement.length < 3) continue;
        anchors.push({
          kind,
          locator: {
            ...base,
            ...(kind === "theorem" && label ? { theorem: label } : {}),
            ...(kind === "equation" && label ? { equation: label } : {}),
            ...(kind === "figure" && label ? { figure: label } : {}),
            ...((kind === "definition" || !label) ? {} : { label }),
          },
          text: statement,
          scope: statementScope(statement),
          extractionMethod: method,
        });
      }
    }
  };

  if (sourceKind === "pdf") {
    const pages = text.split("\f");
    pages.forEach((pageText, index) => {
      const normalized = normalizeText(pageText);
      if (!normalized) return;
      anchors.push({
        kind: "page",
        locator: { page: index + 1 },
        text: normalized,
        extractionMethod: "pdf-sidecar-text",
      });
      addStatements(pageText, { page: index + 1 }, "pdf-sidecar-structure");
    });
    return anchors;
  }

  if (sourceKind === "latex") {
    for (const match of text.matchAll(/\\(section|subsection|subsubsection)\*?\{([^}]+)\}/gu)) {
      anchors.push({
        kind: "section",
        locator: { section: normalizeText(match[2]!), startOffset: match.index },
        text: normalizeText(match[2]!),
        extractionMethod: "latex-structure",
      });
    }
    for (const [kind, environment] of [["theorem", "theorem"], ["definition", "definition"], ["equation", "equation"]] as const) {
      const pattern = new RegExp(`\\\\begin\\{${environment}\\}(?:\\[([^\\]]+)\\])?([\\s\\S]*?)\\\\end\\{${environment}\\}`, "gu");
      for (const match of text.matchAll(pattern)) {
        const body = normalizeText(match[2]!);
        anchors.push({
          kind,
          locator: { ...(match[1] ? { label: normalizeText(match[1]) } : {}), startOffset: match.index },
          text: body,
          ...(kind === "theorem" ? { scope: statementScope(body) } : {}),
          extractionMethod: "latex-structure",
        });
      }
    }
    for (const match of text.matchAll(/\\caption\{([^}]+)\}/gu)) {
      anchors.push({
        kind: "figure",
        locator: { figure: normalizeText(match[1]!), startOffset: match.index },
        text: normalizeText(match[1]!),
        extractionMethod: "latex-structure",
      });
    }
    addStatements(text.replace(/\\[A-Za-z]+(?:\[[^\]]*\])?/gu, ""), {}, "latex-text-heuristic");
    return anchors;
  }

  if (sourceKind === "bibtex") {
    for (const match of text.matchAll(/@([A-Za-z]+)\s*\{\s*([^,\s]+)\s*,([\s\S]*?)(?=\n@|$)/gu)) {
      const fields = match[3]!;
      const title = /\btitle\s*=\s*[\{"]([^}"]+)/iu.exec(fields)?.[1];
      const author = /\bauthor\s*=\s*[\{"]([^}"]+)/iu.exec(fields)?.[1];
      const year = /\byear\s*=\s*[\{"]?(\d{4})/iu.exec(fields)?.[1];
      anchors.push({
        kind: "reference",
        locator: { label: normalizeText(match[2]!), startOffset: match.index },
        text: normalizeText([title, author, year].filter(Boolean).join(" — ") || match[0]),
        extractionMethod: "bibtex-structure",
      });
    }
    return anchors;
  }

  if (sourceKind === "webpage") {
    for (const match of text.matchAll(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/giu)) {
      const section = normalizeText(match[2]!.replace(/<[^>]+>/gu, " "));
      if (section) anchors.push({
        kind: "section",
        locator: { section, startOffset: match.index },
        text: section,
        extractionMethod: "html-structure",
      });
    }
    const plain = text
      .replace(/<script[\s\S]*?<\/script>/giu, " ")
      .replace(/<style[\s\S]*?<\/style>/giu, " ")
      .replace(/<[^>]+>/gu, " ");
    addStatements(plain, {}, "html-text-heuristic");
    return anchors;
  }

  addStatements(text, {}, `${sourceKind}-text-heuristic`);
  const paragraphs = text.split(/\n\s*\n/gu).map(normalizeText).filter((entry) => entry.length >= 20);
  paragraphs.slice(0, 2_000).forEach((paragraph, index) => anchors.push({
    kind: "paragraph",
    locator: { label: `paragraph-${index + 1}` },
    text: paragraph,
    extractionMethod: `${sourceKind}-paragraphs`,
  }));
  return anchors;
}

function normalizeAnchors(value: readonly LiteratureAnchorDraft[]): LiteratureAnchor[] {
  if (value.length > 20_000) throw new TypeError("A literature source cannot exceed 20,000 anchors");
  const seen = new Set<string>();
  return value.map((candidate, index) => {
    const anchor = record(candidate, `anchors[${index}]`);
    exactKeys(
      anchor,
      ["kind", "locator", "text", "assumptions", "scope", "extractionMethod"],
      `anchors[${index}]`,
    );
    const kind = enumValue(anchor.kind, LITERATURE_ANCHOR_KINDS, `anchors[${index}].kind`);
    const locator = normalizeLocator(anchor.locator, `anchors[${index}].locator`);
    const text = normalizeText(stringValue(anchor.text, `anchors[${index}].text`));
    if (text.length > 100_000) throw new TypeError(`anchors[${index}].text exceeds 100,000 characters`);
    const assumptions = stringArray(anchor.assumptions, `anchors[${index}].assumptions`).sort();
    const scope = anchor.scope === undefined
      ? undefined
      : enumValue(anchor.scope, LITERATURE_SCOPES, `anchors[${index}].scope`);
    const extractionMethod = optionalString(anchor.extractionMethod, `anchors[${index}].extractionMethod`) ?? "user-supplied";
    let identity = computeContentHash({ kind, locator }).slice("sha256:".length, 32);
    if (seen.has(identity)) identity = computeContentHash({ kind, locator, index }).slice("sha256:".length, 32);
    seen.add(identity);
    return secretFree({
      anchorId: `anc_${identity}`,
      kind,
      locator,
      text,
      assumptions,
      ...(scope === undefined ? {} : { scope }),
      extractionMethod,
      extractionState: "machine-proposed" as const,
      contentHash: computeContentHash(text),
    }, `anchors[${index}]`);
  });
}

function parseLiteratureSource(object: ObjectProjection): LiteratureSource | undefined {
  if (object.objectType !== "source" || !isRecord(object.content)) return undefined;
  const content = object.content;
  if (content.kind !== "literature-source" || content.schemaVersion !== 1) return undefined;
  const sourceKind = enumValue(content.sourceKind, LITERATURE_SOURCE_KINDS, `source ${object.objectId}.sourceKind`);
  const metadata = normalizeMetadata(content.metadata);
  if (!Array.isArray(content.anchors)) throw new TypeError(`source ${object.objectId}.anchors must be an array`);
  const drafts = content.anchors.map((raw, index): LiteratureAnchorDraft => {
    const anchor = record(raw, `source ${object.objectId}.anchors[${index}]`);
    return {
      kind: anchor.kind as LiteratureAnchorKind,
      locator: anchor.locator as LiteratureLocator,
      text: anchor.text as string,
      assumptions: anchor.assumptions as string[],
      ...(anchor.scope === undefined ? {} : { scope: anchor.scope as LiteratureScope }),
      extractionMethod: anchor.extractionMethod as string,
    };
  });
  const normalizedAnchors = normalizeAnchors(drafts);
  const anchors = content.anchors.map((raw, index): LiteratureAnchor => {
    const anchor = record(raw, `source ${object.objectId}.anchors[${index}]`);
    const normalized = normalizedAnchors[index]!;
    if (
      anchor.anchorId !== normalized.anchorId ||
      anchor.contentHash !== normalized.contentHash ||
      anchor.extractionState !== "machine-proposed"
    ) throw new TypeError(`source ${object.objectId}.anchors[${index}] identity is invalid`);
    return normalized;
  });
  if (!Array.isArray(content.references)) throw new TypeError(`source ${object.objectId}.references must be an array`);
  const references = content.references.map(normalizeReference);
  const artifact = ArtifactReferenceSchema.parse(content.artifact);
  const provenance = record(content.provenance, `source ${object.objectId}.provenance`);
  return {
    schemaVersion: 1,
    kind: "literature-source",
    sourceKind,
    metadata,
    artifact,
    anchors,
    references,
    provenance: {
      producedByRunId: stringValue(provenance.producedByRunId, "provenance.producedByRunId"),
      environmentId: stringValue(provenance.environmentId, "provenance.environmentId"),
      ingestorId: stringValue(provenance.ingestorId, "provenance.ingestorId"),
      ingestorVersion: stringValue(provenance.ingestorVersion, "provenance.ingestorVersion"),
      rawDigest: stringValue(provenance.rawDigest, "provenance.rawDigest"),
      extractionDigest: stringValue(provenance.extractionDigest, "provenance.extractionDigest"),
    },
  };
}

export function listLiteratureSources(projectRoot: string, branchId: string): LiteratureSourceRecord[] {
  return [...branchObjects(projectRoot, branchId).values()]
    .flatMap((object) => {
      const source = parseLiteratureSource(object);
      return source === undefined ? [] : [{ object, source }];
    })
    .sort((left, right) => left.source.metadata.title.localeCompare(right.source.metadata.title) || left.object.objectId.localeCompare(right.object.objectId));
}

export function getLiteratureSource(
  projectRoot: string,
  branchId: string,
  sourceId: string,
): LiteratureSourceRecord {
  const object = exactObject(branchObjects(projectRoot, branchId), sourceId, "source");
  const source = parseLiteratureSource(object);
  if (source === undefined) throw new Error(`Source ${sourceId} is not a typed literature source`);
  return { object, source };
}

function safeError(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  const redacted = redactSecretValue(text);
  return typeof redacted === "string" ? redacted : "Literature ingestion failed";
}

export async function ingestLiteratureDocument(
  projectRoot: string,
  options: IngestLiteratureOptions,
): Promise<IngestedLiterature> {
  branchObjects(projectRoot, options.branchId);
  enumValue(options.sourceKind, LITERATURE_SOURCE_KINDS, "sourceKind");
  const logicalName = stringValue(options.logicalName, "logicalName");
  const mediaType = stringValue(options.mediaType, "mediaType");
  if (!(options.bytes instanceof Uint8Array)) throw new TypeError("bytes must be Uint8Array");
  if (options.bytes.byteLength > 100 * 1024 * 1024) throw new TypeError("Source exceeds the 100 MiB ingestion limit");
  const metadata = normalizeMetadata(options.metadata);
  const rawDigest = artifactDigest(options.bytes);
  const generated = automaticAnchors(options.sourceKind, metadata, options.extractedText);
  const anchors = normalizeAnchors([...generated, ...(options.anchors ?? [])]);
  const references = [...(options.references ?? [])].map(normalizeReference);
  const ingestorId = options.ingestorId ?? "core.literature-ingest";
  const ingestorVersion = options.ingestorVersion ?? "1.0.0";
  const extractionDigest = computeContentHash({ metadata, anchors, references });
  const environment = await putObject(projectRoot, {
    branchId: options.branchId,
    objectType: "environment",
    content: {
      schemaVersion: 1,
      kind: "literature-ingest-environment",
      runtime: { node: process.version, platform: platform(), architecture: arch() },
      ingestor: { ingestorId, version: ingestorVersion },
      permissions: options.sourceKind === "catalog-record" ? ["network.access"] : ["filesystem.read"],
    },
    ...actorOption(options.actor),
  });
  let run = await putObject(projectRoot, {
    branchId: options.branchId,
    objectType: "run",
    content: {
      schemaVersion: 1,
      kind: "literature-ingest-run",
      status: "running",
      input: {
        sourceKind: options.sourceKind,
        logicalName,
        mediaType,
        rawDigest,
        metadata,
        extractionDigest,
      },
      environmentId: environment.objectId,
      permissions: options.sourceKind === "catalog-record" ? ["network.access"] : ["filesystem.read"],
      nondeterminism: options.sourceKind === "catalog-record" ? "externally-sourced" : "deterministic",
    },
    ...actorOption(options.actor),
  });
  try {
    const artifact = await registerArtifactBytes(projectRoot, options.bytes, {
      branchId: options.branchId,
      logicalName,
      mediaType,
      producedByRunId: run.objectId,
      environmentId: environment.objectId,
      reproducibility: options.sourceKind === "catalog-record" ? "externally-sourced" : "deterministic",
      ...actorOption(options.actor),
    });
    run = await putObject(projectRoot, {
      branchId: options.branchId,
      objectId: run.objectId,
      objectType: "run",
      content: {
        ...(run.content as Record<string, unknown>),
        status: "succeeded",
        artifact: artifact.artifact,
        anchorCount: anchors.length,
      },
      ...actorOption(options.actor),
    });
    const source = await putObject(projectRoot, {
      branchId: options.branchId,
      objectType: "source",
      ...(options.sourceId === undefined ? {} : { objectId: options.sourceId }),
      content: secretFree({
        schemaVersion: 1,
        kind: "literature-source",
        sourceKind: options.sourceKind,
        metadata,
        artifact: artifact.artifact,
        anchors,
        references,
        provenance: {
          producedByRunId: run.objectId,
          environmentId: environment.objectId,
          ingestorId,
          ingestorVersion,
          rawDigest,
          extractionDigest,
        },
      }, "literature source"),
      ...actorOption(options.actor),
    });
    return { source, artifact, run, environment };
  } catch (error) {
    const message = safeError(error);
    run = await putObject(projectRoot, {
      branchId: options.branchId,
      objectId: run.objectId,
      objectType: "run",
      content: { ...(run.content as Record<string, unknown>), status: "failed", error: message },
      ...actorOption(options.actor),
    });
    const failure = await putObject(projectRoot, {
      branchId: options.branchId,
      objectType: "failure",
      content: {
        schemaVersion: 1,
        kind: "literature-ingestion-failure",
        status: "open",
        runRef: { objectId: run.objectId, versionId: run.versionId },
        message,
      },
      ...actorOption(options.actor),
    });
    throw new LiteratureIngestionError(message, run.objectId, failure.objectId);
  }
}

function inferredKind(path: string): { sourceKind: LiteratureSourceKind; mediaType: string } {
  switch (extname(path).toLowerCase()) {
    case ".pdf": return { sourceKind: "pdf", mediaType: "application/pdf" };
    case ".tex": return { sourceKind: "latex", mediaType: "application/x-tex" };
    case ".bib": return { sourceKind: "bibtex", mediaType: "application/x-bibtex" };
    case ".html":
    case ".htm": return { sourceKind: "webpage", mediaType: "text/html" };
    default: return { sourceKind: "text", mediaType: "text/plain; charset=utf-8" };
  }
}

export async function ingestLiteratureFile(
  projectRoot: string,
  path: string,
  options: Omit<IngestLiteratureOptions, "sourceKind" | "logicalName" | "mediaType" | "bytes"> & {
    sourceKind?: LiteratureSourceKind;
    mediaType?: string;
  },
): Promise<IngestedLiterature> {
  const absolute = resolve(path);
  const bytes = await readFile(absolute);
  const inferred = inferredKind(absolute);
  const sourceKind = options.sourceKind ?? inferred.sourceKind;
  return ingestLiteratureDocument(projectRoot, {
    ...options,
    sourceKind,
    logicalName: basename(absolute),
    mediaType: options.mediaType ?? inferred.mediaType,
    bytes,
    ...(options.extractedText === undefined && sourceKind !== "pdf"
      ? { extractedText: new TextDecoder().decode(bytes) }
      : {}),
  });
}

export async function ingestLiteratureFolder(
  projectRoot: string,
  folderPath: string,
  options: {
    branchId: string;
    metadataFor?: (path: string) => unknown;
    actor?: Actor;
  },
): Promise<IngestedLiterature[]> {
  const root = resolve(folderPath);
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && [".pdf", ".tex", ".bib", ".html", ".htm", ".txt", ".md"].includes(extname(path).toLowerCase())) files.push(path);
    }
  };
  await visit(root);
  const results: IngestedLiterature[] = [];
  for (const path of files) {
    const inferred = inferredKind(path);
    const bytes = await readFile(path);
    const decoded = inferred.sourceKind === "pdf" ? undefined : new TextDecoder().decode(bytes);
    results.push(await ingestLiteratureDocument(projectRoot, {
      branchId: options.branchId,
      sourceKind: inferred.sourceKind,
      logicalName: basename(path),
      mediaType: inferred.mediaType,
      bytes,
      metadata: options.metadataFor?.(path) ?? {
        title: basename(path, extname(path)),
        authors: [],
        identifiers: {},
      },
      ...(decoded === undefined ? {} : { extractedText: decoded }),
      ...actorOption(options.actor),
    }));
  }
  return results;
}

export interface LiteratureAnchorResolution {
  readonly sourceId: string;
  readonly sourceVersionId: string;
  readonly title: string;
  readonly anchor: LiteratureAnchor;
  readonly artifact: ArtifactReference;
  readonly uri: string;
}

function anchorUri(artifact: ArtifactReference, anchor: LiteratureAnchor): string {
  const fragment = [
    anchor.locator.page === undefined ? undefined : `page=${anchor.locator.page}`,
    `anchor=${encodeURIComponent(anchor.anchorId)}`,
  ].filter(Boolean).join("&");
  return `artifact:${artifact.digest}${fragment ? `#${fragment}` : ""}`;
}

export function resolveLiteratureAnchor(
  projectRoot: string,
  options: { branchId: string; sourceId: string; anchorId: string },
): LiteratureAnchorResolution {
  const record = getLiteratureSource(projectRoot, options.branchId, options.sourceId);
  const anchor = record.source.anchors.find((candidate) => candidate.anchorId === options.anchorId);
  if (anchor === undefined) throw new Error(`Anchor ${options.anchorId} does not exist in source ${options.sourceId}`);
  return {
    sourceId: record.object.objectId,
    sourceVersionId: record.object.versionId,
    title: record.source.metadata.title,
    anchor,
    artifact: record.source.artifact,
    uri: anchorUri(record.source.artifact, anchor),
  };
}

export interface ReviewedLiteratureAnchor {
  readonly review: ObjectEnvelope;
  readonly edge: Awaited<ReturnType<typeof addEdge>>;
}

export async function reviewLiteratureAnchor(
  projectRoot: string,
  options: {
    branchId: string;
    sourceId: string;
    anchorId: string;
    outcome: "accepted" | "rejected" | "revised";
    summary: string;
    reviewedText?: string;
    actor?: Actor;
  },
): Promise<ReviewedLiteratureAnchor> {
  const source = getLiteratureSource(projectRoot, options.branchId, options.sourceId);
  const anchor = source.source.anchors.find((candidate) => candidate.anchorId === options.anchorId);
  if (anchor === undefined) throw new Error(`Anchor ${options.anchorId} does not exist in source ${options.sourceId}`);
  enumValue(options.outcome, ["accepted", "rejected", "revised"] as const, "outcome");
  const reviewedText = options.reviewedText === undefined ? undefined : normalizeText(stringValue(options.reviewedText, "reviewedText"));
  if (options.outcome === "revised" && reviewedText === undefined) {
    throw new TypeError("A revised anchor review requires reviewedText");
  }
  const review = await putObject(projectRoot, {
    branchId: options.branchId,
    objectType: "review",
    content: secretFree({
      schemaVersion: 1,
      kind: "literature-anchor-review",
      outcome: options.outcome,
      summary: stringValue(options.summary, "summary"),
      sourceRef: { objectId: source.object.objectId, versionId: source.object.versionId },
      anchorRef: { anchorId: anchor.anchorId, contentHash: anchor.contentHash },
      proposedText: anchor.text,
      ...(reviewedText === undefined ? {} : { reviewedText, reviewedTextHash: computeContentHash(reviewedText) }),
    }, "literature anchor review"),
    ...actorOption(options.actor),
  });
  const edge = await addEdge(projectRoot, {
    branchId: options.branchId,
    edgeType: options.outcome === "rejected" ? "refutes" : "supports",
    fromObjectId: review.objectId,
    toObjectId: source.object.objectId,
    metadata: { anchorId: anchor.anchorId, reviewKind: "literature-anchor" },
    ...actorOption(options.actor),
  });
  return { review, edge };
}

export type LiteratureReviewState = "unreviewed" | "accepted" | "rejected" | "revised";

function reviewState(
  objects: readonly ObjectProjection[],
  source: LiteratureSourceRecord,
  anchor: LiteratureAnchor,
): LiteratureReviewState {
  const reviews = objects.filter((object) => {
    if (object.objectType !== "review" || !isRecord(object.content)) return false;
    const sourceRef = isRecord(object.content.sourceRef) ? object.content.sourceRef : undefined;
    const anchorRef = isRecord(object.content.anchorRef) ? object.content.anchorRef : undefined;
    return object.content.kind === "literature-anchor-review" &&
      sourceRef?.objectId === source.object.objectId &&
      sourceRef.versionId === source.object.versionId &&
      anchorRef?.anchorId === anchor.anchorId &&
      anchorRef.contentHash === anchor.contentHash;
  }).sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.objectId.localeCompare(left.objectId));
  const outcome = isRecord(reviews[0]?.content) ? reviews[0].content.outcome : undefined;
  return outcome === "accepted" || outcome === "rejected" || outcome === "revised"
    ? outcome
    : "unreviewed";
}

function tokens(text: string): string[] {
  return [...new Set(
    text.normalize("NFKC").toLocaleLowerCase("en-US").match(/[\p{L}\p{N}]+/gu) ?? [],
  )].filter((token) => token.length > 1).sort();
}

function lexicalScore(query: string, text: string): { score: number; matchedTerms: string[] } {
  const queryTerms = tokens(query);
  if (queryTerms.length === 0) return { score: 0, matchedTerms: [] };
  const haystack = normalizeText(text).toLocaleLowerCase("en-US");
  const haystackTerms = new Set(tokens(text));
  const matchedTerms = queryTerms.filter((term) => haystackTerms.has(term));
  const phrase = haystack.includes(normalizeText(query).toLocaleLowerCase("en-US")) ? 1 : 0;
  return { score: Math.min(1, matchedTerms.length / queryTerms.length * 0.8 + phrase * 0.2), matchedTerms };
}

export interface LiteratureSemanticAdapter {
  readonly descriptor: {
    readonly adapterId: string;
    readonly version: string;
    readonly method: string;
  };
  readonly score: (query: string, documents: readonly string[]) => Promise<readonly number[]>;
}

export class LocalTermVectorSemanticAdapter implements LiteratureSemanticAdapter {
  public readonly descriptor = {
    adapterId: "core.local-term-vector",
    version: "1.0.0",
    method: "normalized-term-overlap",
  } as const;

  public async score(query: string, documents: readonly string[]): Promise<readonly number[]> {
    const queryTerms = new Set(tokens(query));
    return documents.map((document) => {
      const terms = new Set(tokens(document));
      if (queryTerms.size === 0 || terms.size === 0) return 0;
      const intersection = [...queryTerms].filter((term) => terms.has(term)).length;
      return intersection / Math.sqrt(queryTerms.size * terms.size);
    });
  }
}

export interface LiteratureSearchResult {
  readonly sourceId: string;
  readonly sourceVersionId: string;
  readonly title: string;
  readonly anchorId: string;
  readonly anchorKind: LiteratureAnchorKind;
  readonly text: string;
  readonly locator: LiteratureLocator;
  readonly uri: string;
  readonly reviewState: LiteratureReviewState;
  readonly score: number;
  readonly lexicalScore: number;
  readonly semanticScore: number;
  readonly assumptionScore: number;
  readonly matchedTerms: readonly string[];
}

export async function searchLiterature(
  projectRoot: string,
  options: {
    branchId: string;
    query: string;
    mode?: "lexical" | "semantic" | "hybrid" | "citation";
    anchorKinds?: readonly LiteratureAnchorKind[];
    assumptionIds?: readonly string[];
    seedSourceIds?: readonly string[];
    maxDepth?: number;
    limit?: number;
    semanticAdapter?: LiteratureSemanticAdapter;
  },
): Promise<LiteratureSearchResult[]> {
  const query = stringValue(options.query, "query");
  const mode = options.mode ?? "hybrid";
  const objects = branchObjects(projectRoot, options.branchId);
  const sources = listLiteratureSources(projectRoot, options.branchId);
  const kinds = options.anchorKinds === undefined
    ? undefined
    : new Set(options.anchorKinds.map((kind, index) => enumValue(kind, LITERATURE_ANCHOR_KINDS, `anchorKinds[${index}]`)));
  const assumptions = stringArray(options.assumptionIds, "assumptionIds").map((id) => {
    const assumption = exactObject(objects, id, "assumption");
    return isRecord(assumption.content) && typeof assumption.content.statement === "string"
      ? assumption.content.statement
      : canonicalJson(assumption.content);
  });
  let allowedSourceIds: Set<string> | undefined;
  if (mode === "citation") {
    const seeds = stringArray(options.seedSourceIds, "seedSourceIds");
    if (seeds.length === 0) throw new TypeError("citation search requires seedSourceIds");
    const maxDepth = options.maxDepth ?? 2;
    safeInteger(maxDepth, "maxDepth");
    const edges = listEdges(projectRoot, options.branchId).filter((edge) => edge.edgeType === "cites");
    allowedSourceIds = new Set(seeds);
    let frontier = seeds;
    for (let depth = 0; depth < maxDepth; depth += 1) {
      const next = edges.flatMap((edge) =>
        frontier.includes(edge.fromObjectId) ? [edge.toObjectId] : frontier.includes(edge.toObjectId) ? [edge.fromObjectId] : [],
      ).filter((id) => !allowedSourceIds!.has(id));
      next.forEach((id) => allowedSourceIds!.add(id));
      frontier = [...new Set(next)].sort();
      if (frontier.length === 0) break;
    }
  }
  const candidates = sources.flatMap((source) =>
    source.source.anchors
      .filter((anchor) => kinds === undefined || kinds.has(anchor.kind))
      .filter(() => allowedSourceIds === undefined || allowedSourceIds.has(source.object.objectId))
      .map((anchor) => ({ source, anchor })),
  );
  const semanticAdapter = options.semanticAdapter ?? new LocalTermVectorSemanticAdapter();
  const semanticScores = mode === "lexical" || mode === "citation"
    ? candidates.map(() => 0)
    : await semanticAdapter.score(query, candidates.map(({ source, anchor }) =>
        `${source.source.metadata.title}\n${anchor.text}`,
      ));
  if (semanticScores.length !== candidates.length || semanticScores.some((score) => !Number.isFinite(score) || score < 0 || score > 1)) {
    throw new TypeError("semantic adapter returned invalid scores");
  }
  const assumptionTerms = new Set(tokens(assumptions.join(" ")));
  const results = candidates.map(({ source, anchor }, index): LiteratureSearchResult => {
    const lexical = lexicalScore(query, `${source.source.metadata.title}\n${anchor.text}`);
    const anchorTerms = new Set(tokens(`${anchor.text} ${anchor.assumptions.join(" ")}`));
    const assumptionScore = assumptionTerms.size === 0
      ? 0
      : [...assumptionTerms].filter((term) => anchorTerms.has(term)).length / assumptionTerms.size;
    const semantic = Number(semanticScores[index] ?? 0);
    const score = mode === "semantic"
      ? semantic
      : mode === "lexical" || mode === "citation"
        ? lexical.score
        : lexical.score * 0.55 + semantic * 0.35 + assumptionScore * 0.1;
    return {
      sourceId: source.object.objectId,
      sourceVersionId: source.object.versionId,
      title: source.source.metadata.title,
      anchorId: anchor.anchorId,
      anchorKind: anchor.kind,
      text: anchor.text,
      locator: anchor.locator,
      uri: anchorUri(source.source.artifact, anchor),
      reviewState: reviewState([...objects.values()], source, anchor),
      score,
      lexicalScore: lexical.score,
      semanticScore: semantic,
      assumptionScore,
      matchedTerms: lexical.matchedTerms,
    };
  });
  const limit = options.limit ?? 20;
  safeInteger(limit, "limit", 1);
  return results
    .filter((result) => result.score > 0 || mode === "citation")
    .sort((left, right) => right.score - left.score || left.sourceId.localeCompare(right.sourceId) || left.anchorId.localeCompare(right.anchorId))
    .slice(0, limit);
}

export async function linkLiteratureCitation(
  projectRoot: string,
  options: { branchId: string; citingSourceId: string; citedSourceId: string; anchorId?: string; actor?: Actor },
) {
  const citing = getLiteratureSource(projectRoot, options.branchId, options.citingSourceId);
  const cited = getLiteratureSource(projectRoot, options.branchId, options.citedSourceId);
  if (options.anchorId !== undefined && !citing.source.anchors.some((anchor) => anchor.anchorId === options.anchorId)) {
    throw new Error(`Anchor ${options.anchorId} does not exist in citing source`);
  }
  return addEdge(projectRoot, {
    branchId: options.branchId,
    edgeType: "cites",
    fromObjectId: citing.object.objectId,
    toObjectId: cited.object.objectId,
    metadata: { ...(options.anchorId === undefined ? {} : { anchorId: options.anchorId }) },
    ...actorOption(options.actor),
  });
}

export interface CitationCheck {
  readonly checkId: "exact-location" | "metadata" | "quoted-statement" | "compatible-assumptions" | "not-stronger" | "support";
  readonly status: "passed" | "failed" | "inconclusive";
  readonly summary: string;
}

export interface CitationAssessment {
  readonly outcome: "passed" | "failed" | "inconclusive";
  readonly checks: readonly CitationCheck[];
  readonly reviewState: LiteratureReviewState;
}

function sameAuthors(expected: readonly string[], actual: readonly string[]): boolean {
  const normalized = (values: readonly string[]) => values.map((value) => normalizeText(value).toLowerCase()).sort();
  return canonicalJson(normalized(expected)) === canonicalJson(normalized(actual));
}

export function checkLiteratureCitation(
  projectRoot: string,
  options: {
    branchId: string;
    sourceId: string;
    anchorId: string;
    quotedText: string;
    expectedAuthors: readonly string[];
    expectedYear: number;
    expectedIdentifiers?: Readonly<Record<string, string>>;
    claimAssumptions: readonly string[];
    claimScope: LiteratureScope;
    assessment: "supports" | "refutes" | "inconclusive";
  },
): CitationAssessment {
  const source = getLiteratureSource(projectRoot, options.branchId, options.sourceId);
  const anchor = source.source.anchors.find((candidate) => candidate.anchorId === options.anchorId);
  if (anchor === undefined) throw new Error(`Anchor ${options.anchorId} does not exist in source ${options.sourceId}`);
  const objects = [...branchObjects(projectRoot, options.branchId).values()];
  const reviewed = reviewState(objects, source, anchor);
  const identifiersMatch = Object.entries(options.expectedIdentifiers ?? {}).every(
    ([key, value]) => source.source.metadata.identifiers[key.toLowerCase()] === value,
  );
  const metadataMatch = sameAuthors(stringArray(options.expectedAuthors, "expectedAuthors"), source.source.metadata.authors) &&
    source.source.metadata.year === safeInteger(options.expectedYear, "expectedYear", 1) && identifiersMatch;
  const quote = normalizeText(stringValue(options.quotedText, "quotedText")).toLowerCase();
  const quoted = normalizeText(anchor.text).toLowerCase().includes(quote);
  const claimAssumptions = new Set(stringArray(options.claimAssumptions, "claimAssumptions").map((value) => normalizeText(value).toLowerCase()));
  const compatible = anchor.assumptions.every((assumption) => claimAssumptions.has(normalizeText(assumption).toLowerCase()));
  const ranks: Record<LiteratureScope, number> = { example: 0, existential: 1, conditional: 2, universal: 3 };
  const claimScope = enumValue(options.claimScope, LITERATURE_SCOPES, "claimScope");
  const scopeCompatible = anchor.scope !== undefined && ranks[claimScope] <= ranks[anchor.scope];
  const supportStatus: CitationCheck["status"] = options.assessment === "refutes"
    ? "failed"
    : options.assessment === "inconclusive" || reviewed === "unreviewed"
      ? "inconclusive"
      : reviewed === "rejected"
        ? "failed"
        : "passed";
  const checks: CitationCheck[] = [
    { checkId: "exact-location", status: "passed", summary: `Resolved ${anchor.anchorId} to ${anchorUri(source.source.artifact, anchor)}.` },
    { checkId: "metadata", status: metadataMatch ? "passed" : "failed", summary: metadataMatch ? "Authors, year, and identifiers match." : "Authors, year, or identifiers do not match." },
    { checkId: "quoted-statement", status: quoted ? "passed" : "failed", summary: quoted ? "Quoted text occurs in the exact anchor." : "Quoted text does not occur in the exact anchor." },
    { checkId: "compatible-assumptions", status: compatible ? "passed" : "failed", summary: compatible ? "Claim assumptions include the source assumptions." : "The claim omits at least one source assumption." },
    { checkId: "not-stronger", status: scopeCompatible ? "passed" : "failed", summary: scopeCompatible ? "The claim scope is no stronger than the source scope." : "The claim scope is stronger than or incomparable with the source scope." },
    { checkId: "support", status: supportStatus, summary: supportStatus === "passed" ? "A reviewed anchor supports the recorded interpretation." : supportStatus === "failed" ? "The reviewed anchor does not support the recorded interpretation." : "Source support remains unreviewed or inconclusive." },
  ];
  return {
    outcome: checks.some((check) => check.status === "failed")
      ? "failed"
      : checks.some((check) => check.status === "inconclusive")
        ? "inconclusive"
        : "passed",
    checks,
    reviewState: reviewed,
  };
}

export async function groundClaimInLiterature(
  projectRoot: string,
  options: Parameters<typeof checkLiteratureCitation>[1] & {
    claimId: string;
    contextId: string;
    interpretation: string;
    actor?: Actor;
  },
) {
  const objects = branchObjects(projectRoot, options.branchId);
  const claim = exactObject(objects, options.claimId, "claim");
  const context = exactObject(objects, options.contextId, "context");
  const source = getLiteratureSource(projectRoot, options.branchId, options.sourceId);
  const anchor = source.source.anchors.find((candidate) => candidate.anchorId === options.anchorId)!;
  const declaredContext = isRecord(claim.content) ? claim.content.contextId : undefined;
  if (typeof declaredContext === "string" && declaredContext !== context.objectId) {
    throw new Error(`Claim ${claim.objectId} is scoped to context ${declaredContext}`);
  }
  const assessment = checkLiteratureCitation(projectRoot, options);
  const environment = await putObject(projectRoot, {
    branchId: options.branchId,
    objectType: "environment",
    content: {
      schemaVersion: 1,
      kind: "citation-check-environment",
      checker: { checkerId: "core.literature-citation", version: "1.0.0" },
      runtime: { node: process.version },
    },
    ...actorOption(options.actor),
  });
  const run = await putObject(projectRoot, {
    branchId: options.branchId,
    objectType: "run",
    content: secretFree({
      schemaVersion: 1,
      kind: "citation-check-run",
      status: assessment.outcome === "passed" ? "succeeded" : "failed",
      inputs: {
        claimRef: { objectId: claim.objectId, versionId: claim.versionId },
        contextRef: { objectId: context.objectId, versionId: context.versionId },
        sourceRef: { objectId: source.object.objectId, versionId: source.object.versionId },
        anchorRef: { anchorId: anchor.anchorId, contentHash: anchor.contentHash },
        quotedText: options.quotedText,
        claimAssumptions: options.claimAssumptions,
        claimScope: options.claimScope,
        expectedAuthors: options.expectedAuthors,
        expectedYear: options.expectedYear,
        expectedIdentifiers: options.expectedIdentifiers ?? {},
        interpretation: stringValue(options.interpretation, "interpretation"),
      },
      result: assessment,
      environmentId: environment.objectId,
      permissions: [],
      nondeterminism: "deterministic",
    }, "citation check run"),
    ...actorOption(options.actor),
  });
  const evidence = await putObject(projectRoot, {
    branchId: options.branchId,
    objectType: "evidence",
    content: secretFree({
      schemaVersion: 1,
      kind: "source-grounded-evidence",
      dimension: "source",
      outcome: assessment.outcome,
      assurance: assessment.reviewState === "unreviewed" ? "reported" : "human-reviewed",
      summary: stringValue(options.interpretation, "interpretation"),
      checks: assessment.checks,
      claimRef: { objectId: claim.objectId, versionId: claim.versionId },
      contextRef: { objectId: context.objectId, versionId: context.versionId },
      sourceRef: { objectId: source.object.objectId, versionId: source.object.versionId },
      anchorRef: { anchorId: anchor.anchorId, contentHash: anchor.contentHash, locator: anchor.locator },
      excerpt: anchor.text,
      provenance: {
        producedByRunId: run.objectId,
        environmentId: environment.objectId,
        sourceArtifactId: source.source.artifact.artifactId,
        sourceArtifactDigest: source.source.artifact.digest,
      },
    }, "source-grounded evidence"),
    ...actorOption(options.actor),
  });
  const edgeType = assessment.outcome === "passed" ? "supports" : assessment.outcome === "failed" ? "refutes" : "tested_by";
  const judgmentEdge = await addEdge(projectRoot, {
    branchId: options.branchId,
    edgeType,
    ...(edgeType === "tested_by"
      ? { fromObjectId: claim.objectId, toObjectId: evidence.objectId }
      : { fromObjectId: evidence.objectId, toObjectId: claim.objectId }),
    contextId: context.objectId,
    metadata: { verificationDimension: "source", anchorId: anchor.anchorId, outcome: assessment.outcome },
    ...actorOption(options.actor),
  });
  const citationEdge = await addEdge(projectRoot, {
    branchId: options.branchId,
    edgeType: "cites",
    fromObjectId: claim.objectId,
    toObjectId: source.object.objectId,
    contextId: context.objectId,
    metadata: { anchorId: anchor.anchorId, evidenceObjectId: evidence.objectId },
    ...actorOption(options.actor),
  });
  const failure = assessment.outcome === "passed" ? undefined : await putObject(projectRoot, {
    branchId: options.branchId,
    objectType: "failure",
    content: {
      schemaVersion: 1,
      kind: "citation-verification-gap",
      status: "open",
      claimRef: { objectId: claim.objectId, versionId: claim.versionId },
      evidenceRef: { objectId: evidence.objectId, versionId: evidence.versionId },
      failedCheckIds: assessment.checks.filter((check) => check.status !== "passed").map((check) => check.checkId),
    },
    ...actorOption(options.actor),
  });
  return { assessment, run, environment, evidence, judgmentEdge, citationEdge, ...(failure === undefined ? {} : { failure }) };
}

export interface NoveltyCandidate extends LiteratureSearchResult {
  readonly relation: "possible-overlap" | "known-special-case" | "prior-attribution";
  readonly conclusion: "requires-human-review";
}

export async function searchLiteratureNovelty(
  projectRoot: string,
  options: {
    branchId: string;
    claimId: string;
    contextId: string;
    limit?: number;
    semanticAdapter?: LiteratureSemanticAdapter;
  },
): Promise<{ claimId: string; claimVersionId: string; conclusion: "not-assessed"; candidates: NoveltyCandidate[] }> {
  const objects = branchObjects(projectRoot, options.branchId);
  const claim = exactObject(objects, options.claimId, "claim");
  exactObject(objects, options.contextId, "context");
  const statement = isRecord(claim.content) && typeof claim.content.statement === "string"
    ? claim.content.statement
    : canonicalJson(claim.content);
  const claimScope = statementScope(statement);
  const results = await searchLiterature(projectRoot, {
    branchId: options.branchId,
    query: statement,
    mode: "hybrid",
    anchorKinds: ["theorem", "definition", "paragraph", "document"],
    limit: options.limit ?? 10,
    ...(options.semanticAdapter === undefined ? {} : { semanticAdapter: options.semanticAdapter }),
  });
  const ranks: Record<LiteratureScope, number> = { example: 0, existential: 1, conditional: 2, universal: 3 };
  return {
    claimId: claim.objectId,
    claimVersionId: claim.versionId,
    conclusion: "not-assessed",
    candidates: results.map((result) => {
      const source = getLiteratureSource(projectRoot, options.branchId, result.sourceId);
      const anchor = source.source.anchors.find((candidate) => candidate.anchorId === result.anchorId)!;
      const relation: NoveltyCandidate["relation"] = result.score >= 0.9
        ? "prior-attribution"
        : anchor.scope !== undefined && ranks[anchor.scope] < ranks[claimScope]
          ? "known-special-case"
          : "possible-overlap";
      return { ...result, relation, conclusion: "requires-human-review" };
    }),
  };
}

export interface LiteratureCatalogRecord {
  readonly recordId: string;
  readonly title: string;
  readonly authors: readonly string[];
  readonly year?: number;
  readonly identifiers: Readonly<Record<string, string>>;
  readonly abstract?: string;
  readonly url?: string;
  readonly references?: readonly LiteratureReference[];
}

export interface LiteratureCatalogAdapter {
  readonly descriptor: {
    readonly catalogId: string;
    readonly name: string;
    readonly version: string;
    readonly requiredCapabilities: readonly ToolCapability[];
  };
  readonly search: (
    query: string,
    options: { limit: number; signal: AbortSignal },
  ) => Promise<readonly LiteratureCatalogRecord[]>;
}

export class LiteratureCatalogRegistry {
  readonly #adapters = new Map<string, LiteratureCatalogAdapter>();

  public register(adapter: LiteratureCatalogAdapter): this {
    const descriptor = record(adapter?.descriptor, "literature catalog descriptor");
    exactKeys(descriptor, ["catalogId", "name", "version", "requiredCapabilities"], "literature catalog descriptor");
    const catalogId = stringValue(descriptor.catalogId, "catalogId");
    stringValue(descriptor.name, "catalog name");
    stringValue(descriptor.version, "catalog version");
    const capabilities = stringArray(descriptor.requiredCapabilities, "requiredCapabilities");
    for (const capability of capabilities) {
      if (!(TOOL_CAPABILITIES as readonly string[]).includes(capability)) {
        throw new TypeError(`Unsupported catalog capability: ${capability}`);
      }
    }
    if (typeof adapter.search !== "function") throw new TypeError("catalog adapter.search must be a function");
    if (this.#adapters.has(catalogId)) throw new Error(`Catalog ${catalogId} is already registered`);
    this.#adapters.set(catalogId, adapter);
    return this;
  }

  public get(catalogId: string): LiteratureCatalogAdapter | undefined {
    return this.#adapters.get(catalogId);
  }

  public list(): readonly LiteratureCatalogAdapter[] {
    return [...this.#adapters.values()].sort((left, right) => left.descriptor.catalogId.localeCompare(right.descriptor.catalogId));
  }
}

function normalizeCatalogRecord(value: unknown, index: number): LiteratureCatalogRecord {
  const item = record(value, `catalog results[${index}]`);
  const metadata = normalizeMetadata({
    title: item.title,
    authors: item.authors,
    year: item.year,
    identifiers: item.identifiers,
    url: item.url,
    abstract: item.abstract,
  });
  return {
    recordId: stringValue(item.recordId, `catalog results[${index}].recordId`),
    ...metadata,
    references: Array.isArray(item.references) ? item.references.map(normalizeReference) : [],
  };
}

export async function searchLiteratureCatalog(
  registry: LiteratureCatalogRegistry,
  options: {
    catalogId: string;
    query: string;
    limit?: number;
    allowedCatalogIds: readonly string[];
    grantedCapabilities: readonly ToolCapability[];
    signal?: AbortSignal;
  },
): Promise<LiteratureCatalogRecord[]> {
  const adapter = registry.get(options.catalogId);
  if (adapter === undefined) throw new Error(`Unknown literature catalog: ${options.catalogId}`);
  if (!stringArray(options.allowedCatalogIds, "allowedCatalogIds").includes(options.catalogId)) {
    throw new Error(`Catalog ${options.catalogId} is not present in the explicit allow-list`);
  }
  const granted = new Set(stringArray(options.grantedCapabilities, "grantedCapabilities"));
  const missing = adapter.descriptor.requiredCapabilities.filter((capability) => !granted.has(capability));
  if (missing.length > 0) throw new Error(`Catalog ${options.catalogId} requires missing capabilities: ${missing.join(", ")}`);
  const limit = options.limit ?? 10;
  safeInteger(limit, "limit", 1);
  const controller = options.signal === undefined ? new AbortController() : undefined;
  const results = await adapter.search(stringValue(options.query, "query"), {
    limit,
    signal: options.signal ?? controller!.signal,
  });
  if (!Array.isArray(results)) throw new TypeError("catalog adapter must return an array");
  return results.map(normalizeCatalogRecord).slice(0, limit);
}

export class StaticLiteratureCatalogAdapter implements LiteratureCatalogAdapter {
  public readonly descriptor;
  readonly #records: readonly LiteratureCatalogRecord[];

  public constructor(options: { catalogId?: string; records: readonly LiteratureCatalogRecord[] }) {
    this.descriptor = {
      catalogId: options.catalogId ?? "static.catalog",
      name: "Static literature catalog",
      version: "1.0.0",
      requiredCapabilities: [] as readonly ToolCapability[],
    };
    this.#records = options.records.map(normalizeCatalogRecord);
  }

  public async search(query: string, options: { limit: number; signal: AbortSignal }) {
    if (options.signal.aborted) throw options.signal.reason ?? new Error("Catalog search aborted");
    return this.#records
      .map((record) => ({ record, score: lexicalScore(query, `${record.title}\n${record.abstract ?? ""}`).score }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score || left.record.recordId.localeCompare(right.record.recordId))
      .slice(0, options.limit)
      .map((entry) => entry.record);
  }
}

export interface LiteratureHttpResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

export type LiteratureHttpTransport = (
  url: string,
  options: { signal: AbortSignal; headers: Readonly<Record<string, string>> },
) => Promise<LiteratureHttpResponse>;

function abstractFromInvertedIndex(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const positions: Array<[number, string]> = [];
  for (const [word, raw] of Object.entries(value)) {
    if (!Array.isArray(raw)) continue;
    for (const position of raw) if (Number.isSafeInteger(position)) positions.push([Number(position), word]);
  }
  return positions.sort(([left], [right]) => left - right).map(([, word]) => word).join(" ") || undefined;
}

export class OpenAlexCatalogAdapter implements LiteratureCatalogAdapter {
  public readonly descriptor = {
    catalogId: "openalex.works",
    name: "OpenAlex Works",
    version: "1.0.0",
    requiredCapabilities: ["network.access"] as readonly ToolCapability[],
  } as const;
  readonly #transport: LiteratureHttpTransport;

  public constructor(transport?: LiteratureHttpTransport) {
    this.#transport = transport ?? (async (url, options) => fetch(url, {
      signal: options.signal,
      headers: options.headers,
    }));
  }

  public async search(query: string, options: { limit: number; signal: AbortSignal }): Promise<readonly LiteratureCatalogRecord[]> {
    const url = `https://api.openalex.org/works?search=${encodeURIComponent(query)}&per-page=${options.limit}`;
    const response = await this.#transport(url, {
      signal: options.signal,
      headers: { Accept: "application/json", "User-Agent": "OpenReason/Stage9" },
    });
    if (!response.ok) throw new Error(`OpenAlex request failed with HTTP ${response.status}`);
    const payload = record(await response.json(), "OpenAlex response");
    if (!Array.isArray(payload.results)) throw new TypeError("OpenAlex response.results must be an array");
    return payload.results.map((raw, index): LiteratureCatalogRecord => {
      const work = record(raw, `OpenAlex results[${index}]`);
      const authorships = Array.isArray(work.authorships) ? work.authorships : [];
      const authors = authorships.flatMap((rawAuthorship) => {
        if (!isRecord(rawAuthorship) || !isRecord(rawAuthorship.author) || typeof rawAuthorship.author.display_name !== "string") return [];
        return [rawAuthorship.author.display_name];
      });
      const ids = isRecord(work.ids) ? work.ids : {};
      const identifiers: Record<string, string> = {};
      if (typeof work.id === "string") identifiers.openalex = work.id;
      if (typeof work.doi === "string") identifiers.doi = work.doi.replace(/^https?:\/\/doi\.org\//iu, "");
      if (typeof ids.arxiv === "string") identifiers.arxiv = ids.arxiv;
      const primaryLocation = isRecord(work.primary_location) ? work.primary_location : undefined;
      return normalizeCatalogRecord({
        recordId: stringValue(work.id, `OpenAlex results[${index}].id`),
        title: work.title,
        authors,
        year: work.publication_year,
        identifiers,
        abstract: abstractFromInvertedIndex(work.abstract_inverted_index),
        url: primaryLocation?.landing_page_url,
        references: Array.isArray(work.referenced_works)
          ? work.referenced_works.map((id) => ({ title: String(id) }))
          : [],
      }, index);
    });
  }
}

export async function ingestCatalogRecord(
  projectRoot: string,
  options: { branchId: string; record: LiteratureCatalogRecord; actor?: Actor },
): Promise<IngestedLiterature> {
  const catalogRecord = normalizeCatalogRecord(options.record, 0);
  const bytes = new TextEncoder().encode(`${JSON.stringify(catalogRecord, null, 2)}\n`);
  return ingestLiteratureDocument(projectRoot, {
    branchId: options.branchId,
    sourceKind: "catalog-record",
    logicalName: `${catalogRecord.recordId.replace(/[^A-Za-z0-9._-]+/gu, "_")}.json`,
    mediaType: "application/json",
    bytes,
    metadata: catalogRecord,
    extractedText: [catalogRecord.title, catalogRecord.abstract].filter(Boolean).join("\n\n"),
    ...(catalogRecord.references === undefined ? {} : { references: catalogRecord.references }),
    ingestorId: "core.catalog-record",
    ingestorVersion: "1.0.0",
    ...actorOption(options.actor),
  });
}
