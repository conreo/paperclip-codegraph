# paperclip-codegraph v0.12.5

> **Corrected in [v0.12.6](./RELEASE-NOTES-0.12.6.md).** This release says CodeGraph's
> index "lives at the checkout, so handing it the folder one level above answers nothing
> at all". That is wrong for the case that mattered: CodeGraph searches **upward**, so a
> project indexed at its container folder is answered for from its checkout, and the
> agent path was not broken for `dealthai` at all. The descent introduced here did fix
> multi-repository projects — nothing indexes the container of one — but applied
> unconditionally it hid the container index and would have built a second one inside
> the checkout. v0.12.6 makes the descent conditional on the folder not already
> answering. The rest of this note stands.

The agent side of the same defect v0.12.4 fixed on the settings page.

## The gap

v0.12.4 made the settings page find the checkouts inside a project's container folder.
It left the **agent** path alone, and that path had the identical bug:

```ts
projectPath = resolveProjectPath(bindingPathFor(binding.path, root), { … });
// → the workspace: <project>/_default
```

A binding — or the workspace Paperclip hands a run — names the project folder. For a
multi-repository project that folder holds every checkout and is not a checkout itself,
so CodeGraph was handed a path with no index in it. The repository is indexed on the
host; the agent gets *not indexed*; and there is nothing in the answer to say why.

So a plugin that lists six repositories and cannot read any of them is half a fix. This
is the other half.

## What a call does now

One function, `resolveCheckout`, applied to the path a call resolves to:

| The project folder holds | What the call reads |
|---|---|
| the checkout itself | it, unchanged — the ordinary case, byte-identical to before |
| exactly one checkout | that checkout — unambiguous, and plainly what was meant |
| several checkouts | **nothing.** Refused, with the repository names returned |
| no checkout | the folder, unchanged — it may be a package inside a monorepo whose index sits at an ancestor |

The last row matters as much as the others: a `git rev-parse` that finds an ancestor is
CodeGraph's own business to resolve, and rewriting the path there would move a working
monorepo deployment somewhere nobody bound.

## Why several is refused rather than guessed

The alternative was to read the first checkout, deterministically. It is deterministic
and it is wrong: nothing in a multi-repository project says which repository the
question was about, so the agent would answer out of, say, `acme-api` when the question
was about `acme-web` — a confident, well-sourced answer about the wrong codebase, which
is the worst failure mode code intelligence has. Quietly indexing one of six is worse
than refusing all six, because the refusal is visible.

The refusal had to be *actionable*, so it names what it found and what to do:

> CodeGraph project "vroomy" holds 6 repositories (vroomy-backend, vroomy-docs,
> vroomy-frontend, vroomy-infra, vroomy-proto, vroomy-superproject), so no repository
> is selected. Ask a Paperclip admin to bind one of them in the CodeGraph governance
> profile for your company.

The names are `relativePath`s — directory names relative to the workspace, the same
labels the settings page shows — so nothing about host layout is disclosed. The call is
recorded as `ambiguous_repository` with the candidate count, so "the agent said
CodeGraph refused" is answerable after the fact rather than a support round-trip.

## Also in this release

- `verify-scope` performs the same resolution, so it reports what a call would actually
  do instead of a path the call would have replaced.
- The Repositories section says `0 of 6 repositories indexed` for a multi-repository
  project rather than `Not indexed`, which hid how many there were to do.
- Two stale comments: `graph-projects` was described as what "the graph view can draw"
  (there has been no graph view since 0.11.0 — it is what the settings page and the nav
  column read), and `repositories` explained indexing under a note about `alias`.

## Upgrading

No configuration change, and no behaviour change for a project that holds one
checkout. A project that holds several will now *refuse* agent calls it previously
failed to answer usefully — that is the intended difference, and the fix is a
governance binding to one of the checkouts it names.

## Verification

`tests/repository-selection.spec.ts` runs the real registered tool handler against a
real container folder: it asserts the refusal names all three repositories in order and
says what to do, that the audit row carries the candidate count, that a single nested
checkout is **not** refused, and that a binding outside `allowedProjectRoots` is still
refused by containment before the repository check runs at all.

`tests/git-identity.spec.ts` covers `resolveCheckout` directly, including the two cases
that must not change: a path that is already a checkout is returned unchanged, and a
path with no checkout is left alone.

`npm run verify` — typecheck, build, 521 tests, all passing.
