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

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  useHostLocation,
  useHostNavigation,
  usePluginData,
  type PluginPageProps,
} from "@paperclipai/plugin-sdk/ui";

import { DATA_KEYS } from "../plugin-keys.js";
import { sanitizeErrorMessage } from "../errors.js";
import { ui } from "./chrome.js";
import { MapView } from "./map-view.js";
import {
  DeadCodeView,
  EntryPointsView,
  FlowView,
  StepsView,
} from "./views-panels.js";
import { VIEW_LABELS, VIEW_NOTES, viewFromHash } from "./views.js";
import { parseSearchIntent } from "./search-intent.js";
import { readerLayout, showsSidePanes } from "./reader-layout.js";

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

/**
 * The reader's payload, and the map's.
 *
 * The map is served by `graph-neighbourhood`, which returns the same seed,
 * caller and callee shape alongside the raw graph — so one type describes both
 * and the two views cannot drift apart.
 */
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

/**
 * Measures the page and decides how many panes fit.
 *
 * A ResizeObserver rather than a media query: the host's content column can be
 * narrow on a wide screen (a pinned sidebar, a split view), so the viewport width
 * is the wrong number to branch on. The observed element is the page itself,
 * which is the box the panes have to fit inside.
 */
function useReaderLayout(): {
  kind: ReturnType<typeof readerLayout>;
  ref: (node: HTMLElement | null) => void;
} {
  const [width, setWidth] = useState(0);
  const observer = useRef<ResizeObserver | null>(null);

  const ref = useCallback((node: HTMLElement | null) => {
    observer.current?.disconnect();
    if (!node) return;

    setWidth(node.clientWidth);
    if (typeof ResizeObserver === "undefined") return;

    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setWidth(entry.contentRect.width);
    });
    ro.observe(node);
    observer.current = ro;
  }, []);

  useEffect(() => () => observer.current?.disconnect(), []);

  return { kind: readerLayout(width), ref };
}

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
  // The view lives in the URL, so the rail can link to it, a reload keeps it, and
  // the two cannot disagree about which is open.
  const { hash } = useHostLocation();
  const navigation = useHostNavigation();
  const view = viewFromHash(hash);
  const layout = useReaderLayout();
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [selected, setSelected] = useState<SymbolRef | null>(null);

  /**
   * Open a symbol in the reader.
   *
   * Set from another view's row (a route's handler, a dead-code candidate), so it
   * switches to the Symbol tab too — otherwise the selection would change behind
   * a view that cannot show it.
   */
  const openInReader = useCallback((symbol: SymbolRef) => {
    setSelected(symbol);
    navigation.navigate("/codegraph#symbol");
  }, [navigation]);

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
  // The placeholder offers a question; recognise one so the answer can be honest
  // rather than "no symbol matches".
  const intent = useMemo(() => parseSearchIntent(debounced), [debounced]);
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
    <div ref={layout.ref} style={styles.page}>
      {/*
        One toolbar, ordered as the viewer's is: search on the left, then the
        repository and index state on the right. Search is deliberately the widest
        thing here — it is the only control used constantly, and the repository
        changes once a session.
      */}
      <header style={styles.topbar}>
        <div style={styles.searchWrap}>
          <span aria-hidden style={styles.searchIcon}>
            {/* Drawn inline: the page cannot import the host's icon set. */}
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
          </span>
          <input
            type="search"
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              // Escape clears, then blurs — the host's own search behaves this way.
              if (event.key !== "Escape") return;
              if (query.length > 0) {
                event.preventDefault();
                setQuery("");
              } else {
                event.currentTarget.blur();
              }
            }}
            placeholder={
              "Search a symbol or file, or ask \u201chow does execute reach getFile\u201d \u2014 press / to focus"
            }
            aria-label="Search query"
            style={styles.search}
          />
          {query.length > 0 ? (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => setQuery("")}
              style={styles.searchClear}
            >
              ✕
            </button>
          ) : (
            <kbd aria-hidden style={styles.searchKbd}>
              /
            </kbd>
          )}
        </div>

        <div style={styles.topbarRight}>
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
            <span style={styles.repoName}>
              {active?.repoName ?? active?.alias ?? organization ?? "no repository"}
            </span>
          )}
          {active?.indexed ? (
            <span style={styles.stats}>{repositories.length} indexed</span>
          ) : active ? (
            <span style={styles.stats}>not indexed</span>
          ) : null}
        </div>
      </header>

      <div style={styles.viewHeader}>
        <h2 style={styles.viewTitle}>{VIEW_LABELS[view]}</h2>
        <p style={styles.viewNote}>{VIEW_NOTES[view]}</p>
      </div>

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

      {view === "map" ? (
        <MapView companyId={companyId} projectId={projectId} organization={organization} />
      ) : view === "entrypoints" ? (
        <EntryPointsView
          companyId={companyId}
          projectId={projectId}
          onOpen={(nodeId, name) =>
            openInReader({
              id: nodeId,
              name,
              qualifiedName: "",
              kind: "",
              filePath: "",
              startLine: null,
              endLine: null,
            })
          }
        />
      ) : view === "deadcode" ? (
        <DeadCodeView
          companyId={companyId}
          projectId={projectId}
          onOpen={(nodeId, name) =>
            openInReader({
              id: nodeId,
              name,
              qualifiedName: "",
              kind: "",
              filePath: "",
              startLine: null,
              endLine: null,
            })
          }
        />
      ) : view === "steps" ? (
        <StepsView />
      ) : view === "flow" ? (
        <FlowView />
      ) : (
      <div style={showsSidePanes(layout.kind) ? styles.body : styles.bodyStacked}>
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
            ) : intent.kind === "question" ? (
              <QuestionPanel
                from={intent.from ?? ""}
                to={intent.to ?? ""}
                raw={intent.raw}
                onSearch={(term) => setQuery(term)}
              />
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
      )}

      {selected ? (
        /*
         * A status strip, not navigation. There is no back button here on
         * purpose: this is a full page inside Paperclip, so going back is the
         * browser, the company nav, or the browser's own history — a plugin
         * inventing its own back affordance duplicates chrome the host already
         * shows, and it is what made the page feel like a separate app.
         */
        <footer style={styles.trail}>
          <span style={styles.trailLabel}>Reading</span>
          <code style={styles.trailCode}>
            {selected.name} — {selected.filePath}
            {selected.startLine === null ? "" : `:${selected.startLine}`}
          </code>
          {readerLoading ? <span style={styles.dim}>updating…</span> : null}
          {readerData?.error ? (
            <span style={styles.error}>{sanitizeErrorMessage(readerData.error)}</span>
          ) : null}
        </footer>
      ) : null}
    </div>
  );
}

/**
 * What a question typed into the search box gets.
 *
 * The placeholder invites one — "ask 'how does execute reach getFile'" — so
 * answering "no symbol matches" would be the box failing at something it
 * advertised. What it says instead is what is true: the path search behind that
 * question is the Flow view, which this plugin does not implement, and here is the
 * next best thing that does work.
 */
function QuestionPanel({
  from,
  to,
  raw,
  onSearch,
}: {
  from: string;
  to: string;
  raw: string;
  onSearch: (term: string) => void;
}) {
  return (
    <div style={styles.resultsWrap}>
      <h2 style={styles.questionTitle}>That is a question, not a symbol</h2>
      <p style={styles.questionBody}>
        You asked: <em>{raw}</em>
      </p>
      <p style={styles.questionBody}>
        Answering it needs a path search between <code>{from}</code> and <code>{to}</code> —
        the same traversal behind CodeGraph&apos;s own <strong>Flow</strong> view, which this
        plugin does not implement: it keeps no call-path history to walk. Rather than guess
        at a route between them, here is what does work:
      </p>
      <ul style={styles.questionList}>
        <li style={styles.questionItem}>
          <button type="button" style={styles.questionLink} onClick={() => onSearch(from)}>
            Open {from}
          </button>{" "}
          and follow what it calls, each row citing the line that calls it.
        </li>
        <li style={styles.questionItem}>
          <button type="button" style={styles.questionLink} onClick={() => onSearch(to)}>
            Open {to}
          </button>{" "}
          and read who calls it, which is the same path from the other end.
        </li>
        <li style={styles.questionItem}>
          The <strong>Map</strong> view shows how the modules are layered, if the question is
          really about shape rather than a specific path.
        </li>
        <li style={styles.questionItem}>
          For the path itself, run <code>codegraph ui</code> on the host — it is a local tool
          and needs no Paperclip wiring.
        </li>
      </ul>
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
  /*
   * Sizing, given a host container this page does not control.
   *
   * A plugin page is dropped into whatever wrapper the host provides, and that
   * wrapper may or may not have a height. `height: 100%` alone collapses to the
   * content height when it does not, which is how the panes came out the wrong
   * size; a fixed pixel height would overflow on a short window. So: fill the
   * parent when it has a height, and never exceed the viewport either way.
   */
  page: {
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
    height: "100%",
    maxHeight: "100vh",
    boxSizing: "border-box",
    background: ui.background,
    color: ui.foreground,
    fontFamily: ui.fontSans,
    fontSize: 13,
  },
  topbar: {
    display: "flex",
    alignItems: "center",
    gap: 14,
    padding: "0 14px",
    minHeight: 48,
    borderBottom: `1px solid ${ui.border}`,
    background: ui.background,
    flexWrap: "wrap",
  },
  topbarRight: { display: "flex", alignItems: "center", gap: 10, flex: "0 0 auto" },
  repoName: { fontFamily: ui.fontMono, fontSize: 12, color: ui.mutedForeground },
  repoSelect: {
    fontFamily: ui.fontMono,
    fontSize: 12,
    padding: "3px 6px",
    borderRadius: 4,
    border: `1px solid ${ui.border}`,
    background: ui.background,
    color: ui.foreground,
  },
  search: {
    flex: "1 1 260px",
    minWidth: 200,
    padding: "7px 10px",
    borderRadius: 4,
    border: `1px solid ${ui.border}`,
    background: ui.background,
    color: ui.foreground,
    fontFamily: ui.fontSans,
    fontSize: 13,
  },
  stats: { color: ui.mutedForeground, fontSize: 11.5, fontFamily: ui.fontMono, flex: "0 0 auto" },
  notice: {
    margin: 0,
    padding: "9px 14px",
    background: ui.muted,
    color: ui.mutedForeground,
    fontSize: 12.5,
  },
  body: {
    display: "flex",
    alignItems: "stretch",
    flex: "1 1 auto",
    minHeight: 0,
    overflow: "hidden",
    flexWrap: "nowrap",
  },
  pane: {
    // minWidth 0 so a long symbol name cannot push the pane wider than its
    // share; the truncation happens inside the row instead.
    flex: "0 1 232px",
    display: "flex",
    flexDirection: "column",
    minWidth: 0,
    borderRight: `1px solid ${ui.border}`,
    background: ui.muted,
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
    color: ui.mutedForeground,
  },
  paneCount: { fontSize: 11, color: ui.mutedForeground, fontFamily: ui.fontMono },
  paneBody: { padding: "0 8px 12px", display: "flex", flexDirection: "column", gap: 1 },
  sourcePane: {
    flex: "1 1 auto",
    minWidth: 0,
    overflowY: "auto",
    background: ui.background,
    padding: "0 0 24px",
  },
  resultsWrap: { padding: 16 },
  questionTitle: { margin: "0 0 10px", fontSize: 17, fontWeight: 600, letterSpacing: -0.2 },
  questionBody: { margin: "0 0 10px", color: ui.mutedForeground, lineHeight: 1.55, maxWidth: 640 },
  questionList: { margin: "0 0 0 4px", padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 8, maxWidth: 640 },
  questionItem: { color: ui.mutedForeground, lineHeight: 1.5, fontSize: 12.5 },
  questionLink: {
    padding: 0,
    border: "none",
    background: "transparent",
    color: ui.primary,
    cursor: "pointer",
    fontFamily: ui.fontMono,
    fontSize: 12.5,
    textDecoration: "underline",
  },
  resultGroup: { marginBottom: 18 },
  resultGroupTitle: {
    margin: "0 0 6px",
    fontSize: 11,
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    color: ui.mutedForeground,
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
    color: ui.primary,
    fontFamily: ui.fontMono,
    fontSize: 11,
  },
  resultName: { fontWeight: 500, flex: "0 0 auto" },
  resultQualified: {
    color: ui.mutedForeground,
    fontSize: 11.5,
    fontFamily: ui.fontMono,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    flex: "1 1 auto",
  },
  resultWhere: {
    marginLeft: "auto",
    color: ui.mutedForeground,
    fontSize: 11,
    fontFamily: ui.fontMono,
    flex: "0 0 auto",
  },
  emptyState: { maxWidth: 560, padding: "56px 32px" },
  emptyTitle: { margin: "0 0 8px", fontSize: 20, fontWeight: 600, letterSpacing: -0.3 },
  emptyBody: { margin: "0 0 10px", color: ui.mutedForeground, lineHeight: 1.55 },
  sourceWrap: { padding: "12px 16px 0" },
  sourceHead: {
    display: "flex",
    alignItems: "baseline",
    gap: 8,
    flexWrap: "wrap",
    paddingBottom: 8,
    borderBottom: `1px solid ${ui.border}`,
    marginBottom: 10,
  },
  sourceName: { fontSize: 15, fontWeight: 600 },
  sourceKind: {
    fontSize: 11,
    color: ui.mutedForeground,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  sourcePath: { marginLeft: "auto", fontFamily: ui.fontMono, fontSize: 11.5, color: ui.mutedForeground },
  code: {
    fontFamily: ui.fontMono,
    fontSize: 12.5,
    lineHeight: "20px",
    background: ui.background,
    border: `1px solid ${ui.border}`,
    borderRadius: 4,
    overflowX: "auto",
  },
  codeLine: { display: "flex", gap: 0, paddingRight: 10 },
  codeLineCalling: {
    display: "flex",
    gap: 0,
    paddingRight: 10,
    background: ui.primary,
    boxShadow: `inset 2px 0 0 ${ui.ring}`,
  },
  gutter: {
    flex: "0 0 46px",
    textAlign: "right",
    paddingRight: 10,
    color: ui.mutedForeground,
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
    color: ui.mutedForeground,
  },
  alignedList: { listStyle: "none", margin: 0, padding: 0 },
  alignedRow: { display: "flex", alignItems: "baseline", gap: 8, padding: "2px 0" },
  alignedLine: {
    flex: "0 0 56px",
    textAlign: "right",
    fontFamily: ui.fontMono,
    fontSize: 11,
    color: ui.mutedForeground,
  },
  alignedLink: {
    color: ui.primary,
    textDecoration: "none",
    fontWeight: 500,
    fontFamily: ui.fontMono,
    fontSize: 12.5,
  },
  alignedWhere: { color: ui.mutedForeground, fontSize: 11, fontFamily: ui.fontMono },
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
  callName: { fontSize: 12.5, fontWeight: 500, fontFamily: ui.fontMono },
  callWhere: { fontSize: 10.5, color: ui.mutedForeground, fontFamily: ui.fontMono },
  callKind: {
    fontSize: 10,
    color: ui.primary,
    fontFamily: ui.fontMono,
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  trail: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "7px 14px",
    borderTop: `1px solid ${ui.border}`,
    background: ui.muted,
    flexWrap: "wrap",
  },
  trailLabel: {
    fontSize: 10.5,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    color: ui.mutedForeground,
    fontWeight: 600,
  },
  trailCode: { fontFamily: ui.fontMono, fontSize: 11.5, color: ui.mutedForeground },
  trailButton: {
    marginLeft: "auto",
    padding: "4px 10px",
    borderRadius: 4,
    border: `1px solid ${ui.border}`,
    background: ui.background,
    color: ui.foreground,
    cursor: "pointer",
    fontFamily: "inherit",
    fontSize: 12,
  },
  dim: { color: ui.mutedForeground, fontSize: 12, margin: "6px 0" },
  error: { color: ui.primary, fontSize: 12, margin: "6px 0" },
  // -- View header --------------------------------------------------------
  // The rail carries the navigation; this names whichever view is open, so the
  // page still says what it is when the rail is collapsed.
  viewHeader: { padding: "10px 14px 8px", borderBottom: `1px solid ${ui.border}` },
  viewTitle: { margin: 0, fontSize: 15, fontWeight: 600, letterSpacing: -0.2 },
  viewNote: { margin: "2px 0 0", fontSize: 12, color: ui.mutedForeground, lineHeight: 1.45 },

  // -- Map ----------------------------------------------------------------
  map: {
    display: "flex",
    gap: 16,
    padding: 16,
    alignItems: "flex-start",
    overflow: "auto",
    flex: "1 1 auto",
    minHeight: 0,
  },
  mapColumn: { flex: "1 1 0", minWidth: 0, display: "flex", flexDirection: "column", gap: 4 },
  mapNode: {
    textAlign: "left",
    padding: "6px 9px",
    borderRadius: 6,
    border: `1px solid ${ui.border}`,
    background: ui.card,
    color: "inherit",
    fontFamily: ui.fontMono,
    fontSize: 12,
    cursor: "pointer",
  },
  mapSeed: {
    padding: "8px 10px",
    borderRadius: 6,
    border: `1px solid ${ui.ring}`,
    background: ui.accent,
    fontWeight: 600,
    fontFamily: ui.fontMono,
    fontSize: 12.5,
  },
  mapEmpty: { padding: 24, flex: "1 1 auto" },
};