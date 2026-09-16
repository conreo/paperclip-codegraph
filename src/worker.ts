/**
 * Plugin worker entrypoint.
 *
 * ## Call path
 *
 * ```
 * agent calls paperclip-codegraph:codegraph_explore
 *   → Paperclip tool gateway: policyService.decide() over operator profiles,
 *     policies and bindings; writes `tool_gateway.call_allowed` + a
 *     `tool_invocations` row + a call event   ← host-owned, this plugin cannot skip it
 *   → this worker's handler
 *       → re-check enabled
 *       → validate arguments against the declared schema
 *       → resolve governance for runCtx.companyId / projectId / agentId
 *       → decide this tool against that resolution
 *       → sanitize the resolved path
 *       → ensure the index exists (only if autoIndex)
 *       → stdio JSON-RPC to `codegraph serve --mcp`, with projectPath injected
 *   → result clamped, then validated by the host's content guards
 * ```
 *
 * Two independent governance layers therefore apply: Paperclip's, which this
 * plugin neither duplicates nor bypasses, and this plugin's own scope resolver,
 * which answers the question Paperclip cannot — *whose codebase is this?*
 *
 * ## What makes cross-tenant reads structurally impossible
 *
 * 1. `projectPath` is **not** in any tool's declared schema, and any value the
 *    caller supplies under that key is deleted before the upstream call.
 * 2. The path used upstream is read from the governance binding for
 *    `runCtx.companyId`, and `GovernanceStore.loadForResolve` loads only that
 *    company's slice — other tenants' bindings are never in memory.
 * 3. Overrides at project and agent scope can only *name* a binding the company
 *    already owns; they cannot introduce a path.
 * 4. Every path is re-validated (absolute, existing, symlink-resolved, inside
 *    `allowedProjectRoots`) at call time, not just at write time.
 */

import path from "node:path";

import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import type { PluginContext, ToolResult, ToolRunContext } from "@paperclipai/plugin-sdk";

import {
  CODEGRAPH_FOLDER_KEY,
  CODEGRAPH_INDEX_DIR,
  CODEGRAPH_TOOLS,
  PLUGIN_ID,
  UPSTREAM_PROJECT_PATH_PARAM,
  MAX_ARG_STRING_CHARS,
  MAX_SOURCE_BYTES,
  MAX_SOURCE_LINES,
} from "./constants.js";
import { normalizeConfig, type RuntimeConfig } from "./config.js";
import { CodeGraphClientPool, buildChildEnv } from "./mcp/client.js";
import {
  CODEGRAPH_TOOL_SPECS,
  toJsonSchema,
  type CodeGraphToolSpec,
} from "./tools/catalog.js";
import { validateArguments } from "./tools/validate.js";
import { GovernanceStore } from "./governance/store.js";
import {
  decideToolAccess,
  parseGovernance,
  resolveScope,
  visibleTools,
  GovernanceValidationError,
} from "./governance/resolver.js";
import type { CompanyGovernance, GovernanceDocument, ScopePolicy } from "./governance/types.js";
import {
  PathRefusal,
  resolveProjectPath,
  redactPath,
} from "./governance/sanitize.js";
import { buildNativeMcpPlan, renderPlanAsCurl } from "./governance/provision.js";
import {
  ensureBinary,
  ensureIndex,
  resolveCommand,
  runCommand,
  indexStatus,
  isIndexed,
  rebuildIndex,
} from "./codegraph/manage.js";
import { mergeGovernance, setAgentAccess, setProjectAccess } from "./governance/merge.js";
import {
  GraphUnavailable,
  neighbourhood,
  nodeById,
  searchNodes,
} from "./graph/neighbourhood.js";
import { readExcerpt } from "./graph/source.js";
import {
  NO_GIT_IDENTITY,
  indexRoot,
  isGitRepository,
  type CommandRunner,
  type GitIdentity,
} from "./git/identity.js";
import {
  acceptWorkspacePath,
  buildWorkspaceGovernance,
  shouldTryWorkspaceFallback,
} from "./governance/workspace.js";

// ---------------------------------------------------------------------------
// Module state (one worker process)
// ---------------------------------------------------------------------------

const pool = new CodeGraphClientPool();

/** Tool names registered in this worker instance; registration is not idempotent. */
const registeredTools = new Set<string>();

/**
 * How long one `git rev-parse` may take.
 *
 * Short on purpose: these are local config reads, so anything slow means git is
 * wedged rather than busy — and the caller falls back to the workspace path.
 */
const GIT_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

/**
 * Read and normalize config.
 *
 * A malformed config must never fall back to permissive defaults: if the
 * operator wrote something we cannot parse, every call is denied until they fix
 * it, and the reason says why.
 */
async function loadConfig(
  ctx: PluginContext,
  companyId?: string,
): Promise<{ config: RuntimeConfig; error: string | null }> {
  try {
    const raw = await ctx.config.get(companyId);
    return { config: normalizeConfig(raw), error: null };
  } catch (error) {
    return {
      config: normalizeConfig(undefined),
      error:
        error instanceof Error
          ? `Plugin configuration is invalid: ${error.message}`
          : "Plugin configuration is invalid",
    };
  }
}

function mcpEnv(config: RuntimeConfig): Record<string, string> {
  return buildChildEnv({
    command: config.codegraphCommand,
    args: config.codegraphArgs,
    projectPath: "/",
    extraEnv: config.extraEnv,
    allowTelemetry: config.allowTelemetry,
    useDaemon: config.useDaemon,
  });
}

/**
 * This company's display name, or null when it cannot be read.
 *
 * `companies.get` is namespace-checked by the host, and a failure here must not
 * take a page down with it: the name is a label, so null means the surfaces
 * simply omit it. The `companies.read` capability exists for this one call.
 */
async function organizationName(
  ctx: PluginContext,
  companyId: string,
): Promise<string | null> {
  try {
    const company = await ctx.companies.get(companyId);
    const name = (company as { name?: unknown } | null)?.name;
    return typeof name === "string" && name.trim().length > 0 ? name.trim() : null;
  } catch {
    return null;
  }
}

/**
 * The operator-configured repositories directory, or null when unset.
 *
 * This is the folder the admin picks in Paperclip's own folder settings UI, so
 * its path is host-validated (containment, symlink escape) rather than
 * hand-written by whoever edits governance. Governance can then name a
 * repository *relative* to it, which is the difference between "type the
 * absolute path of the repo" and "pick your repositories directory once".
 */
async function repositoryRoot(
  ctx: PluginContext,
  companyId: string,
): Promise<string | null> {
  // Always null, and deliberately so. The `localFolders` declaration was removed
  // in 0.5.3 because Paperclip rendered a permanent "Needs attention" badge for a
  // folder the plugin does not require; `localFolders.status` requires the
  // `local.folders` capability, which went with it. Calling it anyway produced a
  // guaranteed capability denial on every readiness check.
  //
  // Kept as a seam rather than deleted: every call site feeds this through
  // `bindingPathFor` and `containmentRoots`, both of which handle null, so
  // restoring a folder root is a manifest line plus a body here — and absolute
  // bindings and workspace-derived repositories are unaffected either way.
  void ctx;
  void companyId;
  return null;
}

/**
 * The repository the run is actually working in, per Paperclip.
 *
 * This is the correction to "why does it ask for a repo?": the path already
 * exists as a Paperclip project workspace, created by the host and owned by it.
 * `projectId` comes from the run context, not from an agent argument, so the
 * value is host-trusted; it is still validated like any other path before use.
 *
 * Returns null when there is no project context, no workspace, or the workspace
 * fails validation — in which case governance alone decides, exactly as before.
 */
async function workspaceForRun(
  ctx: PluginContext,
  companyId: string,
  projectId: string | null,
  roots: readonly string[],
): Promise<string | null> {
  if (!projectId) return null;
  try {
    // `projectId` comes from the run context, never from an agent argument, so
    // the value is host-trusted. It is still validated, and the host itself
    // checks that the project belongs to this company.
    const workspace = await ctx.projects.getPrimaryWorkspace(projectId, companyId);
    return acceptWorkspacePath(workspace?.path, roots);
  } catch {
    return null;
  }
}


/**
 * Turn a governance binding path into an absolute one.
 *
 * Relative paths resolve against the operator's folder; absolute paths are
 * taken as-is so an existing absolute-path deployment keeps working.
 */
function bindingPathFor(bindingPath: string, root: string | null): string {
  if (path.isAbsolute(bindingPath) || !root) return bindingPath;
  return path.join(root, bindingPath);
}

/**
 * Containment roots for path validation.
 *
 * The operator's folder is the boundary when set, so `allowedProjectRoots`
 * becomes optional in the common case. Explicit roots still win, because an
 * operator who wrote them meant them.
 */
function containmentRoots(config: RuntimeConfig, root: string | null): string[] {
  if (config.allowedProjectRoots.length > 0) return config.allowedProjectRoots;
  return root ? [root] : [];
}

// ---------------------------------------------------------------------------
// Argument validation
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Governance resolution
// ---------------------------------------------------------------------------

export interface DenialAuditContext {
  companyId: string;
  agentId: string | null;
  runId: string | null;
  paperclipProjectId: string | null;
}

async function audit(
  ctx: PluginContext,
  entry: DenialAuditContext,
  message: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  try {
    await ctx.activity.log({
      companyId: entry.companyId,
      message,
      entityType: "codegraph_tool_call",
      ...(entry.agentId ? { entityId: entry.agentId } : {}),
      metadata: {
        plugin: PLUGIN_ID,
        agentId: entry.agentId,
        runId: entry.runId,
        paperclipProjectId: entry.paperclipProjectId,
        ...metadata,
      },
    });
  } catch {
    // Audit failure must never turn a policy decision into an agent-visible
    // error; Paperclip's own gateway audit for this call is independent.
  }
}

// ---------------------------------------------------------------------------
// The tool handler
// ---------------------------------------------------------------------------

async function handleToolCall(
  ctx: PluginContext,
  spec: CodeGraphToolSpec,
  rawParams: unknown,
  runCtx: ToolRunContext,
): Promise<ToolResult> {
  const auditCtx: DenialAuditContext = {
    companyId: runCtx.companyId,
    agentId: runCtx.agentId ?? null,
    runId: runCtx.runId ?? null,
    paperclipProjectId: runCtx.projectId ?? null,
  };

  const { config, error: configError } = await loadConfig(ctx, runCtx.companyId);
  if (configError) {
    await audit(ctx, auditCtx, `${spec.name} denied: invalid plugin config`, {
      tool: spec.name,
      decision: "deny",
      reason: "invalid_config",
      detail: configError,
    });
    return { error: configError };
  }

  const argsResult = validateArguments(spec, rawParams);
  if (!argsResult.ok) {
    await audit(ctx, auditCtx, `${spec.name} denied: bad arguments`, {
      tool: spec.name,
      decision: "deny",
      reason: "invalid_arguments",
      detail: argsResult.error,
    });
    return { error: argsResult.error };
  }

  const store = new GovernanceStore(ctx.state);
  let document: GovernanceDocument;
  try {
    document = await store.loadForResolve(runCtx.companyId);
  } catch (error) {
    const detail =
      error instanceof GovernanceValidationError
        ? `Governance document is invalid: ${error.message}`
        : "Governance document could not be read";
    await audit(ctx, auditCtx, `${spec.name} denied: ${detail}`, {
      tool: spec.name,
      decision: "deny",
      reason: "governance_unreadable",
    });
    return { error: detail };
  }

  // ---------------------------------------------------------------------
  // Fallback binding for unconfigured companies — off unless explicitly on,
  // so multi-tenant isolation is the default posture.
  // ---------------------------------------------------------------------
  let resolved: ReturnType<typeof resolveScope>;
  try {
    if (
      config.bindDefaultProjectForUnconfiguredCompanies &&
      config.defaultProjectPath &&
      !document.companies[runCtx.companyId]
    ) {
      const seededPath = resolveProjectPath(config.defaultProjectPath, {
        allowedProjectRoots: config.allowedProjectRoots,
      });
      const seeded = parseGovernance({
        version: 1,
        companies: {
          [runCtx.companyId]: {
            enabled: true,
            defaultProjectKey: "default",
            projects: {
              default: { projectKey: "default", path: seededPath, displayName: "Default" },
            },
          },
        },
      });
      document = {
        version: 1,
        defaults: document.defaults,
        companies: seeded.companies,
      };
    }

    resolved = resolveScope(document, {
      companyId: runCtx.companyId,
      paperclipProjectId: runCtx.projectId ?? null,
      agentId: runCtx.agentId ?? null,
      pluginEnabled: config.enabled,
    });
  } catch (error) {
    if (error instanceof PathRefusal) {
      await audit(ctx, auditCtx, `${spec.name} denied: unsafe default project path`, {
        tool: spec.name,
        decision: "deny",
        reason: error.code,
      });
      return {
        error: `The configured default CodeGraph project path was refused: ${error.message}`,
      };
    }
    throw error;
  }

  // If governance could not produce a repository, fall back to the workspace
  // Paperclip says this run is working in. Implemented by re-resolving with a
  // synthetic binding rather than by bypassing the resolver, so the narrowing
  // algebra and every tool decision stay exactly as tested: existing policy,
  // agents and per-project overrides are carried over verbatim.
  // If governance could not produce a repository, fall back to the workspace
  // Paperclip says this run is working in. Implemented by re-resolving against a
  // document with the workspace added as a binding, rather than by bypassing the
  // resolver, so the narrowing algebra and every tool decision stay as tested.
  if (shouldTryWorkspaceFallback(resolved)) {
    const workspace = await workspaceForRun(
      ctx,
      runCtx.companyId,
      runCtx.projectId ?? null,
      containmentRoots(config, await repositoryRoot(ctx, runCtx.companyId)),
    );
    if (workspace) {
      const retry = resolveScope(
        buildWorkspaceGovernance({
          document,
          companyId: runCtx.companyId,
          workspacePath: workspace,
        }),
        {
          companyId: runCtx.companyId,
          paperclipProjectId: runCtx.projectId ?? null,
          agentId: runCtx.agentId ?? null,
          pluginEnabled: config.enabled,
        },
      );
      if (retry.allowed) resolved = retry;
    }
  }

  const decision = decideToolAccess(resolved, spec.name);
  if (!decision.allowed) {
    await audit(ctx, auditCtx, `${spec.name} denied by CodeGraph governance`, {
      tool: spec.name,
      decision: "deny",
      reason: decision.reason,
    });
    return {
      error:
        `CodeGraph tool "${spec.name}" is not permitted for this scope (${decision.reason}). ` +
        `Ask a Paperclip admin to grant it in the CodeGraph governance profile for your company.`,
    };
  }

  // ---------------------------------------------------------------------
  // Path re-validation at call time.
  // ---------------------------------------------------------------------
  const binding = resolved.project!;
  let projectPath: string;
  try {
    const root = await repositoryRoot(ctx, runCtx.companyId);
    projectPath = resolveProjectPath(bindingPathFor(binding.path, root), {
      allowedProjectRoots: containmentRoots(config, root),
    });
  } catch (error) {
    const detail =
      error instanceof PathRefusal
        ? `CodeGraph project binding "${binding.projectKey}" was refused: ${error.message}`
        : "CodeGraph project binding could not be validated";
    await audit(ctx, auditCtx, `${spec.name} denied: unsafe project binding`, {
      tool: spec.name,
      decision: "deny",
      reason: error instanceof PathRefusal ? error.code : "path_invalid",
      projectKey: binding.projectKey,
    });
    return { error: detail };
  }

  const env = mcpEnv(config);

  // ---------------------------------------------------------------------
  // Binary first, then index, then call.
  //
  // The binary is resolved before anything else because a supervisor-started
  // Paperclip may have a PATH without the per-user npm prefix; the resolved
  // absolute path is what every later step uses, so the index and the MCP
  // process are guaranteed to be the same build.
  // ---------------------------------------------------------------------
  const binary = await ensureBinary({
    command: config.codegraphCommand,
    autoInstall: config.autoInstall,
    version: config.codegraphVersion,
    timeoutMs: Math.max(config.startupTimeoutMs, 300_000),
    env,
  });
  if (!binary.ok || !binary.resolvedPath) {
    await audit(ctx, auditCtx, `${spec.name} failed: CodeGraph CLI unavailable`, {
      tool: spec.name,
      decision: "allow",
      outcome: "failure",
      reason: "binary_missing",
      projectKey: binding.projectKey,
      detail: binary.detail,
    });
    return { error: binary.detail };
  }
  const command = binary.resolvedPath;

  const indexResult = await ensureIndex({
    projectPath,
    autoIndex: config.autoIndex,
    command,
    timeoutMs: config.indexTimeoutMs,
    env,
  });
  if (!indexResult.ok) {
    await audit(ctx, auditCtx, `${spec.name} failed: project not indexed`, {
      tool: spec.name,
      decision: "allow",
      outcome: "failure",
      reason: "not_indexed",
      projectKey: binding.projectKey,
      detail: indexResult.detail,
    });
    return { error: indexResult.detail };
  }

  // ---------------------------------------------------------------------
  // The call.
  // ---------------------------------------------------------------------
  const startedAt = Date.now();
  const server = pool.acquire(
    {
      command,
      args: config.codegraphArgs,
      projectPath,
      // Pass the governance-approved set upstream so CodeGraph itself refuses a
      // tool this scope may not call — enforcement does not rest on our code.
      toolAllowlist: resolved.allowedTools,
      extraEnv: config.extraEnv,
      allowTelemetry: config.allowTelemetry,
      useDaemon: config.useDaemon,
      callTimeoutMs: config.callTimeoutMs,
      startupTimeoutMs: config.startupTimeoutMs,
    },
    () => {
      /* stderr is retained on the server for onHealth; never logged verbatim */
    },
  );

  try {
    const result = await server.callTool(spec.name, argsResult.args);
    const durationMs = Date.now() - startedAt;

    if (result.isError) {
      await audit(ctx, auditCtx, `${spec.name} returned an error`, {
        tool: spec.name,
        decision: "allow",
        outcome: "failure",
        reason: "upstream_error",
        projectKey: binding.projectKey,
        durationMs,
        ...(config.auditProjectPaths ? { projectPath } : {}),
      });
      return { error: result.text || "CodeGraph reported an error" };
    }

    await audit(ctx, auditCtx, `${spec.name} executed`, {
      tool: spec.name,
      decision: "allow",
      outcome: "success",
      reason: "ok",
      projectKey: binding.projectKey,
      effectiveScopes: resolved.trace.appliedScopes,
      durationMs,
      resultChars: result.text.length,
      truncated: result.truncated,
      ...(config.auditProjectPaths ? { projectPath } : {}),
      ...(argsResult.stripped.length > 0 ? { strippedParams: argsResult.stripped } : {}),
    });

    return {
      content: result.text,
      data: {
        // Deliberately the alias, not the path: an agent does not need the
        // host's directory layout, and the alias is stable for correlating.
        project: redactPath(projectPath, binding.projectKey),
        tool: spec.name,
        truncated: result.truncated,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // A dead process must not be reused.
    pool.evict({
      command,
      args: config.codegraphArgs,
      projectPath,
      toolAllowlist: resolved.allowedTools,
      extraEnv: config.extraEnv,
      allowTelemetry: config.allowTelemetry,
      useDaemon: config.useDaemon,
    });
    await audit(ctx, auditCtx, `${spec.name} failed`, {
      tool: spec.name,
      decision: "allow",
      outcome: "failure",
      reason: "transport_error",
      projectKey: binding.projectKey,
      durationMs: Date.now() - startedAt,
      detail: message.slice(0, 300),
    });
    return { error: `CodeGraph call failed: ${message}` };
  }
}

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

const plugin = definePlugin({
  async setup(ctx) {
    // `ctx.config.get()` with no company id is a *host-scoped* read, and the
    // host does not guarantee one during setup. A failure here must not abort
    // startup: registration is unconditional and every call re-reads the
    // company-scoped config, so the plugin can come up inert and become useful
    // as soon as an operator configures a company. Returning early instead
    // would leave no handler registered at all, and the only symptom would be
    // "no handler registered for key ..." with a plugin reporting `ready`.
    let config: RuntimeConfig;
    let error: string | null;
    try {
      ({ config, error } = await loadConfig(ctx));
    } catch (thrown) {
      config = normalizeConfig(undefined);
      error =
        thrown instanceof Error
          ? `Plugin configuration could not be read: ${thrown.message}`
          : "Plugin configuration could not be read";
    }

    if (error) {
      ctx.logger.error(
        "paperclip-codegraph is running with default (disabled) configuration",
        { error },
      );
    }

    // Handlers are registered unconditionally, and enablement is decided per
    // call. Paperclip's plugin config is *company-scoped*, so an instance-level
    // read here cannot know whether any particular company has opted in;
    // registering lazily on an instance-wide flag would leave a company that
    // later enables the plugin with no handler at all. Gating at call time is
    // also what makes a config change take effect without a worker restart.
    for (const spec of CODEGRAPH_TOOL_SPECS) {
      if (registeredTools.has(spec.name)) continue;
      ctx.tools.register(
        spec.name,
        {
          displayName: spec.displayName,
          description: spec.description,
          parametersSchema: toJsonSchema(spec),
        },
        async (params, runCtx): Promise<ToolResult> =>
          handleToolCall(ctx, spec, params, runCtx),
      );
      registeredTools.add(spec.name);
    }

    if (config.useDaemon) {
      ctx.logger.warn(
        "CodeGraph shared daemon is enabled (useDaemon). The daemon enforces CODEGRAPH_MCP_TOOLS from its own environment, so when several governance scopes query the same project path with different allowlists, upstream applies only the first one's allowlist. This plugin's own resolver still denies correctly, but CodeGraph will no longer refuse a denied tool on its own. Leave useDaemon off for multi-tenant deployments.",
      );
    }

    ctx.logger.info("paperclip-codegraph registered CodeGraph tools", {
      tools: [...registeredTools],
      command: config.codegraphCommand,
      args: config.codegraphArgs,
      // Not a gate — each company's own config decides whether calls succeed.
      instanceDefaultEnabled: config.enabled,
    });

    // -----------------------------------------------------------------
    // Data handlers — read-only surfaces a board UI or the CLI can query via
    // `paperclipai plugin bridge:data`. They deliberately return aliases and
    // decisions, never host paths.
    // -----------------------------------------------------------------

    ctx.data.register("governance-summary", async (params) => {
      const companyId = asString(params?.["companyId"]);
      const store = new GovernanceStore(ctx.state);
      const document = companyId
        ? await store.loadForResolve(companyId)
        : await store.loadAll();
      return {
        configuredCompanies: await store.listCompanyIds(),
        defaults: document.defaults ?? {},
        companies: Object.fromEntries(
          Object.entries(document.companies).map(([id, company]) => [
            id,
            {
              enabled: company.enabled,
              defaultProjectKey: company.defaultProjectKey ?? null,
              // Aliases only: never the absolute path.
              projectKeys: Object.keys(company.projects ?? {}),
              agentOverrides: Object.keys(company.agents ?? {}),
              projectOverrides: Object.keys(company.projectsByPaperclipProject ?? {}),
            },
          ]),
        ),
      };
    });

    /**
     * The single line that answers "why doesn't it work?" for an operator.
     *
     * Checks the four things that must all be true — enabled, CLI present,
     * repositories directory set, repository indexed — and reports each one
     * independently, so the page never shows a blank failure.
     */
    ctx.data.register("readiness", async (params) => {
      const companyId = asString(params?.["companyId"]);
      if (!companyId) {
        return {
          enabled: false,
          codegraph: { ok: false, version: null, detail: "No company context" },
          folder: { configured: false, alias: null },
          repository: { configured: false, key: null, indexed: false, alias: null },
        };
      }

      const { config: scoped, error: configError } = await loadConfig(ctx, companyId);
      const root = await repositoryRoot(ctx, companyId);

      const binary = configError
        ? { ok: false, version: null, detail: configError }
        : await ensureBinary({
            command: scoped.codegraphCommand,
            autoInstall: false,
            version: scoped.codegraphVersion,
            timeoutMs: 15_000,
            env: mcpEnv(scoped),
          });

      let repository = {
        configured: false,
        key: null as string | null,
        indexed: false,
        alias: null as string | null,
      };

      // Set from the company's own bindings: a relative path needs the folder,
      // an absolute one does not.
      let folderRequired = false;

      if (!configError) {
        const document = await new GovernanceStore(ctx.state).loadForResolve(companyId);
        const resolved = resolveScope(document, {
          companyId,
          pluginEnabled: scoped.enabled,
        });
        const boundProjects = Object.values(
          document.companies[companyId]?.projects ?? {},
        );
        folderRequired = boundProjects.some((binding) => !path.isAbsolute(binding.path));
        if (resolved.allowed && resolved.project) {
          repository.key = resolved.project.projectKey;
          repository.alias = resolved.project.projectKey;
          repository.configured = true;
          try {
            const bound = resolveProjectPath(bindingPathFor(resolved.project.path, root), {
              allowedProjectRoots: containmentRoots(scoped, root),
            });
            // The alias, not the path: this feeds a UI and must not disclose
            // the host's directory layout.
            repository.alias = path.basename(bound);
            repository.indexed = await isIndexed(bound);
          } catch {
            repository.indexed = false;
          }
        }
      }

      return {
        enabled: scoped.enabled,
        codegraph: { ok: binary.ok, version: binary.version, detail: binary.detail },
        folder: {
          configured: root !== null,
          alias: root ? path.basename(root) : null,
          // The folder is a convenience, not a requirement: a company whose
          // repositories are all bound by absolute path does not need it. Only a
          // *relative* binding depends on it, so that is what makes it required —
          // otherwise the page shows a red cross next to a working setup.
          required: folderRequired,
        },
        repository,
      };
    });

    /**
     * Index state for every repository this company has bound.
     *
     * Read-only, and the alias rather than the path: this feeds a UI, so it must
     * not disclose the host's layout.
     */
    ctx.data.register("index-status", async (params) => {
      const companyId = asString(params?.["companyId"]);
      if (!companyId) return { repositories: [], codegraph: null };

      const { config: scoped, error } = await loadConfig(ctx, companyId);
      if (error) return { repositories: [], codegraph: null, error };

      const env = mcpEnv(scoped);
      const binary = await ensureBinary({
        command: scoped.codegraphCommand,
        autoInstall: false,
        version: scoped.codegraphVersion,
        timeoutMs: 15_000,
        env,
      });

      const root = await repositoryRoot(ctx, companyId);
      const document = await new GovernanceStore(ctx.state).loadForResolve(companyId);
      const resolved = resolveScope(document, { companyId, pluginEnabled: scoped.enabled });

      // Deliberately NOT gated on the scope resolving. This is an operator-facing
      // diagnostic: when the plugin is disabled or a scope is denied, "which
      // repositories are bound and are they indexed?" is exactly the question
      // being asked. Returning an empty list there would read as "nothing is
      // bound" and send the operator looking in the wrong place, so the bindings
      // are listed regardless and the denial is reported alongside.
      const bound = Object.values(document.companies[companyId]?.projects ?? {});

      const repositories: Array<Record<string, unknown>> = [];
      for (const binding of bound) {
        const entry: Record<string, unknown> = { projectKey: binding.projectKey };
        try {
          const bound = resolveProjectPath(bindingPathFor(binding.path, root), {
            allowedProjectRoots: containmentRoots(scoped, root),
          });
          entry["alias"] = path.basename(bound);
          entry["indexed"] = await isIndexed(bound);
          if (entry["indexed"] && binary.ok) {
            const status = await indexStatus({
              projectPath: bound,
              command: binary.resolvedPath ?? scoped.codegraphCommand,
              timeoutMs: 20_000,
              env,
            });
            const parsed = (status.parsed ?? {}) as Record<string, unknown>;
            entry["fileCount"] = parsed["fileCount"] ?? null;
            entry["nodeCount"] = parsed["nodeCount"] ?? null;
            entry["lastIndexed"] = parsed["lastIndexed"] ?? null;
          }
        } catch (pathError) {
          entry["indexed"] = false;
          entry["problem"] =
            pathError instanceof Error ? pathError.message : String(pathError);
        }
        repositories.push(entry);
      }

      return {
        codegraph: { ok: binary.ok, version: binary.version, detail: binary.detail },
        // So a UI can say "3 repositories, but CodeGraph is switched off" rather
        // than showing an unexplained empty screen.
        enabled: scoped.enabled,
        allowed: resolved.allowed,
        reason: resolved.reason,
        repositories,
      };
    });

    /**
     * A `git` runner for identity lookups, or null when git is unavailable.
     *
     * The worker is a long-lived service often started with a minimal
     * environment, so `git` is resolved through the same search as `codegraph`
     * rather than trusting `PATH`. Only the two read-only subcommands the
     * identity module issues are ever run, and the child gets no credentials:
     * `rev-parse` and `remote get-url` read local config and never contact a
     * remote, so there is nothing here for a hostile repository to exploit.
     */
    const gitIdentityRunner = async (): Promise<CommandRunner | null> => {
      const resolved = await resolveCommand("git");
      if (!resolved) return null;
      return async (command, args, cwd) => {
        const result = await runCommand(command, args, {
          cwd,
          timeoutMs: GIT_TIMEOUT_MS,
          env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "" },
        });
        // `git` reports "not a repository" on stderr with a non-zero exit; the
        // identity module treats a throw as "no answer".
        if (result.code !== 0) throw new Error(result.stderr.trim() || `git exited ${result.code}`);
        return result.stdout;
      };
    };

    /**
     * The repository a workspace belongs to, and where its index lives.
     *
     * Returns the workspace itself when git cannot answer, so every non-git or
     * git-less deployment keeps behaving exactly as it did before.
     */
    const repositoryIdentity = async (
      workspacePath: string,
    ): Promise<{ root: string; identity: GitIdentity }> => {
      const run = await gitIdentityRunner();
      if (!run) return { root: workspacePath, identity: NO_GIT_IDENTITY };
      return indexRoot(workspacePath, run);
    };

    /**
     * This org's repositories, taken from its own Paperclip projects.
     *
     * Read-only and display-only: a repository is not configured here, it follows
     * the agent's project. What the operator needs from this list is whether each
     * one is indexed and a way to index it.
     */
    ctx.data.register("repositories", async (params) => {
      const companyId = asString(params?.["companyId"]);
      if (!companyId) return { repositories: [] };

      const { config: scoped, error } = await loadConfig(ctx, companyId);
      if (error) return { repositories: [], error };
      const env = mcpEnv(scoped);
      const binary = await ensureBinary({
        command: scoped.codegraphCommand,
        autoInstall: false,
        version: scoped.codegraphVersion,
        timeoutMs: 15_000,
        env,
      });
      const roots = containmentRoots(scoped, await repositoryRoot(ctx, companyId));

      const repositories: Array<Record<string, unknown>> = [];
      let projects: Array<{ id: string; name?: string }> = [];
      try {
        projects = await ctx.projects.list({ companyId, limit: 200, offset: 0 });
      } catch {
        return { repositories: [], detail: "This org has no readable projects." };
      }

      for (const project of projects) {
        try {
          const workspace = await ctx.projects.getPrimaryWorkspace(project.id, companyId);
          const path_ = acceptWorkspacePath(workspace?.path, roots);
          if (!path_) continue;

          // The index lives at the repository root, which is the workspace
          // itself for an ordinary checkout and an ancestor of it when the
          // project points into a monorepo.
          const { root: indexAt, identity } = await repositoryIdentity(path_);

          // Repositories only, for the same reason as the selector above: a
          // project with no checkout is not a repository and has nothing to index.
          if (!workspace?.repoUrl && !(await isGitRepository(indexAt))) continue;

          const entry: Record<string, unknown> = {
            projectId: project.id,
            name: project.name ?? identity.name ?? path.basename(path_),
            // Alias only — this feeds a UI and must not disclose host layout.
            // The repository name is preferred over the folder name because the
            // folder is an accident of how Paperclip checked the code out.
            alias: identity.name ?? path.basename(path_),
            repoName: identity.name,
            indexed: await isIndexed(indexAt),
          };
          if (identity.root && identity.root !== path_) {
            // The project is a subdirectory of the checkout. Worth showing: it
            // explains why the graph may include more than this project.
            entry["repositoryRootIsParent"] = true;
          }
          if (entry["indexed"] && binary.ok) {
            const status = await indexStatus({
              projectPath: indexAt,
              command: binary.resolvedPath ?? scoped.codegraphCommand,
              timeoutMs: 20_000,
              env,
            });
            const parsed = (status.parsed ?? {}) as Record<string, unknown>;
            entry["fileCount"] = parsed["fileCount"] ?? null;
            entry["nodeCount"] = parsed["nodeCount"] ?? null;
            entry["lastIndexed"] = parsed["lastIndexed"] ?? null;
          }
          repositories.push(entry);
        } catch {
          // A project with no usable workspace is simply not listed.
        }
      }

      return { repositories, codegraph: { ok: binary.ok, version: binary.version } };
    });

    /**
     * The repositories the graph view can draw, cheapest possible check.
     *
     * Distinct from `repositories` above, which runs `codegraph status` per
     * indexed repository to report file and node counts. That is right for a
     * status page and wrong for a selector: it spawns a process per project on
     * every load. This one only asks whether the index file exists.
     */
    ctx.data.register("graph-projects", async (params) => {
      const companyId = asString(params?.["companyId"]);
      if (!companyId) return { repositories: [] };

      const { config: scoped, error } = await loadConfig(ctx, companyId);
      if (error) return { repositories: [], error };
      const roots = containmentRoots(scoped, await repositoryRoot(ctx, companyId));

      const repositories: Array<Record<string, unknown>> = [];
      let projects: Array<{ id: string; name?: string }> = [];
      try {
        projects = await ctx.projects.list({ companyId, limit: 200, offset: 0 });
      } catch {
        return { repositories: [], detail: "This org has no readable projects." };
      }

      // One read of the governance document, so every row reports its own
      // override rather than a per-row lookup.
      const store = new GovernanceStore(ctx.state);
      const companyGovernance = await store.getCompany(companyId);

      let skipped = 0;
      for (const project of projects) {
        try {
          const workspace = await ctx.projects.getPrimaryWorkspace(project.id, companyId);
          const resolved = acceptWorkspacePath(workspace?.path, roots);
          if (!resolved) {
            skipped += 1;
            continue;
          }
          const { root: indexAt, identity } = await repositoryIdentity(resolved);

          // Only repositories are listed. A Paperclip project can exist with no
          // code at all — a backlog idea, a cancelled onboarding project — and
          // its managed folder carries no checkout. Listing those as
          // "repositories, not indexed" is noise on rows that cannot be acted on.
          //
          // Paperclip already knows whether the workspace is a repository
          // (`repoUrl`), and a bare `git init` with no remote is still a
          // repository, so the check falls back to `.git` rather than trusting
          // the URL alone.
          if (!workspace?.repoUrl && !(await isGitRepository(indexAt))) {
            skipped += 1;
            continue;
          }

          repositories.push({
            projectId: project.id,
            name: project.name ?? identity.name ?? path.basename(resolved),
            // The repository's own name, not the folder's: the folder is an
            // accident of how Paperclip checked the code out.
            alias: identity.name ?? path.basename(resolved),
            repoName: identity.name,
            indexed: await isIndexed(indexAt),
            // The primary control: whether this org may read this repository at
            // all. Absent means yes — access is derived, and this only narrows.
            blocked:
              companyGovernance?.projectsByPaperclipProject?.[project.id]?.enabled === false,
          });
        } catch {
          // A project with no usable workspace is simply not offered.
          skipped += 1;
        }
      }

      return {
        // The org's own name, so every CodeGraph surface can say whose code it
        // is showing. The host context carries only `companyPrefix`, and a page
        // that lists repositories without naming the org makes the operator
        // check the URL to be sure which company they are editing.
        organization: await organizationName(ctx, companyId),
        repositories,
        enabled: scoped.enabled,
        // Projects that are not repositories are counted rather than listed, so
        // "nothing here" is distinguishable from "three projects, none of which
        // have code".
        skippedProjects: skipped,
        detail:
          repositories.length === 0
            ? projects.length === 0
              ? "This org has no projects."
              : `This org has ${projects.length} project(s), none with a repository workspace.`
            : undefined,
      };
    });

    /**
     * Resolve the repository a graph request is about.
     *
     * The operator picks a project; the path comes from that project's own
     * workspace, exactly as the tool path does. Nothing here accepts a path.
     */
    const repositoryForProject = async (
      companyId: string,
      projectId: string | null,
    ): Promise<string> => {
      const { config: scoped } = await loadConfig(ctx, companyId);
      const roots = containmentRoots(scoped, await repositoryRoot(ctx, companyId));

      let target = projectId;
      if (!target) {
        const projects = await ctx.projects.list({ companyId, limit: 200, offset: 0 });
        target = projects[0]?.id ?? null;
      }
      if (!target) throw new GraphUnavailable("This org has no projects.", "not_indexed");

      const workspace = await ctx.projects.getPrimaryWorkspace(target, companyId);
      const resolved = acceptWorkspacePath(workspace?.path, roots);
      if (!resolved) {
        throw new GraphUnavailable(
          "That project has no usable repository workspace.",
          "not_indexed",
        );
      }
      // The index sits at the repository root. For an ordinary checkout that is
      // the workspace; when the project points into a monorepo it is an
      // ancestor, and opening `<workspace>/.codegraph` would find no index at all.
      const { root } = await repositoryIdentity(resolved);
      return root;
    };

    /**
     * Why the graph view believes what it believes about one project.
     *
     * Exists because "not indexed" on a repository that plainly is indexed is not
     * debuggable from the outside: the browser never sees the host's paths, so
     * there is no way to tell a stale render from a wrong resolution. This
     * reports the chain the plugin actually followed, with host layout redacted
     * the same way the rest of the plugin redacts it.
     */
    ctx.data.register("graph-diagnose", async (params) => {
      const companyId = asString(params?.["companyId"]);
      const projectId = asString(params?.["projectId"]);
      if (!companyId || !projectId) return { error: "companyId and projectId are required" };
      try {
        const { config: scoped } = await loadConfig(ctx, companyId);
        const roots = containmentRoots(scoped, await repositoryRoot(ctx, companyId));

        const workspace = await ctx.projects.getPrimaryWorkspace(projectId, companyId);
        const accepted = acceptWorkspacePath(workspace?.path, roots);
        if (!accepted) {
          return {
            projectId,
            workspaceAccepted: false,
            reason:
              "The host returned no workspace path for this project, or it failed containment.",
            containmentRootCount: roots.length,
          };
        }

        const { root, identity } = await repositoryIdentity(accepted);
        const indexed = await isIndexed(root);

        return {
          projectId,
          workspaceAccepted: true,
          // `path.basename`, not `redactPath`: the latter produces an audit *key*
          // (two trailing segments plus a hash), which for a managed workspace
          // emits the project UUID. A diagnostic must not disclose more than the
          // alias the operator already sees.
          workspaceAlias: path.basename(accepted),
          repoUrl: workspace?.repoUrl ?? null,
          gitRootAlias: path.basename(root),
          gitRootIsWorkspace: root === accepted,
          repositoryName: identity.name,
          indexed,
          indexPathAlias: `${path.basename(root)}/${CODEGRAPH_INDEX_DIR}`,
          hasGitEntry: await isGitRepository(root),
          containmentRootCount: roots.length,
          gitAvailable: (await gitIdentityRunner()) !== null,
        };
      } catch (error) {
        return graphFailure(error);
      }
    });

    /** Symbol search in one of this org's repositories. */
    ctx.data.register("graph-search", async (params) => {
      const companyId = asString(params?.["companyId"]);
      const query = asString(params?.["query"]);
      if (!companyId || !query) return { results: [] };
      try {
        const projectPath = await repositoryForProject(
          companyId,
          asString(params?.["projectId"]),
        );
        return { results: searchNodes(projectPath, query) };
      } catch (error) {
        return graphFailure(error);
      }
    });

    /** The call neighbourhood around one symbol, for the graph view. */
    ctx.data.register("graph-neighbourhood", async (params) => {
      const companyId = asString(params?.["companyId"]);
      const nodeId = asString(params?.["nodeId"]);
      if (!companyId || !nodeId) return { error: "companyId and nodeId are required" };
      const depthRaw = params?.["depth"];
      const depth = typeof depthRaw === "number" && Number.isFinite(depthRaw) ? depthRaw : 1;
      try {
        const projectPath = await repositoryForProject(
          companyId,
          asString(params?.["projectId"]),
        );
        // The seed is echoed back so the view can mark the centre of the graph
        // without re-deriving it from the traversal order.
        return { graph: neighbourhood(projectPath, nodeId, depth), seedId: nodeId, depth };
      } catch (error) {
        return graphFailure(error);
      }
    });

    /**
     * A short source excerpt for one node, so the graph view can show the code
     * behind a symbol without the operator leaving Paperclip.
     *
     * The path comes from the node's row in the index and is validated against
     * containment before anything is read; only a capped excerpt is returned,
     * and it is line-numbered so the excerpt is self-describing.
     */
    ctx.data.register("graph-source", async (params) => {
      const companyId = asString(params?.["companyId"]);
      const nodeId = asString(params?.["nodeId"]);
      if (!companyId || !nodeId) return { excerpt: null };
      try {
        const projectPath = await repositoryForProject(companyId, asString(params?.["projectId"]));
        const { config: scoped } = await loadConfig(ctx, companyId);
        const roots = containmentRoots(scoped, await repositoryRoot(ctx, companyId));

        const node = nodeById(projectPath, nodeId);
        if (!node) return { excerpt: null, reason: "That symbol is not in the current index." };

        const absolute = resolveProjectPath(path.join(projectPath, node.filePath), {
          allowedProjectRoots: roots.length > 0 ? roots : [projectPath],
        });

        const excerpt = await readExcerpt(absolute, node.startLine, node.endLine, {
          maxLines: MAX_SOURCE_LINES,
          maxBytes: MAX_SOURCE_BYTES,
        });

        return {
          excerpt: excerpt.text,
          filePath: node.filePath,
          startLine: excerpt.firstLine,
          endLine: excerpt.lastLine,
          truncated: excerpt.truncated,
          node,
        };
      } catch (error) {
        return graphFailure(error);
      }
    });

    /**
     * Who may use CodeGraph.
     *
     * Default is everyone: an agent working in one of this org's projects reads
     * that project's repository, and Paperclip already decides who works where.
     * Unticking is the only edit this surface offers, so it can only narrow.
     */
    ctx.data.register("access", async (params) => {
      const companyId = asString(params?.["companyId"]);
      if (!companyId) return { agents: [] };
      const document = await new GovernanceStore(ctx.state).loadForResolve(companyId);
      const overrides = document.companies[companyId]?.agents ?? {};
      const rows = await ctx.agents.list({ companyId, limit: 200, offset: 0 });
      return {
        agents: rows.map((agent) => ({
          id: agent.id,
          name: agent.name,
          // Absent override means allowed — the default is on, not off.
          enabled: overrides[agent.id]?.enabled !== false,
        })),
        toolCount: CODEGRAPH_TOOLS.length,
      };
    });

    /** The company's agents, with names, so the settings page can list them. */
    ctx.data.register("agents", async (params) => {
      const companyId = asString(params?.["companyId"]);
      if (!companyId) return { agents: [] };
      const rows = await ctx.agents.list({ companyId, limit: 200, offset: 0 });
      return {
        agents: rows.map((agent) => ({ id: agent.id, name: agent.name })),
      };
    });

    /**
     * End-to-end self test for one scope, run inside the real host.
     *
     * Resolves governance, checks the CodeGraph binary and index, then performs
     * a real `codegraph_explore` call and returns a fingerprint of the answer.
     * This is the call an operator (or a CI job) uses to prove that a company's
     * binding actually reads that company's codebase.
     */
    ctx.data.register("verify-scope", async (params) => {
      const companyId = asString(params?.["companyId"]);
      if (!companyId) return { ok: false, error: "companyId is required" };

      const { config: scopedConfig, error: configError } = await loadConfig(ctx, companyId);
      if (configError) return { ok: false, error: configError };

      const document = await new GovernanceStore(ctx.state).loadForResolve(companyId);
      const resolved = resolveScope(document, {
        companyId,
        paperclipProjectId: asString(params?.["paperclipProjectId"]) ?? null,
        agentId: asString(params?.["agentId"]) ?? null,
        pluginEnabled: scopedConfig.enabled,
      });

      const decision = decideToolAccess(resolved, "codegraph_explore");
      if (!resolved.allowed || !resolved.project) {
        return {
          ok: false,
          enabled: scopedConfig.enabled,
          allowed: false,
          reason: resolved.reason,
          denialSource: resolved.trace.denialSource,
        };
      }
      if (!decision.allowed) {
        return {
          ok: false,
          enabled: scopedConfig.enabled,
          allowed: false,
          reason: decision.reason,
          projectKey: resolved.project.projectKey,
        };
      }

      const projectPath = resolveProjectPath(resolved.project.path, {
        allowedProjectRoots: scopedConfig.allowedProjectRoots,
      });
      const env = mcpEnv(scopedConfig);

      const binary = await ensureBinary({
        command: scopedConfig.codegraphCommand,
        autoInstall: scopedConfig.autoInstall,
        version: scopedConfig.codegraphVersion,
        timeoutMs: Math.max(scopedConfig.startupTimeoutMs, 300_000),
        env,
      });
      if (!binary.ok || !binary.resolvedPath) {
        return { ok: false, error: binary.detail, projectKey: resolved.project.projectKey };
      }

      const indexed = await ensureIndex({
        projectPath,
        autoIndex: scopedConfig.autoIndex,
        command: binary.resolvedPath,
        timeoutMs: scopedConfig.indexTimeoutMs,
        env,
      });
      if (!indexed.ok) {
        return { ok: false, error: indexed.detail, projectKey: resolved.project.projectKey };
      }

      const query = asString(params?.["query"]) ?? "module entry point";
      const server = pool.acquire({
        command: binary.resolvedPath,
        args: scopedConfig.codegraphArgs,
        projectPath,
        toolAllowlist: resolved.allowedTools,
        extraEnv: scopedConfig.extraEnv,
        allowTelemetry: scopedConfig.allowTelemetry,
        useDaemon: scopedConfig.useDaemon,
        callTimeoutMs: scopedConfig.callTimeoutMs,
        startupTimeoutMs: scopedConfig.startupTimeoutMs,
      });

      const startedAt = Date.now();
      const listed = await server.listTools();
      const result = await server.callTool("codegraph_explore", { query });

      return {
        ok: !result.isError,
        enabled: scopedConfig.enabled,
        allowed: true,
        projectKey: resolved.project.projectKey,
        // Aliases, never paths.
        upstreamToolsListed: listed.map((tool) => tool.name),
        upstreamToolCount: listed.length,
        effectiveScopes: resolved.trace.appliedScopes,
        allowedTools: resolved.allowedTools,
        // What an agent can actually call, after denials are applied.
        effectiveTools: visibleTools(resolved),
        deniedTools: resolved.deniedTools,
        durationMs: Date.now() - startedAt,
        resultChars: result.text.length,
        // Which files CodeGraph served, relative to the project root. This is
        // the evidence that the *right* repository answered: the paths are
        // relative, so they identify the codebase without disclosing where the
        // host keeps it.
        filesServed: extractServedFiles(result.text),
        resultDigest: result.text.slice(0, 1_200),
      };
    });

    // -----------------------------------------------------------------
    // Actions — admin surface. Paperclip authorizes these at the board
    // boundary; they are not agent tools and are not derivable from a
    // run context.
    // -----------------------------------------------------------------

    ctx.actions.register("get-governance", async (params) => {
      const companyId = asString(params?.["companyId"]);
      if (companyId) {
        const company = await new GovernanceStore(ctx.state).getCompany(companyId);
        return { companyId, governance: company };
      }
      return { governance: await new GovernanceStore(ctx.state).loadAll() };
    });

    ctx.actions.register("set-company-governance", async (params) => {
      const companyId = asString(params?.["companyId"]);
      if (!companyId) throw new Error("companyId is required");
      const governance = params?.["governance"];
      if (typeof governance !== "object" || governance === null) {
        throw new Error("governance must be an object");
      }
      // Validate by round-tripping, so a bad write never reaches storage.
      const parsed = parseGovernance({
        version: 1,
        companies: { [companyId]: governance },
      });
      const validated = parsed.companies[companyId]!;

      // Paths are validated here as well as at call time so an operator gets an
      // immediate error instead of discovering it on an agent's first call.
      const { config: scoped } = await loadConfig(ctx, companyId);
      const root = await repositoryRoot(ctx, companyId);
      const roots = containmentRoots(scoped, root);
      const normalized: CompanyGovernance = {
        ...validated,
        projects: Object.fromEntries(
          Object.entries(validated.projects ?? {}).map(([key, binding]) => [
            key,
            {
              ...binding,
              // A relative path is resolved against the operator's folder and
              // stored absolute, so resolution at call time cannot be affected
              // by a later change to that setting.
              path: resolveProjectPath(bindingPathFor(binding.path, root), {
                allowedProjectRoots: roots,
              }),
            },
          ]),
        ),
      };

      await new GovernanceStore(ctx.state).setCompany(companyId, normalized);
      return { ok: true, companyId, projects: Object.keys(normalized.projects ?? {}) };
    });

    ctx.actions.register("delete-company-governance", async (params) => {
      const companyId = asString(params?.["companyId"]);
      if (!companyId) throw new Error("companyId is required");
      await new GovernanceStore(ctx.state).deleteCompany(companyId);
      return { ok: true, companyId };
    });

    ctx.actions.register("set-instance-defaults", async (params) => {
      const defaults = params?.["defaults"];
      if (typeof defaults !== "object" || defaults === null) {
        throw new Error("defaults must be an object");
      }
      const parsed = parseGovernance({ version: 1, defaults, companies: {} });
      await new GovernanceStore(ctx.state).setDefaults(parsed.defaults ?? {});
      return { ok: true, defaults: parsed.defaults ?? {} };
    });

    /**
     * Explain what a scope can do, without calling CodeGraph.
     *
     * This is the tool an operator reaches for when an agent reports a denial,
     * and the tool a test asserts isolation with.
     */
    ctx.actions.register("explain-scope", async (params) => {
      const companyId = asString(params?.["companyId"]);
      if (!companyId) throw new Error("companyId is required");
      const { config } = await loadConfig(ctx, companyId);
      const document = await new GovernanceStore(ctx.state).loadForResolve(companyId);
      const resolved = resolveScope(document, {
        companyId,
        paperclipProjectId: asString(params?.["paperclipProjectId"]) ?? null,
        agentId: asString(params?.["agentId"]) ?? null,
        pluginEnabled: config.enabled,
      });
      const root = await repositoryRoot(ctx, companyId);
      return {
        enabled: config.enabled,
        // Whether the operator has picked a repositories directory, and whether
        // the host considers it healthy. Never the path itself.
        repositoriesDirectory: {
          configured: root !== null,
          alias: root ? path.basename(root) : null,
        },
        allowed: resolved.allowed,
        reason: resolved.reason,
        // The alias and never the path: this output can reach an agent-adjacent
        // surface and must not disclose host layout.
        projectKey: resolved.project?.projectKey ?? null,
        // `allowedTools` is the post-intersection allow set; `effectiveTools`
        // is what an agent can actually call, with denials removed. Reporting
        // both stops a reader from mistaking "in the allow set" for "callable".
        allowedTools: resolved.allowedTools,
        effectiveTools: visibleTools(resolved),
        deniedTools: resolved.deniedTools,
        appliedScopes: resolved.trace.appliedScopes,
        denialSource: resolved.trace.denialSource,
      };
    });

    ctx.actions.register("verify-codegraph", async (params) => {
      const companyId = asString(params?.["companyId"]);
      const { config, error } = await loadConfig(ctx, companyId ?? undefined);
      if (error) return { ok: false, detail: error };

      const env = mcpEnv(config);
      const binary = await ensureBinary({
        command: config.codegraphCommand,
        autoInstall: false,
        version: config.codegraphVersion,
        timeoutMs: config.startupTimeoutMs,
        env,
      });
      if (!binary.ok) return { ok: false, binary, detail: binary.detail };

      const projectPath = await resolveProjectPath(asString(params?.["projectPath"]), {
        allowedProjectRoots: config.allowedProjectRoots,
      });
      const index = await indexStatus({
        projectPath,
        command: config.codegraphCommand,
        timeoutMs: config.startupTimeoutMs,
        env,
      });
      return {
        ok: index.ok,
        binary,
        project: { alias: redactPath(projectPath), indexed: index.ok },
        status: index.parsed,
        detail: index.ok ? "CodeGraph is reachable and the project is indexed" : index.raw,
      };
    });

    /**
     * The native-Paperclip-MCP provisioning plan (see `governance/provision.ts`).
     * Returned as data so it can be reviewed before anything is created.
     */
    ctx.actions.register("native-mcp-plan", async (params) => {
      const companyId = asString(params?.["companyId"]);
      if (!companyId) throw new Error("companyId is required");
      const { config } = await loadConfig(ctx, companyId);
      const company = await new GovernanceStore(ctx.state).getCompany(companyId);
      const firstProject = Object.values(company?.projects ?? {})[0];

      const plan = buildNativeMcpPlan({
        companyId,
        command: config.codegraphCommand,
        args: config.codegraphArgs,
        projectPath: firstProject?.path ?? config.defaultProjectPath ?? "",
        allowedTools: (company?.policy?.allowedTools as string[] | undefined) ?? undefined,
        deniedTools: (company?.policy?.deniedTools as string[] | undefined) ?? undefined,
        deploymentMode: asString(params?.["deploymentMode"]) ?? undefined,
      });

      return { plan, curl: renderPlanAsCurl(plan) };
    });

    /**
     * The primary access control: whether this org may read one repository.
     *
     * A targeted edit rather than a whole-form save, because the caller knows
     * about one repository and nothing else. `setProjectAccess` is pure and
     * tested for the destructive case: it changes only this project's override,
     * keeps any `projectKey` or `policy` attached to it, and never raises
     * `company.enabled`.
     *
     * This can only narrow. Blocking writes `enabled: false` for the project;
     * unblocking removes that flag, and the company binding still has to allow
     * the repository — and Paperclip still has to allow the tool.
     */
    ctx.actions.register("set-repository-access", async (params) => {
      const companyId = asString(params?.["companyId"]);
      const projectId = asString(params?.["projectId"]);
      if (!companyId || !projectId) {
        throw new Error("companyId and projectId are required");
      }
      const blocked = params?.["blocked"] === true;

      const store = new GovernanceStore(ctx.state);
      const current = await store.getCompany(companyId);
      const next = setProjectAccess(current, projectId, !blocked);
      await store.setCompany(companyId, next);

      await audit(
        ctx,
        { companyId, agentId: null, runId: null, paperclipProjectId: projectId },
        blocked ? "CodeGraph blocked for a repository" : "CodeGraph unblocked for a repository",
        { projectId, blocked },
      );

      return { ok: true, blocked };
    });

    /**
     * Narrow one agent's access.
     *
     * An **exception**, not a grant: agents already reach the repositories their
     * projects use, so this exists to revoke for one agent in the cases the
     * derived rules cannot express. Also a targeted edit, so unticking one agent
     * cannot disturb another — `mergeGovernance`'s whole-form shape is kept below
     * for the older surface.
     */
    ctx.actions.register("set-agent-access", async (params) => {
      const companyId = asString(params?.["companyId"]);
      const agentId = asString(params?.["agentId"]);
      if (!companyId || !agentId) throw new Error("companyId and agentId are required");
      const enabled = params?.["enabled"] !== false;

      const store = new GovernanceStore(ctx.state);
      const current = await store.getCompany(companyId);
      const next = setAgentAccess(current, agentId, enabled);
      await store.setCompany(companyId, next);

      await audit(
        ctx,
        { companyId, agentId, runId: null, paperclipProjectId: null },
        enabled ? "CodeGraph access restored for an agent" : "CodeGraph access revoked for an agent",
        { agentId, enabled },
      );

      return { ok: true, enabled };
    });

    /**
     * Narrow per-agent access.
     *
     * Delegates to mergeGovernance, which is already tested for the destructive
     * case: it preserves projects, policy and any override for an agent the form
     * did not list, and deletes nothing the operator did not remove. This surface
     * therefore cannot clear a tool denial or drop another agent's settings.
     */
    ctx.actions.register("set-access", async (params) => {
      const companyId = asString(params?.["companyId"]);
      if (!companyId) throw new Error("companyId is required");

      const granted = toStringArray(params?.["grantedAgentIds"]);
      const listed = toStringArray(params?.["listedAgentIds"]);
      if (listed.length === 0) throw new Error("listedAgentIds is required");

      const store = new GovernanceStore(ctx.state);
      const current = await store.getCompany(companyId);

      const merged = mergeGovernance(
        current,
        {
          // Carried through unchanged: this action narrows agents, not repositories.
          repositories: Object.values(current?.projects ?? {}).map((binding) => ({
            key: binding.projectKey,
            path: binding.path,
          })),
          removedRepositoryKeys: [],
          grantedAgentIds: granted,
          listedAgentIds: listed,
        },
        { defaultAllowedTools: [...CODEGRAPH_TOOLS] },
      );

      await store.setCompany(companyId, merged);

      await audit(
        ctx,
        { companyId, agentId: null, runId: null, paperclipProjectId: null },
        "CodeGraph access narrowed",
        { granted: granted.length, listed: listed.length },
      );

      return { ok: true, granted: granted.length, listed: listed.length };
    });

    ctx.actions.register("shutdown-codegraph", async () => {
      const before = pool.size;
      await pool.closeAll();
      return { ok: true, stopped: before };
    });
  },

  async onHealth() {
    const servers = pool.describe();
    const degraded = servers.some((entry) => !entry.alive);
    return {
      status: degraded ? "degraded" : "ok",
      message: `${registeredTools.size} CodeGraph tools registered; ${pool.size} MCP process(es)`,
      details: {
        registeredTools: [...registeredTools],
        processes: servers,
      },
    };
  },

  /**
   * Stop every child process. The `codegraph` npm shim runs the real binary
   * through a blocking `spawnSync`, so an unstopped group would outlive the
   * worker; `CodeGraphMcpServer.stop` kills the process group for that reason.
   */
  async onShutdown() {
    await pool.closeAll();
  },

  async onValidateConfig(config) {
    try {
      normalizeConfig(config);
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        errors: [error instanceof Error ? error.message : "Invalid configuration"],
      };
    }
  },
});

/**
 * Extract the project-relative file paths a CodeGraph response served.
 *
 * CodeGraph renders a per-file header of the form ``**`path/to/file.ts`** — ...``
 * and cites `file.ts:line` in its relationship lists. Both are relative to the
 * queried project root, so collecting them identifies which codebase answered
 * without exposing an absolute path.
 */
export function extractServedFiles(text: string): string[] {
  const found = new Set<string>();
  const codeSpan = /`([A-Za-z0-9_./@-]+\.[A-Za-z0-9]{1,8})`/g;
  const cited = /(?:^|[\s(])([A-Za-z0-9_./@-]+\.[A-Za-z0-9]{1,8}):\d+/gm;
  for (const pattern of [codeSpan, cited]) {
    for (const match of text.matchAll(pattern)) {
      const candidate = match[1];
      if (!candidate) continue;
      if (!candidate.includes("/") && !/\.[A-Za-z0-9]{1,8}$/.test(candidate)) continue;
      found.add(candidate);
    }
  }
  return [...found].sort();
}

/**
 * A graph failure is data, not an exception.
 *
 * `schema_drift` in particular must reach the operator as a named reason: an
 * empty graph would read as "this repository has no symbols" and send them
 * debugging the wrong layer.
 */
function graphFailure(error: unknown): { error: string; reason?: string } {
  if (error instanceof GraphUnavailable) {
    return { error: error.message, reason: error.reason };
  }
  return { error: error instanceof Error ? error.message : String(error) };
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export default plugin;
runWorker(plugin, import.meta.url);
