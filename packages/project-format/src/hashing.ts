import { createHash } from "node:crypto";

import { canonicalJson } from "./json.js";

export type Sha256Digest = `sha256:${string}`;

export function sha256Digest(value: string | Uint8Array): Sha256Digest {
  const hexadecimal = createHash("sha256").update(value).digest("hex");
  return `sha256:${hexadecimal}`;
}

export function computeContentHash(content: unknown): Sha256Digest {
  return sha256Digest(canonicalJson(content));
}

export function verifyContentHash(content: unknown, expected: string): boolean {
  return computeContentHash(content) === expected;
}

export function computeEventHash(event: Readonly<Record<string, unknown>>): Sha256Digest {
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event)) {
    if (key !== "eventHash") body[key] = value;
  }
  return computeContentHash(body);
}

export function verifyEventHash(
  event: Readonly<Record<string, unknown>> & { readonly eventHash: string },
): boolean {
  return computeEventHash(event) === event.eventHash;
}

export function withEventHash<T extends Readonly<Record<string, unknown>>>(
  event: T,
): T & { readonly eventHash: Sha256Digest } {
  return { ...event, eventHash: computeEventHash(event) };
}

