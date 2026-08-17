import { randomBytes } from "node:crypto";

import { z } from "zod";

import { OBJECT_ID_PREFIXES, type ObjectType } from "./constants.js";

const CROCKFORD_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const PREFIX_PATTERN = "[a-z][a-z0-9]{1,11}";
const ULID_PATTERN = "[0-7][0-9A-HJKMNP-TV-Z]{25}";
const UUID_V7_PATTERN =
  "[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const ID_SUFFIX_PATTERN = `(?:${ULID_PATTERN}|${UUID_V7_PATTERN})`;

export const CANONICAL_ID_PATTERN = new RegExp(
  `^${PREFIX_PATTERN}_${ID_SUFFIX_PATTERN}$`,
);

export const CanonicalIdSchema = z
  .string()
  .regex(CANONICAL_ID_PATTERN, "Expected a prefixed ULID or UUIDv7 identifier");
export const canonicalIdSchema = CanonicalIdSchema;
export type CanonicalId = z.infer<typeof CanonicalIdSchema>;

export function canonicalIdSchemaFor(...prefixes: readonly string[]) {
  if (prefixes.length === 0) throw new TypeError("At least one ID prefix is required");
  for (const prefix of prefixes) assertPrefix(prefix);
  const alternatives = prefixes.join("|");
  return z
    .string()
    .regex(
      new RegExp(`^(?:${alternatives})_${ID_SUFFIX_PATTERN}$`),
      `Expected an identifier with prefix ${prefixes.join(" or ")}`,
    );
}

export const ProjectIdSchema = canonicalIdSchemaFor("prj");
export const BranchIdSchema = canonicalIdSchemaFor("br");
export const EventIdSchema = canonicalIdSchemaFor("evt");
export const VersionIdSchema = canonicalIdSchemaFor("ver");
export const EdgeIdSchema = canonicalIdSchemaFor("edg");
export const ArtifactIdSchema = canonicalIdSchemaFor("art");
export const RunIdSchema = canonicalIdSchemaFor("run");
export const EnvironmentIdSchema = canonicalIdSchemaFor("env");
export const ContextIdSchema = canonicalIdSchemaFor("ctx");
export const MigrationIdSchema = canonicalIdSchemaFor("mig");
export const JobIdSchema = canonicalIdSchemaFor("job");

export interface IdFactoryOptions {
  readonly now?: () => number;
  readonly random?: (size: number) => Uint8Array;
}

export interface IdFactory {
  create(prefix: string, timestamp?: number | Date): CanonicalId;
}

function encodeBase32(value: bigint, length: number): string {
  let current = value;
  let encoded = "";
  for (let index = 0; index < length; index += 1) {
    const digit = Number(current & 31n);
    encoded = CROCKFORD_BASE32[digit] + encoded;
    current >>= 5n;
  }
  if (current !== 0n) throw new RangeError("Value does not fit in requested base32 length");
  return encoded;
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

function assertPrefix(prefix: string): void {
  if (!new RegExp(`^${PREFIX_PATTERN}$`).test(prefix)) {
    throw new TypeError("ID prefix must be 2-12 lowercase ASCII letters/digits and start with a letter");
  }
}

function toUnixMilliseconds(timestamp: number | Date): number {
  const milliseconds = timestamp instanceof Date ? timestamp.getTime() : timestamp;
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0 || milliseconds > 281_474_976_710_655) {
    throw new RangeError("ID timestamp must be a non-negative 48-bit integer in milliseconds");
  }
  return milliseconds;
}

export function createIdFactory(options: IdFactoryOptions = {}): IdFactory {
  const now = options.now ?? Date.now;
  const random = options.random ?? ((size: number) => randomBytes(size));
  let lastTimestamp = -1;
  let lastEntropy = -1n;
  const maxEntropy = (1n << 80n) - 1n;

  return {
    create(prefix: string, timestamp: number | Date = now()): CanonicalId {
      assertPrefix(prefix);
      let milliseconds = toUnixMilliseconds(timestamp);

      // Clock rollback must not make newly issued IDs sort before earlier IDs.
      if (milliseconds < lastTimestamp) milliseconds = lastTimestamp;

      if (milliseconds === lastTimestamp) {
        if (lastEntropy === maxEntropy) {
          milliseconds += 1;
          lastTimestamp = milliseconds;
          lastEntropy = 0n;
        } else {
          lastEntropy += 1n;
        }
      } else {
        const entropy = random(10);
        if (entropy.byteLength !== 10) {
          throw new RangeError("ID entropy source must return exactly the requested byte count");
        }
        lastTimestamp = milliseconds;
        lastEntropy = bytesToBigInt(entropy);
      }

      const suffix = `${encodeBase32(BigInt(lastTimestamp), 10)}${encodeBase32(lastEntropy, 16)}`;
      return `${prefix}_${suffix}`;
    },
  };
}

const defaultIdFactory = createIdFactory();

export function createId(prefix: string, timestamp?: number | Date): CanonicalId {
  return timestamp === undefined
    ? defaultIdFactory.create(prefix)
    : defaultIdFactory.create(prefix, timestamp);
}

export function createObjectId(objectType: ObjectType, timestamp?: number | Date): CanonicalId {
  return createId(OBJECT_ID_PREFIXES[objectType], timestamp);
}

export function timestampFromId(identifier: string): number | undefined {
  if (!CANONICAL_ID_PATTERN.test(identifier)) return undefined;
  const suffix = identifier.slice(identifier.indexOf("_") + 1);
  if (suffix.includes("-")) return undefined;

  let timestamp = 0n;
  for (const character of suffix.slice(0, 10)) {
    const value = CROCKFORD_BASE32.indexOf(character);
    if (value < 0) return undefined;
    timestamp = timestamp * 32n + BigInt(value);
  }
  const numeric = Number(timestamp);
  return Number.isSafeInteger(numeric) ? numeric : undefined;
}
