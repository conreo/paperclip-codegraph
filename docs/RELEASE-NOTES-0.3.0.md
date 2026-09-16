# paperclip-codegraph v0.3.0

Activation is now one page instead of a console snippet.

## Added

**A settings page.** The plugin's settings now show a *Status* list answering
"why doesn't it work?" in four independent lines — enabled, CLI found,
repositories directory set, repository indexed — then **Repository**, **who may
use it**, and a single **Activate CodeGraph** button. Activate creates the
Paperclip tool profile, binds it, and creates the MCP gateway. No credential is
handled: the bundle runs as trusted same-origin code inside the Paperclip app
and those calls carry the signed-in board member's own session.

**A repository folder picker, for free.** `localFolders` + `local.folders` make
the host render and validate a "Repositories directory" field with its own
health metrics — including `path_traversal` and `symlink_escape` checks.
Governance can then name a repository *relative* to it, and the folder becomes
the containment boundary, so `allowedProjectRoots` is optional in the common
case.

## Changed

**The configuration page went from 17 fields to 5.** It was a wall of prose with
the essentials buried. Now: `enabled`, `autoInstall`, `autoIndex`,
`allowedProjectRoots`, `codegraphCommand`. The rest are code defaults — the
server validates saved config with Ajv and the property set is closed, so
unexposed keys always take their default. Notably `useDaemon` (a documented
multi-tenant footgun) and the internal timeouts are no longer reachable, which
also means a company with no governance entry is denied outright rather than
falling back to a shared repository.

## Fixed

**Activation binds at company scope.** Paperclip keeps only the narrowest
matching binding tier, so the agent-scoped binding an earlier plan proposed would
have silently stopped that agent's company profile applying — granting CodeGraph
could have revoked their other tools. Per-agent restriction now happens in the
plugin's own governance, which narrows without replacing.

**Agents still cannot choose a folder.** Letting an agent name a path to index is
the cross-tenant read this plugin exists to remove. Agents may only select among
bindings their company already owns.

## Verified

163 unit and integration tests, and 23/23 live isolation checks against the
npm-installed artifact on Paperclip `2026.817.0`: two companies bound to two
repositories, each served only its own files, forged project/agent ids
ineffective, company-scoped governance reads unable to see each other.

## Known limitations

- The settings page has not been visually confirmed — the host accepts the slot
  and registers the bundle (`uiEntryFile=index.js`), but rendering is unverified.
- No UI for editing the governance document's advanced narrowing (per-project
  overrides, per-agent allow lists beyond the checkbox list).
- An agent-heartbeat tool call is still unverified end to end; plugin tools need
  a run context, and creating an agent needs board approval.
