import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  NO_GIT_IDENTITY,
  gitIdentity,
  indexRoot,
  findRepositories,
  resolveCheckout,
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

describe("findRepositories — discovering checkouts inside a workspace", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pcg-discover-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const mkRepo = (dir: string) => {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
    fs.mkdirSync(path.join(root, dir, ".git"));
  };

  it("finds the workspace itself when it is a repository", async () => {
    mkRepo(".");
    const found = await findRepositories(root);
    expect(found).toHaveLength(1);
    expect(found[0]!.relativePath).toBe("");
    expect(found[0]!.path).toBe(root);
  });

  it("finds a single nested checkout — the DEA shape", async () => {
    // Real case: the managed folder is a container and the checkout is one level in.
    fs.mkdirSync(path.join(root, "_default", "dealthai"), { recursive: true });
    fs.mkdirSync(path.join(root, "_default", "dealthai", ".git"));
    const found = await findRepositories(path.join(root, "_default"));
    expect(found).toHaveLength(1);
    expect(found[0]!.relativePath).toBe("dealthai");
  });

  it("finds every checkout in a multi-repo project — the VRO shape", async () => {
    // Real case: six repositories side by side under one project folder.
    for (const name of ["vroomy-backend", "vroomy-frontend", "vroomy-docs", "vroomy-infra"]) {
      mkRepo(name);
    }
    const found = await findRepositories(root);
    expect(found.map((r) => r.relativePath)).toEqual([
      "vroomy-backend",
      "vroomy-docs",
      "vroomy-frontend",
      "vroomy-infra",
    ]);
  });

  it("returns nothing for a workspace with no repository at all", async () => {
    // The cancelled-project case: a folder, no code. Must not be reported as one.
    fs.mkdirSync(path.join(root, "notes"));
    expect(await findRepositories(root)).toEqual([]);
  });

  it("does not descend into a repository to find more", async () => {
    // Once a checkout is found, its own subdirectories are its business — a nested
    // repo there is a submodule, not a second project repository.
    mkRepo("app");
    fs.mkdirSync(path.join(root, "app", "vendor", ".git"), { recursive: true });
    const found = await findRepositories(root);
    expect(found).toHaveLength(1);
    expect(found[0]!.relativePath).toBe("app");
  });

  it("ignores hidden directories and node_modules", async () => {
    // A vendored checkout in node_modules is not a project repository, and indexing
    // one nobody meant to index is worse than not finding it.
    fs.mkdirSync(path.join(root, "node_modules", "some-pkg", ".git"), { recursive: true });
    fs.mkdirSync(path.join(root, ".cache", ".git"), { recursive: true });
    mkRepo("app");
    const found = await findRepositories(root);
    expect(found.map((r) => r.relativePath)).toEqual(["app"]);
  });

  it("treats a linked worktree (.git as a file) as a repository", async () => {
    fs.mkdirSync(path.join(root, "wt"));
    fs.writeFileSync(path.join(root, "wt", ".git"), "gitdir: /elsewhere/.git/worktrees/wt\n");
    const found = await findRepositories(root);
    expect(found.map((r) => r.relativePath)).toEqual(["wt"]);
  });

  it("is ordered and stable", async () => {
    mkRepo("zeta");
    mkRepo("alpha");
    const first = (await findRepositories(root)).map((r) => r.relativePath);
    const second = (await findRepositories(root)).map((r) => r.relativePath);
    expect(first).toEqual(["alpha", "zeta"]);
    expect(second).toEqual(first);
  });

  it("returns nothing for a path that does not exist", async () => {
    // Must not throw: a workspace that vanished is a project with no repository.
    await expect(findRepositories(path.join(root, "gone"))).resolves.toEqual([]);
  });

  it("reports the workspace when Paperclip knows it is a repository but nothing is on disk", async () => {
    // A project whose checkout has not been cloned yet. Paperclip's own `repo_url`
    // is the answer, and a row saying "not indexed" is more useful than the project
    // vanishing from the list entirely.
    fs.mkdirSync(path.join(root, "empty"));
    const found = await findRepositories(path.join(root, "empty"), {
      remoteUrl: "https://example.com/group/repo.git",
    });
    expect(found).toHaveLength(1);
    expect(found[0]!.relativePath).toBe("");
  });

  it("reports the workspace when the checkout is an ancestor — the monorepo shape", async () => {
    // A project pointing at a package inside a larger checkout: the workspace holds
    // no `.git` of its own and no child repository, so discovery alone would answer
    // "no repository" for a project that is plainly in one. Only `git rev-parse` can
    // find the root, so the workspace is offered as the candidate to resolve.
    fs.mkdirSync(path.join(root, "monorepo", "packages", "app"), { recursive: true });
    fs.mkdirSync(path.join(root, "monorepo", ".git"));
    const found = await findRepositories(path.join(root, "monorepo", "packages", "app"), {
      remoteUrl: "https://example.com/group/monorepo.git",
    });
    expect(found).toHaveLength(1);
    expect(found[0]!.path).toBe(path.join(root, "monorepo", "packages", "app"));
    expect(found[0]!.relativePath).toBe("");
  });

  it("still reports nothing when neither a checkout nor a remote exists", async () => {
    // A backlog idea or a cancelled project: a folder with no code is not a
    // repository, and offering a row for it would only offer a button that fails.
    fs.mkdirSync(path.join(root, "notes"));
    await expect(findRepositories(path.join(root, "notes"), { remoteUrl: null })).resolves.toEqual(
      [],
    );
    await expect(findRepositories(path.join(root, "notes"), { remoteUrl: "" })).resolves.toEqual([]);
  });

  it("does not add a second row when a checkout was found and a remote exists", async () => {
    // The fallback must not fire on a project that already has somewhere to point:
    // two rows for one project, one of them the container folder, is a duplicate an
    // operator would have to reason about.
    mkRepo("app");
    const found = await findRepositories(root, { remoteUrl: "https://example.com/group/app.git" });
    expect(found.map((r) => r.relativePath)).toEqual(["app"]);
  });
});

describe("resolveCheckout — which checkout a configured path means", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pcg-checkout-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const mkRepo = (dir: string) => {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
    fs.mkdirSync(path.join(root, dir, ".git"));
  };

  it("returns a checkout unchanged", async () => {
    // The property every existing deployment depends on: a binding that already
    // names the checkout must resolve to exactly the same path it always did.
    mkRepo(".");
    const resolved = await resolveCheckout(root);
    expect(resolved).toEqual({ ok: true, path: root, contained: false });
  });

  it("descends into a folder holding one checkout — the DEA case", async () => {
    // The binding names `_default`; the index is at `_default/dealthai`. Handing
    // CodeGraph the folder above it is why an agent got "not indexed" for a
    // repository that was indexed on the host.
    fs.mkdirSync(path.join(root, "_default", "dealthai"), { recursive: true });
    fs.mkdirSync(path.join(root, "_default", "dealthai", ".git"));
    const resolved = await resolveCheckout(path.join(root, "_default"));
    expect(resolved).toEqual({
      ok: true,
      path: path.join(root, "_default", "dealthai"),
      contained: true,
    });
  });

  it("refuses a folder holding several, naming them", async () => {
    // Nothing says which of the six was meant, and answering out of an arbitrary one
    // would be a confident answer about the wrong codebase. The names are also the
    // instruction: bind one of these.
    for (const name of ["vroomy-frontend", "vroomy-backend", "vroomy-docs"]) {
      mkRepo(name);
    }
    const resolved = await resolveCheckout(root);
    expect(resolved.ok).toBe(false);
    if (resolved.ok) throw new Error("unreachable");
    // Ordered, so the message is stable across calls.
    expect(resolved.candidates).toEqual(["vroomy-backend", "vroomy-docs", "vroomy-frontend"]);
  });

  it("leaves a path with no checkout alone", async () => {
    // It may be a subdirectory of a checkout whose index sits at an ancestor, which
    // is CodeGraph's own business to resolve. Refusing here would break a working
    // monorepo deployment, and rewriting the path would move it somewhere nobody
    // bound.
    fs.mkdirSync(path.join(root, "packages", "app"), { recursive: true });
    const target = path.join(root, "packages", "app");
    expect(await resolveCheckout(target)).toEqual({ ok: true, path: target, contained: false });
  });

  it("leaves a path that does not exist alone", async () => {
    // Not this function's job to report: `resolveProjectPath` has already validated
    // containment, and a missing folder is reported by the call that needs it.
    const target = path.join(root, "gone");
    expect(await resolveCheckout(target)).toEqual({ ok: true, path: target, contained: false });
  });

  it("does not treat a nested checkout inside a checkout as a second candidate", async () => {
    // A submodule is the outer repository's business: the workspace *is* a checkout,
    // so what it contains is not a competing answer.
    mkRepo(".");
    fs.mkdirSync(path.join(root, "vendor", "sub", ".git"), { recursive: true });
    expect(await resolveCheckout(root)).toEqual({ ok: true, path: root, contained: false });
  });
});
