/**
 * The bridge contract between the UI and the worker.
 *
 * This test exists because of a specific shipped defect: `index-now` was deleted
 * from the worker by an unrelated 0.7.0 refactor, and the UI kept calling it. The
 * bridge answered a missing key with an error object, the settings page rendered
 * it as `[object Object]`, and it stayed broken for four releases and a settings
 * page rewrite because nothing compared the two sides.
 *
 * The check is deliberately source-level: it reads the UI modules and asserts that
 * every key they ask for is registered, and that every registered key is either
 * called or explicitly listed as having no UI caller. A wrong key is a runtime
 * failure that types cannot see — both sides are plain strings — so the only place
 * to catch it is here.
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

import {
  ACTION_KEYS,
  ALL_ACTION_KEYS,
  ALL_DATA_KEYS,
  DATA_KEYS,
  KEYS_WITHOUT_UI_CALLER,
} from "../src/plugin-keys.js";

const UI_DIR = path.join(process.cwd(), "src", "ui");

/** Every `.tsx`/`.ts` module in the UI bundle, which is what the host loads. */
function uiSources(): Array<{ file: string; source: string }> {
  return fs
    .readdirSync(UI_DIR)
    .filter((name) => name.endsWith(".tsx") || name.endsWith(".ts"))
    .map((name) => ({ file: name, source: fs.readFileSync(path.join(UI_DIR, name), "utf8") }));
}

/**
 * Keys passed to one of the two bridge hooks, with the file they came from.
 *
 * Both call styles are matched: a string literal, and a `DATA_KEYS.x` /
 * `ACTION_KEYS.x` constant reference. The constants are what the UI and worker
 * actually share, so matching only literals would make this test pass while the
 * contract drifted — which is exactly how `index-now` stayed broken.
 */
function calledKeys(hook: "usePluginAction" | "usePluginData"): Map<string, string> {
  const found = new Map<string, string>();
  const pattern = new RegExp(
    `${hook}[<(][^"']*?(?:"([^"]+)"|(?:DATA_KEYS|ACTION_KEYS)\\.([A-Za-z0-9_]+))`,
    "g",
  );

  for (const { file, source } of uiSources()) {
    for (const match of source.matchAll(pattern)) {
      const literal = match[1];
      const member = match[2];
      let key: string | undefined = literal;
      if (!key && member) {
        // Resolve the constant reference back to the value the bridge sees. The
        // two tables are disjoint, so the member name alone identifies it.
        const table = (member in DATA_KEYS ? DATA_KEYS : ACTION_KEYS) as Record<string, string>;
        key = table[member];
      }
      if (key) found.set(key, file);
    }
  }
  return found;
}

describe("bridge keys — UI calls have handlers", () => {
  it("finds the UI sources it is meant to be checking", () => {
    // A silent zero here would make every assertion below vacuous.
    const sources = uiSources();
    expect(sources.length).toBeGreaterThanOrEqual(3);
    expect(sources.some((file) => file.file === "admin.tsx")).toBe(true);
  });

  it("every action the UI calls is registered by the worker", () => {
    const called = calledKeys("usePluginAction");
    expect(called.size).toBeGreaterThan(0);

    const missing = [...called.entries()]
      .filter(([key]) => !ALL_ACTION_KEYS.includes(key))
      .map(([key, file]) => `${key} (called in ${file})`);

    expect(missing, `UI calls actions the worker never registers: ${missing.join(", ")}`).toEqual(
      [],
    );
  });

  it("every data key the UI calls is registered by the worker", () => {
    const called = calledKeys("usePluginData");
    expect(called.size).toBeGreaterThan(0);

    const missing = [...called.entries()]
      .filter(([key]) => !ALL_DATA_KEYS.includes(key))
      .map(([key, file]) => `${key} (called in ${file})`);

    expect(missing, `UI calls data keys the worker never registers: ${missing.join(", ")}`).toEqual(
      [],
    );
  });

  it("registers `index-now`, the key whose absence shipped as [object Object]", () => {
    // Named explicitly so a future refactor that deletes it again fails here
    // rather than in an operator's browser.
    expect(ALL_ACTION_KEYS).toContain("index-now");
    expect(calledKeys("usePluginAction").has("index-now")).toBe(true);
  });

  it("accounts for every registered key", () => {
    const called = new Set([
      ...calledKeys("usePluginAction").keys(),
      ...calledKeys("usePluginData").keys(),
    ]);

    const unaccounted = [...ALL_ACTION_KEYS, ...ALL_DATA_KEYS].filter(
      (key) => !called.has(key) && !KEYS_WITHOUT_UI_CALLER.includes(key),
    );

    expect(
      unaccounted,
      "these keys are registered but neither called by the UI nor listed in KEYS_WITHOUT_UI_CALLER",
    ).toEqual([]);
  });

  it("does not list a key as UI-less while the UI calls it", () => {
    // The list is a record of intent, so it must not go stale in the other
    // direction either.
    const called = new Set([
      ...calledKeys("usePluginAction").keys(),
      ...calledKeys("usePluginData").keys(),
    ]);
    const contradictory = KEYS_WITHOUT_UI_CALLER.filter((key) => called.has(key));
    expect(contradictory, "listed as having no UI caller, but the UI calls them").toEqual([]);
  });

  it("has no duplicate key values", () => {
    // Two handlers under one key would mean one of them silently never runs.
    expect(new Set(ALL_ACTION_KEYS).size).toBe(ALL_ACTION_KEYS.length);
    expect(new Set(ALL_DATA_KEYS).size).toBe(ALL_DATA_KEYS.length);
  });
});
