# Assumptions, verified facts, and unresolved blockers

Everything here was established by reading source, not documentation, wherever
the two disagreed. Where a claim is machine-verified in this repo, the test or
script is named.

## 1. Verified environment

| Item | Value |
|---|---|
| Paperclip (live test target) | `2026.817.0`, `deploymentMode: local_trusted`, `deploymentExposure: private` |
| Paperclip source read for API shapes | `paperclipai/paperclip` @ `e1f245a6` (full clone, read-only) |
| `@paperclipai/plugin-sdk` | `2026.824.1` from npm (Paperclip publishes it; 1463 versions) |
| CodeGraph | `1.6.0` (`@colbymchenry/codegraph`), plan-verified against its own source |
| Node for building/testing | `24.11.1` (Paperclip's engine floor is `>=24.11.0`) |

## 2. Paperclip API facts this plugin depends on

Each was confirmed by reading the cited file, then exercised against the live
instance where possible.

| Fact | Source | Exercised live? |
|---|---|---|
| A plugin tool is governed by the same policy engine as MCP connections, tagged `providerType: "paperclip_plugin"` with risk inferred from the tool name | `server/src/services/tool-gateway.ts:1164-1171` (`pluginTools()`), `:671` (`inferToolRisk`) | Indirectly — tool list read from the live registry |
| Paperclip's default is **deny**: a tool with no matching profile/policy/grant is denied | `tool-access-policy.ts:1304` (`deny_default`), regression test `tool-gateway.test.ts:5346` | Not via a heartbeat run — see §5 |
| Plugin tools are namespaced `<pluginId>:<toolName>` | `plugin-tool-registry.ts:40-50`, `:246` | **Yes** — `paperclipai plugin tools` shows `paperclip-codegraph:codegraph_explore` |
| Tool declarations come from the **manifest** at load time, not from `ctx.tools.register` | `plugin-tool-registry.ts:15-21` | **Yes** — all 8 listed while config was still `enabled: false` |
| Plugin tools require an agent run context; without it the gateway returns `403 agent_context_required` | `tool-gateway.ts:10196-10203` | Read only |
| Plugin tools have no `applicationId`/`connectionId`/`catalogEntryId`, so only `tool_name` / `risk_level` profile entries can reach them | `tool-gateway.ts:1164-1171`, `tool-access-policy.ts:535-544` | Read only |
| Plugin config is **company-scoped** | `plugin_config(plugin_id, company_id, config_json)`; `POST /api/plugins/:id/config` requires `configJson` + `companyId` | **Yes** — the set call succeeded with a real company id and failed with a stale one |
| `ctx.state` requires a company invocation context for company-scoped keys | live error `INVOCATION_SCOPE_DENIED: state.get: company context is required` | **Yes** |
| Plugin `state`/`action`/`data` calls are reachable over `POST /api/plugins/:id/bridge/{action,data}` with a top-level `companyId` | `server/src/routes/plugins.ts:1250-1275`, `:1398`, `:1491-1530` | **Yes** — all governance checks ran through these |
| A plugin cannot create connections, profiles, policies, or bindings; the capability list has no MCP/governance entry | `packages/shared/src/constants.ts:1322-1421`; no `toolAccessService`/`toolGatewayService` in `plugin-host-services.ts` | Read only |
| A plugin worker's `ctx.http` blocks loopback/private addresses, so it cannot call its own host's API | `plugin-host-services.ts:199-204` | Read only — which is why native-MCP provisioning is a script |
| Binding scope precedence puts `gateway` narrowest, then issue, routine, agent, project, company | `tool-profile-binding-precedence.ts:17-26` | Read only |
| Paperclip `tool_name` profile entries are **exact matches, not globs** | `tool-access-policy.ts:335` comment, `:541` (`===`) | Read only |
| Paperclip policies are first-match-wins by `priority`; deny does not universally beat allow | `tool-access-policy.ts:1214-1284`, `:1261` | Read only |
| `local_stdio` connections need an approved stdio template and are refused in `authenticated` + `public` without a trusted runtime host | `tool-access.ts:3502-3519`, `:3471-3486` | Read only |

## 3. CodeGraph facts this plugin depends on

| Fact | Source | Exercised live? |
|---|---|---|
| MCP launch command is exactly `codegraph serve --mcp` | CodeGraph `1.6.0`; upstream writes `{command:'codegraph',args:['serve','--mcp']}` | **Yes** |
| MCP transport is stdio only, JSON-RPC 2.0, newline-delimited, protocol `2024-11-05` | `dist/mcp/transport.ts`, `dist/mcp/session.js:59` | **Yes** — 157 tests plus live calls |
| Exactly 8 tools: explore, search, callers, callees, impact, node, status, files. No `codegraph_context`, no `codegraph_trace` | `dist/mcp/tools.js` `tools` array | **Yes** — schemas dumped from the installed build |
| **`tools/list` defaults to `codegraph_explore` alone**; others are callable but unlisted; `CODEGRAPH_MCP_TOOLS` is the gate | `DEFAULT_MCP_TOOLS = new Set(['explore'])` | **Yes** — a live call reported 3 listed tools for a small repo, confirming the variable is honoured |
| Every tool accepts an optional `projectPath`, resolved to the nearest `.codegraph/` at or above it | `projectPathProperty` in `dist/mcp/tools.js` | **Yes** — this is the isolation boundary being tested |
| `projectPath` becomes *required* when the server has no default project | `withRequiredProjectPath()` | Read only — harmless here, since the plugin always injects it |
| Index lives at `<root>/.codegraph/codegraph.db`; `isInitialized` requires both | `dist/directory.js` | **Yes** — `codegraph status --json` after `init` |
| `codegraph init <path>` creates the index and builds it in one step; `--index` is a deprecated no-op | `dist/bin/codegraph.js` `runInit` | **Yes** — both fixture repos indexed in ~205 ms |
| `init` refuses home/root paths without `--force` | `unsafeIndexRootReason` | Read only — the plugin never passes `--force`, so upstream's refusal and the plugin's own sanitizer agree |
| Telemetry is **on** by default and opt-out | `telemetry/index.ts` default branch | Read only |
| Zero-ingress set is `DO_NOT_TRACK=1` + `CODEGRAPH_TELEMETRY=0` + `CODEGRAPH_NO_DOWNLOAD=1`; `DO_NOT_TRACK` also kills the GitHub update check | `telemetry/index.ts`, `upgrade/update-check.ts:89-90`, `npm-shim.js:121-123` | Asserted in `tests/mcp-client.spec.ts` |
| The npm shim runs the bundle via a blocking `spawnSync(..., {stdio:'inherit'})`, so killing only the shim PID orphans the server | `npm-shim.js:55` | Reason for the detached process-group kill in `mcp/client.ts` |
| All 8 tools are query-only (`readOnlyHint: true`), and indexing spends no LLM tokens | `READ_ONLY_ANNOTATIONS`; no `fetch` in `src/extraction/` | Implied by live calls |
| License MIT | `LICENSE` + npm metadata | Read only |

## 4. Assumptions made where documentation was missing

1. **Manifest tool declarations are the source of truth for the registry.**
   Therefore `enabled: false` cannot hide tools from `pluginai plugin tools`;
   it denies every *call* instead. Removing the plugin, or
   `paperclipai plugin disable`, is the way to remove them from the registry.
   This is documented in the README rather than worked around, because
   `enabled: false` producing a clear denial is the honest behaviour.
2. **Registering handlers unconditionally is correct.** Because config is
   company-scoped, an instance-level read during `setup()` cannot know whether
   any company has opted in — and in this environment that read *failed*, which
   would have left a plugin reporting `ready` with no handlers at all. Enablement
   is therefore decided per call. This was a real bug found by live testing.
3. **The resolved binary path is used for every step.** A supervisor-started
   Paperclip had a `PATH` without `~/.npm-global/bin`, so a bare `codegraph`
   was invisible. The plugin now searches conventional install directories as
   well as `PATH`, and threads the resolved absolute path through index and MCP
   invocation so both use the same build. Also found by live testing.
4. **Aliases, not paths, in logs and API responses.** `projectKey` is either
   operator-chosen or derived from the last two path segments plus a short hash.
   Absolute paths appear only when `auditProjectPaths` is explicitly enabled.
5. **`extraEnv` keys that look like credentials are rejected** rather than
   passed through and redacted later. CodeGraph is local-only and needs none.
6. **The plugin does not build indexes by default.** Indexing is CPU- and
   disk-intensive and mutates the checkout, so `autoIndex` defaults to `false`.
7. **Narrowing-only semantics were chosen deliberately.** The alternative
   (most-specific-wins, where a narrow scope replaces a broad one) would let a
   project or agent override *widened* access, which is the wrong default for a
   governance system. Verified in `tests/governance.spec.ts`.
8. **`CODEGRAPH_MCP_TOOLS` is always set explicitly**, so a denied tool is
   refused by CodeGraph itself, not only by the plugin. This is defence in depth
   and also fixes upstream's one-tool default surface.

## 5. Unresolved blockers

### 5.1 No live agent-heartbeat tool call

**What is missing:** a recorded live call to
`paperclip-codegraph:codegraph_explore` made *by an agent* through the tool
gateway, with the resulting `tool_gateway.*` audit rows and `tool_call_events`
rows shown.

**Why:** plugin tools require an agent run context
(`tool-gateway.ts:10196-10203` returns `403 agent_context_required` without
`agentId` + `runId`). Creating a gateway session needs a real heartbeat run:
`POST /api/tool-gateway/sessions` returned
`{"error":"Run does not belong to company","reasonCode":"run_company_mismatch"}`
for a synthetic run id. The company's only agents are in `pending_approval`, and
direct creation is refused with *"Direct agent creation requires board approval"*.
Producing a genuine run needs an approved agent, a working adapter, and budget —
out of scope for this build.

Consequently the `tool_gateway.*` audit rows are **unverified live**, and the
claim that Paperclip default-denies plugin tools rests on source reading
(`tool-access-policy.ts:1304` and the `deny_default` regression test) rather than
observation.

**Exact steps to close it, on an instance with an approved agent:**

```bash
# 1. Confirm the agent is runnable and note its id + the company id.
paperclipai agent list -C "$COMPANY_ID"

# 2. Run one heartbeat, which creates a real run id.
paperclipai heartbeat run --help      # use the flags that fit your adapter
#    ... and record the run id it prints as $RUN_ID

# 3. In that company, include the CodeGraph tools in a Paperclip profile and
#    bind it at company (or agent) scope. tool_name entries are exact matches.
PLUGIN_TOOLS=$(paperclipai plugin tools --json \
  | jq -r '.[] | select(.name|startswith("paperclip-codegraph:")) | .name')
#    POST /api/companies/$COMPANY_ID/tools/profiles with one include entry per tool,
#    then POST .../tools/profiles/$PROFILE_ID/bind {targetType:"company",targetId:"$COMPANY_ID"}.

# 4. Drive a call through the gateway as the agent (agent API key + run id).
paperclipai plugin tool:execute \
  --api-key "$AGENT_API_KEY" --run-id "$RUN_ID" \
  --payload-json '{"tool":"paperclip-codegraph:codegraph_explore","parameters":{"query":"auth flow"}}'

# 5. Read the audit back.
curl -fsS -H "Authorization: Bearer $PAPERCLIP_BOARD_API_KEY" \
  "$PAPERCLIP_API_URL/api/tool-gateway/audit?companyId=$COMPANY_ID&window=24h" \
  | jq '.events[] | select(.details.tool|test("codegraph"))'
```

### 5.2 The plugin registry / marketplace

No Paperclip plugin registry or marketplace submission endpoint was found. The
documented distribution path is **npm** plus `paperclipai plugin install <pkg>`;
`doc/plugins/PLUGIN_AUTHORING_GUIDE.md` states plainly that "GitHub repository
installs are not a first-class workflow today" and to publish to npm. Community
discovery is via `awesome-paperclip` (a community list, not a registry). See
`docs/PUBLISHING.md` for the submission attempt and the exact commands.

### 5.3 Announcement channels

Posting to Discord, X/Twitter, LinkedIn, or Reddit needs credentials and accounts
this environment does not have. Ready-to-post drafts for each channel are in
`docs/ANNOUNCEMENTS.md`; nothing was posted.

### 5.4 `useDaemon: true` weakens the upstream allowlist layer

Upstream's shared daemon is **one process per project path**, multiplexed over a
unix socket, and it enforces `CODEGRAPH_MCP_TOOLS` from the *daemon's* own
environment. A stdio proxy's environment does not govern the daemon's
`tools/call` path. So if two governance scopes query the **same** project path
with **different** allowlists, the daemon applies whichever allowlist spawned it
first.

The plugin's own resolver still denies correctly — this only removes the
defence-in-depth layer that has CodeGraph itself refuse a denied tool. Direct mode
(`useDaemon: false`, the default) keeps that layer per scope. `setup()` now logs a
warning when the daemon is enabled. **Leave `useDaemon` off for multi-tenant
deployments.**

### 5.5 Process count scales with (repository × allowlist), not with company

The pool is keyed on `(command, args, projectPath, toolAllowlist, telemetry flag,
daemon flag, extraEnv keys)`, so a company with 3 repositories and 2 distinct
effective allowlists can hold up to 6 CodeGraph processes, each carrying a bundled
Node runtime and an open SQLite handle. Measured: 3 processes for 3 pairs.

For a large fleet, either keep effective allowlists uniform across a company (so
one process per repository) or accept the ceiling. `useDaemon: true` would collapse
this, but see §5.4. The `shutdown-codegraph` action releases every process on
demand.

### 5.6 Not implemented

- No plugin UI (`settingsPage` slot). Admin surfaces are actions plus the CLI.
- No optimistic concurrency on the governance document.
- Windows process cleanup uses a single-process kill, not a group kill.
