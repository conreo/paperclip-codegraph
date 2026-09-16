/**
 * The reader's views, as a set of routes on one page.
 *
 * CodeGraph's own UI offers Steps · Entry points · Map · Symbol · Flow · Dead code.
 * Only the ones this plugin can actually fill are offered, because a view that
 * opens fabricated content is worse than one that is not there:
 *
 *   - **Symbol** and **Map** are built from the call graph and the index.
 *   - **Steps**, **Flow** and **Dead code** need call-path history and an
 *     unused-code analysis with export/reference awareness. The index carries no
 *     such marks — a naive "no inbound edge" query returns **zero** candidates on
 *     the real POS index, because route and file nodes reference everything — so
 *     any list would be a guess.
 *   - **Entry points** is reachable (routes are a node kind) and is planned.
 *
 * Shared between the route sidebar and the page so the two cannot disagree about
 * what exists or which one is open.
 */

export const VIEWS = ["symbol", "map"] as const;
export type View = (typeof VIEWS)[number];

export const VIEW_LABELS: Record<View, string> = {
  symbol: "Symbol",
  map: "Map",
};

export const VIEW_NOTES: Record<View, string> = {
  symbol: "Who calls a symbol, its source, and what it calls — each callee beside the line that calls it.",
  map: "The repository as modules, one layer above what it depends on, with the cycles it has.",
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
