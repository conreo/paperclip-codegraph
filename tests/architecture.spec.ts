import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  MODULE_HEIGHT,
  REFERENCE_EDGE_KINDS,
  assignLayers,
  buildRepoMap,
  chooseModuleDepth,
  findCycles,
  findUnreferenced,
  groupRoutes,
  parseRoute,
  isGeneratedFile,
  isTestFile,
  layoutMap,
  moduleOf,
  type DeadCandidate,
  type IndexedEdge,
  type IndexedFile,
  type MapLinkInput,
  type MapModuleInput,
} from "../src/graph/architecture.js";

function module(id: string, overrides: Partial<MapModuleInput> = {}): MapModuleInput {
  return { id, label: id, files: 1, symbols: 1, test: false, generated: false, ...overrides };
}

function link(source: string, target: string, count = 5, declared = 5): MapLinkInput {
  return { source, target, count, declared };
}

const OPTIONS = { weakLinkThreshold: 4, includeWeak: false };

describe("assignLayers — one layer above what a module depends on", () => {
  it("puts a dependency below its dependent", () => {
    // "app depends on db" ⇒ app sits above db, so reading down follows the flow.
    const { layer } = assignLayers([module("app"), module("db")], [link("app", "db")]);
    expect(layer.get("app")).toBe(1);
    expect(layer.get("db")).toBe(0);
  });

  it("uses the longest path, so a dependency is always below everything that needs it", () => {
    // a → b → c, and a → c directly. c must sit below b, not beside it.
    const { layer } = assignLayers(
      [module("a"), module("b"), module("c")],
      [link("a", "b"), link("b", "c"), link("a", "c")],
    );
    expect(layer.get("c")).toBe(0);
    expect(layer.get("b")).toBe(1);
    expect(layer.get("a")).toBe(2);
  });

  it("gives an unconnected module its own layer", () => {
    const { layer } = assignLayers([module("lonely")], []);
    expect(layer.get("lonely")).toBe(0);
  });

  it("breaks a cycle instead of looping forever", () => {
    // a ↔ b has no valid layer order. One edge must be dropped from the layering
    // and marked as a back edge; the other still orders the pair.
    const { layer, backEdges } = assignLayers(
      [module("a"), module("b")],
      [link("a", "b"), link("b", "a")],
    );
    expect(backEdges.size).toBe(1);
    expect(layer.get("a")).not.toBe(layer.get("b"));
  });

  it("breaks a three-module cycle", () => {
    const { layer, backEdges } = assignLayers(
      [module("a"), module("b"), module("c")],
      [link("a", "b"), link("b", "c"), link("c", "a")],
    );
    expect(backEdges.size).toBe(1);
    const values = [layer.get("a")!, layer.get("b")!, layer.get("c")!];
    expect(new Set(values).size).toBe(3);
  });

  it("ignores self-links when layering", () => {
    // A self-link cannot place a module above itself.
    const { layer, backEdges } = assignLayers([module("a")], [link("a", "a")]);
    expect(layer.get("a")).toBe(0);
    expect(backEdges.size).toBe(0);
  });

  it("ignores links to modules that are not in the set", () => {
    const { layer } = assignLayers([module("a")], [link("a", "ghost")]);
    expect(layer.get("a")).toBe(0);
  });

  it("is deterministic regardless of input order", () => {
    // The same index must draw the same picture, or the map is unreadable across
    // reloads.
    const modules = [module("a"), module("b"), module("c")];
    const links = [link("a", "b"), link("b", "c")];
    const first = assignLayers(modules, links).layer;
    const second = assignLayers([...modules].reverse(), [...links].reverse()).layer;
    expect([...second.entries()].sort()).toEqual([...first.entries()].sort());
  });
});

describe("findCycles", () => {
  it("finds a two-module cycle", () => {
    const cycles = findCycles([module("a"), module("b")], [link("a", "b"), link("b", "a")]);
    expect(cycles).toHaveLength(1);
    expect(cycles[0]!.sort()).toEqual(["a", "b"]);
  });

  it("finds a three-module cycle", () => {
    const cycles = findCycles(
      [module("a"), module("b"), module("c")],
      [link("a", "b"), link("b", "c"), link("c", "a")],
    );
    expect(cycles).toHaveLength(1);
    expect(cycles[0]!.sort()).toEqual(["a", "b", "c"]);
  });

  it("reports a self-dependency as a cycle", () => {
    expect(findCycles([module("a")], [link("a", "a")])).toEqual([["a"]]);
  });

  it("reports no cycle for a plain chain", () => {
    expect(
      findCycles([module("a"), module("b"), module("c")], [link("a", "b"), link("b", "c")]),
    ).toEqual([]);
  });

  it("keeps separate cycles separate", () => {
    const cycles = findCycles(
      [module("a"), module("b"), module("x"), module("y")],
      [link("a", "b"), link("b", "a"), link("x", "y"), link("y", "x")],
    );
    expect(cycles).toHaveLength(2);
    for (const cycle of cycles) expect(cycle).toHaveLength(2);
  });

  it("orders the largest cycle first", () => {
    const cycles = findCycles(
      [module("a"), module("b"), module("x"), module("y"), module("z")],
      [link("a", "b"), link("b", "a"), link("x", "y"), link("y", "z"), link("z", "x")],
    );
    expect(cycles[0]).toHaveLength(3);
  });
});

describe("layoutMap", () => {
  const modules = [
    module("app"),
    module("api"),
    module("db"),
    module("util"),
  ];
  const links = [link("app", "api"), link("api", "db"), link("db", "util"), link("app", "db")];

  it("places every module and gives each a position", () => {
    const layout = layoutMap(modules, links, OPTIONS);
    expect(layout.modules).toHaveLength(4);
    for (const positioned of layout.modules) {
      expect(Number.isFinite(positioned.x)).toBe(true);
      expect(Number.isFinite(positioned.y)).toBe(true);
      expect(positioned.width).toBeGreaterThan(0);
      expect(positioned.height).toBe(MODULE_HEIGHT);
    }
  });

  it("separates layers vertically and keeps every module inside the canvas", () => {
    const layout = layoutMap(modules, links, OPTIONS);
    for (const positioned of layout.modules) {
      expect(positioned.x).toBeGreaterThanOrEqual(0);
      expect(positioned.x + positioned.width).toBeLessThanOrEqual(layout.width);
      expect(positioned.y).toBeGreaterThanOrEqual(0);
      expect(positioned.y + positioned.height).toBeLessThanOrEqual(layout.height);
    }
  });

  it("does not overlap two modules in the same layer", () => {
    // `root` depends on three siblings, so all three share the layer below it.
    const layout = layoutMap(
      [module("a"), module("b"), module("c"), module("root")],
      [link("root", "a"), link("root", "b"), link("root", "c")],
      OPTIONS,
    );
    const row = layout.modules.filter((m) => m.layer === 0).sort((x, y) => x.x - y.x);
    expect(row).toHaveLength(3);
    for (let i = 1; i < row.length; i += 1) {
      const previous = row[i - 1]!;
      const current = row[i]!;
      expect(current.x).toBeGreaterThanOrEqual(previous.x + previous.width);
    }
  });

  it("counts dependents and marks the unreferenced", () => {
    const layout = layoutMap(modules, links, OPTIONS);
    const byId = new Map(layout.modules.map((m) => [m.id, m]));
    expect(byId.get("db")!.dependents).toBe(2); // app and api
    expect(byId.get("app")!.unreferenced).toBe(true);
    expect(byId.get("app")!.weight).toBe(0);
  });

  it("scales the weight against the most depended-on module", () => {
    const layout = layoutMap(modules, links, OPTIONS);
    const byId = new Map(layout.modules.map((m) => [m.id, m]));
    expect(byId.get("db")!.weight).toBe(1);
    expect(byId.get("util")!.weight).toBeGreaterThan(0);
    expect(byId.get("util")!.weight).toBeLessThan(1);
  });

  it("hides weak links and reports how many", () => {
    // `x → y` is a one-off reference between modules in no cycle, so it is noise
    // until a module it touches is selected.
    const layout = layoutMap(
      [module("x"), module("y"), module("a"), module("b")],
      [link("x", "y", 1), link("a", "b", 1), link("b", "a", 9)],
      OPTIONS,
    );
    expect(layout.hiddenWeakLinks).toBe(1);
    // The strong link and both cycle links survive.
    expect(layout.links).toHaveLength(2);
  });

  it("draws weak links when asked", () => {
    const layout = layoutMap(
      [module("x"), module("y")],
      [link("x", "y", 1)],
      { ...OPTIONS, includeWeak: true },
    );
    expect(layout.hiddenWeakLinks).toBe(0);
    expect(layout.links).toHaveLength(1);
  });

  it("keeps weak links that touch a cycle, so a cycle is never broken up", () => {
    // Hiding half a cycle would draw a lie: a cycle missing an edge is not a cycle.
    const layout = layoutMap(
      [module("a"), module("b")],
      [link("a", "b", 1), link("b", "a", 1)],
      OPTIONS,
    );
    expect(layout.links).toHaveLength(2);
    expect(layout.hiddenWeakLinks).toBe(0);
  });

  it("marks back edges so they can be drawn as the lighter half", () => {
    const layout = layoutMap(
      [module("a"), module("b")],
      [link("a", "b", 9), link("b", "a", 9)],
      OPTIONS,
    );
    expect(layout.links.filter((l) => l.back)).toHaveLength(1);
  });

  it("gives every drawn link a real path", () => {
    const layout = layoutMap(modules, links, OPTIONS);
    expect(layout.links.length).toBeGreaterThan(0);
    for (const drawn of layout.links) {
      expect(drawn.path.startsWith("M ")).toBe(true);
      expect(drawn.path).toContain(" C ");
      expect(drawn.path).not.toContain("NaN");
    }
  });

  it("drops links whose endpoints are not modules", () => {
    const layout = layoutMap([module("a")], [link("a", "ghost")], OPTIONS);
    expect(layout.links).toEqual([]);
  });

  it("returns an empty canvas for an empty repository", () => {
    const layout = layoutMap([], [], OPTIONS);
    expect(layout.modules).toEqual([]);
    expect(layout.links).toEqual([]);
    expect(layout.width).toBeGreaterThan(0);
    expect(layout.height).toBeGreaterThan(0);
    expect(layout.layers).toBe(0);
  });

  it("is deterministic", () => {
    const first = layoutMap(modules, links, OPTIONS);
    const second = layoutMap(modules, links, OPTIONS);
    expect(second.modules).toEqual(first.modules);
    expect(second.links).toEqual(first.links);
  });

  it("reports the cycle it found", () => {
    const layout = layoutMap(
      [module("a"), module("b"), module("c")],
      [link("a", "b"), link("b", "c"), link("c", "a")],
      OPTIONS,
    );
    expect(layout.cycles).toHaveLength(1);
    expect(layout.cycles[0]).toHaveLength(3);
  });
});

describe("chooseModuleDepth", () => {
  const paths = [
    "frontend/src/components/Button.tsx",
    "frontend/src/components/Input.tsx",
    "frontend/src/api/client.ts",
    "backend/src/db/pool.ts",
    "backend/src/db/migrate.ts",
    "backend/src/core/order.ts",
  ];

  it("picks a depth that separates the top-level folders", () => {
    const depth = chooseModuleDepth(paths, { maxModules: 40, maxDepth: 4 });
    expect(depth).toBeGreaterThanOrEqual(1);
  });

  it("steps back one level when a cut would exceed the module budget", () => {
    // Depth 3 gives frontend/src/components etc. With a budget of 2 that is too
    // many boxes, so the coarser cut is chosen.
    const depth = chooseModuleDepth(paths, { maxModules: 2, maxDepth: 4 });
    expect(depth).toBeLessThanOrEqual(2);
  });

  it("never returns a depth where every file is its own module", () => {
    const depth = chooseModuleDepth(paths, { maxModules: 500, maxDepth: 8 });
    const buckets = new Set(paths.map((p) => moduleOf(p, depth)));
    expect(buckets.size).toBeLessThan(paths.length);
  });

  it("handles an empty repository", () => {
    expect(chooseModuleDepth([], { maxModules: 40, maxDepth: 4 })).toBe(1);
  });
});

describe("moduleOf", () => {
  it("keeps the first segments as the module", () => {
    expect(moduleOf("backend/src/db/pool.ts", 2)).toBe("backend/src");
    expect(moduleOf("backend/src/db/pool.ts", 3)).toBe("backend/src/db");
  });

  it("puts a file with no directory in the root module", () => {
    // CodeGraph labels this "(root files)" and shows its file list, rather than
    // discarding it.
    expect(moduleOf("docker-compose.yml", 3)).toBe("(root files)");
    expect(moduleOf("AGENTS.md", 1)).toBe("(root files)");
  });

  it("does not name a module after the file itself", () => {
    // A cut at or past the file's own depth must still yield a directory.
    expect(moduleOf("src/index.ts", 1)).toBe("src");
    expect(moduleOf("src/index.ts", 5)).toBe("src");
  });
});

describe("isTestFile", () => {
  it("recognises the conventions that occur", () => {
    for (const path of [
      "backend/src/db/pool.test.ts",
      "frontend/src/components/Button.spec.tsx",
      "e2e/checkout.spec.ts",
      "backend/__tests__/orders.ts",
      "pos-table-grid/tests/helper.ts",
    ]) {
      expect(isTestFile(path), path).toBe(true);
    }
  });

  it("does not flag ordinary source", () => {
    for (const path of ["backend/src/db/pool.ts", "frontend/src/api/client.ts", "src/latest.ts"]) {
      expect(isTestFile(path), path).toBe(false);
    }
  });
});

describe("isGeneratedFile", () => {
  it("recognises generated output", () => {
    for (const path of ["dist/index.js", "src/generated/types.ts", "src/api.gen.ts", "build/out.js"]) {
      expect(isGeneratedFile(path), path).toBe(true);
    }
  });

  it("does not flag hand-written source", () => {
    for (const path of ["src/general.ts", "backend/src/db/pool.ts"]) {
      expect(isGeneratedFile(path), path).toBe(false);
    }
  });
});

describe("buildRepoMap — turning an index into a map", () => {
  const files: IndexedFile[] = [
    { filePath: "frontend/src/components/Button.tsx", fileKind: "component", nodes: 3 },
    { filePath: "frontend/src/components/Input.tsx", fileKind: "component", nodes: 4 },
    { filePath: "frontend/src/api/client.ts", fileKind: "file", nodes: 2 },
    { filePath: "backend/src/db/pool.ts", fileKind: "file", nodes: 5 },
    { filePath: "backend/src/core/order.ts", fileKind: "file", nodes: 6 },
    { filePath: "backend/src/core/order.test.ts", fileKind: "file", nodes: 1 },
    { filePath: "docker-compose.yml", fileKind: "file", nodes: 0 },
  ];

  const edges: IndexedEdge[] = [
    { sourceFile: "frontend/src/components/Button.tsx", targetFile: "frontend/src/api/client.ts", kind: "imports" },
    { sourceFile: "frontend/src/api/client.ts", targetFile: "backend/src/db/pool.ts", kind: "calls" },
    { sourceFile: "backend/src/core/order.ts", targetFile: "backend/src/db/pool.ts", kind: "imports" },
    // Same-module edge: must not become a link.
    { sourceFile: "backend/src/db/pool.ts", targetFile: "backend/src/db/other.ts", kind: "calls" },
    // Unresolvable: counted, not silently dropped.
    { sourceFile: null, targetFile: "backend/src/db/pool.ts", kind: "references" },
  ];

  it("groups files into modules one layer above them", () => {
    const map = buildRepoMap(files, edges, { maxModules: 60, maxDepth: 3 });
    const ids = map.modules.map((m) => m.id);
    expect(ids.length).toBeGreaterThan(0);
    // Every module owns at least one file.
    for (const module of map.modules) expect(module.files).toBeGreaterThan(0);
  });

  it("puts a root-level file in a module rather than dropping it", () => {
    // CodeGraph calls this "(root files)" and still shows it.
    const map = buildRepoMap(files, edges, { maxModules: 60, maxDepth: 3 });
    expect(map.modules.some((m) => m.id.includes("root"))).toBe(true);
  });

  it("counts symbols per module", () => {
    const map = buildRepoMap(files, edges, { maxModules: 60, maxDepth: 3 });
    const total = map.modules.reduce((sum, m) => sum + m.symbols, 0);
    expect(total).toBe(files.reduce((sum, f) => sum + f.nodes, 0));
  });

  it("makes links only between different modules", () => {
    const map = buildRepoMap(files, edges, { maxModules: 60, maxDepth: 3 });
    for (const link of map.links) expect(link.source).not.toBe(link.target);
  });

  it("counts declared references separately from raw ones", () => {
    // The layering prefers declared links; the UI says when it could not.
    const map = buildRepoMap(files, edges, { maxModules: 60, maxDepth: 3 });
    for (const link of map.links) expect(link.declared).toBeLessThanOrEqual(link.count);
  });

  it("marks a module whose files are mostly tests", () => {
    const map = buildRepoMap(
      [
        { filePath: "src/a/x.test.ts", fileKind: "file", nodes: 1 },
        { filePath: "src/a/y.test.ts", fileKind: "file", nodes: 1 },
      ],
      [],
      { maxModules: 60, maxDepth: 3 },
    );
    expect(map.modules[0]!.test).toBe(true);
  });

  it("reports unresolvable edges instead of silently losing them", () => {
    const map = buildRepoMap(files, edges, { maxModules: 60, maxDepth: 3 });
    expect(map.unresolvedEdges).toBe(1);
  });

  it("offers subtree choices with real file counts", () => {
    const map = buildRepoMap(files, edges, { maxModules: 60, maxDepth: 3 });
    expect(map.roots[0]).toEqual({ root: "", label: "whole repository", files: files.length });
    const frontend = map.roots.find((r) => r.root === "frontend");
    expect(frontend?.files).toBe(3);
  });

  it("scopes to a subtree when asked", () => {
    const map = buildRepoMap(files, edges, { root: "frontend", maxModules: 60, maxDepth: 3 });
    const total = map.modules.reduce((sum, m) => sum + m.files, 0);
    expect(total).toBe(3);
  });

  it("respects an explicit depth and reports it as not automatic", () => {
    const map = buildRepoMap(files, edges, { depth: 2, maxModules: 60, maxDepth: 4 });
    expect(map.depth).toBe(2);
    expect(map.depthIsAutomatic).toBe(false);
  });

  it("handles an empty repository", () => {
    const map = buildRepoMap([], [], { maxModules: 60, maxDepth: 4 });
    expect(map.modules).toEqual([]);
    expect(map.links).toEqual([]);
    expect(map.roots).toEqual([{ root: "", label: "whole repository", files: 0 }]);
  });
});

describe("parseRoute", () => {
  it("splits the method from the path", () => {
    expect(parseRoute("GET /api/health")).toEqual({ method: "GET", path: "/api/health" });
    expect(parseRoute("POST /api/v1/modules/alcohol/log")).toEqual({
      method: "POST",
      path: "/api/v1/modules/alcohol/log",
    });
  });

  it("keeps a route with no method whole rather than guessing", () => {
    // A dynamically registered route may genuinely have no verb the graph saw.
    expect(parseRoute("/api/thing")).toEqual({ method: null, path: "/api/thing" });
  });

  it("tolerates extra spacing", () => {
    expect(parseRoute("  GET   /a/b  ")).toEqual({ method: "GET", path: "/a/b" });
  });

  it("does not mistake a lowercase word for a method", () => {
    expect(parseRoute("get /a")).toEqual({ method: null, path: "get /a" });
  });
});

describe("groupRoutes", () => {
  const routes = [
    { id: "r2", method: "POST", path: "/b", filePath: "b.ts", line: 1, handler: "h", handlerFile: "b.ts", handlerLine: 2, handlerId: "fn:h" },
    { id: "r1", method: "GET", path: "/a", filePath: "a.ts", line: 1, handler: null, handlerFile: null, handlerLine: null, handlerId: null },
  ];

  it("orders by path so the list can be scanned", () => {
    expect(groupRoutes(routes).entries.map((r) => r.path)).toEqual(["/a", "/b"]);
  });

  it("counts routes with and without a handler", () => {
    const grouped = groupRoutes(routes);
    expect(grouped.withHandler).toBe(1);
    expect(grouped.withoutHandler).toBe(1);
  });

  it("keys by method and path, since one path can serve several verbs", () => {
    const grouped = groupRoutes([
      ...routes,
      { id: "r3", method: "DELETE", path: "/a", filePath: "a.ts", line: 9, handler: null, handlerFile: null, handlerLine: null, handlerId: null },
    ]);
    expect(grouped.byPath.has("GET /a")).toBe(true);
    expect(grouped.byPath.has("DELETE /a")).toBe(true);
  });
});

describe("findUnreferenced", () => {
  const symbol = (id: string, filePath = "src/a.ts"): DeadCandidate => ({
    id,
    name: id,
    qualifiedName: id,
    kind: "function",
    filePath,
    startLine: 1,
    endLine: 2,
  });

  const base = {
    referenced: new Set<string>(),
    entryPoints: new Set<string>(),
    unreachableFiles: new Set<string>(),
    limit: 100,
  };

  it("lists a symbol nothing reaches", () => {
    const report = findUnreferenced([symbol("unused")], base);
    expect(report.candidates.map((c) => c.id)).toEqual(["unused"]);
  });

  it("excludes a referenced symbol and counts why", () => {
    const report = findUnreferenced([symbol("used")], {
      ...base,
      referenced: new Set(["used"]),
    });
    expect(report.candidates).toEqual([]);
    expect(report.excluded.find((e) => e.reason === "referenced")?.count).toBe(1);
  });

  it("never reports an entry point as dead", () => {
    // A route handler has no inbound call edge by design; calling it unused would
    // be wrong every time.
    const report = findUnreferenced([symbol("handler")], {
      ...base,
      entryPoints: new Set(["handler"]),
    });
    expect(report.candidates).toEqual([]);
    expect(report.excluded.find((e) => e.reason === "entry point")?.count).toBe(1);
  });

  it("sets aside symbols in files nothing reaches", () => {
    // "This whole file is unreachable" is a different fact from "this symbol is
    // unused", and mixing them makes both harder to act on.
    const report = findUnreferenced([symbol("x", "src/orphan.ts")], {
      ...base,
      unreachableFiles: new Set(["src/orphan.ts"]),
    });
    expect(report.candidates).toEqual([]);
    expect(report.excluded.find((e) => e.reason === "in a file nothing reaches")?.count).toBe(1);
  });

  it("orders candidates by file then line, so a file's candidates sit together", () => {
    const report = findUnreferenced(
      [
        { ...symbol("b"), filePath: "src/z.ts", startLine: 5 },
        { ...symbol("a"), filePath: "src/a.ts", startLine: 9 },
        { ...symbol("c"), filePath: "src/a.ts", startLine: 2 },
      ],
      base,
    );
    expect(report.candidates.map((c) => c.id)).toEqual(["c", "a", "b"]);
  });

  it("reports the true total while capping the list", () => {
    const many = Array.from({ length: 300 }, (_, i) => symbol(`s${i}`));
    const report = findUnreferenced(many, { ...base, limit: 50 });
    expect(report.candidates).toHaveLength(50);
    expect(report.totalCandidates).toBe(300);
  });

  it("always reports every exclusion reason, even at zero", () => {
    // The counts are what make the list interpretable; a missing row would read as
    // "nothing was excluded" rather than "nothing of that kind".
    const report = findUnreferenced([symbol("x")], base);
    expect(report.excluded.map((e) => e.reason).sort()).toEqual([
      "entry point",
      "in a file nothing reaches",
      "referenced",
    ]);
  });
});

describe("REFERENCE_EDGE_KINDS — the rule that this view depends on", () => {
  it("excludes `contains`, which is not a reference", () => {
    // The bug this pins: `contains` is the file→symbol parent relation and the
    // index has one for *every* symbol. Counting it as a reference made the
    // referenced set equal to the symbol set, so the dead-code view could only
    // ever return nothing — which is exactly what it did on the real POS index
    // (2,352 symbols, 0 candidates) until this list existed.
    expect(REFERENCE_EDGE_KINDS).not.toContain("contains");
  });

  it("includes the kinds that do mean a reference", () => {
    for (const kind of ["calls", "imports", "references", "instantiates"]) {
      expect(REFERENCE_EDGE_KINDS).toContain(kind);
    }
  });

  it("is accompanied by a query that filters on it", () => {
    // A constant nobody uses is a comment. The worker must actually filter.
    const worker = readFileSync(
      join(process.cwd(), "src", "worker.ts"),
      "utf8",
    );
    expect(worker).toContain("REFERENCE_EDGE_KINDS");
    expect(worker).toMatch(/kind IN \(\$\{placeholders\}\)/);
  });
});
