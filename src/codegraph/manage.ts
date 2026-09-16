/**
 * CodeGraph CLI lifecycle: detect the binary, optionally install it, optionally
 * build an index.
 *
 * All three are opt-in. Indexing is not a read: it walks the repository, parses
 * every supported file, and writes a SQLite database, so it is CPU- and
 * disk-intensive and must never happen implicitly on an agent's first call
 * unless an operator asked for it.
 *
 * Commands are always run as `execFile(command, argsArray)` — never through a
 * shell — so a project path or config value can never be reinterpreted as shell
 * syntax. Paths arrive here already validated by `governance/sanitize.ts`.
 */

import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CODEGRAPH_INDEX_DIR } from "../constants.js";

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface ManagedProcessEnv {
  /** Environment for the child. Reuse the MCP env so telemetry stays off. */
  env: Record<string, string>;
}

/** Run one executable with an argument array, never a shell. */
export function runCommand(
  command: string,
  args: readonly string[],
  options: {
    timeoutMs: number;
    cwd?: string;
    env?: Record<string, string>;
    maxBuffer?: number;
  },
): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(
      command,
      [...args],
      {
        cwd: options.cwd,
        env: options.env ? { ...options.env, PATH: options.env["PATH"] ?? "" } : undefined,
        timeout: options.timeoutMs,
        maxBuffer: options.maxBuffer ?? 8 * 1024 * 1024,
        windowsHide: true,
        shell: false,
      },
      (error, stdout, stderr) => {
        const result: CommandResult = {
          code: 0,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
          timedOut: false,
        };
        if (error) {
          const candidate = error as NodeJS.ErrnoException & {
            code?: string | number;
            killed?: boolean;
          };
          result.timedOut = candidate.killed === true;
          result.code = typeof candidate.code === "number" ? candidate.code : 1;
          if (candidate.code === "ENOENT") result.code = 127;
        }
        resolve(result);
      },
    );
  });
}

/**
 * Directories to search in addition to `PATH`.
 *
 * A long-lived Paperclip service is often started by a supervisor with a
 * minimal environment that does not include the per-user npm prefix, so a
 * `codegraph` the operator can plainly run in their own shell is invisible to
 * the plugin worker. Searching the conventional install locations makes the
 * default configuration work without the operator having to hard-code an
 * absolute path.
 */
function fallbackBinDirs(): string[] {
  if (process.platform === "win32") {
    return [
      process.env["APPDATA"] ? path.join(process.env["APPDATA"], "npm") : "",
      process.env["LOCALAPPDATA"] ? path.join(process.env["LOCALAPPDATA"], "npm") : "",
    ].filter((entry) => entry.length > 0);
  }
  const home = os.homedir();
  const dirs = [
    process.env["npm_config_prefix"] ? path.join(process.env["npm_config_prefix"], "bin") : "",
    path.join(home, ".npm-global", "bin"),
    path.join(home, ".local", "bin"),
    path.join(home, ".bun", "bin"),
    "/usr/local/bin",
    "/usr/bin",
    "/opt/homebrew/bin",
    // CodeGraph's own installer target.
    path.join(home, ".codegraph", "current", "bin"),
  ];
  return dirs.filter((entry) => entry.length > 0);
}

function executableExtensions(): string[] {
  return process.platform === "win32"
    ? (process.env["PATHEXT"] ?? ".EXE;.CMD;.BAT").split(";")
    : [""];
}

async function isExecutable(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate, fsConstants.X_OK);
    const stats = await fs.stat(candidate);
    return stats.isFile();
  } catch {
    return false;
  }
}

/**
 * Resolve `command` to an absolute executable path, or null.
 *
 * An explicit path is only checked, never searched for: an operator who wrote a
 * path means that path. A bare name is searched on `PATH` first, then in
 * {@link fallbackBinDirs}.
 */
export async function resolveCommand(command: string): Promise<string | null> {
  const extensions = executableExtensions();

  if (command.includes("/") || command.includes("\\") || path.isAbsolute(command)) {
    for (const extension of extensions) {
      if (await isExecutable(`${command}${extension}`)) return `${command}${extension}`;
    }
    return null;
  }

  const separator = process.platform === "win32" ? ";" : ":";
  const searchDirs = [
    ...(process.env["PATH"] ?? "").split(separator),
    ...fallbackBinDirs(),
  ];

  for (const dir of searchDirs) {
    if (dir.trim().length === 0) continue;
    for (const extension of extensions) {
      const candidate = path.join(dir, `${command}${extension}`);
      if (await isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

/** True when `command` resolves to an executable file. */
export async function commandExists(command: string): Promise<boolean> {
  return (await resolveCommand(command)) !== null;
}

export interface EnsureBinaryResult {
  ok: boolean;
  command: string;
  /** Absolute path actually used, when one could be resolved. */
  resolvedPath: string | null;
  version: string | null;
  installed: boolean;
  detail: string;
}

/**
 * Ensure the CodeGraph CLI is available.
 *
 * `autoInstall` installs the pinned npm package globally. We deliberately do
 * NOT pipe the upstream `install.sh` into a shell: that would execute a remote
 * script fetched at call time with no version pin and no integrity check. A
 * version-pinned `npm install -g` is reproducible and auditable.
 */
export async function ensureBinary(options: {
  command: string;
  autoInstall: boolean;
  version: string;
  timeoutMs: number;
  env: Record<string, string>;
}): Promise<EnsureBinaryResult> {
  const resolved = await resolveCommand(options.command);

  const probe = async (binary: string): Promise<string | null> => {
    const result = await runCommand(binary, ["--version"], {
      timeoutMs: Math.min(options.timeoutMs, 30_000),
      env: options.env,
    });
    if (result.code !== 0) return null;
    const version = result.stdout.trim().split("\n")[0]?.trim() ?? "";
    return version.length > 0 ? version : null;
  };

  const existing = resolved ? await probe(resolved) : null;
  if (existing) {
    return {
      ok: true,
      command: options.command,
      resolvedPath: resolved,
      version: existing,
      installed: false,
      detail: `Found ${options.command} ${existing} at ${resolved}`,
    };
  }

  if (!options.autoInstall) {
    return {
      ok: false,
      command: options.command,
      resolvedPath: null,
      version: null,
      installed: false,
      detail:
        `CodeGraph command "${options.command}" was not found on PATH or in the usual install locations ` +
        `(${fallbackBinDirs().slice(0, 3).join(", ")}, ...). ` +
        "Install it (`npm install -g @colbymchenry/codegraph`), set codegraphCommand to an absolute path, " +
        "or enable autoInstall in the plugin config.",
    };
  }

  const install = await runCommand(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["install", "-g", `@colbymchenry/codegraph@${options.version}`],
    { timeoutMs: Math.max(options.timeoutMs, 300_000), env: options.env },
  );

  if (install.code !== 0) {
    return {
      ok: false,
      command: options.command,
      resolvedPath: null,
      version: null,
      installed: false,
      detail: `npm install -g failed (exit ${install.code}): ${install.stderr.slice(-500)}`,
    };
  }

  const afterResolve = await resolveCommand(options.command);
  const afterInstall = afterResolve ? await probe(afterResolve) : null;
  return {
    ok: afterInstall !== null,
    command: options.command,
    resolvedPath: afterResolve,
    version: afterInstall,
    installed: afterInstall !== null,
    detail:
      afterInstall !== null
        ? `Installed ${options.command} ${afterInstall}`
        : "Installed the package but the command still does not resolve; check the global npm bin directory is on PATH.",
  };
}

/** Whether a project has a usable CodeGraph index. */
export async function isIndexed(projectPath: string): Promise<boolean> {
  const dir = path.join(projectPath, CODEGRAPH_INDEX_DIR);
  try {
    const stats = await fs.stat(dir);
    if (!stats.isDirectory()) return false;
    // Upstream's `isInitialized` requires the database file too, not just the
    // directory (a `.codegraph/` left behind by `uninit` must not count).
    await fs.access(path.join(dir, "codegraph.db"), fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export interface EnsureIndexResult {
  ok: boolean;
  indexed: boolean;
  created: boolean;
  detail: string;
  stdout: string;
}

/**
 * Ensure a project is indexed, running `codegraph init <path>` when allowed.
 *
 * Upstream `init` creates `.codegraph/` AND builds the initial index in one
 * step; `--index` is a deprecated no-op. We pass `--yes` so the non-interactive
 * child never blocks on a prompt, and never pass `--force`: a path upstream
 * considers unsafe (home directory, filesystem root) should fail rather than be
 * overridden from inside an agent run.
 */
export async function ensureIndex(options: {
  projectPath: string;
  autoIndex: boolean;
  command: string;
  timeoutMs: number;
  env: Record<string, string>;
}): Promise<EnsureIndexResult> {
  if (await isIndexed(options.projectPath)) {
    return {
      ok: true,
      indexed: true,
      created: false,
      detail: "Project already has a .codegraph index",
      stdout: "",
    };
  }

  if (!options.autoIndex) {
    return {
      ok: false,
      indexed: false,
      created: false,
      detail:
        `Project ${options.projectPath} has no .codegraph index. ` +
        `Run \`codegraph init\` in it, or enable autoIndex in the plugin config.`,
      stdout: "",
    };
  }

  const result = await runCommand(options.command, ["init", options.projectPath, "--yes"], {
    timeoutMs: options.timeoutMs,
    cwd: options.projectPath,
    env: options.env,
  });

  const indexed = await isIndexed(options.projectPath);
  return {
    ok: result.code === 0 && indexed,
    indexed,
    created: indexed,
    detail:
      result.code === 0
        ? indexed
          ? "Built the CodeGraph index"
          : "codegraph init exited 0 but no index appeared"
        : result.timedOut
          ? `codegraph init timed out after ${options.timeoutMs}ms`
          : `codegraph init failed (exit ${result.code}): ${result.stderr.slice(-500)}`,
    stdout: result.stdout.slice(-2_000),
  };
}

export interface RebuildResult {
  ok: boolean;
  detail: string;
  stdout: string;
}

/**
 * Full re-index: `codegraph index <path>`.
 *
 * Upstream's `index` is a *rebuild from scratch* — it recreates the database
 * rather than syncing — which is why this is a separate, explicitly-requested
 * operation and not something a query path ever triggers. An operator presses a
 * button; an agent does not.
 */
export async function rebuildIndex(options: {
  projectPath: string;
  command: string;
  timeoutMs: number;
  env: Record<string, string>;
}): Promise<RebuildResult> {
  const result = await runCommand(options.command, ["index", options.projectPath], {
    timeoutMs: options.timeoutMs,
    cwd: options.projectPath,
    env: options.env,
  });
  const indexed = await isIndexed(options.projectPath);
  return {
    ok: result.code === 0 && indexed,
    detail:
      result.code === 0
        ? indexed
          ? "Rebuilt the CodeGraph index"
          : "codegraph index exited 0 but no index appeared"
        : result.timedOut
          ? `codegraph index timed out after ${options.timeoutMs}ms`
          : `codegraph index failed (exit ${result.code}): ${result.stderr.slice(-500)}`,
    stdout: result.stdout.slice(-2_000),
  };
}

/** `codegraph status <path> --json`, parsed when possible. */
export async function indexStatus(options: {
  projectPath: string;
  command: string;
  timeoutMs: number;
  env: Record<string, string>;
}): Promise<{ ok: boolean; raw: string; parsed: unknown }> {
  const result = await runCommand(
    options.command,
    ["status", options.projectPath, "--json"],
    { timeoutMs: options.timeoutMs, cwd: options.projectPath, env: options.env },
  );
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    parsed = null;
  }
  return {
    ok: result.code === 0 && parsed !== null,
    raw: (result.stdout || result.stderr).slice(-4_000),
    parsed,
  };
}
