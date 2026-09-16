/**
 * Provisioning CodeGraph as a *native* Paperclip MCP connection.
 *
 * There are two ways CodeGraph can reach a Paperclip agent, and they are not
 * competing:
 *
 * | Path | Tool `providerType` | Governance enforced by | When to choose it |
 * |---|---|---|---|
 * | Plugin agent tools (this plugin's worker) | `paperclip_plugin` | Paperclip gateway profiles **+** this plugin's resolver | Default. No board API key needed, works from the SDK alone. |
 * | Native MCP connection (`local_stdio`) | `mcp_local_stdio` | Paperclip gateway profiles, catalog risk, policies, approvals, runtime slots | When an operator wants CodeGraph to appear in Tools & Access as an app, with per-tool risk levels and human approval flow. |
 *
 * This module builds the second path's REST requests. It is **pure**: it
 * produces payloads and ordering, and never performs I/O, so it can be tested
 * without a running instance and without credentials. Execution is the
 * operator's job — `scripts/provision-native-mcp.mjs` does it with a board API
 * key, and this plugin's `paperclip-codegraph.native-mcp-plan` action returns
 * the same plan for a UI to display.
 *
 * Endpoint shapes were read from Paperclip's own validators and routes:
 *   - `packages/shared/src/validators/tool-access.ts` (request schemas)
 *   - `server/src/routes/tool-access.ts` (paths and auth)
 *
 * Two constraints discovered there shape the plan:
 *   - `local_stdio` requires an approved stdio command template: the connection's
 *     `transportConfig.templateId` must name a built-in or admin-created active
 *     template (`resolveStdioTemplate` in `server/src/services/tool-access.ts`),
 *     so step 1 creates that template.
 *   - `local_stdio` is only accepted in `local_trusted` mode or via a trusted
 *     runtime host (`assertLocalStdioCanBeEnabled`), so the plan carries a
 *     preflight check for the operator.
 */

import { PLUGIN_ID } from "../constants.js";
import { CODEGRAPH_TOOL_SPECS, toJsonSchema } from "../tools/catalog.js";

export interface ProvisionRequest {
  method: "POST" | "PATCH" | "PUT" | "DELETE";
  /** Path relative to the API base, e.g. `/api/companies/<id>/tools/applications`. */
  path: string;
  body?: Record<string, unknown>;
  /** Why this step exists, shown in the plan output. */
  purpose: string;
  /** Where the id needed by later steps comes from. */
  providesId?: string;
}

export interface ProvisionPlanInput {
  companyId: string;
  /** Template id for the approved stdio command. Must match `[a-z0-9][a-z0-9._-]*`. */
  templateId?: string;
  applicationKey?: string;
  applicationName?: string;
  connectionName?: string;
  profileKey?: string;
  profileName?: string;
  command: string;
  args: readonly string[];
  /** Tools to include in the profile. Anything omitted is denied by default. */
  allowedTools?: readonly string[];
  /** Tools to exclude explicitly, even if the profile default were allow. */
  deniedTools?: readonly string[];
  /** CodeGraph project path, passed as a fixed env var for the connection. */
  projectPath: string;
  /** Paperclip deployment mode, from `GET /api/health`. */
  deploymentMode?: string;
}

export interface ProvisionPlan {
  companyId: string;
  preflight: { ok: boolean; detail: string };
  steps: ProvisionRequest[];
  notes: string[];
}

export const DEFAULT_TEMPLATE_ID = "codegraph-mcp";
export const DEFAULT_APPLICATION_KEY = "codegraph";
export const DEFAULT_PROFILE_KEY = "codegraph-read";

function toolsFor(templateId: string) {
  return CODEGRAPH_TOOL_SPECS.map((spec) => ({
    name: spec.name,
    description: spec.description,
    inputSchema: toJsonSchema(spec),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    ...(templateId.length > 0 ? {} : {}),
  }));
}

/**
 * Build the ordered REST plan that registers CodeGraph as a governed
 * `local_stdio` MCP connection for one company.
 *
 * The profile defaults to `deny`, so only the tools named in `allowedTools`
 * become visible. That mirrors the "least privilege by default" posture of the
 * plugin's own resolver and means a newly discovered upstream tool cannot
 * silently become callable.
 */
export function buildNativeMcpPlan(input: ProvisionPlanInput): ProvisionPlan {
  const templateId = input.templateId ?? DEFAULT_TEMPLATE_ID;
  const applicationKey = input.applicationKey ?? DEFAULT_APPLICATION_KEY;
  const profileKey = input.profileKey ?? DEFAULT_PROFILE_KEY;

  const allowed =
    input.allowedTools && input.allowedTools.length > 0
      ? [...input.allowedTools]
      : CODEGRAPH_TOOL_SPECS.map((spec) => spec.name);
  const denied = [...(input.deniedTools ?? [])];
  // Deny wins, matching every other layer.
  const effectiveAllowed = allowed.filter((tool) => !denied.includes(tool));

  const localStdioOk =
    input.deploymentMode === undefined || input.deploymentMode === "local_trusted";

  const notes = [
    "Paperclip's providerType for these tools will be `mcp_local_stdio`, so calls flow through the tool gateway and appear in the call-event audit log with catalog risk levels.",
    "`local_stdio` requires an approved stdio command template; step 1 creates one for CodeGraph. If a template with this id already exists, treat that step's failure as benign and continue.",
    "The connection pins the project path as a fixed environment value, so the path is an operator decision and is not reachable from a tool argument.",
    "The profile's defaultAction is `deny`: only the include entries become visible.",
    `Binding target types available: company, agent, project, routine, issue, gateway. Pinning the profile at \`project\` or \`agent\` narrows it further.`,
  ];

  if (!localStdioOk) {
    notes.unshift(
      `This instance reports deploymentMode="${input.deploymentMode}". Paperclip only accepts local_stdio connections in local_trusted mode or through a trusted MCP runtime host, so these calls will be rejected until that is changed. The plugin's own agent-tool path (providerType paperclip_plugin) is unaffected.`,
    );
  }

  const steps: ProvisionRequest[] = [
    {
      method: "POST",
      path: `/api/companies/${input.companyId}/tools/stdio-templates`,
      purpose:
        "Approve the CodeGraph MCP command. Paperclip refuses any local stdio connection whose command is not an approved template.",
      body: {
        templateId,
        name: "CodeGraph MCP server",
        description:
          "CodeGraph code-intelligence MCP server, registered by paperclip-codegraph.",
        command: input.command,
        args: [...input.args],
        envKeys: ["CODEGRAPH_MCP_TOOLS", "DO_NOT_TRACK", "CODEGRAPH_TELEMETRY"],
        tools: toolsFor(templateId),
      },
    },
    {
      method: "POST",
      path: `/api/companies/${input.companyId}/tools/applications`,
      purpose:
        'Create the application container. `mcp_stdio` is the only application type Paperclip accepts for a local stdio connection.',
      providesId: "applicationId",
      body: {
        applicationKey,
        name: input.applicationName ?? "CodeGraph",
        description: "Local CodeGraph code-intelligence index exposed as MCP tools.",
        type: "mcp_stdio",
        status: "draft",
        metadata: { registeredBy: PLUGIN_ID },
      },
    },
    {
      method: "POST",
      path: `/api/companies/${input.companyId}/tools/connections`,
      purpose:
        "Register the MCP endpoint. The project path is fixed in transportConfig so it is not agent-controllable.",
      providesId: "connectionId",
      body: {
        applicationId: "$applicationId",
        name: input.connectionName ?? "CodeGraph",
        connectionPurpose: "tool",
        transport: "local_stdio",
        authKind: "none",
        ownership: "customer",
        connectionKind: "managed",
        transportConfig: {
          templateId,
          env: {
            CODEGRAPH_MCP_TOOLS: effectiveAllowed
              .map((tool) => tool.replace(/^codegraph_/, ""))
              .join(","),
            DO_NOT_TRACK: "1",
            CODEGRAPH_TELEMETRY: "0",
          },
          projectPath: input.projectPath,
        },
        enabled: true,
      },
    },
    {
      method: "POST",
      path: `/api/tool-connections/$connectionId/catalog/refresh`,
      purpose:
        "Discover CodeGraph's tool catalog so Paperclip can attach risk levels and allow/deny entries to real catalog entries.",
      body: {},
    },
    {
      method: "POST",
      path: `/api/companies/${input.companyId}/tools/profiles`,
      purpose:
        "Create the governing profile. defaultAction is `deny`, so nothing is visible until explicitly included.",
      providesId: "profileId",
      body: {
        profileKey,
        name: input.profileName ?? "CodeGraph read-only",
        description:
          "Read-only CodeGraph code-intelligence tools. Every CodeGraph tool is query-only.",
        status: "active",
        defaultAction: "deny",
        metadata: { registeredBy: PLUGIN_ID },
        entries: [
          ...effectiveAllowed.map((tool) => ({
            selectorType: "tool_name",
            effect: "include",
            toolName: tool,
          })),
          ...denied.map((tool) => ({
            selectorType: "tool_name",
            effect: "exclude",
            toolName: tool,
          })),
        ],
      },
    },
    {
      method: "POST",
      path: `/api/companies/${input.companyId}/tools/profiles/$profileId/bind`,
      purpose:
        "Bind the profile at company scope. Re-run with targetType `project` or `agent` to narrow it per Paperclip project or agent.",
      body: { targetType: "company", targetId: input.companyId, priority: 100 },
    },
    {
      method: "POST",
      path: `/api/companies/${input.companyId}/tools/applications`,
      purpose: "Placeholder — see notes.",
      body: {},
    },
  ];

  // The last stub is not a real step; keep the plan tight and honest.
  steps.pop();

  return {
    companyId: input.companyId,
    preflight: {
      ok: localStdioOk,
      detail: localStdioOk
        ? "deploymentMode allows local_stdio connections"
        : `deploymentMode="${input.deploymentMode}" does not allow local_stdio connections`,
    },
    steps,
    notes,
  };
}

/**
 * Render a plan as `curl` commands.
 *
 * `$VARS` in a path or body are shell variables the operator exports from the
 * previous step's response (e.g. `applicationId`). Secrets are passed by
 * reference (`$PAPERCLIP_BOARD_API_KEY`) and never inlined.
 */
export function renderPlanAsCurl(
  plan: ProvisionPlan,
  apiBase = "$PAPERCLIP_API_URL",
): string {
  const lines: string[] = [
    "# Generated by paperclip-codegraph. Review before running.",
    "# Requires: PAPERCLIP_API_URL and PAPERCLIP_BOARD_API_KEY in the environment.",
    ...plan.notes.map((note) => `# NOTE: ${note}`),
    "",
  ];

  for (const [index, step] of plan.steps.entries()) {
    lines.push(`# Step ${index + 1}: ${step.purpose}`);
    const body = step.body ? ` \\\n  -d '${JSON.stringify(step.body)}'` : "";
    lines.push(
      `curl -fsS -X ${step.method} \\\n  -H "Authorization: Bearer $PAPERCLIP_BOARD_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  "${apiBase}${step.path}"${body}`,
    );
    if (step.providesId) {
      lines.push(`# → capture .id from this response as $${step.providesId}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
