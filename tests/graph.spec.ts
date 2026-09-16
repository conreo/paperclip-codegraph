import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  GraphUnavailable,
  MAX_GRAPH_NODES,
  assertSchema,
  neighbourhood,
  searchNodes,
} from "../src/graph/neighbourhood.js";

/**
 * Build a real CodeGraph-shaped index, so the SQL is exercised rather than
 * mocked. The schema below is copied from a live `.codegraph/codegraph.db`.
 */
function makeIndex(options: { nodes?: boolean; columns?: boolean } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pcg-graph-"));
  const dir = path.join(root, ".codegraph");
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, "codegraph.db");
  const db = new DatabaseSync(dbPath);
  if (options.columns !== false) {
    db.exec(`CREATE TABLE nodes (
      id TEXT PRIMARY KEY, kind TEXT, name TEXT, qualified_name TEXT,
      file_path TEXT, language TEXT, start_line INTEGER, end_line INTEGER)`);
    db.exec(`CREATE TABLE edges (
      id TEXT PRIMARY KEY, source TEXT, target TEXT, kind TEXT, provenance TEXT)`);
  }
  if (options.nodes !== false) {
    const insertNode = db.prepare(
      "INSERT INTO nodes VALUES (?,?,?,?,?,?,?,?)",
    );
    // n1 <- n2 <- n3  (a chain of callers), n1 -> n4 (a callee)
    insertNode.run("n1", "function", "createOrder", "order.createOrder", "src/order.ts", "ts", 10, 40);
    insertNode.run("n2", "function", "handleRequest", "api.handleRequest", "src/api.ts", "ts", 5, 20);
    insertNode.run("n3", "function", "route", "api.route", "src/routes.ts", "ts", 1, 9);
    insertNode.run("n4", "function", "saveOrder", "db.saveOrder", "src/db.ts", "ts", 50, 60);
    insertNode.run("n5", "class", "OrderService", "order.OrderService", "src/service.ts", "ts", 1, 100);
    const insertEdge = db.prepare("INSERT INTO edges VALUES (?,?,?,?,?)");
    insertEdge.run("e1", "n2", "n1", "calls", "static");
    insertEdge.run("e2", "n3", "n2", "calls", "static");
    insertEdge.run("e3", "n1", "n4", "calls", "static");
    insertEdge.run("e4", "n1", "n5", "references", "static");
  }
  db.close();
  return root;
}

describe("assertSchema", () => {
  it("accepts a real-shaped index", () => {
    const root = makeIndex();
    const db = new DatabaseSync(path.join(root, ".codegraph", "codegraph.db"), { readOnly: true });
    expect(() => assertSchema(db)).not.toThrow();
    db.close();
  });

  it("fails closed when a column is missing, rather than returning empty", () => {
    const root = makeIndex();
    const dbPath = path.join(root, ".codegraph", "codegraph.db");
    const db = new DatabaseSync(dbPath);
    db.exec("ALTER TABLE nodes RENAME TO nodes_old");
    db.exec("CREATE TABLE nodes (id TEXT, name TEXT)"); // missing the rest
    expect(() => assertSchema(db)).toThrow(/schema has changed/);
    db.close();
  });

  it("reports schema drift with a reason, not a crash", () => {
    const root = makeIndex();
    const db = new DatabaseSync(path.join(root, ".codegraph", "codegraph.db"));
    db.exec("DROP TABLE edges");
    try {
      assertSchema(db);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(GraphUnavailable);
      expect((error as GraphUnavailable).reason).toBe("schema_drift");
      // The message must say the tools are unaffected, or an operator will think
      // CodeGraph itself is broken.
      expect((error as GraphUnavailable).message).toMatch(/tools are unaffected/);
    }
    db.close();
  });
});

describe("neighbourhood", () => {
  it("returns the seed alone at depth 0-ish (minimum is 1 hop)", () => {
    const root = makeIndex();
    const graph = neighbourhood(root, "n1", 1);
    expect(graph.nodes.map((n) => n.id).sort()).toEqual(["n1", "n2", "n4", "n5"]);
  });

  it("preserves edge direction so callers and callees are distinguishable", () => {
    const root = makeIndex();
    const graph = neighbourhood(root, "n1", 1);
    const caller = graph.edges.find((e) => e.source === "n2");
    const callee = graph.edges.find((e) => e.target === "n4");
    expect(caller).toEqual({ source: "n2", target: "n1", kind: "calls" });
    expect(callee).toEqual({ source: "n1", target: "n4", kind: "calls" });
  });

  it("walks further with depth and finds the grandparent caller", () => {
    const root = makeIndex();
    const oneHop = neighbourhood(root, "n1", 1).nodes.map((n) => n.id);
    const twoHops = neighbourhood(root, "n1", 2).nodes.map((n) => n.id);
    expect(oneHop).not.toContain("n3");
    expect(twoHops).toContain("n3");
  });

  it("returns every edge kind it traverses, labelled", () => {
    const root = makeIndex();
    const graph = neighbourhood(root, "n1", 1);
    expect(graph.edgeKinds).toEqual(["calls", "references"]);
    expect(graph.edges.some((e) => e.kind === "references")).toBe(true);
  });

  it("never returns an edge with a missing endpoint", () => {
    const root = makeIndex();
    const ids = new Set(neighbourhood(root, "n1", 2).nodes.map((n) => n.id));
    for (const edge of neighbourhood(root, "n1", 2).edges) {
      expect(ids.has(edge.source)).toBe(true);
      expect(ids.has(edge.target)).toBe(true);
    }
  });

  it("carries file and line so the UI can show where a node lives", () => {
    const root = makeIndex();
    const seed = neighbourhood(root, "n1", 1).nodes.find((n) => n.id === "n1");
    expect(seed).toMatchObject({
      name: "createOrder",
      kind: "function",
      filePath: "src/order.ts",
      startLine: 10,
    });
  });

  it("fails with not_indexed when there is no index at all", () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "pcg-noidx-"));
    try {
      neighbourhood(empty, "n1");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as GraphUnavailable).reason).toBe("not_indexed");
      expect((error as GraphUnavailable).message).toMatch(/no CodeGraph index/);
    }
  });

  it("reports an unknown seed rather than an empty graph", () => {
    const root = makeIndex();
    expect(() => neighbourhood(root, "nope")).toThrow(/No symbol with id/);
  });

  it("stops at the node ceiling and says it did", () => {
    const root = makeIndex();
    // A star: one hub with more leaves than the ceiling allows.
    const db = new DatabaseSync(path.join(root, ".codegraph", "codegraph.db"));
    const insertNode = db.prepare("INSERT INTO nodes VALUES (?,?,?,?,?,?,?,?)");
    const insertEdge = db.prepare("INSERT INTO edges VALUES (?,?,?,?,?)");
    for (let i = 0; i < MAX_GRAPH_NODES + 40; i += 1) {
      insertNode.run(`leaf${i}`, "function", `leaf${i}`, `x.leaf${i}`, "src/x.ts", "ts", 1, 2);
      insertEdge.run(`ex${i}`, "n1", `leaf${i}`, "calls", "static");
    }
    db.close();
    const graph = neighbourhood(root, "n1", 1);
    expect(graph.truncated).toBe(true);
    expect(graph.nodes.length).toBeLessThanOrEqual(MAX_GRAPH_NODES);
  });
});

describe("searchNodes", () => {
  it("finds by name and by qualified name", () => {
    const root = makeIndex();
    expect(searchNodes(root, "createOrder").map((n) => n.id)).toContain("n1");
    expect(searchNodes(root, "order.OrderService").map((n) => n.id)).toContain("n5");
  });

  it("puts the shortest name first, so an exact-ish match wins", () => {
    const root = makeIndex();
    const db = new DatabaseSync(path.join(root, ".codegraph", "codegraph.db"));
    db.prepare("INSERT INTO nodes VALUES (?,?,?,?,?,?,?,?)").run(
      "n9", "function", "createOrderWithEverything", "x.y", "src/y.ts", "ts", 1, 2,
    );
    db.close();
    expect(searchNodes(root, "createOrder")[0]?.id).toBe("n1");
  });

  it("returns nothing for a term that is not there, without throwing", () => {
    const root = makeIndex();
    expect(searchNodes(root, "definitelyNotHere")).toEqual([]);
  });

  it("treats LIKE wildcards in the query as literal text", () => {
    const root = makeIndex();
    // "%" must not match everything — an operator typing it is not a wildcard.
    expect(searchNodes(root, "%")).toEqual([]);
  });

  it("fails with a clear reason when there is no index", () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "pcg-noidx2-"));
    expect(() => searchNodes(empty, "x")).toThrow(GraphUnavailable);
  });
});
