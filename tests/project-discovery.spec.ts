/**
 * `graph-projects` against workspaces shaped like the ones that failed on a real
 * instance.
 *
 * The defect this covers was not in a pure function: the handler required `.git` at
 * the *folder root* and skipped the project otherwise, so a project holding a
 * single nested checkout or six side-by-side checkouts appeared in the dashboard as
 * **no repository at all** — and the operator's question was "why is my repo not
 * detected?". Only running the registered handler over a real directory tree can
 * show that, so this does.
 *
 * The two shapes are taken from the host that reported it:
 *
 *   - `dealthai`  — the managed folder contains one checkout, one level down;
 *   - `vroomy`    — the managed folder contains six checkouts side by side, and is
 *                   itself not a repository.
 *
 * The rows are also checked for host-layout leakage. Rows go to a browser, and the
 * absolute path of a checkout is the one thing in them that must not.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runCommand } from "../src/codegraph/manage.js";

const runWorker = vi.fn();
vi.mock("@paperclipai/plugin-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/plugin-sdk")>();
  return { ...actual, runWorker: (...args: unknown[]) => runWorker(...args) };
});

import { DATA_KEYS } from "../src/plugin-keys.js";
import { isGitRepository } from "../src/git/identity.js";

/** Real `git`, because the rows carry the repository name git is the only source of. */
async function git(args: string[], cwd: string): Promise<void> {
  const result = await runCommand("git", args, {
    cwd,
    timeoutMs: 10_000,
    env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "" },
  });
  if (result.code !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
}

const COMPANY = "979ed243-a0ff-41a8-82c5-f8d2697c33a7";

type Handler = (params: Record<string, unknown>) => Promise<Record<string, unknown>>;

interface Project {
  id: string;
  name: string;
  workspace: { path: string; repoUrl: string | null };
}

/** The worker's `setup()`, with Paperclip answering from a table of projects. */
async function graphProjectsFor(projects: Project[], roots: string[]): Promise<{
  handle: Handler;
  calls: { git: string[]; status: string[] };
}> {
  vi.resetModules();
  const data = new Map<string, unknown>();
  const calls = { git: [] as string[], status: [] as string[] };

  const ctx = {
    data: { register: (key: string, handler: unknown) => data.set(key, handler) },
    actions: { register: () => {} },
    tools: { register: () => {} },
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    activity: { log: async () => {} },
    state: { get: async () => null, set: async () => {} },
    streams: { emit: () => {} },
    config: {
      get: async () => ({
        enabled: true,
        autoInstall: false,
        autoIndex: false,
        allowedProjectRoots: roots,
        codegraphCommand: "/nonexistent/codegraph",
      }),
    },
    projects: {
      list: async () => projects.map(({ id, name }) => ({ id, name })),
      getPrimaryWorkspace: async (projectId: string) =>
        projects.find((project) => project.id === projectId)?.workspace ?? null,
    },
    agents: {},
    companies: { get: async () => ({ name: "Vroomy" }) },
    localFolders: {},
  };

  const module = await import("../src/worker.js");
  const plugin = module.default as unknown as {
    definition: { setup: (ctx: unknown) => Promise<void> | void };
  };
  await plugin.definition.setup(ctx);

  return { handle: data.get(DATA_KEYS.graphProjects) as Handler, calls };
}

describe("graph-projects — discovering the repositories a project holds", () => {
  let root: string;

  beforeEach(() => {
    // `/tmp` is not guaranteed to persist between steps in some sandboxes, but
    // within one test process `mkdtemp` is the right home for a real tree.
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pcg-projects-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** A repository whose `origin` names it, so identity resolution has something to read. */
  async function checkout(relative: string): Promise<string> {
    const dir = path.join(root, relative);
    fs.mkdirSync(dir, { recursive: true });
    // A real repository, not a bare `.git` directory: `isGitRepository` only stats,
    // so a fixture that git itself refuses would pass discovery while quietly
    // returning no repository *name* — the half of the row an operator reads.
    await git(["init", "-q"], dir);
    await git(
      ["remote", "add", "origin", `https://example.com/vroomy/${path.basename(relative)}.git`],
      dir,
    );
    return dir;
  }

  it("lists every checkout of a multi-repository project — the VRO shape", async () => {
    // The folder is a container. Before the fix this project produced zero rows.
    for (const name of ["vroomy-backend", "vroomy-frontend", "vroomy-proto"]) {
      await checkout(path.join("_default", name));
    }
    fs.mkdirSync(path.join(root, "_default", "notes"), { recursive: true });

    // The regression marker, asserted rather than described: the old predicate was
    // `!repoUrl && !isGitRepository(workspaceRoot)`, both halves of which are true
    // here — so this project used to be skipped and produced no rows at all.
    expect(await isGitRepository(path.join(root, "_default"))).toBe(false);

    const { handle } = await graphProjectsFor(
      [
        {
          id: "p-vroomy",
          name: "Vroomy",
          workspace: { path: path.join(root, "_default"), repoUrl: null },
        },
      ],
      [root],
    );

    const result = await handle({ companyId: COMPANY });
    const repositories = result["repositories"] as Array<Record<string, unknown>>;

    expect(repositories).toHaveLength(3);
    expect(repositories.map((row) => row["repositoryKey"])).toEqual([
      "vroomy-backend",
      "vroomy-frontend",
      "vroomy-proto",
    ]);
    // Each names itself, because the project name would repeat down all three rows.
    expect(repositories.map((row) => row["name"])).toEqual([
      "vroomy-backend",
      "vroomy-frontend",
      "vroomy-proto",
    ]);
    // ...and the project still travels with the row.
    expect(repositories.every((row) => row["projectName"] === "Vroomy")).toBe(true);
    expect(result["skippedProjects"]).toBe(0);
  });

  it("lists a single nested checkout — the DEA shape", async () => {
    await checkout(path.join("_default", "dealthai"));

    // Same regression, one level in: the workspace root is not a repository.
    expect(await isGitRepository(path.join(root, "_default"))).toBe(false);

    const { handle } = await graphProjectsFor(
      [
        {
          id: "p-dea",
          name: "Dealthai",
          workspace: { path: path.join(root, "_default"), repoUrl: null },
        },
      ],
      [root],
    );

    const repositories = (await handle({ companyId: COMPANY }))["repositories"] as Array<
      Record<string, unknown>
    >;
    expect(repositories).toHaveLength(1);
    expect(repositories[0]!["repositoryKey"]).toBe("dealthai");
    // One checkout keeps the project's name: that is the label the operator gave it.
    expect(repositories[0]!["name"]).toBe("Dealthai");
    expect(repositories[0]!["repoName"]).toBe("dealthai");
  });

  it("keeps the ordinary single-checkout project working", async () => {
    await checkout("_default");

    const { handle } = await graphProjectsFor(
      [
        {
          id: "p-pos",
          name: "Point of Sale",
          workspace: { path: path.join(root, "_default"), repoUrl: "https://example.com/pos.git" },
        },
      ],
      [root],
    );

    const repositories = (await handle({ companyId: COMPANY }))["repositories"] as Array<
      Record<string, unknown>
    >;
    expect(repositories).toHaveLength(1);
    // `""` is the key for "the project's own checkout", not a missing value.
    expect(repositories[0]!["repositoryKey"]).toBe("");
  });

  it("still refuses to list a project with no code at all", async () => {
    // A backlog idea is not a repository, and a row for it would offer a button that
    // can only fail.
    fs.mkdirSync(path.join(root, "_default", "notes"), { recursive: true });

    const { handle } = await graphProjectsFor(
      [
        {
          id: "p-idea",
          name: "Someday",
          workspace: { path: path.join(root, "_default"), repoUrl: null },
        },
      ],
      [root],
    );

    const result = await handle({ companyId: COMPANY });
    expect(result["repositories"]).toEqual([]);
    expect(result["skippedProjects"]).toBe(1);
    expect(result["detail"]).toContain("none with a repository workspace");
  });

  it("never sends a host path to the browser", async () => {
    await checkout(path.join("_default", "vroomy-backend"));

    const { handle } = await graphProjectsFor(
      [
        {
          id: "p-vroomy",
          name: "Vroomy",
          workspace: { path: path.join(root, "_default"), repoUrl: null },
        },
      ],
      [root],
    );

    const result = await handle({ companyId: COMPANY });
    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain(root);
    expect(serialised).not.toContain("_default");
    // The key is a directory *name* relative to the workspace, which is safe to show
    // and is what every action sends back.
    expect(serialised).toContain("vroomy-backend");
  });
});
