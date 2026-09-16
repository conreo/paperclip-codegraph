/**
 * The reader's two queries against a real index, when one is available.
 *
 * `graph.spec.ts` builds a fixture index, which pins the SQL but not the shape of
 * a real one: a 19 MB POS index has 13,374 edges of which only 4,405 are `calls`,
 * and every one of those carries a line while `contains` carries none. That
 * distinction is the whole basis of line-aligned callees, so it is worth checking
 * against the real thing.
 *
 * Skips unless `CODEGRAPH_TEST_PROJECT` names an indexed repository, so the suite
 * passes on a machine with no index and proves something where there is one.
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

import { calleesOf, callersOf, nodeById, searchNodes } from "../src/graph/neighbourhood.js";

const projectRoot = process.env["CODEGRAPH_TEST_PROJECT"] ?? "";
const indexed =
  projectRoot.length > 0 && fs.existsSync(path.join(projectRoot, ".codegraph", "codegraph.db"));

describe.skipIf(!indexed)("reader queries against a real index", () => {
  /** A symbol that actually calls something, found rather than hardcoded. */
  function findCaller(): { id: string; name: string } {
    const hits = searchNodes(projectRoot, "order", 25);
    for (const hit of hits) {
      if (calleesOf(projectRoot, hit.id).length > 0) return { id: hit.id, name: hit.name };
    }
    throw new Error("no symbol with callees found — is the index complete?");
  }

  it("returns callees ordered by the line that calls them", () => {
    const seed = findCaller();
    const callees = calleesOf(projectRoot, seed.id);

    expect(callees.length).toBeGreaterThan(0);
    const lines = callees.map((edge) => edge.line).filter((line): line is number => line !== null);
    expect(lines.length).toBe(callees.length);
    expect([...lines].sort((a, b) => a - b)).toEqual(lines);
  });

  it("resolves every callee to a real node with a name and a file", () => {
    // The reader draws a name and a path for each row, so an unresolvable id
    // would render as "(unknown symbol)" on screen.
    const seed = findCaller();
    for (const edge of calleesOf(projectRoot, seed.id).slice(0, 10)) {
      const node = nodeById(projectRoot, edge.target);
      expect(node, `callee ${edge.target} does not resolve`).not.toBeNull();
      expect(node!.name.length).toBeGreaterThan(0);
      expect(node!.filePath.length).toBeGreaterThan(0);
    }
  });

  it("returns callers with a line in the caller's own file", () => {
    const seed = findCaller();
    const callees = calleesOf(projectRoot, seed.id);
    const target = callees[0]!.target;

    const callers = callersOf(projectRoot, target);
    expect(callers.length).toBeGreaterThan(0);
    for (const edge of callers) {
      expect(edge.target).toBe(target);
      expect(edge.line).not.toBeNull();
      expect(nodeById(projectRoot, edge.source)).not.toBeNull();
    }
  });

  it("drops self-calls, which have no line to point at", () => {
    for (const hit of searchNodes(projectRoot, "order", 10)) {
      for (const edge of calleesOf(projectRoot, hit.id)) {
        expect(edge.target).not.toBe(hit.id);
      }
    }
  });

  it("never returns an edge without a line, which would break alignment", () => {
    // `contains` edges are the ones that lack a line, and asking for callees must
    // not sweep them in.
    const seed = findCaller();
    for (const edge of calleesOf(projectRoot, seed.id)) {
      expect(edge.kind).not.toBe("contains");
      expect(typeof edge.line).toBe("number");
    }
  });
});
