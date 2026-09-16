/**
 * Re-reading data that something else may have changed.
 *
 * `usePluginData` fetches once and then holds that answer, and everything on the
 * settings page can change outside it: an agent created in another tab, a
 * repository workspace added to a project, an index built by the CLI. None of
 * those notify anybody, so the page went stale the moment it rendered — which
 * reads as the plugin being wrong rather than out of date.
 *
 * Two triggers, because they are cheap and cover the real cases:
 *
 *   - **the tab becomes visible again**, which is when a person returns to a page
 *     they left open and precisely when a new agent should appear;
 *   - **an action finished**, via the returned `refresh` passed to the callers that
 *     change something.
 *
 * Deliberately not a polling interval: a background tick would spawn a `git`
 * process per project on a page nobody is looking at, to change a number nobody
 * is reading.
 *
 * The rule that decides *when* lives in `refresh-signal.ts`, apart from the hook,
 * because this file imports React — a peer dependency that is absent from
 * `node_modules`, so anything a test needs to reach cannot be in here.
 */

import { useCallback, useEffect, useState } from "react";

import { shouldRefreshOnVisibility } from "./refresh-signal.js";

export interface RefreshSignal {
  /** Bump to ask every consumer to re-read. */
  refresh: () => void;
  /** Changes whenever a re-read is wanted; pass it into data parameters. */
  revision: number;
}

/**
 * A counter that bumps when the view should be re-read.
 *
 * Callers thread `revision` into their `usePluginData` parameters, so a bump is a
 * new parameter value and the hook re-fetches — no extra subscription machinery.
 */
export function useRefreshSignal(): RefreshSignal {
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    if (typeof document === "undefined") return;

    const onVisibility = () => {
      if (shouldRefreshOnVisibility(document.visibilityState)) refresh();
    };
    document.addEventListener("visibilitychange", onVisibility);
    // `focus` as well as `visibilitychange`: switching between two windows on one
    // screen fires focus without a visibility change, and that is the case where
    // an operator has just created an agent in the other window.
    window.addEventListener("focus", refresh);

    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", refresh);
    };
  }, [refresh]);

  return { refresh, revision };
}
