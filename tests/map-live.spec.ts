/**
 * The architecture map against a real index.
 *
 * The fixture tests pin the algebra; this pins that the queries return what the
 * algebra expects — that `nodes.file_path` really groups into modules, that edges
 * resolve to files, and that the result is a readable number of boxes rather than
 * a wall. Skips unless `CODEGRAPH_TEST_PROJECT` names an indexed repository.
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  MAP_EDGE_QUERY,
  MAP_FILE_QUERY,
  buildRepoMap,
  layoutMap,
  type IndexedEdge,
  type IndexedFile,
} from "../src/graph/architecture.js";

const projectRoot = process.env["CODEGRAPH_TEST_PROJECT"] ?? "";
const indexed =
  projectRoot.length > 0 && fs.existsSync(path.join(projectRoot, ".codegraph", "codegraph.db"));

function readIndex(): { files: IndexedFile[]; edges: IndexedEdge[] } {
  const db = new DatabaseSync(path.join(projectRoot, ".codegraph", "codegraph.db"), {
    readOnly: true,
  });
  try {
    const files = (db.prepare(MAP_FILE_QUERY).all() as Array<Record<string, unknown>>).map(
      (row) => ({
        filePath: String(row["file_path"] ?? ""),
        fileKind: null,
        nodes: Number(row["nodes"] ?? 0),
      }),
    );
    const edges = (
      db.prepare(MAP_EDGE_QUERY).all(200_000) as Array<Record<string, unknown>>
    ).map((row) => ({
      sourceFile: row["source_file"] === null ? null : String(row["source_file"]),
      targetFile: row["target_file"] === null ? null : String(row["target_file"]),
      kind: String(row["kind"] ?? ""),
    }));
    return { files, edges };
  } finally {
    db.close();
  }
}

describe.skipIf(!indexed)("architecture map against a real index", () => {
  const { files, edges } = indexed ? readIndex() : { files: [], edges: [] };

  it("finds files with symbols in them", () => {
    expect(files.length).toBeGreaterThan(50);
    expect(files.reduce((sum, f) => sum + f.nodes, 0)).toBeGreaterThan(1000);
  });

  it("resolves most edges to files on both ends", () => {
    // An edge whose endpoint has no file_path is one the map cannot place; the
    // count is reported rather than hidden, but it must not dominate.
    const resolved = edges.filter((e) => e.sourceFile && e.targetFile).length;
    expect(resolved / edges.length).toBeGreaterThan(0.5);
  });

  it("builds a readable number of modules", () => {
    const map = buildRepoMap(files, edges, { maxModules: 60, maxDepth: 4 });
    expect(map.modules.length).toBeGreaterThan(3);
    expect(map.modules.length).toBeLessThanOrEqual(60);
  });

  it("produces links that all reference real modules", () => {
    const map = buildRepoMap(files, edges, { maxModules: 60, maxDepth: 4 });
    expect(map.links.length).toBeGreaterThan(0);
    const ids = new Set(map.modules.map((m) => m.id));
    for (const link of map.links) {
      expect(ids.has(link.source), `link source ${link.source} is not a module`).toBe(true);
      expect(ids.has(link.target), `link target ${link.target} is not a module`).toBe(true);
      expect(link.source).not.toBe(link.target);
    }
  });

  it("lays the map out inside its canvas with no overlaps", () => {
    const map = buildRepoMap(files, edges, { maxModules: 60, maxDepth: 4 });
    const layout = layoutMap(map.modules, map.links, {
      weakLinkThreshold: 4,
      includeWeak: false,
    });

    for (const module of layout.modules) {
      expect(module.x).toBeGreaterThanOrEqual(0);
      expect(module.x + module.width).toBeLessThanOrEqual(layout.width);
      expect(module.y + module.height).toBeLessThanOrEqual(layout.height);
    }

    const byLayer = new Map<number, typeof layout.modules>();
    for (const module of layout.modules) {
      const row = byLayer.get(module.layer) ?? [];
      row.push(module);
      byLayer.set(module.layer, row);
    }
    for (const row of byLayer.values()) {
      const sorted = row.slice().sort((a, b) => a.x - b.x);
      for (let i = 1; i < sorted.length; i += 1) {
        expect(sorted[i]!.x).toBeGreaterThanOrEqual(sorted[i - 1]!.x + sorted[i - 1]!.width);
      }
    }
  });

  it("reports cycles if the repository has any", () => {
    // Not asserting a count — a clean repository legitimately has none — but the
    // shape must be usable when there are.
    const map = buildRepoMap(files, edges, { maxModules: 60, maxDepth: 4 });
    const layout = layoutMap(map.modules, map.links, { weakLinkThreshold: 4, includeWeak: false });
    for (const cycle of layout.cycles) {
      expect(cycle.length).toBeGreaterThanOrEqual(2);
      for (const id of cycle) {
        expect(map.modules.some((m) => m.id === id), `${id} in a cycle but not a module`).toBe(true);
      }
    }
  });

  it("scopes to a top-level folder", () => {
    const map = buildRepoMap(files, edges, { maxModules: 60, maxDepth: 4 });
    const top = map.roots.find((r) => r.root !== "");
    if (!top) return;
    const scoped = buildRepoMap(files, edges, {
      root: top.root,
      maxModules: 60,
      maxDepth: 4,
    });
    const total = scoped.modules.reduce((sum, m) => sum + m.files, 0);
    expect(total).toBe(top.files);
  });
});
