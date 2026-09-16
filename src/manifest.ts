/**
 * Plugin manifest.
 *
 * The `tools` array is the static surface Paperclip reads at load time — before
 * any CodeGraph process exists — so it lists all eight upstream CodeGraph tools.
 * The plugin's governance resolver decides at call time which of them a given
 * company / project / agent may actually use, and Paperclip's own tool gateway
 * independently applies operator profiles on top.
 *
 * Declaring all eight here is also what makes a *disabled* plugin honest: with
 * `enabled: false` the worker registers nothing and the host's registry drops
 * every tool, so an agent sees no CodeGraph tools at all.
 */

import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { PLUGIN_ID, PLUGIN_VERSION } from "./constants.js";
import { INSTANCE_CONFIG_SCHEMA } from "./config.js";
import { CODEGRAPH_TOOL_SPECS, toJsonSchema } from "./tools/catalog.js";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "CodeGraph",
  description:
    "CodeGraph code-intelligence MCP tools for Paperclip agents, governed per company, project, and agent. Every call flows through Paperclip's tool gateway and audit log.",
  author: "conreo",
  categories: ["connector", "workspace"],
  capabilities: [
    // Registering the CodeGraph tool surface for agents.
    "agent.tools.register",
    // Least privilege, verified against the host's own operation→capability map
    // (`plugin-capability-validator.ts` / `host-client-factory.ts`):
    //   projects.getPrimaryWorkspace → project.workspaces.read
    //   agents.list                  → agents.read
    //   state.get/set                → plugin.state.read/write
    //   activity.log                 → activity.log.write
    // `companies.read` and `projects.read` were declared and never used: the
    // plugin reads no company and calls no `projects.list`/`projects.get`.
    "project.workspaces.read",
    // Reads this company's display name for the CodeGraph surfaces, so they can
    // say whose code they are showing instead of relying on the URL.
    "companies.read",
    // Lists this org's projects so the sidebar can show its repositories and
    // whether each is indexed.
    "projects.read",
    "agents.read",
    // The governance document (which company may read which codebase).
    "plugin.state.read",
    "plugin.state.write",
    // Plugin-attributed audit entries for governance decisions. Paperclip's own
    // gateway audit for each tool call is separate and always written.
    "activity.log.write",
    // Required by the settingsPage slot below. The host validates this pairing
    // and rejects the manifest without it, naming the capability in the error.
    "instance.settings.register",
    // The sidebar entry below.
    "ui.sidebar.register",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  ui: {
    slots: [
      {
        type: "settingsPage",
        id: "codegraph-settings",
        displayName: "CodeGraph",
        exportName: "SettingsPage",
      },
      {
        // Where the operator actually works: repositories with index status and
        // an Index now button, plus the per-agent switches.
        type: "sidebar",
        id: "codegraph-sidebar",
        displayName: "CodeGraph",
        exportName: "CodeGraphSidebar",
      },
    ],
  },
  instanceConfigSchema: INSTANCE_CONFIG_SCHEMA,
  tools: [
    ...CODEGRAPH_TOOL_SPECS.map((spec) => ({
    name: spec.name,
      displayName: spec.displayName,
      description: spec.description,
      parametersSchema: toJsonSchema(spec),
    })),
  ],
};

export default manifest;
