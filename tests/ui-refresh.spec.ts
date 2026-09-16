import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

import { shouldRefreshOnVisibility } from "../src/ui/refresh-signal.js";

const UI_DIR = path.join(process.cwd(), "src", "ui");
const ADMIN = fs.readFileSync(path.join(UI_DIR, "admin.tsx"), "utf8");

describe("shouldRefreshOnVisibility", () => {
  it("re-reads when the tab becomes visible", () => {
    // The case that matters: an agent created in another tab should appear when
    // the operator comes back to this one.
    expect(shouldRefreshOnVisibility("visible")).toBe(true);
  });

  it("does not re-read when the tab is hidden", () => {
    // Going away is not a reason to spend a `git` process per project on an
    // answer nobody will see.
    expect(shouldRefreshOnVisibility("hidden")).toBe(false);
  });

  it("treats unknown states as no signal", () => {
    // An environment without `visibilityState` must not cause a refresh loop.
    expect(shouldRefreshOnVisibility(null)).toBe(false);
    expect(shouldRefreshOnVisibility(undefined)).toBe(false);
    expect(shouldRefreshOnVisibility("prerender")).toBe(false);
    expect(shouldRefreshOnVisibility("")).toBe(false);
  });
});

/**
 * Every `usePluginData(...)` call in the page, as source text.
 *
 * Split on the call and take up to the matching close paren, so nested braces
 * inside the type argument do not truncate the slice — a regex over braces reads
 * as if it works and silently matches the wrong span.
 */
function dataCalls(source: string): string[] {
  const calls: string[] = [];
  let index = source.indexOf("usePluginData");
  while (index !== -1) {
    const open = source.indexOf("(", index);
    if (open === -1) break;
    let depth = 0;
    let end = open;
    for (let i = open; i < source.length; i += 1) {
      const char = source[i];
      if (char === "(") depth += 1;
      else if (char === ")") {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    calls.push(source.slice(index, end + 1));
    index = source.indexOf("usePluginData", end);
  }
  return calls;
}

describe("the settings page re-reads after changes", () => {
  /**
   * Source-level checks for wiring types cannot verify: `revision` is a number
   * threaded into data parameters, so passing the wrong one — or dropping it —
   * still type-checks while leaving the page stale. That was the reported bug:
   * index state and the agent list changed only on a manual reload.
   */
  it("finds the data calls it is meant to be checking", () => {
    const calls = dataCalls(ADMIN);
    expect(calls.length).toBeGreaterThanOrEqual(5);
  });

  it("threads the refresh revision into every project-backed read", () => {
    // The page's overview read and the Repositories section read the same handler;
    // both must re-read together or Status and the list disagree on screen.
    const reads = dataCalls(ADMIN).filter((call) => call.includes("DATA_KEYS.graphProjects"));
    expect(reads.length).toBeGreaterThanOrEqual(2);
    for (const read of reads) {
      expect(read, `a graph-projects read is missing the revision:\n${read}`).toContain("revision");
    }
  });

  it("threads the revision into the agent reads", () => {
    // "What happened to new agents?" — the list is fetched once per mount, so a
    // newly created agent needs a reason to be re-read.
    const reads = dataCalls(ADMIN).filter(
      (call) => call.includes("DATA_KEYS.access") || call.includes("DATA_KEYS.agents"),
    );
    expect(reads.length).toBeGreaterThanOrEqual(2);
    for (const read of reads) {
      expect(read, `an agent read is missing the revision:\n${read}`).toContain("revision");
    }
  });

  it("threads it into the repositories read used for counts", () => {
    const reads = dataCalls(ADMIN).filter((call) => call.includes("DATA_KEYS.repositories"));
    expect(reads.length).toBeGreaterThanOrEqual(1);
    for (const read of reads) {
      expect(read, `the repositories read is missing the revision:\n${read}`).toContain("revision");
    }
  });

  it("re-reads after indexing, rather than telling the operator to reload", () => {
    expect(ADMIN).toContain("await indexNow(");
    const afterIndex = ADMIN.slice(ADMIN.indexOf("await indexNow(")).slice(0, 400);
    expect(afterIndex, "indexing does not refresh the counts it invalidates").toContain(
      "refresh()",
    );
    expect(afterIndex).toContain("onChanged()");
  });

  it("no longer tells the operator to reopen the page", () => {
    // The old copy was a workaround for not refreshing; keeping it would let the
    // staleness come back without anyone noticing.
    expect(ADMIN).not.toContain("Reopen this page to see it finish");
  });

  it("re-reads after an access change", () => {
    const afterAccess = ADMIN.slice(ADMIN.indexOf("await setAgentAccess(")).slice(0, 300);
    expect(afterAccess).toContain("refreshAccess()");
  });

  it("offers a manual refresh", () => {
    expect(ADMIN).toContain("useRefreshSignal()");
    expect(ADMIN).toMatch(/onClick=\{refresh\}/);
  });
});

describe("Status reports real repositories, not governance bindings", () => {
  it("does not derive the repository line from the readiness binding", () => {
    // The reported contradiction: "No repository yet" rendered directly above a
    // repository with 640 files and 12,085 nodes, because Status read the
    // governance *binding* while the list read the org's projects.
    expect(ADMIN).not.toContain("readiness.repository.indexed");
    expect(ADMIN).not.toContain("readiness.repository.configured");
  });

  it("counts repositories and indexed repositories for the status line", () => {
    expect(ADMIN).toContain("repositories.filter((repo) => repo.indexed).length");
    expect(ADMIN).toContain("const indexedCount");
  });

  it("says how many repositories are switched off", () => {
    expect(ADMIN).toContain("repo.blocked === true");
  });
});
