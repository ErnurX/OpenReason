import { z } from "@reasoning-workbench/project-format";
import { describe, expect, it } from "vitest";

import {
  formatCliError,
  formatJsonPath,
  formatZodError,
  isZodError,
  parseJsonSafely,
} from "../src/errors.js";

describe("CLI Actionable Error Formatting", () => {
  it("formats JSON paths in bracket and dot notation", () => {
    expect(formatJsonPath([])).toBe("(root)");
    expect(formatJsonPath(["name"])).toBe("name");
    expect(formatJsonPath(["sections", 0, "title"])).toBe("sections[0].title");
    expect(formatJsonPath(["items", 2, "properties", "color"])).toBe("items[2].properties.color");
    expect(formatJsonPath(["metadata", "special key"])).toBe("metadata[\"special key\"]");
  });

  it("formats Zod validation errors into human-readable messages", () => {
    const TestSchema = z.object({
      name: z.string(),
      age: z.number().min(0).max(120),
      role: z.enum(["admin", "user", "guest"]),
      tags: z.array(z.string()),
    });

    const result = TestSchema.safeParse({
      name: 123,
      age: -5,
      role: "superuser",
      tags: ["valid", 456],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(isZodError(result.error)).toBe(true);
      const formatted = formatZodError(result.error, "UserConfig");
      expect(formatted).toContain("Schema validation failed for UserConfig:");
      expect(formatted).toContain("• at name: Invalid input: expected string, received number");
      expect(formatted).toContain("• at age:");
      expect(formatted).toContain("• at role: Invalid option: expected one of \"admin\"|\"user\"|\"guest\"");
      expect(formatted).toContain("• at tags[1]: Invalid input: expected string, received number");
    }
  });

  it("handles unrecognized keys and strict object violations", () => {
    const StrictSchema = z.strictObject({
      title: z.string(),
    });

    const result = StrictSchema.safeParse({
      title: "Valid",
      extraKey: "Invalid",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      const formatted = formatZodError(result.error);
      expect(formatted).toContain("Schema validation failed:");
      expect(formatted).toContain("Unrecognized key(s): \"extraKey\"");
    }
  });

  it("catches and enhances JSON syntax errors with source label", () => {
    expect(() => parseJsonSafely("invalid json", "config.json")).toThrow(
      /JSON syntax error in config\.json:/,
    );

    expect(() => parseJsonSafely("{\"open\": true,", "--policy")).toThrow(
      /JSON syntax error in --policy:/,
    );

    const valid = parseJsonSafely<Record<string, unknown>>("{\"status\": \"ok\"}", "test");
    expect(valid).toEqual({ status: "ok" });
  });

  it("formats arbitrary CLI errors cleanly through formatCliError", () => {
    const standardError = new Error("Connection failed");
    expect(formatCliError(standardError)).toBe("Connection failed");

    const stringError = "Unknown error occurred";
    expect(formatCliError(stringError)).toBe("Unknown error occurred");

    // Stringified ZodError JSON array (often seen when store serializes schema errors)
    const rawZodJson = JSON.stringify([
      {
        code: "invalid_type",
        path: ["title"],
        message: "Invalid input: expected string, received number",
      },
    ]);
    const zodMsgError = new Error(rawZodJson);
    const formattedZod = formatCliError(zodMsgError);
    expect(formattedZod).toContain("Schema validation failed:");
    expect(formattedZod).toContain("• at title: Invalid input: expected string, received number");
  });
});
