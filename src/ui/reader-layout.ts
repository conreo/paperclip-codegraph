/**
 * How the reader lays itself out at a given width.
 *
 * The page is dropped into a host container of unknown size, and the three-pane
 * reader is only readable when there is room for three columns: 232 + 232 of
 * fixed pane plus a source column that needs at least ~380px to show a line of
 * code without wrapping. Below that the columns squeeze to unreadable slivers —
 * which is what "does not adapt to the page dimensions" looked like.
 *
 * Extracted as a pure function because a breakpoint is exactly the kind of rule
 * that is wrong at one specific width and fine everywhere else, so it needs to be
 * checkable at the boundaries rather than eyeballed.
 */

export type ReaderLayout = "three-pane" | "two-pane" | "stacked";

/** Source column width below which a line of code starts wrapping badly. */
export const MIN_SOURCE_WIDTH = 380;
/** One fixed side pane, matching the styles. */
export const PANE_WIDTH = 232;
/** The page's own horizontal padding, counted twice. */
const CHROME = 32;

/**
 * Pick a layout for the available width.
 *
 * - `three-pane` — callers, source and callees side by side.
 * - `two-pane` — one side pane plus the source, and the panes share a column
 *   below it rather than squeezing; the reader is still usable while reading.
 * - `stacked` — a phone or a narrow sidebar column: source first, then callers
 *   and callees beneath it, each full width.
 */
export function readerLayout(availableWidth: number): ReaderLayout {
  if (!Number.isFinite(availableWidth) || availableWidth <= 0) {
    // An unmeasured container must not be treated as "enormous" — that would
    // render the widest layout and then jump. Two panes is the safe middle.
    return "two-pane";
  }

  const room = availableWidth - CHROME;
  if (room >= PANE_WIDTH * 2 + MIN_SOURCE_WIDTH) return "three-pane";
  if (room >= PANE_WIDTH + MIN_SOURCE_WIDTH) return "two-pane";
  return "stacked";
}

/** Whether the side panes sit beside the source or beneath it. */
export function panesAreColumns(layout: ReaderLayout): boolean {
  return layout === "three-pane";
}

/** Whether any side pane is shown at all. */
export function showsSidePanes(layout: ReaderLayout): boolean {
  return layout !== "stacked";
}
