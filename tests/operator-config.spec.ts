import { describe, expect, it } from "vitest";

import {
  INSTANCE_CONFIG_SCHEMA,
  OPERATOR_CONFIG_DEFAULTS,
  operatorConfigForSave,
  readOperatorConfig,
  settableConfigKeys,
} from "../src/config.js";

describe("readOperatorConfig", () => {
  it("returns the schema defaults for an empty document", () => {
    expect(readOperatorConfig({})).toEqual(OPERATOR_CONFIG_DEFAULTS);
    expect(readOperatorConfig(null)).toEqual(OPERATOR_CONFIG_DEFAULTS);
    expect(readOperatorConfig(undefined)).toEqual(OPERATOR_CONFIG_DEFAULTS);
    expect(readOperatorConfig("nonsense")).toEqual(OPERATOR_CONFIG_DEFAULTS);
    expect(readOperatorConfig([1, 2, 3])).toEqual(OPERATOR_CONFIG_DEFAULTS);
  });

  it("defaults to disabled, so installing changes nothing", () => {
    // The load-bearing default: a settings form that opened with CodeGraph
    // apparently on would misrepresent an unconfigured plugin.
    expect(readOperatorConfig({}).enabled).toBe(false);
  });

  it("reads the five settable fields", () => {
    const config = readOperatorConfig({
      enabled: true,
      autoInstall: true,
      autoIndex: true,
      allowedProjectRoots: ["/srv/repos", "/opt/code"],
      codegraphCommand: "/usr/local/bin/codegraph",
    });
    expect(config).toEqual({
      enabled: true,
      autoInstall: true,
      autoIndex: true,
      allowedProjectRoots: ["/srv/repos", "/opt/code"],
      codegraphCommand: "/usr/local/bin/codegraph",
    });
  });

  it("takes each field independently, so one bad key does not sink the form", () => {
    const config = readOperatorConfig({
      enabled: "yes" as unknown as boolean,
      autoIndex: true,
      allowedProjectRoots: "not-an-array" as unknown as string[],
    });
    expect(config.enabled).toBe(false);
    expect(config.autoIndex).toBe(true);
    expect(config.allowedProjectRoots).toEqual([]);
  });

  it("discards non-string entries in the roots list", () => {
    const config = readOperatorConfig({
      allowedProjectRoots: ["/srv/repos", 42, null, { path: "/x" }, "/opt/code"],
    });
    expect(config.allowedProjectRoots).toEqual(["/srv/repos", "/opt/code"]);
  });

  it("falls back for a blank command rather than saving an empty one", () => {
    // An empty command cannot launch anything, so the default is the honest
    // reading of "unset" — and it keeps the field from being saved blank.
    expect(readOperatorConfig({ codegraphCommand: "" }).codegraphCommand).toBe("codegraph");
    expect(readOperatorConfig({ codegraphCommand: "   " }).codegraphCommand).toBe("codegraph");
    expect(readOperatorConfig({ codegraphCommand: "  /opt/cg  " }).codegraphCommand).toBe("/opt/cg");
  });

  it("does not mutate the document it reads", () => {
    const stored = { enabled: true, allowedProjectRoots: ["/srv/repos"] };
    const snapshot = JSON.parse(JSON.stringify(stored));
    const config = readOperatorConfig(stored);
    config.allowedProjectRoots.push("/mutated");
    expect(stored).toEqual(snapshot);
  });
});

describe("settableConfigKeys", () => {
  it("is exactly the schema's properties", () => {
    const fromSchema = Object.keys(
      (INSTANCE_CONFIG_SCHEMA as { properties: Record<string, unknown> }).properties,
    );
    expect(settableConfigKeys()).toEqual(fromSchema);
    expect(settableConfigKeys().length).toBeGreaterThan(0);
  });
});

describe("operatorConfigForSave", () => {
  it("sends only the schema's keys, so the server's closed schema accepts it", () => {
    // This is the bug that made saving fail: the payload is validated by Ajv with
    // `additionalProperties: false`, so a stray key is a rejected request rather
    // than a preserved setting.
    const stored = { enabled: true, useDaemon: true, extraEnv: {}, codegraphArgs: ["serve"] };
    const { config } = operatorConfigForSave(stored, { enabled: false });
    for (const key of Object.keys(config)) {
      expect(settableConfigKeys(), `"${key}" is not in the schema`).toContain(key);
    }
    expect(config).toEqual({ enabled: false });
  });

  it("reports the keys it left out instead of dropping them silently", () => {
    // One of them has a real effect, so the operator should be told.
    const stored = { enabled: true, useDaemon: true, startupTimeoutMs: 30_000 };
    const { droppedKeys } = operatorConfigForSave(stored, { enabled: true });
    expect(droppedKeys.sort()).toEqual(["startupTimeoutMs", "useDaemon"]);
  });

  it("does not mention keys it keeps", () => {
    const stored = { enabled: true, autoIndex: false };
    expect(operatorConfigForSave(stored, {}).droppedKeys).toEqual([]);
  });

  it("applies false and empty values, which are real edits", () => {
    const stored = { enabled: true, autoInstall: true, allowedProjectRoots: ["/srv/repos"] };
    const { config } = operatorConfigForSave(stored, { enabled: false, allowedProjectRoots: [] });
    expect(config).toEqual({ enabled: false, autoInstall: true, allowedProjectRoots: [] });
  });

  it("leaves an untouched field alone", () => {
    const stored = { enabled: true, autoIndex: true, codegraphCommand: "/opt/cg" };
    expect(operatorConfigForSave(stored, { autoIndex: undefined }).config).toEqual(stored);
  });

  it("refuses a key smuggled in through the edits", () => {
    // The form is trusted, but the rule is enforced here rather than assumed.
    const edits = { enabled: true, useDaemon: true } as Partial<
      Record<string, unknown>
    >;
    const { config } = operatorConfigForSave({}, edits);
    expect(config).toEqual({ enabled: true });
  });

  it("treats a missing or invalid document as empty", () => {
    expect(operatorConfigForSave(null, { enabled: true }).config).toEqual({ enabled: true });
    expect(operatorConfigForSave("nonsense", { enabled: true }).config).toEqual({ enabled: true });
    expect(operatorConfigForSave([1, 2], { enabled: true }).config).toEqual({ enabled: true });
  });

  it("does not mutate the stored document", () => {
    const stored = { enabled: false, useDaemon: true };
    operatorConfigForSave(stored, { enabled: true });
    expect(stored).toEqual({ enabled: false, useDaemon: true });
  });

  it("round-trips: what it saves is what it reads back", () => {
    const stored = { enabled: false, autoIndex: true, useDaemon: true };
    const edited = readOperatorConfig(stored);
    const { config } = operatorConfigForSave(stored, { ...edited, enabled: true });
    expect(readOperatorConfig(config).enabled).toBe(true);
    expect(readOperatorConfig(config).autoIndex).toBe(true);
    // And the result is stable — saving it again drops nothing further.
    expect(operatorConfigForSave(config, {}).droppedKeys).toEqual([]);
  });

  it("keeps a real organisation's legacy document saveable", () => {
    // Reproduces the reported failure: a 0.6.0-shaped document plus a form save.
    const legacy = {
      enabled: true,
      extraEnv: {},
      autoIndex: true,
      useDaemon: true,
      autoInstall: true,
      callTimeoutMs: 60000,
      codegraphArgs: ["serve", "--mcp"],
      allowTelemetry: false,
      indexTimeoutMs: 900000,
      maxResultChars: 400000,
      codegraphCommand: "codegraph",
      codegraphVersion: "1.6.0",
      startupTimeoutMs: 30000,
      auditProjectPaths: false,
      allowedProjectRoots: [],
      bindDefaultProjectForUnconfiguredCompanies: false,
    };
    const { config, droppedKeys } = operatorConfigForSave(legacy, {
      ...readOperatorConfig(legacy),
      enabled: true,
    });

    expect(Object.keys(config).sort()).toEqual(settableConfigKeys().sort());
    expect(droppedKeys).toContain("useDaemon");
    expect(droppedKeys).not.toContain("enabled");
  });
});
