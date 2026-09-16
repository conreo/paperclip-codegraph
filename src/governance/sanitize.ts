/**
 * Path safety for CodeGraph project bindings.
 *
 * A CodeGraph project binding is an *absolute filesystem path the server will
 * read source from*. In a multi-tenant control plane that makes it a
 * capability, so every path that reaches a child process passes through here
 * first. The rules are deny-by-default and fail closed:
 *
 *   - must be an absolute, normalized path with no NUL bytes;
 *   - must exist and be a directory;
 *   - is symlink-resolved, and the *resolved* path is what gets validated and
 *     used (so a symlink cannot be used to escape a root after the check);
 *   - must not be a sensitive system or credential directory;
 *   - must be deep enough to be a project rather than a filesystem root or a
 *     home directory;
 *   - if the operator configured `allowedProjectRoots`, must be contained in one.
 *
 * Nothing here logs or returns raw paths to an agent.
 */

import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import os from "node:os";

export type PathRefusalCode =
  | "empty"
  | "not_a_string"
  | "relative"
  | "nul_byte"
  | "not_found"
  | "not_a_directory"
  | "too_shallow"
  | "sensitive"
  | "outside_allowed_roots";

export class PathRefusal extends Error {
  constructor(
    readonly code: PathRefusalCode,
    message: string,
  ) {
    super(message);
    this.name = "PathRefusal";
  }
}

/**
 * Directories that are never a legitimate CodeGraph project, with the reason.
 *
 * The Paperclip and DSH homes are included because they hold instance
 * configuration, database files, and secrets: pointing a code index at them
 * would let an agent read the control plane's own credentials.
 */
const SENSITIVE_PREFIXES: ReadonlyArray<{ path: string; why: string }> = (
  process.platform === "win32"
    ? [
        { path: "C:\\Windows", why: "operating system directory" },
        { path: "C:\\Program Files", why: "installed programs" },
        { path: "C:\\Program Files (x86)", why: "installed programs" },
      ]
    : [
        { path: "/etc", why: "system configuration and credentials" },
        { path: "/proc", why: "kernel process interface" },
        { path: "/sys", why: "kernel device interface" },
        { path: "/dev", why: "device nodes" },
        { path: "/boot", why: "bootloader and kernel images" },
        { path: "/root", why: "superuser home" },
        { path: "/run", why: "runtime sockets and pid files" },
        { path: "/var/run", why: "runtime sockets and pid files" },
        { path: "/var/lib", why: "service state databases" },
        { path: "/private/etc", why: "system configuration (macOS)" },
        { path: "/private/var", why: "system state (macOS)" },
      ]
).concat([
  { path: path.join(os.homedir(), ".ssh"), why: "SSH private keys" },
  { path: path.join(os.homedir(), ".aws"), why: "AWS credentials" },
  { path: path.join(os.homedir(), ".gnupg"), why: "GPG private keys" },
  { path: path.join(os.homedir(), ".paperclip"), why: "Paperclip instance state and secrets" },
  { path: path.join(os.homedir(), ".dsh"), why: "agent harness state" },
  { path: path.join(os.homedir(), ".config"), why: "application credentials" },
  { path: path.join(os.homedir(), ".npm"), why: "package manager credentials" },
]);

/** Minimum path depth below the filesystem root for a path to be a project. */
const MIN_DEPTH = 3;

export interface PathValidationOptions {
  /**
   * If non-empty, a project path must be contained in one of these roots.
   * Empty or absent means "any non-sensitive directory".
   */
  allowedProjectRoots?: readonly string[];
  /** Override for tests so path checks do not depend on this machine. */
  homedir?: string;
  /** Override for tests. */
  platform?: NodeJS.Platform;
}

function segments(p: string): string[] {
  return p.split(/[\\/]+/).filter((segment) => segment.length > 0);
}

/** True when `candidate` is `root` itself or lives underneath it. */
export function isContainedIn(root: string, candidate: string): boolean {
  const normalizedRoot = path.resolve(root);
  const normalizedCandidate = path.resolve(candidate);
  if (normalizedRoot === normalizedCandidate) return true;
  const relative = path.relative(normalizedRoot, normalizedCandidate);
  return (
    relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative)
  );
}

/** Report why a path is sensitive, or null when it is acceptable. */
export function sensitiveReason(
  candidate: string,
  options: PathValidationOptions = {},
): string | null {
  const resolved = path.resolve(candidate);
  const homedir = options.homedir ?? os.homedir();

  // Checked before the depth rule so the operator gets the specific reason:
  // a home directory like /home/alice is also shallow, and "too shallow" would
  // send them looking for a deeper path instead of a different one.
  if (resolved === path.resolve(homedir)) {
    return "path is the user home directory, which is too broad to index";
  }

  // A filesystem root or a filesystem-level directory is too broad to index.
  if (segments(resolved).length < MIN_DEPTH) {
    return `path is too shallow to be a project (needs at least ${MIN_DEPTH} segments)`;
  }

  for (const entry of SENSITIVE_PREFIXES) {
    if (isContainedIn(entry.path, resolved)) {
      return `path is inside ${entry.path} (${entry.why})`;
    }
  }
  return null;
}

/**
 * Validate and canonicalize an operator-supplied project path.
 *
 * Returns the symlink-resolved absolute path. Throws {@link PathRefusal} with a
 * machine-readable code; the message is safe to show an operator but should not
 * be handed to an agent verbatim.
 */
export function resolveProjectPath(
  raw: unknown,
  options: PathValidationOptions = {},
): string {
  if (typeof raw !== "string") {
    throw new PathRefusal("not_a_string", "Project path must be a string");
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new PathRefusal("empty", "Project path must not be empty");
  }
  if (trimmed.includes("\0")) {
    throw new PathRefusal("nul_byte", "Project path must not contain NUL bytes");
  }
  if (!path.isAbsolute(trimmed)) {
    throw new PathRefusal(
      "relative",
      `Project path must be absolute, got "${trimmed}"`,
    );
  }

  const normalized = path.resolve(trimmed);

  const shallow = sensitiveReason(normalized, options);
  if (shallow) throw new PathRefusal("sensitive", shallow);

  let stats;
  try {
    stats = statSync(normalized);
  } catch {
    throw new PathRefusal("not_found", `Project path does not exist: ${normalized}`);
  }
  if (!stats.isDirectory()) {
    throw new PathRefusal(
      "not_a_directory",
      `Project path is not a directory: ${normalized}`,
    );
  }

  // Resolve symlinks so containment is checked against the real location.
  let resolved: string;
  try {
    resolved = realpathSync(normalized);
  } catch {
    throw new PathRefusal(
      "not_found",
      `Project path could not be resolved: ${normalized}`,
    );
  }

  const afterSymlink = sensitiveReason(resolved, options);
  if (afterSymlink) throw new PathRefusal("sensitive", afterSymlink);

  const roots = options.allowedProjectRoots ?? [];
  if (roots.length > 0) {
    const inside = roots.some((root) => {
      try {
        return isContainedIn(realpathSync(path.resolve(root)), resolved);
      } catch {
        return false;
      }
    });
    if (!inside) {
      throw new PathRefusal(
        "outside_allowed_roots",
        `Project path ${resolved} is not inside any configured allowedProjectRoots entry`,
      );
    }
  }

  return resolved;
}

/**
 * Derive a stable, non-sensitive alias for a path.
 *
 * The last two segments plus a short hash of the full path: enough to tell two
 * checkouts apart in a log, not enough to reconstruct a directory layout, and
 * stable across restarts so audit rows correlate.
 */
export function deriveProjectKey(projectPath: string): string {
  const parts = segments(path.resolve(projectPath));
  const tail = parts.slice(-2).join("-");
  let hash = 0;
  const full = path.resolve(projectPath);
  for (let index = 0; index < full.length; index += 1) {
    hash = (hash * 31 + full.charCodeAt(index)) | 0;
  }
  const suffix = (hash >>> 0).toString(36).slice(0, 6);
  return `${sanitizeAlias(tail)}-${suffix}`;
}

/** Reduce arbitrary text to a safe alias (`[a-z0-9._-]`). */
export function sanitizeAlias(value: string): string {
  // Dots are separators, not content: an alias is a log/audit label, and
  // allowing `.` would let a `..` path segment survive into a string that a
  // downstream tool could read as traversal. Collapsing every disallowed run
  // (including dots and whitespace) to a single dash is the rule that is hard
  // to get subtly wrong.
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned.length > 0 ? cleaned.slice(0, 60) : "project";
}

/**
 * Replace a raw path with its alias for logging.
 *
 * Audit metadata uses this so a log reader learns *which binding* was used
 * without learning the host's directory layout.
 */
export function redactPath(projectPath: string, alias?: string): string {
  return alias && alias.length > 0 ? alias : deriveProjectKey(projectPath);
}
