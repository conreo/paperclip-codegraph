# paperclip-codegraph v0.12.0

The settings page is rebuilt as a **Paperclip settings page**, not a plugin form.

## What changed, and why it is a rework rather than a restyle

It was five bordered cards — Configuration, Activate, Repositories, Indexing,
Exceptions — with checkboxes, a Save button for everything, and explanatory prose
written for a reader who already knew the answers. Next to Paperclip's own General
settings it read as a form bolted on.

The reference was read, not guessed: `ui/src/pages/InstanceGeneralSettings.tsx` and
`ui/src/components/ui/toggle-switch.tsx`. What those files do, and what this now
does:

| | |
|---|---|
| **Page** | A `max-w-4xl` column with sections separated by space, **not** a card around each. |
| **Section** | One idea: a `text-sm font-semibold` heading, a short muted sentence, then its controls. |
| **Setting** | Heading left, control right — `flex items-start justify-between gap-4`. |
| **Switch** | A capsule that **writes immediately**. No Save button, because General settings has none, and a form that needs saving is one that can be abandoned half-changed. |
| **Typed values** | The one place a Save button appears, and it only appears once the text actually changed. |
| **On state** | The host's status green, not `primary` — which its `ToggleSwitch` records as a deliberate ruling. |
| **Failures** | One destructive-tinted banner, rather than a message beside each control. |

## The copy was rewritten to say what happens

The old text was accurate and unreadable — *"Availability follows the Paperclip
project an agent is working in, so this is set per repository rather than per
agent"*. Now:

- **Repositories** — *"An agent reaches the one its Paperclip project uses, so this
  is set here rather than per agent — and switching one off can only narrow."*
- **Index** — *"a repository with no index answers nothing. Building one reads the
  whole repository, which is why it happens when you ask rather than by itself."*
- **Directories CodeGraph may read** — *"A limit, not a list."* The field nobody
  could read is now answered in its first four words.
- **Exceptions** — *"Every agent reaches the repositories its projects use, so there
  is nothing to grant here. This is only for taking that away from one agent."*

Two things stay because they were asked for and are genuinely useful: the org name
in the page title, and the **MCP delivery gap** callout — which now names the fix
(*"Fix it per agent in its adapter settings, then restart that agent"*) as well as
the problem.

## Checkboxes became switches, and rows became rows

Repositories and agents were checkbox lists; they are now rows with the item on the
left — name, then a muted status line — and a switch on the right. A repository row
reads `POS · pos / Indexed · 587 files, 5250 symbols` and a switch, rather than a
tick box and a sentence about what ticking means.

## Testing

475 tests, 470 passing and 5 skipped. New: 12 that pin the structural rules as
source-level assertions, because the things that matter here are layout decisions
types cannot see — the reading width, the split row, the switch writing immediately
rather than behind a Save button, and the status green over `primary`.

They also pin the copy: that the switch is never described as a grant, that an
unindexed repository is explained rather than only reported, and that the directory
field says "a limit, not a list".

## Upgrading

```
paperclipai plugin install paperclip-codegraph@0.12.0
```

No manifest change, so no reload is strictly required.
