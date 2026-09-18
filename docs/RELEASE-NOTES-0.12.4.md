# paperclip-codegraph v0.12.4

A project's repository is now found wherever it actually is, not only at the folder
root.

## The report

On the `VRO` organization the dashboard said **no repository**, on a host that held six
of them. The question was the right one — *why is my repo not detected?* — and the
answer was that the plugin was asking the wrong question about the workspace.

## What was wrong

`graph-projects` and `repositories` resolved a project's workspace and then required
**the workspace itself** to be a checkout:

```ts
// before
if (!workspace?.repoUrl && !(await isGitRepository(indexAt))) {
  skipped += 1;
  continue;
}
```

That is true of the simplest deployment — one project, one clone, `.git` at the top —
and false of the shape Paperclip actually creates for a multi-repository project. A
managed folder is a **container**:

```
<company>/<project>/_default/          ← the workspace, not a repository
├── vroomy-backend/    .git
├── vroomy-frontend/   .git
├── vroomy-docs/       .git
├── vroomy-infra/      .git
├── vroomy-proto/      .git
└── vroomy-superproject/ .git
```

`VRO`'s project has no `repo_url` and no `.git` at `_default`, so both halves of the
guard were true and the project was **silently skipped**. Not "not indexed" —
invisible. `dealthai` was broken the same way one level down (a single checkout in
`_default/dealthai`), which is why that organization's plugin showed nothing to
configure while its code was indexed on the host.

## What it does now

`findRepositories` walks the workspace and its **immediate children** — two depths,
deliberately, because a deep search eventually finds a vendored checkout inside
`node_modules` and indexing a repository nobody meant to index is worse than not
finding one. Every checkout it finds becomes its own row:

- **its own identity.** A `repositoryKey` — the path relative to the workspace, `""`
  for the workspace itself. A directory name, never an absolute path, so it is safe to
  render, safe to log, and safe to send back. `index-now` takes it, so *Index now* on
  the third of six checkouts indexes that one.
- **its own name.** A project with one checkout keeps the project's name, because that
  is the label the operator gave it. A project with six cannot — six rows all called
  "Vroomy" is not a list — so each names itself from `origin` and the project becomes
  the aside.
- **its own index state**, and its own *Index now* / *Rebuild*.

The Repositories section now **groups by project**, because the on/off switch is a
per-project control: six identical switches that all move together is not a decision,
it is a puzzle. The switch belongs to the project, and its checkouts are listed under
it. The Index section stays one row per checkout, because indexing is per repository.

## Two cases that keep working

The guard existed for a reason, and both reasons are preserved rather than dropped:

- **A project pointing *into* a larger checkout** — a package inside a monorepo. The
  workspace holds no `.git` and no child repository, so discovery alone would answer
  "no repository" for a project that is plainly in one. Paperclip's own `repo_url`
  keeps that project listed as a single candidate, and `git rev-parse` still resolves
  the ancestor where the index lives.
- **A checkout that is not on disk yet.** Same fallback, and a row saying "not indexed"
  is more useful than the project vanishing.

A folder with no code at all — a backlog idea, a cancelled onboarding project — is
still not a repository and is still counted rather than listed, so *"nothing here"*
stays distinguishable from *"three projects, none with code"*.

## Also in this release

- **The README's troubleshooting section described a data key 0.11.0 deleted.**
  It documented `graph-diagnose` and a JSON payload it can no longer return — no
  handler is registered for that key, so an operator following the documented `curl`
  got `No data handler registered for key "graph-diagnose"`. The section now reads
  `graph-projects`, which is what the page itself reads, and shows how to tell the
  three causes apart from its output.
- `repositoryKey` is recorded in the index audit row, so an index built for the wrong
  checkout of a multi-repository project is visible after the fact.

## Upgrading

No configuration change. Organizations that were showing no repository may show
several after this upgrade; nothing is indexed automatically, so the first thing to do
is press **Index now** on the checkout you want.

## Verification

`tests/project-discovery.spec.ts` runs the registered `graph-projects` handler over
real temporary workspaces in both shapes, built with real `git init` and a real
`origin`. It asserts the six-repository project yields six rows, the nested
single-checkout project yields one, the ordinary project is unchanged, a project with
no code still yields none, and **no absolute path appears anywhere in the response**.
Each of those tests also asserts the old predicate would have skipped the project,
so the regression is stated rather than described.

`tests/repository-rows.spec.ts` covers the naming rule (including an empty
`repositoryKey` being a key and not a missing value, which is what would silently
index the wrong checkout), and `tests/git-identity.spec.ts` covers discovery itself,
including the `repo_url` fallback and the fact that it does not fire when a checkout
was already found.

`npm run verify` — typecheck, build, 511 tests, all passing.
