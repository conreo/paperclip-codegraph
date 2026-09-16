/**
 * The CodeGraph tool surface as Paperclip sees it.
 *
 * Schemas are transcribed from CodeGraph 1.6.0's own `tools/list` response
 * (`dist/mcp/tools.js`, `tools` array). `projectPath` is stripped on purpose —
 * see `UPSTREAM_PROJECT_PATH_PARAM` in `../constants.ts`.
 *
 * These declarations are static because Paperclip reads plugin tools from the
 * manifest at load time, before any worker call. The plugin *also* validates the
 * live `tools/list` from the running CodeGraph server at call time, so a future
 * CodeGraph release that renames or removes a tool degrades to a clear error
 * instead of a silent mismatch.
 */

import type { CodeGraphToolName } from "../constants.js";

export interface CodeGraphToolParam {
  type: "string" | "number" | "boolean";
  description: string;
  enum?: readonly string[];
  default?: string | number | boolean;
}

export interface CodeGraphToolSpec {
  /** Upstream tool name, exposed to agents as `paperclip-codegraph:<name>`. */
  name: CodeGraphToolName;
  displayName: string;
  description: string;
  params: Record<string, CodeGraphToolParam>;
  required: readonly string[];
}

export const CODEGRAPH_TOOL_SPECS: readonly CodeGraphToolSpec[] = [
  {
    name: "codegraph_explore",
    displayName: "CodeGraph Explore",
    description:
      "PRIMARY CodeGraph tool — call this FIRST for almost any question about this repository or before editing it: how does X work, architecture, a bug, where/what is X, or surveying an area. Returns the verbatim source of the relevant symbols grouped by file in one capped call, plus the call path among them. Treat the returned source as already read; do not re-open those files.",
    params: {
      query: {
        type: "string",
        description:
          "A natural-language question, or a bag of symbol/file names to explore.",
      },
      maxFiles: {
        type: "number",
        description: "Maximum number of files to include (default: 12).",
        default: 12,
      },
    },
    required: ["query"],
  },
  {
    name: "codegraph_search",
    displayName: "CodeGraph Search",
    description:
      "Search the pre-built code index for symbols by name or partial name. Use for targeted lookups when you already know what the symbol is called.",
    params: {
      query: {
        type: "string",
        description: 'Symbol name or partial name (e.g. "auth", "signIn").',
      },
      kind: {
        type: "string",
        description: "Filter results by node kind.",
        enum: [
          "function",
          "method",
          "class",
          "interface",
          "type",
          "variable",
          "route",
          "component",
        ],
      },
      limit: {
        type: "number",
        description: "Maximum results (default: 10).",
        default: 10,
      },
    },
    required: ["query"],
  },
  {
    name: "codegraph_callers",
    displayName: "CodeGraph Callers",
    description:
      "Find every function or method that calls the given symbol. Use before changing a signature or behaviour to see who depends on it.",
    params: {
      symbol: {
        type: "string",
        description: "Name of the function, method, or class to find callers for.",
      },
      file: {
        type: "string",
        description:
          "Narrow to the definition in this file (path or suffix) when several symbols share a name.",
      },
      limit: {
        type: "number",
        description: "Maximum number of callers to return (default: 20).",
        default: 20,
      },
    },
    required: ["symbol"],
  },
  {
    name: "codegraph_callees",
    displayName: "CodeGraph Callees",
    description:
      "Find every function or method the given symbol calls. Use to trace what a piece of code depends on.",
    params: {
      symbol: {
        type: "string",
        description: "Name of the function, method, or class to find callees for.",
      },
      file: {
        type: "string",
        description:
          "Narrow to the definition in this file (path or suffix) when several symbols share a name.",
      },
      limit: {
        type: "number",
        description: "Maximum number of callees to return (default: 20).",
        default: 20,
      },
    },
    required: ["symbol"],
  },
  {
    name: "codegraph_impact",
    displayName: "CodeGraph Impact",
    description:
      "Analyse what code is affected by changing a symbol: the transitive dependency fan-out at a chosen depth. Use to size a change before making it.",
    params: {
      symbol: {
        type: "string",
        description: "Name of the symbol to analyse impact for.",
      },
      file: {
        type: "string",
        description:
          "Narrow to the definition in this file (path or suffix) when several symbols share a name.",
      },
      depth: {
        type: "number",
        description: "How many levels of dependencies to traverse (default: 2).",
        default: 2,
      },
    },
    required: ["symbol"],
  },
  {
    name: "codegraph_node",
    displayName: "CodeGraph Node",
    description:
      "Read one symbol's source plus its caller/callee trail, or read an indexed file with line numbers and its dependents. Use after explore when you need one hop more detail.",
    params: {
      symbol: {
        type: "string",
        description:
          "Name of the symbol to read (symbol mode). Omit it and pass `file` alone to read a file instead.",
      },
      includeCode: {
        type: "boolean",
        description:
          "Symbol mode: include the symbol's full body (default: false).",
      },
      file: {
        type: "string",
        description:
          'A file path or basename (e.g. "src/auth/session.ts") to read in file mode.',
      },
      offset: {
        type: "number",
        description: "File mode: 1-based line to start reading from.",
      },
      limit: {
        type: "number",
        description: "File mode: maximum number of lines to return.",
      },
      symbolsOnly: {
        type: "boolean",
        description:
          "File mode: return just the file's symbol map and dependents, without source.",
      },
      line: {
        type: "number",
        description:
          "Symbol mode only: disambiguate to the definition at or around this line.",
      },
    },
    required: [],
  },
  {
    name: "codegraph_status",
    displayName: "CodeGraph Status",
    description:
      "Report the state of the code index for this project: index presence, file and symbol counts, and freshness. Use when results look empty or stale.",
    params: {},
    required: [],
  },
  {
    name: "codegraph_files",
    displayName: "CodeGraph Files",
    description:
      "List the project's file structure from the index, optionally filtered by glob pattern and rendered as a tree, flat list, or grouped by language.",
    params: {
      path: {
        type: "string",
        description: "Restrict the listing to this subpath of the project.",
      },
      pattern: {
        type: "string",
        description: 'Glob pattern to filter files (e.g. "**/*.ts").',
      },
      format: {
        type: "string",
        description: "How to render the listing.",
        enum: ["tree", "flat", "grouped"],
        default: "tree",
      },
      includeMetadata: {
        type: "boolean",
        description: "Include per-file metadata such as language (default: true).",
        default: true,
      },
      maxDepth: {
        type: "number",
        description: "Maximum directory depth to descend in tree format.",
      },
    },
    required: [],
  },
] as const;

/** Lookup by upstream tool name. */
export const CODEGRAPH_TOOL_SPEC_BY_NAME: ReadonlyMap<string, CodeGraphToolSpec> =
  new Map(CODEGRAPH_TOOL_SPECS.map((spec) => [spec.name, spec]));

/** All upstream tool names, in declaration order. */
export const ALL_TOOL_NAMES: readonly string[] = CODEGRAPH_TOOL_SPECS.map(
  (spec) => spec.name,
);

/** JSON Schema for one tool, as required by `PluginToolDeclaration`. */
export function toJsonSchema(spec: CodeGraphToolSpec): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const [key, param] of Object.entries(spec.params)) {
    const property: Record<string, unknown> = {
      type: param.type,
      description: param.description,
    };
    if (param.enum) property["enum"] = [...param.enum];
    if (param.default !== undefined) property["default"] = param.default;
    properties[key] = property;
  }
  return {
    type: "object",
    properties,
    required: [...spec.required],
    additionalProperties: false,
  };
}
