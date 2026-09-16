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

import { randomUUID } from "node:crypto";
import path from "node:path";

import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import type { PluginContext, ToolResult, ToolRunContext } from "@paperclipai/plugin-sdk";

import {
  CODEGRAPH_FOLDER_KEY,
  CODEGRAPH_TOOLS,
  PLUGIN_ID,
  REQUEST_ACCESS_TOOL,
  UPSTREAM_PROJECT_PATH_PARAM,
  MAX_ARG_STRING_CHARS,
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
  indexStatus,
  isIndexed,
  rebuildIndex,
} from "./codegraph/manage.js";
import { RequestError, RequestStore, describeRequest } from "./governance/requests.js";

// ---------------------------------------------------------------------------
// Module state (one worker process)
// ---------------------------------------------------------------------------

const pool = new CodeGraphClientPool();

/** Tool names registered in this worker instance; registration is not idempotent. */
const registeredTools = new Set<string>();

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
    const workspace = await ctx.projects.getPrimaryWorkspace(projectId, companyId);
    const candidate = workspace?.path;
    if (!candidate) return null;
    return resolveProjectPath(candidate, { allowedProjectRoots: [...roots] });
  } catch {
    return null;
  }
}

/**
 * Reasons that mean "we could not find a repository", as opposed to "you are not
 * allowed". Only these are eligible for the workspace fallback: a disabled
 * company, a disabled agent, or a tool denial must still deny.
 */
const REPOSITORY_MISSING_REASONS = new Set([
  "company_not_configured",
  "no_project_bound",
  "project_binding_missing",
]);

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
  if (!resolved.allowed && REPOSITORY_MISSING_REASONS.has(resolved.reason)) {
    const workspace = await workspaceForRun(
      ctx,
      runCtx.companyId,
      runCtx.projectId ?? null,
      containmentRoots(config, await repositoryRoot(ctx, runCtx.companyId)),
    );
    if (workspace) {
      const existing = document.companies[runCtx.companyId];
      const withWorkspace = parseGovernance({
        version: 1,
        defaults: document.defaults,
        companies: {
          [runCtx.companyId]: {
            ...(existing ?? {}),
            enabled: true,
            defaultProjectKey: existing?.defaultProjectKey ?? "workspace",
            projects: {
              ...(existing?.projects ?? {}),
              workspace: {
                projectKey: "workspace",
                path: workspace,
                displayName: "Project workspace",
              },
            },
          },
        },
      });
      const retry = resolveScope(withWorkspace, {
        companyId: runCtx.companyId,
        paperclipProjectId: runCtx.projectId ?? null,
        agentId: runCtx.agentId ?? null,
        pluginEnabled: config.enabled,
      });
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

/**
 * Apply an approved request: bind the repository if needed and grant the agent.
 *
 * Writes directly rather than going through the settings-page merge, because
 * this is a single-agent, single-repository grant and the merge exists to serve
 * a form. What it must not do is lose anything, so `policy` is carried over
 * verbatim and only `projects`/`agents`/`defaultProjectKey` are touched.
 */
async function applyGrant(
  ctx: PluginContext,
  companyId: string,
  request: { agentId: string; repository: string },
): Promise<string> {
  const { config: scoped, error } = await loadConfig(ctx, companyId);
  if (error) throw new Error(error);

  const root = await repositoryRoot(ctx, companyId);
  const store = new GovernanceStore(ctx.state);
  const current = await store.getCompany(companyId);

  const projects: Record<string, { projectKey: string; path: string }> = {
    ...((current?.projects ?? {}) as Record<string, { projectKey: string; path: string }>),
  };

  // An already-bound repository is granted as-is. Anything else is treated as a
  // path and validated against the operator's folder before it is stored, so an
  // agent-supplied string can never widen the boundary.
  let projectKey = Object.keys(projects).find((key) => key === request.repository) ?? null;
  if (!projectKey) {
    const resolvedPath = resolveProjectPath(
      bindingPathFor(request.repository, root),
      { allowedProjectRoots: containmentRoots(scoped, root) },
    );
    projectKey = request.repository;
    projects[projectKey] = { projectKey, path: resolvedPath };
  }

  await store.setCompany(companyId, {
    ...(current ?? {}),
    enabled: current?.enabled ?? true,
    projects,
    defaultProjectKey: current?.defaultProjectKey ?? projectKey,
    agents: {
      ...(current?.agents ?? {}),
      [request.agentId]: {
        projectKey,
        policy: { allowedTools: [...CODEGRAPH_TOOLS] },
      },
    },
    // Preserved verbatim: an approval must never clear a denial someone set.
    ...(current?.policy
      ? { policy: current.policy }
      : { policy: { allowedTools: [...CODEGRAPH_TOOLS] } }),
  });

  return projectKey;
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
    // The one tool that is NOT gated by CodeGraph governance. An agent denied
    // CodeGraph is exactly the agent that needs to ask for it, so gating this
    // would make the request flow unreachable. It is still subject to
    // Paperclip's own profile, which is why the Activate step includes it.
    if (!registeredTools.has(REQUEST_ACCESS_TOOL)) {
      ctx.tools.register(
        REQUEST_ACCESS_TOOL,
        {
          displayName: "Request CodeGraph access",
          description:
            "Ask a board member for CodeGraph access to a repository. Use this when CodeGraph tools are denied for you. Records a request for a human to approve.",
          parametersSchema: {
            type: "object",
            properties: {
              repository: { type: "string" },
              reason: { type: "string" },
            },
            required: ["repository", "reason"],
            additionalProperties: false,
          },
        },
        async (params, runCtx): Promise<ToolResult> => {
          const raw = (typeof params === "object" && params !== null ? params : {}) as Record<
            string,
            unknown
          >;
          try {
            const requests = new RequestStore(ctx.state);
            const created = await requests.create({
              companyId: runCtx.companyId,
              agentId: runCtx.agentId,
              agentName: await resolveAgentName(ctx, runCtx.companyId, runCtx.agentId),
              repository: String(raw["repository"] ?? ""),
              reason: String(raw["reason"] ?? ""),
              id: randomUUID(),
              now: new Date().toISOString(),
            });
            // What the agent is told depends on whether it was denied before, so
            // it learns the reason instead of asking again.
            const previous = (await requests.list(runCtx.companyId)).find(
              (entry) =>
                entry.agentId === runCtx.agentId &&
                entry.repository === created.repository &&
                entry.status === "denied",
            );
            return { content: describeRequest(created, previous), data: { requestId: created.id } };
          } catch (error) {
            if (error instanceof RequestError) return { error: error.message };
            throw error;
          }
        },
      );
      registeredTools.add(REQUEST_ACCESS_TOOL);
    }

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

    /** Pending and decided access requests, for the sidebar. */
    ctx.actions.register("list-access-requests", async (params) => {
      const companyId = asString(params?.["companyId"]);
      if (!companyId) throw new Error("companyId is required");
      const all = await new RequestStore(ctx.state).list(companyId);
      return {
        pending: all.filter((entry) => entry.status === "pending"),
        decided: all.filter((entry) => entry.status !== "pending"),
      };
    });

    /**
     * Approve or deny a request.
     *
     * On approve the grant is applied first and the outcome recorded on the
     * request: a decision that failed to apply must not look like a working
     * approval, which is why `appliedAt`/`applyError` exist separately from
     * `status`.
     */
    ctx.actions.register("decide-access-request", async (params) => {
      const companyId = asString(params?.["companyId"]);
      const requestId = asString(params?.["requestId"]);
      const decision = asString(params?.["decision"]);
      if (!companyId) throw new Error("companyId is required");
      if (!requestId) throw new Error("requestId is required");
      if (decision !== "approved" && decision !== "denied") {
        throw new Error('decision must be "approved" or "denied"');
      }

      const requests = new RequestStore(ctx.state);
      const now = new Date().toISOString();
      const decided = await requests.decide({
        companyId,
        requestId,
        decision,
        decidedBy: asString(params?.["decidedBy"]) ?? "board",
        decisionReason: asString(params?.["reason"]),
        now,
      });

      if (decision === "denied") {
        await audit(ctx, {
          companyId,
          agentId: decided.agentId,
          runId: null,
          paperclipProjectId: null,
        }, "CodeGraph access request denied", {
          requestId, decision, repository: decided.repository,
        });
        return { ok: true, request: decided };
      }

      let applied = decided;
      try {
        const projectKey = await applyGrant(ctx, companyId, decided);
        applied = await requests.markApplied({ companyId, requestId, now });
        await audit(ctx, {
          companyId,
          agentId: decided.agentId,
          runId: null,
          paperclipProjectId: null,
        }, "CodeGraph access request approved", {
          requestId, decision, projectKey,
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        applied = await requests.markApplied({ companyId, requestId, now, error: detail });
        await audit(ctx, {
          companyId,
          agentId: decided.agentId,
          runId: null,
          paperclipProjectId: null,
        }, "CodeGraph access request approved but not applied", {
          requestId, decision, error: detail,
        });
        return { ok: false, request: applied, error: detail };
      }

      return { ok: true, request: applied };
    });

    /**
     * Index a repository on request.
     *
     * Indexing mutates the checkout (it writes `.codegraph/`) and is CPU- and
     * disk-intensive, so it is an explicit operator action rather than something
     * `autoIndex` does quietly — and never something an agent can trigger.
     * `reindex: true` is a full rebuild, which upstream implements by recreating
     * the database.
     */
    ctx.actions.register("index-now", async (params) => {
      const companyId = asString(params?.["companyId"]);
      if (!companyId) throw new Error("companyId is required");
      const reindex = params?.["reindex"] === true;

      const { config: scoped, error } = await loadConfig(ctx, companyId);
      if (error) throw new Error(error);

      const root = await repositoryRoot(ctx, companyId);
      const document = await new GovernanceStore(ctx.state).loadForResolve(companyId);
      const wanted = asString(params?.["projectKey"]);
      const company = document.companies[companyId];
      const available = Object.keys(company?.projects ?? {});
      const projectKey =
        wanted && available.includes(wanted) ? wanted : (company?.defaultProjectKey ?? available[0]);
      if (!projectKey) {
        throw new Error(
          "No repository is bound for this company. Add one before indexing.",
        );
      }
      const binding = company?.projects?.[projectKey];
      if (!binding) throw new Error(`No binding for "${projectKey}"`);

      const env = mcpEnv(scoped);
      const binary = await ensureBinary({
        command: scoped.codegraphCommand,
        autoInstall: scoped.autoInstall,
        version: scoped.codegraphVersion,
        timeoutMs: Math.max(scoped.startupTimeoutMs, 300_000),
        env,
      });
      if (!binary.ok || !binary.resolvedPath) throw new Error(binary.detail);

      const projectPath = resolveProjectPath(bindingPathFor(binding.path, root), {
        allowedProjectRoots: containmentRoots(scoped, root),
      });

      const result = reindex
        ? await rebuildIndex({
            projectPath,
            command: binary.resolvedPath,
            timeoutMs: scoped.indexTimeoutMs,
            env,
          })
        : await ensureIndex({
            projectPath,
            // An explicit request, so index even though autoIndex may be off.
            autoIndex: true,
            command: binary.resolvedPath,
            timeoutMs: scoped.indexTimeoutMs,
            env,
          });

      await audit(
        ctx,
        { companyId, agentId: null, runId: null, paperclipProjectId: null },
        `CodeGraph index ${result.ok ? "completed" : "failed"} for "${projectKey}"`,
        { projectKey, reindex, ok: result.ok, detail: result.detail.slice(0, 300) },
      );

      return {
        ok: result.ok,
        projectKey,
        alias: path.basename(projectPath),
        reindex,
        detail: result.detail,
      };
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

/** Best-effort agent display name; a missing name must not fail a request. */
async function resolveAgentName(
  ctx: PluginContext,
  companyId: string,
  agentId: string,
): Promise<string | null> {
  try {
    const rows = await ctx.agents.list({ companyId, limit: 200, offset: 0 });
    return rows.find((agent) => agent.id === agentId)?.name ?? null;
  } catch {
    return null;
  }
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export default plugin;
runWorker(plugin, import.meta.url);
