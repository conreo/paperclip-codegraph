/**
 * Entry points, Dead code, Steps and Flow.
 *
 * Two of these are real and two are explained, which is a deliberate split rather
 * than an unfinished one:
 *
 *   - **Entry points** — `route` is a first-class node kind and a route's `calls`
 *     edge names its handler, so this view reports what the index records.
 *   - **Dead code** — genuinely weaker, and built to say so. The index records
 *     that a symbol is *declared*, not whether it is exported, so CodeGraph's own
 *     exclusions (215 exported, 209 unreachable-file, 63 mentioned on a real
 *     repository) cannot be reproduced. The view shows the rules it *can* apply,
 *     the count it excluded for each, and a standing caveat.
 *   - **Steps** and **Flow** — not implemented, and shown rather than hidden so
 *     they are not silently missing from the rail. Both need call-path history
 *     that no index table carries: `codegraph ui` keeps trails in
 *     `.codegraph/ui/trails` as you click, and its flow view walks a path between
 *     two named symbols. Reconstructing either from edges alone would produce a
 *     plausible-looking answer to a question nobody asked, which is worse than
 *     saying what is missing and how to get it.
 */

import { useMemo, useState, type CSSProperties } from "react";
import { usePluginData } from "@paperclipai/plugin-sdk/ui";

import { DATA_KEYS } from "../plugin-keys.js";
import { sanitizeErrorMessage } from "../errors.js";
import { ui } from "./chrome.js";

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

interface RouteRow {
  id: string;
  method: string | null;
  path: string;
  filePath: string;
  line: number | null;
  handler: string | null;
  handlerFile: string | null;
  handlerLine: number | null;
  handlerId: string | null;
}

interface EntryPointsResponse {
  routes?: RouteRow[];
  total?: number;
  withHandler?: number;
  withoutHandler?: number;
  truncated?: boolean;
  error?: string;
  reason?: string;
}

export function EntryPointsView({
  companyId,
  projectId,
  onOpen,
}: {
  companyId: string;
  projectId: string | null;
  /** Open the handler in the reader, when it resolves to a symbol. */
  onOpen?: (nodeId: string, name: string) => void;
}) {
  const [filter, setFilter] = useState("");
  const { data, loading, error } = usePluginData<EntryPointsResponse>(DATA_KEYS.graphEntryPoints, {
    companyId,
    projectId,
  });

  const routes = data?.routes ?? [];
  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (needle.length === 0) return routes;
    return routes.filter(
      (route) =>
        route.path.toLowerCase().includes(needle) ||
        (route.method ?? "").toLowerCase().includes(needle) ||
        (route.handler ?? "").toLowerCase().includes(needle),
    );
  }, [routes, filter]);

  if (loading && routes.length === 0) return <Notice>Reading routes…</Notice>;
  if (error) return <Notice tone="error">{sanitizeErrorMessage(error)}</Notice>;
  if (data?.error) return <Notice tone="error">{sanitizeErrorMessage(data.error)}</Notice>;
  if (routes.length === 0) {
    return (
      <Notice>
        No HTTP routes were found in this repository&apos;s index. This view reports `route`
        nodes, so a repository whose server framework the indexer does not recognise will
        show nothing here even though it serves traffic.
      </Notice>
    );
  }

  return (
    <div style={styles.page}>
      <div style={styles.toolbar}>
        <input
          type="search"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Filter by path, method or handler…"
          aria-label="Filter routes"
          style={styles.filter}
        />
        <span style={styles.summary}>
          {shown.length} of {data?.total ?? routes.length} routes
          {data?.withHandler !== undefined
            ? ` · ${data.withHandler} with a handler, ${data.withoutHandler ?? 0} without`
            : ""}
          {data?.truncated ? " · showing the first 200" : ""}
        </span>
      </div>

      <table style={styles.table}>
        <thead>
          <tr>
            <th style={styles.th}>Method</th>
            <th style={styles.th}>Path</th>
            <th style={styles.th}>Handler</th>
            <th style={styles.th}>Where</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((route) => (
            <tr key={route.id} style={styles.tr}>
              <td style={styles.tdMono}>
                {route.method ? <span style={styles.method}>{route.method}</span> : <span style={styles.dim}>—</span>}
              </td>
              <td style={styles.tdMono}>{route.path}</td>
              <td style={styles.td}>
                {route.handler && route.handlerId && onOpen ? (
                  <button
                    type="button"
                    style={styles.linkButton}
                    onClick={() => onOpen(route.handlerId!, route.handler!)}
                  >
                    {route.handler}
                  </button>
                ) : (
                  (route.handler ?? <span style={styles.dim}>not recorded</span>)
                )}
              </td>
              <td style={styles.tdMono}>
                <span style={styles.dim}>
                  {route.filePath}
                  {route.line === null ? "" : `:${route.line}`}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dead code
// ---------------------------------------------------------------------------

interface DeadResponse {
  candidates?: Array<{
    id: string;
    name: string;
    qualifiedName: string;
    kind: string;
    filePath: string;
    startLine: number | null;
  }>;
  excluded?: Array<{ reason: string; count: number }>;
  totalCandidates?: number;
  scanned?: number;
  caveat?: string;
  error?: string;
  reason?: string;
}

export function DeadCodeView({
  companyId,
  projectId,
  onOpen,
}: {
  companyId: string;
  projectId: string | null;
  onOpen?: (nodeId: string, name: string) => void;
}) {
  const { data, loading, error } = usePluginData<DeadResponse>(DATA_KEYS.graphDeadCode, {
    companyId,
    projectId,
  });

  if (loading && !data) return <Notice>Scanning…</Notice>;
  if (error) return <Notice tone="error">{sanitizeErrorMessage(error)}</Notice>;
  if (data?.error) return <Notice tone="error">{sanitizeErrorMessage(data.error)}</Notice>;

  const candidates = data?.candidates ?? [];

  return (
    <div style={styles.page}>
      {/*
        The caveat is at the top, not in small print. This view is a hint, and a
        list of "unused" symbols that turns out to be mostly exports would train an
        operator to ignore it — or worse, to delete something load-bearing.
      */}
      <div style={styles.callout}>
        <strong>This is a hint, not a verdict.</strong>
        <p style={styles.calloutBody}>
          {data?.caveat ??
            "Unreferenced is a hint, not a verdict: this plugin has no export analysis, so a symbol exported for another module to import can appear here."}
        </p>
        <p style={styles.calloutBody}>
          A symbol is listed when no edge in the index reaches it. That is the rule this
          plugin can apply. CodeGraph&apos;s own dead-code view additionally excludes
          exported symbols, names mentioned more than once, and files nothing reaches —
          which on a real repository is the majority of candidates, and is why its list is
          three rows where this one is longer.
        </p>
      </div>

      {data?.excluded ? (
        <p style={styles.summary}>
          {data.scanned ?? 0} symbols scanned ·{" "}
          {data.excluded.map((entry) => `${entry.count} excluded as ${entry.reason}`).join(" · ")}
        </p>
      ) : null}

      {candidates.length === 0 ? (
        <Notice>Nothing unreferenced found.</Notice>
      ) : (
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Symbol</th>
              <th style={styles.th}>Kind</th>
              <th style={styles.th}>Where</th>
            </tr>
          </thead>
          <tbody>
            {candidates.map((candidate) => (
              <tr key={candidate.id} style={styles.tr}>
                <td style={styles.td}>
                  {onOpen ? (
                    <button
                      type="button"
                      style={styles.linkButton}
                      onClick={() => onOpen(candidate.id, candidate.name)}
                    >
                      {candidate.name}
                    </button>
                  ) : (
                    candidate.name
                  )}
                </td>
                <td style={styles.tdMono}>{candidate.kind}</td>
                <td style={styles.tdMono}>
                  <span style={styles.dim}>
                    {candidate.filePath}
                    {candidate.startLine === null ? "" : `:${candidate.startLine}`}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {data?.totalCandidates !== undefined && data.totalCandidates > candidates.length ? (
        <p style={styles.summary}>
          Showing the first {candidates.length} of {data.totalCandidates}.
        </p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Steps and Flow — named, explained, not faked
// ---------------------------------------------------------------------------

export function StepsView() {
  return (
    <Explained
      title="Steps"
      what="Walks outward from an anchor symbol, hop by hop, so you can read a call path as a sequence rather than a diagram."
      why="It needs a starting point and a traversal the index does not store. CodeGraph's own Steps view is built on the trail it records as you click through its UI, kept in `.codegraph/ui/trails`; nothing in the index tables carries that."
      instead="The Symbol view already shows one hop in each direction with the exact line that makes each call, and the Map view shows the shape. For a longer path, run `codegraph ui` on the host — it is a local tool and needs no Paperclip wiring."
    />
  );
}

export function FlowView() {
  return (
    <Explained
      title="Flow"
      what="Traces a path between two named symbols — how a request reaches a handler, or how data reaches a writer."
      why="It needs an ordered path search across the graph. The index has the edges to walk, but no recorded traversal to show, and a plugin-side search would be a second implementation of a traversal CodeGraph already does properly."
      instead="Use the Symbol view to follow the calls by hand — each row cites the line — or `codegraph ui` for the flow view itself."
    />
  );
}

function Explained({
  title,
  what,
  why,
  instead,
}: {
  title: string;
  what: string;
  why: string;
  instead: string;
}) {
  return (
    <div style={styles.page}>
      <div style={styles.callout}>
        <strong>{title} is not available from this plugin.</strong>
        <p style={styles.calloutBody}>
          <strong>What it does:</strong> {what}
        </p>
        <p style={styles.calloutBody}>
          <strong>Why not here:</strong> {why}
        </p>
        <p style={styles.calloutBody}>
          <strong>What to use instead:</strong> {instead}
        </p>
        <p style={styles.calloutBody}>
          It is listed in the rail rather than hidden, so its absence is a stated gap
          instead of something to wonder about.
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

function Notice({ children, tone }: { children: React.ReactNode; tone?: "error" }) {
  return (
    <div style={styles.page}>
      <p style={tone === "error" ? styles.error : styles.body}>{children}</p>
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  page: {
    flex: "1 1 auto",
    minHeight: 0,
    overflow: "auto",
    padding: 14,
    background: ui.background,
    fontSize: 12.5,
  },
  toolbar: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    flexWrap: "wrap",
    marginBottom: 12,
  },
  filter: {
    flex: "1 1 240px",
    minWidth: 180,
    height: 34,
    boxSizing: "border-box",
    padding: "0 10px",
    borderRadius: 6,
    border: `1px solid ${ui.input}`,
    background: "transparent",
    color: "inherit",
    fontFamily: "inherit",
    fontSize: 13,
  },
  summary: { color: ui.mutedForeground, fontSize: 11.5 },
  table: {
    width: "100%",
    borderCollapse: "collapse",
    fontFamily: "inherit",
  },
  th: {
    textAlign: "left",
    fontSize: 10.5,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    color: ui.mutedForeground,
    fontWeight: 600,
    padding: "0 10px 6px 0",
    borderBottom: `1px solid ${ui.border}`,
    position: "sticky",
    top: 0,
    background: ui.background,
  },
  tr: { borderBottom: `1px solid ${ui.border}` },
  td: { padding: "6px 10px 6px 0", verticalAlign: "top" },
  tdMono: {
    padding: "6px 10px 6px 0",
    verticalAlign: "top",
    fontFamily: ui.fontMono,
    fontSize: 11.5,
  },
  method: {
    display: "inline-block",
    minWidth: 42,
    padding: "1px 5px",
    borderRadius: 4,
    border: `1px solid ${ui.border}`,
    background: ui.muted,
    fontSize: 10,
    fontWeight: 600,
    letterSpacing: 0.4,
  },
  linkButton: {
    padding: 0,
    border: "none",
    background: "transparent",
    color: ui.primary,
    cursor: "pointer",
    fontFamily: ui.fontMono,
    fontSize: 11.5,
    textDecoration: "underline",
  },
  callout: {
    border: `1px solid ${ui.border}`,
    borderLeft: `3px solid ${ui.primary}`,
    borderRadius: 8,
    background: ui.muted,
    padding: "12px 14px",
    marginBottom: 14,
    lineHeight: 1.5,
  },
  calloutBody: { margin: "6px 0 0", color: ui.mutedForeground, fontSize: 12 },
  body: { color: ui.mutedForeground, fontSize: 12.5 },
  error: { color: ui.destructive, fontSize: 12.5 },
  dim: { color: ui.mutedForeground },
};
