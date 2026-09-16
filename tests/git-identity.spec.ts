import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  NO_GIT_IDENTITY,
  gitIdentity,
  indexRoot,
  isGitRepository,
  redactRemoteUrl,
  repoNameFromRemoteUrl,
  type CommandRunner,
} from "../src/git/identity.js";

/** A fake git that answers from a table, so no real repository is needed. */
function fakeGit(answers: Record<string, string | Error>): CommandRunner {
  return async (command, args) => {
    expect(command).toBe("git");
    const key = args.join(" ");
    const answer = answers[key];
    if (answer === undefined) throw new Error(`git ${key} failed`);
    if (answer instanceof Error) throw answer;
    return answer;
  };
}

describe("repoNameFromRemoteUrl", () => {
  it("reads the name out of an https remote", () => {
    expect(repoNameFromRemoteUrl("https://192.168.1.46/root/pos")).toBe("pos");
    expect(repoNameFromRemoteUrl("https://github.com/conreo/paperclip-codegraph.git")).toBe(
      "paperclip-codegraph",
    );
  });

  it("reads the name out of an scp-style remote", () => {
    // The form git prints for an SSH clone, which has no scheme to parse.
    expect(repoNameFromRemoteUrl("git@github.com:conreo/paperclip-codegraph.git")).toBe(
      "paperclip-codegraph",
    );
    expect(repoNameFromRemoteUrl("git@192.168.1.46:root/pos.git")).toBe("pos");
  });

  it("reads the name out of an ssh:// remote", () => {
    expect(repoNameFromRemoteUrl("ssh://git@github.com/conreo/repo.git")).toBe("repo");
  });

  it("reads the name out of a local path", () => {
    expect(repoNameFromRemoteUrl("/srv/git/pos.git")).toBe("pos");
    expect(repoNameFromRemoteUrl("/srv/git/pos")).toBe("pos");
  });

  it("tolerates a trailing slash", () => {
    expect(repoNameFromRemoteUrl("https://github.com/conreo/repo.git/")).toBe("repo");
    expect(repoNameFromRemoteUrl("https://github.com/conreo/repo/")).toBe("repo");
  });

  it("returns null rather than a mangled name", () => {
    // Guessing here would put a wrong label in front of an operator, which is
    // worse than falling back to the folder name.
    expect(repoNameFromRemoteUrl(null)).toBeNull();
    expect(repoNameFromRemoteUrl(undefined)).toBeNull();
    expect(repoNameFromRemoteUrl("")).toBeNull();
    expect(repoNameFromRemoteUrl("   ")).toBeNull();
    expect(repoNameFromRemoteUrl("/")).toBeNull();
    expect(repoNameFromRemoteUrl("https://github.com/")).toBeNull();
  });

  it("does not treat a dotfile-ish tail as a name", () => {
    expect(repoNameFromRemoteUrl("https://github.com/conreo/.git")).toBeNull();
  });
});

describe("gitIdentity", () => {
  it("reports the root, name and url of a repository", () => {
    const run = fakeGit({
      "rev-parse --show-toplevel": "/srv/pos\n",
      "remote get-url origin": "https://192.168.1.46/root/pos\n",
    });
    return expect(gitIdentity("/srv/pos/backend", run)).resolves.toEqual({
      root: "/srv/pos",
      name: "pos",
      url: "https://192.168.1.46/root/pos",
    });
  });

  it("handles a workspace that is a subdirectory of a checkout", () => {
    // The case that motivated this module: the project points at a package
    // inside a monorepo, so the index is at the repository root, not here.
    const run = fakeGit({
      "rev-parse --show-toplevel": "/srv/mono",
      "remote get-url origin": "git@github.com:acme/mono.git",
    });
    return expect(gitIdentity("/srv/mono/packages/api", run)).resolves.toEqual({
      root: "/srv/mono",
      name: "mono",
      url: "git@github.com:acme/mono.git",
    });
  });

  it("reports a repository with no origin as root-only", () => {
    // A fresh `git init`, or a remote named something else. The root is still
    // useful; the name is not invented.
    const run = fakeGit({ "rev-parse --show-toplevel": "/srv/local" });
    return expect(gitIdentity("/srv/local", run)).resolves.toEqual({
      root: "/srv/local",
      name: null,
      url: null,
    });
  });

  it("returns nothing when the directory is not a repository", async () => {
    const run: CommandRunner = async () => {
      throw new Error("fatal: not a git repository");
    };
    await expect(gitIdentity("/tmp/plain", run)).resolves.toEqual(NO_GIT_IDENTITY);
  });

  it("returns nothing when git is not installed", async () => {
    // ENOENT surfaces the same way as any other failure, and must not propagate:
    // a missing binary is not a reason to refuse to draw a graph.
    const run: CommandRunner = async () => {
      const error = new Error("spawn git ENOENT") as Error & { code?: string };
      error.code = "ENOENT";
      throw error;
    };
    await expect(gitIdentity("/srv/pos", run)).resolves.toEqual(NO_GIT_IDENTITY);
  });

  it("treats empty stdout as no answer", async () => {
    // `git` can exit 0 with nothing to say; an empty string is not a path.
    const run = fakeGit({ "rev-parse --show-toplevel": "  \n" });
    await expect(gitIdentity("/srv/pos", run)).resolves.toEqual(NO_GIT_IDENTITY);
  });

  it("keeps the root when only the remote lookup fails", async () => {
    const run = fakeGit({ "rev-parse --show-toplevel": "/srv/pos" });
    const identity = await gitIdentity("/srv/pos", run);
    expect(identity.root).toBe("/srv/pos");
    expect(identity.name).toBeNull();
  });
});

describe("indexRoot", () => {
  it("uses the repository root when git answers", async () => {
    const run = fakeGit({
      "rev-parse --show-toplevel": "/srv/mono",
      "remote get-url origin": "git@github.com:acme/mono.git",
    });
    const { root, identity } = await indexRoot("/srv/mono/packages/api", run);
    expect(root).toBe("/srv/mono");
    expect(identity.name).toBe("mono");
  });

  it("falls back to the workspace when git cannot answer", async () => {
    // Today's behaviour, preserved exactly, for every non-git deployment.
    const run: CommandRunner = async () => {
      throw new Error("not a repository");
    };
    const { root, identity } = await indexRoot("/srv/plain", run);
    expect(root).toBe("/srv/plain");
    expect(identity).toEqual(NO_GIT_IDENTITY);
  });
});

describe("isGitRepository", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pcg-isrepo-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("recognises a normal clone, where .git is a directory", () => {
    fs.mkdirSync(path.join(root, ".git"));
    return expect(isGitRepository(root)).resolves.toBe(true);
  });

  it("recognises a linked worktree, where .git is a file", async () => {
    // `git worktree add` writes a `.git` *file* pointing at the real git dir,
    // so a directory-only check would misread every linked worktree.
    fs.writeFileSync(path.join(root, ".git"), "gitdir: /srv/main/.git/worktrees/wt\n");
    await expect(isGitRepository(root)).resolves.toBe(true);
  });

  it("returns false for a plain directory", async () => {
    // The case that put "Onboarding — not indexed yet" in the repository list.
    await expect(isGitRepository(root)).resolves.toBe(false);
  });

  it("returns false for a directory that does not exist", async () => {
    await expect(isGitRepository(path.join(root, "nope"))).resolves.toBe(false);
  });

  it("returns false when .git is unreadable rather than throwing", async () => {
    // A stat failure must not take down the listing that called it.
    await expect(isGitRepository("/proc/1/fd/not-a-real-path")).resolves.toBe(false);
  });
});

describe("redactRemoteUrl — a clone URL can carry a token", () => {
  it("strips a password from an https remote", () => {
    // The real case this exists for: GitLab hands out clone URLs with a PAT in
    // them, and this plugin reads that URL to label a repository.
    expect(redactRemoteUrl("https://oauth2:glpat-EXAMPLEtoken123@git.example.com/group/repo.git")).toBe(
      "https://***@git.example.com/group/repo.git",
    );
  });

  it("keeps the user so the label still says whose checkout it is", () => {
    expect(redactRemoteUrl("https://deploy:secret@host/x/y.git")).toBe("https://***@host/x/y.git");
  });

  it("leaves a URL with no credentials alone", () => {
    for (const url of [
      "https://github.com/conreo/paperclip-codegraph.git",
      "git@github.com:conreo/repo.git",
      "ssh://git@github.com/conreo/repo.git",
      "/srv/git/pos.git",
    ]) {
      expect(redactRemoteUrl(url), url).toBe(url);
    }
  });

  it("strips the scp form too, which has no scheme to anchor on", () => {
    expect(redactRemoteUrl("oauth2:glpat-EXAMPLE@git.example.com:group/repo.git")).toBe(
      "***@git.example.com:group/repo.git",
    );
  });

  it("never leaves the token in the string", () => {
    const secret = "glpat-EXAMPLEtoken123";
    for (const url of [
      `https://oauth2:${secret}@h/g/r.git`,
      `http://u:${secret}@h/g/r.git`,
      `oauth2:${secret}@h:g/r.git`,
    ]) {
      expect(redactRemoteUrl(url)).not.toContain(secret);
    }
  });
});
