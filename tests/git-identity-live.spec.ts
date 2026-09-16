/**
 * The git identity path, against a real repository.
 *
 * `git-identity.spec.ts` drives `gitIdentity` through an injected runner, which
 * pins the *logic* but would happily pass while the runner itself was broken —
 * wrong arguments, a cwd that is ignored, stdout not trimmed. These cases shell
 * out to the real `git` so the contract with the binary is exercised too, and
 * they skip rather than fail when git is absent, because a missing binary is not
 * a plugin defect.
 */

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveCommand, runCommand } from "../src/codegraph/manage.js";
import { indexRoot, type CommandRunner } from "../src/git/identity.js";

let root: string;
let gitAvailable = false;

/** The same runner shape the worker builds, pointed at real git. */
const run: CommandRunner = async (command, args, cwd) => {
  const result = await runCommand(command, args, {
    cwd,
    timeoutMs: 10_000,
    env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "" },
  });
  if (result.code !== 0) throw new Error(result.stderr.trim() || `git exited ${result.code}`);
  return result.stdout;
};

async function git(args: string[], cwd: string): Promise<void> {
  const result = await runCommand("git", args, {
    cwd,
    timeoutMs: 10_000,
    env: {
      PATH: process.env["PATH"] ?? "",
      HOME: process.env["HOME"] ?? "",
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
  if (result.code !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
}

beforeAll(async () => {
  gitAvailable = (await resolveCommand("git")) !== null;
  if (!gitAvailable) return;

  root = fs.mkdtempSync(path.join(os.tmpdir(), "pcg-realgit-"));
  fs.mkdirSync(path.join(root, "packages", "api"), { recursive: true });
  fs.writeFileSync(path.join(root, "packages", "api", "index.ts"), "export const x = 1;\n");

  await git(["init", "-q"], root);
  await git(["add", "."], root);
  await git(["-c", "commit.gpgsign=false", "commit", "-q", "-m", "init"], root);
});

afterAll(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

describe("git identity against real git", () => {
  it("finds the repository root from a subdirectory", async () => {
    if (!gitAvailable) return;
    // The monorepo case, with a real git binary and a real worktree.
    const { root: found, identity } = await indexRoot(path.join(root, "packages", "api"), run);
    // macOS tmpdirs are symlinked (/var -> /private/var), so compare realpaths.
    expect(fs.realpathSync(found)).toBe(fs.realpathSync(root));
    expect(identity.root).not.toBeNull();
  });

  it("returns the workspace itself for a directory that is not a repository", async () => {
    if (!gitAvailable) return;
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), "pcg-plain-"));
    try {
      const { root: found, identity } = await indexRoot(plain, run);
      expect(found).toBe(plain);
      expect(identity.root).toBeNull();
      expect(identity.name).toBeNull();
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });

  it("reports no name for a repository with no origin", async () => {
    if (!gitAvailable) return;
    // A local `git init` with no remote: the root is real, the name is not
    // invented from the directory.
    const { identity } = await indexRoot(root, run);
    expect(identity.root).not.toBeNull();
    expect(identity.name).toBeNull();
  });

  it("reads the name once an origin exists", async () => {
    if (!gitAvailable) return;
    const local = fs.mkdtempSync(path.join(os.tmpdir(), "pcg-origin-"));
    try {
      await git(["init", "-q"], local);
      await git(["remote", "add", "origin", "git@github.com:acme/pos.git"], local);

      const { identity } = await indexRoot(local, run);
      expect(identity.name).toBe("pos");
      expect(identity.url).toBe("git@github.com:acme/pos.git");
    } finally {
      fs.rmSync(local, { recursive: true, force: true });
    }
  });
});
