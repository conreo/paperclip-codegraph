/**
 * The CodeGraph entry in Paperclip's nav column.
 *
 * This is a **link, not a panel**. The host renders a `sidebar` slot as a custom
 * component inside its nav (`ui/src/components/Sidebar.tsx`), and a plugin `page`
 * slot creates a route without adding any nav entry
 * (`ui/src/App.tsx:432`). So an operator would otherwise have a working URL and
 * no way to reach it: this is the missing entry, and it navigates to the page.
 *
 * `useHostNavigation().linkProps()` is what makes it a real link — it resolves
 * the company prefix and returns a genuine `href`, so middle-click,
 * copy-link and open-in-new-tab keep working instead of being hijacked by an
 * `onClick` handler.
 *
 * Configuration deliberately does not live here. Per-plugin settings belong in
 * Settings → Plugins → CodeGraph, which is where the host mounts this plugin's
 * `settingsPage`; a nav column is for going places.
 */

import { usePluginData, useHostNavigation, type PluginSidebarProps } from "@paperclipai/plugin-sdk/ui";

import { StatusLine, styles } from "./chrome.js";
import { sidebarStatus } from "./sidebar-status.js";
import { ACTION_KEYS, DATA_KEYS } from "../plugin-keys.js";

export function CodeGraphSidebar({ context }: PluginSidebarProps) {
  const navigation = useHostNavigation();
  const companyId = context.companyId;

  // The same read the settings page uses, so the nav badge and the page can never
  // disagree about whether this organisation has a repository. The `readiness`
  // handler is deliberately not used here: it reports the governance *binding*,
  // which is empty on an organisation that is working fine.
  const { data } = usePluginData<{
    enabled?: boolean;
    repositories: Array<{ indexed: boolean; blocked?: boolean }>;
  }>(DATA_KEYS.graphProjects, { companyId });

  const status = sidebarStatus(
    data ? { enabled: data.enabled !== false, repositories: data.repositories } : null,
  );

  // Outside a company there is no `/codegraph` route to link to, so the entry
  // says so rather than offering a dead link.
  if (!companyId) {
    return <p style={styles.muted}>CodeGraph is configured per organization.</p>;
  }

  return (
    <div style={styles.sidebarWrap}>
      <a {...navigation.linkProps("/codegraph")} style={styles.sidebarLink}>
        <span aria-hidden style={styles.sidebarGlyph}>
          {/* Two callers above, one callee below: the shape the page draws. */}
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
            <path d="M7 4.5 V9" stroke="currentColor" strokeWidth="1.2" />
            <path d="M3 2.8 C 3 4.2, 6.4 3.9, 7 4.5" stroke="currentColor" strokeWidth="1.2" />
            <path d="M11 2.8 C 11 4.2, 7.6 3.9, 7 4.5" stroke="currentColor" strokeWidth="1.2" />
            <circle cx="3" cy="2.2" r="1.4" fill="currentColor" />
            <circle cx="11" cy="2.2" r="1.4" fill="currentColor" />
            <circle cx="7" cy="10.4" r="1.5" fill="currentColor" />
          </svg>
        </span>
        <span style={styles.sidebarLabel}>CodeGraph</span>
        {status.state === "unknown" ? null : (
          <span
            style={status.ok ? styles.sidebarDotOk : styles.sidebarDotIdle}
            title={status.title}
            aria-label={status.title}
          />
        )}
      </a>

      {/*
        One line of state, not a control panel. A nav column has room for a
        destination and whether it is ready; the controls themselves live in
        Settings → Plugins → CodeGraph, and the graph lives behind this link.
      */}
      {status.note ? (
        <ul style={styles.sidebarNotes}>
          <StatusLine ok={false} good="" bad={status.note} />
        </ul>
      ) : null}
    </div>
  );
}
