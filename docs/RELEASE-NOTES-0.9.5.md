# paperclip-codegraph v0.9.5

Fixes the **Index now** / **Rebuild** buttons, which returned `[object Object]`.

## Why the buttons were broken

There was no `index-now` handler at all.

`ctx.actions.register("index-now", …)` was deleted by commit `56d44c2`, *"remove
the agent access-request flow"*. That commit removed a tool, a store, two actions
and a helper — and this action, which had nothing to do with any of it, went with
them. The UI kept calling `usePluginAction("index-now")`, so the bridge looked up
a key nobody had registered, threw, and the thrown object reached the page as
`[object Object]`.

It shipped that way for four releases, through a settings page rewrite. Nothing
failed: no type error, no test, and the code path is only reachable by pressing a
button.

### Two failures, not one

**The missing handler.** `index-now` is restored against the current API: the
caller sends a Paperclip `projectId`, the path is resolved through the host as
everywhere else, and a failed index is returned as a result rather than thrown so
the page can show what CodeGraph actually said. It indexes the repository root,
so it agrees with the graph view about where the index lives.

**The unreadable error.** `sanitizeErrorMessage`'s last resort was `String(raw)`,
which turns any thrown object into `"[object Object]"`. The bridge throws plain
objects of its own (`{ code, message, details }`), so objects are now normalised
by reading `message`, `error`, `detail`, `reason` in that order, unwrapping one
level of nesting (`{ error: { message } }`), and JSON-stringifying anything left —
so the shape survives instead of the message being lost. The redaction still runs
afterwards, so a token inside an object-supplied message is redacted exactly as it
is in a bare string.

The display bug is the reason this took a bug report to find: had the message been
readable, it would have said *"No handler registered for key index-now"*.

## The guard that was missing

The two sides of the bridge are plain strings, so nothing checked them against each
other. Every key now lives in `src/plugin-keys.ts`, used by both the worker and the
UI, and two test files enforce the contract:

- **`bridge-keys.spec.ts`** reads the UI sources and asserts that every key the UI
  asks for is registered, that every registered key is either called or explicitly
  listed as having no UI caller (`explain-scope`, `graph-diagnose` and friends are
  CLI-only, documented in the README), and that the list has not gone stale in
  either direction.
- **`worker-registration.spec.ts`** goes further: it stubs `runWorker`, calls the
  **real `setup()`** with a recording mock context, and asserts that every key in
  the shared registry was actually registered, that every handler is callable, and
  that no key is registered under a name the registry does not know.

That second file is the one that closes this class of bug, and it was verified by
re-introducing the deletion: with `index-now` renamed away, three tests fail with
`action key "index-now" was not registered`. With it restored, all pass.

Writing it also surfaced two real inconsistencies in the process — `agents` was
listed as having no UI caller while the UI calls it, and three genuinely CLI-only
keys were unaccounted for.

## Testing

381 tests across 22 files. New: 10 for thrown-object messages (including the
circular-object case, where a formatter that throws would be worse than the bug),
7 for the key contract, and 6 for real setup registration.

## Upgrading

```
paperclipai plugin install paperclip-codegraph@0.9.5
```

No manifest change, so no reload is strictly required — but if the buttons showed
`[object Object]`, reload to be sure you are on this build.
