export interface SchemaIssue {
  code?: string;
  path: readonly (string | number)[];
  message: string;
  expected?: string;
  received?: unknown;
  keys?: readonly string[];
  options?: readonly unknown[];
  minimum?: number | bigint;
  maximum?: number | bigint;
}

export interface SchemaErrorLike {
  name?: string;
  issues: readonly SchemaIssue[];
  message?: string;
}

export function formatJsonPath(path: readonly (string | number)[]): string {
  if (path.length === 0) return "(root)";
  let formatted = "";
  for (let i = 0; i < path.length; i += 1) {
    const segment = path[i]!;
    if (typeof segment === "number") {
      formatted += `[${segment}]`;
    } else if (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(String(segment))) {
      formatted += formatted.length > 0 ? `.${segment}` : String(segment);
    } else {
      formatted += `[${JSON.stringify(segment)}]`;
    }
  }
  return formatted;
}

export function formatSchemaIssue(issue: SchemaIssue): string {
  const path = formatJsonPath(issue.path);
  let detail = issue.message;

  if (issue.code === "unrecognized_keys" && Array.isArray(issue.keys)) {
    detail = `Unrecognized key(s): ${issue.keys.map((k) => JSON.stringify(k)).join(", ")}`;
  } else if (
    issue.code === "too_small" &&
    issue.minimum !== undefined &&
    !detail.includes(String(issue.minimum))
  ) {
    detail = `${detail} (minimum: ${issue.minimum})`;
  } else if (
    issue.code === "too_big" &&
    issue.maximum !== undefined &&
    !detail.includes(String(issue.maximum))
  ) {
    detail = `${detail} (maximum: ${issue.maximum})`;
  }

  return `  • at ${path}: ${detail}`;
}

export function isSchemaError(error: unknown): error is SchemaErrorLike {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: string }).name === "ZodError" &&
    Array.isArray((error as { issues?: unknown }).issues)
  );
}

export function formatSchemaError(error: SchemaErrorLike, contextLabel?: string): string {
  const header = contextLabel
    ? `Schema validation failed for ${contextLabel}:`
    : "Schema validation failed:";
  const issues = error.issues.map(formatSchemaIssue);
  return `${header}\n${issues.join("\n")}`;
}

export const formatZodError = formatSchemaError;
export const isZodError = isSchemaError;

export function parseJsonSafely<T = unknown>(text: string, sourceLabel: string): T {
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`JSON syntax error in ${sourceLabel}: ${message}`);
  }
}

export function formatCliError(error: unknown): string {
  if (isSchemaError(error)) {
    return formatSchemaError(error);
  }
  if (error instanceof Error) {
    // If the message looks like a stringified ZodError JSON array, try to parse and format it
    if (error.message.startsWith("[{") && error.message.endsWith("}]")) {
      try {
        const issues = JSON.parse(error.message) as SchemaIssue[];
        if (Array.isArray(issues) && issues.length > 0 && issues[0]?.code) {
          return formatSchemaError({ issues });
        }
      } catch {
        // Fall back to ordinary message if parsing fails
      }
    }
    return error.message;
  }
  return String(error);
}
