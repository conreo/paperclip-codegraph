# Architecture

## Module map

```
                     ┌──────────────────────────────────────────┐
  agent tool call ──▶│ Paperclip tool gateway (core)            │
                     │  profile/policy/binding decision + audit │
                     └───────────────────┬──────────────────────┘
                                         │ providerType: paperclip_plugin
                                         ▼
  src/worker.ts ─────────────────────────────────────────────────
    ├── loadConfig(ctx, companyId)      src/config.ts
    ├── validateArguments(spec, raw)    src/tools/validate.ts   ← strips projectPath
    ├── GovernanceStore.loadForResolve  src/governance/store.ts ← only this company
    ├── resolveScope(...)               src/governance/resolver.ts  (pure)
    ├── decideToolAccess(resolved, name)
    ├── resolveProjectPath(...)         src/governance/sanitize.ts
    ├── ensureBinary / ensureIndex      src/codegraph/manage.ts
    └── pool.acquire(...).callTool(...) src/mcp/client.ts → src/mcp/protocol.ts
                                         │
                                         ▼
                              codegraph serve --mcp   (stdio JSON-RPC)
```

`src/manifest.ts` declares the eight tools, the capability set, and the
instance-config JSON Schema. `src/governance/provision.ts` builds the payloads
for the alternative native-`local_stdio` integration path.

## Why the trust boundary sits where it does

The plugin worker is trusted local code with `node:child_process` and `node:fs`,
so the interesting question is not "can it read a file" but "which file is it
allowed to be told to read". Everything that answers that question lives in
`src/governance/` and is pure: no I/O, no host calls. That is what makes the
isolation properties unit-testable rather than aspirational.

### The five scopes

```
instance defaults → company → project binding → Paperclip project → agent
   (broadest)                                             (narrowest)
```

Only the **company** scope introduces a path. Every narrower scope may only
*select among* that company's already-bound `projectKey`s. This is why a forged
`agentId` or `paperclipProjectId` cannot escape: the worst it can do is choose a
different binding the company already owns.

### Narrowing-only algebra

`deniedTools` unions; `allowedTools` intersects. Consequences, all tested:

- any scope can deny, and no narrower scope can re-grant;
- an override that names a non-existent `projectKey` fails closed with
  `project_binding_missing` rather than falling back;
- an empty `allowedTools: []` means deny-all at that scope;
- a misconfigured override is a denial-of-service risk, never an escalation risk.

### Why resolution cannot see another tenant

`GovernanceStore` keys each company's document under
`(scopeKind: "company", scopeId: companyId)`. `loadForResolve(companyId)` returns
instance defaults plus **exactly one** company. `resolveScope` is therefore
incapable of reaching another tenant's bindings even if handed a forged
identifier — the data is not in the process. `tests/store-isolation.spec.ts`
asserts this by serializing the resolution input and checking the other company's
path does not appear anywhere in it.

An instance-scoped index entry exists solely so an admin surface can enumerate
configured company **UUIDs**; it holds no paths and no policies.

## `projectPath`: the single most important decision

Upstream accepts `projectPath` on every tool so one server can serve a monorepo.
In a multi-tenant control plane that is a cross-tenant read primitive. Defence in
depth, outermost first:

1. **Not declared.** `toJsonSchema()` strips it; every schema sets
   `additionalProperties: false`.
2. **Stripped on the way in.** `validateArguments` deletes any key not in the
   spec — `additionalProperties: false` is a declaration, not an enforcement.
3. **Injected at the transport.** `CodeGraphMcpServer.callTool` force-sets
   `projectPath` from its own resolved config, so even a caller that bypassed
   step 2 could not redirect the query.
4. **Enforced upstream.** The resolved allow set is passed as
   `CODEGRAPH_MCP_TOOLS`, so CodeGraph itself refuses a tool this scope may not
   call.

## Process lifecycle

`CodeGraphClientPool` keys a server by `(command, args, projectPath,
toolAllowlist, telemetry flag, daemon flag, extraEnv keys)`. Two governance
scopes never share a process unless every process-level input matches, because
CodeGraph holds both a per-process project cache and a per-process tool
allowlist.

Stop semantics matter: the `codegraph` npm shim runs the real bundled binary
through a blocking `spawnSync(..., {stdio:'inherit'})`, so a signal to the shim's
PID alone would orphan the server. The plugin spawns `detached` and kills the
whole process group, escalating to `SIGKILL` after five seconds, and `onShutdown`
closes the pool.

## Environment hygiene

The child receives an allowlist of environment variables, not `process.env`.
Paperclip's server process holds `DATABASE_URL` and API tokens; none of that is
CodeGraph's business. `extraEnv` keys matching
`secret|token|password|credential|api_key|private_key|database_url|dsn|auth` are
rejected with an error rather than forwarded and redacted later.

By default the plugin also hard-disables upstream egress: `DO_NOT_TRACK=1`,
`CODEGRAPH_TELEMETRY=0`, `CODEGRAPH_NO_UPDATE_CHECK=1`, `CODEGRAPH_NO_DOWNLOAD=1`.

## Error taxonomy

Denials are returned as `ToolResult.error` with a stable reason, never as
exceptions, because a policy decision is not a malfunction:

| Reason | Meaning |
|---|---|
| `plugin_disabled` | Master switch off for this company |
| `company_not_configured` | No governance entry — fail closed, never a fallback |
| `company_disabled` / `agent_disabled` / `paperclip_project_disabled` | Scope suspended |
| `no_project_bound` / `project_binding_missing` | No usable binding |
| `tool_denied` / `tool_not_allowed` | Tool-level decision |
| `invalid_config` / `governance_unreadable` / `invalid_arguments` | Bad input, surfaced clearly |

Path refusals carry a code from `PathRefusalCode` so an operator can tell
"relative" from "symlink escaped into `~/.ssh`".
