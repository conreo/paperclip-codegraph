# paperclip-codegraph v0.10.1

Chrome placement, a search bar that matches the viewer's, and one promise the
placeholder was making that this plugin could not keep.

## The Key is an overlay, bottom-left

It was a strip above the canvas, taking vertical space from the picture. It is now
an absolutely-positioned panel in the **bottom-left of the graph**, collapsible with
its `Key ▾` toggle, exactly as CodeGraph's own viewer has it — that is what the
overlay is in the original, verified by reading its geometry rather than guessing.

## Zoom and reset are an overlay, bottom-right

Same story: the controls moved from a toolbar to a compact vertical stack in the
**bottom-right of the graph**, in their own bordered card. Both overlays use
`pointerEvents: none` on the wrapper and `auto` on the contents, so drag-to-pan still
works through the gaps between them.

## The toolbar reads like the viewer's

- **Search is first and widest** (`flex: 1 1 520px`, capped at 720px — the viewer's
  own input measures 708px). It was previously squeezed behind a "CodeGraph" label
  and a repository name, which is why it looked cramped.
- **The "CodeGraph" label is gone.** The page it sits on is already called
  CodeGraph; the rail says so too. It was spending the width the search needed.
- **Repository and index state moved right**, where they change once a session
  rather than constantly.
- The placeholder is now the viewer's own: *Search a symbol or file, or ask "how
  does execute reach getFile" — press / to focus*.

## The placeholder was promising something this plugin does not do

That sentence offers a natural-language question, and treating it as a symbol name
returned *"No symbol matches"* — the search box failing at something it advertised.

A question is now **recognised** (`src/ui/search-intent.ts`, 8 tests, pure) and
answered with what is true: that answering it needs the path search behind
CodeGraph's own Flow view, which this plugin does not implement because it keeps no
call-path history — and then four things that do work, including opening either
symbol in the reader so the path can be followed by hand from either end.

Recognising the pattern also means the common case is protected: `createOrder`,
`orderEngine.ts`, `GET /api/health` and `src/api` are all still plain searches. The
parser only fires on a phrase with two distinct symbols and a path verb, and falls
back to a name search on anything malformed — a misread question would replace a
working symbol list with an explanation.

## Testing

511 tests, 494 passing and 17 skipped without an index. New: 8 for the question
parser, including the placeholder's own example and the cases that must *not* be
read as questions.

## Upgrading

```
paperclipai plugin install paperclip-codegraph@0.10.1
```

No manifest change.
