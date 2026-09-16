/**
 * The CodeGraph page.
 *
 * Modelled on CodeGraph's own `codegraph ui` rather than invented, because that
 * reader already answers the question this page exists to answer: *who calls
 * this, and what does it call?* The layout is three panes —
 *
 *     callers  |  the symbol's verbatim source  |  callees
 *
 * — and the detail that makes it work is that each callee is drawn **beside the
 * line that calls it**. A call graph as a diagram answers "what is connected to
 * what"; aligned with the source it answers "where does this happen", which is
 * what someone reading code actually asks.
 *
 * Two constraints shaped this:
 *
 * 1. The CodeGraph viewer binds loopback and plugin UI routes return JSON only,
 *    so it cannot be embedded. The worker reads the index and this draws it.
 * 2. Nothing here accepts a path. The operator picks a *project*; the worker
 *    resolves its repository through the host, as every other surface does.
 *
 * A repository selector appears in the header when the organisation has more than
 * one, since the graph is per repository while search spans them.
 */

import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { usePluginData, type PluginPageProps } from "@paperclipai/plugin-sdk/ui";

import { DATA_KEYS } from "../plugin-keys.js";
import { sanitizeErrorMessage } from "../errors.js";
import { reader } from "./chrome.js";

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

interface RepoRow {
  projectId: string;
  name: string;
  alias: string;
  repoName?: string | null;
  indexed: boolean;
  blocked?: boolean;
}

interface SymbolRef {
  id: string;
  name: string;
  qualifiedName: string;
  kind: string;
  filePath: string;
  startLine: number | null;
  endLine: number | null;
}

interface CallRef extends SymbolRef {
  /** The line in this caller/callee's own file that makes the call. */
  callLine: number | null;
  edgeKind: string;
}

interface ReaderResponse {
  seed?: SymbolRef;
  callers?: CallRef[];
  callees?: CallRef[];
  callerCount?: number;
  calleeCount?: number;
  truncated?: boolean;
  error?: string;
  reason?: string;
}

interface SearchResponse {
  results?: SymbolRef[];
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

const KIND_LABELS: Record<string, string> = {
  function: "Functions",
  method: "Methods",
  class: "Classes",
  interface: "Interfaces",
  type: "Types",
  constant: "Constants",
  component: "Components",
  import: "Imports",
  file: "Files",
};

function kindGroup(kind: string): string {
  return KIND_LABELS[kind] ?? (kind ? `${kind[0]!.toUpperCase()}${kind.slice(1)}s` : "Other");
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function CodeGraphPage({ context }: PluginPageProps) {
  const companyId = context.companyId ?? null;

  const { data: reposData, loading: reposLoading } = usePluginData<{
    organization?: string | null;
    repositories: RepoRow[];
    enabled?: boolean;
  }>(DATA_KEYS.graphProjects, { companyId });

  const repositories = useMemo(
    () => (reposData?.repositories ?? []).filter((repo) => repo.blocked !== true),
    [reposData],
  );
  const organization = reposData?.organization ?? null;

  const [projectId, setProjectId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [selected, setSelected] = useState<SymbolRef | null>(null);

  // Open on the first indexed repository, so the page never greets an operator
  // with an error about a repository they did not choose.
  useEffect(() => {
    if (projectId || repositories.length === 0) return;
    const preferred = repositories.find((repo) => repo.indexed) ?? repositories[0];
    if (preferred) setProjectId(preferred.projectId);
  }, [projectId, repositories]);

  // Search is scoped to the chosen repository, so switching it invalidates both
  // the results and whatever was open.
  useEffect(() => {
    setSelected(null);
  }, [projectId]);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 200);
    return () => clearTimeout(timer);
  }, [query]);

  const { data: searchData, loading: searching } = usePluginData<SearchResponse>(
    DATA_KEYS.graphSearch,
    { companyId, projectId, query: debounced },
  );

  const readerParams = useMemo(
    () => ({ companyId, projectId, nodeId: selected?.id ?? null }),
    [companyId, projectId, selected],
  );
  const { data: readerData, loading: readerLoading } = usePluginData<ReaderResponse>(
    DATA_KEYS.graphReader,
    readerParams,
  );

  const { data: sourceData, loading: sourceLoading } = usePluginData<SourceResponse>(
    DATA_KEYS.graphSource,
    { companyId, projectId, nodeId: selected?.id ?? null },
  );

  const results = searchData?.results ?? [];
  const active = repositories.find((repo) => repo.projectId === projectId) ?? null;

  if (!companyId) {
    return (
      <div style={styles.page}>
        <p style={styles.dim}>Open this page inside an organization to read its code graph.</p>
      </div>
    );
  }

  if (reposLoading && repositories.length === 0) {
    return (
      <div style={styles.page}>
        <p style={styles.dim}>Finding repositories…</p>
      </div>
    );
  }

  return (
    <div style={styles.page}>
      <header style={styles.topbar}>
        <div style={styles.brand}>
          <span aria-hidden style={styles.brandMark} />
          <span style={styles.brandName}>CodeGraph</span>
          {repositories.length > 1 ? (
            <select
              aria-label="Repository"
              value={projectId ?? ""}
              onChange={(event) => setProjectId(event.target.value || null)}
              style={styles.repoSelect}
            >
              {repositories.map((repo) => (
                <option key={repo.projectId} value={repo.projectId}>
                  {repo.name}
                  {repo.indexed ? "" : " — not indexed"}
                </option>
              ))}
            </select>
          ) : (
            <span style={styles.brandProject}>
              {active?.repoName ?? active?.alias ?? organization ?? "no repository"}
            </span>
          )}
        </div>

        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search a symbol or a file…"
          aria-label="Search a symbol or a file"
          style={styles.search}
        />

        <div style={styles.stats}>
          {active?.indexed
            ? `${repositories.length} repositor${repositories.length === 1 ? "y" : "ies"} · indexed`
            : active
              ? "not indexed"
              : ""}
        </div>
      </header>

      {repositories.length === 0 ? (
        <p style={styles.notice}>
          This organization has no repository workspaces, so there is nothing to read. A
          repository appears once a Paperclip project here has one.
        </p>
      ) : active && !active.indexed ? (
        <p style={styles.notice}>
          This repository has no index yet. Build one in Settings → Plugins → CodeGraph, then
          reopen this page.
        </p>
      ) : null}

      <div style={styles.body}>
        <Pane
          title="Callers"
          count={readerData?.callerCount}
          shown={readerData?.callers?.length}
          empty={selected ? "Nothing calls this." : "Who calls the symbol you open."}
        >
          {(readerData?.callers ?? []).map((call) => (
            <CallRow key={`in:${call.id}:${call.callLine}`} call={call} onOpen={setSelected} />
          ))}
        </Pane>

        <main style={styles.sourcePane}>
          {!selected ? (
            debounced.length === 0 ? (
              <div style={styles.emptyState}>
                <h2 style={styles.emptyTitle}>Nothing selected</h2>
                <p style={styles.emptyBody}>
                  Search for a symbol to start reading{organization ? ` in ${organization}` : ""}.
                </p>
                <p style={styles.emptyBody}>
                  Every symbol you open shows who calls it on the left, its source here, and
                  what it calls on the right — each callee lined up with the line that calls it.
                </p>
              </div>
            ) : (
              <div style={styles.resultsWrap}>
                {searching && results.length === 0 ? (
                  <p style={styles.dim}>Searching…</p>
                ) : results.length === 0 ? (
                  <p style={styles.dim}>No symbol matches “{debounced}”.</p>
                ) : (
                  <Results results={results} onOpen={setSelected} />
                )}
              </div>
            )
          ) : (
            <Source
              symbol={selected}
              source={sourceData}
              loading={sourceLoading}
              callees={readerData?.callees ?? []}
              onOpen={setSelected}
            />
          )}
        </main>

        <Pane
          title="Callees"
          count={readerData?.calleeCount}
          shown={readerData?.callees?.length}
          empty={selected ? "This calls nothing recorded." : "What the symbol you open calls."}
        >
          {(readerData?.callees ?? []).map((call) => (
            <CallRow key={`out:${call.id}:${call.callLine}`} call={call} onOpen={setSelected} />
          ))}
        </Pane>
      </div>

      {selected ? (
        <footer style={styles.trail}>
          <span style={styles.trailLabel}>Reading</span>
          <code style={styles.trailCode}>
            {selected.name} — {selected.filePath}
            {selected.startLine === null ? "" : `:${selected.startLine}`}
          </code>
          <button type="button" style={styles.trailButton} onClick={() => setSelected(null)}>
            Back to search
          </button>
          {readerLoading ? <span style={styles.dim}>updating…</span> : null}
          {readerData?.error ? (
            <span style={styles.error}>{sanitizeErrorMessage(readerData.error)}</span>
          ) : null}
        </footer>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Search results
// ---------------------------------------------------------------------------

/** Results grouped by symbol kind, the way the CodeGraph viewer lists them. */
function Results({
  results,
  onOpen,
}: {
  results: SymbolRef[];
  onOpen: (symbol: SymbolRef) => void;
}) {
  const groups = useMemo(() => {
    const byGroup = new Map<string, SymbolRef[]>();
    for (const symbol of results) {
      const key = kindGroup(symbol.kind);
      const list = byGroup.get(key);
      if (list) list.push(symbol);
      else byGroup.set(key, [symbol]);
    }
    return [...byGroup.entries()];
  }, [results]);

  return (
    <div>
      {groups.map(([group, symbols]) => (
        <section key={group} style={styles.resultGroup}>
          <h3 style={styles.resultGroupTitle}>{group}</h3>
          <ul style={styles.resultList}>
            {symbols.map((symbol) => (
              <li key={symbol.id}>
                <button type="button" style={styles.resultRow} onClick={() => onOpen(symbol)}>
                  <span style={styles.resultGlyph}>{glyphFor(symbol.kind)}</span>
                  <span style={styles.resultName}>{symbol.name}</span>
                  {symbol.qualifiedName && symbol.qualifiedName !== symbol.name ? (
                    <span style={styles.resultQualified}>{symbol.qualifiedName}</span>
                  ) : null}
                  <span style={styles.resultWhere}>
                    {symbol.filePath}
                    {symbol.startLine === null ? "" : `:${symbol.startLine}`}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function glyphFor(kind: string): string {
  if (kind === "function" || kind === "method") return "ƒ";
  if (kind === "class") return "C";
  if (kind === "interface" || kind === "type") return "I";
  if (kind === "component") return "◫";
  if (kind === "constant") return "const";
  if (kind === "import") return "im";
  return "•";
}

// ---------------------------------------------------------------------------
// Source
// ---------------------------------------------------------------------------

/**
 * The symbol's source, in the middle pane.
 *
 * The worker returns a bounded, line-numbered excerpt, so this is two columns: a
 * gutter of true line numbers and the text. Keeping the numbers from the file
 * rather than re-counting the excerpt means a line cited here is the same line a
 * reviewer's editor shows, and the same line the caller and callee panes cite.
 *
 * Lines that call something are tinted, so the correspondence between this pane
 * and the right-hand one is visible without hunting for it.
 */
function Source({
  symbol,
  source,
  loading,
  callees,
  onOpen,
}: {
  symbol: SymbolRef;
  source: SourceResponse | null;
  loading: boolean;
  callees: CallRef[];
  onOpen: (symbol: SymbolRef) => void;
}) {
  const callLines = useMemo(
    () =>
      new Set(
        callees
          .map((call) => call.callLine)
          .filter((line): line is number => line !== null),
      ),
    [callees],
  );

  const lines = useMemo(() => {
    const text = source?.excerpt ?? "";
    if (text.length === 0) return [];
    return text.split("\n").map((row) => {
      const tab = row.indexOf("\t");
      const number = tab === -1 ? null : Number(row.slice(0, tab));
      return { number, text: tab === -1 ? row : row.slice(tab + 1) };
    });
  }, [source?.excerpt]);

  return (
    <div style={styles.sourceWrap}>
      <div style={styles.sourceHead}>
        <span style={styles.sourceName}>{symbol.name}</span>
        <span style={styles.sourceKind}>{symbol.kind}</span>
        <span style={styles.sourcePath}>
          {symbol.filePath}
          {symbol.startLine === null ? "" : `:${symbol.startLine}`}
        </span>
      </div>

      {loading && lines.length === 0 ? (
        <p style={styles.dim}>Reading source…</p>
      ) : source?.error ? (
        <p style={styles.error}>{sanitizeErrorMessage(source.error)}</p>
      ) : lines.length === 0 ? (
        <p style={styles.dim}>{source?.reason ?? "No source is available for this symbol."}</p>
      ) : (
        <div style={styles.code}>
          {lines.map((line, index) => (
            <div
              key={line.number ?? `x${index}`}
              style={
                line.number !== null && callLines.has(line.number)
                  ? styles.codeLineCalling
                  : styles.codeLine
              }
            >
              <span style={styles.gutter}>{line.number ?? ""}</span>
              <span style={styles.codeText}>{line.text}</span>
            </div>
          ))}
        </div>
      )}

      {source?.truncated ? (
        <p style={styles.dim}>
          Showing lines {source.startLine}–{source.endLine}. The index reports this symbol
          extends further; it may be longer than the excerpt limit, or the working tree may
          have moved on since it was indexed.
        </p>
      ) : null}

      {/* The line-aligned list, mirroring the viewer's right-hand column. */}
      {callees.filter((call) => call.callLine !== null).length > 0 ? (
        <div style={styles.aligned}>
          <h4 style={styles.alignedTitle}>Called from this source, in order</h4>
          <ul style={styles.alignedList}>
            {callees
              .filter((call) => call.callLine !== null)
              .slice()
              .sort((a, b) => (a.callLine ?? 0) - (b.callLine ?? 0))
              .map((call) => (
                <li key={`${call.id}:${call.callLine}`} style={styles.alignedRow}>
                  <span style={styles.alignedLine}>L{call.callLine}</span>
                  <a
                    href="#"
                    style={styles.alignedLink}
                    onClick={(event) => {
                      event.preventDefault();
                      onOpen(call);
                    }}
                  >
                    {call.name}
                  </a>
                  <span style={styles.alignedWhere}>{call.filePath}</span>
                </li>
              ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Panes
// ---------------------------------------------------------------------------

function Pane({
  title,
  count,
  shown,
  empty,
  children,
}: {
  title: string;
  count?: number;
  shown?: number;
  empty: string;
  children: ReactNode;
}) {
  const hasChildren = Array.isArray(children) ? children.length > 0 : Boolean(children);
  const hidden = count !== undefined && shown !== undefined ? count - shown : 0;

  return (
    <aside style={styles.pane}>
      <div style={styles.paneHead}>
        <h3 style={styles.paneTitle}>{title}</h3>
        {count !== undefined && count > 0 ? <span style={styles.paneCount}>{count}</span> : null}
      </div>
      <div style={styles.paneBody}>
        {hasChildren ? children : <p style={styles.dim}>{empty}</p>}
      </div>
      {hidden > 0 ? <p style={styles.dim}>+{hidden} more not shown</p> : null}
    </aside>
  );
}

/** One caller or callee: its name, where it lives, and the line that calls. */
function CallRow({ call, onOpen }: { call: CallRef; onOpen: (symbol: SymbolRef) => void }) {
  const handle = useCallback(() => onOpen(call), [call, onOpen]);
  return (
    <button type="button" style={styles.callRow} onClick={handle}>
      <span style={styles.callName}>{call.name}</span>
      <span style={styles.callWhere}>
        {call.filePath}
        {call.callLine === null ? "" : `:${call.callLine}`}
      </span>
      {call.edgeKind && call.edgeKind !== "calls" ? (
        <span style={styles.callKind}>{call.edgeKind}</span>
      ) : null}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

/**
 * Warm paper, one ink scale, one accent — CodeGraph's own palette, so someone who
 * knows `codegraph ui` recognises this page. Deliberately not the host's tokens:
 * this is a light reading surface, and inheriting a dark theme would break it.
 */
const styles: Record<string, CSSProperties> = {
  page: {
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
    height: "100%",
    background: reader.paper,
    color: reader.ink,
    fontFamily: reader.sans,
    fontSize: 13,
  },
  topbar: {
    display: "flex",
    alignItems: "center",
    gap: 14,
    padding: "0 14px",
    minHeight: 48,
    borderBottom: `1px solid ${reader.ruleFaint}`,
    background: reader.paper,
    flexWrap: "wrap",
  },
  brand: { display: "flex", alignItems: "center", gap: 8, flex: "0 0 auto" },
  brandMark: {
    width: 10,
    height: 10,
    borderRadius: 2,
    background: reader.accent,
    display: "inline-block",
  },
  brandName: { fontWeight: 600, fontSize: 14, letterSpacing: -0.2 },
  brandProject: { color: reader.ink2, fontFamily: reader.mono, fontSize: 12 },
  repoSelect: {
    fontFamily: reader.mono,
    fontSize: 12,
    padding: "3px 6px",
    borderRadius: 4,
    border: `1px solid ${reader.rule}`,
    background: reader.paper,
    color: reader.ink,
  },
  search: {
    flex: "1 1 260px",
    minWidth: 200,
    padding: "7px 10px",
    borderRadius: 4,
    border: `1px solid ${reader.rule}`,
    background: reader.paper,
    color: reader.ink,
    fontFamily: reader.sans,
    fontSize: 13,
  },
  stats: { color: reader.ink3, fontSize: 11.5, fontFamily: reader.mono, flex: "0 0 auto" },
  notice: {
    margin: 0,
    padding: "9px 14px",
    background: reader.amberSoft,
    color: reader.amber,
    fontSize: 12.5,
  },
  body: {
    display: "flex",
    alignItems: "stretch",
    flex: "1 1 auto",
    minHeight: 0,
    overflow: "hidden",
  },
  pane: {
    flex: "0 0 232px",
    display: "flex",
    flexDirection: "column",
    minWidth: 0,
    borderRight: `1px solid ${reader.ruleFaint}`,
    background: reader.paper2,
    overflowY: "auto",
  },
  paneHead: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    padding: "9px 12px 6px",
  },
  paneTitle: {
    margin: 0,
    fontSize: 11,
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    color: reader.ink3,
  },
  paneCount: { fontSize: 11, color: reader.ink4, fontFamily: reader.mono },
  paneBody: { padding: "0 8px 12px", display: "flex", flexDirection: "column", gap: 1 },
  sourcePane: {
    flex: "1 1 auto",
    minWidth: 0,
    overflowY: "auto",
    background: reader.paper,
    padding: "0 0 24px",
  },
  resultsWrap: { padding: 16 },
  resultGroup: { marginBottom: 18 },
  resultGroupTitle: {
    margin: "0 0 6px",
    fontSize: 11,
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    color: reader.ink3,
  },
  resultList: { listStyle: "none", margin: 0, padding: 0 },
  resultRow: {
    display: "flex",
    alignItems: "baseline",
    gap: 8,
    width: "100%",
    textAlign: "left",
    padding: "5px 8px",
    border: "none",
    borderLeft: "2px solid transparent",
    background: "transparent",
    color: "inherit",
    cursor: "pointer",
    fontFamily: "inherit",
    fontSize: 13,
  },
  resultGlyph: {
    flex: "0 0 26px",
    color: reader.accent,
    fontFamily: reader.mono,
    fontSize: 11,
  },
  resultName: { fontWeight: 500, flex: "0 0 auto" },
  resultQualified: {
    color: reader.ink3,
    fontSize: 11.5,
    fontFamily: reader.mono,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    flex: "1 1 auto",
  },
  resultWhere: {
    marginLeft: "auto",
    color: reader.ink4,
    fontSize: 11,
    fontFamily: reader.mono,
    flex: "0 0 auto",
  },
  emptyState: { maxWidth: 560, padding: "56px 32px" },
  emptyTitle: { margin: "0 0 8px", fontSize: 20, fontWeight: 600, letterSpacing: -0.3 },
  emptyBody: { margin: "0 0 10px", color: reader.ink2, lineHeight: 1.55 },
  sourceWrap: { padding: "12px 16px 0" },
  sourceHead: {
    display: "flex",
    alignItems: "baseline",
    gap: 8,
    flexWrap: "wrap",
    paddingBottom: 8,
    borderBottom: `1px solid ${reader.ruleFaint}`,
    marginBottom: 10,
  },
  sourceName: { fontSize: 15, fontWeight: 600 },
  sourceKind: {
    fontSize: 11,
    color: reader.ink3,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  sourcePath: { marginLeft: "auto", fontFamily: reader.mono, fontSize: 11.5, color: reader.ink3 },
  code: {
    fontFamily: reader.mono,
    fontSize: 12.5,
    lineHeight: "20px",
    background: reader.paper,
    border: `1px solid ${reader.ruleFaint}`,
    borderRadius: 4,
    overflowX: "auto",
  },
  codeLine: { display: "flex", gap: 0, paddingRight: 10 },
  codeLineCalling: {
    display: "flex",
    gap: 0,
    paddingRight: 10,
    background: reader.accentSoft,
    boxShadow: `inset 2px 0 0 ${reader.accentLine}`,
  },
  gutter: {
    flex: "0 0 46px",
    textAlign: "right",
    paddingRight: 10,
    color: reader.ink4,
    userSelect: "none",
  },
  codeText: { whiteSpace: "pre", flex: "1 1 auto" },
  aligned: { marginTop: 18 },
  alignedTitle: {
    margin: "0 0 6px",
    fontSize: 11,
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    color: reader.ink3,
  },
  alignedList: { listStyle: "none", margin: 0, padding: 0 },
  alignedRow: { display: "flex", alignItems: "baseline", gap: 8, padding: "2px 0" },
  alignedLine: {
    flex: "0 0 56px",
    textAlign: "right",
    fontFamily: reader.mono,
    fontSize: 11,
    color: reader.ink4,
  },
  alignedLink: {
    color: reader.accent,
    textDecoration: "none",
    fontWeight: 500,
    fontFamily: reader.mono,
    fontSize: 12.5,
  },
  alignedWhere: { color: reader.ink4, fontSize: 11, fontFamily: reader.mono },
  callRow: {
    display: "flex",
    flexDirection: "column",
    gap: 1,
    width: "100%",
    textAlign: "left",
    padding: "5px 8px",
    border: "none",
    borderRadius: 4,
    background: "transparent",
    color: "inherit",
    cursor: "pointer",
    fontFamily: "inherit",
  },
  callName: { fontSize: 12.5, fontWeight: 500, fontFamily: reader.mono },
  callWhere: { fontSize: 10.5, color: reader.ink4, fontFamily: reader.mono },
  callKind: {
    fontSize: 10,
    color: reader.accent,
    fontFamily: reader.mono,
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  trail: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "7px 14px",
    borderTop: `1px solid ${reader.ruleFaint}`,
    background: reader.paper2,
    flexWrap: "wrap",
  },
  trailLabel: {
    fontSize: 10.5,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    color: reader.ink3,
    fontWeight: 600,
  },
  trailCode: { fontFamily: reader.mono, fontSize: 11.5, color: reader.ink2 },
  trailButton: {
    marginLeft: "auto",
    padding: "4px 10px",
    borderRadius: 4,
    border: `1px solid ${reader.rule}`,
    background: reader.paper,
    color: reader.ink,
    cursor: "pointer",
    fontFamily: "inherit",
    fontSize: 12,
  },
  dim: { color: reader.ink3, fontSize: 12, margin: "6px 0" },
  error: { color: reader.accent, fontSize: 12, margin: "6px 0" },
};
