import { describe, expect, it } from "vitest";

import { setAgentAccess, setProjectAccess } from "../src/governance/merge.js";
import type { CompanyGovernance } from "../src/governance/types.js";

const PROJECT = "5ebdaf48-3f46-447f-b0f1-be65b0c6f189";
const OTHER_PROJECT = "3b2a1745-8025-4dab-bfc3-173ff24900d3";
const AGENT = "agent-1";

/** A company with a binding, an unrelated project override, and an agent policy. */
function populated(): CompanyGovernance {
  return {
    enabled: true,
    defaultProjectKey: "pos",
    projects: {
      pos: { projectKey: "pos", path: "/srv/pos" },
      spoon: { projectKey: "spoon", path: "/srv/spoon" },
    },
    projectsByPaperclipProject: {
      [OTHER_PROJECT]: { projectKey: "spoon" },
    },
    agents: {
      "agent-2": { policy: { deniedTools: ["codegraph_impact"] } },
    },
    policy: { allowedTools: ["codegraph_explore"] },
  };
}

describe("setProjectAccess — narrowing one repository", () => {
  it("disables a project without touching anything else", () => {
    const next = setProjectAccess(populated(), PROJECT, false);
    expect(next.projectsByPaperclipProject?.[PROJECT]).toEqual({ enabled: false });

    // Everything else is byte-for-byte what it was.
    expect(next.projects).toEqual(populated().projects);
    expect(next.agents).toEqual(populated().agents);
    expect(next.policy).toEqual(populated().policy);
    expect(next.defaultProjectKey).toBe("pos");
    expect(next.enabled).toBe(true);
  });

  it("leaves a sibling project's override alone", () => {
    const next = setProjectAccess(populated(), PROJECT, false);
    expect(next.projectsByPaperclipProject?.[OTHER_PROJECT]).toEqual({ projectKey: "spoon" });
  });

  it("removes the override entirely when re-enabled", () => {
    // Narrowing only: the absence of an override is the derived default, so
    // clearing one cannot grant anything the company binding does not allow.
    const disabled = setProjectAccess(populated(), PROJECT, false);
    const reenabled = setProjectAccess(disabled, PROJECT, true);
    expect(reenabled.projectsByPaperclipProject?.[PROJECT]).toBeUndefined();
    expect(Object.keys(reenabled.projectsByPaperclipProject ?? {})).toEqual([OTHER_PROJECT]);
  });

  it("keeps a projectKey or policy attached to the override when re-enabling", () => {
    // The override may be doing two jobs. Clearing the disable flag must not
    // throw away the other one.
    const current = populated();
    current.projectsByPaperclipProject = {
      ...current.projectsByPaperclipProject,
      [PROJECT]: {
        enabled: false,
        projectKey: "spoon",
        policy: { deniedTools: ["codegraph_files"] },
      },
    };

    const next = setProjectAccess(current, PROJECT, true);
    expect(next.projectsByPaperclipProject?.[PROJECT]).toEqual({
      projectKey: "spoon",
      policy: { deniedTools: ["codegraph_files"] },
    });
  });

  it("drops the whole entry when nothing else was on it", () => {
    const disabled = setProjectAccess(populated(), PROJECT, false);
    const reenabled = setProjectAccess(disabled, PROJECT, true);
    expect(
      Object.prototype.hasOwnProperty.call(
        reenabled.projectsByPaperclipProject ?? {},
        PROJECT,
      ),
    ).toBe(false);
  });

  it("never raises company.enabled", () => {
    // A repository switch cannot turn a company back on that an admin turned off.
    const off: CompanyGovernance = { ...populated(), enabled: false };
    expect(setProjectAccess(off, PROJECT, true).enabled).toBe(false);
    expect(setProjectAccess(off, PROJECT, false).enabled).toBe(false);
  });

  it("starts from an empty document without inventing a binding", () => {
    const next = setProjectAccess(null, PROJECT, false);
    expect(next.projects).toBeUndefined();
    expect(next.projectsByPaperclipProject?.[PROJECT]).toEqual({ enabled: false });
    // A company with no governance is NOT enabled by this call.
    expect(next.enabled).toBe(false);
  });

  it("does not mutate the document it was given", () => {
    const current = populated();
    const snapshot = JSON.parse(JSON.stringify(current));
    setProjectAccess(current, PROJECT, false);
    expect(current).toEqual(snapshot);
  });

  it("is idempotent", () => {
    const once = setProjectAccess(populated(), PROJECT, false);
    const twice = setProjectAccess(once, PROJECT, false);
    expect(twice).toEqual(once);
  });
});

describe("setAgentAccess — narrowing one agent", () => {
  it("disables an agent and preserves their narrowing policy", () => {
    const withPolicy: CompanyGovernance = {
      ...populated(),
      agents: { [AGENT]: { policy: { deniedTools: ["codegraph_impact"] } } },
    };
    const next = setAgentAccess(withPolicy, AGENT, false);
    expect(next.agents?.[AGENT]).toEqual({
      policy: { deniedTools: ["codegraph_impact"] },
      enabled: false,
    });
    expect(next.projects).toEqual(withPolicy.projects);
  });

  it("clears only the disable flag when re-enabled", () => {
    const disabled = setAgentAccess(
      { ...populated(), agents: { [AGENT]: { policy: { deniedTools: ["codegraph_files"] } } } },
      AGENT,
      false,
    );
    const reenabled = setAgentAccess(disabled, AGENT, true);
    expect(reenabled.agents?.[AGENT]).toEqual({ policy: { deniedTools: ["codegraph_files"] } });
  });

  it("leaves other agents untouched", () => {
    const next = setAgentAccess(populated(), AGENT, false);
    expect(next.agents?.["agent-2"]).toEqual({ policy: { deniedTools: ["codegraph_impact"] } });
  });

  it("starts from an empty document without enabling the company", () => {
    const next = setAgentAccess(null, AGENT, false);
    expect(next.enabled).toBe(false);
    expect(next.agents?.[AGENT]).toEqual({ enabled: false });
  });

  it("does not mutate the document it was given", () => {
    const current = populated();
    const snapshot = JSON.parse(JSON.stringify(current));
    setAgentAccess(current, AGENT, false);
    expect(current).toEqual(snapshot);
  });

  it("touches agents only, never projects", () => {
    const next = setAgentAccess(populated(), AGENT, false);
    expect(next.projectsByPaperclipProject).toEqual(
      populated().projectsByPaperclipProject,
    );
  });
});
