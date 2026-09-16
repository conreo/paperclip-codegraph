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
import { CODEGRAPH_FOLDER_KEY, PLUGIN_ID, PLUGIN_VERSION, REQUEST_ACCESS_TOOL } from "./constants.js";
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
    // The repository an agent is allowed to read is derived from the Paperclip
    // project it is working in, rather than typed into plugin config.
    "project.workspaces.read",
    "agents.read",
    // The governance document (which company may read which codebase).
    "plugin.state.read",
    "plugin.state.write",
    // Plugin-attributed audit entries for governance decisions. Paperclip's own
    // gateway audit for each tool call is separate and always written.
    "activity.log.write",
    // The operator picks the repository root in Paperclip's own folder settings
    // UI. The host validates the path (containment, symlinks) and reports health,
    // so the plugin never has to accept a hand-typed path from an agent.
    "local.folders",
    // Required by the settingsPage slot below. The host validates this pairing
    // and rejects the manifest without it, naming the capability in the error.
    "instance.settings.register",
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
    ],
  },
  instanceConfigSchema: INSTANCE_CONFIG_SCHEMA,
  localFolders: [
    {
      folderKey: CODEGRAPH_FOLDER_KEY,
      displayName: "Repositories directory",
      description:
        "Directory containing the repositories CodeGraph should index. Governance picks which repository inside it each company may read.",
      // readWrite because `autoIndex` runs `codegraph init`, which writes
      // `.codegraph/` into the repository. With autoIndex off it is only read.
      access: "readWrite",
    },
  ],
  tools: [
    {
      // Deliberately NOT one of the eight CodeGraph tools, and deliberately not
      // gated by CodeGraph's own governance: an agent with no grant must still
      // be able to ask for one. It is subject to Paperclip's own profile, which
      // is why Activate includes it.
      name: REQUEST_ACCESS_TOOL,
      displayName: "Request CodeGraph access",
      description:
        "Ask a board member for CodeGraph access to a repository. Use this when CodeGraph tools are denied for you. Records a request for a human to approve; it does not grant access by itself and does not need to be retried.",
      parametersSchema: {
        type: "object",
        properties: {
          repository: {
            type: "string",
            description:
              "Repository you need, by name (as bound) or path. Ask for one repository per request.",
          },
          reason: {
            type: "string",
            description:
              "Why you need it — what you are trying to find or change. The board decides on this.",
          },
        },
        required: ["repository", "reason"],
        additionalProperties: false,
      },
    },
    ...CODEGRAPH_TOOL_SPECS.map((spec) => ({
    name: spec.name,
      displayName: spec.displayName,
      description: spec.description,
      parametersSchema: toJsonSchema(spec),
    })),
  ],
};

export default manifest;
