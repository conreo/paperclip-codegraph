# paperclip-codegraph v0.9.6

Fixes a settings page that contradicted itself and never re-read its own facts.

## Status said "No repository yet" above a list of one

An operator on org `delthai` saw this on one screen:

```
Status
✗ No repository yet. One appears once an agent runs in a Paperclip project.

Repositories
Onboarding (dealthai)

Indexing
Onboarding — 640 files · 12085 nodes
```

The status line was not wrong about the thing it was reading; it was reading the
wrong thing. It reported the governance **binding** while the list reported the
org's actual projects. `readiness` resolves `resolved.project` out of the
governance document, and on an org that was never given a binding that is empty —
even when a project has a repository workspace and a complete index.

Bindings are an **override** mechanism, not a declaration of what exists. Status
now reports the repositories the page actually lists:

- `1 repository, indexed` — or `N repositories, M indexed`
- `N repositories, none indexed yet — use Index now below`
- plus `N repositories are switched off for this organization` when any are

One fewer thing reads the governance document to answer a question about the
filesystem.

## Nothing ever re-read

`usePluginData` fetches once per mount and then holds that answer. Everything on
this page can change outside it:

- an **agent created** in another tab — this is "what happened to new agents?":
  the list was fetched when the section first rendered and had no reason to
  re-read;
- a **workspace added** to a project, so a repository that should be listed was not;
- an **index built** by the CLI, or finished by a previous press of a button.

The page now re-reads when the tab becomes **visible** again — which is exactly
when someone comes back to a page they left open, and precisely when a new agent
or project should appear — and on window **focus**, which is what actually fires
when switching back from another window on the same screen. Every action that
changes something (index, rebuild, repository switch, agent exception) re-reads
too, and there is an explicit **Refresh** button for the operator who would rather
not guess.

Deliberately **not** a polling interval: a background tick would spawn a `git`
process per project, on a page nobody is looking at, to change a number nobody is
reading.

## Indexing no longer asks you to reload

The old copy was *"Rebuild started. Reopen this page to see it finish."* That
sentence existed because the page could not refresh. It now says the counts are
updated, and they are.

## Notes on the reported screen

- **`Onboarding (delthai)`** — the project is genuinely named *Onboarding*; the
  parenthetical is your repository name, taken from the git remote. So the row is
  a real repository with 640 files, and the alias is correct.
- **`dealthai` vs `delthai`** — these are two different organizations on the
  instance (10 agents and 34 agents respectively), not a display bug.

## Testing

395 tests across 23 files. New: 14 for the refresh wiring and the Status
correction.

One of them **caught a read I had missed**: `RepositoryAccess` still lacked the
refresh revision, so switching a repository off would not have updated the Status
line directly above it. The check compares each `usePluginData` call textually —
selecting calls by matching parentheses rather than a brace regex, because a brace
regex reads as if it works and silently matches the wrong span.

The hook is split from its decision on purpose: `refresh.ts` imports React, which
is a *peer* dependency and therefore absent from `node_modules`, so a test that
imports it cannot run. `refresh-signal.ts` has no imports, so the rule stays
testable — and that rule is the part that can be wrong in both directions, a stale
page or a refresh loop.

## Upgrading

```
paperclipai plugin install paperclip-codegraph@0.9.6
```

No manifest change, so no reload is strictly required.
