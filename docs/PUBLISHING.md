# Publishing

What was published, what was not, and the exact commands for each.

## npm

The Paperclip plugin ecosystem distributes via npm —
`paperclipai plugin install <package>` — and
`doc/plugins/PLUGIN_AUTHORING_GUIDE.md` says to "use npm packages as the
deployment artifact" and that "GitHub repository installs are not a first-class
workflow today". So npm is the distribution channel.

```bash
npm run build                     # emits dist/manifest.js + dist/worker.js
npm run typecheck
npm test
npm publish --access public       # unscoped name, so no --access needed
```

Verify what will ship:

```bash
npm pack --dry-run
```

The published tarball contains `dist/`, `README.md`, `LICENSE`, and
`package.json`. `paperclipPlugin` in `package.json` points the host at
`./dist/manifest.js` and `./dist/worker.js`.

Consumers install with:

```bash
paperclipai plugin install paperclip-codegraph
```

## GitHub

```bash
git init -b main
git add -A
git commit -m "paperclip-codegraph 0.1.0"
gh repo create paperclip-codegraph --public --source=. --push \
  --description "CodeGraph MCP tools for Paperclip agents, governed per company, project and agent"
```

Then a release:

```bash
gh release create v0.1.0 --title "v0.1.0" --notes-file docs/RELEASE-NOTES-0.1.0.md
```

## Paperclip plugin registry / marketplace

**No official submission endpoint exists.** Evidence:

- `paperclipai plugin --help` lists install/list/enable/disable/inspect/examples/
  ui-contributions/tools/tool:execute/health/logs/upgrade/config/… — there is no
  `publish`, `submit`, or `registry` command.
- The plugin authoring guide names npm as the artifact and describes no registry,
  and explicitly notes that GitHub installs are not first-class.
- The README's "Community & Plugins" section points at
  [`awesome-paperclip`](https://github.com/gsxdsm/awesome-paperclip), a
  community-maintained list rather than a registry with an API.

The closest thing to a registry entry is therefore a pull request adding the
plugin to the community list. **Submitted:**

- **PR:** https://github.com/gsxdsm/awesome-paperclip/pull/41 — adds
  `paperclip-codegraph` to the *Plugins* category in alphabetical position,
  with the repo and npm links and a checklist against that repo's quality
  standards.

If Paperclip later ships an official registry, the artifact is already in the
shape it would consume: a public npm package whose `package.json` carries the
`paperclipPlugin` runtime entrypoints and whose manifest passes host validation
(confirmed by `status=ready` on install).

## Published artifacts

| Artifact | Location |
|---|---|
| GitHub repository (public) | https://github.com/conreo/paperclip-codegraph |
| GitHub release `v0.1.0` | https://github.com/conreo/paperclip-codegraph/releases/tag/v0.1.0 |
| npm package | `paperclip-codegraph@0.1.0` — https://www.npmjs.com/package/paperclip-codegraph |
| Community list PR | https://github.com/gsxdsm/awesome-paperclip/pull/41 |

Verified after publishing: the plugin was **uninstalled from the local path and
reinstalled from the npm registry** into the live Paperclip `2026.817.0`
instance (`✓ Installed paperclip-codegraph v0.1.0 (ready)`), and the full
23/23 isolation suite was re-run against that npm-installed artifact
(`docs/evidence/e2e-isolation-npm-install.txt`).

## Local development install

```bash
npm install
npm run dev                        # esbuild --watch on dist/
paperclipai plugin install .       # local path → trusted local code
paperclipai plugin list
paperclipai plugin tools
```

Paperclip watches `dist/` for locally installed plugins and restarts the worker
about 500 ms after a rebuild. If a change does not appear, cycle the plugin:

```bash
paperclipai plugin disable paperclip-codegraph
paperclipai plugin enable  paperclip-codegraph
```

A local-path install runs trusted code from disk with no signature check and no
sandbox — which is also why it is the only way to test the worker end to end
before publishing.
