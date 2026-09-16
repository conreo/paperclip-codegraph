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
export function repoNameFromRemoteUrl(url: string | null | undefined): string | null {
  if (typeof url !== "string") return null;
  const trimmed = url.trim();
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

  const url = await git(run, workspacePath, ["remote", "get-url", "origin"]);
  return { root, name: repoNameFromRemoteUrl(url), url };
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
