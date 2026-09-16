# paperclip-codegraph v0.9.7

Fixes **Save configuration**, which failed with *"Configuration does not match the
plugin's instanceConfigSchema"*.

## Why saving failed

The save sent the merged stored document plus the form. The server validates that
payload with Ajv against `instanceConfigSchema`, which is **closed**
(`additionalProperties: false`), so every key beyond the five declared ones is not
a preserved setting — it is a rejected request.

The failure was deterministic and organisation-dependent, which is what made it
look arbitrary:

| Organisation | Stored keys | Save |
|---|---|---|
| `delthai` | 5 | worked |
| `sake` | 16 | **rejected** |

`sake` still carried a 0.6.0-shaped document — `useDaemon`, `codegraphArgs`,
`extraEnv`, `startupTimeoutMs`, `codegraphVersion`, `auditProjectPaths` and five
more. The form could not be saved at all on that organisation, with no visible
reason.

The merge existed for a good reason, applied in the wrong place: *a key the form
does not show must not be dropped* is the right rule for a governance document and
the wrong one for a schema-validated payload. The document an operator can edit is
exactly the schema, so that is what is sent now — `operatorConfigForSave` derives
the allowed key list from `instanceConfigSchema.properties`, so it cannot drift
from the schema it is validated against.

## Everything that is left out is named

Dropping keys silently would be the same class of mistake as dropping them
accidentally, so the save reports them:

> Configuration saved. This plugin no longer uses useDaemon, codegraphArgs, …,
> which were removed — they are not part of its settings any more.

This matters for one key in particular. **`useDaemon` was `true` on `sake`**, and
it is read by `normalizeConfig`, defaulting to off. The plugin's own warning about
it is worth repeating: with the shared daemon on, CodeGraph enforces
`CODEGRAPH_MCP_TOOLS` from its *own* environment, so when several governance scopes
query one project with different allowlists upstream applies only the first — and
**CodeGraph stops refusing a denied tool on its own**. The plugin's resolver still
denies correctly, so nothing was exposed, but one layer of defence was
inoperative. Saving now clears it to the documented default of off.

`codegraphVersion` was the other real key, and dropping it is also the documented
behaviour: the schema deliberately does not expose it, so it resolves to the code
default (`1.6.0` — the version actually installed). It only matters for
`autoInstall`, and a binary that is already found is never re-installed.

## Testing

400 tests across 23 files. The 5 new ones cover the reported failure directly:

- the payload contains **only** schema keys, checked against
  `instanceConfigSchema.properties` rather than a hardcoded list;
- a key smuggled in through the edits is refused, so the rule is enforced here
  rather than assumed of the caller;
- dropped keys are reported, and kept keys are not;
- saving is **stable** — saving what was just saved drops nothing further, so the
  message appears once rather than on every save;
- a real 0.6.0-shaped 16-key document is reproduced and proved saveable, with all
  five schema keys present and `useDaemon` among those dropped.

## Upgrading

```
paperclipai plugin install paperclip-codegraph@0.9.7
```

No manifest change. On an organisation that showed the error, the first save will
also clear the legacy keys — expect the message naming them.
