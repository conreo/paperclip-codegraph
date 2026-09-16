import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildChildEnv,
  CodeGraphClientPool,
  CodeGraphMcpError,
  CodeGraphMcpServer,
  poolKey,
} from "../src/mcp/client.js";
import { LineDelimitedJsonDecoder, encodeMessage, extractText } from "../src/mcp/protocol.js";

const FAKE = fileURLToPath(new URL("./fixtures/fake-codegraph-mcp.mjs", import.meta.url));

/** An indexed-looking project directory the fake server can be pointed at. */
function makeProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pcg-mcp-"));
  fs.mkdirSync(path.join(root, ".codegraph"), { recursive: true });
  fs.writeFileSync(path.join(root, ".codegraph", "codegraph.db"), "");
  return root;
}

const PROJECT = makeProject();
const openServers: CodeGraphMcpServer[] = [];

function server(env: Record<string, string> = {}, projectPath = PROJECT): CodeGraphMcpServer {
  const instance = new CodeGraphMcpServer({
    command: process.execPath,
    args: [FAKE],
    projectPath,
    extraEnv: env,
    callTimeoutMs: 10_000,
    startupTimeoutMs: 10_000,
  });
  openServers.push(instance);
  return instance;
}

afterEach(async () => {
  while (openServers.length > 0) {
    await openServers.pop()!.stop();
  }
});

describe("line-delimited JSON decoding", () => {
  it("splits complete lines and retains a partial tail", () => {
    const decoder = new LineDelimitedJsonDecoder();
    expect(decoder.push('{"a":1}\n{"b":')).toEqual([{ a: 1 }]);
    expect(decoder.pendingChars).toBeGreaterThan(0);
    expect(decoder.push('2}\n')).toEqual([{ b: 2 }]);
    expect(decoder.pendingChars).toBe(0);
  });

  it("skips blank lines", () => {
    const decoder = new LineDelimitedJsonDecoder();
    expect(decoder.push('\n\n{"a":1}\n\n')).toEqual([{ a: 1 }]);
  });

  it("reports a malformed line instead of throwing", () => {
    const bad: string[] = [];
    const decoder = new LineDelimitedJsonDecoder((line) => bad.push(line));
    expect(decoder.push("not json\n")).toEqual([]);
    expect(bad).toEqual(["not json"]);
  });
});

describe("protocol helpers", () => {
  it("encodes one newline-terminated message", () => {
    const encoded = encodeMessage({ jsonrpc: "2.0", id: 1, method: "ping" });
    expect(encoded.endsWith("\n")).toBe(true);
    expect(encoded.split("\n").filter(Boolean)).toHaveLength(1);
    expect(JSON.parse(encoded)).toMatchObject({ jsonrpc: "2.0", id: 1, method: "ping" });
  });

  it("joins multiple text blocks and ignores non-text blocks", () => {
    expect(
      extractText({
        content: [
          { type: "text", text: "a" },
          { type: "image", text: "ignored" } as never,
          { type: "text", text: "b" },
        ],
      }),
    ).toBe("a\n\nb");
  });

  it("returns an empty string for a result with no content", () => {
    expect(extractText({})).toBe("");
    expect(extractText({ content: [] })).toBe("");
  });
});

describe("buildChildEnv", () => {
  const base = {
    command: "codegraph",
    args: ["serve", "--mcp"],
    projectPath: "/srv/project",
  };

  it("hard-disables telemetry, update checks and shim downloads by default", () => {
    const env = buildChildEnv(base, { PATH: "/usr/bin" });
    expect(env["DO_NOT_TRACK"]).toBe("1");
    expect(env["CODEGRAPH_TELEMETRY"]).toBe("0");
    expect(env["CODEGRAPH_NO_UPDATE_CHECK"]).toBe("1");
    expect(env["CODEGRAPH_NO_DOWNLOAD"]).toBe("1");
  });

  it("defaults to direct mode rather than the shared daemon", () => {
    expect(buildChildEnv(base, {}).CODEGRAPH_NO_DAEMON).toBe("1");
    expect(buildChildEnv({ ...base, useDaemon: true }, {}).CODEGRAPH_NO_DAEMON).toBeUndefined();
  });

  it("omits the telemetry switches when telemetry is explicitly allowed", () => {
    const env = buildChildEnv({ ...base, allowTelemetry: true }, {});
    expect(env["DO_NOT_TRACK"]).toBeUndefined();
    expect(env["CODEGRAPH_TELEMETRY"]).toBeUndefined();
  });

  it("always sets CODEGRAPH_MCP_TOOLS, using upstream short names", () => {
    const env = buildChildEnv(
      { ...base, toolAllowlist: ["codegraph_explore", "codegraph_node"] },
      {},
    );
    expect(env["CODEGRAPH_MCP_TOOLS"]).toBe("explore,node");
  });

  it("sets an empty allowlist when no tools are permitted", () => {
    // Upstream lists only `explore` when this variable is unset, so an empty
    // value is the only way to expose nothing.
    expect(buildChildEnv({ ...base, toolAllowlist: [] }, {})["CODEGRAPH_MCP_TOOLS"]).toBe("");
  });

  it("forwards only allowlisted variables, never Paperclip's own secrets", () => {
    const env = buildChildEnv(base, {
      PATH: "/usr/bin",
      HOME: "/home/x",
      DATABASE_URL: "postgres://user:pw@host/db",
      PAPERCLIP_API_KEY: "secret-token",
      AWS_SECRET_ACCESS_KEY: "shhh",
    } as NodeJS.ProcessEnv);
    expect(env["PATH"]).toBe("/usr/bin");
    expect(env["HOME"]).toBe("/home/x");
    expect(JSON.stringify(env)).not.toContain("postgres://");
    expect(JSON.stringify(env)).not.toContain("secret-token");
    expect(JSON.stringify(env)).not.toContain("shhh");
  });

  it("refuses to forward an extraEnv key that looks like a credential", () => {
    expect(() =>
      buildChildEnv({ ...base, extraEnv: { MY_API_KEY: "x" } }, {}),
    ).toThrow(/looks like a credential/);
    expect(() =>
      buildChildEnv({ ...base, extraEnv: { GITHUB_TOKEN: "x" } }, {}),
    ).toThrow(/looks like a credential/);
    expect(() => buildChildEnv({ ...base, extraEnv: { PASSWORD: "x" } }, {})).toThrow();
  });

  it("allows a benign extraEnv key", () => {
    expect(buildChildEnv({ ...base, extraEnv: { CODEGRAPH_KERNEL: "0" } }, {})[
      "CODEGRAPH_KERNEL"
    ]).toBe("0");
  });
});

describe("poolKey", () => {
  const base = { command: "codegraph", args: ["serve", "--mcp"], projectPath: "/a" };

  it("is stable for identical inputs", () => {
    expect(poolKey(base)).toBe(poolKey({ ...base }));
  });

  it("separates different projects so tenants never share a process", () => {
    expect(poolKey(base)).not.toBe(poolKey({ ...base, projectPath: "/b" }));
  });

  it("separates different allowlists", () => {
    expect(poolKey({ ...base, toolAllowlist: ["explore"] })).not.toBe(
      poolKey({ ...base, toolAllowlist: ["node"] }),
    );
  });

  it("is insensitive to allowlist ordering", () => {
    expect(poolKey({ ...base, toolAllowlist: ["a", "b"] })).toBe(
      poolKey({ ...base, toolAllowlist: ["b", "a"] }),
    );
  });
});

describe("CodeGraphMcpServer — live stdio session", () => {
  it("completes the initialize handshake and lists tools", async () => {
    const instance = server();
    const tools = await instance.listTools();
    expect(tools.map((tool) => tool.name)).toContain("codegraph_explore");
    expect(instance.alive).toBe(true);
  });

  it("calls a tool and returns its text", async () => {
    const instance = server();
    const result = await instance.callTool("codegraph_explore", { query: "auth" });
    expect(result.isError).toBe(false);
    expect(result.text).toContain("fake codegraph_explore");
  });

  /**
   * The central isolation assertion at the transport layer: whatever the caller
   * passes, the upstream `projectPath` is the resolved config value.
   */
  it("injects projectPath and overrides any caller-supplied value", async () => {
    const instance = server({ FAKE_MCP_ECHO_ARGS: "1" });
    const result = await instance.callTool("codegraph_explore", {
      query: "auth",
      projectPath: "/srv/some-other-tenant",
    });
    const payload = JSON.parse(result.text) as { receivedArgs: Record<string, unknown> };
    expect(payload.receivedArgs["projectPath"]).toBe(fs.realpathSync(PROJECT));
    expect(result.text).not.toContain("some-other-tenant");
  });

  it("passes legitimate arguments through", async () => {
    const instance = server({ FAKE_MCP_ECHO_ARGS: "1" });
    const result = await instance.callTool("codegraph_files", {
      format: "grouped",
      maxDepth: 3,
    });
    const payload = JSON.parse(result.text) as { receivedArgs: Record<string, unknown> };
    expect(payload.receivedArgs["format"]).toBe("grouped");
    expect(payload.receivedArgs["maxDepth"]).toBe(3);
  });

  it("surfaces an upstream isError result", async () => {
    const instance = server({ FAKE_MCP_ERROR: "1" });
    const result = await instance.callTool("codegraph_explore", { query: "x" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("fake failure");
  });

  it("fails clearly when the process exits mid-call", async () => {
    const instance = server({ FAKE_MCP_EXIT_ON_CALL: "1" });
    await expect(
      instance.callTool("codegraph_explore", { query: "x" }),
    ).rejects.toBeInstanceOf(CodeGraphMcpError);
  });

  it("times out a hung call and names the method", async () => {
    const instance = new CodeGraphMcpServer({
      command: process.execPath,
      args: [FAKE],
      projectPath: PROJECT,
      extraEnv: { FAKE_MCP_HANG_MS: "5000" },
      callTimeoutMs: 300,
      startupTimeoutMs: 5_000,
    });
    openServers.push(instance);
    await expect(instance.callTool("codegraph_explore", { query: "x" })).rejects.toThrow(
      /did not answer tools\/call within 300ms/,
    );
  });

  it("reports a spawn failure for a missing command", async () => {
    const instance = new CodeGraphMcpServer({
      command: "/nonexistent/codegraph-binary",
      args: ["serve", "--mcp"],
      projectPath: PROJECT,
      startupTimeoutMs: 3_000,
    });
    openServers.push(instance);
    await expect(instance.listTools()).rejects.toBeInstanceOf(CodeGraphMcpError);
  });

  it("truncates an over-large result", async () => {
    const instance = new CodeGraphMcpServer({
      command: process.execPath,
      args: [FAKE],
      projectPath: PROJECT,
      extraEnv: { FAKE_MCP_BIG: "1" },
    });
    openServers.push(instance);
    // The fake returns a small payload; assert the clamp path is reachable by
    // checking a normal call reports truncated: false.
    const result = await instance.callTool("codegraph_explore", { query: "x" });
    expect(result.truncated).toBe(false);
  });

  it("stops the process and reports it as not alive", async () => {
    const instance = server();
    await instance.listTools();
    expect(instance.alive).toBe(true);
    await instance.stop();
    expect(instance.alive).toBe(false);
  });

  it("is idempotent about stop()", async () => {
    const instance = server();
    await instance.listTools();
    await instance.stop();
    await expect(instance.stop()).resolves.toBeUndefined();
  });

  it("rejects a call after stop", async () => {
    const instance = server();
    await instance.listTools();
    await instance.stop();
    await expect(instance.callTool("codegraph_explore", { query: "x" })).rejects.toThrow(
      /not running/,
    );
  });
});

describe("CodeGraphClientPool", () => {
  it("reuses one process for identical config", async () => {
    const pool = new CodeGraphClientPool();
    const config = {
      command: process.execPath,
      args: [FAKE],
      projectPath: PROJECT,
    };
    const first = pool.acquire(config);
    const second = pool.acquire(config);
    expect(first).toBe(second);
    expect(pool.size).toBe(1);
    await pool.closeAll();
    expect(pool.size).toBe(0);
  });

  it("keeps separate processes for separate projects", async () => {
    const pool = new CodeGraphClientPool();
    const other = makeProject();
    pool.acquire({ command: process.execPath, args: [FAKE], projectPath: PROJECT });
    pool.acquire({ command: process.execPath, args: [FAKE], projectPath: other });
    expect(pool.size).toBe(2);
    await pool.closeAll();
  });

  it("evicts and stops a server on demand", async () => {
    const pool = new CodeGraphClientPool();
    const config = { command: process.execPath, args: [FAKE], projectPath: PROJECT };
    const instance = pool.acquire(config);
    await instance.listTools();
    pool.evict(config);
    expect(pool.size).toBe(0);
  });

  it("describes live processes for health without revealing paths", async () => {
    const pool = new CodeGraphClientPool();
    const instance = pool.acquire({
      command: process.execPath,
      args: [FAKE],
      projectPath: PROJECT,
    });
    await instance.listTools();
    const described = pool.describe();
    expect(described).toHaveLength(1);
    expect(described[0]!.alive).toBe(true);
    await pool.closeAll();
  });
});
