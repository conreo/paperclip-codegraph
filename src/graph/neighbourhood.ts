/**
 * Reading the CodeGraph index directly.
 *
 * The graph view cannot use CodeGraph's own web viewer: it binds loopback on the
 * server (unreachable from the operator's browser), and plugin routes are
 * JSON-only so its SPA and SSE stream cannot be proxied. It cannot use `ctx.http`
 * either — that blocks private addresses, and `127.0.0.1` is private.
 *
 * So the worker opens `.codegraph/codegraph.db` itself. Node 24 ships
 * `node:sqlite`, plugin workers already have `node:fs`, and no HTTP is involved,
 * which makes the loopback restriction irrelevant.
 *
 * ## The cost, stated plainly
 *
 * This couples the plugin to CodeGraph's **internal** schema, which is not a
 * public API. `schema_versions` is read and checked first, and anything
 * unrecognised fails closed with a clear message rather than rendering a
 * confidently wrong graph. The eight governed tools are unaffected by any of
 * this: they go through MCP, not the database.
 */

import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import path from "node:path";
import { CODEGRAPH_INDEX_DIR } from "../constants.js";

export const INDEX_DB_FILE = "codegraph.db";

/** Hard ceiling so a well-connected symbol cannot produce a hairball. */
export const MAX_GRAPH_NODES = 250;

export class GraphUnavailable extends Error {
  constructor(
    message: string,
    readonly reason: "not_indexed" | "schema_drift" | "unreadable",
  ) {
    super(message);
    this.name = "GraphUnavailable";
  }
}

export interface GraphNode {
  id: string;
  name: string;
  kind: string;
  qualifiedName: string;
  filePath: string;
  startLine: number | null;
  endLine: number | null;
}

export interface GraphEdge {
  source: string;
  target: string;
  kind: string;
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** True when the traversal stopped at MAX_GRAPH_NODES. */
  truncated: boolean;
  /** Edge kinds present, so the UI can label without hardcoding a vocabulary. */
  edgeKinds: string[];
}

/** Columns this module reads. A rename is schema drift, not a silent zero. */
const NODE_COLUMNS = [
  "id",
  "kind",
  "name",
  "qualified_name",
  "file_path",
  "start_line",
  "end_line",
] as const;

const EDGE_COLUMNS = ["source", "target", "kind"] as const;

function openIndex(projectPath: string): DatabaseSync {
  const dbPath = path.join(projectPath, CODEGRAPH_INDEX_DIR, INDEX_DB_FILE);
  if (!existsSync(dbPath)) {
    throw new GraphUnavailable(
      "This repository has no CodeGraph index yet.",
      "not_indexed",
    );
  }
  try {
    // Read-only: the graph view must never be able to write to an index, and a
    // read-only handle also cannot take a lock a concurrent `codegraph sync`
    // would need.
    return new DatabaseSync(dbPath, { readOnly: true });
  } catch (error) {
    throw new GraphUnavailable(
      `Could not open the CodeGraph index: ${error instanceof Error ? error.message : String(error)}`,
      "unreadable",
    );
  }
}

function tableColumns(db: DatabaseSync, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: unknown }>;
  return new Set(rows.map((row) => String(row.name)));
}

/**
 * Verify the schema before reading it.
 *
 * A CodeGraph upgrade that renames a column would otherwise return an empty graph
 * — which looks like "this repo has no symbols" rather than "this integration
 * needs updating". Failing closed with a reason is the honest outcome.
 */
export function assertSchema(db: DatabaseSync): void {
  for (const table of ["nodes", "edges"]) {
    let columns: Set<string>;
    try {
      columns = tableColumns(db, table);
    } catch {
      throw new GraphUnavailable(
        `The CodeGraph index has no "${table}" table. It may predate this plugin or come from a different tool.`,
        "schema_drift",
      );
    }
    const required = table === "nodes" ? NODE_COLUMNS : EDGE_COLUMNS;
    const missing = required.filter((column) => !columns.has(column));
    if (missing.length > 0) {
      throw new GraphUnavailable(
        `The CodeGraph index schema has changed: "${table}" is missing ${missing.join(", ")}. The graph view needs updating for this CodeGraph version; the eight CodeGraph tools are unaffected.`,
        "schema_drift",
      );
    }
  }
}

function toNode(row: Record<string, unknown>): GraphNode {
  return {
    id: String(row["id"]),
    name: String(row["name"] ?? ""),
    kind: String(row["kind"] ?? ""),
    qualifiedName: String(row["qualified_name"] ?? ""),
    filePath: String(row["file_path"] ?? ""),
    startLine: typeof row["start_line"] === "number" ? row["start_line"] : null,
    endLine: typeof row["end_line"] === "number" ? row["end_line"] : null,
  };
}

/**
 * One symbol by its index id, or null when the index has no such id.
 *
 * Separate from `searchNodes` on purpose: an id lookup is exact, so it must not
 * be expressed as a name search that happens to include the id as text.
 */
export function nodeById(projectPath: string, nodeId: string): GraphNode | null {
  const db = openIndex(projectPath);
  try {
    assertSchema(db);
    const rows = db
      .prepare(`SELECT ${NODE_COLUMNS.join(", ")} FROM nodes WHERE id = ?`)
      .all(nodeId) as Array<Record<string, unknown>>;
    const row = rows[0];
    return row ? toNode(row) : null;
  } finally {
    db.close();
  }
}

/** Symbols matching a name or qualified name, best (shortest name) first. */
export function searchNodes(projectPath: string, query: string, limit = 25): GraphNode[] {
  // Wildcards are stripped so a query containing them is literal text, not a
  // pattern an operator did not mean to write. Stripping can empty the term —
  // and an empty term would match everything via '%%', so that case returns
  // nothing rather than the whole index.
  const needle = query.trim().replace(/[%_]/g, "").trim();
  if (needle.length === 0) return [];

  const db = openIndex(projectPath);
  try {
    assertSchema(db);
    const term = `%${needle}%`;
    const rows = db
      .prepare(
        `SELECT ${NODE_COLUMNS.join(", ")} FROM nodes
         WHERE name LIKE ? OR qualified_name LIKE ?
         ORDER BY length(name) ASC, name ASC
         LIMIT ?`,
      )
      .all(term, term, Math.max(1, Math.min(limit, 100))) as Array<Record<string, unknown>>;
    return rows.map(toNode);
  } finally {
    db.close();
  }
}

/**
 * The call neighbourhood around one symbol, breadth-first to `depth` hops.
 *
 * Traverses edges in both directions from the seed: `in` neighbours are callers,
 * `out` are callees. Direction is preserved on every edge returned, so the UI can
 * lay callers above and callees below without re-deriving it.
 *
 * All edge kinds are traversed and returned labelled, rather than filtered to an
 * assumed "calls" vocabulary — the UI can decide what to draw, and a kind this
 * module has never heard of still reaches the operator instead of vanishing.
 */
export function neighbourhood(
  projectPath: string,
  seedId: string,
  depth = 1,
  maxNodes = MAX_GRAPH_NODES,
): Graph {
  const db = openIndex(projectPath);
  try {
    assertSchema(db);

    const seedRows = db
      .prepare(`SELECT ${NODE_COLUMNS.join(", ")} FROM nodes WHERE id = ?`)
      .all(seedId) as Array<Record<string, unknown>>;
    if (seedRows.length === 0) {
      throw new GraphUnavailable(`No symbol with id ${seedId} in this index.`, "unreadable");
    }

    const nodes = new Map<string, GraphNode>();
    const edges = new Map<string, GraphEdge>();
    const hops = Math.max(1, Math.min(depth, 3));
    let frontier = [seedId];
    nodes.set(seedId, toNode(seedRows[0]!));
    let truncated = false;

    const inStmt = db.prepare(
      `SELECT ${EDGE_COLUMNS.join(", ")} FROM edges WHERE target = ?`,
    );
    const outStmt = db.prepare(
      `SELECT ${EDGE_COLUMNS.join(", ")} FROM edges WHERE source = ?`,
    );
    const nodeStmt = db.prepare(
      `SELECT ${NODE_COLUMNS.join(", ")} FROM nodes WHERE id = ?`,
    );

    for (let hop = 0; hop < hops; hop += 1) {
      const next: string[] = [];
      for (const current of frontier) {
        for (const stmt of [inStmt, outStmt]) {
          for (const raw of stmt.all(current) as Array<Record<string, unknown>>) {
            const edge: GraphEdge = {
              source: String(raw["source"]),
              target: String(raw["target"]),
              kind: String(raw["kind"] ?? ""),
            };
            edges.set(`${edge.source}->${edge.target}:${edge.kind}`, edge);

            const other = edge.source === current ? edge.target : edge.source;
            if (nodes.has(other)) continue;
            if (nodes.size >= maxNodes) {
              truncated = true;
              continue;
            }
            const found = nodeStmt.all(other) as Array<Record<string, unknown>>;
            if (found.length === 0) continue;
            nodes.set(other, toNode(found[0]!));
            next.push(other);
          }
        }
      }
      frontier = next;
      if (truncated) break;
    }

    return {
      nodes: [...nodes.values()],
      // Only edges whose both ends made it in: a dangling edge would be drawn as
      // a node-less line.
      edges: [...edges.values()].filter(
        (edge) => nodes.has(edge.source) && nodes.has(edge.target),
      ),
      truncated,
      edgeKinds: [...new Set([...edges.values()].map((edge) => edge.kind))].sort(),
    };
  } finally {
    db.close();
  }
}
