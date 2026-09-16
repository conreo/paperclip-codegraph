/**
 * The plugin's UI entrypoint.
 *
 * This file is the bundle's contract surface: the host resolves each declared
 * `exportName` from here. The surfaces themselves live in sibling modules so
 * that the parts worth testing — the layout algebra, the excerpt reader, the
 * sidebar's readiness logic — are ordinary functions in ordinary files rather
 * than closures inside a component.
 *
 *   SettingsPage      → Settings → Plugins → CodeGraph   (all configuration)
 *   CodeGraphSidebar  → the nav column                   (index state)
 *
 * The split follows the host's own model: `ui/src/pages/PluginSettings.tsx` mounts
 * `settingsPage` inside Settings → Plugins, and `ui/src/components/Sidebar.tsx`
 * renders `sidebar` inside the nav column.
 *
 * There is deliberately no `page` slot. A hand-built reader lived here for several
 * releases and was removed: CodeGraph's own UI is better, changes often, and a
 * second implementation of it could only fall behind. The tools and the governed
 * MCP path are the plugin's job; reading the graph is CodeGraph's.
 */

export { SettingsPage } from "./admin.js";
export { CodeGraphSidebar } from "./sidebar.js";
