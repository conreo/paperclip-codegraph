import { describe, expect, it } from "vitest";

import {
  LAYER_GAP,
  MAX_PER_RANK,
  NODE_HEIGHT,
  ROW_GAP,
  computeLayout,
  type LayoutInput,
} from "../src/graph/layout.js";

/** Shorthand: `edge("a", "b")` means a calls b. */
function edge(source: string, target: string, kind = "calls") {
  return { source, target, kind };
}

function node(id: string, name = id) {
  return { id, name, kind: "function" };
}

function graph(ids: string[], edges: Array<{ source: string; target: string; kind?: string }>): LayoutInput {
  return {
    nodes: ids.map((id) => node(id)),
    edges: edges.map((e) => edge(e.source, e.target, e.kind ?? "calls")),
  };
}

function byId(layout: ReturnType<typeof computeLayout>) {
  return new Map(layout.nodes.map((n) => [n.id, n]));
}

describe("computeLayout — ranks encode call direction", () => {
  it("places callers above and callees below the seed", () => {
    // seed(centre) <- caller ; seed -> callee
    const layout = computeLayout(graph(["caller", "seed", "callee"], [
      { source: "caller", target: "seed" },
      { source: "seed", target: "callee" },
    ]), "seed");

    const nodes = byId(layout);
    expect(nodes.get("seed")!.rank).toBe(0);
    expect(nodes.get("caller")!.rank).toBe(-1);
    expect(nodes.get("callee")!.rank).toBe(1);

    // Above means a smaller y, below a larger y.
    expect(nodes.get("caller")!.y).toBeLessThan(nodes.get("seed")!.y);
    expect(nodes.get("callee")!.y).toBeGreaterThan(nodes.get("seed")!.y);
  });

  it("propagates direction over multiple hops", () => {
    // a -> b -> seed -> c -> d
    const layout = computeLayout(graph(["a", "b", "seed", "c", "d"], [
      { source: "a", target: "b" },
      { source: "b", target: "seed" },
      { source: "seed", target: "c" },
      { source: "c", target: "d" },
    ]), "seed");

    const nodes = byId(layout);
    expect(nodes.get("b")!.rank).toBe(-1);
    expect(nodes.get("a")!.rank).toBe(-2);
    expect(nodes.get("c")!.rank).toBe(1);
    expect(nodes.get("d")!.rank).toBe(2);
  });

  it("keeps a mutually-recursive neighbour level with the seed", () => {
    // The seed and "peer" call each other: it is both caller and callee, so it
    // belongs beside the seed rather than on one arbitrary side.
    const layout = computeLayout(graph(["seed", "peer"], [
      { source: "seed", target: "peer" },
      { source: "peer", target: "seed" },
    ]), "seed");

    const nodes = byId(layout);
    expect(nodes.get("peer")!.rank).toBe(0);
    expect(nodes.get("peer")!.y).toBe(nodes.get("seed")!.y);
    // Same row, but not stacked on top of the seed.
    expect(nodes.get("peer")!.x).not.toBe(nodes.get("seed")!.x);
  });

  it("marks the seed and no one else", () => {
    const layout = computeLayout(graph(["caller", "seed", "callee"], [
      { source: "caller", target: "seed" },
      { source: "seed", target: "callee" },
    ]), "seed");
    expect(layout.nodes.filter((n) => n.isSeed).map((n) => n.id)).toEqual(["seed"]);
  });
});

describe("computeLayout — drawing geometry", () => {
  it("never overlaps two nodes on the same row", () => {
    const layout = computeLayout(graph(["seed", "a", "b", "c"], [
      { source: "seed", target: "a" },
      { source: "seed", target: "b" },
      { source: "seed", target: "c" },
    ]), "seed");

    const row = layout.nodes.filter((n) => n.rank === 1).sort((x, y) => x.x - y.x);
    expect(row).toHaveLength(3);
    for (let i = 1; i < row.length; i += 1) {
      const previous = row[i - 1]!;
      const current = row[i]!;
      const previousRight = previous.x + previous.width / 2;
      const currentLeft = current.x - current.width / 2;
      expect(currentLeft).toBeGreaterThanOrEqual(previousRight + ROW_GAP - 0.001);
    }
  });

  it("leaves a visible gap between rows", () => {
    const layout = computeLayout(graph(["caller", "seed", "callee"], [
      { source: "caller", target: "seed" },
      { source: "seed", target: "callee" },
    ]), "seed");
    const nodes = byId(layout);
    const gap = nodes.get("seed")!.y - nodes.get("caller")!.y;
    expect(gap).toBeGreaterThanOrEqual(LAYER_GAP);
    expect(nodes.get("seed")!.y - nodes.get("callee")!.y).toBe(-gap);
  });

  it("gives every node a positive size and keeps coordinates finite", () => {
    const layout = computeLayout(graph(["seed", "a"], [
      { source: "seed", target: "a" },
    ]), "seed");
    for (const n of layout.nodes) {
      expect(n.width).toBeGreaterThan(0);
      expect(n.height).toBe(NODE_HEIGHT);
      expect(Number.isFinite(n.x)).toBe(true);
      expect(Number.isFinite(n.y)).toBe(true);
    }
    expect(layout.width).toBeGreaterThan(0);
    expect(layout.height).toBeGreaterThan(0);
    expect(Number.isFinite(layout.centerX)).toBe(true);
  });

  it("centres the viewport on the seed", () => {
    const layout = computeLayout(graph(["seed", "a", "b", "c"], [
      { source: "seed", target: "a" },
      { source: "seed", target: "b" },
      { source: "seed", target: "c" },
    ]), "seed");
    const seed = layout.nodes.find((n) => n.isSeed)!;
    expect(layout.centerX).toBe(seed.x);
  });

  it("keeps the seed within the drawn canvas", () => {
    const layout = computeLayout(graph(["seed", "a"], [
      { source: "a", target: "seed" },
    ]), "seed");
    const seed = layout.nodes.find((n) => n.isSeed)!;
    expect(seed.x - seed.width / 2).toBeGreaterThanOrEqual(0);
    expect(seed.x + seed.width / 2).toBeLessThanOrEqual(layout.width);
  });
});

describe("computeLayout — edges", () => {
  it("draws an edge for each pair that both have positions", () => {
    const layout = computeLayout(graph(["a", "b", "seed", "c"], [
      { source: "a", target: "b" },
      { source: "b", target: "seed" },
      { source: "seed", target: "c" },
    ]), "seed");
    expect(layout.edges).toHaveLength(3);
    for (const e of layout.edges) {
      expect(e.path.startsWith("M ")).toBe(true);
      expect(e.path).toContain(" C ");
      expect(e.path).not.toContain("NaN");
    }
  });

  it("drops edges whose endpoints are not in the node set", () => {
    const input: LayoutInput = {
      nodes: [node("seed"), node("a")],
      edges: [edge("seed", "a"), edge("ghost", "seed"), edge("a", "phantom")],
    };
    const layout = computeLayout(input, "seed");
    expect(layout.edges.map((e) => `${e.source}->${e.target}`)).toEqual(["seed->a"]);
  });

  it("flags the edges that touch the seed", () => {
    const layout = computeLayout(graph(["a", "b", "seed", "c", "d"], [
      { source: "a", target: "b" },
      { source: "b", target: "seed" },
      { source: "seed", target: "c" },
      { source: "c", target: "d" },
    ]), "seed");
    const primary = layout.edges.filter((e) => e.isPrimary).map((e) => `${e.source}->${e.target}`);
    expect(primary.sort()).toEqual(["b->seed", "seed->c"]);
  });

  it("preserves edge kind so the view can label without a fixed vocabulary", () => {
    const layout = computeLayout(graph(["seed", "a", "b"], [
      { source: "seed", target: "a", kind: "calls" },
      { source: "seed", target: "b", kind: "references" },
    ]), "seed");
    expect(layout.edges.map((e) => e.kind).sort()).toEqual(["calls", "references"]);
  });

  it("ignores self-edges rather than drawing a zero-length curve", () => {
    const layout = computeLayout(graph(["seed", "a"], [
      { source: "a", target: "a" },
      { source: "seed", target: "a" },
    ]), "seed");
    expect(layout.edges.map((e) => `${e.source}->${e.target}`)).toEqual(["seed->a"]);
  });
});

describe("computeLayout — degenerate input", () => {
  it("lays out a lone seed without dividing by zero", () => {
    const layout = computeLayout(graph(["seed"], []), "seed");
    expect(layout.nodes).toHaveLength(1);
    expect(layout.nodes[0]!.isSeed).toBe(true);
    expect(layout.edges).toHaveLength(0);
    expect(layout.ranks).toBe(1);
    expect(layout.width).toBeGreaterThan(0);
    expect(layout.height).toBeGreaterThan(0);
  });

  it("returns an empty canvas for an empty graph", () => {
    const layout = computeLayout({ nodes: [], edges: [] }, "missing");
    expect(layout.nodes).toEqual([]);
    expect(layout.edges).toEqual([]);
    expect(layout.ranks).toBe(0);
    expect(Number.isFinite(layout.centerX)).toBe(true);
  });

  it("draws unreachable nodes rather than dropping them", () => {
    const layout = computeLayout(graph(["seed", "orphan"], []), "seed");
    const nodes = byId(layout);
    expect(nodes.has("orphan")).toBe(true);
    expect(nodes.get("orphan")!.rank).toBe(0);
  });

  it("caps a huge rank and says so", () => {
    const ids = ["seed", ...Array.from({ length: MAX_PER_RANK + 12 }, (_, i) => `c${i}`)];
    const layout = computeLayout(
      graph(ids, ids.slice(1).map((id) => ({ source: "seed", target: id }))),
      "seed",
    );
    expect(layout.truncated).toBe(true);
    expect(layout.nodes.filter((n) => n.rank === 1)).toHaveLength(MAX_PER_RANK);
  });

  it("is deterministic", () => {
    const input = graph(["seed", "a", "b", "c"], [
      { source: "a", target: "seed" },
      { source: "seed", target: "b" },
      { source: "b", target: "c" },
    ]);
    const first = computeLayout(input, "seed");
    const second = computeLayout(input, "seed");
    expect(second.nodes).toEqual(first.nodes);
    expect(second.edges).toEqual(first.edges);
  });

  it("keeps a wide graph inside a bounded canvas", () => {
    const ids = ["seed", ...Array.from({ length: 20 }, (_, i) => `n${i}`)];
    const layout = computeLayout(
      graph(ids, ids.slice(1).map((id) => ({ source: id, target: "seed" }))),
      "seed",
    );
    // 20 nodes cannot be squeezed into a phone-width canvas.
    expect(layout.width).toBeGreaterThan(20 * 100);
    for (const n of layout.nodes) {
      expect(n.x + n.width / 2).toBeLessThanOrEqual(layout.width);
    }
  });
});
