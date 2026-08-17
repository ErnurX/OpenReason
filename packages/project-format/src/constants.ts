export const PROJECT_FORMAT = "reasoning-project" as const;
export const CURRENT_FORMAT_VERSION = "0.1.0" as const;
export const SUPPORTED_FORMAT_MAJOR = 0 as const;
export const HASH_ALGORITHM = "sha256" as const;

export const OBJECT_TYPES = [
  "problem",
  "goal",
  "context",
  "definition",
  "assumption",
  "claim",
  "evidence",
  "source",
  "run",
  "artifact",
  "review",
  "decision",
  "failure",
  "branch",
  "workstream",
  "document",
  "environment",
  "alignment",
] as const;

export type ObjectType = (typeof OBJECT_TYPES)[number];

export const EDGE_TYPES = [
  "depends_on",
  "uses_definition",
  "supports",
  "refutes",
  "derived_from",
  "tested_by",
  "formalizes",
  "cites",
  "produced_by",
  "contradicts",
  "supersedes",
] as const;

export type EdgeType = (typeof EDGE_TYPES)[number];

export const ACTOR_TYPES = ["human", "agent", "tool", "system"] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

export const REPRODUCIBILITY_KINDS = [
  "deterministic",
  "seeded",
  "nondeterministic",
  "externally-sourced",
] as const;

export type ReproducibilityKind = (typeof REPRODUCIBILITY_KINDS)[number];

export const KNOWN_EVENT_TYPES = [
  "ProjectInitialized",
  "BranchCreated",
  "ObjectVersionCreated",
  "EdgeCreated",
  "ArtifactRegistered",
  "BranchMerged",
  "MigrationApplied",
] as const;

export type KnownEventType = (typeof KNOWN_EVENT_TYPES)[number];

export const OBJECT_ID_PREFIXES: Readonly<Record<ObjectType, string>> = {
  problem: "prb",
  goal: "gol",
  context: "ctx",
  definition: "def",
  assumption: "asm",
  claim: "clm",
  evidence: "evd",
  source: "src",
  run: "run",
  artifact: "art",
  review: "rev",
  decision: "dec",
  failure: "flr",
  branch: "br",
  workstream: "wrk",
  document: "doc",
  environment: "env",
  alignment: "aln",
};
