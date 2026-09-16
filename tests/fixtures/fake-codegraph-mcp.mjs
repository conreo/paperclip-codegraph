#!/usr/bin/env node
/**
 * A fake CodeGraph MCP server for tests.
 *
 * Speaks the same stdio JSON-RPC surface as `codegraph serve --mcp`:
 * newline-delimited JSON-RPC 2.0, protocol version 2024-11-05, `tools/list`
 * and `tools/call`, text-only content blocks.
 *
 * Its job is to make the *transport contract* testable without a 280 MB
 * CodeGraph install and without a real index. It deliberately reports back the
 * `projectPath` it was given, so a test can assert that the plugin injected the
 * governance-resolved path and that an agent-supplied one never survived.
 *
 * Behaviour is driven by env vars so one fixture covers several cases:
 *   FAKE_MCP_TOOLS          comma-separated short names for `tools/list`
 *                           (default: all eight, mirroring an explicit allowlist)
 *   FAKE_MCP_ECHO_ARGS=1    return the received arguments as JSON text
 *   FAKE_MCP_ERROR=1        answer every `tools/call` with `isError: true`
 *   FAKE_MCP_EXIT_ON_CALL=1 exit the process on `tools/call` (transport failure)
 *   FAKE_MCP_HANG_MS=…      delay before answering `tools/call`
 *   FAKE_MCP_NO_LIST=1      omit `tools/list` support
 *   FAKE_MCP_LOG=path       append every received message as JSON lines
 *   FAKE_MCP_NO_NEWLINE_ECHO=1 do not answer `notifications/initialized`
 */

import process from "node:process";
import fs from "node:fs";

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

const LOG_PATH = process.env["FAKE_MCP_LOG"];

function log(entry) {
  if (!LOG_PATH) return;
  try {
    fs.appendFileSync(LOG_PATH, `${JSON.stringify(entry)}\n`);
  } catch {
    /* logging is best-effort */
  }
}

function configuredTools() {
  const raw = process.env["FAKE_MCP_TOOLS"];
  if (raw === undefined) return ALL_TOOLS;
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => (entry.startsWith("codegraph_") ? entry : `codegraph_${entry}`));
}

function toolDescriptors() {
  return configuredTools().map((name) => ({
    name,
    description: `Fake ${name}`,
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" }, symbol: { type: "string" } },
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  }));
}

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id, result) {
  write({ jsonrpc: "2.0", id, result });
}

function fail(id, code, message) {
  write({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handle(message) {
  log({ direction: "in", message });

  const { id, method, params } = message;

  if (method === "initialize") {
    reply(id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "fake-codegraph", version: "0.0.0" },
    });
    return;
  }

  if (method === "notifications/initialized") {
    if (process.env["FAKE_MCP_NO_NEWLINE_ECHO"] !== "1") {
      log({ direction: "notified" });
    }
    return;
  }

  if (method === "tools/list") {
    if (process.env["FAKE_MCP_NO_LIST"] === "1") {
      fail(id, -32601, "Method not found");
      return;
    }
    reply(id, { tools: toolDescriptors() });
    return;
  }

  if (method === "tools/call") {
    if (process.env["FAKE_MCP_EXIT_ON_CALL"] === "1") {
      process.exit(3);
    }

    const hangMs = Number(process.env["FAKE_MCP_HANG_MS"] ?? "0");
    if (Number.isFinite(hangMs) && hangMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, hangMs));
    }

    const name = params?.name;
    const args = params?.arguments ?? {};
    log({ direction: "call", name, args });

    if (process.env["FAKE_MCP_ERROR"] === "1") {
      reply(id, {
        content: [{ type: "text", text: `fake failure for ${name}` }],
        isError: true,
      });
      return;
    }

    const payload =
      process.env["FAKE_MCP_ECHO_ARGS"] === "1"
        ? JSON.stringify({ receivedArgs: args, tool: name })
        : `# fake ${name}\n\nproject=${args?.projectPath ?? "<none>"}\n`;

    reply(id, { content: [{ type: "text", text: payload }] });
    return;
  }

  if (method === "ping") {
    reply(id, {});
    return;
  }

  fail(id, -32601, `Method not found: ${method}`);
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf("\n");
  while (index !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line.length > 0) {
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        // A malformed line is ignored rather than fatal, exactly like upstream.
        parsed = null;
      }
      if (parsed) void handle(parsed);
    }
    index = buffer.indexOf("\n");
  }
});

process.stdin.on("end", () => process.exit(0));
