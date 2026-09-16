# paperclip-codegraph v0.10.0

All six views, zoom controls, a complete legend, a search that matches its own
placeholder, and two defects found in the process — one of them mine.

## The rail is complete

`Steps · Entry points · Map · Symbol · Flow · Dead code`, in CodeGraph's own order.
Two are now real, two were already, and two explain themselves.

| View | State |
|---|---|
| **Entry points** | 170 routes on POS, 139 with the handler each one calls. `route` is a node kind and a route's `calls` edge names its function, so this is reported, not guessed. Clicking a handler opens it in the reader. |
| **Dead code** | Real, and deliberately labelled weak — see below. |
| **Symbol**, **Map** | As before. |
| **Steps**, **Flow** | Listed, and explain why not. Both need call-path history (`codegraph ui` records trails in `.codegraph/ui/trails`) or a path search that would be a second implementation of a traversal CodeGraph already does properly. A view that opens fabricated content is worse than a view that says what is missing. |

## A defect in my own dead-code logic

The first version counted **`contains`** edges as references. `contains` is not a
reference — it is the file→symbol parent relation, and the index has one for every
symbol in it. So `referenced` came out equal to the symbol set and the view could
only ever return nothing. It did: 2,352 symbols scanned, 0 candidates.

With the four genuine kinds (`calls`, `imports`, `references`, `instantiates`) it
returns **6 candidates and sets aside 614 symbols as "in a file nothing reaches"** —
a different fact, reported separately because "this whole file is unreachable" and
"this symbol is unused" need different responses. `REFERENCE_EDGE_KINDS` now carries
that rule with a test named after the bug, plus a test that the worker actually
filters on it, because a constant nobody uses is just a comment.

The caveat stands and is printed above the list, not under it: this plugin has no
export analysis, so a symbol exported for another module can appear. CodeGraph's own
view excludes 215 exported and 63 mentioned-elsewhere names that this cannot.

## Search now matches its own placeholder

It said "Search a symbol or a file" and queried `name` and `qualified_name` only, so
typing a filename found nothing. `file_path` is now searched too, with name matches
ranked above path-only matches. A search that silently ignores half its placeholder
is a bug the operator has no way to diagnose.

The input itself is styled as the host's own: `h-9 rounded-md border-input px-3` with
the host's focus ring, a leading search icon, a clear button, and `/` as the keyboard
hint — plus Escape clearing then blurring, as the host's search does.

## Zoom and a complete legend on the map

**Zoom in, zoom out, reset, and the current percentage**, with drag-to-pan on the
background and ⌘/Ctrl-wheel to zoom. Zoom and pan are view state, so the layout never
rearranges itself underneath the reader. A click on a module is still a selection, not
a drag.

The legend is now the viewer's own Key panel: module, dependence bar, depends-on,
points-back-up, the layering rule, selected, nothing-depends-on-this, tests,
generated, and the hidden-weak count when there is one.

## Testing

503 tests, 486 passing and 17 skipped without an index. New: 28 for routes and the
unreferenced analysis, including the `contains` rule and the "always report every
exclusion reason, even at zero" case.

## Upgrading

```
paperclipai plugin install paperclip-codegraph@0.10.0
```

No manifest change beyond the route sidebar added in 0.9.11, so no reload is strictly
required.
