import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  ActorSchema,
  ArtifactReferenceSchema,
  CURRENT_FORMAT_VERSION,
  EdgeEnvelopeSchema,
  EventSchema,
  KnownEventSchema,
  ObjectEnvelopeSchema,
  ProjectManifestSchema,
} from "../packages/project-format/src/index.js";

const outputDirectory = resolve("schemas/generated");
const checkOnly = process.argv.includes("--check");

const publicSchemas = {
  actor: ActorSchema,
  artifact: ArtifactReferenceSchema,
  edge: EdgeEnvelopeSchema,
  event: EventSchema,
  "known-event": KnownEventSchema,
  object: ObjectEnvelopeSchema,
  manifest: ProjectManifestSchema,
} as const;

if (!checkOnly) await mkdir(outputDirectory, { recursive: true });

async function emit(name: string, content: string): Promise<void> {
  const path = resolve(outputDirectory, name);
  if (!checkOnly) {
    await writeFile(path, content, "utf8");
    return;
  }
  let current: string;
  try {
    current = await readFile(path, "utf8");
  } catch {
    throw new Error(`Generated schema is missing: ${path}`);
  }
  if (current !== content) {
    throw new Error(
      `Generated schema is stale: ${path}. Run \"pnpm run schemas\".`,
    );
  }
}

for (const [name, schema] of Object.entries(publicSchemas)) {
  const jsonSchema = schema.toJSONSchema({
    target: "draft-2020-12",
    io: "input",
  });
  const document = {
    $id: `https://reasoning-workbench.org/schemas/${CURRENT_FORMAT_VERSION}/${name}.schema.json`,
    title: `Reasoning Workbench ${name} schema`,
    ...jsonSchema,
  };
  await emit(
    `${name}.schema.json`,
    `${JSON.stringify(document, null, 2)}\n`,
  );
}

await emit(
  "index.json",
  `${JSON.stringify(
    {
      formatVersion: CURRENT_FORMAT_VERSION,
      schemas: Object.keys(publicSchemas).map((name) => `${name}.schema.json`),
    },
    null,
    2,
  )}\n`,
);
