# paperclip-codegraph v0.12.6

v0.12.5 made the agent path descend into a project's checkout. It descended too
eagerly, and this corrects that.

## What was wrong

The rule v0.12.5 added was "the index lives at the checkout, so a folder that holds one
is the wrong path". Checking it against the host that reported the original problem
showed the premise is only half true. CodeGraph **searches upward** for `.codegraph`:

```console
$ cd …/0925bda0-…/_default/dealthai && codegraph status --json
{ "projectPath": "…/_default",              ← resolved upward
  "indexPath":   "…/_default/.codegraph",   ← the container's index
  "fileCount": 129, … }
```

So `dealthai` — the shape v0.12.5 was written for — was *already* answered for. Its
index is at the container folder, and the old behaviour of handing CodeGraph
`_default` worked. Applying the descent unconditionally:

- **hid a working index.** A call would be resolved to `_default/dealthai`, where
  there is no `.codegraph` of its own.
- **and broke it further.** `ensureIndex` checks the path it is handed, would not find
  one, and with `autoIndex` on would run `codegraph init …/_default/dealthai` — a
  **second** index of the same code, 5 MB of it, and a different index answering
  afterwards. With `autoIndex` off — the default — the agent simply got *"Project
  …/dealthai has no .codegraph index"* on a repository that is indexed.
- **and misreported it.** The settings page already showed the row as `Not indexed`,
  because the check was made at the checkout. Pressing *Index now* would have built
  that second index by hand.

(The multi-repository half of v0.12.5 was right and is unchanged: nothing indexes the
container of a project holding six checkouts, so descending is the only way to reach
one.)

## What it does now

An index that already exists wins. `resolveCheckout` takes an injected `hasIndex`: when
the configured folder already answers, the path is kept exactly as it was, and the
descent only applies to a folder that does **not** answer. The rule is now:

> Read and build where the index already is. Otherwise, find the checkout.

The same rule governs all three places the question comes up:

| Surface | Before | Now |
|---|---|---|
| an agent's tool call | descends, misses the container index, may build a second | keeps the folder when it answers |
| a row's *Indexed* state | checked at the checkout only | checkout **or** the folder holding it |
| *Index now* / *Rebuild* | targeted the checkout, building a second index | targets wherever the index already is |

`readiness` and `index-status` are deliberately left alone: they probe a path an
operator explicitly bound, and "is there an index at the path you bound" is a
defensible meaning for a diagnostic. Changing it there would make the surface used to
debug this harder to reason about, not easier.

## Verified against every project on the reporting instance

The decision code was run against all six companies and every project folder, with the
real filesystem and the real indexes:

```
DEL 8f393fa5 _default: wsIndexed=true  effective=_default  rows=[(root):shown=true]
DEA 0925bda0 _default: wsIndexed=true  effective=_default  rows=[dealthai:own=false,shown=true]
VRO e77f5825 _default: wsIndexed=false effective=REFUSED [vroomy-backend, …, vroomy-superproject]
REG 2ccfb99b _default: wsIndexed=false effective=REFUSED [regency-app, regency-os]
SAK 5ebdaf48 pos:      wsIndexed=true  effective=pos       rows=[(root):shown=true]
SAK 3b2a1745 pos:      wsIndexed=false effective=pos       rows=[(root):shown=false]
GLU b1616c4b _default: wsIndexed=false effective=_default  rows=[(root):shown=false]
DEL 1fa33d8c _default: wsIndexed=false effective=_default  rows=[]          (no code)
```

Every project that was working keeps the exact path it had. `dealthai` shows its row as
indexed and resolves to the index that exists. The two multi-repository projects are
refused by name, which is the intended behaviour for a project nobody has bound a
repository for.

## Verification

`resolveCheckout` covers the pair directly: the same directory with `hasIndex` true
keeps the folder, with `hasIndex` false descends — the two tests differ in nothing else.
`tests/project-discovery.spec.ts` asserts the row for a checkout whose container holds
the index reads `indexed: true` and that a row with no index anywhere still reads
`false`. `tests/repository-selection.spec.ts` asserts a container that answers is
**not** refused even while holding several checkouts.

`npm run verify` — typecheck, build, 527 tests, all passing.
