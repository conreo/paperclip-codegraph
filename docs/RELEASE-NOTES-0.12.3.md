# paperclip-codegraph v0.12.3

The "cannot receive these tools" warning was naming the wrong cause.

## What it said, and why it was misleading

On an organization where the plugin had **never been configured or activated at all**,
the Exceptions section said:

> 5 of 11 agents cannot receive these tools yet. An active profile only makes the tools
> allowed. An agent also needs an MCP client pointed at this organization's MCP config…
> Fix it per agent in its adapter settings, then restart that agent.

Every sentence is true of a different situation. When the plugin is **off**, no agent
receives anything whatever its adapter says — so the adapter is not the problem, and
that paragraph sends an operator to the wrong settings page to fix it.

Off is exactly the state a fresh organization is in: `GlucoChef`, `dealthai` and
`Regency` have no config row and no profile at all, so the plugin is off by default
there. The warning was their first impression of the feature, and it was wrong.

## Two states, named separately

- **Plugin off** — *"CodeGraph is off for this organization, so no agent receives these
  tools yet whatever its adapter is set to. Switch it on at the top of this page, and
  this section will say whether anything else is still missing."* No mention of adapters.
- **Plugin on, wiring missing** — the wiring warning, now opening with the fact that
  earns it: *"CodeGraph is on, and an active profile makes these tools allowed — but an
  agent also needs an MCP client…"*

The off-state note comes first in the conditional chain, so it wins when both are true.

## Testing

486 tests, 481 passing and 5 skipped. Two new ones: that the off-state explanation
precedes the wiring warning in the chain, and that revoked agents stay excluded from
the count — an agent somebody switched off is a choice, not a gap.
