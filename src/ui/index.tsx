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
 *   CodeGraphSidebar  → the nav column                   (a link to the page)
 *   CodeGraphPage     → /:companyPrefix/codegraph        (the graph itself)
 *
 * The split is deliberate and follows the host's own model:
 * `ui/src/pages/PluginSettings.tsx` mounts `settingsPage` inside Settings →
 * Plugins, `ui/src/components/Sidebar.tsx` renders `sidebar` inside the nav, and
 * `ui/src/App.tsx` turns a `page` slot's `routePath` into a route. Configuration
 * belongs in the first; the second exists so the third is reachable.
 */

export { SettingsPage } from "./admin.js";
export { CodeGraphSidebar } from "./sidebar.js";
export { CodeGraphRouteSidebar } from "./route-sidebar.js";
export { CodeGraphPage } from "./page.js";
