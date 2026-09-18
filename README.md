# paperclip-codegraph

**CodeGraph's code-intelligence MCP tools for [Paperclip](https://github.com/paperclipai/paperclip) agents — governed per company, per project, and per agent.**

[CodeGraph](https://github.com/colbymchenry/codegraph) builds a local, pre-indexed
knowledge graph of a codebase and exposes it over MCP. Paperclip is a
multi-tenant control plane for AI agent "companies". Putting CodeGraph at the
*process* level in a multi-org deployment means every agent can read every
repository on the host. This plugin moves that decision into Paperclip, where it
belongs: an admin binds each company to its own repositories, and agents can
only ever reach the codebase they were granted.

```
Company A ──┐                          ┌── repo A  (.codegraph index)
            ├── paperclip-codegraph ───┤
Company B ──┘                          └── repo B  (.codegraph index)
```

## Contents

- [What it does](#what-it-does)
- [How it fits Paperclip](#how-it-fits-paperclip)
- [Requirements](#requirements)
- [One-command install](#one-command-install)
- [Configuration](#configuration)
  - [Instance / company config](#instance--company-config)
  - [Governance profiles](#governance-profiles)
- [Multi-org governance examples](#multi-org-governance-examples)
- [Tools exposed](#tools-exposed)
- [Where it appears in Paperclip](#where-it-appears-in-paperclip)
- [Why `projectPath` is not exposed](#why-projectpath-is-not-exposed)
- [One project, several repositories](#one-project-several-repositories)
- [Choosing between the two integration paths](#choosing-between-the-two-integration-paths)
- [Verifying an install](#verifying-an-install)
- [Bringing it up on a real instance](./docs/RUNBOOK.md)
- [Audit](#audit)
- [Security model](#security-model)
- [Limitations and assumptions](#limitations-and-assumptions)
- [Development](#development)
- [License](#license)

## What it does

- Registers CodeGraph's eight MCP tools as **Paperclip agent tools**, via the
  official Plugin SDK (`ctx.tools.register`) and Paperclip's tool gateway.
- Lets you **configure CodeGraph centrally** — the MCP command and args, which
  paths each company may read, which tools are allowed or denied, and whether to
  auto-install the CLI or auto-build an index.
- Supports **many CodeGraph projects per instance** (monorepos, many orgs) by
  binding a `projectKey` → absolute path per company, with per-Paperclip-project
  and per-agent overrides on top.
- Enforces **cross-tenant isolation by construction**, not by a check that could
  be forgotten. See [Security model](#security-model).
- Produces **audit entries** for every governance decision, on top of the ones
  Paperclip's own gateway already writes for every tool call.
- Is **optional and inert until an operator turns it on**.

## How it fits Paperclip

Two independent governance layers apply to every call, and this plugin neither
duplicates nor bypasses Paperclip's:

| Layer | Decides | Enforced by |
|---|---|---|
| Paperclip profiles, policies, bindings | *May this agent call this tool at all?* | Paperclip's tool gateway — core, unwriteable by the plugin |
| This plugin's governance document | *Whose codebase, and which CodeGraph tools, for this scope?* | The plugin worker |

The path taken by one call:

```
agent calls paperclip-codegraph:codegraph_explore
  │
  ├─ Paperclip tool gateway
  │    policyService.decide() over profiles / policies / bindings
  │    writes tool_gateway.call_allowed + a tool_invocations row + a call event
  │
  ├─ this plugin's worker
  │    re-check enabled → validate args → resolve governance for
  │    runCtx.companyId/projectId/agentId → decide this tool → sanitize the path
  │    → ensure index (only if autoIndex) → inject projectPath
  │
  └─ stdio JSON-RPC to `codegraph serve --mcp` (with CODEGRAPH_MCP_TOOLS set)
       real source code comes back, clamped, then host content-guards run
```

Because plugin tools are registered as `providerType: "paperclip_plugin"`,
Paperclip applies its normal **default-deny**: until an operator writes a tool
profile that includes them, a CodeGraph tool is not callable by any agent. That
is intentional and is the strongest statement of the design — *installing this
plugin grants nothing*.

> Plugin tools carry no `applicationId` / `connectionId` / `catalogEntryId`, so
> in a Paperclip profile they can only be selected with `selectorType:
> "tool_name"` or `"risk_level"` entries. All eight CodeGraph tools are
> query-only, so Paperclip's name-based risk inference classifies every one of
> them as `read`.

## Requirements

- **Paperclip** `>= 2026.817.0`. Verified against `2026.817.0` in
  `local_trusted` mode.
- **CodeGraph CLI** `1.6.0` on the machine running the Paperclip server:
  `npm install -g @colbymchenry/codegraph@1.6.0`
- **Node.js `>= 24.11.0`** for the Paperclip server itself (its own engine
  requirement). CodeGraph ships its own bundled runtime, so it does not matter
  which Node the CodeGraph CLI is launched from.
- No database, no network, no credentials. CodeGraph is local-only.

## Upgrading

Paperclip records the installed plugin as a caret range — `"paperclip-codegraph":
"^0.7.1"` — in `plugins/package.json` inside its own data dir. For a pre-1.0
package a caret does **not** cross a minor: `^0.6.0` means `>=0.6.0 <0.7.0`.

Two consequences worth knowing before you file a bug:

- **A bare `plugin install paperclip-codegraph` on an already-installed instance
  is a no-op.** npm sees the pinned range already satisfied, reports "up to date",
  and never looks at the new release.
- **Install the version explicitly** to move across a minor:

  ```bash
  paperclipai plugin install paperclip-codegraph@0.7.2
  ```

  The installer rewrites the pin, so the range tracks what you last installed.

If `plugin install` reports a version you did not ask for, check
`<paperclip home>/plugins/package.json` — the pin, not the registry, is deciding.

## One-command install

```bash
paperclipai plugin install paperclip-codegraph
```

Or from a checkout, which is how local development works:

```bash
git clone https://github.com/conreo/paperclip-codegraph.git
cd paperclip-codegraph
npm install && npm run build
paperclipai plugin install .
```

The plugin installs **disabled**. Nothing changes for any agent until you
configure a company (below).

## Configuration

Two layers, deliberately separate.

### Instance / company config

An operator-owned envelope: how to launch CodeGraph and what the safety limits
are. Set it per company (Paperclip plugin config is company-scoped):

```bash
paperclipai plugin config:set paperclip-codegraph -C <companyId> --payload-json '{
  "enabled": true,
  "codegraphCommand": "codegraph",
  "codegraphArgs": ["serve", "--mcp"],
  "allowedProjectRoots": ["/srv/checkouts"],
  "autoInstall": false,
  "autoIndex": false,
  "allowTelemetry": false,
  "useDaemon": false,
  "callTimeoutMs": 60000
}'
```

**Five settings are exposed.** They are the ones a normal operator has to decide:

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Turn CodeGraph on for this company. While off, every call is denied. |
| `autoInstall` | `false` | Install CodeGraph on the server if it is missing. |
| `autoIndex` | `false` | Index a repository the first time it is queried. |
| `allowedProjectRoots` | `[]` | Repositories must live under one of these. Recommended with more than one company. |
| `codegraphCommand` | `codegraph` | The executable to run. Set an absolute path if it is not on the server `PATH`. |

Everything else is a **code default an operator cannot reach**: `codegraphArgs`,
`codegraphVersion`, `useDaemon`, `callTimeoutMs`, `indexTimeoutMs`,
`startupTimeoutMs`, `maxResultChars`, `extraEnv`, `auditProjectPaths`,
`defaultProjectPath`, `bindDefaultProjectForUnconfiguredCompanies`.

That is deliberate, not a stub. Paperclip validates saved config with Ajv against
this schema and the property set is closed, so an unexposed key always takes its
default — which is why `useDaemon` (a multi-tenant footgun) and the internal
timeouts are not on the page. The runtime still understands them, so re-exposing
one is a schema change plus a deliberate test edit rather than new code.

> `defaultProjectPath` and `bindDefaultProjectForUnconfiguredCompanies` being
> unexposed is what makes isolation the default posture: a company with no
> governance entry is denied outright rather than falling back to a shared
> repository.

### Governance profiles

The plugin's own document: which codebase each scope may read and which tools it
may call. Set it with the `set-company-governance` action.

```jsonc
{
  "enabled": true,
  "defaultProjectKey": "web",
  "projects": {
    "web":  { "projectKey": "web",  "path": "/srv/checkouts/acme-web",  "displayName": "Acme web" },
    "libs": { "projectKey": "libs", "path": "/srv/checkouts/acme-libs", "displayName": "Shared libs" }
  },
  "projectsByPaperclipProject": {
    "<paperclipProjectUuid>": { "projectKey": "libs" }
  },
  "agents": {
    "<paperclipAgentUuid>": { "projectKey": "web", "policy": { "allowedTools": ["codegraph_explore"] } },
    "<otherAgentUuid>":      { "enabled": false }
  },
  "policy": {
    "allowedTools": ["codegraph_*"],
    "deniedTools":  ["codegraph_impact"]
  }
}
```

**Precedence, broadest to narrowest:** instance defaults → company → project
binding → Paperclip project → agent.

**The algebra is narrowing-only.** This is the property that makes an override
safe for a non-admin to write:

- `deniedTools` **unions** across every applicable scope. Once any scope denies a
  tool, no narrower scope can re-grant it.
- `allowedTools` **intersects** across every declared list. A present but empty
  list (`[]`) denies everything at that scope.
- A project or agent override can only *name* a binding the company already
  owns. It cannot introduce a path.

So a misconfigured override is at worst a denial of service. It is never an
escalation.

Tool entries accept exact names or `*` globs (`codegraph_*`, `*`).

## Multi-org governance examples

### 1. Two companies, two repositories, fully isolated

```bash
# Company A may read only acme-web.
curl -fsS -X POST "$PAPERCLIP_API_URL/api/plugins/$PLUGIN_ID/bridge/action" \
  -H 'Content-Type: application/json' \
  -d '{"key":"set-company-governance","companyId":"'$COMPANY_A'","params":{
        "companyId":"'$COMPANY_A'",
        "governance":{"enabled":true,"defaultProjectKey":"web",
          "projects":{"web":{"projectKey":"web","path":"/srv/checkouts/acme-web"}}}}}'

# Company B may read only globex-api.
curl -fsS -X POST "$PAPERCLIP_API_URL/api/plugins/$PLUGIN_ID/bridge/action" \
  -H 'Content-Type: application/json' \
  -d '{"key":"set-company-governance","companyId":"'$COMPANY_B'","params":{
        "companyId":"'$COMPANY_B'",
        "governance":{"enabled":true,"defaultProjectKey":"api",
          "projects":{"api":{"projectKey":"api","path":"/srv/checkouts/globex-api"}}}}}'
```

An agent in Company A now physically cannot reach `/srv/checkouts/globex-api`:
`projectPath` is not an agent-settable argument, and the path it does get comes
from Company A's own binding.

### 2. A monorepo where each project reads its own package

```jsonc
{
  "enabled": true,
  "defaultProjectKey": "monorepo-root",
  "projects": {
    "monorepo-root": { "projectKey": "monorepo-root", "path": "/srv/platform" },
    "svc-payments":  { "projectKey": "svc-payments",  "path": "/srv/platform/services/payments" },
    "svc-identity":  { "projectKey": "svc-identity",  "path": "/srv/platform/services/identity" }
  },
  "projectsByPaperclipProject": {
    "<paymentsProjectUuid>": { "projectKey": "svc-payments" },
    "<identityProjectUuid>": { "projectKey": "svc-identity" }
  }
}
```

Each package needs its own `.codegraph/` index (`codegraph init` in that
directory). CodeGraph resolves the *nearest* index at or above the path it is
given, so a nested binding is both correct and cheaper than indexing the root.

### 3. Read-only by default, one team gets call-graph tools

```jsonc
{
  "enabled": true,
  "policy": { "allowedTools": ["codegraph_explore", "codegraph_search", "codegraph_node"] },
  "projects": { "web": { "projectKey": "web", "path": "/srv/acme-web" } },
  "agents": {
    "<staffEngineerAgentUuid>": {
      "policy": { "allowedTools": ["codegraph_explore", "codegraph_search", "codegraph_node", "codegraph_callers", "codegraph_callees", "codegraph_impact"] }
    }
  }
}
```

Because allows intersect, the staff-engineer entry **cannot exceed** the company
allow list unless the company list is widened too. To grant more, widen the
company scope — deliberately, and visibly.

### 4. Suspend one company without touching the others

```jsonc
{ "enabled": false }
```

Every call from that company is denied with `company_disabled`; other companies
are unaffected.

## Tools exposed

Exposed to agents as `paperclip-codegraph:<name>`. Names are kept identical to
upstream so there is no translation table to learn.

| Tool | Purpose |
|---|---|
| `codegraph_explore` | **Primary.** Relevant symbol source grouped by file plus the call path, in one capped call. |
| `codegraph_search` | Find symbols by name or partial name. |
| `codegraph_callers` | Every function that calls a symbol. |
| `codegraph_callees` | Every function a symbol calls. |
| `codegraph_impact` | Transitive dependency fan-out for a symbol at a chosen depth. |
| `codegraph_node` | One symbol's source with its caller/callee trail, or read an indexed file. |
| `codegraph_status` | Index health: files, nodes, edges, freshness. |
| `codegraph_files` | Indexed file tree, flat list, or grouped by language. |

Every CodeGraph tool is **query-only**. Upstream advertises `readOnlyHint: true,
destructiveHint: false, idempotentHint: true, openWorldHint: false`, and an index
is built only by an explicit operator CLI call — never by an agent.

### `CODEGRAPH_MCP_TOOLS` is always set

Upstream's default `tools/list` surface is **`codegraph_explore` alone**
(`DEFAULT_MCP_TOOLS = new Set(['explore'])`); the other seven stay callable but
unlisted. This plugin always sets `CODEGRAPH_MCP_TOOLS` explicitly to the
governance-resolved set, for two reasons: leaving it unset would advertise one
tool, and setting it means **CodeGraph itself refuses a tool this scope may not
call**. Enforcement therefore does not rest on this plugin's code alone.

## Where it appears in Paperclip

The plugin adds **two** surfaces, and deliberately no more:

| Surface | Where | What it is |
|---|---|---|
| **CodeGraph** | the nav column | Index state at a glance: a dot and one line when there is no index or the feature is off. |
| **CodeGraph** | Settings → Plugins | All configuration. |

Each matches how the host mounts plugin UI: `ui/src/components/Sidebar.tsx` renders
a `sidebar` slot inside its nav column, and `ui/src/pages/PluginSettings.tsx` mounts
a `settingsPage` slot inside Settings → Plugins.

### There is no graph page, on purpose

Earlier releases shipped a hand-built reader — a three-pane Symbol view, an
architecture Map, entry points and a dead-code list — and it was removed.

The reason is that **CodeGraph already has that UI, and it is better.** It is under
active development, and its own released notes add views this plugin would have
taken months to match. A second implementation of the same reader could only fall
behind, and every hour spent on it was an hour not spent on the part that is
actually pluggable.

What the plugin is for is the part Paperclip needs:

- **the eight CodeGraph tools, governed and audited** through Paperclip's own tool
  gateway, with per-project and per-agent narrowing it cannot provide on its own;
- **the MCP wiring** that makes those tools reachable by an agent at all;
- **the repository resolution** — a repository is a Paperclip project's workspace,
  never a path an agent types;
- **repository discovery** — a project's managed folder is a container, not always a
  checkout, so the plugin finds the checkouts inside it: one nested (the usual
  `_default/<repo>` shape), or several side by side. Each becomes its own row, with
  its own index and its own "Index now", identified by its path relative to the
  workspace (`""` is the workspace itself). Nothing is guessed beyond one level down,
  so a vendored checkout inside `node_modules` is never indexed by accident. The same
  resolution applies to an **agent's** call: a project folder holding exactly one
  checkout is descended into, and one holding several is refused rather than answered
  out of an arbitrary member — see [One project, several
  repositories](#one-project-several-repositories).

To **read** the graph, run `codegraph ui` on the host. It is a local, read-only
viewer for the project you already indexed, and it needs no Paperclip wiring:

```bash
codegraph ui -p /path/to/repo     # opens a browser on a loopback port
```

For the record, since it shaped what is here: the adapter seam in CodeGraph's own
UI was investigated properly, and it holds — `ui/src/lib/api.ts` is explicit that
"a host that already holds the index installs its own" adapter, and a proof of
concept ran their real Map view against this plugin's data with no page errors. It
was **not** adopted, because their UI ships inside a 123 MB vendored runtime and is
`private: true` on npm, so consuming it means a build step tracking their source on
every update. That is a maintenance commitment this plugin does not need to take on
to do its job.

## Why `projectPath` is not exposed

Upstream CodeGraph accepts an optional `projectPath` on every tool so one server
can serve several codebases. In a multi-tenant control plane that parameter is a
cross-tenant read primitive: an agent in Company A could simply name Company B's
checkout.

This plugin therefore:

1. **Removes `projectPath` from every declared schema**, so it is not part of the
   tool contract an agent sees.
2. **Deletes it from incoming arguments** even if a host forwards it anyway —
   `additionalProperties: false` is a declaration, not a guarantee.
3. **Injects the resolved path itself**, from the governance binding for
   `runCtx.companyId`, at the transport layer, overriding anything supplied.

The argument-stripping behaviour is asserted directly in
`tests/arguments.spec.ts`, and the override at the wire level in
`tests/mcp-client.spec.ts`.

## One project, several repositories

Paperclip's managed layout is a *container*, not a checkout:

```
<company>/<project>/_default/            ← the project workspace, not a repository
├── acme-web/          .git
├── acme-api/          .git
└── acme-infra/        .git
```

A single-repository project puts one checkout in there. A multi-repository project
puts several, side by side, and the workspace itself carries no `.git` and no
`repo_url`.

**On the settings page**, each checkout is its own row, with its own index state and
its own *Index now*. Rows are grouped under their project, because the on/off switch
is a per-project decision: the project is what an agent works in, and switching it off
narrows every checkout at once. A row is identified by `repositoryKey` — its path
relative to the workspace, `""` for the workspace itself. That is a directory name,
never an absolute path, so it is safe to render and safe to send back.

**When an agent calls a tool**, there is no key to send: the call is about the project
the run is working in. So the resolution is:

| The project folder holds | What the call reads |
|---|---|
| the checkout itself | it, unchanged — every existing deployment behaves identically |
| exactly one checkout | that checkout — unambiguous, and plainly what was meant |
| several checkouts | **nothing.** The call is refused, and the repository names are returned |
| no checkout | the folder, unchanged — it may be a package inside a monorepo whose index sits at an ancestor |

The refusal is the deliberate part. Nothing in a multi-repository project says which
repository a question was about, and a tool that quietly reads `acme-api` when the
question was about `acme-web` produces a confident, well-sourced, wrong answer — the
worst possible failure for code intelligence. Binding one repository is an explicit
act, so it has to be an explicit act:

```jsonc
// governance: point the project at the checkout, not at the container
{ "projects": { "acme-web": { "projectKey": "acme-web",
                              "path": "/srv/paperclip/<company>/<project>/_default/acme-web" } } }
```

The refusal names the candidates so the operator knows what to bind, and it is
recorded in the audit row as `ambiguous_repository`.

## Choosing between the two integration paths

The plugin-tool path above is the default and needs no credentials. Paperclip can
*also* host CodeGraph as a first-class **native MCP connection**
(`transport: "local_stdio"`), which puts CodeGraph in Tools & Access with catalog
risk levels, policies, approval flow, and runtime slots.

| | Plugin agent tools (default) | Native `local_stdio` connection |
|---|---|---|
| Tool `providerType` | `paperclip_plugin` | `mcp_local_stdio` |
| Governance | Paperclip gateway **+** this plugin | Paperclip gateway |
| Needs a board API key | No | Yes |
| Appears in Tools & Access | As plugin tools | As an application + catalog |
| Per-tool risk levels in the catalog | Inferred from name | From discovery + hints |

Generate the exact provisioning plan for the second path — it is returned as data
so it can be reviewed before anything is created:

```bash
curl -fsS -X POST "$PAPERCLIP_API_URL/api/plugins/$PLUGIN_ID/bridge/action" \
  -H 'Content-Type: application/json' \
  -d '{"key":"native-mcp-plan","companyId":"'$COMPANY_ID'","params":{
        "companyId":"'$COMPANY_ID'","deploymentMode":"local_trusted"}}'
```

Or execute it directly:

```bash
PAPERCLIP_API_URL=http://127.0.0.1:3100 \
PAPERCLIP_BOARD_API_KEY=... \
node scripts/provision-native-mcp.mjs --company-id "$COMPANY_ID" --project-path /srv/acme-web
```

## Verifying an install

> Bringing this up on a real instance for the first time? Follow
> **[docs/RUNBOOK.md](./docs/RUNBOOK.md)** — ordered steps, a gate between each,
> and a failure→cause table. It covers the three things that make this look
> broken when it is merely half-configured: CodeGraph must be installed *where the
> worker runs*, enabling is a **second** gate on top of the Paperclip profile, and
> a **named MCP gateway** is required before any agent receives the tools.

Ask the plugin what a scope may do, without calling CodeGraph:

```bash
curl -fsS -X POST "$PAPERCLIP_API_URL/api/plugins/$PLUGIN_ID/bridge/action" \
  -H 'Content-Type: application/json' \
  -d '{"key":"explain-scope","companyId":"'$COMPANY_ID'","params":{"companyId":"'$COMPANY_ID'"}}'
```

```jsonc
{
  "enabled": true,
  "allowed": true,
  "reason": "allowed",
  "projectKey": "payments",          // an alias, never an absolute path
  "allowedTools": ["codegraph_explore", "..."],   // post-intersection allow set
  "effectiveTools": ["codegraph_explore", "..."], // what is actually callable
  "deniedTools": [],
  "appliedScopes": ["company"]
}
```

Run a real call end to end, inside the real host:

```bash
curl -fsS -X POST "$PAPERCLIP_API_URL/api/plugins/$PLUGIN_ID/bridge/data" \
  -H 'Content-Type: application/json' \
  -d '{"key":"verify-scope","companyId":"'$COMPANY_ID'","params":{"query":"auth flow"}}'
```

### A repository that shows as "not indexed", or does not show at all

The settings page answers the first case itself: a row that is listed but not indexed
is a repository discovery found, and the question is only whether CodeGraph has read
it. Press **Index now**, and if it fails the reason comes back in the toast.

The second case — a project whose repository *is* on the host but which appears in
the settings page as no repository at all — is the one that used to be undebuggable,
because the plugin never discloses host paths, so a wrong resolution and a genuinely
empty workspace look identical. Read the discovery result directly instead of
guessing at it. This is what the page itself reads:

```bash
curl -fsS -X POST "$PAPERCLIP_API_URL/api/plugins/$PLUGIN_ID/bridge/data" \
  -H 'Content-Type: application/json' \
  -d '{"key":"graph-projects","companyId":"'$COMPANY_ID'","params":{"companyId":"'$COMPANY_ID'"}}'
```

```jsonc
{
  "organization": "Vroomy",
  "repositories": [
    {
      "projectId": "e77f5825-…",
      "repositoryKey": "vroomy-backend",   // path relative to the project's workspace
      "name": "vroomy-backend",
      "projectName": "Vroomy",
      "repoName": "vroomy-backend",        // from `git remote get-url origin`
      "indexed": false
    }
    // …six rows, one per checkout in the project folder
  ],
  "enabled": true,
  "skippedProjects": 0,                    // projects with no repository at all
  "detail": "This org has 3 project(s), none with a repository workspace."
}
```

That separates the three causes:

- **`repositories` is empty and `skippedProjects` counts your project** — the
  workspace itself is not a checkout and holds none: either the code has not been
  cloned, or it lives deeper than one level below the workspace. Discovery looks at
  the workspace and its immediate children, and no further.
- **`repositories` has a row with `"indexed": false`** — discovery is fine and only
  the index is missing. That is a normal state, not a fault.
- **The row is missing a repository you expected inside a multi-repository project** —
  check `repositoryKey`. Every checkout of a project is its own row, and a directory
  that is not a repository root (a vendored copy under `node_modules`, a hidden
  directory) is deliberately not one.

`repositoryKey` is the only identifier ever sent back to the host. It is a directory
name relative to the workspace — never an absolute path — so it is safe to print and
safe to paste into a bug report.

To check that a *scope* — not just a repository — resolves end to end, the
`verify-scope` data key runs a real `codegraph_explore` through the governed path and
reports `ok: true`, the resolved `projectKey`, `upstreamToolCount`, `effectiveTools`,
and `filesServed` — the project-relative files CodeGraph actually returned, which is
the evidence that the *right* repository answered.

The full isolation suite, against a live instance:

```bash
node scripts/e2e-isolation.mjs \
  --plugin-id "$PLUGIN_ID" \
  --company-a "$COMPANY_A" --repo-a /srv/checkouts/acme-web \
  --company-b "$COMPANY_B" --repo-b /srv/checkouts/globex-api
```

It asserts the disabled-by-default posture, per-company binding, resistance to
forged project/agent ids, deny-wins, narrowing, real CodeGraph calls whose served
files contain only the calling company's code, and per-company governance reads
that cannot see each other. Sample output is in `docs/EVIDENCE.md`.

## Audit

Every CodeGraph call produces audit records at two levels:

1. **Paperclip's gateway**, for the tool call itself — a `tool_gateway` audit
   event plus a `tool_call_events` row and a `tool_invocations` row, with
   arguments and results summarized and redacted. This is written by core before
   and after the plugin handler runs, and the plugin cannot skip it.
2. **This plugin**, for the governance decision — a `codegraph_tool_call` activity
   entry carrying `decision`, `reason`, the resolved `projectKey` (an alias),
   `effectiveScopes`, `durationMs`, and `resultChars`.

Plugin entries deliberately record the operator-chosen **alias**, not the
absolute path. Set `auditProjectPaths: true` only if your audit store is trusted
with host directory layouts.

```bash
paperclipai activity list -C "$COMPANY_ID" | grep codegraph
```

## Security model

| Property | How it is achieved |
|---|---|
| Cross-tenant reads impossible | `projectPath` is not in any schema, is deleted from incoming args, and is injected from the caller's own company binding. `GovernanceStore.loadForResolve` loads **only** the caller's company slice, so another tenant's bindings are never in memory. |
| Overrides cannot escalate | Narrowing-only algebra: denies union, allows intersect. |
| Path traversal and symlink escape | `resolveProjectPath` requires an absolute path, rejects NUL bytes, requires the directory to exist, resolves symlinks with `realpath` **before** containment, and enforces `allowedProjectRoots` against the resolved target. |
| Credential directories unreadable | `/etc`, `/proc`, `/sys`, `/dev`, `/root`, `/var/lib`, `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.paperclip`, `~/.dsh`, `~/.config`, `~/.npm` are refused, and paths shallower than three segments are refused so a filesystem root or home directory cannot be indexed. |
| No secret exfiltration to CodeGraph | The child gets an allowlist environment, not `process.env`. Keys matching `secret|token|password|credential|api_key|private_key|database_url|dsn|auth` are rejected outright. |
| No network egress | `DO_NOT_TRACK=1`, `CODEGRAPH_TELEMETRY=0`, `CODEGRAPH_NO_UPDATE_CHECK=1`, `CODEGRAPH_NO_DOWNLOAD=1` by default. CodeGraph's indexing performs no network or LLM calls. |
| No shell injection | Commands run via `execFile` with an argument array and `shell: false`. |
| No orphaned processes | The `codegraph` npm shim runs the real binary through a blocking `spawnSync`, so the plugin spawns detached and kills the whole **process group**; `onShutdown` closes the pool. |
| No context flooding | Results are clamped to `maxResultChars` before reaching the agent, then Paperclip's own content guards run. |
| Governance not bypassed | The plugin has no capability to create connections, profiles, or policies, and its `ctx.http` cannot reach loopback/private addresses. It registers *tools*; governance stays with core. |

## Limitations and assumptions

Honest list. See `docs/ASSUMPTIONS.md` for the full version with citations.

**Verified in this build**

- Paperclip `2026.817.0`, `local_trusted`, plugin installs `ready` from the npm
  registry, 157 unit and integration tests pass, 23/23 live isolation checks
  pass, and real `codegraph_explore` calls return real source from the correct
  repository.
- **Multiple repositories per organization is verified live**: two repositories
  bound to one company, selected by agent override, Paperclip-project override,
  and company default, with each real call served exactly one repository's files
  and no cross-contamination between them.

**Known limitations**

1. **No UI.** Admin surfaces are plugin actions plus the CLI. A `settingsPage`
   slot is the obvious next step.
2. **Governance is a single document per company**, so a concurrent
   read-modify-write by two admins can lose one update. Writes are validated on
   the way in; there is no optimistic-concurrency token yet.
3. **An agent tool call was not exercised through a full heartbeat run** in this
   environment: that needs an approved agent, a working adapter, and budget. The
   gateway path for plugin tools is therefore verified by code reading and unit
   tests, not by a recorded live run. `docs/ASSUMPTIONS.md` gives the exact
   reproduction steps.
4. **`codegraph init` cost is unbounded.** Default `indexTimeoutMs` is 15 minutes;
   a very large repository may need more. `autoIndex` is off by default for this
   reason.
5. **Index freshness is upstream's business.** The plugin does not watch or sync;
   CodeGraph's own watcher (or `codegraph sync`) owns that.
6. **One MCP process per (command, args, project, allowlist) key.** Many
   companies with distinct allowlists means many processes; `useDaemon: true`
   trades that memory for a shared background daemon.
7. **`local_stdio` native connections require `local_trusted`** (or a trusted MCP
   runtime host). The plugin-tool path has no such restriction.
8. **Paperclip's `tool_name` profile entries are exact matches, not globs.**
   This plugin's own resolver supports globs, but a Paperclip profile must list
   each tool by full name.
9. **Paperclip's policy engine is first-match-wins by priority**, so a policy
   `allow` at a lower priority number can beat a `block` at a higher one. Deny
   dominance holds only for blocks that sort first and against `trust_rule`.
   Plan priorities accordingly.
10. **Windows process-group kill** uses a single-process kill rather than a group
    kill; a stray CodeGraph process is possible there.
11. **Process count scales with (repository × distinct allowlist)**, not with
    company: one CodeGraph process per pair, each with a bundled Node runtime and
    an open SQLite handle. Measured 3 processes for 3 pairs. Keep allowlists
    uniform within a company to get one process per repository, and use the
    `shutdown-codegraph` action to release them on demand.
12. **`useDaemon: true` weakens one defence layer.** Upstream's shared daemon is
    per *project path* and enforces `CODEGRAPH_MCP_TOOLS` from its own
    environment, so two scopes querying the same path with different allowlists
    get whichever allowlist started the daemon. This plugin's resolver still
    denies correctly; CodeGraph just stops refusing denied tools on its own.
    Leave `useDaemon` off in multi-tenant deployments (it is the default).

**Assumptions**

- CodeGraph's CLI surface is the `1.6.0` interface: `codegraph serve --mcp`,
  `codegraph init <path> --yes`, `codegraph status <path> --json`. A future
  release that renames or removes a tool degrades to a clear error because the
  plugin validates the live `tools/list` at call time.
- The eight tool schemas are transcribed from CodeGraph `1.6.0`'s own
  `tools/list` output.
- Audit reads (`GET /api/tool-gateway/audit`) need `tools:view_audit`; in
  `local_trusted` mode the plugin bridge routes are reachable without a token,
  which is not true in `authenticated` mode.

## Development

```bash
npm install
npm run build          # esbuild → dist/manifest.js, dist/worker.js
npm run typecheck
npm test               # 157 unit + integration tests

# Watch build, then install into a running Paperclip
npm run dev
paperclipai plugin install .
paperclipai plugin list
paperclipai plugin health paperclip-codegraph
```

Editing a file under `dist/` makes Paperclip restart the plugin worker; if a
change does not appear, `paperclipai plugin disable <key>` then
`paperclipai plugin enable <key>`.

Repository layout:

```
src/
  manifest.ts              manifest, capabilities, tool declarations
  worker.ts                lifecycle, tool handlers, actions, data handlers
  config.ts                instance/company config schema and normalization
  constants.ts             tool names, defaults, limits
  mcp/protocol.ts          JSON-RPC framing (pure)
  mcp/client.ts            stdio client, env policy, process pool
  tools/catalog.ts         the eight tool specs
  tools/validate.ts        argument validation and unknown-key stripping
  governance/types.ts      the governance model
  governance/resolver.ts   narrowing-only resolution (pure)
  governance/store.ts      per-company persistence
  governance/sanitize.ts   path validation
  governance/provision.ts  native MCP connection provisioning plan
  codegraph/manage.ts      CLI resolution, install, index
tests/                     157 tests; fixtures/ has a fake MCP server
scripts/e2e-isolation.mjs  live multi-company isolation suite
```

## License

MIT — see [LICENSE](./LICENSE). Integrates two MIT projects:
[Paperclip](https://github.com/paperclipai/paperclip) and
[CodeGraph](https://github.com/colbymchenry/codegraph).
