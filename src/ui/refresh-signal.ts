/**
 * The decision behind re-reading plugin data.
 *
 * Kept apart from the hook in `refresh.ts` for one practical reason: the hook
 * imports React, which is a *peer* dependency here and therefore absent from
 * `node_modules`, so a test that imports the hook cannot run. This module has no
 * imports, so the rule itself stays testable — and the rule is the part that can
 * be wrong in both directions, a stale page or a refresh loop.
 */

/**
 * Whether a visibility event should trigger a re-read.
 *
 * Only on becoming visible: a `hidden` event means the page is going away, so
 * re-reading then would spend work on an answer nobody sees. An unknown or absent
 * state is not a signal either — an environment without `visibilityState` must not
 * cause a refresh loop.
 */
export function shouldRefreshOnVisibility(state: string | null | undefined): boolean {
  return state === "visible";
}
