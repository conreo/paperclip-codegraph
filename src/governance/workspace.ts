/**
 * Deriving the repository from the run's Paperclip project workspace.
 *
 * Extracted from the worker so the tenant-safety logic is testable. These three
 * functions are the whole fallback: decide whether to try it, accept the path the
 * host returned, and build the document to re-resolve against. Everything that
 * matters for isolation is here rather than buried in a tool handler.
 *
 * The security argument in one line: `projectId` comes from the run context, the
 * workspace path comes from Paperclip, and the path is still validated — so a
 * forged id cannot produce a path, and a path that escapes the operator's roots
 * is refused.
 */

import { parseGovernance } from "./resolver.js";
import { PathRefusal, resolveProjectPath } from "./sanitize.js";
import type { GovernanceDocument } from "./types.js";

/** Binding key used for the workspace-derived repository. */
export const WORKSPACE_PROJECT_KEY = "workspace";

/**
 * Reasons that mean "we could not find a repository", as opposed to "you are not
 * allowed".
 *
 * Only these are eligible for the fallback. `plugin_disabled`, `company_disabled`,
 * `agent_disabled` and a tool decision all mean the caller may not use CodeGraph,
 * and falling back there would turn an authorisation denial into access.
 */
export const REPOSITORY_MISSING_REASONS: ReadonlySet<string> = new Set([
  "company_not_configured",
  "no_project_bound",
  "project_binding_missing",
]);

export function shouldTryWorkspaceFallback(resolved: {
  allowed: boolean;
  reason: string;
}): boolean {
  return !resolved.allowed && REPOSITORY_MISSING_REASONS.has(resolved.reason);
}

/**
 * Accept the host's workspace path, or null.
 *
 * Never throws: a rejected path must degrade to "governance decides alone", not
 * break the tool call. Containment still applies, so an operator who set
 * `allowedProjectRoots` keeps that boundary even for workspace-derived paths.
 */
export function acceptWorkspacePath(
  candidate: unknown,
  roots: readonly string[],
): string | null {
  if (typeof candidate !== "string" || candidate.trim().length === 0) return null;
  try {
    return resolveProjectPath(candidate, { allowedProjectRoots: [...roots] });
  } catch (error) {
    // A PathRefusal is an expected outcome; anything else is a bug, but neither
    // should surface as a tool error when governance can still answer.
    void (error instanceof PathRefusal);
    return null;
  }
}

/**
 * Re-resolve against a document that has the workspace as an extra binding.
 *
 * Built as a *new document* that is then validated by the resolver, rather than
 * by bypassing the resolver, so the narrowing algebra and every tool decision
 * stay exactly as tested. Existing projects, policy and agent overrides are
 * carried over verbatim — a configured denial still denies.
 */
export function buildWorkspaceGovernance(input: {
  document: GovernanceDocument;
  companyId: string;
  workspacePath: string;
}): GovernanceDocument {
  const existing = input.document.companies[input.companyId];
  const existingProjects = existing?.projects ?? {};

  return parseGovernance({
    version: 1,
    defaults: input.document.defaults,
    companies: {
      [input.companyId]: {
        ...(existing ?? {}),
        enabled: true,
        // Keep the company's own default when it has one; the workspace is only
        // the default when there was nothing to default to.
        defaultProjectKey: existing?.defaultProjectKey ?? WORKSPACE_PROJECT_KEY,
        projects: {
          ...existingProjects,
          [WORKSPACE_PROJECT_KEY]: {
            projectKey: WORKSPACE_PROJECT_KEY,
            path: input.workspacePath,
            displayName: "Project workspace",
          },
        },
      },
    },
  });
}
