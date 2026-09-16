/**
 * Persistence for the governance document, via `ctx.state`.
 *
 * ## Why this is keyed per company
 *
 * `ctx.state` partitions on `(pluginId, scopeKind, scopeId, namespace, stateKey)`,
 * so a company's governance can live under `scopeKind: "company"` with that
 * company's UUID as `scopeId`. Resolution then loads **only the caller's own
 * company entry** — there is no code path that reads another tenant's slice, so
 * a resolution bug cannot leak Company B's project paths into a Company A call.
 * That is a structural guarantee, not a check that could be forgotten.
 *
 * The cost of per-company keying is that `ctx.state` cannot enumerate keys, so
 * an admin UI could not list configured companies. A small instance-scoped index
 * of company **UUIDs only** (no paths, no policies) restores enumeration without
 * reintroducing a cross-tenant read path for anything sensitive.
 */

import { GOVERNANCE_VERSION } from "./types.js";
import type { CompanyGovernance, GovernanceDocument, ScopePolicy } from "./types.js";
import { parseGovernance, GovernanceValidationError } from "./resolver.js";
import { STATE_KEY, STATE_NAMESPACE } from "../constants.js";

/** The subset of `ctx.state` this store needs. Narrow so tests can stub it. */
export interface StateClient {
  get(input: {
    scopeKind: "instance" | "company";
    scopeId?: string;
    namespace?: string;
    stateKey: string;
  }): Promise<unknown>;
  set(
    input: {
      scopeKind: "instance" | "company";
      scopeId?: string;
      namespace?: string;
      stateKey: string;
    },
    value: unknown,
  ): Promise<void>;
  delete(input: {
    scopeKind: "instance" | "company";
    scopeId?: string;
    namespace?: string;
    stateKey: string;
  }): Promise<void>;
}

/** Instance-scope entry holding defaults shared by every company. */
export const DEFAULTS_KEY = "instance-defaults";

/** Instance-scope entry holding the list of configured company UUIDs. */
export const COMPANY_INDEX_KEY = "company-index";

export interface InstanceDefaults {
  enabled?: boolean;
  policy?: ScopePolicy;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class GovernanceStore {
  constructor(private readonly state: StateClient) {}

  private instanceKey(stateKey: string) {
    return { scopeKind: "instance" as const, namespace: STATE_NAMESPACE, stateKey };
  }

  private companyKey(companyId: string) {
    return {
      scopeKind: "company" as const,
      scopeId: companyId,
      namespace: STATE_NAMESPACE,
      stateKey: STATE_KEY,
    };
  }

  async getDefaults(): Promise<InstanceDefaults> {
    const raw = await this.state.get(this.instanceKey(DEFAULTS_KEY));
    if (!isRecord(raw)) return {};
    // Round-trip through the validator so a hand-edited value cannot smuggle
    // unexpected keys into resolution.
    const parsed = parseGovernance({
      version: GOVERNANCE_VERSION,
      defaults: raw,
      companies: {},
    });
    return parsed.defaults ?? {};
  }

  async setDefaults(defaults: InstanceDefaults): Promise<void> {
    // Validate before persisting so a bad write fails at the boundary.
    parseGovernance({
      version: GOVERNANCE_VERSION,
      defaults,
      companies: {},
    });
    await this.state.set(this.instanceKey(DEFAULTS_KEY), defaults);
  }

  async getCompany(companyId: string): Promise<CompanyGovernance | null> {
    const raw = await this.state.get(this.companyKey(companyId));
    if (raw === undefined || raw === null) return null;
    const parsed = parseGovernance({
      version: GOVERNANCE_VERSION,
      companies: { [companyId]: raw },
    });
    return parsed.companies[companyId] ?? null;
  }

  async setCompany(companyId: string, governance: CompanyGovernance): Promise<void> {
    parseGovernance({
      version: GOVERNANCE_VERSION,
      companies: { [companyId]: governance },
    });
    await this.state.set(this.companyKey(companyId), governance);
    await this.addToIndex(companyId);
  }

  async deleteCompany(companyId: string): Promise<void> {
    await this.state.delete(this.companyKey(companyId));
    const index = await this.listCompanyIds();
    const next = index.filter((entry) => entry !== companyId);
    await this.state.set(this.instanceKey(COMPANY_INDEX_KEY), next);
  }

  /** Company UUIDs only — never paths or policies. */
  async listCompanyIds(): Promise<string[]> {
    const raw = await this.state.get(this.instanceKey(COMPANY_INDEX_KEY));
    if (!Array.isArray(raw)) return [];
    return raw.filter((entry): entry is string => typeof entry === "string");
  }

  private async addToIndex(companyId: string): Promise<void> {
    const index = await this.listCompanyIds();
    if (index.includes(companyId)) return;
    await this.state.set(this.instanceKey(COMPANY_INDEX_KEY), [...index, companyId]);
  }

  /**
   * Build the resolution input for one company.
   *
   * The returned document contains instance defaults plus **exactly one**
   * company. `resolveScope` therefore cannot reach any other tenant's bindings
   * even if it were called with a forged project or agent id.
   */
  async loadForResolve(companyId: string): Promise<GovernanceDocument> {
    const [defaults, company] = await Promise.all([
      this.getDefaults(),
      this.getCompany(companyId),
    ]);
    return {
      version: GOVERNANCE_VERSION,
      defaults,
      companies: company ? { [companyId]: company } : {},
    };
  }

  /** Full read for admin/UI surfaces. Callers must be board-authorized. */
  async loadAll(): Promise<GovernanceDocument> {
    const defaults = await this.getDefaults();
    const ids = await this.listCompanyIds();
    const companies: Record<string, CompanyGovernance> = {};
    for (const id of ids) {
      const company = await this.getCompany(id);
      if (company) companies[id] = company;
    }
    return { version: GOVERNANCE_VERSION, defaults, companies };
  }
}

export { GovernanceValidationError };
