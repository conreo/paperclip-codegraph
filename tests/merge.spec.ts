import { describe, expect, it } from "vitest";

import { mergeGovernance, type GovernanceFormState } from "../src/governance/merge.js";
import type { CompanyGovernance } from "../src/governance/types.js";
import { CODEGRAPH_TOOLS } from "../src/constants.js";
import liveDocument from "./fixtures/live-governance.json" with { type: "json" };

const TOOLS = [...CODEGRAPH_TOOLS];

/**
 * A company that has already been configured by an admin: two repositories, a
 * tool denial, a Paperclip-project override, and an agent override that the
 * settings form does not know about.
 *
 * This is the shape the first version of the page destroyed on save.
 */
function seededCompany(): CompanyGovernance {
  return {
    enabled: true,
    defaultProjectKey: "payments",
    projects: {
      payments: {
        projectKey: "payments",
        path: "/srv/acme/payments",
        displayName: "Payments",
        policy: { deniedTools: ["codegraph_files"] },
      },
      identity: { projectKey: "identity", path: "/srv/acme/identity" },
    },
    projectsByPaperclipProject: {
      "proj-identity": { projectKey: "identity" },
      "proj-gone": { projectKey: "retired" },
    },
    agents: {
      "agent-narrowed": { policy: { allowedTools: ["codegraph_explore"] } },
      "agent-off": { enabled: false },
      "agent-from-automation": { projectKey: "identity" },
    },
    policy: { allowedTools: ["codegraph_explore", "codegraph_search"], deniedTools: ["codegraph_impact"] },
  };
}

function form(overrides: Partial<GovernanceFormState> = {}): GovernanceFormState {
  return {
    repositories: [{ key: "payments", path: "payments" }],
    removedRepositoryKeys: [],
    grantedAgentIds: [],
    listedAgentIds: [],
    ...overrides,
  };
}

const options = { defaultAllowedTools: TOOLS };

describe("mergeGovernance — the destructive-save regression", () => {
  it("never clears a configured denial", () => {
    // The original bug: the page sent `deniedTools: []`, silently widening
    // access. A denial is not the settings page's to remove.
    const merged = mergeGovernance(seededCompany(), form(), options);
    expect(merged.policy?.deniedTools).toEqual(["codegraph_impact"]);
  });

  it("never widens the company allow list", () => {
    const merged = mergeGovernance(seededCompany(), form(), options);
    expect(merged.policy?.allowedTools).toEqual([
      "codegraph_explore",
      "codegraph_search",
    ]);
  });

  it("preserves the binding when the form only touches one repository", () => {
    const merged = mergeGovernance(seededCompany(), form(), options);
    expect(Object.keys(merged.projects ?? {}).sort()).toEqual(["identity", "payments"]);
    expect(merged.projects?.["identity"]?.path).toBe("/srv/acme/identity");
  });

  it("preserves a per-repository policy when the path is unchanged", () => {
    const merged = mergeGovernance(seededCompany(), form(), options);
    expect(merged.projects?.["payments"]?.policy?.deniedTools).toEqual(["codegraph_files"]);
    expect(merged.projects?.["payments"]?.displayName).toBe("Payments");
  });

  it("preserves an agent override the form never listed", () => {
    const merged = mergeGovernance(seededCompany(), form(), options);
    expect(merged.agents?.["agent-from-automation"]).toEqual({ projectKey: "identity" });
    expect(merged.agents?.["agent-narrowed"]).toEqual({
      policy: { allowedTools: ["codegraph_explore"] },
    });
    expect(merged.agents?.["agent-off"]).toEqual({ enabled: false });
  });

  it("drops Paperclip-project overrides only when their repository is gone", () => {
    const merged = mergeGovernance(seededCompany(), form(), options);
    expect(Object.keys(merged.projectsByPaperclipProject ?? {})).toEqual(["proj-identity"]);
  });

  it("is idempotent: saving twice changes nothing the second time", () => {
    const once = mergeGovernance(seededCompany(), form(), options);
    const twice = mergeGovernance(once, form(), options);
    expect(twice).toEqual(once);
  });
});

describe("mergeGovernance — explicit edits still work", () => {
  it("adds a repository", () => {
    const merged = mergeGovernance(
      seededCompany(),
      form({
        repositories: [
          { key: "payments", path: "payments" },
          { key: "checkout", path: "services/checkout" },
        ],
      }),
      options,
    );
    expect(Object.keys(merged.projects ?? {}).sort()).toEqual([
      "checkout",
      "identity",
      "payments",
    ]);
    expect(merged.projects?.["checkout"]?.path).toBe("services/checkout");
  });

  it("removes a repository only when it was explicitly removed", () => {
    const merged = mergeGovernance(
      seededCompany(),
      form({ removedRepositoryKeys: ["identity"] }),
      options,
    );
    expect(Object.keys(merged.projects ?? {})).toEqual(["payments"]);
    expect(merged.projectsByPaperclipProject?.["proj-identity"]).toBeUndefined();
  });

  it("re-paths an existing repository without losing its policy", () => {
    const merged = mergeGovernance(
      seededCompany(),
      form({ repositories: [{ key: "payments", path: "/srv/acme/payments-v2" }] }),
      options,
    );
    expect(merged.projects?.["payments"]?.path).toBe("/srv/acme/payments-v2");
    expect(merged.projects?.["payments"]?.policy?.deniedTools).toEqual(["codegraph_files"]);
  });

  it("keeps the current default project while it is still bound", () => {
    const merged = mergeGovernance(
      seededCompany(),
      form({ repositories: [{ key: "identity", path: "identity" }] }),
      options,
    );
    expect(merged.defaultProjectKey).toBe("payments");
  });

  it("moves the default to the first row when the old default was removed", () => {
    const merged = mergeGovernance(
      seededCompany(),
      form({
        repositories: [{ key: "identity", path: "identity" }],
        removedRepositoryKeys: ["payments"],
      }),
      options,
    );
    expect(merged.defaultProjectKey).toBe("identity");
  });

  it("ignores a blank repository row", () => {
    const merged = mergeGovernance(
      seededCompany(),
      form({ repositories: [{ key: "  ", path: "  " }] }),
      options,
    );
    expect(Object.keys(merged.projects ?? {}).sort()).toEqual(["identity", "payments"]);
  });

  it("falls back to the key when a row has no path", () => {
    const merged = mergeGovernance(
      null,
      form({ repositories: [{ key: "pos", path: "" }] }),
      options,
    );
    expect(merged.projects?.["pos"]?.path).toBe("pos");
  });

  it("de-duplicates rows by key, last path winning", () => {
    const merged = mergeGovernance(
      null,
      form({
        repositories: [
          { key: "pos", path: "first" },
          { key: "pos", path: "second" },
        ],
      }),
      options,
    );
    expect(Object.keys(merged.projects ?? {})).toEqual(["pos"]);
    expect(merged.projects?.["pos"]?.path).toBe("second");
  });
});

describe("mergeGovernance — agent grants", () => {
  it("unticking an agent disables it but keeps its narrowing policy", () => {
    const merged = mergeGovernance(
      seededCompany(),
      form({ listedAgentIds: ["agent-narrowed"], grantedAgentIds: [] }),
      options,
    );
    expect(merged.agents?.["agent-narrowed"]).toEqual({
      policy: { allowedTools: ["codegraph_explore"] },
      enabled: false,
    });
  });

  it("ticking a disabled agent clears the flag without a dead empty override", () => {
    const merged = mergeGovernance(
      seededCompany(),
      form({ listedAgentIds: ["agent-off"], grantedAgentIds: ["agent-off"] }),
      options,
    );
    expect(merged.agents?.["agent-off"]).toBeUndefined();
  });

  it("ticking an agent keeps any narrowing it already had", () => {
    const merged = mergeGovernance(
      seededCompany(),
      form({ listedAgentIds: ["agent-narrowed"], grantedAgentIds: ["agent-narrowed"] }),
      options,
    );
    expect(merged.agents?.["agent-narrowed"]).toEqual({
      policy: { allowedTools: ["codegraph_explore"] },
    });
  });

  it("leaves agents not listed by the form alone", () => {
    const merged = mergeGovernance(
      seededCompany(),
      form({ listedAgentIds: ["agent-off"], grantedAgentIds: [] }),
      options,
    );
    expect(merged.agents?.["agent-from-automation"]).toEqual({ projectKey: "identity" });
  });
});

describe("mergeGovernance — fresh company", () => {
  it("seeds the allow list and enables, since the page is an explicit opt-in", () => {
    const merged = mergeGovernance(
      null,
      form({ repositories: [{ key: "pos", path: "pos" }] }),
      options,
    );
    expect(merged.enabled).toBe(true);
    expect(merged.policy?.allowedTools).toEqual(TOOLS);
    expect(merged.policy?.deniedTools).toBeUndefined();
    expect(merged.defaultProjectKey).toBe("pos");
  });

  it("never re-enables a company an admin disabled", () => {
    const merged = mergeGovernance({ enabled: false }, form(), options);
    expect(merged.enabled).toBe(false);
  });

  it("produces no projects key when nothing is bound", () => {
    const merged = mergeGovernance(null, form({ repositories: [] }), options);
    expect(merged.projects).toBeUndefined();
    expect(merged.defaultProjectKey).toBeNull();
  });
});

/**
 * The same regression, against a document captured from a real instance rather
 * than one I wrote to suit the test. The fixture is a company that had a tool
 * denial and an agent override configured before the settings page was ever
 * opened — the exact situation the first version silently corrupted.
 */
describe("mergeGovernance — against a captured live document", () => {
  const live = liveDocument as CompanyGovernance;

  it("is a document that had something to lose", () => {
    // Guard against the fixture being replaced by an empty one, which would
    // make every assertion below vacuously true.
    expect(Object.keys(live.projects ?? {}).length).toBeGreaterThan(0);
    expect(JSON.stringify(live.policy ?? {}).length).toBeGreaterThan(2);
  });

  it("preserves the live denial and every agent override when the form only saves a repository", () => {
    const merged = mergeGovernance(
      live,
      {
        repositories: Object.values(live.projects ?? {}).map((binding) => ({
          key: binding.projectKey,
          path: binding.path,
        })),
        removedRepositoryKeys: [],
        grantedAgentIds: Object.keys(live.agents ?? {}),
        listedAgentIds: Object.keys(live.agents ?? {}),
      },
      options,
    );

    expect(merged.policy).toEqual(live.policy);
    expect(Object.keys(merged.projects ?? {}).sort()).toEqual(
      Object.keys(live.projects ?? {}).sort(),
    );
    expect(merged.projects?.["payments"]?.path).toBe(live.projects?.["payments"]?.path);
  });
});
