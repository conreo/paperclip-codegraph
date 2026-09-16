/**
 * The Map view: how this codebase is shaped.
 *
 * CodeGraph's own map states the rule this reproduces — *each module sits one
 * layer above everything it depends on, so entry points end up at the top and the
 * foundations at the bottom*. That makes the vertical axis mean something:
 * reading top to bottom follows the dependency direction, which is the whole
 * reason a map is more useful than a list of folders.
 *
 * Faithful to the original where it matters, and honest where it cannot be:
 *
 *   - modules carry their file and symbol counts, and the bar along the bottom is
 *     how much leans on them, scaled against the most depended-on box;
 *   - link thickness is the number of references crossing it;
 *   - **cycles are reported in words**, because a layered drawing cannot express
 *     one — the back edge that closes a cycle is drawn dashed instead of being
 *     hidden, so the picture does not claim a clean hierarchy it does not have;
 *   - weak links are held back until a module they touch is selected, and the
 *     count of what was held back is stated rather than left to be noticed.
 *
 * Grouping depth is a real control because the right cut depends on the
 * repository: too coarse and everything is one box, too fine and it is a wall.
 */

import { useMemo, useState, type CSSProperties } from "react";
import { usePluginData } from "@paperclipai/plugin-sdk/ui";

import {
  MODULE_HEIGHT,
  layoutMap,
  type MapLayout,
  type MapLinkInput,
  type MapModuleInput,
  type PositionedModule,
} from "../graph/architecture.js";
import { DATA_KEYS } from "../plugin-keys.js";
import { sanitizeErrorMessage } from "../errors.js";
import { ui } from "./chrome.js";

/** What `graph-map` returns. */
interface MapResponse {
  modules?: MapModuleInput[];
  links?: MapLinkInput[];
  depth?: number;
  depthIsAutomatic?: boolean;
  roots?: Array<{ root: string; label: string; files: number }>;
  weakLinkCount?: number;
  unresolvedEdges?: number;
  error?: string;
  reason?: string;
}

/** Below this many references a link is noise until something it touches is selected. */
const WEAK_LINK_THRESHOLD = 4;

export function MapView({
  companyId,
  projectId,
  organization,
}: {
  companyId: string;
  projectId: string | null;
  organization: string | null;
}) {
  const [root, setRoot] = useState("");
  const [depth, setDepth] = useState<number | null>(null);
  const [includeTests, setIncludeTests] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);

  const { data, loading, error } = usePluginData<MapResponse>(DATA_KEYS.graphMap, {
    companyId,
    projectId,
    root,
    // `null` asks the worker to choose; a number pins it.
    depth,
  });

  const map = data;

  const visible = useMemo(() => {
    const modules = (map?.modules ?? []).filter((module) => includeTests || !module.test);
    const ids = new Set(modules.map((module) => module.id));
    const links = (map?.links ?? []).filter(
      (link) => ids.has(link.source) && ids.has(link.target),
    );
    return { modules, links };
  }, [map?.modules, map?.links, includeTests]);

  const layout: MapLayout = useMemo(
    () =>
      layoutMap(visible.modules, visible.links, {
        weakLinkThreshold: WEAK_LINK_THRESHOLD,
        // Selecting a module brings its own weak links out, which is what makes
        // the threshold a filter rather than a permanent loss.
        includeWeak: selected !== null,
      }),
    [visible.modules, visible.links, selected],
  );

  // Everything more than one hop from the selection fades, as in the original.
  const neighbourhood = useMemo(() => {
    if (!selected) return null;
    const near = new Set<string>([selected]);
    for (const link of layout.links) {
      if (link.source === selected) near.add(link.target);
      if (link.target === selected) near.add(link.source);
    }
    return near;
  }, [layout.links, selected]);

  const hiddenWeak = layout.hiddenWeakLinks;
  const cyclesOfThreeOrMore = layout.cycles.filter((cycle) => cycle.length >= 3);

  return (
    <div style={styles.map}>
      <div style={styles.stage}>
        {loading && !map ? (
          <p style={styles.dim}>Deriving the map…</p>
        ) : error ? (
          <p style={styles.error}>{sanitizeErrorMessage(error)}</p>
        ) : map?.error ? (
          <p style={styles.error}>
            {sanitizeErrorMessage(map.error)}
            {map.reason ? ` (${map.reason})` : ""}
          </p>
        ) : layout.modules.length === 0 ? (
          <p style={styles.dim}>No modules to draw for this selection.</p>
        ) : (
          <div style={styles.canvasWrap}>
            <div style={styles.legend}>
              <strong style={styles.legendTitle}>Key</strong>
              <LegendRow swatch="box" label="A module — one directory, with its files and symbols" />
              <LegendRow
                swatch="bar"
                label="The bar is how much leans on it, against the most depended-on module here"
              />
              <LegendRow swatch="line" label="Depends on — thicker means more references" />
              <LegendRow swatch="dashed" label="Points back up — the lighter half of a cycle" />
              <LegendRow swatch="badge" label="Tests, or tool-generated — nobody wrote it" />
            </div>

            <div style={styles.canvas}>
              <svg
                role="img"
                aria-label={`Architecture map of ${organization ?? "this repository"}: ${layout.modules.length} modules`}
                width={layout.width}
                height={layout.height}
                viewBox={`0 0 ${layout.width} ${layout.height}`}
                style={styles.svg}
              >
                {layout.links.map((link) => {
                  const faded =
                    neighbourhood !== null &&
                    !neighbourhood.has(link.source) &&
                    !neighbourhood.has(link.target);
                  const touching =
                    selected !== null && (link.source === selected || link.target === selected);
                  return (
                    <path
                      key={`${link.source}->${link.target}`}
                      d={link.path}
                      fill="none"
                      stroke={touching ? ui.primary : ui.mutedForeground}
                      strokeWidth={Math.min(6, 1 + Math.log2(link.count + 1))}
                      strokeDasharray={link.back ? "5 4" : undefined}
                      strokeOpacity={faded ? 0.08 : touching ? 0.9 : 0.35}
                    />
                  );
                })}

                {layout.modules.map((module) => (
                  <ModuleBox
                    key={module.id}
                    module={module}
                    selected={module.id === selected}
                    faded={neighbourhood !== null && !neighbourhood.has(module.id)}
                    onSelect={() => setSelected(module.id === selected ? null : module.id)}
                  />
                ))}
              </svg>
            </div>
          </div>
        )}
      </div>

      <aside style={styles.side}>
        <h2 style={styles.sideTitle}>Architecture map</h2>
        <p style={styles.sideBody}>
          Derived from the graph, not drawn by hand: each module sits one layer above the
          modules it depends on, so reading top to bottom follows the dependency direction.
          Line weight is how many references cross the link.
        </p>

        <label style={styles.field}>
          <span style={styles.fieldLabel}>Showing</span>
          <select
            value={root}
            onChange={(event) => {
              setRoot(event.target.value);
              setSelected(null);
            }}
            style={styles.select}
          >
            {(map?.roots ?? [{ root: "", label: "whole repository", files: 0 }]).map((choice) => (
              <option key={choice.root} value={choice.root}>
                {choice.label} · {choice.files} files
              </option>
            ))}
          </select>
        </label>

        <label style={styles.field}>
          <span style={styles.fieldLabel}>Grouping</span>
          <select
            value={depth === null ? "auto" : String(depth)}
            onChange={(event) => {
              setDepth(event.target.value === "auto" ? null : Number(event.target.value));
              setSelected(null);
            }}
            style={styles.select}
          >
            <option value="auto">
              automatic{map?.depthIsAutomatic && map.depth ? ` — ${map.depth} folders deep` : ""}
            </option>
            <option value="1">top-level folders</option>
            <option value="2">2 folders deep</option>
            <option value="3">3 folders deep</option>
            <option value="4">4 folders deep</option>
          </select>
        </label>

        <label style={styles.toggle}>
          <input
            type="checkbox"
            checked={includeTests}
            onChange={(event) => setIncludeTests(event.target.checked)}
          />
          Include test modules
        </label>

        {map ? (
          <div style={styles.notes}>
            <p style={styles.note}>
              {layout.modules.length} module{layout.modules.length === 1 ? "" : "s"},{" "}
              {layout.links.length} link{layout.links.length === 1 ? "" : "s"} drawn
              {map.depthIsAutomatic && map.depth ? `, grouped ${map.depth} folders deep` : ""}.
            </p>
            {hiddenWeak > 0 ? (
              <p style={styles.note}>
                {hiddenWeak} link{hiddenWeak === 1 ? "" : "s"} carrying fewer than{" "}
                {WEAK_LINK_THRESHOLD} references {hiddenWeak === 1 ? "is" : "are"} hidden until you
                select a module {hiddenWeak === 1 ? "it touches" : "they touch"}, so a weak
                coincidence never draws as a dependency.
              </p>
            ) : null}
            {map.unresolvedEdges ? (
              <p style={styles.note}>
                {map.unresolvedEdges} reference{map.unresolvedEdges === 1 ? "" : "s"} could not be
                placed in a module — the index records an endpoint with no file — so{" "}
                {map.unresolvedEdges === 1 ? "it is" : "they are"} excluded from every count here.
              </p>
            ) : null}
            {layout.cycles.length > 0 ? (
              <p style={styles.noteWarning}>
                {layout.cycles.length} dependency cycle
                {layout.cycles.length === 1 ? "" : "s"} between modules
                {cyclesOfThreeOrMore.length > 0
                  ? `, ${cyclesOfThreeOrMore.length} of three or more`
                  : ""}
                . A cycle has no layer order, so the edge that closes each one is drawn dashed
                and left out of the layering.
              </p>
            ) : null}
            {layout.cycles.length > 0 ? (
              <ul style={styles.cycleList}>
                {layout.cycles.slice(0, 5).map((cycle) => (
                  <li key={cycle.join("|")} style={styles.cycleItem}>
                    {cycle.join(" → ")}
                  </li>
                ))}
              </ul>
            ) : null}
            {selected ? (
              <p style={styles.note}>
                Selected <strong>{selected}</strong> — everything more than one hop away has
                faded. Click it again to clear.
              </p>
            ) : (
              <p style={styles.note}>
                Click a module to bring out its links and fade the rest.
              </p>
            )}
          </div>
        ) : null}
      </aside>
    </div>
  );
}

/** One module: its label, its counts, and the bar showing how much leans on it. */
function ModuleBox({
  module,
  selected,
  faded,
  onSelect,
}: {
  module: PositionedModule;
  selected: boolean;
  faded: boolean;
  onSelect: () => void;
}) {
  const { x, y, width, height, weight } = module;
  const barWidth = Math.max(weight > 0 ? 3 : 0, weight * (width - 20));

  return (
    <g
      role="button"
      tabIndex={0}
      aria-label={`${module.label}, ${module.symbols} symbols, ${module.files} files`}
      opacity={faded ? 0.3 : 1}
      style={{ cursor: "pointer" }}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
    >
      <rect
        x={x}
        y={y}
        width={width}
        height={height}
        rx={6}
        fill={ui.card}
        stroke={selected ? ui.primary : ui.border}
        strokeWidth={selected ? 2 : 1}
      />
      <text x={x + 10} y={y + 18} fontSize={11.5} fontWeight={600} fill={ui.foreground}>
        {trim(module.label, width - 20)}
      </text>
      <text x={x + 10} y={y + 32} fontSize={10} fill={ui.mutedForeground}>
        {module.symbols} symbol{module.symbols === 1 ? "" : "s"} · {module.files} file
        {module.files === 1 ? "" : "s"}
      </text>
      <text x={x + 10} y={y + 45} fontSize={9.5} fill={ui.mutedForeground}>
        {module.unreferenced
          ? "nothing depends on this"
          : `${module.dependents} depend on it`}
        {module.test ? " · tests" : ""}
        {module.generated ? " · generated" : ""}
      </text>
      {barWidth > 0 ? (
        <rect x={x + 10} y={y + height - 5} width={barWidth} height={2.5} rx={1} fill={ui.primary} />
      ) : null}
    </g>
  );
}

function LegendRow({ swatch, label }: { swatch: "box" | "bar" | "line" | "dashed" | "badge"; label: string }) {
  return (
    <span style={styles.legendRow}>
      <svg width="22" height="12" aria-hidden style={{ flex: "0 0 auto" }}>
        {swatch === "box" ? (
          <rect x="2" y="2" width="18" height="8" rx="2" fill={ui.card} stroke={ui.border} />
        ) : swatch === "bar" ? (
          <rect x="2" y="5" width="16" height="2.5" rx="1" fill={ui.primary} />
        ) : swatch === "line" ? (
          <path d="M2 6 H20" stroke={ui.mutedForeground} strokeWidth="2" />
        ) : swatch === "dashed" ? (
          <path d="M2 6 H20" stroke={ui.mutedForeground} strokeWidth="2" strokeDasharray="4 3" />
        ) : (
          <rect x="4" y="2" width="14" height="8" rx="4" fill={ui.muted} stroke={ui.border} />
        )}
      </svg>
      <span>{label}</span>
    </span>
  );
}

/** Clip a label to the box rather than letting it overlap its neighbour. */
function trim(label: string, available: number): string {
  const capacity = Math.max(6, Math.floor(available / 6.2));
  return label.length <= capacity ? label : `…${label.slice(label.length - capacity + 1)}`;
}

const styles: Record<string, CSSProperties> = {
  map: {
    display: "flex",
    flex: "1 1 auto",
    minHeight: 0,
    alignItems: "stretch",
  },
  stage: {
    flex: "1 1 auto",
    minWidth: 0,
    overflow: "auto",
    padding: 12,
    background: ui.background,
  },
  canvasWrap: { display: "flex", flexDirection: "column", gap: 8 },
  legend: {
    display: "flex",
    flexWrap: "wrap",
    gap: "4px 16px",
    alignItems: "center",
    fontSize: 11,
    color: ui.mutedForeground,
    paddingBottom: 8,
    borderBottom: `1px solid ${ui.border}`,
  },
  legendTitle: { fontSize: 11, color: ui.foreground, marginRight: 4 },
  legendRow: { display: "inline-flex", alignItems: "center", gap: 5 },
  canvas: {
    border: `1px solid ${ui.border}`,
    borderRadius: 8,
    background: ui.background,
    overflow: "auto",
    maxHeight: "70vh",
  },
  svg: { display: "block" },
  side: {
    flex: "0 0 300px",
    minWidth: 0,
    borderLeft: `1px solid ${ui.border}`,
    padding: 14,
    overflowY: "auto",
    background: ui.card,
  },
  sideTitle: { margin: "0 0 6px", fontSize: 14, fontWeight: 600 },
  sideBody: { margin: "0 0 12px", fontSize: 12, color: ui.mutedForeground, lineHeight: 1.5 },
  field: { display: "block", marginBottom: 12 },
  fieldLabel: {
    display: "block",
    fontSize: 10.5,
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    color: ui.mutedForeground,
    marginBottom: 4,
  },
  select: {
    width: "100%",
    boxSizing: "border-box",
    padding: "6px 8px",
    borderRadius: 6,
    border: `1px solid ${ui.border}`,
    background: ui.background,
    color: "inherit",
    fontFamily: "inherit",
    fontSize: 12.5,
  },
  toggle: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    fontSize: 12.5,
    cursor: "pointer",
    marginBottom: 12,
  },
  notes: { display: "flex", flexDirection: "column", gap: 8, marginTop: 8 },
  note: { margin: 0, fontSize: 11.5, color: ui.mutedForeground, lineHeight: 1.5 },
  noteWarning: { margin: 0, fontSize: 11.5, color: ui.foreground, lineHeight: 1.5 },
  cycleList: { margin: 0, paddingLeft: 16, display: "flex", flexDirection: "column", gap: 3 },
  cycleItem: { fontSize: 10.5, fontFamily: ui.fontMono, color: ui.mutedForeground },
  dim: { color: ui.mutedForeground, fontSize: 12, margin: 8 },
  error: { color: ui.destructive, fontSize: 12, margin: 8 },
};
