# Runbook: bring `paperclip-codegraph` from installed to usable

For an operator bringing the plugin up on a real instance. Written against
Paperclip `2026.817.0`; the two diagnostic actions work on any build because they
only touch plugin state.

Order matters. Each step has a **gate** — do not proceed past a failing gate,
because every later failure looks the same ("no tools") and you will debug the
wrong layer.

```
0. Where does CodeGraph run?   ──► gate: codegraph --version inside the container
1. Install the CLI
2. Index the repository(s)     ──► gate: codegraph status --json shows initialized
3. Enable for the company      ──► gate: explain-scope reports enabled: true
4. Bind the repository         ──► gate: explain-scope reports your projectKey
5. Prove a real call           ──► gate: verify-scope returns ok: true  ★ the real one
6. Paperclip layer: profile  +  named MCP gateway
7. Prove an agent call         ──► depends on the agent's adapter
```

Steps 0–5 are yours and are fully scriptable. Step 6 is Paperclip governance.
Step 7 is where agent-adapter reality intrudes.

Set these once:

```bash
export API=https://paperclip.tail27270.ts.net
export KEY=<board API key>          # paperclipai token board
export CO=<company id>              # e.g. the SAK company uuid
export PID=<plugin db id>           # paperclipai plugin list | grep codegraph
export REPO=/abs/path/to/repo       # as the WORKER sees it — see step 0
export ROOT=/abs/path/to           # parent dir allowed to contain bindings
```

---

## Step 0 — decide where CodeGraph runs

**The plugin spawns `codegraph serve --mcp` as a child of its own worker process.**
So the CLI, the repository, and the index must all exist **where the worker runs** —
usually inside the Paperclip container, not on the Docker host.

If your install path looks like `/paperclip/.paperclip/plugins/...`, that is a
container root and everything below happens *inside* it:

```bash
# Run this INSIDE the container, the way the worker would.
docker exec -it <paperclip-container> sh -lc 'command -v codegraph; node -v'
```

> Gate: `codegraph --version` prints a version. If it prints nothing, the plugin
> cannot work no matter what else you configure.

**Installing on the host but not in the container changes nothing.** This is the
single most common way this setup appears to fail for no reason.

`allowedProjectRoots` and every bound path must be the path **as the worker sees
it**, so `/paperclip/uploads/repos/pos` not `/srv/repos/pos`.

## Step 1 — install the CodeGraph CLI

Inside the container:

```bash
npm install -g @colbymchenry/codegraph@1.6.0
codegraph --version            # expect 1.6.0
```

The plugin does **not** require it on `PATH`: binary resolution searches `PATH`
and then `~/.npm-global/bin`, `~/.local/bin`, `/usr/local/bin`,
`~/.codegraph/current/bin`. So a minimal supervisor `PATH` is not fatal — but
verify with the plugin's own probe (step 5's predecessor) rather than `which`.

If you prefer the plugin to install it: set `autoInstall: true`. It runs
`npm install -g @colbymchenry/codegraph@<codegraphVersion>` — version-pinned, and
deliberately **not** `curl | sh`.

## Step 2 — index the repository(s)

Inside the container, on the repo as the worker sees it:

```bash
cd "$REPO"
codegraph init . --yes
codegraph status . --json | head -c 400     # expect "initialized": true
```

Notes that matter:

- `codegraph init` **writes `.codegraph/` into the repository**. The directory
  self-gitignores, but it is a real mutation of a checkout — decide deliberately.
- It refuses a filesystem root or a home directory without `--force`. The plugin
  never passes `--force`, and separately refuses paths shallower than three
  segments, so pick a real project directory.
- One index per repository. For a monorepo you can index each service
  separately and bind the sub-paths — CodeGraph resolves the *nearest*
  `.codegraph/` at or above the path it is given.
- Budget the time: `indexTimeoutMs` defaults to 15 minutes and `autoIndex` is
  off by default, so a manual `init` is the expected path. No LLM tokens are
  spent indexing; it is CPU and disk.

> Gate: `"initialized": true` for every repo you intend to bind.

## Step 3 — enable the plugin for the company

Plugin config is **company-scoped** and defaults to `enabled: false`.

> The CLI command `paperclipai plugin config:set` **does not work** for this: it
> sends its payload as the request body, but the route requires
> `{companyId, configJson}` and returns
> `400 "configJson" is required and must be an object`. Use curl.

```bash
curl -fsS -X POST "$API/api/plugins/$PID/config" \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d "{\"companyId\":\"$CO\",\"configJson\":{
        \"enabled\":true,
        \"autoIndex\":false,
        \"allowedProjectRoots\":[\"$ROOT\"]
      }}"
```

No worker restart is needed — the plugin registers its handlers at startup and
decides enablement per call, so this takes effect immediately.

> Gate:
>
> ```bash
> curl -fsS -X POST "$API/api/plugins/$PID/bridge/action" \
>   -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
>   -d "{\"key\":\"explain-scope\",\"companyId\":\"$CO\",\"params\":{\"companyId\":\"$CO\"}}"
> ```
>
> Expect `"enabled": true`. If it says `false`, this step did not land.

## Step 4 — bind the repository

```bash
curl -fsS -X POST "$API/api/plugins/$PID/bridge/action" \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d "{\"key\":\"set-company-governance\",\"companyId\":\"$CO\",\"params\":{
        \"companyId\":\"$CO\",
        \"governance\":{
          \"enabled\":true,
          \"defaultProjectKey\":\"pos\",
          \"projects\":{
            \"pos\":{\"projectKey\":\"pos\",\"path\":\"$REPO\",\"displayName\":\"POS\"}
          }
        }}}"
```

Add `spoon` as a second key in the same `projects` map if you want both indexed —
one binding per repository, and a per-agent override can pick between them:

```jsonc
"projects": {
  "pos":   { "projectKey": "pos",   "path": "/paperclip/uploads/repos/pos" },
  "spoon": { "projectKey": "spoon", "path": "/paperclip/uploads/repos/spoon" }
},
"agents": {
  "<agent-uuid-that-should-read-spoon>": { "projectKey": "spoon" }
}
```

`allowedTools` / `deniedTools` are optional here. Denials union and allows
intersect, so a narrow scope can never widen access.

> Gate: `explain-scope` now reports `"allowed": true` and your `projectKey`.
> A `project_binding_missing` or `no_project_bound` reason means this step.

## Step 5 — prove a real call ★

This is the gate that actually matters. It resolves governance, checks the binary,
checks the index, and performs a real `codegraph_explore` through a real CodeGraph
process — inside the real host.

```bash
curl -fsS -X POST "$API/api/plugins/$PID/bridge/data" \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d "{\"key\":\"verify-scope\",\"companyId\":\"$CO\",\"params\":{
        \"companyId\":\"$CO\",\"query\":\"login flow\"}}"
```

Expect `"ok": true`, a `projectKey`, and `filesServed` listing project-relative
paths from **the repository you bound**. `filesServed` is the proof that the right
codebase answered — and that no other tenant's files could.

If it fails, the `error` names the layer: binary missing, project not indexed, or
a governance denial with its reason code.

**Do not proceed to step 6 until this passes.** Everything after this point is
Paperclip governance, and debugging both layers at once is miserable.

## Step 6 — the Paperclip layer (two things, not one)

Both are required. This is the step most often half-done.

**6a. A tool profile including the tools by exact name.** Plugin tools are
default-denied, and they carry no `applicationId`/`connectionId`/
`catalogEntryId`, so only `tool_name` or `risk_level` entries can reach them.
`tool_name` matching is **exact — globs do not work in Paperclip profiles.**

```bash
curl -fsS -X POST "$API/api/companies/$CO/tools/profiles" \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"profileKey":"codegraph-read","name":"CodeGraph read-only",
       "status":"active","defaultAction":"deny",
       "entries":[
         {"selectorType":"tool_name","effect":"include","toolName":"codegraph_explore"},
         {"selectorType":"tool_name","effect":"include","toolName":"codegraph_search"},
         {"selectorType":"tool_name","effect":"include","toolName":"codegraph_callers"},
         {"selectorType":"tool_name","effect":"include","toolName":"codegraph_callees"},
         {"selectorType":"tool_name","effect":"include","toolName":"codegraph_impact"},
         {"selectorType":"tool_name","effect":"include","toolName":"codegraph_node"},
         {"selectorType":"tool_name","effect":"include","toolName":"codegraph_status"},
         {"selectorType":"tool_name","effect":"include","toolName":"codegraph_files"}
       ]}'
# capture .id as $PROFILE_ID, then:
curl -fsS -X POST "$API/api/companies/$CO/tools/profiles/$PROFILE_ID/bind" \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d "{\"targetType\":\"company\",\"targetId\":\"$CO\",\"priority\":100}"
```

`defaultAction: "deny"` means nothing is visible until explicitly included — a
newly discovered tool cannot silently become callable.

**6b. A named MCP gateway for the company.** Without one, the managed MCP config
is never built and no agent receives the tools, *even with the profile attached*.

```bash
curl -fsS -X POST "$API/api/companies/$CO/tools/gateways" \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d "{\"name\":\"CodeGraph\",\"slug\":\"codegraph\",\"profileId\":\"$PROFILE_ID\"}"
```

Creating a gateway requires `tools:admin`, and **there is no CLI command for
gateways** — it is REST only.

> Gate: `GET $API/api/companies/$CO/tools/profiles/effective/agents/<agentId>`
> should list the included tools. Note this endpoint only considers `company`
> and `agent` bindings, so it under-reports `project`/`routine`/`issue` bindings.

## Step 7 — prove an agent call

This needs an **approved agent** and a real run — plugin tools require an agent
run context and return `403 agent_context_required` without one.

```bash
paperclipai plugin tool:execute \
  --api-base "$API" --api-key "$AGENT_API_KEY" --run-id "$RUN_ID" \
  --payload-json '{"tool":"paperclip-codegraph:codegraph_explore","parameters":{"query":"login flow"}}'
```

Then read the audit:

```bash
curl -fsS -H "Authorization: Bearer $KEY" \
  "$API/api/tool-gateway/audit?companyId=$CO&window=24h" \
  | jq '.events[] | select(.details.tool|test("codegraph"))'
```

### Which adapters actually receive the tools

This is core behaviour, not the plugin's. In the version this was verified
against:

| Adapter | Delivery |
|---|---|
| `codex_local` | Managed MCP config written to `CODEX_HOME/config.toml` (`MANAGED_MCP_LOCAL_ADAPTERS`) |
| `claude_local` | Native/ACP runtime MCP servers via `ctx.runtimeMcp` |
| anything else | **No managed injection.** The agent will not see the tools. |

For an adapter outside that set, use the pull path: an agent holding an agent API
key can discover its own allowed plugin tools and call through the gateway.

```bash
curl -fsS -H "Authorization: Bearer $AGENT_API_KEY" \
  "$API/api/plugins/tools?companyId=$CO"
```

`runtimeToolDelivery: "invocation_context"` looks like a general fallback but is
not — it carries only the connection-intent tools against `/mcp/runtime-tools`.

**So: if your CTO and engineers run on an adapter in the third row, steps 1–6 will
all pass and they still will not see the tools.** Check this before writing the
task, not after.

---

## Failure → cause

| Symptom | Cause | Fix |
|---|---|---|
| `no paperclip-codegraph:* tool` in the agent's set | profile missing, or gateway missing, or adapter unsupported | steps 6a, 6b, step 7 table |
| `explain-scope` → `plugin_disabled` | company config `enabled: false` | step 3 |
| `explain-scope` → `no_project_bound` / `project_binding_missing` | governance not written, or override names an unbound key | step 4 |
| `CodeGraph command "codegraph" was not found` | CLI absent **where the worker runs** | steps 0–1 |
| `has no .codegraph index` | repo not indexed, or a different path than the worker sees | step 2 |
| `path is too shallow` / `sensitive` | bound path is a root, home, or credential dir | pick a real project dir |
| `not inside any configured allowedProjectRoots` | `allowedProjectRoots` does not contain the realpath | step 3 |
| `deny_default` from Paperclip | profile missing or not bound | step 6a |
| everything green, agent still blind | no gateway, or unsupported adapter | steps 6b, 7 |

## Two diagnostics worth memorising

`explain-scope` answers *"what may this scope do?"* without touching CodeGraph.
`verify-scope` answers *"does it actually work?"* by making a real call. Between
them they localise every failure to a single step.
