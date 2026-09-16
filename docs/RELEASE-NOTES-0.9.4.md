# paperclip-codegraph v0.9.4

Fixes the repository list reporting projects that are not repositories, names the
organization on every surface, and explains the one setting nobody could read.

## Projects that are not repositories were listed as repositories

`Repositories` showed **Onboarding — not indexed yet** and **Agent Platform — not
indexed yet**. Neither is a repository. A Paperclip project can exist with no code
at all — a backlog idea, a cancelled onboarding project — and the host still
resolves a managed folder for it, so the plugin listed a row that could not be
acted on and hinted it needed indexing.

A project is now listed only when it is a repository, decided two ways:

- **`workspace.repoUrl`** — Paperclip already knows whether the workspace is a
  repository, so its own answer is preferred over a guess; and
- **a `.git` entry at the repository root** — because a `git init` with no remote
  is still a repository, and trusting the URL alone would hide it.

`.git` is checked with a `stat` rather than a `git` call, and counts whether it is
a directory (a normal clone) or a file (a linked worktree or submodule).

Excluded projects are **counted, not hidden**, so the page still explains itself:

> 2 other projects in this organization are not listed: they have no repository
> workspace, so there is nothing for CodeGraph to read.

## The organization is named up front

Every surface now says whose code it is showing: **CodeGraph · SAK** on the
settings page and on the graph page, falling back to the URL prefix when the name
cannot be read.

This needed the `companies.read` capability back. It was removed in an earlier
release as unused, and the manifest test asserted its absence — that assertion is
now inverted, with the reason recorded. The host context carries only
`companyPrefix`, so the name has to come from `companies.get`. A failure to read
it omits the label rather than failing the page: the name is decoration, and no
page should break over decoration.

## "Allowed repository directories" now explains itself

The field was one line of prose that assumed the reader already knew the answer.
It now answers the three questions in order:

- **What it is** — a ceiling on where the plugin may look for code on the server.
  Any repository outside these directories is refused, even if an agent is working
  in it. It is *not* a list of repositories.
- **Why it exists** — the plugin runs on the Paperclip host and can read files.
  With it empty, it reads whichever repository a project points at, anywhere on
  disk. One directory per tenant is what stops one organization's CodeGraph
  reaching another's code.
- **When to set it** — if more than one organization shares this instance. On a
  single-tenant instance, leave it empty.

## On "POS — not indexed yet"

If POS still shows as unindexed after upgrading, reload the page: the check reads
`<repository root>/.codegraph/codegraph.db`, and `git rev-parse --show-toplevel`
resolves that root correctly on this instance (verified: the root is the project
workspace, and the 19 MB index there is readable by the worker's uid). A stale
render from before the upgrade is the likeliest explanation, and the
`skippedProjects` count and org name above make a repeat easy to spot.

## New: `graph-diagnose`, so "not indexed" is answerable

A repository that plainly is indexed showing as *not indexed* is not debuggable
from the browser — the plugin never discloses host paths, so a stale render and a
wrong resolution look identical. The `graph-diagnose` data key reports the chain
the plugin actually followed for one project:

```
POST /api/plugins/paperclip-codegraph/bridge/data
{ "key": "graph-diagnose",
  "params": { "companyId": "…", "projectId": "…" } }
```

It answers with `workspaceAccepted`, `workspaceAlias`, `repoUrl`, `gitRootAlias`,
`gitRootIsWorkspace`, `repositoryName`, `indexed`, `indexPathAlias`, `hasGitEntry`,
`gitAvailable` and `containmentRootCount` — enough to tell "the host gave no
workspace" from "git resolved elsewhere" from "the index is genuinely absent".
Paths are reduced to their last segment.

Writing it caught a disclosure bug in its own first version: it used `redactPath`,
which is built for **audit keys** (two trailing segments plus a hash), so a managed
workspace came out as `5ebdaf48-3f46-447f-b0f1-be65b0c6f189-pos-<hash>` —
disclosing the very project UUID it was meant to hide. `path.basename` is the right
tool for a label, and a test now pins that no host prefix or UUID survives.

## Testing

358 tests across 20 files. New: 5 for `isGitRepository` (the directory-vs-file
`.git` distinction a naive check gets wrong, plus the stat-failure path that must
not throw inside a listing loop) and 4 pinning what a diagnostic may disclose.

## Upgrading

```
paperclipai plugin install paperclip-codegraph@0.9.3
```

The manifest changed (`companies.read`), so Paperclip must reload the plugin.
