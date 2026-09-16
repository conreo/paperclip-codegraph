import { describe, expect, it } from "vitest";

import {
  ConfigError,
  DEFAULT_RUNTIME_CONFIG,
  INSTANCE_CONFIG_SCHEMA,
  normalizeConfig,
} from "../src/config.js";
import { DEFAULT_MCP_ARGS, DEFAULT_MCP_COMMAND } from "../src/constants.js";

describe("normalizeConfig", () => {
  it("is disabled by default", () => {
    expect(normalizeConfig(undefined).enabled).toBe(false);
    expect(DEFAULT_RUNTIME_CONFIG.enabled).toBe(false);
  });

  it("defaults to `codegraph serve --mcp`", () => {
    const config = normalizeConfig({});
    expect(config.codegraphCommand).toBe(DEFAULT_MCP_COMMAND);
    expect(config.codegraphArgs).toEqual([...DEFAULT_MCP_ARGS]);
  });

  it("keeps telemetry and the daemon off by default", () => {
    const config = normalizeConfig({});
    expect(config.allowTelemetry).toBe(false);
    expect(config.useDaemon).toBe(false);
    expect(config.autoInstall).toBe(false);
    expect(config.autoIndex).toBe(false);
    expect(config.auditProjectPaths).toBe(false);
  });

  it("accepts a full valid config", () => {
    const config = normalizeConfig({
      enabled: true,
      codegraphCommand: "/usr/local/bin/codegraph",
      codegraphArgs: ["serve", "--mcp", "--no-watch"],
      defaultProjectPath: "/srv/repo",
      bindDefaultProjectForUnconfiguredCompanies: true,
      allowedProjectRoots: ["/srv"],
      autoInstall: true,
      autoIndex: true,
      allowTelemetry: true,
      useDaemon: true,
      callTimeoutMs: 5_000,
      extraEnv: { CODEGRAPH_KERNEL: "0" },
    });
    expect(config.enabled).toBe(true);
    expect(config.codegraphArgs).toEqual(["serve", "--mcp", "--no-watch"]);
    expect(config.allowedProjectRoots).toEqual(["/srv"]);
    expect(config.extraEnv).toEqual({ CODEGRAPH_KERNEL: "0" });
  });

  it("rejects the wrong type for a boolean", () => {
    expect(() => normalizeConfig({ enabled: "true" })).toThrow(ConfigError);
  });

  it("rejects an empty codegraphArgs array", () => {
    expect(() => normalizeConfig({ codegraphArgs: [] })).toThrow(/must not be empty/);
  });

  it("rejects a non-string entry in codegraphArgs", () => {
    expect(() => normalizeConfig({ codegraphArgs: ["serve", 7] })).toThrow(
      /must be a non-empty string/,
    );
  });

  it("rejects an out-of-range timeout", () => {
    expect(() => normalizeConfig({ callTimeoutMs: 10 })).toThrow(/between/);
    expect(() => normalizeConfig({ callTimeoutMs: 10_000_000 })).toThrow(/between/);
  });

  it("rejects a non-finite timeout", () => {
    expect(() => normalizeConfig({ callTimeoutMs: Number.NaN })).toThrow(/finite/);
  });

  it("rejects a non-object extraEnv", () => {
    expect(() => normalizeConfig({ extraEnv: ["A=1"] })).toThrow(/object of strings/);
  });

  it("rejects a non-string extraEnv value", () => {
    expect(() => normalizeConfig({ extraEnv: { A: 1 } })).toThrow(/must be a string/);
  });

  it("rejects a blank defaultProjectPath when the key is present", () => {
    expect(() => normalizeConfig({ defaultProjectPath: "  " })).toThrow(
      /non-empty string when set/,
    );
  });

  it("rejects a non-object config", () => {
    expect(() => normalizeConfig([])).toThrow(/must be an object/);
    expect(() => normalizeConfig("nope")).toThrow(/must be an object/);
  });

  it("names the offending field in the error message", () => {
    try {
      normalizeConfig({ callTimeoutMs: 1 });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as ConfigError).field).toBe("callTimeoutMs");
      expect((error as ConfigError).message).toContain("callTimeoutMs");
    }
  });
});

describe("INSTANCE_CONFIG_SCHEMA", () => {
  const properties = INSTANCE_CONFIG_SCHEMA["properties"] as Record<
    string,
    Record<string, unknown>
  >;

  it("declares enabled with a false default", () => {
    expect(properties["enabled"]?.["default"]).toBe(false);
  });

  it("sets additionalProperties: false so typos are rejected by the host", () => {
    expect(INSTANCE_CONFIG_SCHEMA["additionalProperties"]).toBe(false);
  });

  /**
   * Deliberately a curated subset, asserted rather than derived.
   *
   * The server validates saved config with Ajv against this object and
   * `properties` is closed, so a key absent here is unreachable from the UI and
   * the API and always takes its code default. Growing this list means taking a
   * decision away from those defaults, so it should be a conscious edit.
   */
  it("exposes only the curated operator surface", () => {
    expect(Object.keys(properties).sort()).toEqual([
      "allowedProjectRoots",
      "autoIndex",
      "autoInstall",
      "codegraphCommand",
      "enabled",
    ]);
  });

  it("gives every exposed field a default, so the page renders pre-filled", () => {
    for (const [key, schema] of Object.entries(properties)) {
      expect(schema["default"], `${key} needs a default`).toBeDefined();
    }
  });

  it("still parses keys that are no longer exposed", () => {
    // Not reachable through the API today, but the runtime still understands
    // them, so re-exposing one is a schema-only change rather than a code
    // change. This test exists so that stays true.
    const config = normalizeConfig({
      codegraphArgs: ["serve", "--mcp", "--no-watch"],
      callTimeoutMs: 5_000,
      useDaemon: true,
    });
    expect(config.codegraphArgs).toEqual(["serve", "--mcp", "--no-watch"]);
    expect(config.callTimeoutMs).toBe(5_000);
    expect(config.useDaemon).toBe(true);
  });

  it("keeps a defined default for every runtime field, exposed or not", () => {
    for (const [key, value] of Object.entries(DEFAULT_RUNTIME_CONFIG)) {
      expect(value, `${key} needs a default`).toBeDefined();
    }
  });

  it("documents each field with a title and description", () => {
    for (const [key, schema] of Object.entries(properties)) {
      expect(schema["title"], `${key} needs a title`).toBeTruthy();
      expect(schema["description"], `${key} needs a description`).toBeTruthy();
    }
  });
});
