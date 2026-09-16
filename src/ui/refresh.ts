/**
 * Re-reading data that something else may have changed.
 *
 * `usePluginData` fetches once and then holds that answer. Everything this plugin
 * shows can change outside the page: an agent created in another tab, a
 * repository workspace added to a project, an index built by a CLI, an index
 * finished by a previous button press. None of those notify anybody. The result
 * was a settings page that went stale the moment it rendered, which reads as the
 * plugin being wrong rather than out of date.
 *
 * Two triggers, because they are cheap and cover the real cases:
 *
 *   - **the tab becomes visible again**, which is exactly when a person comes
 *     back to a page they left open, and precisely when a new agent or project
 *     created elsewhere should appear;
 *   - **a button press finished**, via the returned `refresh` passed down to the
 *     actions that change something.
 *
 * Deliberately not a polling interval: a background tick would spawn a `git`
 * process per project on a page nobody is looking at, to change a number nobody
 * is reading.
 */

import { useCallback, useEffect, useState } from "react";

import { shouldRefreshOnVisibility } from "./refresh-signal.js";

/**
 * A counter that bumps when the view should be re-read.
 *
 * Callers pass the value into their data parameters, so a bump is a new value and
 * `usePluginData` re-fetches — no extra subscription machinery.
 */
export function useRefreshSignal(): {
  /** Bump to ask every consumer to re-read. */
  refresh: () => void;
  /** Changes whenever a re-read is wanted. */
  revision: number;
  /** Bump from an event handler, e.g. the window regaining focus. */
  onVisibilityChange: (state: string | null) => void;
} {
  const [revision, setRevision] = useState(0);

  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  const onVisibilityChange = useCallback(
    (state: string | null) => {
      if (shouldRefreshOnVisibility(state)) refresh();
    },
    [refresh],
  );

  useEffect(() => {
    if (typeof document === "undefined") return;

    const handler = () => onVisibilityChange(document.visibilityState);
    document.addEventListener("visibilitychange", handler);
    // `focus` as well as `visibilitychange`: switching between two windows on the
    // same screen fires focus without a visibility change, and that is the case
    // where an operator has just created an agent in the other window.
    window.addEventListener("focus", refresh);

    return () => {
      document.removeEventListener("visibilitychange", handler);
      window.removeEventListener("focus", refresh);
    };
  }, [onVisibilityChange, refresh]);

  return { refresh, revision, onVisibilityChange };
}
