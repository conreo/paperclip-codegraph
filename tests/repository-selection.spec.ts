/**
 * What an agent's CodeGraph call does when its project holds several repositories.
 *
 * The settings page was the reported symptom, but the same folder question decides
 * what an *agent* reads: a binding names the project's workspace, and for a
 * multi-repository project that workspace is a container holding every checkout. The
 * call used to hand CodeGraph the container, which reads no index and reports the
 * repository as unindexed even though it is indexed on the host.
 *
 * One checkout is unambiguous and is descended into. Several are not, and that is the
 * case worth testing here: the only two defensible answers are "refuse" and "pick
 * one", and picking one means an agent answers confidently out of a codebase nobody
 * chose. So the call is refused, and this asserts what the refusal says — because the
 * message is the entire fix from the operator's point of view: it is what tells them
 * which repositories exist and that one has to be bound.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const runWorker = vi.fn();
vi.mock("@paperclipai/plugin-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/plugin-sdk")>();
  return { ...actual, runWorker: (...args: unknown[]) => runWorker(...args) };
});

import { CODEGRAPH_TOOL_SPECS } from "../src/tools/catalog.js";

const COMPANY = "979ed243-a0ff-41a8-82c5-f8d2697c33a7";
const PROJECT = "e77f5825-b743-47db-b406-4108dedd22ab";

type ToolHandler = (
  params: Record<string, unknown>,
  runCtx: Record<string, unknown>,
) => Promise<{ error?: string; ok?: boolean }>;

/** The worker's `setup()`, with one company bound to a container folder. */
async function bindContainer(containerPath: string, roots: string[]): Promise<{
  call: ToolHandler;
  audits: Array<Record<string, unknown>>;
}> {
  vi.resetModules();
  const tools = new Map<string, ToolHandler>();
  const audits: Array<Record<string, unknown>> = [];

  const ctx = {
    data: { register: () => {} },
    actions: { register: () => {} },
    tools: {
      register: (name: string, _spec: unknown, handler: ToolHandler) => tools.set(name, handler),
    },
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    activity: {
      log: async (entry: Record<string, unknown>) => {
        audits.push(entry);
      },
    },
    state: {
      // Keyed the way the governance store keys it: one entry per company, plus
      // instance defaults. The company is on and its one project is bound to the
      // container folder — exactly what the settings page would have produced.
      get: async (key: { scopeKind?: string; scopeId?: string }) => {
        if (key.scopeKind !== "company") return {};
        return {
          enabled: true,
          defaultProjectKey: "vroomy",
          projects: { vroomy: { projectKey: "vroomy", path: containerPath } },
          projectsByPaperclipProject: { [PROJECT]: { projectKey: "vroomy" } },
          policy: { allowedTools: ["codegraph_explore"] },
        };
      },
      set: async () => {},
    },
    streams: { emit: () => {} },
    config: {
      get: async () => ({
        enabled: true,
        autoInstall: false,
        autoIndex: false,
        allowedProjectRoots: roots,
        // Deliberately not a real binary path: the refusal has to happen before
        // anything tries to run CodeGraph, or the message would be about the binary.
        codegraphCommand: "/nonexistent/codegraph",
      }),
    },
    projects: {},
    agents: {},
    companies: { get: async () => ({ name: "Vroomy" }) },
    localFolders: {},
  };

  const module = await import("../src/worker.js");
  const plugin = module.default as unknown as {
    definition: { setup: (ctx: unknown) => Promise<void> | void };
  };
  await plugin.definition.setup(ctx);

  const spec = CODEGRAPH_TOOL_SPECS[0]!;
  return { call: tools.get(spec.name) as ToolHandler, audits };
}

describe("a CodeGraph call in a project that holds several repositories", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pcg-toolcall-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const mkRepo = (name: string) => {
    fs.mkdirSync(path.join(root, "_default", name, ".git"), { recursive: true });
  };

  const runCtx = { companyId: COMPANY, projectId: PROJECT, agentId: "agent-1" };

  it("refuses, and names the repositories, instead of reading an arbitrary one", async () => {
    for (const name of ["vroomy-backend", "vroomy-frontend", "vroomy-proto"]) mkRepo(name);

    const { call } = await bindContainer(path.join(root, "_default"), [root]);
    const result = await call({ query: "where is the auth middleware" }, runCtx);

    expect(result.error).toBeTruthy();
    expect(result.error).toContain("holds 3 repositories");
    expect(result.error).toContain("vroomy-backend");
    expect(result.error).toContain("vroomy-frontend");
    expect(result.error).toContain("vroomy-proto");
    // The operator needs to know what to do, and the answer is governance.
    expect(result.error).toContain("bind one of them");
  });

  it("records the refusal, so it is answerable after the fact", async () => {
    // "The agent said CodeGraph refused" is not debuggable without the reason, and a
    // governance refusal and an ambiguous repository look the same from outside.
    for (const name of ["vroomy-backend", "vroomy-frontend"]) mkRepo(name);

    const { call, audits } = await bindContainer(path.join(root, "_default"), [root]);
    await call({ query: "anything" }, runCtx);

    const denial = audits.find(
      (entry) => (entry["metadata"] as Record<string, unknown> | undefined)?.["reason"] === "ambiguous_repository",
    );
    expect(denial, "no audit row recorded the ambiguous repository").toBeTruthy();
    expect(
      (denial!["metadata"] as Record<string, unknown>)["candidates"],
      "the count belongs in the audit; the names do not, they are already in the error",
    ).toBe(2);
  });

  it("does not refuse a project with a single nested checkout", async () => {
    // The DEA shape: one checkout is unambiguous. The call goes on to fail because
    // no CodeGraph binary is configured here, which is a *different* error — the
    // proof that the ambiguity check did not fire.
    mkRepo("dealthai");

    const { call } = await bindContainer(path.join(root, "_default"), [root]);
    const result = await call({ query: "anything" }, runCtx);

    expect(result.error).not.toContain("holds 1 repositories");
    expect(result.error).not.toContain("bind one of them");
  });

  it("does not refuse when the folder itself already answers", async () => {
    // A container with an index at it is a working deployment, not a mistake:
    // CodeGraph searches upward from the checkout and finds that index today. So the
    // index wins over the descent, the call proceeds, and — because no CodeGraph
    // binary is configured here — it fails on *that*, not on ambiguity. Descending
    // would instead have built a second index inside one of the checkouts.
    mkRepo("vroomy-backend");
    mkRepo("vroomy-frontend");
    fs.mkdirSync(path.join(root, "_default", ".codegraph"), { recursive: true });
    fs.writeFileSync(path.join(root, "_default", ".codegraph", "codegraph.db"), "");

    const { call } = await bindContainer(path.join(root, "_default"), [root]);
    const result = await call({ query: "anything" }, runCtx);

    expect(result.error).not.toContain("bind one of them");
    expect(result.error).not.toContain("repositories");
  });

  it("refuses a binding outside the allowed roots, before looking at checkouts", async () => {
    // Containment is validated first and the ambiguity check cannot weaken it: a
    // binding outside `allowedProjectRoots` is refused whether or not it happens to
    // hold repositories.
    fs.mkdirSync(path.join(root, "outside", "sneaky", ".git"), { recursive: true });

    const { call } = await bindContainer(path.join(root, "outside"), [path.join(root, "_default")]);
    const result = await call({ query: "anything" }, runCtx);

    expect(result.error).toContain("was refused");
    // Nothing about repositories: the path never got that far.
    expect(result.error).not.toContain("bind one of them");
    expect(result.error).not.toContain("sneaky");
  });
});
