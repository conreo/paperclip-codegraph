import { describe, expect, it } from "vitest";

import {
  OPERATOR_CONFIG_DEFAULTS,
  mergeOperatorConfig,
  readOperatorConfig,
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

describe("mergeOperatorConfig", () => {
  it("preserves keys the form does not show", () => {
    // 0.6.0 wrote seventeen keys; this page shows five. A Settings save must not
    // delete the other twelve — the same bug class that made mergeGovernance
    // necessary.
    const stored = { enabled: false, useDaemon: true, startupTimeoutMs: 30_000 };
    const merged = mergeOperatorConfig(stored, { enabled: true });
    expect(merged).toEqual({ enabled: true, useDaemon: true, startupTimeoutMs: 30_000 });
  });

  it("leaves an untouched field alone", () => {
    const stored = { enabled: true, autoIndex: true, codegraphCommand: "/opt/cg" };
    const merged = mergeOperatorConfig(stored, { autoIndex: undefined });
    expect(merged).toEqual(stored);
  });

  it("applies false and empty values, which are real edits", () => {
    // `false` and `[]` are values, not absences: turning something off must
    // actually turn it off.
    const merged = mergeOperatorConfig(
      { enabled: true, autoInstall: true, allowedProjectRoots: ["/srv/repos"] },
      { enabled: false, allowedProjectRoots: [] },
    );
    expect(merged).toEqual({ enabled: false, autoInstall: true, allowedProjectRoots: [] });
  });

  it("treats a missing or invalid document as empty", () => {
    expect(mergeOperatorConfig(null, { enabled: true })).toEqual({ enabled: true });
    expect(mergeOperatorConfig("nonsense", { enabled: true })).toEqual({ enabled: true });
    expect(mergeOperatorConfig([1, 2], { enabled: true })).toEqual({ enabled: true });
  });

  it("does not mutate the stored document", () => {
    const stored = { enabled: false, useDaemon: true };
    mergeOperatorConfig(stored, { enabled: true });
    expect(stored).toEqual({ enabled: false, useDaemon: true });
  });

  it("round-trips through read merge and read", () => {
    const stored = { enabled: false, autoIndex: true, useDaemon: true };
    const edited = readOperatorConfig(stored);
    const saved = mergeOperatorConfig(stored, { ...edited, enabled: true });
    // All five settable fields are written, because the schema is closed and the
    // server validates against it: a partial document is not a valid one.
    expect(saved).toEqual({
      enabled: true,
      autoInstall: false,
      autoIndex: true,
      allowedProjectRoots: [],
      codegraphCommand: "codegraph",
      // ...and the key this page does not show survives.
      useDaemon: true,
    });
    expect(readOperatorConfig(saved).enabled).toBe(true);
  });
});
