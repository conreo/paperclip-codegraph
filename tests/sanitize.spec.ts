import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  deriveProjectKey,
  isContainedIn,
  PathRefusal,
  redactPath,
  resolveProjectPath,
  sanitizeAlias,
  sensitiveReason,
} from "../src/governance/sanitize.js";

/**
 * A throwaway tree deep enough to pass the shallow-path gate.
 *
 * Deliberately NOT `<tmpdir>/<one-segment>`: the sanitizer rejects paths with
 * fewer than three segments, and a bare `/tmp/foo` is only two.
 */
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "pcg-"));
const ROOT = path.join(BASE, "workspace");
const PROJECT = path.join(ROOT, "org", "repo");
fs.mkdirSync(PROJECT, { recursive: true });

describe("resolveProjectPath", () => {
  it("accepts an absolute existing directory", () => {
    expect(resolveProjectPath(PROJECT)).toBe(fs.realpathSync(PROJECT));
  });

  it("rejects non-strings and empty values", () => {
    expect(() => resolveProjectPath(undefined)).toThrow(PathRefusal);
    expect(() => resolveProjectPath(42)).toThrow(/must be a string/);
    expect(() => resolveProjectPath("   ")).toThrow(/must not be empty/);
  });

  it("rejects relative paths", () => {
    expect(() => resolveProjectPath("org/repo")).toThrow(/must be absolute/);
  });

  it("rejects NUL bytes", () => {
    expect(() => resolveProjectPath(`${PROJECT}\0/etc`)).toThrow(/NUL/);
  });

  it("rejects a path that does not exist", () => {
    expect(() => resolveProjectPath(path.join(ROOT, "not", "here"))).toThrow(
      /does not exist/,
    );
  });

  it("rejects a file", () => {
    const file = path.join(PROJECT, "a.txt");
    fs.writeFileSync(file, "x");
    expect(() => resolveProjectPath(file)).toThrow(/not a directory/);
  });

  it("refuses filesystem roots and shallow paths", () => {
    expect(() => resolveProjectPath("/")).toThrow(PathRefusal);
    expect(sensitiveReason("/", { homedir: "/home/nobody" })).toMatch(/too shallow/);
  });

  it("refuses the user home directory", () => {
    expect(sensitiveReason(os.homedir(), { homedir: os.homedir() })).toMatch(
      /home directory/,
    );
  });

  it("refuses credential directories", () => {
    const home = os.homedir();
    for (const dir of [".ssh", ".aws", ".gnupg", ".paperclip", ".dsh", ".config"]) {
      expect(sensitiveReason(path.join(home, dir), { homedir: home })).not.toBeNull();
    }
  });

  it("refuses system directories", () => {
    for (const dir of ["/etc", "/proc", "/sys", "/dev", "/root", "/var/lib"]) {
      expect(sensitiveReason(dir, { homedir: "/home/nobody" })).not.toBeNull();
    }
  });

  it("does not refuse a normal deep project path", () => {
    expect(sensitiveReason(PROJECT, { homedir: os.homedir() })).toBeNull();
  });

  it("enforces allowedProjectRoots containment", () => {
    expect(
      resolveProjectPath(PROJECT, { allowedProjectRoots: [ROOT] }),
    ).toBe(fs.realpathSync(PROJECT));

    expect(() =>
      resolveProjectPath(PROJECT, { allowedProjectRoots: ["/srv/elsewhere"] }),
    ).toThrow(/not inside any configured allowedProjectRoots/);
  });

  it("resolves symlinks before checking containment", () => {
    const outside = path.join(BASE, "elsewhere", "deep");
    fs.mkdirSync(outside, { recursive: true });
    const linked = path.join(PROJECT, "linked");
    fs.symlinkSync(outside, linked);

    // `linked` looks contained, but its real target is not.
    expect(() =>
      resolveProjectPath(linked, { allowedProjectRoots: [PROJECT] }),
    ).toThrow(/not inside any configured allowedProjectRoots/);
  });

  it("rejects a symlink that escapes into a credential directory", () => {
    const link = path.join(PROJECT, "ssh-link");
    const target = path.join(os.homedir(), ".ssh");
    if (!fs.existsSync(target)) return;
    try {
      fs.symlinkSync(target, link);
    } catch {
      return; // symlinks unavailable in this environment
    }
    expect(() => resolveProjectPath(link)).toThrow(PathRefusal);
    try {
      resolveProjectPath(link);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as PathRefusal).code).toBe("sensitive");
    }
  });
});

describe("isContainedIn", () => {
  it("is true for the root itself and for descendants", () => {
    expect(isContainedIn("/srv/app", "/srv/app")).toBe(true);
    expect(isContainedIn("/srv/app", "/srv/app/src")).toBe(true);
  });

  it("is false for siblings and parents", () => {
    expect(isContainedIn("/srv/app", "/srv/app-other")).toBe(false);
    expect(isContainedIn("/srv/app", "/srv")).toBe(false);
  });

  it("is false for a traversal escape", () => {
    expect(isContainedIn("/srv/app", "/srv/app/../../etc")).toBe(false);
  });
});

describe("aliasing and redaction", () => {
  it("derives a stable alias from the last two segments", () => {
    // Two segments, not the whole path: enough to tell two checkouts apart in a
    // log, not enough to reconstruct the host layout.
    const alias = deriveProjectKey("/srv/tenant-a/checkout");
    expect(alias).toMatch(/^tenant-a-checkout-[a-z0-9]+$/);
    expect(deriveProjectKey("/srv/tenant-a/checkout")).toBe(alias);
    expect(deriveProjectKey("/srv/tenant-b/checkout")).not.toBe(alias);
  });

  it("strips characters that could break a log line", () => {
    expect(sanitizeAlias("my repo/../name\n")).toBe("my-repo-name");
    expect(sanitizeAlias("")).toBe("project");
    // A dot run must not survive: `..` in an alias reads as traversal downstream.
    expect(sanitizeAlias("..")).toBe("project");
    expect(sanitizeAlias("../etc")).toBe("etc");
    expect(sanitizeAlias("...hidden...")).toBe("hidden");
    expect(sanitizeAlias("codegraph.json")).toBe("codegraph-json");
  });

  it("never returns the raw path when an alias is known", () => {
    expect(redactPath("/srv/tenant-a/checkout", "checkout")).toBe("checkout");
    expect(redactPath("/srv/tenant-a/checkout")).not.toContain("/srv");
  });
});
