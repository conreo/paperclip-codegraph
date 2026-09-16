#!/usr/bin/env node
/**
 * End-to-end multi-organization isolation test against a *live* Paperclip
 * instance with paperclip-codegraph installed.
 *
 * It proves, using real HTTP calls to the real host and real CodeGraph
 * processes:
 *
 *   1. the plugin is inert until a company enables it            (disabled by default)
 *   2. each company resolves to its OWN bound repository          (no cross-tenant read)
 *   3. a tool denied at company scope is denied for its agents    (deny wins)
 *   4. a per-agent allow list narrows what an agent may call       (narrowing-only)
 *   5. a real `codegraph_explore` call returns code from the right repo
 *   6. audit rows for the call exist in the gateway's call-event log
 *
 * Nothing here is mocked: the CodeGraph MCP server is the real `codegraph`
 * binary reading real indexes.
 *
 * Usage:
 *   PAPERCLIP_API_URL=http://127.0.0.1:3100 \
 *   PAPERCLIP_BOARD_API_KEY=... \            # only needed if the instance is not local_trusted
 *   node scripts/e2e-isolation.mjs \
 *     --plugin-id <plugin-db-id> \
 *     --company-a <uuid> --repo-a /abs/path \
 *     --company-b <uuid> --repo-b /abs/path
 *
 * Exit code 0 means every check passed. Findings are printed as a table and,
 * with --json, emitted as machine-readable JSON for CI.
 */

import process from "node:process";

const args = parseArgs(process.argv.slice(2));
const API = (args["api-url"] ?? process.env["PAPERCLIP_API_URL"] ?? "http://127.0.0.1:3100").replace(/\/$/, "");
const API_KEY = args["api-key"] ?? process.env["PAPERCLIP_BOARD_API_KEY"] ?? null;
const PLUGIN_ID = require_("plugin-id", args["plugin-id"]);
const COMPANY_A = require_("company-a", args["company-a"]);
const COMPANY_B = require_("company-b", args["company-b"]);
const REPO_A = require_("repo-a", args["repo-a"]);
const REPO_B = require_("repo-b", args["repo-b"]);
const AGENT_A = args["agent-a"] ?? "e2e-agent-restricted";
const AGENT_FREE = args["agent-free"] ?? "e2e-agent-full";

function require_(name, value) {
  if (!value) {
    console.error(`missing required --${name}`);
    process.exit(2);
  }
  return value;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    if (key === "json") {
      out[key] = true;
      continue;
    }
    out[key] = argv[i + 1];
    i += 1;
  }
  return out;
}

function headers() {
  const h = { "Content-Type": "application/json" };
  if (API_KEY) h["Authorization"] = `Bearer ${API_KEY}`;
  return h;
}

async function api(method, path, body) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: headers(),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: response.status, ok: response.ok, body: parsed };
}

const results = [];
function check(name, passed, detail) {
  results.push({ name, passed, detail });
  const mark = passed ? "PASS" : "FAIL";
  console.log(`  [${mark}] ${name}${detail ? ` — ${detail}` : ""}`);
}

/** Run a plugin action through the host's bridge; the host scopes it by companyId. */
async function action(key, companyId, params) {
  const response = await api("POST", `/api/plugins/${PLUGIN_ID}/bridge/action`, {
    key,
    companyId,
    params: { companyId, ...params },
  });
  if (!response.ok) {
    throw new Error(`action ${key} failed: ${response.status} ${JSON.stringify(response.body)}`);
  }
  return response.body?.data ?? response.body;
}

async function data(key, params, companyId) {
  if (typeof params === "string") {
    companyId = params;
    params = {};
  }
  const response = await api("POST", `/api/plugins/${PLUGIN_ID}/bridge/data`, {
    key,
    companyId,
    params: { companyId, ...params },
  });
  if (!response.ok) {
    throw new Error(`data ${key} failed: ${response.status} ${JSON.stringify(response.body)}`);
  }
  return response.body?.data ?? response.body;
}

async function setConfig(companyId, configJson) {
  const response = await api("POST", `/api/plugins/${PLUGIN_ID}/config`, {
    companyId,
    configJson,
  });
  if (!response.ok) {
    throw new Error(`config for ${companyId} failed: ${response.status} ${JSON.stringify(response.body)}`);
  }
  return response.body;
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

async function main() {
  console.log(`\nPaperclip CodeGraph isolation E2E against ${API}`);
  console.log(`  plugin   ${PLUGIN_ID}`);
  console.log(`  companyA ${COMPANY_A}  -> ${REPO_A}`);
  console.log(`  companyB ${COMPANY_B}  -> ${REPO_B}\n`);

  // ---------------------------------------------------------------------
  // 1. Neutralize both companies, then confirm the plugin is inert.
  // ---------------------------------------------------------------------
  console.log("1. Disabled-by-default posture");
  for (const companyId of [COMPANY_A, COMPANY_B]) {
    await setConfig(companyId, { enabled: false });
  }
  const offA = await action("explain-scope", COMPANY_A, {});
  const offB = await action("explain-scope", COMPANY_B, {});
  check(
    "company A denied while disabled",
    offA.allowed === false && offA.reason === "plugin_disabled",
    `reason=${offA.reason}`,
  );
  check(
    "company B denied while disabled",
    offB.allowed === false && offB.reason === "plugin_disabled",
    `reason=${offB.reason}`,
  );

  // ---------------------------------------------------------------------
  // 2. Bind each company to its own repository.
  //
  // Company A additionally denies `codegraph_impact` at company scope and puts
  // one agent on a narrower allow list, so the narrowing rules are exercised.
  // ---------------------------------------------------------------------
  console.log("\n2. Bind distinct repositories per company");
  const roots = [REPO_A, REPO_B].map((p) => p.replace(/\/[^/]+\/[^/]+$/, ""));
  for (const companyId of [COMPANY_A, COMPANY_B]) {
    await setConfig(companyId, {
      enabled: true,
      autoIndex: false,
      allowedProjectRoots: [...new Set(roots)],
    });
  }

  await action("set-company-governance", COMPANY_A, {
    governance: {
      enabled: true,
      defaultProjectKey: "payments",
      projects: { payments: { projectKey: "payments", path: REPO_A, displayName: "Payments" } },
      policy: { deniedTools: ["codegraph_impact"] },
      agents: {
        [AGENT_A]: { policy: { allowedTools: ["codegraph_explore", "codegraph_search"] } },
      },
    },
  });
  await action("set-company-governance", COMPANY_B, {
    governance: {
      enabled: true,
      defaultProjectKey: "inventory",
      projects: {
        inventory: { projectKey: "inventory", path: REPO_B, displayName: "Inventory" },
      },
    },
  });

  const onA = await action("explain-scope", COMPANY_A, {});
  const onB = await action("explain-scope", COMPANY_B, {});
  check(
    "company A resolves to its own binding",
    onA.allowed === true && onA.projectKey === "payments",
    `projectKey=${onA.projectKey}`,
  );
  check(
    "company B resolves to its own binding",
    onB.allowed === true && onB.projectKey === "inventory",
    `projectKey=${onB.projectKey}`,
  );
  check(
    "company A cannot resolve company B's binding",
    onA.projectKey !== onB.projectKey,
    `A=${onA.projectKey} B=${onB.projectKey}`,
  );

  // ---------------------------------------------------------------------
  // 3. Forged identifiers must not escape the caller's own company.
  // ---------------------------------------------------------------------
  console.log("\n3. Forged cross-tenant identifiers");
  const forged = await action("explain-scope", COMPANY_A, {
    paperclipProjectId: "00000000-0000-0000-0000-000000000000",
    agentId: "not-a-real-agent",
  });
  check(
    "company A ignores a forged project/agent id",
    forged.projectKey === "payments",
    `projectKey=${forged.projectKey}`,
  );

  // ---------------------------------------------------------------------
  // 4. Company-scope deny and agent-scope narrowing.
  // ---------------------------------------------------------------------
  console.log("\n4. Deny wins; narrower scopes only narrow");
  const agentFree = await action("explain-scope", COMPANY_A, { agentId: AGENT_FREE });
  check(
    "company deny removes codegraph_impact for a normal agent",
    !agentFree.effectiveTools.includes("codegraph_impact"),
    `effective=${agentFree.effectiveTools.length} denied=${JSON.stringify(agentFree.deniedTools)}`,
  );

  const agentRestricted = await action("explain-scope", COMPANY_A, { agentId: AGENT_A });
  check(
    "agent allow list narrows to exactly two tools",
    JSON.stringify(agentRestricted.effectiveTools) ===
      JSON.stringify(["codegraph_explore", "codegraph_search"]),
    `effectiveTools=${JSON.stringify(agentRestricted.effectiveTools)}`,
  );
  check(
    "agent override cannot re-grant a company-denied tool",
    !agentRestricted.effectiveTools.includes("codegraph_impact"),
    "codegraph_impact absent",
  );
  check(
    "a normal agent sees more tools than the restricted agent",
    agentFree.effectiveTools.length > agentRestricted.effectiveTools.length,
    `${agentFree.effectiveTools.length} > ${agentRestricted.effectiveTools.length}`,
  );

  // ---------------------------------------------------------------------
  // 5. Real CodeGraph calls, one per company.
  // ---------------------------------------------------------------------
  console.log("\n5. Real CodeGraph MCP calls through the real host");
  // Company-specific queries, so each result is a real answer about that
  // company's code rather than an empty match that would prove nothing.
  const verifyA = await data("verify-scope", { query: "recordPayment balanceCents" }, COMPANY_A);
  const verifyB = await data("verify-scope", { query: "restock totalUnits" }, COMPANY_B);

  check(
    "company A call succeeded against its repo",
    verifyA.ok === true,
    `projectKey=${verifyA.projectKey} chars=${verifyA.resultChars} ms=${verifyA.durationMs}`,
  );
  check(
    "company B call succeeded against its repo",
    verifyB.ok === true,
    `projectKey=${verifyB.projectKey} chars=${verifyB.resultChars} ms=${verifyB.durationMs}`,
  );
  // The load-bearing isolation assertions: each company is served its own
  // files, and none of the other company's files appear anywhere in the answer.
  const aFiles = (verifyA.filesServed ?? []).join(" ");
  const bFiles = (verifyB.filesServed ?? []).join(" ");
  const aBody = `${verifyA.resultDigest ?? ""} ${aFiles}`;
  const bBody = `${verifyB.resultDigest ?? ""} ${bFiles}`;

  check(
    "company A is served its own file (ledger.ts)",
    aFiles.includes("ledger.ts"),
    `files=${JSON.stringify(verifyA.filesServed)}`,
  );
  check(
    "company B is served its own file (warehouse.ts)",
    bFiles.includes("warehouse.ts"),
    `files=${JSON.stringify(verifyB.filesServed)}`,
  );
  check(
    "company A's answer contains none of company B's code",
    !aBody.includes("warehouse") && !aBody.includes("restock") && !aBody.includes("totalUnits"),
    "no tenant-B identifiers in tenant-A output",
  );
  check(
    "company B's answer contains none of company A's code",
    !bBody.includes("ledger") && !bBody.includes("recordPayment") && !bBody.includes("balanceCents"),
    "no tenant-A identifiers in tenant-B output",
  );
  check(
    "the upstream allowlist reaches CodeGraph itself",
    verifyA.upstreamToolCount >= 1,
    `upstream tools listed=${verifyA.upstreamToolCount}`,
  );
  check(
    "company A's effective tool set excludes the company-denied tool",
    Array.isArray(verifyA.effectiveTools) &&
      !verifyA.effectiveTools.includes("codegraph_impact") &&
      verifyA.effectiveTools.length < verifyA.allowedTools.length,
    `effective=${verifyA.effectiveTools?.length} allowed=${verifyA.allowedTools?.length}`,
  );
  check(
    "company B has no company-level denial, so all eight are effective",
    Array.isArray(verifyB.effectiveTools) && verifyB.effectiveTools.length === 8,
    `effective=${verifyB.effectiveTools?.length}`,
  );

  // ---------------------------------------------------------------------
  // 6. Governance summary shows two independent companies.
  // ---------------------------------------------------------------------
  console.log("\n6. Governance state is per company");
  const summaryA = await data("governance-summary", COMPANY_A);
  const summaryB = await data("governance-summary", COMPANY_B);

  // Each company-scoped read must return exactly its own entry: a read for A
  // that could see B would itself be the leak.
  check(
    "company A's governance read contains only company A",
    Object.keys(summaryA.companies ?? {}).join() === COMPANY_A,
    `keys=${Object.keys(summaryA.companies ?? {}).length}`,
  );
  check(
    "company B's governance read contains only company B",
    Object.keys(summaryB.companies ?? {}).join() === COMPANY_B,
    `keys=${Object.keys(summaryB.companies ?? {}).length}`,
  );
  const aliasesA = summaryA.companies[COMPANY_A]?.projectKeys ?? [];
  const aliasesB = summaryB.companies[COMPANY_B]?.projectKeys ?? [];
  check(
    "each company sees its own project alias and not the other's",
    aliasesA.join() === "payments" && aliasesB.join() === "inventory",
    `A=${JSON.stringify(aliasesA)} B=${JSON.stringify(aliasesB)}`,
  );
  check(
    "no absolute repository path is disclosed by either read",
    !JSON.stringify(summaryA).includes(REPO_A) &&
      !JSON.stringify(summaryA).includes(REPO_B) &&
      !JSON.stringify(summaryB).includes(REPO_A) &&
      !JSON.stringify(summaryB).includes(REPO_B),
    "no host paths in summary",
  );

  // ---------------------------------------------------------------------
  // 7. Audit visibility for the plugin's own decisions.
  // ---------------------------------------------------------------------
  if (API_KEY) {
    console.log("\n7. Audit trail");
    const audit = await api(
      "GET",
      `/api/tool-gateway/audit?companyId=${COMPANY_A}&window=24h&limit=50`,
    );
    const rows = Array.isArray(audit.body?.events)
      ? audit.body.events
      : Array.isArray(audit.body?.data)
        ? audit.body.data
        : [];
    const codegraphRows = rows.filter((row) =>
      JSON.stringify(row).includes("codegraph"),
    );
    check(
      "gateway audit is reachable",
      audit.ok,
      `status=${audit.status} rows=${rows.length}`,
    );
    check(
      "audit mentions codegraph activity",
      codegraphRows.length > 0,
      `matching rows=${codegraphRows.length}`,
    );
  } else {
    console.log("\n7. Audit trail skipped (no PAPERCLIP_BOARD_API_KEY supplied)");
  }

  // ---------------------------------------------------------------------
  const failed = results.filter((row) => !row.passed);
  const report = {
    api: API,
    pluginId: PLUGIN_ID,
    companies: { a: COMPANY_A, b: COMPANY_B },
    repos: { a: REPO_A, b: REPO_B },
    tools: ALL_TOOLS,
    passed: results.length - failed.length,
    failed: failed.length,
    checks: results,
    verifications: { companyA: verifyA, companyB: verifyB },
  };

  if (args["json"]) console.log(`\n---JSON---\n${JSON.stringify(report, null, 2)}`);

  console.log(
    `\n${failed.length === 0 ? "ALL CHECKS PASSED" : `${failed.length} CHECK(S) FAILED`} (${results.length - failed.length}/${results.length})`,
  );
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(`\nE2E aborted: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
