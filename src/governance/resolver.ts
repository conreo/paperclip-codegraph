/**
 * Governance resolution.
 *
 * Pure functions over a {@link GovernanceDocument}: no filesystem access, no
 * host calls, no I/O. That is deliberate — this is the module that decides
 * whether an agent in Company A can read Company B's checkout, so it must be
 * exhaustively unit-testable in isolation.
 *
 * ## The narrowing rule
 *
 * Five scopes can contribute, from broadest to narrowest:
 *
 *     instance defaults → company → project binding → Paperclip project → agent
 *
 * `deniedTools` **unions** across every applicable scope: once any scope denies
 * a tool, no narrower scope can re-grant it.
 *
 * `allowedTools` **intersects**: if any scope declares an allow list, the
 * effective allow list is the intersection of all declared lists. A present but
 * empty list means "deny everything at this scope".
 *
 * The consequence is that adding an override can only ever remove access. A
 * misconfigured agent override is therefore a denial-of-service risk, never an
 * escalation risk.
 */

import { CODEGRAPH_TOOLS } from "../constants.js";
import type {
  CompanyGovernance,
  GovernanceDocument,
  ProjectBinding,
  ResolvedScope,
  ResolutionDenialReason,
  ResolutionTrace,
  ScopeOverride,
  ScopePolicy,
} from "./types.js";
import { GOVERNANCE_VERSION } from "./types.js";

// ---------------------------------------------------------------------------
// Tool-pattern matching
// ---------------------------------------------------------------------------

/**
 * Match a tool name against an exact name or a `*` glob.
 *
 * `*` matches any run of characters, so `codegraph_*` selects all upstream
 * tools and `*` selects everything. Matching is case-sensitive because upstream
 * tool names are lowercase snake_case.
 */
export function matchesToolPattern(pattern: string, toolName: string): boolean {
  if (pattern === toolName) return true;
  if (!pattern.includes("*")) return false;
  const escaped = pattern
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`).test(toolName);
}

function matchesAny(patterns: readonly string[], toolName: string): boolean {
  return patterns.some((pattern) => matchesToolPattern(pattern, toolName));
}

// ---------------------------------------------------------------------------
// Validation of operator-supplied input
// ---------------------------------------------------------------------------

export class GovernanceValidationError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(`${path}: ${message}`);
    this.name = "GovernanceValidationError";
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseStringArray(value: unknown, where: string): string[] {
  if (!Array.isArray(value)) {
    throw new GovernanceValidationError("must be an array of strings", where);
  }
  return value.map((entry, index) => {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new GovernanceValidationError(
        `entry ${index} must be a non-empty string`,
        where,
      );
    }
    return entry.trim();
  });
}

function parsePolicy(value: unknown, where: string): ScopePolicy | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isPlainObject(value)) {
    throw new GovernanceValidationError("must be an object", where);
  }
  const policy: ScopePolicy = {};
  if (value["allowedTools"] !== undefined) {
    policy.allowedTools = parseStringArray(
      value["allowedTools"],
      `${where}.allowedTools`,
    );
  }
  if (value["deniedTools"] !== undefined) {
    policy.deniedTools = parseStringArray(
      value["deniedTools"],
      `${where}.deniedTools`,
    );
  }
  return policy;
}

function parseProjectBinding(value: unknown, where: string): ProjectBinding {
  if (!isPlainObject(value)) {
    throw new GovernanceValidationError("must be an object", where);
  }
  const projectKey = value["projectKey"];
  const projectPath = value["path"];
  if (typeof projectKey !== "string" || projectKey.trim().length === 0) {
    throw new GovernanceValidationError("projectKey must be a non-empty string", where);
  }
  if (typeof projectPath !== "string" || projectPath.trim().length === 0) {
    throw new GovernanceValidationError("path must be a non-empty string", where);
  }
  const displayName = value["displayName"];
  if (displayName !== undefined && typeof displayName !== "string") {
    throw new GovernanceValidationError("displayName must be a string", where);
  }
  return {
    projectKey: projectKey.trim(),
    path: projectPath.trim(),
    ...(typeof displayName === "string" ? { displayName } : {}),
    ...(parsePolicy(value["policy"], `${where}.policy`)
      ? { policy: parsePolicy(value["policy"], `${where}.policy`) }
      : {}),
  };
}

function parseOverride(value: unknown, where: string): ScopeOverride {
  if (!isPlainObject(value)) {
    throw new GovernanceValidationError("must be an object", where);
  }
  const override: ScopeOverride = {};
  if (value["enabled"] !== undefined) {
    if (typeof value["enabled"] !== "boolean") {
      throw new GovernanceValidationError("enabled must be a boolean", where);
    }
    override.enabled = value["enabled"];
  }
  if (value["projectKey"] !== undefined) {
    if (value["projectKey"] !== null && typeof value["projectKey"] !== "string") {
      throw new GovernanceValidationError("projectKey must be a string or null", where);
    }
    if (typeof value["projectKey"] === "string") override.projectKey = value["projectKey"];
  }
  const policy = parsePolicy(value["policy"], `${where}.policy`);
  if (policy) override.policy = policy;
  return override;
}

function parseOverrideMap(
  value: unknown,
  where: string,
): Record<string, ScopeOverride> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isPlainObject(value)) {
    throw new GovernanceValidationError("must be an object", where);
  }
  const result: Record<string, ScopeOverride> = {};
  for (const [key, entry] of Object.entries(value)) {
    result[key] = parseOverride(entry, `${where}.${key}`);
  }
  return result;
}

/**
 * Validate and normalize a raw governance document.
 *
 * Unknown top-level keys are rejected rather than ignored, so a typo in an
 * operator's config surfaces immediately instead of silently granting the wrong
 * access. Throws {@link GovernanceValidationError} with the offending path.
 */
export function parseGovernance(input: unknown): GovernanceDocument {
  if (input === undefined || input === null) {
    return { version: GOVERNANCE_VERSION, companies: {} };
  }
  if (!isPlainObject(input)) {
    throw new GovernanceValidationError("governance must be an object", "$");
  }

  const version = input["version"];
  if (version !== undefined && version !== GOVERNANCE_VERSION) {
    throw new GovernanceValidationError(
      `unsupported version ${String(version)}; expected ${GOVERNANCE_VERSION}`,
      "$.version",
    );
  }

  const doc: GovernanceDocument = {
    version: GOVERNANCE_VERSION,
    companies: {},
  };

  const defaults = input["defaults"];
  if (defaults !== undefined && defaults !== null) {
    if (!isPlainObject(defaults)) {
      throw new GovernanceValidationError("defaults must be an object", "$.defaults");
    }
    for (const key of Object.keys(defaults)) {
      if (key !== "enabled" && key !== "policy") {
        throw new GovernanceValidationError(`unknown key "${key}"`, "$.defaults");
      }
    }
    if (defaults["enabled"] !== undefined && typeof defaults["enabled"] !== "boolean") {
      throw new GovernanceValidationError("enabled must be a boolean", "$.defaults.enabled");
    }
    doc.defaults = {
      ...(typeof defaults["enabled"] === "boolean" ? { enabled: defaults["enabled"] } : {}),
      ...(parsePolicy(defaults["policy"], "$.defaults.policy")
        ? { policy: parsePolicy(defaults["policy"], "$.defaults.policy") }
        : {}),
    };
  }

  const companies = input["companies"];
  if (companies !== undefined && companies !== null) {
    if (!isPlainObject(companies)) {
      throw new GovernanceValidationError("companies must be an object", "$.companies");
    }
    const parsed: Record<string, CompanyGovernance> = {};
    for (const [companyId, rawCompany] of Object.entries(companies)) {
      const where = `$.companies.${companyId}`;
      if (!isPlainObject(rawCompany)) {
        throw new GovernanceValidationError("must be an object", where);
      }
      for (const key of Object.keys(rawCompany)) {
        if (
          ![
            "enabled",
            "policy",
            "projects",
            "defaultProjectKey",
            "projectsByPaperclipProject",
            "agents",
          ].includes(key)
        ) {
          throw new GovernanceValidationError(`unknown key "${key}"`, where);
        }
      }
      if (typeof rawCompany["enabled"] !== "boolean") {
        throw new GovernanceValidationError(
          "enabled is required and must be a boolean",
          `${where}.enabled`,
        );
      }

      let projects: Record<string, ProjectBinding> | undefined;
      const rawProjects = rawCompany["projects"];
      if (rawProjects !== undefined && rawProjects !== null) {
        if (!isPlainObject(rawProjects)) {
          throw new GovernanceValidationError("projects must be an object", `${where}.projects`);
        }
        projects = {};
        for (const [key, rawBinding] of Object.entries(rawProjects)) {
          const binding = parseProjectBinding(rawBinding, `${where}.projects.${key}`);
          if (binding.projectKey !== key) {
            throw new GovernanceValidationError(
              `binding declares projectKey "${binding.projectKey}" but is stored under key "${key}"`,
              `${where}.projects.${key}`,
            );
          }
          projects[key] = binding;
        }
      }

      const defaultProjectKey = rawCompany["defaultProjectKey"];
      if (
        defaultProjectKey !== undefined &&
        defaultProjectKey !== null &&
        typeof defaultProjectKey !== "string"
      ) {
        throw new GovernanceValidationError(
          "defaultProjectKey must be a string or null",
          `${where}.defaultProjectKey`,
        );
      }

      parsed[companyId] = {
        enabled: rawCompany["enabled"],
        ...(parsePolicy(rawCompany["policy"], `${where}.policy`)
          ? { policy: parsePolicy(rawCompany["policy"], `${where}.policy`) }
          : {}),
        ...(projects ? { projects } : {}),
        ...(typeof defaultProjectKey === "string"
          ? { defaultProjectKey }
          : { defaultProjectKey: null }),
        ...(() => {
          const map = parseOverrideMap(
            rawCompany["projectsByPaperclipProject"],
            `${where}.projectsByPaperclipProject`,
          );
          return map ? { projectsByPaperclipProject: map } : {};
        })(),
        ...(() => {
          const map = parseOverrideMap(rawCompany["agents"], `${where}.agents`);
          return map ? { agents: map } : {};
        })(),
      };
    }
    doc.companies = parsed;
  }

  return doc;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export interface ScopeRequest {
  companyId: string;
  /** Paperclip project UUID from the agent run context, when available. */
  paperclipProjectId?: string | null;
  /** Paperclip agent UUID from the agent run context. */
  agentId?: string | null;
  /** Instance-level kill switch (plugin config `enabled`). */
  pluginEnabled: boolean;
  /** The upstream tool set this plugin exposes. Defaults to CodeGraph 1.6.0's. */
  allTools?: readonly string[];
}

function policyOf(policy: ScopePolicy | undefined, scope: string) {
  return policy ? { policy, scope } : null;
}

/**
 * Resolve the effective governance for one scope.
 *
 * Never throws for ordinary misconfiguration: an unresolvable or disabled scope
 * returns `allowed: false` with a reason code, because "deny" is the correct
 * behaviour and an exception here would only turn a policy decision into a 500.
 */
export function resolveScope(
  doc: GovernanceDocument,
  request: ScopeRequest,
): ResolvedScope {
  const allTools = request.allTools ?? CODEGRAPH_TOOLS;
  const trace: ResolutionTrace = { appliedScopes: [], denialSource: null };

  const deny = (reason: ResolutionDenialReason, source: string): ResolvedScope => {
    trace.denialSource = source;
    return {
      allowed: false,
      reason,
      allowedTools: [],
      deniedTools: [],
      trace,
    };
  };

  if (!request.pluginEnabled) return deny("plugin_disabled", "instance");

  if (doc.defaults?.enabled === false) {
    return deny("instance_defaults_disabled", "instance_defaults");
  }

  const company = doc.companies[request.companyId];
  if (!company) return deny("company_not_configured", "company");
  if (!company.enabled) return deny("company_disabled", "company");

  const agentOverride: ScopeOverride | undefined = request.agentId
    ? company.agents?.[request.agentId]
    : undefined;
  const projectOverride: ScopeOverride | undefined = request.paperclipProjectId
    ? company.projectsByPaperclipProject?.[request.paperclipProjectId]
    : undefined;

  if (agentOverride?.enabled === false) return deny("agent_disabled", "agent");
  if (projectOverride?.enabled === false) {
    return deny("paperclip_project_disabled", "paperclip_project");
  }

  // Most specific binding wins; a narrower scope can only *choose among* the
  // company's own bound projects, never introduce a new path.
  const selectedKey =
    agentOverride?.projectKey ??
    projectOverride?.projectKey ??
    company.defaultProjectKey ??
    null;

  if (!selectedKey) return deny("no_project_bound", "company");

  const binding = company.projects?.[selectedKey];
  if (!binding) return deny("project_binding_missing", "company");

  // Collect every applicable policy, broadest → narrowest, for auditing.
  const applicable = [
    policyOf(doc.defaults?.policy, "instance_defaults"),
    policyOf(company.policy, "company"),
    policyOf(binding.policy, "project_binding"),
    policyOf(projectOverride?.policy, "paperclip_project"),
    policyOf(agentOverride?.policy, "agent"),
  ].filter((entry): entry is { policy: ScopePolicy; scope: string } => entry !== null);

  trace.appliedScopes = applicable.map((entry) => entry.scope);

  const denySets = applicable
    .map((entry) => entry.policy.deniedTools)
    .filter((value): value is readonly string[] => Array.isArray(value));
  const deniedTools = [...new Set(denySets.flat())];

  const allowSets = applicable
    .map((entry) => entry.policy.allowedTools)
    .filter((value): value is readonly string[] => Array.isArray(value));

  // No allow list anywhere ⇒ everything not denied. Otherwise intersect.
  const allowedTools =
    allowSets.length === 0
      ? [...allTools]
      : allTools.filter((tool) =>
          allowSets.every((set) => matchesAny(set, tool)),
        );

  return {
    allowed: true,
    reason: "allowed",
    project: binding,
    allowedTools,
    deniedTools,
    trace,
  };
}

export type ToolAccessDecision =
  | { allowed: true; reason: "allowed" }
  | { allowed: false; reason: "tool_denied" | "tool_not_allowed" | ResolutionDenialReason };

/**
 * Decide one tool call against an already-resolved scope.
 *
 * Deny is evaluated first so a tool that appears in both lists is denied.
 */
export function decideToolAccess(
  resolved: ResolvedScope,
  toolName: string,
): ToolAccessDecision {
  if (!resolved.allowed) {
    return { allowed: false, reason: resolved.reason as ResolutionDenialReason };
  }
  if (matchesAny(resolved.deniedTools, toolName)) {
    return { allowed: false, reason: "tool_denied" };
  }
  if (!resolved.allowedTools.includes(toolName)) {
    return { allowed: false, reason: "tool_not_allowed" };
  }
  return { allowed: true, reason: "allowed" };
}

/**
 * The tool list to advertise for a scope.
 *
 * Paperclip's gateway independently filters plugin tools through operator
 * profiles; this is the plugin's own narrowing on top of that, so an operator
 * who has not written any Paperclip profile still gets the plugin's policy.
 */
export function visibleTools(resolved: ResolvedScope): readonly string[] {
  if (!resolved.allowed) return [];
  return resolved.allowedTools.filter(
    (tool) => !matchesAny(resolved.deniedTools, tool),
  );
}
