/**
 * Plugin-wide constants.
 *
 * Every CodeGraph tool name here is copied verbatim from the upstream CodeGraph
 * MCP server (`codegraph serve --mcp`, package `@colbymchenry/codegraph`,
 * verified against 1.6.0). Keeping the upstream names means an agent that
 * already knows CodeGraph needs no translation table, and an operator reading
 * `paperclipai plugin tools` sees the same vocabulary as the CLI's docs.
 *
 * Paperclip namespaces plugin tools as `<pluginId>:<toolName>`, so these are
 * exposed to agents as e.g. `paperclip-codegraph:codegraph_explore`.
 */

/** Manifest id and state namespace for this plugin. */
export const PLUGIN_ID = "paperclip-codegraph";

/** Namespace used for every `ctx.state` key this plugin writes. */
export const STATE_NAMESPACE = "governance";

/** State key holding the whole governance document. */
export const STATE_KEY = "profiles";

/** Schema version of the persisted governance document. */
export const GOVERNANCE_DOC_VERSION = 1;

/**
 * The operator-configured repository root, surfaced through Paperclip's native
 * `localFolders` settings UI.
 *
 * Declaring this means the host renders the path field, validates it
 * server-side (containment, `path_traversal`, `symlink_escape`) and shows
 * health metrics — so selecting the folder to index is a form field rather
 * than a hand-written governance path or a curl call.
 */
export const CODEGRAPH_FOLDER_KEY = "codegraph-repositories";

/** Manifest version; keep in sync with package.json. */
export const PLUGIN_VERSION = "0.7.3";

/**
 * `projectPath` is deliberately absent from every schema this plugin declares.
 *
 * Upstream CodeGraph accepts `projectPath` on all of its tools so one server can
 * serve a monorepo. In a multi-organization control plane that parameter is a
 * cross-tenant read primitive: an agent in Company A could name Company B's
 * checkout. This plugin removes it from the schema and injects the resolved path
 * itself, from the governance binding for the caller's company/project/agent.
 *
 * See `docs/ARCHITECTURE.md` § "Why `projectPath` is not exposed".
 */
export const UPSTREAM_PROJECT_PATH_PARAM = "projectPath";

/** The exact set of tools CodeGraph 1.6.0 exposes. */
export const CODEGRAPH_TOOLS = [
  "codegraph_explore",
  "codegraph_search",
  "codegraph_callers",
  "codegraph_callees",
  "codegraph_impact",
  "codegraph_node",
  "codegraph_status",
  "codegraph_files",
] as const;

export type CodeGraphToolName = (typeof CODEGRAPH_TOOLS)[number];

/**
 * Default MCP launch command. Verified against `codegraph install --print-config
 * codex`, which writes exactly `command = "codegraph"`, `args = ["serve", "--mcp"]`.
 */
export const DEFAULT_MCP_COMMAND = "codegraph";
export const DEFAULT_MCP_ARGS: readonly string[] = ["serve", "--mcp"];

/** Upstream index directory, relative to the project root. */
export const CODEGRAPH_INDEX_DIR = ".codegraph";

/** Default timeouts. */
export const DEFAULT_CALL_TIMEOUT_MS = 60_000;
export const DEFAULT_INDEX_TIMEOUT_MS = 900_000;
export const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;

/** Hard caps so a hostile config cannot ask for an unbounded stdio buffer. */
export const MAX_RESULT_CHARS = 400_000;
export const MAX_ARG_STRING_CHARS = 4_000;
export const MAX_ARRAY_ITEMS = 200;

/**
 * Risk classification reported to Paperclip.
 *
 * Every CodeGraph tool is query-only: upstream advertises
 * `readOnlyHint: true, idempotentHint: true, openWorldHint: false` and indexes
 * are built by an explicit operator CLI call, never by an agent. Paperclip's
 * gateway infers plugin-tool risk from the tool *name* (see
 * `inferToolRisk` in `server/src/services/tool-gateway.ts`), and none of these
 * names match its write/destructive patterns, so all eight classify as `read`.
 * We record the expectation here and assert it in tests.
 */
export const EXPECTED_TOOL_RISK = "read" as const;
