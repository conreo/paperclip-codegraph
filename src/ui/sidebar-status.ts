/**
 * What the CodeGraph nav entry says about readiness.
 *
 * Extracted from the component because this is the part that can be wrong in a
 * way nobody reports: a nav item showing the wrong state is a small lie that
 * costs an operator a support round-trip. It is also the only logic the sidebar
 * has, so separating it leaves the component as pure layout.
 *
 * The rule the whole plugin is built on applies here too: **absence means
 * allowed**. `readiness.enabled` is not a boolean flag that defaults to false —
 * an unknown value must not be rendered as "switched off", because that would
 * tell an operator their working deployment is broken.
 */

export interface SidebarReadiness {
  enabled: boolean;
  repository: { configured: boolean; indexed: boolean };
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
 * Reduce readiness to what the entry shows.
 *
 * `null` readiness means the data has not arrived, and that is `unknown` — not
 * "off". Reporting "off" during the first render would flash a false problem on
 * every page load.
 */
export function sidebarStatus(readiness: SidebarReadiness | null | undefined): SidebarStatus {
  if (!readiness) {
    return { state: "unknown", ok: false, note: null, title: "Checking CodeGraph" };
  }

  if (!readiness.enabled) {
    return {
      state: "off",
      ok: false,
      note: "Switched off for this company",
      title: "CodeGraph is switched off for this company",
    };
  }

  if (!readiness.repository.configured) {
    return {
      state: "no-repository",
      ok: false,
      note: "No repository in this company yet",
      title:
        "No repository yet. One appears once a project in this company has a workspace.",
    };
  }

  if (!readiness.repository.indexed) {
    return {
      state: "unindexed",
      ok: false,
      note: "No index yet",
      title: "No index yet — index it in Settings → Plugins → CodeGraph",
    };
  }

  return { state: "ready", ok: true, note: null, title: "Repository indexed" };
}
