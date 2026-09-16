# paperclip-codegraph v0.9.0

The graph, drawn. A new page at `/:companyPrefix/codegraph` shows what the
index knows: search a symbol, see its callers above and callees below, click a
node to read its source.

This release also fixes the error that made the graph data unusable in 0.8.0.

## The bug this fixes

`graph-search` and `graph-neighbourhood` returned `{"error":"Internal server
error"}` through the plugin bridge. The cause was not in those handlers — they
were **never in an installed build**. The bridge registers data handlers by key,
and its lookup throws when a key is absent:

```js
// packages/plugins/sdk/src/worker-rpc-host.ts
const handler = dataHandlers.get(params.key);
if (!handler) throw new Error(`No data handler registered for key "${params.key}"`);
```

That throw reaches Paperclip's global error handler, which answers `500` with
`{"error":"Internal server error"}` and no further detail. The handler logic was
correct throughout; the version on the instance simply predated it.

The lesson is recorded here because it cost real time: a handler that is absent
and a handler that is broken are indistinguishable from the client, so confirm
which build is installed before reading the code.

## The page

A call graph is wide and tall at once, so it gets a page rather than a panel —
the sidebar is a narrow column and cannot show one.

- **Repository** — which of this org's projects to draw. Indexed repositories
  are offered first; an unindexed one says so instead of drawing nothing.
- **Find a symbol** — search the index by name or qualified name.
- **Depth** — 1–3 hops, capped at 250 symbols, and the page says when it capped.
- **The graph** — click a node for its source, double-click to re-centre.
- **Source** — a bounded, line-numbered excerpt with file and line range.

### Layered, not force-directed

This is the design decision worth stating. Position means *distance in the call
graph*: callers above the symbol you searched for, callees below, one row per
hop. A force layout would scatter the same graph differently on every render and
answer no question; here the picture says something before you read a label.

Direction is taken from the edge itself, so `calls` and `references` are both
drawn without the plugin knowing which edge kinds exist — a kind it has never
heard of still reaches the operator instead of vanishing.

The layout is a pure module with 20 tests, which caught three defects that would
otherwise have shipped looking like "the graph is broken":

- **ranks collapsed onto one row** — every row was positioned at the same `y`,
  so a two-hop graph drew as a single line;
- **self-edges were drawn twice** — dropped by the layout pass, kept by the edge
  pass;
- **a mutually-recursive neighbour flipped sides** by iteration order — it is
  both caller and callee of the seed, so it now lands beside the seed.

### Reading source is bounded

`graph-source` returns a line-numbered excerpt for one symbol. Reading a file is
the one place this plugin touches bytes rather than an index, so both the read
and the result are capped (60 lines, 256 KB), and `readExcerpt` is its own
tested module.

`truncated` means "the range the index asked for was not shown in full". That
deliberately covers index drift: if the index claims a symbol runs to line 99 in
a 5-line file, the page says the working tree may have moved on since indexing,
rather than presenting a silently wrong excerpt.

## New capabilities and handlers

- `ui.page.register` — required by the host for a page slot, and the manifest
  tests now assert every slot's required capability is declared.
- `graph-projects` — lists this org's projects with index status. Kept separate
  from `repositories`, which runs `codegraph status` per repository: correct for
  a status page, wrong for a selector that loads on every visit.
- `graph-source` — the excerpt above.
- `nodeById` — an exact id lookup, separate from `searchNodes` so an id lookup
  is never expressed as a name search that happens to include the id as text.

## Upgrading

This release adds a page, so Paperclip must reload the plugin manifest. Install
by version explicitly — Paperclip pins `^<installed>`, and for a `0.x` version a
caret does not cross a minor release:

```
paperclipai plugin install paperclip-codegraph@0.9.0
```

## Testing

292 tests across 14 files, plus the live isolation suite. New here: 20 layout
tests and 15 excerpt tests.
