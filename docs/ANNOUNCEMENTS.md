# Announcement drafts

**Status: nothing was posted.** Posting to Discord, X/Twitter, LinkedIn, or
Reddit requires account credentials and interactive auth that this environment
does not have. The drafts below are ready to paste. Fill in the two placeholders
(`<REPO_URL>`, `<DEMO_URL>`) before posting.

---

## GitHub Discussions (Paperclip repo, "Show and tell" / Plugins category)

**Title:** `paperclip-codegraph` — CodeGraph code intelligence, governed per company/project/agent

I built a Paperclip plugin that brings CodeGraph's code-intelligence MCP tools to
agents, with the tenant boundary enforced by Paperclip rather than by a runtime
config file.

**The problem.** CodeGraph ships as a local stdio MCP server (`codegraph serve
--mcp`) and accepts an optional `projectPath` on every tool so one server can
serve a monorepo. In a multi-org Paperclip deployment that parameter is a
cross-tenant read primitive: an agent in Company A can just name Company B's
checkout. A runtime-level MCP entry can't express "Company A may read only
`/srv/acme-web`".

**What the plugin does.** It registers CodeGraph's eight tools as **plugin agent
tools** (`ctx.tools.register`), so every call flows through Paperclip's tool
gateway and gets a profile/policy decision plus audit records. On top of that it
keeps its own governance document — which codebase each company may read, with
per-project and per-agent narrowing — and it *removes* `projectPath` from every
tool schema, injecting the resolved path itself.

```bash
paperclipai plugin install paperclip-codegraph
```

**Two design points others might find useful:**

- Plugin tools are `providerType: paperclip_plugin`, so Paperclip's **default-deny
  applies**: installing the plugin grants an agent nothing until an operator
  writes a profile that includes the tools. I think that's the right default and
  worth stating plainly.
- Scopes are **narrowing-only** (denies union, allows intersect). A project or
  agent override can only ever name a binding the company already owns, so a
  misconfigured override is a DoS risk, never an escalation.

**Verified.** 157 unit/integration tests, plus a 20/20 live isolation suite
against Paperclip `2026.817.0`: two companies bound to two repositories, each
served only its own files. Docs and evidence in the repo.

**Known limitations.** No UI yet; governance is one document per company with no
optimistic concurrency; an agent-heartbeat tool call was not exercised end to end
because plugin tools need a run context and creating an agent needs board
approval (`docs/ASSUMPTIONS.md` §5.1 has repro steps). Also note Paperclip's
`tool_name` profile entries are exact matches, not globs, and policies are
first-match-wins by priority.

Repo: `<REPO_URL>`

Feedback very welcome, especially on the governance model and on whether a
plugin *should* be able to register MCP connections — today it can't, which is
why the native `local_stdio` path is a generated plan executed with a board key
rather than something the plugin does itself.

---

## awesome-paperclip (PR or issue)

**Title:** Add `paperclip-codegraph` — CodeGraph code intelligence with per-company governance

```markdown
- [paperclip-codegraph](https://github.com/conreo/paperclip-codegraph) — Exposes
  [CodeGraph](https://github.com/colbymchenry/codegraph)'s code-intelligence MCP
  tools to agents, governed per company, project, and agent. Denies cross-tenant
  repository reads by construction; all calls flow through Paperclip's tool
  gateway and audit log.
  Install: `paperclipai plugin install paperclip-codegraph`
```

---

## X / Twitter

> Shipped `paperclip-codegraph`: CodeGraph's code-intel MCP tools for
> @paperclipai agents, with governance that actually holds in multi-tenant.
>
> Each company binds its own repos. Agents can't pass `projectPath` — it's not in
> the schema, it's stripped from args, and the plugin injects it.
>
> Default-deny: installing it grants nothing.
>
> `paperclipai plugin install paperclip-codegraph`
> <REPO_URL>

---

## LinkedIn

**Headline:** Governing code-intelligence tools across tenants in a multi-agent control plane

We use AI coding agents that read a whole codebase to answer questions. CodeGraph
does this well locally: it pre-indexes a repository into a knowledge graph and
serves it over MCP.

The hard part isn't the index. It's that in a multi-tenant control plane for AI
agent "companies", putting CodeGraph at the process level lets every tenant's
agent read every repository on the host — and the upstream tool accepts an
optional `projectPath`, which is a cross-tenant read primitive dressed as a
convenience parameter.

We built `paperclip-codegraph` to move that decision into the governance layer:

- CodeGraph's tools register as Paperclip agent tools, so every call passes
  through Paperclip's profile/policy engine and lands in the audit log.
- Each company binds its own repositories; project and agent scopes can only
  narrow, never widen.
- `projectPath` is absent from the tool schema, stripped from incoming arguments,
  and injected by the plugin from the caller's own binding — three independent
  places, because a schema flag is a declaration, not an enforcement.
- Installing the plugin grants nothing. Paperclip's default-deny means an
  operator must explicitly include the tools in a profile.

Verified with 157 tests and a live two-company isolation suite on Paperclip
2026.817.0. MIT. Install with `paperclipai plugin install paperclip-codegraph`.

Repo: `<REPO_URL>`

---

## Reddit (r/LocalLLaMA, r/LLMDevs, r/devops — tailor per sub)

**Title:** I built a governance layer for code-intelligence MCP tools so tenant A can't read tenant B's repo

CodeGraph indexes a repo locally and serves it over MCP (`codegraph serve --mcp`).
Great tool. But it takes an optional `projectPath` argument so one server can
serve a monorepo — which in a multi-tenant setup means an agent can just name
someone else's checkout.

`paperclip-codegraph` is a Paperclip plugin that fixes this properly:

1. Registers CodeGraph's 8 tools as plugin agent tools → every call goes through
   Paperclip's gateway (profile/policy decision + audit).
2. Keeps a governance doc: company → repository bindings, with project/agent
   overrides that can only *narrow*.
3. Deletes `projectPath` from the schema and from incoming args, then injects the
   resolved path itself at the transport layer.
4. Passes the resolved allowlist to CodeGraph via `CODEGRAPH_MCP_TOOLS`, so
   CodeGraph refuses a tool the scope may not call.
5. Defaults to no network: `DO_NOT_TRACK=1`, `CODEGRAPH_TELEMETRY=0`,
   `CODEGRAPH_NO_UPDATE_CHECK=1`, `CODEGRAPH_NO_DOWNLOAD=1`.

Refuses to index credential directories (`~/.ssh`, `~/.paperclip`, `/etc`, …) and
resolves symlinks before checking containment, so a symlink can't escape an
allowed root.

157 tests; 20/20 live isolation checks against Paperclip 2026.817.0 with two
companies and two real CodeGraph indexes. MIT.

`paperclipai plugin install paperclip-codegraph` · `<REPO_URL>`

Happy to hear where the governance model is wrong.

---

## Discord / Slack (short form)

> **paperclip-codegraph** — CodeGraph's MCP tools for Paperclip agents, governed
> per company/project/agent.
>
> `paperclipai plugin install paperclip-codegraph`
>
> Each company binds its own repos; agents can't pass `projectPath` (not in the
> schema, stripped from args, injected by the plugin). Narrowing-only overrides.
> Default-deny — installing it grants nothing. Local-only, no telemetry by
> default.
>
> 157 tests + a 20/20 live two-company isolation suite on Paperclip 2026.817.0.
> MIT. <REPO_URL>
>
> Known gaps: no UI, no optimistic concurrency, and an agent-heartbeat call isn't
> verified end-to-end yet. Feedback welcome.
