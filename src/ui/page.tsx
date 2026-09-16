/**
 * The CodeGraph page.
 *
 * A call graph is wide and tall at once, so this is a page rather than a panel:
 * `/:companyPrefix/codegraph`. The layout is chosen so that *position means
 * something* — callers above the symbol you searched for, callees below — which
 * is the whole reason a force-directed blob would be useless here.
 *
 * Three constraints shaped the implementation:
 *
 * 1. The CodeGraph viewer binds loopback, and plugin routes return JSON only
 *    (`PLUGIN_SPEC.md`), so the graph is read from the index by the worker and
 *    drawn here. No iframe, no second server.
 * 2. Nothing here accepts a path. The operator picks a *project*; the worker
 *    resolves that project's workspace through the host, as the tool path does.
 * 3. Interaction is deliberately small: search, click a node to re-centre, pick
 *    depth. Everything that changes what is drawn is visible on screen.
 */

import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  KeyValueList,
  Spinner,
  StatusBadge,
  usePluginData,
  type PluginPageProps,
} from "@paperclipai/plugin-sdk/ui";

import { computeLayout, type LayoutEdge, type LayoutNode } from "../graph/layout.js";
import { sanitizeErrorMessage } from "../errors.js";

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

interface RepoRow {
  projectId: string;
  name: string;
  alias: string;
  indexed: boolean;
}

interface GraphNodeDto {
  id: string;
  name: string;
  kind: string;
  qualifiedName: string;
  filePath: string;
  startLine: number | null;
  endLine: number | null;
}

interface GraphDto {
  nodes: GraphNodeDto[];
  edges: Array<{ source: string; target: string; kind: string }>;
  truncated: boolean;
  edgeKinds: string[];
}

interface NeighbourhoodResponse {
  graph?: GraphDto;
  seedId?: string;
  error?: string;
  reason?: string;
}

interface SearchResponse {
  results?: GraphNodeDto[];
  error?: string;
}

interface SourceResponse {
  excerpt?: string | null;
  filePath?: string;
  startLine?: number;
  endLine?: number;
  truncated?: boolean;
  reason?: string;
  error?: string;
}

const DEPTHS = [1, 2, 3] as const;
const SEARCH_DEBOUNCE_MS = 250;

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function CodeGraphPage({ context }: PluginPageProps) {
  const companyId = context.companyId ?? null;

  const { data: reposData, loading: reposLoading } = usePluginData<{
    organization?: string | null;
    repositories: RepoRow[];
    enabled?: boolean;
  }>("graph-projects", { companyId });

  const repositories = reposData?.repositories ?? [];
  const organization = reposData?.organization ?? null;

  const [projectId, setProjectId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [seedId, setSeedId] = useState<string | null>(null);
  const [depth, setDepth] = useState<number>(1);

  // Default to the first indexed repository once the list arrives: opening the
  // page on a repository with no index would show an error for no reason.
  useEffect(() => {
    if (projectId || repositories.length === 0) return;
    const preferred = repositories.find((repo) => repo.indexed) ?? repositories[0];
    if (preferred) setProjectId(preferred.projectId);
  }, [projectId, repositories]);

  // The selector changed: whatever was drawn belongs to another repository.
  useEffect(() => {
    setSeedId(null);
  }, [projectId]);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  const searchParams = useMemo(
    () => ({ companyId, projectId, query: debounced }),
    [companyId, projectId, debounced],
  );
  const graphParams = useMemo(
    () => ({ companyId, projectId, nodeId: seedId, depth }),
    [companyId, projectId, seedId, depth],
  );

  const {
    data: searchData,
    loading: searching,
  } = usePluginData<SearchResponse>("graph-search", searchParams);

  const {
    data: graphData,
    loading: graphLoading,
  } = usePluginData<NeighbourhoodResponse>("graph-neighbourhood", graphParams);

  const [selectedId, setSelectedId] = useState<string | null>(null);

  const seedNode = useMemo(() => {
    if (!selectedId || !graphData?.graph) return null;
    return graphData.graph.nodes.find((node) => node.id === selectedId) ?? null;
  }, [selectedId, graphData]);

  const { data: sourceData, loading: sourceLoading } = usePluginData<SourceResponse>(
    "graph-source",
    { companyId, projectId, nodeId: selectedId },
  );

  // A fresh seed replaces whatever was selected before.
  useEffect(() => {
    setSelectedId(seedId);
  }, [seedId]);

  const results = searchData?.results ?? [];

  if (!companyId) {
    return <Shell><p style={styles.muted}>Open this page inside a company to see its code graph.</p></Shell>;
  }

  if (reposLoading && repositories.length === 0) {
    return <Shell><Spinner label="Finding repositories" /></Shell>;
  }

  if (repositories.length === 0) {
    return (
      <Shell>
        <p style={styles.muted}>
          This organization has no repository workspaces, so there is no graph to draw. A
          repository appears here once a Paperclip project in this organization has one.
        </p>
      </Shell>
    );
  }

  const active = repositories.find((repo) => repo.projectId === projectId) ?? null;

  return (
    <Shell>
      <header style={styles.header}>
        <div style={styles.headerLeft}>
          <h2 style={styles.h2}>
            CodeGraph
            {organization ? ` · ${organization}` : context.companyPrefix ? ` · ${context.companyPrefix}` : ""}
          </h2>
          <p style={styles.muted}>
            Who calls what in this organization&apos;s code. Callers above, callees below.
          </p>
        </div>
        <div style={styles.headerRight}>
          <label style={styles.field}>
            <span style={styles.fieldLabel}>Repository</span>
            <select
              value={projectId ?? ""}
              onChange={(event) => setProjectId(event.target.value || null)}
              style={styles.select}
            >
              {repositories.map((repo) => (
                <option key={repo.projectId} value={repo.projectId}>
                  {repo.name}
                  {repo.indexed ? "" : " — not indexed"}
                </option>
              ))}
            </select>
          </label>
          {active ? (
            <StatusBadge
              label={active.indexed ? "Indexed" : "Not indexed"}
              status={active.indexed ? "ok" : "warning"}
            />
          ) : null}
        </div>
      </header>

      {active && !active.indexed ? (
        <p style={styles.warn}>
          This repository has no index yet. Index it from the CodeGraph sidebar, then reload
          this page. Nothing is drawn from an unindexed repository.
        </p>
      ) : null}

      <div style={styles.body}>
        <aside style={styles.side}>
          <label style={styles.field}>
            <span style={styles.fieldLabel}>Find a symbol</span>
            <input
              type="search"
              value={query}
              placeholder="createOrder, InvoiceService…"
              onChange={(event) => setQuery(event.target.value)}
              style={styles.input}
              aria-label="Find a symbol"
            />
          </label>

          {searching && results.length === 0 ? <Spinner size="sm" label="Searching" /> : null}

          {debounced.length === 0 ? (
            <p style={styles.muted}>Search for a function, class, or method to draw its graph.</p>
          ) : results.length === 0 && !searching ? (
            <p style={styles.muted}>No symbol in this repository matches “{debounced}”.</p>
          ) : (
            <ul style={styles.results}>
              {results.map((node) => (
                <li key={node.id}>
                  <button
                    type="button"
                    onClick={() => setSeedId(node.id)}
                    style={node.id === seedId ? styles.resultActive : styles.result}
                    title={node.qualifiedName || node.name}
                  >
                    <span style={styles.resultName}>{node.name}</span>
                    <span style={styles.resultMeta}>
                      {node.kind} · {node.filePath}
                      {node.startLine === null ? "" : `:${node.startLine}`}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div style={styles.depthRow}>
            <span style={styles.fieldLabel}>Depth</span>
            {DEPTHS.map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setDepth(value)}
                style={value === depth ? styles.depthActive : styles.depth}
                aria-pressed={value === depth}
              >
                {value}
              </button>
            ))}
            <span style={styles.muted}>hops</span>
          </div>
        </aside>

        <main style={styles.main}>
          {!seedId ? (
            <p style={styles.muted}>Pick a symbol on the left to draw its call graph.</p>
          ) : graphLoading && !graphData?.graph ? (
            <Spinner label="Reading the index" />
          ) : graphData?.error ? (
            <p style={styles.bad}>
              {sanitizeErrorMessage(graphData.error)}
              {graphData.reason ? ` (${graphData.reason})` : ""}
            </p>
          ) : graphData?.graph ? (
            <GraphView
              graph={graphData.graph}
              seedId={seedId}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onRecentre={setSeedId}
            />
          ) : null}
        </main>

        <aside style={styles.detail}>
          {seedNode ? (
            <NodeDetail
              node={seedNode}
              source={sourceData}
              sourceLoading={sourceLoading}
            />
          ) : (
            <p style={styles.muted}>Select a node to see its details and source.</p>
          )}
        </aside>
      </div>
    </Shell>
  );
}

// ---------------------------------------------------------------------------
// Graph
// ---------------------------------------------------------------------------

function GraphView({
  graph,
  seedId,
  selectedId,
  onSelect,
  onRecentre,
}: {
  graph: GraphDto;
  seedId: string;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onRecentre: (id: string) => void;
}) {
  const layout = useMemo(() => computeLayout(graph, seedId), [graph, seedId]);
  const scroller = useRef<HTMLDivElement | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);

  // Centre the seed on first draw and whenever the seed changes, so a wide graph
  // opens on the symbol rather than at its left edge.
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const target = Math.max(0, layout.centerX - element.clientWidth / 2);
    element.scrollLeft = target;
  }, [layout.centerX, seedId]);

  const active = hovered ?? selectedId;
  const touched = useMemo(() => {
    if (!active) return null;
    const ids = new Set<string>();
    for (const edge of layout.edges) {
      if (edge.source === active) ids.add(edge.target);
      if (edge.target === active) ids.add(edge.source);
    }
    return ids;
  }, [active, layout.edges]);

  const kinds = graph.edgeKinds.length > 0 ? graph.edgeKinds : ["calls"];

  return (
    <div style={styles.graphWrap}>
      <div style={styles.legend}>
        {kinds.map((kind, index) => (
          <span key={kind} style={styles.legendItem}>
            <span
              aria-hidden
              style={{
                ...styles.legendSwatch,
                background: EDGE_COLOURS[index % EDGE_COLOURS.length],
              }}
            />
            {kind}
          </span>
        ))}
        <span style={styles.legendItem}>{graph.nodes.length} symbols</span>
        {graph.truncated || layout.truncated ? (
          <span style={styles.legendTruncated}>showing a capped subset</span>
        ) : null}
      </div>

      <div ref={scroller} style={styles.scroller}>
        <svg
          role="img"
          aria-label={`Call graph for ${graph.nodes.find((n) => n.id === seedId)?.name ?? "symbol"}`}
          width={layout.width}
          height={layout.height}
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          style={styles.svg}
        >
          <defs>
            <marker
              id="codegraph-arrow"
              viewBox="0 0 8 8"
              refX="7"
              refY="4"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 8 4 L 0 8 z" fill="currentColor" />
            </marker>
          </defs>

          {layout.edges.map((edge) => (
            <EdgePath
              key={`${edge.source}->${edge.target}:${edge.kind}`}
              edge={edge}
              kinds={kinds}
              active={active}
              touched={touched}
            />
          ))}

          {layout.nodes.map((node) => (
            <NodeBox
              key={node.id}
              node={node}
              selected={node.id === selectedId}
              dimmed={touched !== null && node.id !== active && !touched.has(node.id)}
              onHover={setHovered}
              onSelect={onSelect}
              onRecentre={onRecentre}
            />
          ))}
        </svg>
      </div>

      <p style={styles.muted}>
        Click a node to see its source. Double-click to re-centre the graph on it.
      </p>
    </div>
  );
}

/** Background fills for edges, one colour per edge kind. */
const EDGE_COLOURS = ["#64748b", "#0ea5e9", "#a855f7", "#f59e0b", "#14b8a6"];

function EdgePath({
  edge,
  kinds,
  active,
  touched,
}: {
  edge: LayoutEdge;
  kinds: string[];
  active: string | null;
  touched: Set<string> | null;
}) {
  const index = Math.max(0, kinds.indexOf(edge.kind));
  const colour = EDGE_COLOURS[index % EDGE_COLOURS.length];
  const isTouched = active !== null && (edge.source === active || edge.target === active);
  const dim = touched !== null && !isTouched && !edge.isPrimary;

  return (
    <path
      d={edge.path}
      fill="none"
      stroke={isTouched ? "var(--accent, #2563eb)" : colour}
      strokeWidth={isTouched ? 2.4 : edge.isPrimary ? 1.8 : 1.2}
      strokeOpacity={dim ? 0.18 : isTouched ? 1 : 0.65}
      markerEnd="url(#codegraph-arrow)"
      style={{ color: isTouched ? "var(--accent, #2563eb)" : colour }}
    />
  );
}

function NodeBox({
  node,
  selected,
  dimmed,
  onHover,
  onSelect,
  onRecentre,
}: {
  node: LayoutNode;
  selected: boolean;
  dimmed: boolean;
  onHover: (id: string | null) => void;
  onSelect: (id: string) => void;
  onRecentre: (id: string) => void;
}) {
  const x = node.x - node.width / 2;
  const y = node.y - node.height / 2;

  const fill = node.isSeed
    ? "var(--accent, #2563eb)"
    : selected
      ? "var(--card, #ffffff)"
      : "var(--card, #ffffff)";
  const stroke = node.isSeed
    ? "var(--accent, #2563eb)"
    : selected
      ? "var(--accent, #2563eb)"
      : "var(--border, #d4d4d8)";
  const labelColour = node.isSeed ? "#ffffff" : "var(--foreground, #18181b)";

  return (
    <g
      role="button"
      tabIndex={0}
      aria-label={`${node.name}, ${node.kind}`}
      opacity={dimmed ? 0.35 : 1}
      style={{ cursor: "pointer" }}
      onMouseEnter={() => onHover(node.id)}
      onMouseLeave={() => onHover(null)}
      onFocus={() => onHover(node.id)}
      onBlur={() => onHover(null)}
      onClick={() => onSelect(node.id)}
      onDoubleClick={() => onRecentre(node.id)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect(node.id);
        }
      }}
    >
      <rect
        x={x}
        y={y}
        width={node.width}
        height={node.height}
        rx={7}
        fill={fill}
        stroke={stroke}
        strokeWidth={node.isSeed || selected ? 2 : 1}
      />
      <text
        x={node.x}
        y={node.y + 4}
        textAnchor="middle"
        fontSize={12}
        fontWeight={node.isSeed ? 600 : 500}
        fill={labelColour}
        style={{ pointerEvents: "none", userSelect: "none" }}
      >
        {truncateLabel(node.name, node.width)}
      </text>
    </g>
  );
}

/** Node text is clipped to the box rather than allowed to spill over a neighbour. */
function truncateLabel(name: string, width: number): string {
  const capacity = Math.max(6, Math.floor((width - 16) / 7.2));
  return name.length <= capacity ? name : `${name.slice(0, capacity - 1)}…`;
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

function NodeDetail({
  node,
  source,
  sourceLoading,
}: {
  node: GraphNodeDto;
  source: SourceResponse | null;
  sourceLoading: boolean;
}) {
  const pairs = [
    { label: "Symbol", value: node.name },
    { label: "Kind", value: node.kind },
    { label: "Qualified name", value: node.qualifiedName || "—" },
    { label: "File", value: node.filePath },
    {
      label: "Lines",
      value:
        node.startLine === null
          ? "—"
          : node.endLine === null || node.endLine === node.startLine
            ? String(node.startLine)
            : `${node.startLine}–${node.endLine}`,
    },
  ];

  return (
    <div>
      <h3 style={styles.h3}>Source</h3>
      <KeyValueList pairs={pairs} />

      <h4 style={styles.h4}>Code</h4>
      {sourceLoading && !source?.excerpt ? (
        <Spinner size="sm" label="Reading source" />
      ) : source?.error ? (
        <p style={styles.bad}>{sanitizeErrorMessage(source.error)}</p>
      ) : source?.excerpt ? (
        <>
          <pre style={styles.code}>{source.excerpt}</pre>
          {source.truncated ? (
            <p style={styles.muted}>
              Showing lines {source.startLine}–{source.endLine}. The index reports this symbol
              extends further than what is shown — it may be longer than the excerpt limit, or
              the working tree may have moved on since it was indexed.
            </p>
          ) : null}
        </>
      ) : (
        <p style={styles.muted}>
          {source?.reason ?? "No source excerpt available for this symbol."}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chrome
// ---------------------------------------------------------------------------

function Shell({ children }: { children: ReactNode }) {
  return <div style={styles.page}>{children}</div>;
}

/** Inline styles only: a plugin must not import the host's `ui/src` internals. */
const styles: Record<string, CSSProperties> = {
  page: { display: "flex", flexDirection: "column", gap: 12, minHeight: 0, color: "inherit" },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-end",
    gap: 16,
    flexWrap: "wrap",
  },
  headerLeft: { minWidth: 200 },
  headerRight: { display: "flex", alignItems: "flex-end", gap: 10 },
  h2: { fontSize: 20, fontWeight: 600, margin: "0 0 2px" },
  h3: { fontSize: 14, fontWeight: 600, margin: "0 0 8px" },
  h4: {
    fontSize: 11,
    fontWeight: 600,
    margin: "16px 0 6px",
    textTransform: "uppercase",
    letterSpacing: 0.4,
    color: "var(--muted-foreground, #71717a)",
  },
  muted: { color: "var(--muted-foreground, #71717a)", fontSize: 13, margin: "6px 0" },
  bad: { color: "var(--destructive, #dc2626)", fontSize: 13 },
  warn: {
    color: "var(--muted-foreground, #71717a)",
    fontSize: 13,
    margin: 0,
    padding: "8px 12px",
    borderRadius: 8,
    border: "1px solid var(--border, #e4e4e7)",
    background: "var(--muted, rgba(0,0,0,0.03))",
  },
  body: { display: "flex", gap: 16, alignItems: "flex-start", minHeight: 0, flexWrap: "wrap" },
  side: { flex: "0 0 248px", minWidth: 220 },
  main: { flex: "1 1 420px", minWidth: 320 },
  detail: {
    flex: "0 0 320px",
    minWidth: 260,
    maxHeight: "70vh",
    overflowY: "auto",
    paddingLeft: 16,
    borderLeft: "1px solid var(--border, #e4e4e7)",
  },
  field: { display: "block", marginBottom: 10 },
  fieldLabel: {
    display: "block",
    fontSize: 11,
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: 0.4,
    color: "var(--muted-foreground, #71717a)",
    marginBottom: 4,
  },
  input: {
    width: "100%",
    boxSizing: "border-box",
    padding: "8px 10px",
    borderRadius: 6,
    border: "1px solid var(--border, #e4e4e7)",
    background: "var(--background, transparent)",
    color: "inherit",
    fontSize: 13,
    fontFamily: "inherit",
  },
  select: {
    padding: "7px 10px",
    borderRadius: 6,
    border: "1px solid var(--border, #e4e4e7)",
    background: "var(--background, transparent)",
    color: "inherit",
    fontSize: 13,
    fontFamily: "inherit",
    minWidth: 180,
  },
  results: { listStyle: "none", padding: 0, margin: "4px 0 0", maxHeight: "40vh", overflowY: "auto" },
  result: {
    display: "block",
    width: "100%",
    textAlign: "left",
    padding: "7px 9px",
    marginBottom: 4,
    borderRadius: 6,
    border: "1px solid var(--border, #e4e4e7)",
    background: "transparent",
    color: "inherit",
    cursor: "pointer",
    fontFamily: "inherit",
  },
  resultActive: {
    display: "block",
    width: "100%",
    textAlign: "left",
    padding: "7px 9px",
    marginBottom: 4,
    borderRadius: 6,
    border: "1px solid var(--accent, #2563eb)",
    background: "transparent",
    color: "inherit",
    cursor: "pointer",
    fontFamily: "inherit",
  },
  resultName: { display: "block", fontSize: 13, fontWeight: 500 },
  resultMeta: {
    display: "block",
    fontSize: 11,
    color: "var(--muted-foreground, #71717a)",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  depthRow: { display: "flex", alignItems: "center", gap: 6, marginTop: 12, flexWrap: "wrap" },
  depth: {
    width: 28,
    height: 28,
    borderRadius: 6,
    border: "1px solid var(--border, #e4e4e7)",
    background: "transparent",
    color: "inherit",
    cursor: "pointer",
    fontFamily: "inherit",
    fontSize: 12,
  },
  depthActive: {
    width: 28,
    height: 28,
    borderRadius: 6,
    border: "1px solid var(--accent, #2563eb)",
    background: "var(--accent, #2563eb)",
    color: "#ffffff",
    cursor: "pointer",
    fontFamily: "inherit",
    fontSize: 12,
  },
  graphWrap: {
    border: "1px solid var(--border, #e4e4e7)",
    borderRadius: 10,
    padding: 12,
    background: "var(--card, transparent)",
  },
  legend: { display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap", fontSize: 11, marginBottom: 8 },
  legendItem: { display: "inline-flex", alignItems: "center", gap: 5, color: "var(--muted-foreground, #71717a)" },
  legendSwatch: { width: 14, height: 2, borderRadius: 1, display: "inline-block" },
  legendTruncated: { color: "var(--destructive, #dc2626)" },
  scroller: {
    overflow: "auto",
    maxHeight: "60vh",
    border: "1px solid var(--border, #e4e4e7)",
    borderRadius: 8,
    background: "var(--background, transparent)",
  },
  svg: { display: "block" },
  code: {
    margin: 0,
    padding: 10,
    borderRadius: 8,
    border: "1px solid var(--border, #e4e4e7)",
    background: "var(--code-bg-resolved, rgba(0,0,0,0.04))",
    fontSize: 11.5,
    lineHeight: 1.5,
    overflowX: "auto",
    maxHeight: "40vh",
    whiteSpace: "pre",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  },
};
