# Demo evidence

All output below was captured from a real run against a live Paperclip instance
with real CodeGraph processes. Nothing is mocked. Raw logs are checked in next to
this file.

## Environment

| | |
|---|---|
| Paperclip | `2026.817.0` at `http://127.0.0.1:3100`, `deploymentMode: local_trusted`, `exposure: private` |
| CodeGraph | `1.6.0` at `/home/rimko/.npm-global/bin/codegraph` |
| Plugin | `paperclip-codegraph` `0.1.0`, installed from local path, status `ready`, db id `37281b09-f52b-46bb-a4b4-cb71db75f0b7` |
| Company A | `00ee2512-1d74-46cb-a221-88c812e2c588` ("Spoon") → `tenant-a/payments-service` |
| Company B | `f49a49b5-9199-4942-a904-a74fa2768104` ("Mock Tenant B", created for this test) → `tenant-b/inventory-service` |

Both fixture repositories are two-file TypeScript services with deliberately
distinct vocabulary, so a leak between them is detectable by string:

- Tenant A: `PaymentsLedger`, `recordPayment`, `balanceCents`, `src/ledger.ts`
- Tenant B: `WarehouseIndex`, `restock`, `totalUnits`, `src/warehouse.ts`

## 1. Install

```
$ paperclipai plugin install /home/rimko/projects/paperclip-codegraph
Target Paperclip: http://localhost:3100
  health: status=ok  version=2026.817.0  mode=local_trusted  exposure=private
Installing plugin from local path: /home/rimko/projects/paperclip-codegraph
✓ Installed paperclip-codegraph v0.1.0 (ready)
```

```
$ paperclipai plugin inspect paperclip-codegraph
key=paperclip-codegraph  status=ready  version=0.1.0  id=37281b09-f52b-46bb-a4b4-cb71db75f0b7
```

```
$ paperclipai plugin health paperclip-codegraph
{ "pluginId": "37281b09-...", "status": "ready", "healthy": true,
  "checks": [ {"name":"registry","passed":true,"message":"Plugin found in registry"},
              {"name":"manifest","passed":true,"message":"Manifest is valid"},
              {"name":"status","passed":true,"message":"Current status: ready"} ] }
```

## 2. Tools registered, namespaced by the host

```
$ paperclipai plugin tools
name=paperclip-codegraph:codegraph_explore  displayName=CodeGraph Explore ...
name=paperclip-codegraph:codegraph_search   displayName=CodeGraph Search ...
name=paperclip-codegraph:codegraph_callers  displayName=CodeGraph Callers ...
name=paperclip-codegraph:codegraph_callees  displayName=CodeGraph Callees ...
name=paperclip-codegraph:codegraph_impact   displayName=CodeGraph Impact ...
name=paperclip-codegraph:codegraph_node     displayName=CodeGraph Node ...
name=paperclip-codegraph:codegraph_status   displayName=CodeGraph Status ...
name=paperclip-codegraph:codegraph_files    displayName=CodeGraph Files ...
```

## 3. Indexing the fixtures with the real CodeGraph CLI

```
$ codegraph init . --yes          # in tenant-a/payments-service
◆  Indexed 2 files
●  10 nodes, 16 edges in 205ms

$ codegraph status . --json
{"initialized":true,"version":"1.6.0","fileCount":2,"nodeCount":10,"edgeCount":16,
 "indexPath":".../tenant-a/payments-service/.codegraph","backend":"node-sqlite"}

$ codegraph init . --yes          # in tenant-b/inventory-service
◆  Indexed 2 files
●  10 nodes, 15 edges in 209ms
```

## 4. Multi-organization isolation suite — 20/20 checks pass

`node scripts/e2e-isolation.mjs` (raw log: `e2e-isolation-output.txt`)

```
1. Disabled-by-default posture
  [PASS] company A denied while disabled — reason=plugin_disabled
  [PASS] company B denied while disabled — reason=plugin_disabled

2. Bind distinct repositories per company
  [PASS] company A resolves to its own binding — projectKey=payments
  [PASS] company B resolves to its own binding — projectKey=inventory
  [PASS] company A cannot resolve company B's binding — A=payments B=inventory

3. Forged cross-tenant identifiers
  [PASS] company A ignores a forged project/agent id — projectKey=payments

4. Deny wins; narrower scopes only narrow
  [PASS] company deny removes codegraph_impact for a normal agent — effective=7 denied=["codegraph_impact"]
  [PASS] agent allow list narrows to exactly two tools — effectiveTools=["codegraph_explore","codegraph_search"]
  [PASS] agent override cannot re-grant a company-denied tool — codegraph_impact absent
  [PASS] a normal agent sees more tools than the restricted agent — 7 > 2

5. Real CodeGraph MCP calls through the real host
  [PASS] company A call succeeded against its repo — projectKey=payments chars=1657 ms=398
  [PASS] company B call succeeded against its repo — projectKey=inventory chars=1452 ms=399
  [PASS] company A is served its own file (ledger.ts) — files=["index.ts","src/index.ts","src/ledger.ts"]
  [PASS] company B is served its own file (warehouse.ts) — files=["src/index.ts","src/warehouse.ts"]
  [PASS] company A's answer contains none of company B's code — no tenant-B identifiers in tenant-A output
  [PASS] company B's answer contains none of company A's code — no tenant-A identifiers in tenant-B output
  [PASS] the upstream allowlist reaches CodeGraph itself — upstream tools listed=3
  [PASS] company A's effective tool set excludes the company-denied tool — effective=7 allowed=8
  [PASS] company B has no company-level denial, so all eight are effective — effective=8

6. Governance state is per company
  [PASS] company A's governance read contains only company A — keys=1
  [PASS] company B's governance read contains only company B — keys=1
  [PASS] each company sees its own project alias and not the other's — A=["payments"] B=["inventory"]
  [PASS] no absolute repository path is disclosed by either read — no host paths in summary

ALL CHECKS PASSED (20/20)
```

### The isolation assertion in full

The two decisive checks compare *which files CodeGraph served* against
tenant-specific filenames. Company A's raw answer, verbatim from the host:

```
**Exploration: module entry point**

Found 5 symbols across 1 file.

**Blast radius — what depends on these (update/verify before editing)**

- `LedgerEntry` (src/ledger.ts:1) — 2 callers in `src/ledger.ts`; no tests found within 3 caller hops

**Source Code**

> The code below is the **verbatim, current on-disk source** of these files — re-read from disk on this call ...
```

`filesServed` for A was `["index.ts","src/index.ts","src/ledger.ts"]`; for B it was
`["src/index.ts","src/warehouse.ts"]`. Neither answer contains the other
company's identifiers, and neither can: `projectPath` is not an argument an agent
can set.

## 5. Disabled-by-default, observed

With `enabled: false` (the shipping default), a company-scoped read reports:

```json
{"enabled":false,"allowed":false,"reason":"plugin_disabled",
 "projectKey":null,"allowedTools":[],"deniedTools":[],
 "appliedScopes":[],"denialSource":"instance"}
```

Installing the plugin changed nothing for any agent until a company opted in.

## 6. Configuration surface, observed

`explain-scope` for company A with a company deny plus one restricted agent:

```json
{
  "enabled": true,
  "allowed": true,
  "reason": "allowed",
  "projectKey": "payments",
  "allowedTools": ["codegraph_explore","codegraph_search","codegraph_callers","codegraph_callees",
                   "codegraph_impact","codegraph_node","codegraph_status","codegraph_files"],
  "effectiveTools": ["codegraph_explore","codegraph_search","codegraph_callers","codegraph_callees",
                     "codegraph_node","codegraph_status","codegraph_files"],
  "deniedTools": ["codegraph_impact"],
  "appliedScopes": ["company"]
}
```

`allowedTools` is the post-intersection allow set; `effectiveTools` is what an
agent can actually call. The company denied `codegraph_impact`; the restricted
agent's own allow list narrowed it further to two tools and could not re-grant the
denied one.

## 7. Tests

```
$ npx vitest run
 Test Files  7 passed (7)
      Tests  157 passed (157)
```

| File | Covers |
|---|---|
| `tests/governance.spec.ts` | narrowing-only algebra, deny-wins, per-company binding, forged-id resistance, document validation |
| `tests/store-isolation.spec.ts` | `ctx.state` partitioning; `loadForResolve` provably cannot see another tenant |
| `tests/sanitize.spec.ts` | path refusal: relative, NUL, missing, non-directory, shallow, credential dirs, symlink escape, allowed-root containment |
| `tests/config.spec.ts` | config defaults, type and range rejection, schema/field coverage |
| `tests/arguments.spec.ts` | `projectPath` stripping, unknown-key rejection, required/enum/type/length checks |
| `tests/mcp-client.spec.ts` | live stdio JSON-RPC against a fake server: handshake, `tools/list`, `tools/call`, projectPath override, timeouts, exit mid-call, pool reuse, env redaction |
| `tests/provision-and-manifest.spec.ts` | manifest validity; native-MCP provisioning plan shape and ordering |

Two real defects were found by these tests and by live runs:

1. **Pool reuse** — a pooled-but-not-yet-started MCP server was considered dead,
   so every call would have spawned a fresh process. Caught by
   `tests/mcp-client.spec.ts` and fixed with an explicit `reusable` state.
2. **Setup aborting on a failed config read** — the instance-scoped
   `ctx.config.get()` during `setup()` fails on the live host, and the early
   return left the plugin reporting `ready` with *no handlers registered at all*.
   Diagnosed from `{"code":"WORKER_ERROR","message":"No action handler registered
   for key \"explain-scope\""}` and fixed by registering unconditionally and
   deciding enablement per call.

A third was found live: a supervisor-started Paperclip had a `PATH` without
`~/.npm-global/bin`, so a bare `codegraph` was invisible to the plugin. Fixed by
searching conventional install directories and threading the resolved absolute
path through every step.

## 8. Not captured — audit rows for an agent call

See `ASSUMPTIONS.md` §5.1. A live agent-heartbeat tool call could not be driven
in this environment: plugin tools require an agent run context, the company's
agents are `pending_approval`, and direct agent creation is refused pending board
approval. Paperclip's `tool_gateway.*` audit rows for a CodeGraph call are
therefore unverified by observation. Exact reproduction steps are in
`ASSUMPTIONS.md`.
