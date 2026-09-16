# paperclip-codegraph v0.1.0

First release. CodeGraph's code-intelligence MCP tools for Paperclip agents, with
governance per company, per project, and per agent.

## Install

```bash
npm install -g @colbymchenry/codegraph@1.6.0   # the CodeGraph CLI
paperclipai plugin install paperclip-codegraph
```

The plugin installs **disabled**. Nothing changes for any agent until a company
opts in — see the README's configuration section.

## What's in it

**Eight tools**, registered as Paperclip agent tools via the Plugin SDK and named
exactly as upstream names them, so nothing has to be translated:
`codegraph_explore`, `codegraph_search`, `codegraph_callers`, `codegraph_callees`,
`codegraph_impact`, `codegraph_node`, `codegraph_status`, `codegraph_files`.

**Multi-organization governance.** Each company binds its own CodeGraph
repositories. Per-Paperclip-project and per-agent overrides narrow that further.
The algebra is narrowing-only: denials union across scopes, allow lists
intersect, and a narrower scope can only ever *name* a binding the company
already owns. A misconfigured override is a denial-of-service risk, never an
escalation risk.

**Cross-tenant isolation by construction.** Upstream accepts an optional
`projectPath` on every tool so one server can serve a monorepo — which in a
multi-tenant control plane is a cross-tenant read primitive. This plugin removes
it from every schema, strips it from incoming arguments, and injects the resolved
path itself at the transport layer. It also passes the resolved allowlist to
CodeGraph through `CODEGRAPH_MCP_TOOLS`, so CodeGraph itself refuses a tool a
scope may not call.

**Defence in depth on paths.** Absolute and existence-checked, symlinks resolved
with `realpath` *before* containment is evaluated, `allowedProjectRoots`
enforced against the resolved target, and credential directories (`~/.ssh`,
`~/.aws`, `~/.paperclip`, `~/.dsh`, `/etc`, `/var/lib`, …) refused outright.

**Local-only by default.** `DO_NOT_TRACK=1`, `CODEGRAPH_TELEMETRY=0`,
`CODEGRAPH_NO_UPDATE_CHECK=1`, `CODEGRAPH_NO_DOWNLOAD=1` on every CodeGraph
process. The child gets an allowlist environment rather than the server's, and
`extraEnv` keys that look like credentials are rejected.

**Two audit layers.** Paperclip's gateway writes a `tool_gateway` event plus a
`tool_call_events` row and a `tool_invocations` row for every call, before and
after the handler runs — the plugin cannot skip it. The plugin separately logs
each governance decision with the operator's project *alias*, not a host path.

**Native-MCP provisioning path.** `native-mcp-plan` returns the exact REST plan
to also register CodeGraph as a Paperclip `local_stdio` connection with catalog
risk levels and approval flow; `scripts/provision-native-mcp.mjs` executes it.

## Verified

- 157 unit and integration tests pass.
- 20/20 live isolation checks against Paperclip `2026.817.0` in `local_trusted`
  mode, with two companies bound to two real CodeGraph indexes: each company is
  served only its own files, forged project/agent ids cannot escape, and
  company-scoped governance reads cannot see each other.
- Plugin installs `ready`; `paperclipai plugin tools` lists all eight namespaced
  tools; `paperclipai plugin health` reports healthy.

Two real defects were found and fixed during this work: an MCP pool that would
have spawned a process per call, and a `setup()` that aborted on a failed
instance-scoped config read — leaving the plugin reporting `ready` with no
handlers registered at all.

## Requirements

Paperclip `>= 2026.817.0`, the CodeGraph CLI `1.6.0`, Node `>= 24.11.0` for the
Paperclip server. No database, no network, no credentials.

## Known limitations

- No plugin UI; admin surfaces are actions and the CLI.
- Governance is one document per company with no optimistic concurrency.
- An agent-heartbeat tool call was not verified end to end — plugin tools need a
  run context, and creating an agent requires board approval. Repro steps are in
  `docs/ASSUMPTIONS.md` §5.1.
- Paperclip's `tool_name` profile entries are exact matches, not globs.
- Paperclip policies are first-match-wins by priority, so an `allow` at a low
  priority number can beat a `block` at a high one.
- `autoIndex` is off by default; indexing is CPU- and disk-intensive and mutates
  the checkout.
- Windows process cleanup uses a single-process kill rather than a group kill.

## License

MIT. Integrates [Paperclip](https://github.com/paperclipai/paperclip) and
[CodeGraph](https://github.com/colbymchenry/codegraph), both MIT.
