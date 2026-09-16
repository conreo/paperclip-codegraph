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
    // Reading the Paperclip objects a scope is keyed on, to validate that a
    // company/project/agent id from a run context is real before trusting it.
    "companies.read",
    "projects.read",
    "agents.read",
    // The governance document (which company may read which codebase).
    "plugin.state.read",
    "plugin.state.write",
    // Plugin-attributed audit entries for governance decisions. Paperclip's own
    // gateway audit for each tool call is separate and always written.
    "activity.log.write",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  instanceConfigSchema: INSTANCE_CONFIG_SCHEMA,
  tools: CODEGRAPH_TOOL_SPECS.map((spec) => ({
    name: spec.name,
    displayName: spec.displayName,
    description: spec.description,
    parametersSchema: toJsonSchema(spec),
  })),
};

export default manifest;
