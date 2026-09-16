# paperclip-codegraph v0.9.8

The graph page is now modelled on CodeGraph's own UI, and the task-bar badge no
longer lies about an organisation that has a repository.

## The task bar said "No repository in this company yet" — on an org that had one

Same root cause as the Status line fixed in 0.9.6, in a second place I missed: the
nav entry read the `readiness` handler, which reports the governance **binding**
(`resolved.project` out of the governance document) rather than the repositories
the organisation actually has.

`dealthai` was the proof. Its workspace is a git repository with a complete index —
and because it had no governance binding, the nav announced there was no repository
at all. (My first check of that workspace said otherwise, because the project
directory is `drwx------` and I was reading it as root; the worker runs as `node`
and sees it fine. Worth recording as a lesson: check as the user the code runs as.)

The nav now reads `graph-projects` — **the same handler the settings page uses** —
so the badge and the page cannot disagree. It also distinguishes two cases that need
different fixes: *no repository in this organization* versus *every repository
switched off*.

## The page now mirrors `codegraph ui`

I read the real viewer rather than inventing a design: it runs on port 4747, so its
DOM structure, its palette and its layout are all inspectable. What it does is a
**reader**, not a diagram:

```
callers  |  the symbol's verbatim source  |  callees
```

and the detail that makes it work is that each callee is drawn **beside the line
that calls it**. A call graph as a diagram answers *what is connected to what*;
aligned with the source it answers *where does this happen*, which is what someone
reading code actually asks.

So the layered diagram is gone from the page, replaced by:

- **a topbar** — brand, repository, search, and index state, as the viewer has;
- **the three panes**, with the source in the middle and a real line-number gutter;
- **tinted source lines** wherever the symbol calls something, so the
  correspondence with the right-hand pane is visible without hunting for it;
- **results grouped by symbol kind** (Functions, Interfaces, Imports…), with a
  glyph and `file:line` per row, as the viewer lists them;
- **a footer** naming what is being read, with a way back — the "back button" that
  was missing;
- **CodeGraph's own palette**: warm paper (`#f7f6f2`), one ink scale, one accent
  (`#7a2230`), IBM Plex Mono for code. Deliberately *not* the host's tokens — this
  is a light reading surface, and inheriting a dark theme would break it. Settings
  and the nav entry stay on the host's tokens.

### A repository selector when the org has more than one

Shown in the topbar only when more than one repository is available, since the
graph is per repository while search spans them. With one repository it shows the
name instead of a one-item dropdown.

### New data, and new plumbing for it

- `graph-reader` returns the three panes in one request — three round-trips would
  show the panes arriving at different times. Callers and callees carry the line in
  *their* file that makes the call, resolved to names server-side so the client does
  not look up ids it cannot see. Each side is capped at 40 with the true counts
  reported, because a widely-called helper has hundreds and none are useful past a
  screenful.
- `EDGE_COLUMNS` now includes `line`, and `calleesOf` / `callersOf` are new. Verified
  against the real POS index: 4,405 `calls` edges, **all** carrying a line, while
  `contains` carries none — which is exactly why the reader filters on `line IS NOT
  NULL` rather than assuming every edge has one.
- The index fixture in the existing tests gained the `line` column, because the
  schema guard is supposed to fail when a fixture diverges from a real index — and
  it did.

## Testing

416 tests. New: 5 live queries against a real index and 5 pinning the reader's exact
payload shape — every callee must have a name, a file and a call line, or a row
would silently vanish from the alignment. Both skip unless `CODEGRAPH_TEST_PROJECT`
names an indexed repository:

```
npm run test:live     # CODEGRAPH_TEST_PROJECT=/path/to/repo
```

The bridge-key contract test also earned its place: it caught that this redesign
orphaned `graph-neighbourhood` — nothing calls it now that the page is a reader.
It stays registered and documented in `KEYS_WITHOUT_UI_CALLER`, along with
`src/graph/layout.ts` and its 20 tests: a diagram is still the right shape for the
question the reader does not answer — "what does this blast radius look like".

## Upgrading

```
paperclipai plugin install paperclip-codegraph@0.9.8
```

No manifest change. If the task bar showed the wrong repository state, reload to be
sure you are on this build.
