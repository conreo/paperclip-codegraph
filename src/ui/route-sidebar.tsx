/**
 * The view rail for the CodeGraph page.
 *
 * This exists for two reasons, and the second is the one that is easy to miss:
 *
 * 1. It is where the views belong. CodeGraph's own UI puts them in a rail with the
 *    content beside it, so the page does not have to carry its own tab bar.
 *
 * 2. **Declaring it removes the host's Back button.** `PluginPage.tsx:166` renders
 *    `{!routeSidebarActive && <Back to dashboard>}`, and `routeSidebarActive` is
 *    true only when `resolveRouteSidebarSlot` finds a `routeSidebar` slot whose
 *    `routePath` matches the plugin's `page` slot, in the same plugin
 *    (`ui/src/plugins/slots.tsx:74-92`). Without one, the host shows a Back button
 *    that navigates away from the page — which is what made it look like a
 *    separate application rather than a section of Paperclip.
 *
 * Links go through `useHostNavigation().linkProps()`, so they are real anchors:
 * middle-click, copy-link and open-in-new-tab keep working.
 */

import { useHostLocation, useHostNavigation, type PluginRouteSidebarProps } from "@paperclipai/plugin-sdk/ui";

import { VIEWS, VIEW_LABELS, VIEW_NOTES, hashForView, viewFromHash } from "./views.js";
import { styles } from "./chrome.js";

export function CodeGraphRouteSidebar({ context }: PluginRouteSidebarProps) {
  const navigation = useHostNavigation();
  const { hash } = useHostLocation();
  const active = viewFromHash(hash);

  if (!context.companyId) return null;

  return (
    <nav aria-label="CodeGraph views" style={styles.viewRail}>
      {VIEWS.map((view) => {
        const isActive = view === active;
        return (
          <a
            key={view}
            {...navigation.linkProps(`/codegraph${hashForView(view)}`)}
            aria-current={isActive ? "page" : undefined}
            style={isActive ? styles.viewRailItemActive : styles.viewRailItem}
            title={VIEW_NOTES[view]}
          >
            <span style={styles.viewRailLabel}>{VIEW_LABELS[view]}</span>
            <span style={styles.viewRailNote}>{VIEW_NOTES[view]}</span>
          </a>
        );
      })}
    </nav>
  );
}
