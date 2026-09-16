/**
 * Layered layout for the CodeGraph view.
 *
 * Deliberately *not* force-directed. A call graph read as a picture is only
 * useful if position means something: here the vertical axis is distance from
 * the symbol you searched for, callers above and callees below. A force layout
 * would scatter the same graph differently on every render and answer no
 * question.
 *
 * Direction comes from the edge itself (`source` → `target`), not from where a
 * node happened to land, so `calls` and `references` can both be drawn without
 * this module knowing which kinds exist.
 *
 * Pure: no DOM, no clock, no randomness. Same input, same coordinates.
 */

/** A node from the index, as much of it as layout needs. */
export interface LayoutInputNode {
  id: string;
  name: string;
  kind?: string;
}

/** An edge from the index. */
export interface LayoutInputEdge {
  source: string;
  target: string;
  kind: string;
}

export interface LayoutInput {
  nodes: LayoutInputNode[];
  edges: LayoutInputEdge[];
}

export interface LayoutNode extends LayoutInputNode {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Negative above the seed (callers), 0 at the seed, positive below. */
  rank: number;
  isSeed: boolean;
}

export interface LayoutEdge extends LayoutInputEdge {
  path: string;
  /** True when the edge touches the seed, so it can be emphasised. */
  isPrimary: boolean;
}

export interface Layout {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  width: number;
  height: number;
  /** Seed-centred drawing width, for horizontal scroll centring. */
  centerX: number;
  ranks: number;
  /** True when a rank held more nodes than one row can show. */
  truncated: boolean;
}

export const NODE_HEIGHT = 28;
export const ROW_GAP = 14;
export const LAYER_GAP = 96;
export const PADDING = 24;
const MIN_NODE_WIDTH = 104;
const MAX_NODE_WIDTH = 208;
const MIN_CANVAS_WIDTH = 480;
const LEFT_PAD = 20;

/** Hard cap per rank: beyond this the picture stops being readable. */
export const MAX_PER_RANK = 40;

function nodeWidth(name: string): number {
  const estimate = name.length * 7.2 + 24;
  return Math.max(MIN_NODE_WIDTH, Math.min(MAX_NODE_WIDTH, Math.round(estimate)));
}

/**
 * Rank assignment by breadth-first traversal from the seed.
 *
 * An outbound edge means "the seed reaches this" (below, +1); an inbound edge
 * means "this reaches the seed" (above, −1). A node reachable both ways has its
 * directions summed, which parks it at the seed's level instead of silently
 * picking whichever edge was seen first. First assignment wins, so a node never
 * moves closer after being placed.
 */
function assignRanks(input: LayoutInput, seedId: string): Map<string, number> {
  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();
  const known = new Set(input.nodes.map((node) => node.id));

  for (const edge of input.edges) {
    if (!known.has(edge.source) || !known.has(edge.target)) continue;
    if (edge.source === edge.target) continue;
    const out = outgoing.get(edge.source);
    if (out) out.push(edge.target);
    else outgoing.set(edge.source, [edge.target]);
    const inc = incoming.get(edge.target);
    if (inc) inc.push(edge.source);
    else incoming.set(edge.target, [edge.source]);
  }

  const ranks = new Map<string, number>([[seedId, 0]]);
  const queue: string[] = [seedId];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const rank = ranks.get(current) ?? 0;

    // Both directions are collapsed per level before assigning: a node reached
    // as both caller and callee lands at the seed's own level (rank 0) instead
    // of being decided by whichever edge happened to be visited first.
    const deltas = new Map<string, number>();
    for (const id of outgoing.get(current) ?? []) {
      deltas.set(id, (deltas.get(id) ?? 0) + 1);
    }
    for (const id of incoming.get(current) ?? []) {
      deltas.set(id, (deltas.get(id) ?? 0) - 1);
    }

    for (const [id, delta] of deltas) {
      if (id === seedId || ranks.has(id)) continue;
      ranks.set(id, rank + Math.sign(delta));
      queue.push(id);
    }
  }

  // Anything the traversal never reached (a node whose edges were all dropped)
  // still gets drawn, level with the seed, rather than vanishing silently.
  for (const node of input.nodes) {
    if (!ranks.has(node.id)) ranks.set(node.id, 0);
  }
  return ranks;
}

export function computeLayout(input: LayoutInput, seedId: string): Layout {
  const ranks = assignRanks(input, seedId);
  // Drawn ranks only. `assignRanks` seeds the map with the seed id so a graph
  // whose nodes were all dropped still resolves; an empty input therefore
  // reports zero ranks rather than one phantom row.
  const rankValues = [...new Set(input.nodes.map((node) => ranks.get(node.id) ?? 0))].sort(
    (a, b) => a - b,
  );

  let truncated = false;
  const nodes: LayoutNode[] = [];
  const widths = new Map<string, number>();

  // Rows are stacked rather than all centred on one line: each row's own height
  // depends on how many nodes it holds, so y is accumulated from the top down
  // and every row is offset by half its own height.
  let cursor = PADDING;
  for (const rank of rankValues) {
    const group = input.nodes.filter((node) => ranks.get(node.id) === rank);
    const shown = group.slice(0, MAX_PER_RANK);
    if (shown.length < group.length) truncated = true;

    let widest = 0;
    for (const node of shown) {
      const width = nodeWidth(node.name);
      widths.set(node.id, width);
      widest = Math.max(widest, width);
    }

    const rowHeight = shown.length * NODE_HEIGHT + Math.max(0, shown.length - 1) * ROW_GAP;
    const y = cursor + rowHeight / 2;
    cursor += rowHeight + LAYER_GAP;

    let offset = LEFT_PAD + widest / 2;
    for (const node of shown) {
      const width = widths.get(node.id) ?? MIN_NODE_WIDTH;
      nodes.push({
        id: node.id,
        name: node.name,
        ...(node.kind === undefined ? {} : { kind: node.kind }),
        x: offset,
        y,
        width,
        height: NODE_HEIGHT,
        rank,
        isSeed: node.id === seedId,
      });
      offset += width + ROW_GAP;
    }
  }

  const positions = new Map(nodes.map((node) => [node.id, node]));
  const seed = positions.get(seedId);

  const edges: LayoutEdge[] = [];
  for (const edge of input.edges) {
    // A self-edge has no vertical extent to draw and is dropped by the rank
    // pass; dropping it here too keeps the two consistent.
    if (edge.source === edge.target) continue;
    const source = positions.get(edge.source);
    const target = positions.get(edge.target);
    if (!source || !target) continue;
    edges.push({
      source: edge.source,
      target: edge.target,
      kind: edge.kind,
      path: edgePath(source, target),
      isPrimary: edge.source === seedId || edge.target === seedId,
    });
  }

  const right = nodes.reduce(
    (max, node) => Math.max(max, node.x + node.width / 2),
    MIN_CANVAS_WIDTH,
  );
  const centerX = seed ? seed.x : right / 2;
  const bottom = nodes.reduce((max, node) => Math.max(max, node.y + node.height / 2), 0);

  return {
    nodes,
    edges,
    width: right + PADDING,
    height: Math.max(bottom + PADDING, NODE_HEIGHT + PADDING * 2),
    centerX,
    ranks: rankValues.length,
    truncated,
  };
}

/**
 * A vertical cubic bezier between two nodes.
 *
 * Control points are pulled most of the way toward the target's own row so a
 * near-vertical edge stays near-vertical and a long edge keeps a visible spine;
 * a straight line between ranks reads as an undifferentiated bundle.
 */
function edgePath(
  source: { x: number; y: number; height: number },
  target: { x: number; y: number; height: number },
): string {
  const goingDown = target.y >= source.y;
  const fromY = source.y + (goingDown ? source.height / 2 : -source.height / 2);
  const toY = target.y + (goingDown ? -target.height / 2 : target.height / 2);
  const bend = Math.max(18, Math.abs(toY - fromY) * 0.45);
  const c1 = fromY + (goingDown ? bend : -bend);
  const c2 = toY - (goingDown ? bend : -bend);
  return `M ${source.x} ${fromY} C ${source.x} ${c1}, ${target.x} ${c2}, ${target.x} ${toY}`;
}
