# paperclip-codegraph v0.3.1

Fixes a privilege-widening bug in the settings page introduced in 0.3.0.

## The bug

The settings page built a whole governance document from its form and saved it.
Every field the form did not show was therefore deleted on save. On a company
that already had governance configured, pressing **Save** silently:

- **cleared tool denials** — it sent `deniedTools: []`, so a restriction an
  admin had set was removed, *widening* access;
- **deleted every repository but the one typed**, although a company can bind
  many;
- **dropped agent overrides** it had not created, including ones written by
  automation.

## The fix

The write path is now a pure function, `src/governance/merge.ts`, pinned by 24
tests. One rule: **the form may only change what it shows, and may only delete
what the operator explicitly removed.**

- Repositories are a **list** — add and remove rows, pre-loaded from the bound
  projects, instead of a single input.
- Save **merges**: it re-reads the live document, so a stale form cannot clobber
  a concurrent change, and it preserves each binding's `displayName` and
  per-repository policy.
- **`policy` is never rewritten.** It is preserved verbatim, and seeded only for
  a company that has none. This page has no way to clear a denial.
- Agent overrides for agents the form did not list are left untouched. Ticking an
  agent clears a disable flag while keeping any narrowing policy; unticking
  disables it without discarding the policy.
- A company with no overrides yet defaults to granting everybody, so a first run
  does not silently deny every agent.
- A company an admin disabled is never silently re-enabled.

## Verified

- 187 tests, including 24 merge tests and a regression test that runs against a
  **document captured from a real instance** — one that had a denial and an agent
  override configured before the page was ever opened. It asserts `policy`
  survives byte-identical.
- 23/23 live isolation checks against the npm-installed artifact, unchanged.
