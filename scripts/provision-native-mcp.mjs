#!/usr/bin/env node
/**
 * Provision CodeGraph as a *native* Paperclip MCP connection
 * (`transport: "local_stdio"`), so it appears in Tools & Access with catalog
 * risk levels, policies, approval flow and runtime slots.
 *
 * This is the second of the two integration paths described in the README. The
 * plugin's own agent-tool path needs no credentials; this one does, because it
 * writes Paperclip governance objects through the board API.
 *
 * Why this is a script and not something the plugin does itself:
 *   - Paperclip has no plugin capability for creating applications, connections,
 *     profiles, policies or bindings — governance is core-only by construction;
 *   - the plugin worker's `ctx.http` refuses loopback/private addresses
 *     (`plugin-host-services.ts`), and a local Paperclip is exactly that.
 *
 * So the plugin *computes* the plan (pure, testable) and this script *executes*
 * it with a board API key.
 *
 * Usage:
 *   PAPERCLIP_API_URL=http://127.0.0.1:3100 \
 *   PAPERCLIP_BOARD_API_KEY=... \
 *   node scripts/provision-native-mcp.mjs \
 *     --company-id <uuid> \
 *     --project-path /srv/checkouts/acme-web \
 *     [--allow codegraph_explore,codegraph_search] \
 *     [--deny codegraph_impact] \
 *     [--dry-run]
 *
 * Prints the plan first, then executes unless --dry-run. Idempotent-ish: each
 * step reports "already exists" rather than aborting the run.
 */

import process from "node:process";

const args = parseArgs(process.argv.slice(2));
const API = (
  args["api-url"] ??
  process.env["PAPERCLIP_API_URL"] ??
  "http://127.0.0.1:3100"
).replace(/\/$/, "");
const API_KEY = args["api-key"] ?? process.env["PAPERCLIP_BOARD_API_KEY"];
const COMPANY_ID = args["company-id"];
const PROJECT_PATH = args["project-path"];
const DRY_RUN = args["dry-run"] === true || args["dry-run"] === "true";
const COMMAND = args["command"] ?? "codegraph";
const ARGS = (args["args"] ?? "serve --mcp").split(" ").filter(Boolean);
const TEMPLATE_ID = args["template-id"] ?? "codegraph-mcp";
const PROFILE_KEY = args["profile-key"] ?? "codegraph-read";
const ALLOW = args["allow"] ? args["allow"].split(",").map((s) => s.trim()) : null;
const DENY = args["deny"] ? args["deny"].split(",").map((s) => s.trim()) : [];

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out[key] = true;
      continue;
    }
    out[key] = next;
    i += 1;
  }
  return out;
}

if (!COMPANY_ID || !PROJECT_PATH) {
  console.error("usage: node scripts/provision-native-mcp.mjs --company-id <uuid> --project-path /abs/path [--dry-run]");
  process.exit(2);
}
if (!DRY_RUN && !API_KEY) {
  console.error("PAPERCLIP_BOARD_API_KEY is required to execute the plan (use --dry-run to only print it).");
  process.exit(2);
}

const ALL_TOOLS = [
  "codegraph_explore",
  "codegraph_search",
  "codegraph_callers",
  "codegraph_callees",
  "codegraph_impact",
  "codegraph_node",
  "codegraph_status",
  "codegraph_files",
];

const allowed = (ALLOW && ALLOW.length > 0 ? ALLOW : ALL_TOOLS).filter((t) => !DENY.includes(t));

const steps = [
  {
    purpose: "Approve the CodeGraph MCP command (local_stdio requires an approved template).",
    method: "POST",
    path: `/api/companies/${COMPANY_ID}/tools/stdio-templates`,
    body: {
      templateId: TEMPLATE_ID,
      name: "CodeGraph MCP server",
      description: "CodeGraph code-intelligence MCP server, registered by paperclip-codegraph.",
      command: COMMAND,
      args: ARGS,
      envKeys: ["CODEGRAPH_MCP_TOOLS", "DO_NOT_TRACK", "CODEGRAPH_TELEMETRY"],
      tools: ALL_TOOLS.map((name) => ({
        name,
        description: `CodeGraph ${name}`,
        inputSchema: { type: "object", properties: {} },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      })),
    },
  },
  {
    purpose: "Create the application container (mcp_stdio is the required type for local stdio).",
    method: "POST",
    path: `/api/companies/${COMPANY_ID}/tools/applications`,
    capture: "applicationId",
    body: {
      applicationKey: "codegraph",
      name: "CodeGraph",
      description: "Local CodeGraph code-intelligence index exposed as MCP tools.",
      type: "mcp_stdio",
      status: "active",
      metadata: { registeredBy: "paperclip-codegraph" },
    },
  },
  {
    purpose: "Register the MCP endpoint. The project path is fixed in transportConfig, so no tool argument can change it.",
    method: "POST",
    path: `/api/companies/${COMPANY_ID}/tools/connections`,
    capture: "connectionId",
    body: {
      applicationId: "$applicationId",
      name: "CodeGraph",
      connectionPurpose: "tool",
      transport: "local_stdio",
      authKind: "none",
      ownership: "customer",
      connectionKind: "managed",
      transportConfig: {
        templateId: TEMPLATE_ID,
        env: {
          CODEGRAPH_MCP_TOOLS: allowed.map((t) => t.replace(/^codegraph_/, "")).join(","),
          DO_NOT_TRACK: "1",
          CODEGRAPH_TELEMETRY: "0",
        },
        projectPath: PROJECT_PATH,
      },
      enabled: true,
    },
  },
  {
    purpose: "Discover the tool catalog so Paperclip can attach risk levels and allow/deny entries.",
    method: "POST",
    path: "/api/tool-connections/$connectionId/catalog/refresh",
    body: {},
  },
  {
    purpose: "Create the governing profile. defaultAction is deny, so nothing is visible until included.",
    method: "POST",
    path: `/api/companies/${COMPANY_ID}/tools/profiles`,
    capture: "profileId",
    body: {
      profileKey: PROFILE_KEY,
      name: "CodeGraph read-only",
      description: "Read-only CodeGraph code-intelligence tools. Every CodeGraph tool is query-only.",
      status: "active",
      defaultAction: "deny",
      metadata: { registeredBy: "paperclip-codegraph" },
      entries: [
        ...allowed.map((toolName) => ({ selectorType: "tool_name", effect: "include", toolName })),
        ...DENY.map((toolName) => ({ selectorType: "tool_name", effect: "exclude", toolName })),
      ],
    },
  },
  {
    purpose: "Bind the profile at company scope. Re-run with targetType project/agent to narrow it.",
    method: "POST",
    path: `/api/companies/${COMPANY_ID}/tools/profiles/$profileId/bind`,
    body: { targetType: "company", targetId: COMPANY_ID, priority: 100 },
  },
];

console.log(`Native MCP provisioning plan for company ${COMPANY_ID}`);
console.log(`  project   ${PROJECT_PATH}`);
console.log(`  command   ${COMMAND} ${ARGS.join(" ")}`);
console.log(`  allow     ${allowed.join(", ")}`);
if (DENY.length > 0) console.log(`  deny      ${DENY.join(", ")}`);
console.log();

const captured = {};

function materialize(value) {
  if (typeof value === "string" && value.startsWith("$")) return captured[value.slice(1)] ?? value;
  if (Array.isArray(value)) return value.map(materialize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, materialize(v)]));
  }
  return value;
}

function headers() {
  return {
    "Content-Type": "application/json",
    ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}),
  };
}

for (const [index, step] of steps.entries()) {
  const path = materialize(step.path);
  const body = materialize(step.body ?? null);
  console.log(`Step ${index + 1}: ${step.purpose}`);
  console.log(`  ${step.method} ${API}${path}`);
  if (body) console.log(`  body ${JSON.stringify(body).slice(0, 300)}${JSON.stringify(body).length > 300 ? "…" : ""}`);

  if (DRY_RUN) {
    console.log("  (dry run — not executed)\n");
    continue;
  }

  try {
    const response = await fetch(`${API}${path}`, {
      method: step.method,
      headers: headers(),
      body: body === null ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }

    if (!response.ok) {
      const message = typeof parsed === "object" && parsed ? parsed.error ?? JSON.stringify(parsed) : String(parsed);
      // A pre-existing template/profile is the common re-run case, not a failure.
      const benign = /already exists|duplicate key|unique constraint/i.test(message);
      console.log(`  ${benign ? "skip" : "FAIL"} (${response.status}) ${message.slice(0, 240)}\n`);
      if (!benign) process.exitCode = 1;
      continue;
    }

    if (step.capture && parsed && typeof parsed === "object" && parsed.id) {
      captured[step.capture] = parsed.id;
      console.log(`  ok → ${step.capture} = ${parsed.id}`);
    } else {
      console.log("  ok");
    }
    console.log();
  } catch (error) {
    console.log(`  FAIL ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

console.log(
  process.exitCode
    ? "Provisioning finished with errors."
    : DRY_RUN
      ? "Dry run complete. Re-run without --dry-run to apply."
      : "Provisioning complete. CodeGraph tools should now appear in Tools & Access.",
);
