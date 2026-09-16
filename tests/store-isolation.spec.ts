import { describe, expect, it } from "vitest";

import { GovernanceStore, type StateClient } from "../src/governance/store.js";
import { resolveScope } from "../src/governance/resolver.js";
import { STATE_NAMESPACE } from "../src/constants.js";

/**
 * An in-memory stand-in for `ctx.state` that mirrors the host's composite key,
 * so the test exercises the same partitioning the real host uses.
 */
function createFakeState() {
  const rows = new Map<string, unknown>();
  const keyOf = (input: {
    scopeKind: string;
    scopeId?: string;
    namespace?: string;
    stateKey: string;
  }) =>
    [input.scopeKind, input.scopeId ?? "", input.namespace ?? "default", input.stateKey].join(
      "::",
    );

  const state: StateClient = {
    async get(input) {
      return rows.get(keyOf(input)) ?? null;
    },
    async set(input, value) {
      rows.set(keyOf(input), structuredClone(value));
    },
    async delete(input) {
      rows.delete(keyOf(input));
    },
  };

  return { state, rows };
}

const COMPANY_A = "11111111-1111-1111-1111-111111111111";
const COMPANY_B = "22222222-2222-2222-2222-222222222222";

describe("GovernanceStore partitioning", () => {
  it("round-trips a company's governance", async () => {
    const { state } = createFakeState();
    const store = new GovernanceStore(state);

    await store.setCompany(COMPANY_A, {
      enabled: true,
      defaultProjectKey: "web",
      projects: { web: { projectKey: "web", path: "/srv/company-a/web" } },
    });

    const loaded = await store.getCompany(COMPANY_A);
    expect(loaded?.projects?.["web"]?.path).toBe("/srv/company-a/web");
  });

  it("writes company data under the company's own state scope", async () => {
    const { state, rows } = createFakeState();
    await new GovernanceStore(state).setCompany(COMPANY_A, {
      enabled: true,
      projects: {},
    });
    const keys = [...rows.keys()];
    expect(keys.some((key) => key.startsWith(`company::${COMPANY_A}::${STATE_NAMESPACE}`))).toBe(
      true,
    );
  });

  it("returns null for a company that was never configured", async () => {
    const { state } = createFakeState();
    expect(await new GovernanceStore(state).getCompany(COMPANY_B)).toBeNull();
  });

  it("keeps each company's document independent", async () => {
    const { state } = createFakeState();
    const store = new GovernanceStore(state);

    await store.setCompany(COMPANY_A, {
      enabled: true,
      defaultProjectKey: "web",
      projects: { web: { projectKey: "web", path: "/srv/a/web" } },
    });
    await store.setCompany(COMPANY_B, {
      enabled: true,
      defaultProjectKey: "api",
      projects: { api: { projectKey: "api", path: "/srv/b/api" } },
    });

    expect((await store.getCompany(COMPANY_A))?.projects?.["web"]?.path).toBe("/srv/a/web");
    expect((await store.getCompany(COMPANY_B))?.projects?.["api"]?.path).toBe("/srv/b/api");
  });

  it("deleting one company leaves the other intact", async () => {
    const { state } = createFakeState();
    const store = new GovernanceStore(state);
    await store.setCompany(COMPANY_A, { enabled: true, projects: {} });
    await store.setCompany(COMPANY_B, { enabled: true, projects: {} });

    await store.deleteCompany(COMPANY_A);

    expect(await store.getCompany(COMPANY_A)).toBeNull();
    expect(await store.getCompany(COMPANY_B)).not.toBeNull();
    expect(await store.listCompanyIds()).toEqual([COMPANY_B]);
  });

  it("indexes company ids without leaking paths or policies", async () => {
    const { state } = createFakeState();
    const store = new GovernanceStore(state);
    await store.setCompany(COMPANY_A, {
      enabled: true,
      policy: { deniedTools: ["codegraph_impact"] },
      projects: { web: { projectKey: "web", path: "/srv/secret/company-a" } },
    });

    const index = await store.listCompanyIds();
    expect(index).toEqual([COMPANY_A]);
    expect(JSON.stringify(index)).not.toContain("secret");
    expect(JSON.stringify(index)).not.toContain("codegraph");
  });

  /**
   * The load-bearing isolation test: `loadForResolve` is the only path the tool
   * handler uses, and it must not put another tenant's bindings in memory.
   */
  it("loadForResolve exposes only the requested company", async () => {
    const { state } = createFakeState();
    const store = new GovernanceStore(state);
    await store.setCompany(COMPANY_A, {
      enabled: true,
      defaultProjectKey: "web",
      projects: { web: { projectKey: "web", path: "/srv/a/web" } },
    });
    await store.setCompany(COMPANY_B, {
      enabled: true,
      defaultProjectKey: "api",
      projects: { api: { projectKey: "api", path: "/srv/b/api-secret" } },
    });

    const forA = await store.loadForResolve(COMPANY_A);

    expect(Object.keys(forA.companies)).toEqual([COMPANY_A]);
    // Company B's path must not appear anywhere in the resolution input.
    expect(JSON.stringify(forA)).not.toContain("api-secret");

    // And resolution built from it cannot reach B, even given B's ids.
    const resolved = resolveScope(forA, {
      companyId: COMPANY_B,
      pluginEnabled: true,
    });
    expect(resolved.allowed).toBe(false);
    expect(resolved.reason).toBe("company_not_configured");
  });

  it("loadAll is available for admin reads", async () => {
    const { state } = createFakeState();
    const store = new GovernanceStore(state);
    await store.setCompany(COMPANY_A, { enabled: true, projects: {} });
    await store.setCompany(COMPANY_B, { enabled: true, projects: {} });

    const all = await store.loadAll();
    expect(Object.keys(all.companies).sort()).toEqual([COMPANY_A, COMPANY_B].sort());
  });

  it("validates on write so a bad document never reaches storage", async () => {
    const { state, rows } = createFakeState();
    const store = new GovernanceStore(state);
    await expect(
      // @ts-expect-error deliberately invalid: enabled must be a boolean
      store.setCompany(COMPANY_A, { enabled: "yes", projects: {} }),
    ).rejects.toThrow(/enabled/);
    expect(rows.size).toBe(0);
  });

  it("stores and reads instance defaults", async () => {
    const { state } = createFakeState();
    const store = new GovernanceStore(state);
    await store.setDefaults({ enabled: true, policy: { deniedTools: ["codegraph_files"] } });

    const defaults = await store.getDefaults();
    expect(defaults.enabled).toBe(true);
    expect(defaults.policy?.deniedTools).toEqual(["codegraph_files"]);
  });

  it("returns empty defaults when nothing was written", async () => {
    const { state } = createFakeState();
    expect(await new GovernanceStore(state).getDefaults()).toEqual({});
  });

  it("ignores an unrecognized shape written into the defaults slot", async () => {
    const { state } = createFakeState();
    const store = new GovernanceStore(state);
    await state.set(
      { scopeKind: "instance", namespace: STATE_NAMESPACE, stateKey: "instance-defaults" },
      { policy: { allowedTools: [123] } },
    );
    await expect(store.getDefaults()).rejects.toThrow();
  });
});
