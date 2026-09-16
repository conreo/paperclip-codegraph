/**
 * Plugin configuration.
 *
 * Two independent layers, on purpose:
 *
 *   - **Instance config** (`instanceConfigSchema`) — how to launch CodeGraph and
 *     the safety envelope: command, args, timeouts, allowed roots, whether
 *     telemetry is allowed. Operator-owned, set once per Paperclip instance.
 *   - **Governance document** (`ctx.state`) — *which* codebase each
 *     company/project/agent may read. Organization-owned, changed often.
 *
 * Keeping them apart means a routine governance change never requires touching
 * the process-launch envelope, and vice versa.
 *
 * Everything is normalized here into {@link RuntimeConfig} with defaults applied,
 * so no other module has to reason about a missing key.
 */

import {
  DEFAULT_CALL_TIMEOUT_MS,
  DEFAULT_INDEX_TIMEOUT_MS,
  DEFAULT_MCP_ARGS,
  DEFAULT_MCP_COMMAND,
  DEFAULT_STARTUP_TIMEOUT_MS,
  MAX_ARG_STRING_CHARS,
  MAX_ARRAY_ITEMS,
  MAX_RESULT_CHARS,
} from "./constants.js";

/**
 * JSON Schema for the operator's instance config.
 *
 * `enabled` defaults to `false`: installing this plugin must not, by itself,
 * change what any agent can do. An admin turns it on deliberately.
 */
export const INSTANCE_CONFIG_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    // ---------------------------------------------------------------------
    // The five an operator actually sets, in the order they should read them.
    //
    // Everything else this plugin understands is a code default. The server
    // validates saved config with Ajv against THIS object and `properties` is
    // closed, so a key omitted here is not settable at all — which is the
    // point: `startupTimeoutMs`, `extraEnv`, `useDaemon` and friends are
    // internal tuning, and exposing them turned a five-decision page into a
    // seventeen-field wall of prose.
    //
    // `title` is the label; `description` is the supporting line. Both are kept
    // short, because some renderers show the description in place of the label.
    // ---------------------------------------------------------------------
    enabled: {
      type: "boolean",
      title: "Enable CodeGraph",
      description:
        "Turn CodeGraph tools on for this company. While off, every CodeGraph call is denied.",
      default: false,
    },
    autoInstall: {
      type: "boolean",
      title: "Install CodeGraph automatically",
      description:
        "Install CodeGraph on the server if it is missing. Off: you must install it yourself.",
      default: false,
    },
    autoIndex: {
      type: "boolean",
      title: "Build the index automatically",
      description:
        "Index a repository the first time it is queried. Off: run `codegraph init` yourself.",
      default: false,
    },
    allowedProjectRoots: {
      type: "array",
      items: { type: "string" },
      title: "Allowed repository directories",
      description:
        "Repositories must live under one of these directories. Recommended whenever more than one company uses this instance.",
      default: [],
    },
    codegraphCommand: {
      type: "string",
      title: "CodeGraph executable",
      description:
        'The CodeGraph command to run. Set an absolute path if it is not on the server PATH. Default "codegraph".',
      default: DEFAULT_MCP_COMMAND,
    },
  },
};

/**
 * The full runtime surface, including the keys deliberately kept out of
 * {@link INSTANCE_CONFIG_SCHEMA}.
 *
 * These are not "unimplemented" — they are settable in code and exercised by
 * tests, but an operator cannot reach them, so they always take the defaults in
 * {@link DEFAULT_RUNTIME_CONFIG}. Re-exposing one is a one-line schema change
 * plus a note here saying why it is worth a field on the page.
 */
export interface RuntimeConfig {
  enabled: boolean;
  codegraphCommand: string;
  codegraphArgs: string[];
  defaultProjectPath: string | null;
  bindDefaultProjectForUnconfiguredCompanies: boolean;
  allowedProjectRoots: string[];
  autoInstall: boolean;
  codegraphVersion: string;
  autoIndex: boolean;
  allowTelemetry: boolean;
  useDaemon: boolean;
  callTimeoutMs: number;
  indexTimeoutMs: number;
  startupTimeoutMs: number;
  maxResultChars: number;
  extraEnv: Record<string, string>;
  auditProjectPaths: boolean;
}

export const DEFAULT_RUNTIME_CONFIG: RuntimeConfig = {
  enabled: false,
  codegraphCommand: DEFAULT_MCP_COMMAND,
  codegraphArgs: [...DEFAULT_MCP_ARGS],
  defaultProjectPath: null,
  bindDefaultProjectForUnconfiguredCompanies: false,
  allowedProjectRoots: [],
  autoInstall: false,
  codegraphVersion: "1.6.0",
  autoIndex: false,
  allowTelemetry: false,
  useDaemon: false,
  callTimeoutMs: DEFAULT_CALL_TIMEOUT_MS,
  indexTimeoutMs: DEFAULT_INDEX_TIMEOUT_MS,
  startupTimeoutMs: DEFAULT_STARTUP_TIMEOUT_MS,
  maxResultChars: MAX_RESULT_CHARS,
  extraEnv: {},
  auditProjectPaths: false,
};

export class ConfigError extends Error {
  constructor(
    message: string,
    readonly field: string,
  ) {
    super(`${field}: ${message}`);
    this.name = "ConfigError";
  }
}

function readBool(
  raw: Record<string, unknown>,
  key: keyof RuntimeConfig,
  fallback: boolean,
): boolean {
  const value = raw[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") {
    throw new ConfigError("must be a boolean", key);
  }
  return value;
}

function readNumber(
  raw: Record<string, unknown>,
  key: keyof RuntimeConfig,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = raw[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ConfigError("must be a finite number", key);
  }
  if (value < min || value > max) {
    throw new ConfigError(`must be between ${min} and ${max}`, key);
  }
  return Math.floor(value);
}

function readString(
  raw: Record<string, unknown>,
  key: keyof RuntimeConfig,
  fallback: string,
  maxLength = MAX_ARG_STRING_CHARS,
): string {
  const value = raw[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ConfigError("must be a non-empty string", key);
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw new ConfigError(`must be at most ${maxLength} characters`, key);
  }
  return trimmed;
}

function readStringArray(
  raw: Record<string, unknown>,
  key: keyof RuntimeConfig,
): string[] {
  const value = raw[key];
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new ConfigError("must be an array of strings", key);
  }
  if (value.length > MAX_ARRAY_ITEMS) {
    throw new ConfigError(`must hold at most ${MAX_ARRAY_ITEMS} entries`, key);
  }
  return value.map((entry, index) => {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new ConfigError(`entry ${index} must be a non-empty string`, key);
    }
    if (entry.length > MAX_ARG_STRING_CHARS) {
      throw new ConfigError(`entry ${index} is too long`, key);
    }
    return entry.trim();
  });
}

/**
 * Normalize raw host config into {@link RuntimeConfig}.
 *
 * Throws {@link ConfigError} naming the offending field. The caller surfaces
 * that to the operator rather than starting a half-configured plugin: a config
 * that cannot be understood is a config that must not grant access.
 */
export function normalizeConfig(input: unknown): RuntimeConfig {
  if (input === undefined || input === null) return { ...DEFAULT_RUNTIME_CONFIG };
  if (typeof input !== "object" || Array.isArray(input)) {
    throw new ConfigError("must be an object", "$");
  }
  const raw = input as Record<string, unknown>;

  const extraEnvRaw = raw["extraEnv"];
  let extraEnv: Record<string, string> = {};
  if (extraEnvRaw !== undefined && extraEnvRaw !== null) {
    if (typeof extraEnvRaw !== "object" || Array.isArray(extraEnvRaw)) {
      throw new ConfigError("must be an object of strings", "extraEnv");
    }
    for (const [key, value] of Object.entries(extraEnvRaw)) {
      if (typeof value !== "string") {
        throw new ConfigError(`value for "${key}" must be a string`, "extraEnv");
      }
      extraEnv[key] = value;
    }
  }

  const defaultProjectPathRaw = raw["defaultProjectPath"];
  if (
    defaultProjectPathRaw !== undefined &&
    defaultProjectPathRaw !== null &&
    (typeof defaultProjectPathRaw !== "string" ||
      defaultProjectPathRaw.trim().length === 0)
  ) {
    throw new ConfigError("must be a non-empty string when set", "defaultProjectPath");
  }

  const config: RuntimeConfig = {
    enabled: readBool(raw, "enabled", DEFAULT_RUNTIME_CONFIG.enabled),
    codegraphCommand: readString(
      raw,
      "codegraphCommand",
      DEFAULT_RUNTIME_CONFIG.codegraphCommand,
      1_000,
    ),
    codegraphArgs:
      raw["codegraphArgs"] === undefined
        ? [...DEFAULT_MCP_ARGS]
        : readStringArray(raw, "codegraphArgs"),
    defaultProjectPath:
      typeof defaultProjectPathRaw === "string"
        ? defaultProjectPathRaw.trim()
        : null,
    bindDefaultProjectForUnconfiguredCompanies: readBool(
      raw,
      "bindDefaultProjectForUnconfiguredCompanies",
      DEFAULT_RUNTIME_CONFIG.bindDefaultProjectForUnconfiguredCompanies,
    ),
    allowedProjectRoots: readStringArray(raw, "allowedProjectRoots"),
    autoInstall: readBool(raw, "autoInstall", DEFAULT_RUNTIME_CONFIG.autoInstall),
    codegraphVersion: readString(
      raw,
      "codegraphVersion",
      DEFAULT_RUNTIME_CONFIG.codegraphVersion,
      100,
    ),
    autoIndex: readBool(raw, "autoIndex", DEFAULT_RUNTIME_CONFIG.autoIndex),
    allowTelemetry: readBool(
      raw,
      "allowTelemetry",
      DEFAULT_RUNTIME_CONFIG.allowTelemetry,
    ),
    useDaemon: readBool(raw, "useDaemon", DEFAULT_RUNTIME_CONFIG.useDaemon),
    callTimeoutMs: readNumber(
      raw,
      "callTimeoutMs",
      DEFAULT_RUNTIME_CONFIG.callTimeoutMs,
      1_000,
      900_000,
    ),
    indexTimeoutMs: readNumber(
      raw,
      "indexTimeoutMs",
      DEFAULT_RUNTIME_CONFIG.indexTimeoutMs,
      1_000,
      7_200_000,
    ),
    startupTimeoutMs: readNumber(
      raw,
      "startupTimeoutMs",
      DEFAULT_RUNTIME_CONFIG.startupTimeoutMs,
      1_000,
      300_000,
    ),
    maxResultChars: readNumber(
      raw,
      "maxResultChars",
      DEFAULT_RUNTIME_CONFIG.maxResultChars,
      1_000,
      4_000_000,
    ),
    extraEnv,
    auditProjectPaths: readBool(
      raw,
      "auditProjectPaths",
      DEFAULT_RUNTIME_CONFIG.auditProjectPaths,
    ),
  };

  if (config.codegraphArgs.length === 0) {
    throw new ConfigError("must not be empty", "codegraphArgs");
  }
  if (config.codegraphArgs.length > MAX_ARRAY_ITEMS) {
    throw new ConfigError(`must hold at most ${MAX_ARRAY_ITEMS} entries`, "codegraphArgs");
  }

  return config;
}
