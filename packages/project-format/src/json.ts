export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/**
 * Deterministic JSON serialization for hashing canonical project values.
 * Object keys are recursively sorted; undefined, sparse arrays, non-finite
 * numbers, custom prototypes, and other non-JSON values are rejected.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical JSON cannot contain a non-finite number");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }

  if (Array.isArray(value)) {
    const items: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value)) throw new TypeError("Canonical JSON cannot contain a sparse array");
      items.push(canonicalJson(value[index]));
    }
    return `[${items.join(",")}]`;
  }

  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Canonical JSON accepts only plain objects");
    }
    const record = value as Record<string, unknown>;
    const members = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${members.join(",")}}`;
  }

  throw new TypeError(`Canonical JSON cannot contain ${describe(value)}`);
}

export function parseJson(text: string): JsonValue {
  const value: unknown = JSON.parse(text);
  // Reusing the canonicalizer gives this helper the same JSON-domain checks as
  // hashing (in particular for values that JSON.parse cannot normally create).
  canonicalJson(value);
  return value as JsonValue;
}

