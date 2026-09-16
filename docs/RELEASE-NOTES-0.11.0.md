# paperclip-codegraph v0.11.0

**The hand-built graph page is removed.** The plugin now does the part it is
actually for, and nothing else.

## Why it came out

For several releases this plugin shipped its own reader: a three-pane Symbol view,
an architecture Map, entry points, and a dead-code list. Every one of those already
exists in **CodeGraph's own UI, and is better.** That UI is under active
development — its own unreleased notes add a Screens tab, rework the Steps layout
several times over, and change the very map and screen layouts this plugin had
reimplemented.

So the reader could only ever fall behind, and the hours spent on it were hours not
spent on the part that is genuinely pluggable. It is gone.

## What was investigated first, and why reuse was not adopted

The adapter seam in CodeGraph's UI is real, and it was tested rather than assumed:

- `ui/src/lib/api.ts` is explicit — *"a host that already holds the index — the Pro
  app — installs its own"* adapter. `GraphAdapter` is 14 methods, with `steps`
  optional and `trails` explicitly specified to answer `{trails: [], readOnly: true}`
  so a host shows the section as empty rather than a dead Save button.
- Their UI **builds standalone** from `ui/src` with Vite and svelte — 1.40s.
- A proof of concept ran **their real Map view against this plugin's data**: 40
  module boxes, their legend, their "foundations — depend on nothing below"
  caption, no page errors.

It was still not adopted, for a reason that only showed up when checked:

- their `ui` package is `private: true` and **not published to npm**;
- the built viewer ships **inside a 123 MB vendored Node runtime**, not as assets
  that can be served;
- installing from git gives only `files: ['dist','scripts','README.md']` — **no
  `ui/` source**.

So consuming it means a build step that fetches and builds their source on every
update, plus implementing 16 API endpoints against `wire.ts` (1,033 lines, 78 types).
That is a real maintenance commitment, and the proof of concept found a bug of
exactly the kind it would keep producing: the module dependence counts came out
**398 where theirs said 36**, because counting all cross-module edges is not the
same as counting files that reference in. The picture looked right; every number
was wrong. A screenshot would not have caught it.

## What the plugin is now

| Surface | Where |
|---|---|
| **CodeGraph** | the nav column — index state at a glance |
| **CodeGraph** | Settings → Plugins — all configuration |

And behind them, what Paperclip actually needs from a plugin:

- the eight CodeGraph tools, **governed and audited** through Paperclip's tool
  gateway, with per-project and per-agent narrowing;
- the **MCP wiring** that makes those tools reachable by an agent at all;
- **repository resolution** — a repository is a Paperclip project's workspace,
  never a path an agent types.

To read the graph, run `codegraph ui` on the host. It is a local, read-only viewer
for the project you already indexed and needs no Paperclip wiring.

## Removed

- `src/ui/page.tsx`, `map-view.tsx`, `views-panels.tsx`, `views.ts`,
  `route-sidebar.tsx`, `reader-layout.ts`, `search-intent.ts`, and their tests.
- The `page` and `routeSidebar` manifest slots, and the `ui.page.register`
  capability — which also means the host's Back button no longer applies, because
  there is no page to go back from.
- Eight data handlers that only the reader used: `graph-reader`, `graph-map`,
  `graph-entry-points`, `graph-dead-code`, `graph-search`, `graph-neighbourhood`,
  `graph-source`, `graph-diagnose`.
- The nav entry is a status row rather than a link, since there is no longer a page
  to link to.

Kept: the settings page in full (configuration, Activate, repositories, indexing,
exceptions), the nav entry's index state, and every tool and governance path.

**Bundles:** UI 130 KB → **51 KB**, worker 737 KB → 707 KB.

## Testing

463 tests, 458 passing and 5 skipped. Removing views removed their tests too —
which is the honest accounting: this is a smaller plugin, not a better-tested one.

## Upgrading

```
paperclipai plugin install paperclip-codegraph@0.11.0
```

The manifest changed — two slots and a capability came out — so Paperclip must
reload the plugin. Any bookmark to `/:companyPrefix/codegraph` will 404.
