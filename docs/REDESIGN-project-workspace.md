# Redesign: derive the repository from the agent's Paperclip project

## Why

Two questions from the board, both correct:

1. **"Why does it show agents with permissions?"** — Paperclip already answers
   "who can do what" through project membership and agent assignment. A plugin
   keeping its own agent permission list is a second, parallel authority that can
   silently disagree with the first. It should not exist.

2. **"Why does it ask for a repo? Should that not be defined by the agent?"** —
   It should not be typed by anyone. The repository already exists as a
   **Paperclip project workspace**:

   ```
   /paperclip/instances/default/projects/<companyId>/<workspaceId>/pos
   ```

   Paperclip created that path and knows which agent runs against it. Asking an
   admin to retype it is duplicated state that can drift.

The current design came from optimising for what was easy to validate without a
live agent run, not for what is correct. Same mistake as the original curl
runbook.

## Target model

| Now | Becomes |
|---|---|
| Admin types a repository path | Repository = the workspace of the project the agent is running in |
| Admin ticks which agents may use it | Access = the agent runs in that project. Paperclip owns this. |
| 5 config keys + a folder setting | Nothing. Install and it works. |
| Agent requests access (0.4.0) | Obsolete: you ask to be on the project, which is Paperclip's own flow |

## The boundary that must survive

An agent must not be able to point CodeGraph at an arbitrary path — that is the
cross-tenant read this plugin exists to prevent. It is satisfied naturally here:
**an agent can only reach workspaces that already exist as Paperclip projects**,
and humans create those. The rule becomes:

> Resolve the repository from the run's project workspace, and accept it only if
> Paperclip itself owns that workspace.

Optional operator allowlist stays, as a narrowing on top, for deployments that
want one.

## Exact changes

1. **`src/worker.ts`, `handleToolCall`** — before consulting governance, resolve a
   workspace from `runCtx.projectId` via `ctx.projects.listWorkspaces()`. Validate
   with `resolveProjectPath`. Use it as the project path.
2. **`src/governance/resolver.ts`** — add an input for a workspace-derived binding
   so a company with no governance entry is *allowed when the run has a
   Paperclip-owned workspace*, instead of `company_not_configured`. This is the
   one semantic change; keep narrowing-only intact, and keep governance as an
   override that can only narrow.
3. **`src/ui/index.tsx`** — delete the repository list and the agent checklist.
   Leave Status + Activate. Show which project/workspace the current context
   resolves to, read-only.
4. **`src/worker.ts`, `readiness`** — report the resolved workspace from the
   project context; the folder setting becomes optional (already partly done).
5. **Delete `src/governance/requests.ts`, its actions, the
   `codegraph_request_access` tool, and `tests/requests.spec.ts`** once step 2
   lands. Keep the module until then — it is the only access path today.
6. **`docs/RUNBOOK.md`** — rewrite around "assign the agent to the project".

## Tests to write first

- A run in a Paperclip-owned workspace is allowed with **no** governance entry.
- A workspace path that Paperclip does not own is refused, even with a valid
  `projectId`.
- A forged `projectId` (another company's project) cannot produce a path.
- A governance binding can still *narrow* to a sub-path, and cannot widen beyond
  the workspace root.
- Absolute-path bindings keep working (no migration break).

## Risks

- `ctx.projects.listWorkspaces()` needs `project.workspaces.read`, which the
  manifest does not currently declare.
- A project may have several workspaces; pick deterministically (the run's
  checkout if available) and document the choice.
- Multi-repo monorepos: one workspace containing several `.codegraph/` indexes is
  fine (CodeGraph walks up to the nearest); several workspaces per project is the
  case to decide explicitly.
