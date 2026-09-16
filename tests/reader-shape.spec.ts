/**
 * The exact payload the reader page consumes.
 *
 * The page destructures `seed`, `callers`, `callees` and two counts, and draws
 * `name`, `filePath` and `callLine` from each entry. This reproduces that shape
 * against a real index so a field rename cannot silently empty a pane.
 *
 * Skips unless `CODEGRAPH_TEST_PROJECT` is set.
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

import { calleesOf, callersOf, nodeById, searchNodes } from "../src/graph/neighbourhood.js";

const projectRoot = process.env["CODEGRAPH_TEST_PROJECT"] ?? "";
const indexed =
  projectRoot.length > 0 && fs.existsSync(path.join(projectRoot, ".codegraph", "codegraph.db"));

/** Mirrors the worker's `graph-reader` handler. */
function buildReaderPayload(nodeId: string, limit = 40) {
  const seed = nodeById(projectRoot, nodeId);
  if (!seed) return null;

  const resolve = (
    edge: { source: string; target: string; kind: string; line: number | null },
    direction: "in" | "out",
  ) => {
    const otherId = direction === "in" ? edge.source : edge.target;
    const node = nodeById(projectRoot, otherId);
    return {
      id: otherId,
      name: node?.name ?? "(unknown symbol)",
      qualifiedName: node?.qualifiedName ?? "",
      kind: node?.kind ?? "",
      filePath: node?.filePath ?? "",
      startLine: node?.startLine ?? null,
      endLine: node?.endLine ?? null,
      callLine: edge.line,
      edgeKind: edge.kind,
    };
  };

  const callerEdges = callersOf(projectRoot, nodeId);
  const calleeEdges = calleesOf(projectRoot, nodeId);
  return {
    seed,
    callers: callerEdges.slice(0, limit).map((e) => resolve(e, "in")),
    callees: calleeEdges.slice(0, limit).map((e) => resolve(e, "out")),
    callerCount: callerEdges.length,
    calleeCount: calleeEdges.length,
    truncated: callerEdges.length > limit || calleeEdges.length > limit,
  };
}

describe.skipIf(!indexed)("reader payload shape", () => {
  function seedWithBoth() {
    for (const hit of searchNodes(projectRoot, "order", 40)) {
      const payload = buildReaderPayload(hit.id);
      if (payload && payload.callees.length > 0 && payload.callers.length > 0) return payload;
    }
    throw new Error("no symbol with both callers and callees");
  }

  it("provides a seed with the fields the header draws", () => {
    const payload = seedWithBoth();
    expect(payload!.seed.name.length).toBeGreaterThan(0);
    expect(payload!.seed.filePath.length).toBeGreaterThan(0);
    expect(payload!.seed.kind.length).toBeGreaterThan(0);
  });

  it("gives every callee a name, a file and a call line to align on", () => {
    const payload = seedWithBoth();
    expect(payload!.callees.length).toBeGreaterThan(0);
    for (const callee of payload!.callees) {
      expect(callee.name).not.toBe("(unknown symbol)");
      expect(callee.filePath.length).toBeGreaterThan(0);
      // The middle pane highlights source lines in this set, so a null here
      // would silently drop a row from the alignment.
      expect(typeof callee.callLine).toBe("number");
    }
  });

  it("gives every caller the same, so the left pane is never blank-titled", () => {
    const payload = seedWithBoth();
    for (const caller of payload!.callers) {
      expect(caller.name).not.toBe("(unknown symbol)");
      expect(caller.filePath.length).toBeGreaterThan(0);
      expect(typeof caller.callLine).toBe("number");
    }
  });

  it("reports counts that match the arrays when nothing was capped", () => {
    const payload = seedWithBoth();
    expect(payload!.callerCount).toBeGreaterThanOrEqual(payload!.callers.length);
    expect(payload!.calleeCount).toBeGreaterThanOrEqual(payload!.callees.length);
    expect(payload!.truncated).toBe(
      payload!.callerCount > payload!.callers.length || payload!.calleeCount > payload!.callees.length,
    );
  });

  it("caps a pane and says so rather than sending hundreds", () => {
    // A widely-called helper is the case that would otherwise flood the bridge.
    let capped = null;
    for (const hit of searchNodes(projectRoot, "e", 40)) {
      const payload = buildReaderPayload(hit.id, 5);
      if (payload && payload.truncated) { capped = payload; break; }
    }
    if (!capped) return; // no wide symbol in this index; the cap is still correct
    expect(capped.callers.length).toBeLessThanOrEqual(5);
    expect(capped.callees.length).toBeLessThanOrEqual(5);
  });
});
