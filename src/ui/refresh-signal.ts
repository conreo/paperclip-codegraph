/**
 * The decision behind re-reading plugin data.
 *
 * Kept apart from the hook in `refresh.ts` for one practical reason: the hook
 * imports React, which is a *peer* dependency here and therefore absent from
 * `node_modules`, so a test that imports the hook cannot run. This module has no
 * imports, so the rule itself stays testable — and the rule is the part worth
 * testing, because getting it wrong means either a stale page or a refresh loop.
 */

/** Whether a visibility event should trigger a re-read. */
export function shouldRefreshOnVisibility(state: string | null | undefined): boolean {
  // Only on becoming visible. A hidden event means the page is going away, so
  // re-reading then would spend work on an answer nobody sees.
  return state === "visible";
}
