# paperclip-codegraph v0.9.2

Two changes to how CodeGraph decides *whose code* and *which repository* — a
design correction and a detection improvement.

## Access is gated by repository, not by agent

The per-agent switches were the primary control, and that was wrong.

An agent's reach already follows the Paperclip project it is working in. That is
the organisational fact, and it changes when someone changes team. A per-agent
list is a **copy** of that fact which does not update when the fact does, so
access outlives the reason it was granted — the classic way permissions rot. It
also does not scale: one deployment here has ~77 agents and 2 repositories, and
the settings page rendered one checkbox per agent.

Now:

- **Repositories** is the primary control — which of this org's repositories
  CodeGraph may read. A switch per repository, and switching one off is the only
  edit, so it can only narrow.
- **Exceptions** holds the per-agent switches, collapsed by default, reframed as
  what they always were: revocation for one agent in cases the derived rules
  cannot express, such as a contractor whose access should not follow their
  project membership.

Neither control grants anything. `paperclip-codegraph` tools are default-denied by
Paperclip until a tool profile allows them, so the plugin narrows access Paperclip
has already granted — it never creates it.

### The write path

Both switches now use targeted, pure functions rather than the whole-form merge:
`setProjectAccess` and `setAgentAccess` (`governance/merge.ts`), with 15 tests.

The rules are the same rule as `mergeGovernance`, applied to one scope:

- **Narrowing only.** Re-enabling removes the disable flag rather than granting:
  the company binding still has to allow the repository, and Paperclip still has
  to allow the tool.
- **Nothing else is touched.** An override may carry a `projectKey` or a
  `policy`; re-enabling clears only `enabled` and keeps those, and an override
  holding nothing else is removed rather than left as an empty object.
- **`company.enabled` is never raised** — a repository cannot switch a company
  back on that an admin turned off.

A whole-form save was the wrong shape here: the caller knows about one
repository, so a form-shaped merge would let one repository's edit disturb
another's. `mergeGovernance` remains for the older whole-form surface.

## Repositories are detected from git

The plugin already recognised repositories without being told — that is why there
is no picker. It was reading identity from the folder name and looking for the
index at the workspace root, and both were approximations:

- **`git rev-parse --show-toplevel`** locates the repository root, so the index is
  read from where it actually is. For an ordinary checkout that is the workspace
  itself; when a project points *into* a checkout — a package inside a monorepo —
  the root is an ancestor, and looking for `<workspace>/.codegraph` would find
  nothing and report a problem that did not exist.
- **`git remote get-url origin`** supplies the label. A repository's identity is
  its remote, not the directory it was checked out into: `pos` from
  `path.basename` is right only because Paperclip names the managed folder after
  the repo, so a project pointed at `checkout-2` would be labelled `checkout-2`.
  Remote URLs are reduced to a name across the forms that occur — `https://`,
  `git@host:group/repo.git`, `ssh://`, and bare local paths — and a URL no name
  can be read from returns null so the folder is used rather than a mangled string.

**The tool path is unchanged.** `codegraph_*` tools still receive the
binding-resolved workspace path exactly as before; only identity and index
location use the git root, because changing what the MCP server is told would
alter verified behaviour for no benefit.

Everything degrades to the workspace path: no git binary, not a repository, no
`origin`, or a wedged git all fall back silently. A missing binary is not a reason
to refuse to draw a graph.

Git is resolved through the same search as `codegraph` (the worker is a
long-lived service often started with a minimal `PATH`), and the child gets no
credentials. The plugin deliberately does **not** scan the filesystem for
repositories: recognising what Paperclip has checked out is scoped to work the
operator already authorised, whereas walking the disk for git repositories would
turn a code-intelligence plugin into a discovery tool for everything on the host.

## Testing

349 tests across 19 files. New here:

- **16 for git identity**, driving it through an injected runner so the logic is
  pinned without a repository: subdirectory-of-monorepo, no origin, not a
  repository, missing binary (ENOENT), empty stdout, and every remote-URL form.
- **4 against real git** (`git-identity-live.spec.ts`). The injected-runner tests
  would pass while the runner itself was broken — wrong arguments, an ignored
  `cwd`, untrimmed stdout — so these shell out to the real binary, and skip when
  git is absent.
- **15 for the targeted access functions**, including that re-enabling keeps an
  attached `policy` and that `company.enabled` is never raised.

## Upgrading

```
paperclipai plugin install paperclip-codegraph@0.9.2
```

No manifest change in this release, so no reload is strictly required — but the
settings page is new UI and a reload is the surest way to see it.
