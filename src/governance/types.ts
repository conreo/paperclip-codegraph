/**
 * Governance model.
 *
 * Paperclip's own tool profiles / policies / bindings decide *whether* a plugin
 * tool may be called; that layer is enforced by the host gateway and this plugin
 * never duplicates or bypasses it. What Paperclip cannot know is *which codebase*
 * a given call should read — that is organization-specific data the plugin owns.
 *
 * So this model answers exactly two questions, and nothing else:
 *
 *   1. Which CodeGraph project may this (company, project, agent) read?
 *   2. Which CodeGraph tools may it call, as a narrowing on top of Paperclip's
 *      own allow/deny?
 *
 * The algebra is deliberately **narrowing-only**: no narrower scope can ever
 * widen what a broader scope granted. Denials accumulate; allowances intersect.
 * That makes a compromised or careless project/agent override incapable of
 * escalating its own access.
 */

export const GOVERNANCE_VERSION = 1 as const;

/** A tool allow/deny list. Entries are exact names or `*` globs. */
export interface ScopePolicy {
  /**
   * If present and non-empty, only these tools are callable at this scope.
   * Intersected with every other applicable scope's `allowedTools`.
   */
  allowedTools?: readonly string[];
  /**
   * These tools are never callable at this scope. Unioned across every
   * applicable scope. Always wins over `allowedTools`.
   */
  deniedTools?: readonly string[];
}

/** A CodeGraph-indexed repository this company is allowed to query. */
export interface ProjectBinding {
  /** Operator-chosen alias. This is what appears in logs and audit rows. */
  projectKey: string;
  /** Absolute path to the repository root that owns a `.codegraph/` index. */
  path: string;
  displayName?: string;
  /** Optional per-project narrowing. */
  policy?: ScopePolicy;
}

/** Optional override attached to one Paperclip project or agent. */
export interface ScopeOverride {
  /** Set to false to remove this scope's access entirely. */
  enabled?: boolean;
  /** Which bound project to query. Must name a key in the company's `projects`. */
  projectKey?: string;
  policy?: ScopePolicy;
}

export interface CompanyGovernance {
  /** Master switch. Absent or false means this company gets no CodeGraph tools. */
  enabled: boolean;
  /** Company-wide narrowing applied to every project and agent in the company. */
  policy?: ScopePolicy;
  /** Bound CodeGraph projects, keyed by `projectKey`. */
  projects?: Readonly<Record<string, ProjectBinding>>;
  /** Project used when no Paperclip-project or agent override applies. */
  defaultProjectKey?: string | null;
  /** Per-Paperclip-project override, keyed by Paperclip project UUID. */
  projectsByPaperclipProject?: Readonly<Record<string, ScopeOverride>>;
  /** Per-agent override, keyed by Paperclip agent UUID. */
  agents?: Readonly<Record<string, ScopeOverride>>;
}

/** The whole persisted document. Stored as one `ctx.state` value, company-namespaced per key. */
export interface GovernanceDocument {
  version: typeof GOVERNANCE_VERSION;
  /** Instance-wide defaults, applied to every company. */
  defaults?: {
    enabled?: boolean;
    policy?: ScopePolicy;
  };
  /** Per-company governance, keyed by Paperclip company UUID. */
  companies: Readonly<Record<string, CompanyGovernance>>;
}

export const EMPTY_GOVERNANCE: GovernanceDocument = {
  version: GOVERNANCE_VERSION,
  companies: {},
};

/** Where a resolved setting came from, for audit and debugging. */
export interface ResolutionTrace {
  /** Scope kinds that contributed a narrowing, most specific first. */
  appliedScopes: string[];
  /** Scope kinds that denied access outright. */
  denialSource: string | null;
}

export type ResolutionDenialReason =
  | "plugin_disabled"
  | "instance_defaults_disabled"
  | "company_not_configured"
  | "company_disabled"
  | "agent_disabled"
  | "paperclip_project_disabled"
  | "no_project_bound"
  | "project_binding_missing"
  | "tool_denied"
  | "tool_not_allowed";

export interface ResolvedScope {
  allowed: boolean;
  reason: ResolutionDenialReason | "allowed";
  /** Bound project for this scope, when resolution succeeded. */
  project?: ProjectBinding;
  /** Effective tool allowlist after narrowing. Empty array means "nothing allowed". */
  allowedTools: readonly string[];
  /** Effective denylist after unioning. */
  deniedTools: readonly string[];
  trace: ResolutionTrace;
}

/** A raw governance document as an operator may hand-write it. */
export type GovernanceInput = unknown;
