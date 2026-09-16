/**
 * Every bridge key the plugin uses, in one place.
 *
 * ## Why this file exists
 *
 * `index-now` was deleted by accident in the 0.7.0 refactor that removed the agent
 * access-request flow — unrelated code lost in a broad commit. Nothing failed:
 * the worker simply stopped registering a key the UI kept calling, and the bridge
 * answered with an error object that rendered as `[object Object]`. It shipped
 * like that for four releases, through a settings page rewrite, because **no test
 * compared the two sides**.
 *
 * The keys were previously string literals scattered across `worker.ts` and the UI
 * modules, so comparing them was impossible without parsing source. Declaring them
 * here makes the contract checkable, and `tests/bridge-keys.spec.ts` checks it in
 * both directions: every key the UI calls is registered, and every registered key
 * is one the UI calls (or is documented as internal).
 *
 * Using the constants at both ends is what keeps this honest — a literal in
 * `worker.ts` would quietly escape the check.
 */

/** Data handlers (`ctx.data.register` / `usePluginData`). */
export const DATA_KEYS = {
  /** Every agent in the company, with the current per-agent override. */
  access: "access",
  /** Agents only, for surfaces that need the list without override state. */
  agents: "agents",
  /** Why the graph view believes what it believes about one project. */
  graphDiagnose: "graph-diagnose",
  /** The call neighbourhood around one symbol. */
  graphNeighbourhood: "graph-neighbourhood",
  /** This org's repositories, cheapest possible check. */
  graphProjects: "graph-projects",
  /** A bounded source excerpt for one symbol. */
  graphSource: "graph-source",
  /** Symbol search in one of this org's repositories. */
  graphSearch: "graph-search",
  /** The org's governance document, as stored. */
  governanceSummary: "governance-summary",
  /** Which repositories are indexed, with file and node counts. */
  indexStatus: "index-status",
  /** Whether CodeGraph is usable for this company right now. */
  readiness: "readiness",
  /** Repositories with index state, running `codegraph status` per repository. */
  repositories: "repositories",
  /** One real CodeGraph call end to end, for verification. */
  verifyScope: "verify-scope",
} as const;

/** Actions (`ctx.actions.register` / `usePluginAction`). */
export const ACTION_KEYS = {
  /** Delete this company's governance document. */
  deleteCompanyGovernance: "delete-company-governance",
  /** Describe what a scope may do, without calling CodeGraph. */
  explainScope: "explain-scope",
  /** Read the governance document for a company. */
  getGovernance: "get-governance",
  /** Build or rebuild an index for one project. */
  indexNow: "index-now",
  /** Plan the native (non-plugin) MCP wiring, as curl. */
  nativeMcpPlan: "native-mcp-plan",
  /** Write a company's governance document wholesale. */
  setCompanyGovernance: "set-company-governance",
  /** Instance-wide defaults. */
  setInstanceDefaults: "set-instance-defaults",
  /** Narrow one agent's access. */
  setAgentAccess: "set-agent-access",
  /** Narrow one agent's access by whole-form merge. */
  setAccess: "set-access",
  /** Narrow access for one repository. */
  setRepositoryAccess: "set-repository-access",
  /** Stop every CodeGraph MCP child process. */
  shutdownCodegraph: "shutdown-codegraph",
  /** Run one real CodeGraph call for verification. */
  verifyCodegraph: "verify-codegraph",
} as const;

/**
 * Keys the worker registers that no UI surface calls.
 *
 * Listed explicitly rather than ignored, so removing a handler without removing
 * its caller — or the reverse — is a decision someone wrote down. These exist for
 * the verification and diagnostic curls documented in the README, which is why
 * they are reachable through the bridge but not from a button.
 */
export const KEYS_WITHOUT_UI_CALLER: readonly string[] = [
  ACTION_KEYS.deleteCompanyGovernance,
  ACTION_KEYS.explainScope,
  ACTION_KEYS.getGovernance,
  ACTION_KEYS.nativeMcpPlan,
  ACTION_KEYS.setAccess,
  ACTION_KEYS.setCompanyGovernance,
  ACTION_KEYS.setInstanceDefaults,
  ACTION_KEYS.shutdownCodegraph,
  ACTION_KEYS.verifyCodegraph,
  DATA_KEYS.governanceSummary,
  DATA_KEYS.graphDiagnose,
  DATA_KEYS.indexStatus,
  DATA_KEYS.verifyScope,
];

export const ALL_DATA_KEYS: readonly string[] = Object.values(DATA_KEYS);
export const ALL_ACTION_KEYS: readonly string[] = Object.values(ACTION_KEYS);
