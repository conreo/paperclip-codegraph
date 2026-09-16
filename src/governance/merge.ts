/**
 * Merging a settings-page form into the governance document.
 *
 * ## Why this is a separate, pure module
 *
 * The first version of the settings page built a whole governance document from
 * the form and saved it, which meant every field the form did not show was
 * deleted on save. On a company that already had governance, pressing Save
 * silently removed a tool denial — widening access rather than narrowing it.
 *
 * So the write path is separated from the component and pinned by tests. The
 * rules below are all the same rule: **the form may only change what it shows,
 * and may only delete what the operator explicitly removed.**
 *
 *   - repositories are added or re-pathed; a repository disappears only if its
 *     key is in `removedRepositoryKeys`;
 *   - `policy` is never rewritten. A denial an admin configured is not the
 *     page's to clear, and there is no UI here that could legitimately widen it;
 *   - agent overrides for agents the form did not list (a deleted agent, or
 *     something automation wrote) are preserved untouched;
 *   - `projectsByPaperclipProject` entries pointing at a repository that is no
 *     longer bound are dropped, since a binding to a removed repository can only
 *     resolve to `project_binding_missing`.
 */

import type { CompanyGovernance, ProjectBinding, ScopeOverride } from "./types.js";

export interface RepositoryRow {
  /** Operator-facing name and the binding key. */
  key: string;
  /** Absolute path, or a path relative to the operator's repositories folder. */
  path: string;
}

export interface GovernanceFormState {
  /** Every repository row currently shown, in order. */
  repositories: readonly RepositoryRow[];
  /** Keys the operator clicked remove on. The only way a binding is deleted. */
  removedRepositoryKeys: readonly string[];
  /** Agent ids the operator ticked. */
  grantedAgentIds: readonly string[];
  /**
   * Every agent id the form listed. Needed to tell "unticked, so deny" apart
   * from "not shown, so leave alone".
   */
  listedAgentIds: readonly string[];
}

export interface MergeOptions {
  /** Used only when the company has no policy yet, so a denial is never cleared. */
  defaultAllowedTools: readonly string[];
}

/** Trim, drop blanks, and de-duplicate rows by key, keeping the last path. */
function normalizeRows(rows: readonly RepositoryRow[]): RepositoryRow[] {
  const byKey = new Map<string, RepositoryRow>();
  for (const row of rows) {
    const key = row.key.trim();
    if (key.length === 0) continue;
    byKey.set(key, { key, path: row.path.trim().length > 0 ? row.path.trim() : key });
  }
  return [...byKey.values()];
}

export function mergeGovernance(
  current: CompanyGovernance | null,
  form: GovernanceFormState,
  options: MergeOptions,
): CompanyGovernance {
  const removed = new Set(form.removedRepositoryKeys.map((key) => key.trim()));
  const rows = normalizeRows(form.repositories);

  // 1. Repositories: start from what is bound, drop only explicit removals,
  //    then apply the form. Existing binding metadata (displayName, per-project
  //    policy) survives an unchanged path.
  const projects: Record<string, ProjectBinding> = {};
  for (const [key, binding] of Object.entries(current?.projects ?? {})) {
    if (removed.has(key)) continue;
    projects[key] = binding;
  }
  for (const row of rows) {
    const existing = projects[row.key];
    projects[row.key] = {
      ...(existing ?? {}),
      projectKey: row.key,
      path: row.path,
    };
  }

  const boundKeys = new Set(Object.keys(projects));

  // 2. Default project: keep the current one when it is still bound, otherwise
  //    the first row, otherwise nothing.
  const currentDefault = current?.defaultProjectKey ?? null;
  const defaultProjectKey =
    currentDefault && boundKeys.has(currentDefault)
      ? currentDefault
      : (rows[0]?.key ?? null);

  // 3. Paperclip-project overrides: keep the ones that still point somewhere.
  const projectsByPaperclipProject: Record<string, ScopeOverride> = {};
  for (const [projectId, override] of Object.entries(
    current?.projectsByPaperclipProject ?? {},
  )) {
    if (override.projectKey && !boundKeys.has(override.projectKey)) continue;
    projectsByPaperclipProject[projectId] = override;
  }

  // 4. Policy: preserved verbatim when it exists. Seeded only for a company
  //    that has none, so this page can never clear a denial.
  const policy = current?.policy ?? { allowedTools: [...options.defaultAllowedTools] };

  // 5. Agents: preserve overrides for agents the form did not list; for listed
  //    agents, ticking clears a disable flag (keeping any narrowing policy) and
  //    unticking disables them.
  const agents: Record<string, ScopeOverride> = { ...(current?.agents ?? {}) };
  const granted = new Set(form.grantedAgentIds);
  for (const agentId of form.listedAgentIds) {
    if (granted.has(agentId)) {
      const existing = agents[agentId];
      if (!existing) continue;
      if (existing.enabled === false) {
        const { enabled: _enabled, ...rest } = existing;
        if (Object.keys(rest).length > 0) agents[agentId] = rest;
        else delete agents[agentId];
      }
      continue;
    }
    agents[agentId] = { ...(agents[agentId] ?? {}), enabled: false };
  }

  return {
    // Never silently re-enable a company an admin turned off.
    enabled: current?.enabled ?? true,
    ...(Object.keys(projects).length > 0 ? { projects } : {}),
    defaultProjectKey,
    ...(Object.keys(projectsByPaperclipProject).length > 0
      ? { projectsByPaperclipProject }
      : {}),
    ...(Object.keys(agents).length > 0 ? { agents } : {}),
    policy,
  };
}
