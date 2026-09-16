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

/**
 * The five fields the operator can set, as a typed view of the config document.
 *
 * `instanceConfigSchema` is closed (`additionalProperties: false`) and the server
 * validates writes against it with Ajv, so this is exactly the settable surface.
 */
export interface OperatorConfig {
  enabled: boolean;
  autoInstall: boolean;
  autoIndex: boolean;
  allowedProjectRoots: string[];
  codegraphCommand: string;
}

/** The schema defaults, which is what an unconfigured plugin behaves as. */
export const OPERATOR_CONFIG_DEFAULTS: OperatorConfig = {
  enabled: false,
  autoInstall: false,
  autoIndex: false,
  allowedProjectRoots: [],
  codegraphCommand: DEFAULT_MCP_COMMAND,
};

function operatorBool(raw: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = raw[key];
  return typeof value === "boolean" ? value : fallback;
}

/**
 * Read the operator's config out of a stored document.
 *
 * A missing or wrongly-typed key falls back to the schema default rather than
 * throwing: this feeds a settings form, and a form that refuses to open because
 * one key drifted is worse than a form showing the default.
 */
export function readOperatorConfig(raw: unknown): OperatorConfig {
  if (typeof raw !== "object" || raw === null) return { ...OPERATOR_CONFIG_DEFAULTS };
  const record = raw as Record<string, unknown>;

  const roots = Array.isArray(record["allowedProjectRoots"])
    ? record["allowedProjectRoots"].filter((entry): entry is string => typeof entry === "string")
    : [...OPERATOR_CONFIG_DEFAULTS.allowedProjectRoots];

  const command = record["codegraphCommand"];

  return {
    enabled: operatorBool(record, "enabled", OPERATOR_CONFIG_DEFAULTS.enabled),
    autoInstall: operatorBool(record, "autoInstall", OPERATOR_CONFIG_DEFAULTS.autoInstall),
    autoIndex: operatorBool(record, "autoIndex", OPERATOR_CONFIG_DEFAULTS.autoIndex),
    allowedProjectRoots: roots,
    codegraphCommand:
      typeof command === "string" && command.trim().length > 0
        ? command.trim()
        : OPERATOR_CONFIG_DEFAULTS.codegraphCommand,
  };
}

/** The property names `INSTANCE_CONFIG_SCHEMA` actually allows. */
export function settableConfigKeys(): string[] {
  const properties = (INSTANCE_CONFIG_SCHEMA as { properties?: Record<string, unknown> }).properties;
  return properties ? Object.keys(properties) : [];
}

export interface SavePayload {
  /** What to send: exactly the schema's properties, nothing else. */
  config: Record<string, unknown>;
  /** Stored keys this payload leaves out, for the operator to see. */
  droppedKeys: string[];
}

/**
 * Build the configuration to save.
 *
 * ## Why this does not merge the stored document wholesale
 *
 * The first version merged the stored document with the form and posted the
 * result, on the reasoning that a key the form does not show must not be dropped.
 * That is the right instinct for a governance document and the **wrong** one
 * here, because the server validates this payload with Ajv against
 * `instanceConfigSchema`, which is closed (`additionalProperties: false`):
 *
 *     Configuration does not match the plugin's instanceConfigSchema
 *
 * So every extra key is not preserved, it is a rejected request. An organisation
 * still carrying 0.6.0's seventeen-key document could not save settings at all —
 * the form appeared to fail for no visible reason. (Deterministic, too: it broke
 * on the orgs with a history and worked on the orgs without one.)
 *
 * The document an operator can edit is exactly the schema, so that is what this
 * returns. Keys outside the schema are reported in `droppedKeys` rather than
 * silently discarded, because one of them (`useDaemon`) has a real effect: it is
 * read by `normalizeConfig` and defaults to off, and the plugin warns that leaving
 * it on stops CodeGraph enforcing its own tool allowlist. Dropping it is the
 * behaviour the schema documents, and saying so is better than pretending it was
 * never there.
 */
export function operatorConfigForSave(
  stored: unknown,
  edits: Partial<OperatorConfig>,
): SavePayload {
  const record =
    typeof stored === "object" && stored !== null && !Array.isArray(stored)
      ? (stored as Record<string, unknown>)
      : {};

  const allowed = settableConfigKeys();
  const config: Record<string, unknown> = {};
  for (const key of allowed) {
    if (key in record) config[key] = record[key];
  }

  for (const [key, value] of Object.entries(edits)) {
    // Only schema keys, so a caller cannot smuggle one in through `edits`.
    if (value === undefined || !allowed.includes(key)) continue;
    config[key] = value;
  }

  const droppedKeys = Object.keys(record).filter((key) => !allowed.includes(key));
  return { config, droppedKeys };
}
