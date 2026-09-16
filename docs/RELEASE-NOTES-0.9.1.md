# paperclip-codegraph v0.9.1

Fixes the UI placement. 0.9.0 shipped a graph page with a working URL, nothing in
Paperclip's nav pointing at it, and — worse — silently removed the ability to
configure the plugin.

## What 0.9.0 got wrong

**No way to reach the graph.** A plugin `page` slot creates a route
(`ui/src/App.tsx:432`); it does **not** add a nav entry. The host renders
`sidebar` slots inside its nav column (`ui/src/components/Sidebar.tsx`), so the
route existed and nothing linked to it.

**Configuration disappeared.** Declaring a `settingsPage` slot makes the host
render that component **instead of** its auto-generated config form:

```tsx
{hasCustomSettingsPage ? ( <PluginSlotMount … /> ) : hasConfigSchema ? ( <PluginConfigForm … /> ) : …}
```

It is an either/or, not an addition. 0.9.0 declared a `settingsPage` containing
only Status and Activate, so the five-field Configuration form — including
**Enable CodeGraph** — stopped rendering. Installing it would have left no way to
switch the plugin on from the UI.

## What this release does

The three surfaces now match how the host actually mounts plugin UI:

| Surface | Where | What it is |
|---|---|---|
| **CodeGraph** | the nav column | A link to the graph page, with an index-status dot. |
| **CodeGraph** | `/:companyPrefix/codegraph` | The graph itself. |
| **CodeGraph** | Settings → Plugins | All configuration. |

- **The nav entry is a link, not a panel.** Built with
  `useHostNavigation().linkProps()`, which resolves the company prefix, returns a
  real `href` so middle-click and copy-link work, and — as the host's own
  implementation does — closes the mobile drawer on navigation. A nav column is
  for going places; the controls moved out of it.
- **Configuration is back**, owned by the settings page: enable, auto-install,
  auto-index, the CodeGraph executable, and allowed repository directories. It
  reads and writes `/api/plugins/:pluginId/config` and **merges** into the stored
  document, so a key this form does not show (0.6.0 wrote seventeen) is never
  dropped on save.
- **Everything else moved into Settings** — repositories with file/node counts and
  Index now / Rebuild, and the per-agent switches.

## Testing

314 tests across 16 files. New here:

- **13 for the operator config** (`readOperatorConfig`, `mergeOperatorConfig`).
  One caught a real defect: `{...[1, 2]}` spreads an array into `{0: …, 1: …}`
  rather than a document, so `mergeOperatorConfig` now rejects arrays the same way
  `readOperatorConfig` does. The round-trip test also pinned down that saving must
  write all five fields, because the schema is closed and the server validates
  against it — a partial document is not a valid one.
- **9 for the nav entry's status** (`sidebarStatus`). These pin the rule the rest
  of the plugin runs on: absence means allowed. Unknown readiness is `unknown`,
  **not** "switched off", so a first render never flashes a false problem.

## Upgrading

```
paperclipai plugin install paperclip-codegraph@0.9.1
```

Adds a nav entry and restores the config form, so Paperclip must reload the
plugin manifest.
