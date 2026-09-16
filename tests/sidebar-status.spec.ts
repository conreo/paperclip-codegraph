import { describe, expect, it } from "vitest";

import { sidebarStatus, type SidebarReadiness } from "../src/ui/sidebar-status.js";

function state(overrides: Partial<SidebarReadiness> = {}): SidebarReadiness {
  return {
    enabled: true,
    repository: { configured: true, indexed: true },
    ...overrides,
  };
}

describe("sidebarStatus — the nav entry's one decision", () => {
  it("is ready only when enabled and indexed", () => {
    const result = sidebarStatus(state());
    expect(result.state).toBe("ready");
    expect(result.ok).toBe(true);
    expect(result.note).toBeNull();
  });

  it("does not claim a problem before the data arrives", () => {
    // The load-bearing case: absence means allowed everywhere else in this
    // plugin, so an unknown readiness must not render as "switched off" — that
    // would flash a false problem on every page load.
    for (const value of [null, undefined]) {
      const result = sidebarStatus(value);
      expect(result.state).toBe("unknown");
      expect(result.ok).toBe(false);
      expect(result.note).toBeNull();
    }
  });

  it("says 'off' only when the config actually says off", () => {
    const result = sidebarStatus(state({ enabled: false }));
    expect(result.state).toBe("off");
    expect(result.ok).toBe(false);
    expect(result.note).toContain("Switched off");
  });

  it("distinguishes no repository from an unindexed one", () => {
    // Different fixes: one needs a project workspace, the other needs an index.
    const none = sidebarStatus(state({ repository: { configured: false, indexed: false } }));
    expect(none.state).toBe("no-repository");
    expect(none.note).toContain("No repository");

    const unindexed = sidebarStatus(state({ repository: { configured: true, indexed: false } }));
    expect(unindexed.state).toBe("unindexed");
    expect(unindexed.note).toBe("No index yet");
  });

  it("reports off ahead of any repository problem", () => {
    // With the feature off, "no index" is noise: nothing will be indexed until
    // it is switched on, so the entry names that cause instead.
    const result = sidebarStatus(
      state({ enabled: false, repository: { configured: false, indexed: false } }),
    );
    expect(result.state).toBe("off");
  });

  it("surfaces no inline note in the ready state", () => {
    // A nav column that carries a permanent note is noise; the point of ready
    // is that there is nothing to say.
    expect(sidebarStatus(state()).note).toBeNull();
    expect(sidebarStatus(state()).title).toContain("indexed");
  });

  it("always has a tooltip, including when ready", () => {
    const cases: Array<SidebarReadiness | null> = [
      null,
      state(),
      state({ enabled: false }),
      state({ repository: { configured: false, indexed: false } }),
      state({ repository: { configured: true, indexed: false } }),
    ];
    for (const value of cases) {
      expect(sidebarStatus(value).title.length).toBeGreaterThan(0);
    }
  });

  it("points at where the fix lives, not just at the problem", () => {
    // An operator reading "No index yet" in the nav needs to know the index
    // button is in Settings, not on this page.
    const unindexed = sidebarStatus(state({ repository: { configured: true, indexed: false } }));
    expect(unindexed.title).toContain("Settings");
  });

  it("is a pure function of readiness", () => {
    const input = state({ repository: { configured: true, indexed: false } });
    const first = sidebarStatus(input);
    const second = sidebarStatus(input);
    expect(second).toEqual(first);
    // And the input is not mutated.
    expect(input.repository.indexed).toBe(false);
  });
});
