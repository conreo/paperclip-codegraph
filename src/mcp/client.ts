/**
 * A pooled MCP client for CodeGraph's stdio server.
 *
 * Design notes that matter for a multi-tenant control plane:
 *
 * 1. **One server process per (command, args, project, tool-allowlist) key.**
 *    CodeGraph keeps a per-process project cache and a per-process tool
 *    allowlist (`CODEGRAPH_MCP_TOOLS`), so two companies with different
 *    allowlists must not share a process.
 * 2. **The project path is injected here, never accepted from the agent.**
 *    Callers pass a resolved path that already passed governance; this module
 *    only appends it as the upstream `projectPath` argument.
 * 3. **The child gets a minimal environment.** Paperclip's server process holds
 *    database URLs and API tokens; none of that is CodeGraph's business. We pass
 *    a small allowlist of benign variables plus our own `CODEGRAPH_*` flags and
 *    refuse anything that looks like a credential.
 * 4. **Process-group kill.** The `codegraph` npm shim runs the real bundled Node
 *    binary through `child_process.spawnSync(..., { stdio: "inherit" })`, so the
 *    shim blocks and a signal sent only to the shim's PID would orphan the
 *    server. We spawn detached and kill the whole group.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  DEFAULT_CALL_TIMEOUT_MS,
  DEFAULT_STARTUP_TIMEOUT_MS,
  MAX_RESULT_CHARS,
  UPSTREAM_PROJECT_PATH_PARAM,
} from "../constants.js";
import {
  LineDelimitedJsonDecoder,
  MCP_PROTOCOL_VERSION,
  encodeMessage,
  extractText,
  isFailure,
  isResponse,
  type JsonRpcRequest,
  type McpToolCallResult,
  type McpToolDescriptor,
} from "./protocol.js";

/** Environment variables safe to forward to a CodeGraph child process. */
const ENV_PASSTHROUGH = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "USER",
  "SHELL",
  "SystemRoot",
  "APPDATA",
  "LOCALAPPDATA",
] as const;

/** Substrings that disqualify an environment key from being forwarded. */
const SECRET_KEY_PATTERN =
  /(secret|token|password|passwd|credential|api[_-]?key|private[_-]?key|database[_-]?url|dsn|auth)/i;

export interface McpServerConfig {
  command: string;
  args: readonly string[];
  /** Absolute, governance-resolved project path. */
  projectPath: string;
  /** Optional upstream tool allowlist, applied via `CODEGRAPH_MCP_TOOLS`. */
  toolAllowlist?: readonly string[];
  /** Extra environment entries from operator config (validated, values never logged). */
  extraEnv?: Readonly<Record<string, string>>;
  /** When false (the default) telemetry and update checks are hard-disabled. */
  allowTelemetry?: boolean;
  /** Opt in to CodeGraph's shared background daemon. Default: direct mode. */
  useDaemon?: boolean;
  callTimeoutMs?: number;
  startupTimeoutMs?: number;
}

/** Stable identity for a pooled server process. */
export function poolKey(config: McpServerConfig): string {
  return JSON.stringify({
    command: config.command,
    args: [...config.args],
    projectPath: config.projectPath,
    toolAllowlist: [...(config.toolAllowlist ?? [])].sort(),
    allowTelemetry: config.allowTelemetry === true,
    useDaemon: config.useDaemon === true,
    extraEnvKeys: Object.keys(config.extraEnv ?? {}).sort(),
  });
}

/**
 * Build the child environment.
 *
 * Deliberately allowlist-first: an unknown variable is dropped, not forwarded.
 * `DO_NOT_TRACK` / `CODEGRAPH_TELEMETRY` / `CODEGRAPH_NO_UPDATE_CHECK` are the
 * three switches upstream documents for keeping CodeGraph local-only, so a
 * default-configured plugin cannot phone home.
 */
export function buildChildEnv(
  config: McpServerConfig,
  baseEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};

  for (const key of ENV_PASSTHROUGH) {
    const value = baseEnv[key];
    if (typeof value === "string" && value.length > 0) env[key] = value;
  }

  for (const [key, value] of Object.entries(config.extraEnv ?? {})) {
    if (SECRET_KEY_PATTERN.test(key)) {
      throw new Error(
        `Refusing to forward environment variable "${key}" to CodeGraph: its name looks like a credential. ` +
          "CodeGraph is local-only and needs no credentials.",
      );
    }
    env[key] = value;
  }

  // Upstream's default surface is `codegraph_explore` ALONE
  // (`DEFAULT_MCP_TOOLS = new Set(['explore'])` in `dist/mcp/tools.js`); the
  // other seven stay callable but unlisted. We therefore always set the
  // allowlist explicitly:
  //
  //   - leaving it unset would advertise only one tool, and
  //   - setting it to the governance-resolved set makes CodeGraph itself refuse
  //     a denied tool, so enforcement does not rest on this plugin's code alone.
  //
  // Upstream matches on the short form, so "node" and "codegraph_node" both work.
  env["CODEGRAPH_MCP_TOOLS"] = (config.toolAllowlist ?? [])
    .map((name) => name.replace(/^codegraph_/, ""))
    .join(",");

  if (config.allowTelemetry !== true) {
    // DO_NOT_TRACK also suppresses the GitHub release update-check that the MCP
    // server otherwise fires at startup, and CODEGRAPH_NO_DOWNLOAD stops the npm
    // shim's self-heal download from GitHub Releases. Together with the two
    // explicit flags this makes a default-configured plugin egress-free.
    env["DO_NOT_TRACK"] = "1";
    env["CODEGRAPH_TELEMETRY"] = "0";
    env["CODEGRAPH_NO_UPDATE_CHECK"] = "1";
    env["CODEGRAPH_NO_DOWNLOAD"] = "1";
  }

  if (config.useDaemon !== true) {
    env["CODEGRAPH_NO_DAEMON"] = "1";
  }

  return env;
}

export class CodeGraphMcpError extends Error {
  constructor(
    message: string,
    readonly reason:
      | "spawn_failed"
      | "startup_timeout"
      | "call_timeout"
      | "server_error"
      | "process_exited"
      | "not_initialized",
  ) {
    super(message);
    this.name = "CodeGraphMcpError";
  }
}

interface PendingCall {
  resolve: (value: McpToolCallResult) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class CodeGraphMcpServer {
  private child: ChildProcessWithoutNullStreams | null = null;
  private readonly decoder = new LineDelimitedJsonDecoder();
  private readonly pending = new Map<number | string, PendingCall>();
  private nextId = 1;
  private stderrTail = "";
  private exited = false;
  /** Set by `stop()`, so a deliberately shut-down server is never reused. */
  private stopped = false;
  private exitDescription: string | null = null;
  private initializePromise: Promise<void> | null = null;
  private readonly callTimeoutMs: number;
  private readonly startupTimeoutMs: number;
  private toolsCache: McpToolDescriptor[] | null = null;

  constructor(
    private readonly config: McpServerConfig,
    private readonly onStderr?: (chunk: string) => void,
  ) {
    this.callTimeoutMs = config.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    this.startupTimeoutMs = config.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  }

  /** True while the child is believed to be alive. */
  get alive(): boolean {
    return this.child !== null && !this.exited && !this.stopped;
  }

  /**
   * Whether this instance may serve another call.
   *
   * A pooled-but-not-yet-started server IS reusable — `acquire()` hands back an
   * instance before anything spawns, so keying reuse off `alive` alone would
   * leak a fresh process per call. Only a stopped or exited process disqualifies.
   */
  get reusable(): boolean {
    return !this.stopped && !this.exited;
  }

  /** Last diagnostics from stderr, for `onHealth`. Never contains secrets by construction. */
  get diagnostics(): { stderrTail: string; exitDescription: string | null } {
    return { stderrTail: this.stderrTail, exitDescription: this.exitDescription };
  }

  async start(): Promise<void> {
    if (this.initializePromise) return this.initializePromise;
    this.initializePromise = this.doStart();
    return this.initializePromise;
  }

  private async doStart(): Promise<void> {
    const env = buildChildEnv(this.config);

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(this.config.command, [...this.config.args], {
        cwd: this.config.projectPath,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        // Detach so the child leads its own process group and we can kill the
        // whole group; the shim's blocking spawnSync would otherwise survive us.
        detached: process.platform !== "win32",
      }) as ChildProcessWithoutNullStreams;
    } catch (error) {
      throw new CodeGraphMcpError(
        `Failed to spawn CodeGraph MCP server ("${this.config.command}"): ${
          error instanceof Error ? error.message : String(error)
        }`,
        "spawn_failed",
      );
    }

    this.child = child;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onStdout(chunk));

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      // Bounded ring so a chatty server cannot exhaust plugin memory.
      this.stderrTail = (this.stderrTail + chunk).slice(-4_000);
      this.onStderr?.(chunk);
    });

    child.on("error", (error) => {
      this.failAll(
        new CodeGraphMcpError(
          `CodeGraph MCP server error: ${error.message}`,
          "spawn_failed",
        ),
      );
    });

    child.on("exit", (code, signal) => {
      this.exited = true;
      this.exitDescription = `exited code=${code ?? "null"} signal=${signal ?? "null"}`;
      this.failAll(
        new CodeGraphMcpError(
          `CodeGraph MCP server ${this.exitDescription}. ${this.stderrTail.slice(-500)}`,
          "process_exited",
        ),
      );
    });

    await this.request(
      "initialize",
      {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "paperclip-codegraph", version: "0.1.0" },
      },
      this.startupTimeoutMs,
      "startup_timeout",
    );

    // Required by the MCP lifecycle; no response is expected.
    this.notify("notifications/initialized", {});
  }

  private onStdout(chunk: string): void {
    for (const value of this.decoder.push(chunk)) {
      if (!isResponse(value)) continue;
      const pending = this.pending.get(value.id);
      if (!pending) continue;
      this.pending.delete(value.id);
      clearTimeout(pending.timer);

      if (isFailure(value)) {
        pending.reject(
          new CodeGraphMcpError(
            `CodeGraph error ${value.error.code}: ${value.error.message}`,
            "server_error",
          ),
        );
        continue;
      }
      pending.resolve(value.result as McpToolCallResult);
    }
  }

  private failAll(error: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private notify(method: string, params: unknown): void {
    if (!this.alive || !this.child) return;
    this.child.stdin.write(encodeMessage({ jsonrpc: "2.0", method, params }));
  }

  private request(
    method: string,
    params: unknown,
    timeoutMs: number,
    timeoutReason: "startup_timeout" | "call_timeout",
  ): Promise<unknown> {
    if (!this.child || !this.alive) {
      return Promise.reject(
        new CodeGraphMcpError(
          `CodeGraph MCP server is not running (${this.exitDescription ?? "not started"})`,
          "not_initialized",
        ),
      );
    }

    const id = this.nextId++;
    const message: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new CodeGraphMcpError(
            `CodeGraph did not answer ${method} within ${timeoutMs}ms`,
            timeoutReason,
          ),
        );
      }, timeoutMs);
      // A pending call must never hold the worker's event loop open.
      timer.unref?.();

      this.pending.set(id, {
        resolve: resolve as (value: McpToolCallResult) => void,
        reject,
        timer,
      });

      this.child!.stdin.write(encodeMessage(message), (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        reject(
          new CodeGraphMcpError(
            `Failed to write to CodeGraph stdin: ${error.message}`,
            "spawn_failed",
          ),
        );
      });
    });
  }

  /** `tools/list`, cached per process because the surface is static per allowlist. */
  async listTools(force = false): Promise<McpToolDescriptor[]> {
    await this.start();
    if (this.toolsCache && !force) return this.toolsCache;
    const result = (await this.request(
      "tools/list",
      {},
      this.startupTimeoutMs,
      "startup_timeout",
    )) as { tools?: McpToolDescriptor[] };
    this.toolsCache = Array.isArray(result.tools) ? result.tools : [];
    return this.toolsCache;
  }

  /**
   * Call one tool.
   *
   * `projectPath` is force-set from the resolved config, overriding anything the
   * caller passed, so an agent-supplied value can never redirect the query.
   */
  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ text: string; isError: boolean; truncated: boolean }> {
    await this.start();

    const governedArgs: Record<string, unknown> = {
      ...args,
      [UPSTREAM_PROJECT_PATH_PARAM]: this.config.projectPath,
    };

    const result = await this.request(
      "tools/call",
      { name, arguments: governedArgs },
      this.callTimeoutMs,
      "call_timeout",
    );

    const payload = result as McpToolCallResult;
    let text = extractText(payload);
    let truncated = false;
    if (text.length > MAX_RESULT_CHARS) {
      text = `${text.slice(0, MAX_RESULT_CHARS)}\n\n[paperclip-codegraph: result truncated at ${MAX_RESULT_CHARS} characters]`;
      truncated = true;
    }

    return { text, isError: payload.isError === true, truncated };
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const child = this.child;
    if (!child) return;

    this.failAll(
      new CodeGraphMcpError("CodeGraph MCP server is shutting down", "process_exited"),
    );

    try {
      child.stdin.end();
    } catch {
      /* stdin may already be gone */
    }

    if (child.pid === undefined) {
      this.child = null;
      return;
    }

    const pid = child.pid;
    const signal = (name: NodeJS.Signals): void => {
      try {
        if (process.platform === "win32") {
          child.kill(name);
        } else {
          // Negative PID targets the detached process group, which is what
          // actually stops the bundled binary behind the npm shim.
          process.kill(-pid, name);
        }
      } catch {
        /* already dead */
      }
    };

    signal("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        signal("SIGKILL");
        resolve();
      }, 5_000);
      timer.unref?.();
      if (this.exited) {
        clearTimeout(timer);
        resolve();
        return;
      }
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });

    this.child = null;
  }
}

/**
 * Process pool.
 *
 * Keyed so two governance scopes never share a process unless every
 * process-level input matches. Idle processes are stopped by `closeAll()` from
 * the plugin's `onShutdown`, and reaped opportunistically when a call finds a
 * dead child.
 */
export class CodeGraphClientPool {
  private readonly servers = new Map<string, CodeGraphMcpServer>();

  get size(): number {
    return this.servers.size;
  }

  acquire(
    config: McpServerConfig,
    onStderr?: (chunk: string) => void,
  ): CodeGraphMcpServer {
    const key = poolKey(config);
    const existing = this.servers.get(key);
    if (existing && existing.reusable) return existing;
    if (existing) {
      this.servers.delete(key);
      void existing.stop().catch(() => undefined);
    }

    const server = new CodeGraphMcpServer(config, onStderr);
    this.servers.set(key, server);
    return server;
  }

  /** Drop a server whose process died so the next call respawns it. */
  evict(config: McpServerConfig): void {
    const key = poolKey(config);
    const server = this.servers.get(key);
    if (!server) return;
    this.servers.delete(key);
    void server.stop().catch(() => undefined);
  }

  async closeAll(): Promise<void> {
    const servers = [...this.servers.values()];
    this.servers.clear();
    await Promise.all(servers.map((server) => server.stop().catch(() => undefined)));
  }

  /** Diagnostics for `onHealth`: one entry per live process, paths omitted. */
  describe(): Array<{ key: string; alive: boolean; exit: string | null }> {
    return [...this.servers.entries()].map(([key, server]) => ({
      key,
      alive: server.alive,
      exit: server.diagnostics.exitDescription,
    }));
  }
}
