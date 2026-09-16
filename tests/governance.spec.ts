import { describe, expect, it } from "vitest";

import {
  decideToolAccess,
  matchesToolPattern,
  parseGovernance,
  resolveScope,
  visibleTools,
  GovernanceValidationError,
} from "../src/governance/resolver.js";
import { CODEGRAPH_TOOLS } from "../src/constants.js";
import type { GovernanceDocument } from "../src/governance/types.js";

const COMPANY_A = "company-a-uuid";
const COMPANY_B = "company-b-uuid";

function doc(companies: Record<string, unknown>): GovernanceDocument {
  return parseGovernance({ version: 1, companies });
}

const COMPANY_A_DOC = doc({
  [COMPANY_A]: {
    enabled: true,
    defaultProjectKey: "web",
    projects: {
      web: { projectKey: "web", path: "/srv/company-a/web" },
    },
  },
  [COMPANY_B]: {
    enabled: true,
    defaultProjectKey: "api",
    projects: {
      api: { projectKey: "api", path: "/srv/company-b/api" },
    },
  },
});

describe("tool pattern matching", () => {
  it("matches exact names", () => {
    expect(matchesToolPattern("codegraph_explore", "codegraph_explore")).toBe(true);
    expect(matchesToolPattern("codegraph_explore", "codegraph_search")).toBe(false);
  });

  it("supports * globs", () => {
    expect(matchesToolPattern("codegraph_*", "codegraph_impact")).toBe(true);
    expect(matchesToolPattern("*", "anything")).toBe(true);
    expect(matchesToolPattern("codegraph_c*", "codegraph_callees")).toBe(true);
    expect(matchesToolPattern("codegraph_c*", "codegraph_node")).toBe(false);
  });

  it("does not treat regex metacharacters as patterns", () => {
    expect(matchesToolPattern("a.b", "axb")).toBe(false);
    expect(matchesToolPattern("a.b", "a.b")).toBe(true);
  });
});

describe("resolveScope — multi-organization isolation", () => {
  it("resolves each company to its own bound project", () => {
    const a = resolveScope(COMPANY_A_DOC, {
      companyId: COMPANY_A,
      pluginEnabled: true,
    });
    const b = resolveScope(COMPANY_A_DOC, {
      companyId: COMPANY_B,
      pluginEnabled: true,
    });

    expect(a.allowed).toBe(true);
    expect(a.project?.path).toBe("/srv/company-a/web");
    expect(b.allowed).toBe(true);
    expect(b.project?.path).toBe("/srv/company-b/api");
  });

  it("denies a company that has no governance entry rather than falling back", () => {
    const resolved = resolveScope(COMPANY_A_DOC, {
      companyId: "company-c-unknown",
      pluginEnabled: true,
    });
    expect(resolved.allowed).toBe(false);
    expect(resolved.reason).toBe("company_not_configured");
    expect(resolved.project).toBeUndefined();
  });

  it("ignores a forged project/agent id from another company", () => {
    // Company A's agent claiming Company B's project id and a B-ish agent id
    // must still resolve inside Company A's own bindings.
    const resolved = resolveScope(COMPANY_A_DOC, {
      companyId: COMPANY_A,
      paperclipProjectId: "project-owned-by-b",
      agentId: "agent-owned-by-b",
      pluginEnabled: true,
    });
    expect(resolved.project?.path).toBe("/srv/company-a/web");
  });

  it("cannot name a project the company has not bound", () => {
    const withOverride = doc({
      [COMPANY_A]: {
        enabled: true,
        defaultProjectKey: "web",
        projects: { web: { projectKey: "web", path: "/srv/company-a/web" } },
        agents: { "agent-1": { projectKey: "secret-project" } },
      },
    });
    const resolved = resolveScope(withOverride, {
      companyId: COMPANY_A,
      agentId: "agent-1",
      pluginEnabled: true,
    });
    expect(resolved.allowed).toBe(false);
    expect(resolved.reason).toBe("project_binding_missing");
  });
});

describe("resolveScope — enablement gates", () => {
  it("denies everything while the plugin is disabled", () => {
    const resolved = resolveScope(COMPANY_A_DOC, {
      companyId: COMPANY_A,
      pluginEnabled: false,
    });
    expect(resolved.allowed).toBe(false);
    expect(resolved.reason).toBe("plugin_disabled");
  });

  it("honours instance-default disablement", () => {
    const withDefaults = parseGovernance({
      version: 1,
      defaults: { enabled: false },
      companies: {
        [COMPANY_A]: {
          enabled: true,
          defaultProjectKey: "web",
          projects: { web: { projectKey: "web", path: "/srv/a" } },
        },
      },
    });
    const resolved = resolveScope(withDefaults, {
      companyId: COMPANY_A,
      pluginEnabled: true,
    });
    expect(resolved.reason).toBe("instance_defaults_disabled");
  });

  it("denies a disabled company", () => {
    const withDisabled = doc({
      [COMPANY_A]: {
        enabled: false,
        defaultProjectKey: "web",
        projects: { web: { projectKey: "web", path: "/srv/a" } },
      },
    });
    expect(
      resolveScope(withDisabled, { companyId: COMPANY_A, pluginEnabled: true }).reason,
    ).toBe("company_disabled");
  });

  it("denies a disabled agent inside an enabled company", () => {
    const withAgent = doc({
      [COMPANY_A]: {
        enabled: true,
        defaultProjectKey: "web",
        projects: { web: { projectKey: "web", path: "/srv/a" } },
        agents: { "agent-off": { enabled: false } },
      },
    });
    expect(
      resolveScope(withAgent, {
        companyId: COMPANY_A,
        agentId: "agent-off",
        pluginEnabled: true,
      }).reason,
    ).toBe("agent_disabled");
    // A sibling agent is unaffected.
    expect(
      resolveScope(withAgent, {
        companyId: COMPANY_A,
        agentId: "agent-on",
        pluginEnabled: true,
      }).allowed,
    ).toBe(true);
  });

  it("denies when no project is bound at all", () => {
    const noDefault = doc({ [COMPANY_A]: { enabled: true } });
    expect(
      resolveScope(noDefault, { companyId: COMPANY_A, pluginEnabled: true }).reason,
    ).toBe("no_project_bound");
  });
});

describe("resolveScope — narrowing-only tool algebra", () => {
  it("treats an absent allow list as 'all not denied'", () => {
    const resolved = resolveScope(COMPANY_A_DOC, {
      companyId: COMPANY_A,
      pluginEnabled: true,
    });
    expect(resolved.allowedTools).toEqual([...CODEGRAPH_TOOLS]);
    expect(resolved.deniedTools).toEqual([]);
  });

  it("lets any scope deny, and no narrower scope un-deny", () => {
    const withDeny = doc({
      [COMPANY_A]: {
        enabled: true,
        defaultProjectKey: "web",
        policy: { deniedTools: ["codegraph_impact"] },
        projects: { web: { projectKey: "web", path: "/srv/a" } },
        agents: {
          // An agent trying to re-grant the denied tool cannot win.
          "agent-1": { policy: { allowedTools: ["codegraph_impact", "codegraph_explore"] } },
        },
      },
    });
    const resolved = resolveScope(withDeny, {
      companyId: COMPANY_A,
      agentId: "agent-1",
      pluginEnabled: true,
    });
    expect(resolved.deniedTools).toContain("codegraph_impact");
    expect(visibleTools(resolved)).not.toContain("codegraph_impact");
  });

  it("intersects allow lists across scopes", () => {
    const withAllows = doc({
      [COMPANY_A]: {
        enabled: true,
        defaultProjectKey: "web",
        policy: { allowedTools: ["codegraph_explore", "codegraph_search", "codegraph_node"] },
        projects: { web: { projectKey: "web", path: "/srv/a" } },
        agents: {
          "agent-1": { policy: { allowedTools: ["codegraph_explore", "codegraph_node"] } },
        },
      },
    });
    const resolved = resolveScope(withAllows, {
      companyId: COMPANY_A,
      agentId: "agent-1",
      pluginEnabled: true,
    });
    expect(resolved.allowedTools).toEqual(["codegraph_explore", "codegraph_node"]);
  });

  it("treats an explicit empty allow list as deny-all", () => {
    const denyAll = doc({
      [COMPANY_A]: {
        enabled: true,
        defaultProjectKey: "web",
        projects: { web: { projectKey: "web", path: "/srv/a" } },
        agents: { "agent-1": { policy: { allowedTools: [] } } },
      },
    });
    const resolved = resolveScope(denyAll, {
      companyId: COMPANY_A,
      agentId: "agent-1",
      pluginEnabled: true,
    });
    // Scope is permitted, but no individual tool is.
    expect(resolved.allowed).toBe(true);
    expect(resolved.allowedTools).toEqual([]);
    expect(visibleTools(resolved)).toEqual([]);
  });

  it("applies the project binding's own policy", () => {
    const bindingPolicy = doc({
      [COMPANY_A]: {
        enabled: true,
        defaultProjectKey: "web",
        projects: {
          web: {
            projectKey: "web",
            path: "/srv/a",
            policy: { deniedTools: ["codegraph_files"] },
          },
        },
      },
    });
    const resolved = resolveScope(bindingPolicy, {
      companyId: COMPANY_A,
      pluginEnabled: true,
    });
    expect(decideToolAccess(resolved, "codegraph_files").allowed).toBe(false);
    expect(decideToolAccess(resolved, "codegraph_explore").allowed).toBe(true);
  });

  it("records which scopes contributed, most broad to most narrow", () => {
    const multi = parseGovernance({
      version: 1,
      defaults: { policy: { deniedTools: ["codegraph_files"] } },
      companies: {
        [COMPANY_A]: {
          enabled: true,
          defaultProjectKey: "web",
          policy: { deniedTools: ["codegraph_status"] },
          projects: { web: { projectKey: "web", path: "/srv/a" } },
          agents: { "agent-1": { policy: { allowedTools: ["codegraph_explore"] } } },
        },
      },
    });
    const resolved = resolveScope(multi, {
      companyId: COMPANY_A,
      agentId: "agent-1",
      pluginEnabled: true,
    });
    expect(resolved.trace.appliedScopes).toEqual([
      "instance_defaults",
      "company",
      "agent",
    ]);
    expect(resolved.deniedTools).toEqual(
      expect.arrayContaining(["codegraph_files", "codegraph_status"]),
    );
  });
});

describe("decideToolAccess", () => {
  it("denies a tool that is both allowed and denied (deny wins)", () => {
    const resolved = resolveScope(COMPANY_A_DOC, {
      companyId: COMPANY_A,
      pluginEnabled: true,
      allTools: ["codegraph_explore"],
    });
    const forced = {
      ...resolved,
      allowedTools: ["codegraph_explore"],
      deniedTools: ["codegraph_explore"],
    };
    expect(decideToolAccess(forced, "codegraph_explore")).toEqual({
      allowed: false,
      reason: "tool_denied",
    });
  });

  it("reports the scope denial reason when the scope is denied", () => {
    const denied = resolveScope(COMPANY_A_DOC, {
      companyId: "unknown",
      pluginEnabled: true,
    });
    expect(decideToolAccess(denied, "codegraph_explore")).toEqual({
      allowed: false,
      reason: "company_not_configured",
    });
  });

  it("denies an allowed-scope tool missing from the allow list", () => {
    const resolved = resolveScope(COMPANY_A_DOC, {
      companyId: COMPANY_A,
      pluginEnabled: true,
      allTools: ["codegraph_explore"],
    });
    expect(decideToolAccess(resolved, "codegraph_files")).toEqual({
      allowed: false,
      reason: "tool_not_allowed",
    });
  });
});

describe("governance document validation", () => {
  it("rejects unknown top-level keys", () => {
    expect(() =>
      parseGovernance({
        version: 1,
        companies: {
          [COMPANY_A]: { enabled: true, projectz: {} },
        },
      }),
    ).toThrow(GovernanceValidationError);
  });

  it("requires companies[].enabled", () => {
    expect(() =>
      parseGovernance({ version: 1, companies: { [COMPANY_A]: {} } }),
    ).toThrow(/enabled is required/);
  });

  it("rejects a binding whose key disagrees with its projectKey", () => {
    expect(() =>
      parseGovernance({
        version: 1,
        companies: {
          [COMPANY_A]: {
            enabled: true,
            projects: { web: { projectKey: "other", path: "/srv/a" } },
          },
        },
      }),
    ).toThrow(/stored under key/);
  });

  it("rejects an unsupported version", () => {
    expect(() => parseGovernance({ version: 99 })).toThrow(/unsupported version/);
  });

  it("reports the offending path in the message", () => {
    try {
      parseGovernance({
        version: 1,
        companies: { [COMPANY_A]: { enabled: true, policy: { allowedTools: "nope" } } },
      });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as GovernanceValidationError).path).toBe(
        `$.companies.${COMPANY_A}.policy.allowedTools`,
      );
    }
  });

  it("treats a null document as empty rather than throwing", () => {
    expect(parseGovernance(null)).toEqual({ version: 1, companies: {} });
  });
});
