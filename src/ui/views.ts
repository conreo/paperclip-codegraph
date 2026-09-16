/**
 * The reader's views, as a set of routes on one page.
 *
 * CodeGraph's own UI offers Steps · Entry points · Map · Symbol · Flow · Dead code.
 * Only the ones this plugin can actually fill are offered, because a view that
 * opens fabricated content is worse than one that is not there:
 *
 *   - **Symbol** and **Map** are built from the call graph and the index.
 *   - **Entry points** is real: `route` is a node kind and a route's `calls` edge
 *     names its handler.
 *   - **Dead code** is real but weaker, and says so in the view: the index records
 *     that a symbol is declared, not whether it is exported, so CodeGraph's own
 *     exclusions cannot be reproduced.
 *   - **Steps** and **Flow** are listed but explain themselves rather than being
 *     hidden. Both need call-path history (`codegraph ui` keeps trails in
 *     `.codegraph/ui/trails`) or a path search that would be a second
 *     implementation of a traversal CodeGraph already does properly. Showing the
 *     gap is better than a plausible-looking answer to a question nobody asked.
 *
 * Shared between the route sidebar and the page so the two cannot disagree about
 * what exists or which one is open.
 */

export const VIEWS = ["steps", "entrypoints", "map", "symbol", "flow", "deadcode"] as const;
export type View = (typeof VIEWS)[number];

export const VIEW_LABELS: Record<View, string> = {
  // Ordered as CodeGraph orders them, so muscle memory carries over.
  steps: "Steps",
  entrypoints: "Entry points",
  map: "Map",
  symbol: "Symbol",
  flow: "Flow",
  deadcode: "Dead code",
};

export const VIEW_NOTES: Record<View, string> = {
  steps: "Not available here — needs the click trail CodeGraph records, which the index does not carry.",
  entrypoints: "The HTTP routes the index found, with the handler each one calls.",
  map: "The repository as modules, one layer above what it depends on, with the cycles it has.",
  symbol: "Who calls a symbol, its source, and what it calls — each callee beside the line that calls it.",
  flow: "Not available here — a path search between two symbols, which CodeGraph's own UI does properly.",
  deadcode: "Symbols nothing references. A hint, not a verdict — there is no export analysis here.",
};

/** The view a location hash names, falling back to the first. */
export function viewFromHash(hash: string | null | undefined): View {
  const name = (hash ?? "").replace(/^#/, "").replace(/^\//, "").trim().toLowerCase();
  return (VIEWS as readonly string[]).includes(name) ? (name as View) : VIEWS[0];
}

/** The hash that opens a view. */
export function hashForView(view: View): string {
  return `#${view}`;
}
