# paperclip-codegraph v0.12.1

Two things: a credential leak this plugin was capable of, and the MCP wiring extended
to a second organization.

## A clone URL can carry a token, and this plugin was reading it

`git remote get-url origin` returns whatever is configured, and a CI-provisioned
checkout often carries a token in it:

```
https://oauth2:glpat-…@git.example.com/group/repo.git
```

This plugin reads that URL to label a repository — the identity work in 0.9.2 — and a
label gets rendered, logged and written into audit rows. The URL itself was returned
to callers unmasked. Found while wiring the second organization, not by a report.

`redactRemoteUrl` now strips a `user:secret@` authority **at the boundary**, before
the name is derived from it, so neither the URL nor the label can carry a token.

It redacts only when a secret is present: `ssh://git@github.com/…` has a user but no
password, and masking `git` there would destroy information rather than protect any.
The first version of the fix over-redacted exactly that case, and the test caught it.

Six tests, including the real GitLab form and the assertion that the token is absent
from the result for three URL shapes.

**If your instance uses a tokenised clone URL, rotate the token.** It has been sitting
in a config file and in the output of every `git remote -v` an agent runs, which is a
larger exposure than this plugin.

## MCP wiring extended to delthai

The wiring added for `sake` — a `--mcp-config` path in each agent's adapter arguments,
and a CodeGraph stdio server in the company's own MCP file — now covers the second
organization that can actually use it.

| Org | pi_local agents | wired | why |
|---|---|---|---|
| **DEL** | 33 | **33** | Has an indexed repository (640 files, 12,085 nodes, 32,373 edges) and the plugin enabled |
| SAK | 17 | 6 | As before — the five engineers and the CEO |
| DEA | 10 | 0 | Its workspace is **not a git repository** and has no index |
| GLU | 11 | 0 | Two git workspaces, **neither indexed** |
| REG | 6 | 0 | No repository workspace at all |

An MCP server pointing at a repository with no index answers nothing, so wiring those
would have been a server that fails on first use. Extending to them is a two-step
job — build the index, then wire — and the settings page has the button.

`opencode_local` agents are excluded on purpose: the wiring passes `pi-mcp-adapter`,
which that adapter does not use. `sake` and `delthai` each have one such agent.

## Testing

480 tests, 475 passing and 5 skipped.
