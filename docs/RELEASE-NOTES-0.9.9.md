# paperclip-codegraph v0.9.9

The reader now looks and behaves like part of Paperclip, and it adapts to the space
it is given.

## The nav entry sat outside the list it was in

It was drawn with its own padding and its own colours, so it read as a foreign
object in the nav column. It now mirrors the host's own `SidebarNavItem` rows
exactly — taken from that component's classes rather than guessed:

```
flex items-center gap-2.5 mx-2 rounded-lg px-2 py-1.5
text-(length:--text-compact) font-medium
active: bg-sidebar-accent text-sidebar-accent-foreground
idle:   text-foreground/80 hover:bg-sidebar-accent
```

Same rhythm, same inset pill, same hover, same `h-4 w-4` glyph slot.

## The page follows Paperclip's theme, not CodeGraph's

The previous release repainted the reader in CodeGraph's warm-paper palette —
`#f7f6f2`, `#7a2230`, IBM Plex Mono. It looked like the tool it was reading from,
and it looked like a foreign window inside Paperclip: it ignored the operator's
theme, and it was wrong in dark mode by construction.

Every value now comes from the host's own custom properties — `--background`,
`--foreground`, `--card`, `--muted`, `--muted-foreground`, `--border`, `--accent`,
`--primary`, `--ring`, `--font-sans`, `--font-mono` — so light and dark both work
without this plugin knowing which is active. The warm palette is gone from the
bundle entirely. Settings and the nav entry were already on the host's tokens.

Honest note on the trade-off: this is a deliberate reversal of the previous
release's instruction to *look like `codegraph ui`*. Matching the tool's own chrome
turned out to be the wrong goal — a page inside Paperclip should look like
Paperclip. The useful thing borrowed from that UI was its **layout**, and that
remains: callers | source | callees, each callee beside the line that calls it.

## It adapts to the space it is given

The three-pane reader is only readable when there is room for three columns, and
it was rendering them at any width — squeezed to slivers in a narrow host column.
Sizing had two bugs: `height: 100%` collapses when the wrapper has no height, and a
fixed height would overflow a short window.

- **Sizing** — fill the parent when it has a height, never exceed the viewport
  either way (`height: 100%` + `maxHeight: 100vh`), with `minWidth: 0` on the panes
  so a long symbol name cannot push one wider than its share.
- **Breakpoints** — a `ResizeObserver` on the page, not a media query: the host's
  content column can be narrow on a wide screen (a pinned sidebar, a split view), so
  viewport width is the wrong number to branch on. Three panes when
  `2 × 232 + 380` fits, two panes below that, stacked below one pane plus the
  source. The rule is a pure function with 6 tests, including the invariant that the
  source column never falls under its minimum in the layout chosen, checked across
  ~230 widths — and the unmeasured first render deliberately picks the *middle*
  layout rather than the widest, so the page does not render three columns and jump.

## The back button is gone

There is no back button on the page, and the footer is a status strip rather than
navigation. A plugin inventing its own back affordance duplicates chrome the host
already shows, and it was part of what made the page feel like a separate app.
Going back is the browser, the company nav, or history.

## View tabs, with only the views that are real

The viewer's tab row is reproduced — but listing only what this plugin can fill.
A tab that opens a fabricated view is worse than a tab that is not there:

| View | Status |
|---|---|
| **Symbol** | Real — the reader. |
| **Map** | Real — the layered callers/seed/callees diagram, using the same payload. |
| Steps, Flow | **Not offered.** They need call-path history, which the index does not carry. |
| Dead code | **Not offered.** It needs an unused-code analysis with export and reference awareness. A naive `no inbound edge` query returns **zero** candidates on the real POS index, because route and file nodes reference everything — so any list it produced would be a guess. |
| Entry points | Planned. `route` is a real node kind (173 on the POS index), so this is reachable; it is not listed until it works. |

The tab row says in one line why the missing views are missing, rather than
leaving an operator to wonder.

`graph-neighbourhood` now returns the seed, caller and callee shape alongside the
raw graph, so the Map view needs no second request and the two views cannot drift
apart. The bridge-key contract test caught that this reversed the previous
release's note about it being orphaned.

## Testing

422 tests, 412 passing and 10 skipped without an index.

## Upgrading

```
paperclipai plugin install paperclip-codegraph@0.9.9
```

No manifest change.
