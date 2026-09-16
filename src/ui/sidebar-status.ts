/**
 * What the CodeGraph nav entry says about readiness.
 *
 * Extracted from the component because this is the part that can be wrong in a
 * way nobody reports: a nav item showing the wrong state is a small lie that
 * costs an operator a support round-trip.
 *
 * ## The bug this file was rewritten to fix
 *
 * It used to read the `readiness` handler, which reports the governance
 * **binding** — `resolved.project` out of the governance document. On an
 * organisation that was never given a binding that is empty, so the nav said
 * *"No repository in this company yet"* while the workspace was a git repository
 * with a 640-file index. Bindings are an override mechanism, not a declaration of
 * what exists; the repositories an organisation actually has come from its
 * Paperclip projects, which is what this now reads.
 *
 * The rule the rest of the plugin runs on still applies: **absence means
 * allowed**. An unknown state must not render as a problem.
 */

/** One repository, as `graph-projects` reports it. */
export interface SidebarRepository {
  indexed: boolean;
  /** True when an operator has switched CodeGraph off for this repository. */
  blocked?: boolean;
}

export interface SidebarFacts {
  /** The plugin's own on/off switch for this organisation. */
  enabled: boolean;
  repositories: readonly SidebarRepository[];
}

export type SidebarState = "ready" | "off" | "unindexed" | "no-repository" | "unknown";

export interface SidebarStatus {
  state: SidebarState;
  /** True only when the entry should show the positive indicator. */
  ok: boolean;
  /** One short line for the nav column, or null when nothing needs saying. */
  note: string | null;
  /** Tooltip: the longer explanation, which a nav column has no room for. */
  title: string;
}

/**
 * Reduce the facts to what the entry shows.
 *
 * `null` means the data has not arrived, and that is `unknown` — not "off" and
 * not "no repository". Reporting either during the first render would flash a
 * false problem on every page load.
 */
export function sidebarStatus(facts: SidebarFacts | null | undefined): SidebarStatus {
  if (!facts) {
    return { state: "unknown", ok: false, note: null, title: "Checking CodeGraph" };
  }

  if (!facts.enabled) {
    return {
      state: "off",
      ok: false,
      note: "Switched off for this organization",
      title: "CodeGraph is switched off for this organization",
    };
  }

  // Repositories an operator has switched off are not a problem to report: the
  // absence is deliberate, so they are excluded rather than counted as missing.
  const usable = facts.repositories.filter((repo) => repo.blocked !== true);

  if (usable.length === 0) {
    return {
      state: facts.repositories.length > 0 ? "off" : "no-repository",
      ok: false,
      // Distinguishes the two cases, which have different fixes.
      note:
        facts.repositories.length > 0
          ? "All repositories switched off"
          : "No repository in this organization yet",
      title:
        facts.repositories.length > 0
          ? "Every repository in this organization is switched off in Settings → Plugins → CodeGraph"
          : "No repository yet. One appears once a project in this organization has a repository workspace.",
    };
  }

  const indexed = usable.filter((repo) => repo.indexed).length;
  if (indexed === 0) {
    return {
      state: "unindexed",
      ok: false,
      note: "No index yet",
      title: "No index yet — index it in Settings → Plugins → CodeGraph",
    };
  }

  return {
    state: "ready",
    ok: true,
    note: null,
    title:
      usable.length === 1
        ? "Repository indexed"
        : `${indexed} of ${usable.length} repositories indexed`,
  };
}
