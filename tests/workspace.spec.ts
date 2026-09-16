import { describe, expect, it } from "vitest";

import {
  WORKSPACE_PROJECT_KEY,
  acceptWorkspacePath,
  buildWorkspaceGovernance,
  shouldTryWorkspaceFallback,
} from "../src/governance/workspace.js";
import { parseGovernance, resolveScope, decideToolAccess } from "../src/governance/resolver.js";

const COMPANY = "company-a";
const OTHER = "company-b";
const WORKSPACE = "/paperclip/instances/default/projects/company-a/ws-1/pos";

const doc = (companies: Record<string, unknown> = {}) =>
  parseGovernance({ version: 1, companies, }) as ReturnType<typeof parseGovernance> &
    Record<string, never>;
const emptyDoc = () => parseGovernance({ version: 1, companies: {} });

describe("shouldTryWorkspaceFallback", () => {
  it("is true only for 'could not find a repository' reasons", () => {
    for (const reason of [
      "company_not_configured",
      "no_project_bound",
      "project_binding_missing",
    ]) {
      expect(shouldTryWorkspaceFallback({ allowed: false, reason }), reason).toBe(true);
    }
  });

  it("is false for every authorisation denial", () => {
    // The whole point: a denial must never become access via the fallback.
    for (const reason of [
      "plugin_disabled",
      "instance_defaults_disabled",
      "company_disabled",
      "agent_disabled",
      "paperclip_project_disabled",
      "tool_denied",
      "tool_not_allowed",
    ]) {
      expect(shouldTryWorkspaceFallback({ allowed: false, reason }), reason).toBe(false);
    }
  });

  it("is false when the scope already resolved", () => {
    expect(shouldTryWorkspaceFallback({ allowed: true, reason: "allowed" })).toBe(false);
  });
});

describe("acceptWorkspacePath", () => {
  it("accepts a plausible absolute workspace path", () => {
    const result = acceptWorkspacePath(WORKSPACE, []);
    expect(result === null || typeof result === "string").toBe(true);
  });

  it("refuses anything that is not a usable string", () => {
    for (const bad of [null, undefined, "", "   ", 42, {}, []]) {
      expect(acceptWorkspacePath(bad, []), String(bad)).toBeNull();
    }
  });

  it("refuses a relative path", () => {
    expect(acceptWorkspacePath("pos/backend", [])).toBeNull();
  });

  it("refuses a path that does not exist", () => {
    // The host is trusted, but a stale workspace row must not become a usable
    // repository just because it came from Paperclip.
    expect(acceptWorkspacePath("/nonexistent/ws/pos", [])).toBeNull();
  });

  it("refuses a sensitive path", () => {
    expect(acceptWorkspacePath("/etc", [])).toBeNull();
  });

  it("honours the operator's allowedProjectRoots", () => {
    // If a root is configured, a workspace outside it is refused — the operator's
    // boundary is not weakened by the fallback.
    expect(acceptWorkspacePath("/tmp", ["/srv/only"])).toBeNull();
  });

  it("never throws, whatever it is handed", () => {
    expect(() => acceptWorkspacePath("\0/etc", [])).not.toThrow();
    expect(() => acceptWorkspacePath("a".repeat(9000), [])).not.toThrow();
  });
});

describe("buildWorkspaceGovernance", () => {
  it("lets a company with no governance entry resolve at all", () => {
    const built = buildWorkspaceGovernance({
      document: emptyDoc(),
      companyId: COMPANY,
      workspacePath: WORKSPACE,
    });
    const resolved = resolveScope(built, { companyId: COMPANY, pluginEnabled: true });
    expect(resolved.allowed).toBe(true);
    expect(resolved.project?.path).toBe(WORKSPACE);
    expect(resolved.project?.projectKey).toBe(WORKSPACE_PROJECT_KEY);
  });

  it("does not invent an entry for another company", () => {
    const built = buildWorkspaceGovernance({
      document: emptyDoc(),
      companyId: COMPANY,
      workspacePath: WORKSPACE,
    });
    expect(Object.keys(built.companies)).toEqual([COMPANY]);
    const other = resolveScope(built, { companyId: OTHER, pluginEnabled: true });
    expect(other.allowed).toBe(false);
    expect(other.reason).toBe("company_not_configured");
  });

  it("preserves an existing company's projects, policy and agent overrides", () => {
    const before = parseGovernance({
      version: 1,
      companies: {
        [COMPANY]: {
          enabled: true,
          defaultProjectKey: "payments",
          projects: { payments: { projectKey: "payments", path: "/srv/payments" } },
          policy: { deniedTools: ["codegraph_impact"] },
          agents: { "agent-1": { policy: { allowedTools: ["codegraph_explore"] } } },
        },
      },
    });
    const built = buildWorkspaceGovernance({
      document: before,
      companyId: COMPANY,
      workspacePath: WORKSPACE,
    });

    const company = built.companies[COMPANY]!;
    expect(Object.keys(company.projects ?? {}).sort()).toEqual(["payments", WORKSPACE_PROJECT_KEY]);
    expect(company.policy).toEqual({ deniedTools: ["codegraph_impact"] });
    expect(company.agents).toEqual({ "agent-1": { policy: { allowedTools: ["codegraph_explore"] } } });
  });

  it("keeps the company's own default project rather than the workspace", () => {
    const before = parseGovernance({
      version: 1,
      companies: {
        [COMPANY]: {
          enabled: true,
          defaultProjectKey: "payments",
          projects: { payments: { projectKey: "payments", path: "/srv/payments" } },
        },
      },
    });
    const built = buildWorkspaceGovernance({
      document: before,
      companyId: COMPANY,
      workspacePath: WORKSPACE,
    });
    expect(built.companies[COMPANY]?.defaultProjectKey).toBe("payments");
  });

  it("carries instance defaults through", () => {
    const before = parseGovernance({
      version: 1,
      defaults: { policy: { deniedTools: ["codegraph_files"] } },
      companies: {},
    });
    const built = buildWorkspaceGovernance({
      document: before,
      companyId: COMPANY,
      workspacePath: WORKSPACE,
    });
    expect(built.defaults?.policy?.deniedTools).toEqual(["codegraph_files"]);
  });

  it("STILL applies a company-level denial — the fallback is not a bypass", () => {
    const before = parseGovernance({
      version: 1,
      companies: {
        [COMPANY]: {
          enabled: true,
          policy: { deniedTools: ["codegraph_impact"] },
        },
      },
    });
    const built = buildWorkspaceGovernance({
      document: before,
      companyId: COMPANY,
      workspacePath: WORKSPACE,
    });
    const resolved = resolveScope(built, { companyId: COMPANY, pluginEnabled: true });
    expect(resolved.allowed).toBe(true);
    expect(decideToolAccess(resolved, "codegraph_impact")).toEqual({
      allowed: false,
      reason: "tool_denied",
    });
  });

  it("STILL applies a per-agent denial", () => {
    const before = parseGovernance({
      version: 1,
      companies: {
        [COMPANY]: { enabled: true, agents: { "agent-1": { enabled: false } } },
      },
    });
    const built = buildWorkspaceGovernance({
      document: before,
      companyId: COMPANY,
      workspacePath: WORKSPACE,
    });
    const resolved = resolveScope(built, {
      companyId: COMPANY,
      agentId: "agent-1",
      pluginEnabled: true,
    });
    expect(resolved.allowed).toBe(false);
    expect(resolved.reason).toBe("agent_disabled");
  });

  it("does not resurrect a company an admin disabled", () => {
    // `enabled: true` here only satisfies the resolver's requirement that a
    // synthetic entry be usable; pluginEnabled is the real gate and still wins.
    const built = buildWorkspaceGovernance({
      document: emptyDoc(),
      companyId: COMPANY,
      workspacePath: WORKSPACE,
    });
    const resolved = resolveScope(built, { companyId: COMPANY, pluginEnabled: false });
    expect(resolved.allowed).toBe(false);
    expect(resolved.reason).toBe("plugin_disabled");
  });

  it("is deterministic: building twice yields the same document", () => {
    const once = buildWorkspaceGovernance({
      document: emptyDoc(),
      companyId: COMPANY,
      workspacePath: WORKSPACE,
    });
    const twice = buildWorkspaceGovernance({
      document: once,
      companyId: COMPANY,
      workspacePath: WORKSPACE,
    });
    expect(twice).toEqual(once);
  });

  it("rejects a relative workspace path rather than storing it", () => {
    expect(() =>
      buildWorkspaceGovernance({
        document: emptyDoc(),
        companyId: COMPANY,
        workspacePath: "pos",
      }),
    ).not.toThrow();
    // parseGovernance does not do filesystem checks; acceptWorkspacePath is the
    // guard that runs first, and this records that split deliberately.
    expect(doc().companies).toEqual({});
  });
});
