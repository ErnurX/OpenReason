import { z } from "zod";

const UTC_TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?Z$/;

/**
 * True only for real calendar instants expressed in UTC, never for an offset
 * timestamp. Milliseconds may be omitted, but other fractional precision is
 * intentionally rejected so every implementation can normalize identically.
 */
export function isUtcTimestamp(value: string): boolean {
  const match = UTC_TIMESTAMP_PATTERN.exec(value);
  if (match === null) return false;

  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return false;

  const normalized = new Date(milliseconds).toISOString();
  const normalizedInput =
    match[7] === undefined ? `${value.slice(0, -1)}.000Z` : value;
  return normalized === normalizedInput;
}

export const UtcTimestampSchema = z
  .string()
  .regex(UTC_TIMESTAMP_PATTERN, "Expected an ISO-8601 timestamp in UTC")
  .refine(isUtcTimestamp, "Expected a valid ISO-8601 UTC timestamp");

export const utcTimestampSchema = UtcTimestampSchema;
export type UtcTimestamp = z.infer<typeof UtcTimestampSchema>;

export function utcNow(now: Date | number = new Date()): UtcTimestamp {
  const value = typeof now === "number" ? new Date(now) : now;
  const timestamp = value.toISOString();
  if (!isUtcTimestamp(timestamp)) {
    throw new RangeError("Cannot represent the supplied date as a UTC timestamp");
  }
  return timestamp;
}
