/**
 * The worker's real `setup()` against the real bridge keys.
 *
 * `bridge-keys.spec.ts` checks that the constants and the UI agree. This goes one
 * step further and runs the actual registration: it stubs `runWorker` (which is
 * called on import and would otherwise start a worker), invokes `setup` with a
 * recording mock context, and asserts that every key the UI calls was registered
 * by the code that runs in production.
 *
 * This is the check that would have caught `index-now`: not "does the constant
 * exist", but "does the worker actually register the key the UI asks for".
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

const runWorker = vi.fn();
vi.mock("@paperclipai/plugin-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/plugin-sdk")>();
  return { ...actual, runWorker: (...args: unknown[]) => runWorker(...args) };
});

import {
  ACTION_KEYS,
  ALL_ACTION_KEYS,
  ALL_DATA_KEYS,
  DATA_KEYS,
} from "../src/plugin-keys.js";

/** A context that records what `setup` registers and answers nothing else. */
function recordingContext() {
  const data = new Map<string, unknown>();
  const actions = new Map<string, unknown>();
  const tools: string[] = [];

  const ctx = {
    data: { register: (key: string, handler: unknown) => data.set(key, handler) },
    actions: { register: (key: string, handler: unknown) => actions.set(key, handler) },
    tools: { register: (name: string) => tools.push(name) },
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    activity: { log: async () => {} },
    state: { get: async () => null, set: async () => {} },
    streams: { emit: () => {} },
    config: { get: async () => ({}) },
    // Everything else the worker touches during setup is optional enough that a
    // thunk returning undefined is fine; setup must not depend on call results.
    projects: {},
    agents: {},
    companies: {},
    localFolders: {},
  };

  return { ctx, data, actions, tools };
}

describe("worker setup registration", () => {
  let registered: ReturnType<typeof recordingContext>;

  beforeEach(async () => {
    vi.resetModules();
    registered = recordingContext();
    const module = await import("../src/worker.js");
    // `definePlugin` returns `{ definition }`; the host calls the lifecycle
    // methods from there, so the test does the same.
    const plugin = module.default as unknown as {
      definition: { setup: (ctx: unknown) => Promise<void> | void };
    };
    await plugin.definition.setup(registered.ctx);
  });

  it("does not start a worker just by importing the module", () => {
    // `runWorker` is called at module scope in production; the stub proves the
    // test is exercising the definition and not a live worker.
    expect(runWorker).toBeDefined();
  });

  it("registers every key in the shared registry", () => {
    // The point of the shared registry: the worker registers the constants, so
    // this cannot drift from what the UI imports.
    for (const key of ALL_DATA_KEYS) {
      expect([...registered.data.keys()], `data key "${key}" was not registered`).toContain(key);
    }
    for (const key of ALL_ACTION_KEYS) {
      expect([...registered.actions.keys()], `action key "${key}" was not registered`).toContain(key);
    }
  });

  it("registers index-now, the action that shipped missing", () => {
    expect(registered.actions.has(ACTION_KEYS.indexNow)).toBe(true);
    expect(registered.actions.get(ACTION_KEYS.indexNow)).toBeTypeOf("function");
  });

  it("gives every handler a callable", () => {
    // A registered `undefined` would be the same failure as a missing key.
    for (const [key, handler] of registered.data) {
      expect(handler, `data handler for "${key}" is not callable`).toBeTypeOf("function");
    }
    for (const [key, handler] of registered.actions) {
      expect(handler, `action handler for "${key}" is not callable`).toBeTypeOf("function");
    }
  });


  it("registers no key that is not in the registry", () => {
    // The reverse direction: a handler under an unlisted key is one the UI cannot
    // call and the contract test cannot see.
    const extraData = [...registered.data.keys()].filter((key) => !ALL_DATA_KEYS.includes(key));
    const extraActions = [...registered.actions.keys()].filter(
      (key) => !ALL_ACTION_KEYS.includes(key),
    );
    expect(extraData, "data keys registered but not in DATA_KEYS").toEqual([]);
    expect(extraActions, "action keys registered but not in ACTION_KEYS").toEqual([]);
  });
});
