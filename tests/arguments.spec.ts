import { describe, expect, it } from "vitest";

import { CODEGRAPH_TOOL_SPECS, toJsonSchema } from "../src/tools/catalog.js";
import { validateArguments } from "../src/tools/validate.js";
import { UPSTREAM_PROJECT_PATH_PARAM } from "../src/constants.js";

const explore = CODEGRAPH_TOOL_SPECS.find((spec) => spec.name === "codegraph_explore")!;
const node = CODEGRAPH_TOOL_SPECS.find((spec) => spec.name === "codegraph_node")!;
const files = CODEGRAPH_TOOL_SPECS.find((spec) => spec.name === "codegraph_files")!;

describe("declared tool schemas", () => {
  it("omits projectPath from every tool", () => {
    for (const spec of CODEGRAPH_TOOL_SPECS) {
      const schema = toJsonSchema(spec);
      const properties = schema["properties"] as Record<string, unknown>;
      expect(
        Object.keys(properties),
        `${spec.name} must not expose projectPath`,
      ).not.toContain(UPSTREAM_PROJECT_PATH_PARAM);
    }
  });

  it("closes each schema to unknown properties", () => {
    for (const spec of CODEGRAPH_TOOL_SPECS) {
      expect(toJsonSchema(spec)["additionalProperties"]).toBe(false);
    }
  });

  it("declares exactly the eight upstream tools", () => {
    expect(CODEGRAPH_TOOL_SPECS.map((spec) => spec.name)).toEqual([
      "codegraph_explore",
      "codegraph_search",
      "codegraph_callers",
      "codegraph_callees",
      "codegraph_impact",
      "codegraph_node",
      "codegraph_status",
      "codegraph_files",
    ]);
  });

  it("marks only the documented parameters required", () => {
    expect(explore.required).toEqual(["query"]);
    expect(node.required).toEqual([]);
    expect(files.required).toEqual([]);
  });
});

describe("validateArguments", () => {
  it("accepts a well-formed call", () => {
    const result = validateArguments(explore, { query: "auth flow", maxFiles: 3 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.args).toEqual({ query: "auth flow", maxFiles: 3 });
  });

  it("strips an agent-supplied projectPath", () => {
    const result = validateArguments(explore, {
      query: "auth",
      projectPath: "/srv/other-tenant/secret-repo",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The whole isolation story rests on this assertion.
    expect(result.args).not.toHaveProperty(UPSTREAM_PROJECT_PATH_PARAM);
    expect(JSON.stringify(result.args)).not.toContain("other-tenant");
    expect(result.stripped).toEqual([UPSTREAM_PROJECT_PATH_PARAM]);
  });

  it("strips every unknown key and reports what it removed", () => {
    const result = validateArguments(explore, {
      query: "x",
      command: "rm",
      args: ["-rf"],
      __proto__: { polluted: true },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.args).toEqual({ query: "x" });
    expect(result.stripped).toEqual(expect.arrayContaining(["command", "args"]));
  });

  it("rejects a missing required parameter", () => {
    const result = validateArguments(explore, { maxFiles: 3 });
    expect(result).toEqual({ ok: false, error: 'Parameter "query" is required' });
  });

  it("rejects a wrong parameter type", () => {
    expect(validateArguments(explore, { query: 7 })).toEqual({
      ok: false,
      error: 'Parameter "query" must be a string',
    });
    expect(validateArguments(explore, { query: "x", maxFiles: "3" })).toEqual({
      ok: false,
      error: 'Parameter "maxFiles" must be a number',
    });
    expect(validateArguments(node, { includeCode: "yes" })).toEqual({
      ok: false,
      error: 'Parameter "includeCode" must be a boolean',
    });
  });

  it("rejects a value outside a declared enum", () => {
    const result = validateArguments(files, { format: "yaml" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/tree, flat, grouped/);
  });

  it("accepts a value inside a declared enum", () => {
    expect(validateArguments(files, { format: "grouped" }).ok).toBe(true);
  });

  it("rejects an over-long string", () => {
    const result = validateArguments(explore, { query: "a".repeat(4_001) });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/exceeds 4000 characters/);
  });

  it("rejects a non-finite number", () => {
    expect(validateArguments(explore, { query: "x", maxFiles: Number.POSITIVE_INFINITY }).ok).toBe(
      false,
    );
  });

  it("treats null and undefined as absent", () => {
    const result = validateArguments(explore, { query: "x", maxFiles: null });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.args).toEqual({ query: "x" });
  });

  it("tolerates a non-object params payload", () => {
    expect(validateArguments(explore, null).ok).toBe(false);
    expect(validateArguments(node, "nope").ok).toBe(true);
  });

  it("ignores caller-supplied prototype keys", () => {
    const result = validateArguments(node, JSON.parse('{"__proto__":{"admin":true}}'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.args).toEqual({});
    expect(({} as Record<string, unknown>)["admin"]).toBeUndefined();
  });
});
