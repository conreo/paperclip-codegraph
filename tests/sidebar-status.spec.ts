import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

import { sidebarStatus, type SidebarFacts } from "../src/ui/sidebar-status.js";

function facts(overrides: Partial<SidebarFacts> = {}): SidebarFacts {
  return {
    enabled: true,
    repositories: [{ indexed: true }],
    ...overrides,
  };
}

describe("sidebarStatus — the nav entry's one decision", () => {
  it("is ready only when there is an indexed repository", () => {
    const result = sidebarStatus(facts());
    expect(result.state).toBe("ready");
    expect(result.ok).toBe(true);
    expect(result.note).toBeNull();
  });

  it("does not claim a problem before the data arrives", () => {
    // The load-bearing case: absence means allowed everywhere else in this
    // plugin, so unknown must not render as "off" or as a missing repository —
    // that would flash a false problem on every page load.
    for (const value of [null, undefined]) {
      const result = sidebarStatus(value);
      expect(result.state).toBe("unknown");
      expect(result.ok).toBe(false);
      expect(result.note).toBeNull();
    }
  });

  it("never says 'no repository' for an organisation that has one", () => {
    // The reported bug: the nav said "No repository in this company yet" while the
    // workspace was a git repository with a 640-file index, because it read the
    // governance *binding* rather than the org's actual projects.
    const result = sidebarStatus(facts({ repositories: [{ indexed: false }] }));
    expect(result.state).toBe("unindexed");
    expect(result.note).toBe("No index yet");
    expect(result.note).not.toContain("No repository");
  });

  it("says 'off' only when the config actually says off", () => {
    const result = sidebarStatus(facts({ enabled: false }));
    expect(result.state).toBe("off");
    expect(result.ok).toBe(false);
    expect(result.note).toContain("Switched off");
  });

  it("distinguishes no repository from all repositories switched off", () => {
    // Different fixes: one needs a project workspace, the other needs a switch
    // turned back on.
    const none = sidebarStatus(facts({ repositories: [] }));
    expect(none.state).toBe("no-repository");
    expect(none.note).toContain("No repository");

    const allOff = sidebarStatus(facts({ repositories: [{ indexed: true, blocked: true }] }));
    expect(allOff.state).toBe("off");
    expect(allOff.note).toContain("switched off");
  });

  it("is ready when at least one usable repository is indexed", () => {
    // One working repository is enough to be useful, so the nav does not nag
    // about the others.
    const result = sidebarStatus(
      facts({ repositories: [{ indexed: false }, { indexed: true }, { indexed: false }] }),
    );
    expect(result.state).toBe("ready");
    expect(result.ok).toBe(true);
    expect(result.title).toContain("1 of 3");
  });

  it("ignores switched-off repositories when counting", () => {
    // A deliberately switched-off repository must not be reported as unindexed.
    const result = sidebarStatus(
      facts({ repositories: [{ indexed: false, blocked: true }, { indexed: true }] }),
    );
    expect(result.state).toBe("ready");
    expect(result.title).toBe("Repository indexed");
  });

  it("reports off ahead of any repository problem", () => {
    const result = sidebarStatus(facts({ enabled: false, repositories: [] }));
    expect(result.state).toBe("off");
  });

  it("surfaces no inline note in the ready state", () => {
    expect(sidebarStatus(facts()).note).toBeNull();
  });

  it("always has a tooltip, including when ready", () => {
    const cases: Array<SidebarFacts | null> = [
      null,
      facts(),
      facts({ enabled: false }),
      facts({ repositories: [] }),
      facts({ repositories: [{ indexed: false }] }),
      facts({ repositories: [{ indexed: true, blocked: true }] }),
    ];
    for (const value of cases) {
      expect(sidebarStatus(value).title.length).toBeGreaterThan(0);
    }
  });

  it("points at where the fix lives, not just at the problem", () => {
    const unindexed = sidebarStatus(facts({ repositories: [{ indexed: false }] }));
    expect(unindexed.title).toContain("Settings");
  });

  it("is a pure function of the facts", () => {
    const input = facts({ repositories: [{ indexed: false }] });
    const first = sidebarStatus(input);
    const second = sidebarStatus(input);
    expect(second).toEqual(first);
    expect(input.repositories[0]!.indexed).toBe(false);
  });
});

describe("the sidebar reads the same source as the page", () => {
  const SIDEBAR = fs.readFileSync(
    path.join(process.cwd(), "src", "ui", "sidebar.tsx"),
    "utf8",
  );

  it("does not read the governance binding for its repository state", () => {
    // Source-level, because this is the defect: `readiness` reports the binding,
    // which is empty on an organisation that works.
    expect(SIDEBAR).not.toContain("DATA_KEYS.readiness");
  });

  it("reads graph-projects, the same handler the settings page uses", () => {
    expect(SIDEBAR).toContain("DATA_KEYS.graphProjects");
  });
});
