/**
 * Git identity for a repository.
 *
 * Two things this buys, and one it deliberately does not.
 *
 * **The index is found where the repository actually is.** `.codegraph/` sits at
 * a repository root, and a Paperclip project's workspace is usually that root —
 * but not always. A `git_repo` project can point at a subdirectory of a checkout
 * (a package inside a monorepo, say), in which case looking for
 * `<workspace>/.codegraph` finds nothing and the graph reports a problem that
 * does not exist. `git rev-parse --show-toplevel` answers the question properly.
 *
 * **The label is a name a human recognises.** A repository's identity is its
 * remote, not the directory it happens to be checked out into. Deriving "pos"
 * from `path.basename` is right only because Paperclip names the managed folder
 * after the repo; point a project at a folder called `checkout-2` and the
 * operator sees "checkout-2".
 *
 * **What it does not do is search the filesystem.** Recognising the repository
 * Paperclip has already checked out is scoped to work the operator authorised.
 * Walking the disk for git repositories would turn a code-intelligence plugin
 * into a discovery tool for everything on the host, which is not its business.
 *
 * Every failure degrades to the workspace path rather than throwing: `git` may be
 * absent, the directory may not be a repository, and neither is an error worth
 * refusing to draw a graph over.
 */

import fs from "node:fs/promises";
import path from "node:path";

/** Runs a command in a directory and returns stdout. Injected so this is testable. */
export type CommandRunner = (
  command: string,
  args: readonly string[],
  cwd: string,
) => Promise<string>;

export interface GitIdentity {
  /** Repository root, from `git rev-parse --show-toplevel`. */
  root: string | null;
  /** Repository name, from `origin`. */
  name: string | null;
  /** Remote URL, when `origin` has one. */
  url: string | null;
}

export const NO_GIT_IDENTITY: GitIdentity = { root: null, name: null, url: null };

/**
 * Reduce a remote URL to a repository name.
 *
 * Handles the forms that actually occur: `https://host/group/repo.git`,
 * `git@host:group/repo.git`, `ssh://git@host/group/repo.git`, and a bare local
 * path. Returns null for anything it cannot read a name out of, so the caller
 * falls back to the folder rather than showing a mangled string.
 */
/**
 * Strip credentials out of a remote URL.
 *
 * A clone URL can carry a token — `https://oauth2:glpat-…@host/group/repo.git` is
 * what GitLab hands out, and it is common in CI-provisioned checkouts. This plugin
 * reads that URL to label a repository, and a label is rendered, logged and put in
 * an audit row, so the credential must not survive the read.
 *
 * Applied before anything else touches the URL, so the name derived from it cannot
 * carry a token either.
 */
export function redactRemoteUrl(url: string): string {
  // Only a `user:secret@` authority is redacted. A bare `user@` carries no secret
  // — `ssh://git@github.com/…` is the ordinary SSH form, and masking `git` there
  // would be destroying information rather than protecting any.
  if (url.includes("://")) {
    return url.replace(
      /^([a-z][a-z0-9+.-]*:\/\/)[^/@\s:]+:[^/@\s]+@/i,
      "$1***@",
    );
  }
  // The scp form has no scheme to anchor on, so anchor on the colon instead.
  return url.replace(/^[^/@\s:]+:[^/@\s]+@/, "***@");
}

export function repoNameFromRemoteUrl(url: string | null | undefined): string | null {
  if (typeof url !== "string") return null;
  // Redacted first: a credential must not reach the name this returns.
  const trimmed = redactRemoteUrl(url.trim());
  if (trimmed.length === 0) return null;

  // `scp`-style shorthand has no scheme, so it needs handling before URL parsing.
  const scpLike = /^(?:[^@/]+@)?[^/:]+:(.+)$/.exec(trimmed);
  const pathPart = trimmed.includes("://")
    ? // `new URL` would decode and normalise; the tail is all that is wanted.
      (trimmed.split("://")[1]?.split("/").slice(1).join("/") ?? "")
    : scpLike
      ? (scpLike[1] ?? "")
      : trimmed;

  const segments = pathPart.split("/").filter((segment) => segment.length > 0);
  const last = segments.at(-1);
  if (!last) return null;

  const name = last.endsWith(".git") ? last.slice(0, -4) : last;
  return name.length > 0 ? name : null;
}

/** One git command, or null if git is missing, the directory is not a repo, or it failed. */
async function git(run: CommandRunner, cwd: string, args: string[]): Promise<string | null> {
  try {
    const output = await run("git", args, cwd);
    const trimmed = output.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    // Not a repository, no git binary, or a timeout. All the same to the caller.
    return null;
  }
}

/**
 * Identify the repository a workspace belongs to.
 *
 * The subdirectory case is handled explicitly: when `git rev-parse` returns an
 * ancestor of `workspacePath`, the *repository* is that ancestor but the
 * *project* is still the subdirectory, so the root is reported without pretending
 * the caller's path was wrong.
 */
export async function gitIdentity(
  workspacePath: string,
  run: CommandRunner,
): Promise<GitIdentity> {
  const root = await git(run, workspacePath, ["rev-parse", "--show-toplevel"]);
  if (!root) return NO_GIT_IDENTITY;

  const rawUrl = await git(run, workspacePath, ["remote", "get-url", "origin"]);
  // Redacted at the boundary: `url` is returned to callers that render it, and a
  // token in a clone URL must not travel any further than this line.
  const url = rawUrl === null ? null : redactRemoteUrl(rawUrl);
  return { root, name: repoNameFromRemoteUrl(rawUrl), url };
}

/**
 * Whether a directory is a git working tree.
 *
 * A cheap `stat` rather than a `git` invocation: `.git` is a directory in a
 * normal clone and a *file* in a linked worktree or submodule, so both count.
 * Used only to exclude non-repository workspaces from the list, so a false
 * negative costs a missing row rather than a wrong answer.
 */
export async function isGitRepository(root: string): Promise<boolean> {
  try {
    await fs.stat(path.join(root, ".git"));
    return true;
  } catch {
    return false;
  }
}

/**
 * Where this workspace's CodeGraph index lives.
 *
 * Prefers the repository root, falling back to the workspace itself when git
 * cannot answer — so a non-git folder, a missing binary, or a bare checkout all
 * keep working exactly as before.
 */
export async function indexRoot(
  workspacePath: string,
  run: CommandRunner,
): Promise<{ root: string; identity: GitIdentity }> {
  const identity = await gitIdentity(workspacePath, run);
  return { root: identity.root ?? workspacePath, identity };
}

/**
 * A repository found inside a project's workspace.
 *
 * `relativePath` is `""` when the workspace itself is the repository, which is the
 * ordinary single-checkout case; otherwise it names the child directory, because a
 * project's managed folder is often a container for several checkouts rather than a
 * checkout itself.
 */
export interface DiscoveredRepository {
  /** Absolute path to the repository root. */
  path: string;
  /**
   * Where this repository sits inside the workspace. `""` means the workspace
   * itself, which is the ordinary single-checkout case. Doubles as the stable
   * identity of the repository within its project: it is the one label that
   * survives a re-index, a re-clone, and a reload of the settings page.
   *
   * Safe to show. It is a directory *name* relative to the workspace, not a host
   * path, and the plugin redacts host layout everywhere else.
   */
  relativePath: string;
}

/**
 * Every repository inside a workspace, without guessing.
 *
 * Paperclip's managed layout puts a checkout at `<parent>/<repo-name>/`, and a
 * project may hold **several** — one real project on this host holds six. The plugin
 * used to require the workspace root itself to be a repository and silently skipped
 * the project otherwise, which is why a multi-repo project appeared as no repository
 * at all in the dashboard.
 *
 * Two depths only, deliberately:
 *
 *   - the workspace root, if it is a repository;
 *   - its immediate children, because that is the shape Paperclip creates.
 *
 * It does not recurse further. A deep search would eventually find a vendored
 * checkout inside `node_modules` or a fixture, and a repository nobody meant to
 * index is worse than one not yet discovered. A child that is not a repository is
 * simply not a candidate.
 *
 * Results are ordered and deduplicated by path, so the same tree always yields the
 * same list and a caller can take the first entry as a stable primary.
 *
 * ## The workspace with no checkout on disk
 *
 * `remoteUrl` is Paperclip's own answer to "is this a repository?" — the
 * workspace's `repo_url`. When nothing is found on disk but that is set, the
 * workspace is reported as a single repository anyway. Two real shapes need this:
 * a project whose checkout has not been cloned yet, and a project pointing *into*
 * a larger checkout (a package inside a monorepo), where the repository root is an
 * ancestor of the workspace and only `git rev-parse` can find it — the workspace
 * itself carries no `.git`, so a discovery-only answer would be "no repository"
 * for a project that is plainly in one.
 *
 * A workspace that does not exist is still nothing: a vanished folder cannot be
 * indexed, so reporting a row for it would only offer a button that fails.
 */
export async function findRepositories(
  workspacePath: string,
  options: { remoteUrl?: string | null } = {},
): Promise<DiscoveredRepository[]> {
  const found: DiscoveredRepository[] = [];

  if (await isGitRepository(workspacePath)) {
    found.push({ path: workspacePath, relativePath: "" });
  } else {
    let entries: string[];
    try {
      entries = await fs.readdir(workspacePath);
    } catch {
      return [];
    }

    for (const entry of entries.sort()) {
      // Skip the obvious non-candidates rather than stat-ing everything: these are
      // never a repository root, and readdir on a large workspace is the expensive
      // part of this function.
      if (entry.startsWith(".") || entry === "node_modules") continue;
      const child = path.join(workspacePath, entry);
      if (await isGitRepository(child)) {
        found.push({ path: child, relativePath: entry });
      }
    }

    if (found.length === 0 && options.remoteUrl) {
      found.push({ path: workspacePath, relativePath: "" });
    }
  }

  return found;
}

/**
 * Which checkout a configured path actually means.
 *
 * The *agent* side of the same problem `findRepositories` solves for the settings
 * page. A governance binding, or the workspace Paperclip hands a run, can name a
 * folder that **contains** the checkout rather than being one — Paperclip's managed
 * layout is `<project>/_default/<repo>/` — and CodeGraph's index lives at the
 * checkout, so handing it the folder one level above answers nothing at all. An
 * agent then gets "not indexed" for a repository that is indexed on the host.
 *
 * - **No candidate** — the path is kept as it is. It may be a subdirectory of a
 *   checkout whose index sits at an ancestor, which is CodeGraph's own business to
 *   resolve; refusing here would break a working monorepo deployment.
 * - **One candidate** — it is used. Unambiguous, and plainly what the operator
 *   meant by naming the folder that holds it.
 * - **Several** — refused, with the names returned. Choosing one would let an agent
 *   answer confidently out of a codebase nobody selected, and nothing in the answer
 *   would say so. Naming them is also the instruction: bind the one you want.
 *
 * The refusal carries `relativePath`s — the same directory names the settings page
 * shows — so the message an agent gets names something the operator can act on,
 * without disclosing where the host keeps it.
 */
export type CheckoutResolution =
  | { ok: true; path: string; contained: boolean }
  | { ok: false; candidates: string[] };

export async function resolveCheckout(configuredPath: string): Promise<CheckoutResolution> {
  const found = await findRepositories(configuredPath);

  // The path is a checkout itself, which is the ordinary case: returning it
  // unchanged is what keeps every existing deployment byte-identical.
  if (found.length === 0 || (found.length === 1 && found[0]!.relativePath === "")) {
    return { ok: true, path: configuredPath, contained: false };
  }

  if (found.length === 1) {
    return { ok: true, path: found[0]!.path, contained: true };
  }

  return { ok: false, candidates: found.map((repository) => repository.relativePath) };
}
