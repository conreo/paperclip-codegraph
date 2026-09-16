/**
 * Laying out the architecture map.
 *
 * The Map view answers a different question from the reader: not "where does this
 * happen" but "how is this codebase shaped". CodeGraph's own map states the rule
 * plainly — *each module sits one layer above everything it depends on, so entry
 * points end up at the top and the foundations at the bottom* — which makes the
 * vertical axis meaningful: reading top to bottom follows the dependency
 * direction.
 *
 * Two things make that rule harder than a topological sort:
 *
 * 1. **Cycles exist.** Six of them on a real repository. A cycle has no valid
 *    layer order, so back edges are excluded from the layering and drawn dashed
 *    instead of pretending the graph is a DAG.
 * 2. **Confidence.** The index carries name-only links that may be coincidences.
 *    CodeGraph excludes those below a threshold and says how many it excluded,
 *    rather than drawing a dependency that may not exist.
 *
 * Pure: no DOM, no clock, no randomness.
 */

export interface MapModuleInput {
  id: string;
  label: string;
  files: number;
  symbols: number;
  /** Every file in it is a test. */
  test: boolean;
  /** Every file in it is tool-generated. */
  generated: boolean;
}

export interface MapLinkInput {
  source: string;
  target: string;
  /** How many references cross this link. */
  count: number;
  /** References backed by an import or a declared type, rather than a name match. */
  declared: number;
}

export interface MapLayoutOptions {
  /** Links below this count are noise until a module they touch is selected. */
  weakLinkThreshold: number;
  /** Whether weak links are currently drawn. */
  includeWeak: boolean;
}

export interface PositionedModule extends MapModuleInput {
  x: number;
  y: number;
  width: number;
  height: number;
  /** 0 at the top (entry points); higher numbers are further down. */
  layer: number;
  /** Modules that depend on this one, for the weight bar. */
  dependents: number;
  /** True when nothing in the index arrives here. */
  unreferenced: boolean;
  /** Relative weight for the dependency bar, 0..1 against the most depended-on. */
  weight: number;
}

export interface PositionedLink extends MapLinkInput {
  /** True when this edge closes a cycle and is therefore not part of the layering. */
  back: boolean;
  weak: boolean;
  path: string;
}

export interface MapLayout {
  modules: PositionedModule[];
  links: PositionedLink[];
  width: number;
  height: number;
  layers: number;
  /** Modular dependency cycles, largest first. */
  cycles: string[][];
  /** Links hidden because they are weak and nothing they touch is selected. */
  hiddenWeakLinks: number;
}

export const MODULE_WIDTH = 168;
export const MODULE_HEIGHT = 54;
const H_GAP = 26;
const V_GAP = 74;
const PADDING = 32;

/**
 * Assign each module a layer, one above everything it depends on.
 *
 * Longest-path layering over the acyclic part: a module's layer is one more than
 * the deepest thing it depends on, so a dependency always points downward. Edges
 * that would point upward are back edges — they belong to a cycle — and are
 * excluded here and marked for dashed drawing instead.
 */
export function assignLayers(
  modules: readonly MapModuleInput[],
  links: readonly MapLinkInput[],
): { layer: Map<string, number>; backEdges: Set<string> } {
  const ids = new Set(modules.map((module) => module.id));
  const outgoing = new Map<string, string[]>();
  for (const module of modules) outgoing.set(module.id, []);

  const edgeKey = (link: MapLinkInput) => `${link.source}\u0000${link.target}`;

  // Adjacency is source → target, i.e. "depends on".
  for (const link of links) {
    if (!ids.has(link.source) || !ids.has(link.target)) continue;
    if (link.source === link.target) continue;
    outgoing.get(link.source)!.push(link.target);
  }

  // DFS colouring: grey marks the stack, so an edge into grey is a back edge.
  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;
  const colour = new Map<string, number>();
  for (const module of modules) colour.set(module.id, WHITE);
  const backEdges = new Set<string>();
  const order: string[] = [];

  const visit = (id: string): void => {
    colour.set(id, GREY);
    for (const target of outgoing.get(id) ?? []) {
      const state = colour.get(target);
      if (state === GREY) {
        backEdges.add(`${id}\u0000${target}`);
        continue;
      }
      if (state === WHITE) visit(target);
    }
    colour.set(id, BLACK);
    order.push(id);
  };

  // Sorted for determinism: the same index must produce the same picture.
  for (const id of [...ids].sort()) {
    if (colour.get(id) === WHITE) visit(id);
  }

  // Longest path over the acyclic edges, in reverse finish order.
  const layer = new Map<string, number>();
  for (const id of order) layer.set(id, 0);

  for (const id of order) {
    for (const target of outgoing.get(id) ?? []) {
      if (backEdges.has(`${id}\u0000${target}`)) continue;
      const candidate = (layer.get(target) ?? 0) + 1;
      if (candidate > (layer.get(id) ?? 0)) layer.set(id, candidate);
    }
  }

  void edgeKey;
  return { layer, backEdges };
}

/**
 * Find groups of modules that depend on each other in a cycle.
 *
 * Tarjan's strongly-connected components: any component with more than one member
 * is a cycle, and a module that depends on itself is one too. Reported because a
 * cycle is the thing a reader most wants to know about and least expects — the
 * layering cannot express it, so it has to be said in words.
 */
export function findCycles(
  modules: readonly MapModuleInput[],
  links: readonly MapLinkInput[],
): string[][] {
  const ids = new Set(modules.map((module) => module.id));
  const outgoing = new Map<string, string[]>();
  for (const module of modules) outgoing.set(module.id, []);
  for (const link of links) {
    if (!ids.has(link.source) || !ids.has(link.target)) continue;
    outgoing.get(link.source)!.push(link.target);
  }

  let index = 0;
  const indices = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];

  const strongConnect = (id: string): void => {
    indices.set(id, index);
    low.set(id, index);
    index += 1;
    stack.push(id);
    onStack.add(id);

    for (const target of outgoing.get(id) ?? []) {
      if (!indices.has(target)) {
        strongConnect(target);
        low.set(id, Math.min(low.get(id)!, low.get(target)!));
      } else if (onStack.has(target)) {
        low.set(id, Math.min(low.get(id)!, indices.get(target)!));
      }
    }

    if (low.get(id) === indices.get(id)) {
      const component: string[] = [];
      let member: string | undefined;
      do {
        member = stack.pop();
        if (member === undefined) break;
        onStack.delete(member);
        component.push(member);
      } while (member !== id);

      const selfLoop = component.length === 1 && (outgoing.get(id) ?? []).includes(id);
      if (component.length > 1 || selfLoop) components.push(component);
    }
  };

  for (const id of [...ids].sort()) {
    if (!indices.has(id)) strongConnect(id);
  }

  return components.sort((a, b) => b.length - a.length || a[0]!.localeCompare(b[0]!));
}

export function layoutMap(
  modules: readonly MapModuleInput[],
  links: readonly MapLinkInput[],
  options: MapLayoutOptions,
): MapLayout {
  const { layer, backEdges } = assignLayers(modules, links);
  const cycles = findCycles(modules, links);

  const inCycle = new Set(cycles.filter((cycle) => cycle.length > 1).flat());

  // Dependents per module, for the bar and the "nothing depends on this" note.
  const dependents = new Map<string, number>();
  for (const module of modules) dependents.set(module.id, 0);
  for (const link of links) {
    if (link.source === link.target) continue;
    if (dependents.has(link.target)) {
      dependents.set(link.target, (dependents.get(link.target) ?? 0) + 1);
    }
  }
  const mostDependedOn = Math.max(1, ...[...dependents.values()]);

  // Group by layer, and order within a layer by how much leans on it, so the
  // heaviest box is leftmost and the eye lands on it first.
  const byLayer = new Map<number, MapModuleInput[]>();
  for (const module of modules) {
    const value = layer.get(module.id) ?? 0;
    const list = byLayer.get(value);
    if (list) list.push(module);
    else byLayer.set(value, [module]);
  }

  const positioned: PositionedModule[] = [];
  const layerValues = [...byLayer.keys()].sort((a, b) => a - b);
  let widest = 0;

  for (const value of layerValues) {
    const row = byLayer.get(value)!.slice().sort((a, b) => {
      const byWeight = (dependents.get(b.id) ?? 0) - (dependents.get(a.id) ?? 0);
      return byWeight !== 0 ? byWeight : a.id.localeCompare(b.id);
    });

    let x = PADDING;
    // A layer's vertical slot is fixed by its depth, so rows do not shift as
    // other rows change width.
    const y = PADDING + value * (MODULE_HEIGHT + V_GAP);
    for (const module of row) {
      const count = dependents.get(module.id) ?? 0;
      positioned.push({
        ...module,
        x,
        y,
        width: MODULE_WIDTH,
        height: MODULE_HEIGHT,
        layer: value,
        dependents: count,
        unreferenced: count === 0,
        weight: count / mostDependedOn,
      });
      x += MODULE_WIDTH + H_GAP;
    }
    widest = Math.max(widest, x);
  }

  const positions = new Map(positioned.map((module) => [module.id, module]));

  const linksOut: PositionedLink[] = [];
  let hiddenWeakLinks = 0;
  for (const link of links) {
    const source = positions.get(link.source);
    const target = positions.get(link.target);
    if (!source || !target) continue;

    const back = backEdges.has(`${link.source}\u0000${link.target}`);
    const weak = link.count < options.weakLinkThreshold;
    if (weak && !options.includeWeak && !inCycle.has(link.source) && !inCycle.has(link.target)) {
      hiddenWeakLinks += 1;
      continue;
    }

    linksOut.push({
      ...link,
      back,
      weak,
      path: curveBetween(source, target),
    });
  }

  const tallest = positioned.reduce((max, module) => Math.max(max, module.y + module.height), 0);

  return {
    modules: positioned,
    links: linksOut,
    width: Math.max(widest, 320),
    height: Math.max(tallest + PADDING, MODULE_HEIGHT + PADDING * 2),
    layers: layerValues.length,
    cycles,
    hiddenWeakLinks,
  };
}

/**
 * A curve between two module boxes.
 *
 * Straight lines between stacked rows read as a single bundle once there are more
 * than a handful; a shallow vertical bias keeps each line's direction legible
 * where they cross.
 */
function curveBetween(
  source: { x: number; y: number; width: number; height: number },
  target: { x: number; y: number; width: number; height: number },
): string {
  const goingDown = target.y >= source.y;
  const fromX = source.x + source.width / 2;
  const toX = target.x + target.width / 2;
  const fromY = source.y + (goingDown ? source.height : 0);
  const toY = target.y + (goingDown ? 0 : target.height);
  const bend = Math.max(16, Math.abs(toY - fromY) * 0.4);
  const c1 = fromY + (goingDown ? bend : -bend);
  const c2 = toY - (goingDown ? bend : -bend);
  return `M ${fromX} ${fromY} C ${fromX} ${c1}, ${toX} ${c2}, ${toX} ${toY}`;
}

/**
 * How deep to cut module boundaries.
 *
 * Too shallow and everything collapses into `frontend/src`; too deep and the map
 * is a hundred boxes nobody can read. CodeGraph picks a depth automatically and
 * says so ("automatic — 3 folders deep"), which is the behaviour worth copying:
 * pick the deepest cut that still produces a readable number of modules.
 *
 * A cut is only meaningful if it separates something, so a depth whose segments
 * are unique per file (every file its own module) is rejected as too deep.
 */
export function chooseModuleDepth(
  filePaths: readonly string[],
  options: { maxModules: number; maxDepth: number },
): number {
  if (filePaths.length === 0) return 1;

  let best = 1;
  for (let depth = 1; depth <= options.maxDepth; depth += 1) {
    const buckets = new Set<string>();
    for (const filePath of filePaths) {
      buckets.add(moduleOf(filePath, depth));
    }
    // Every file alone means the cut went past the structure.
    if (buckets.size >= filePaths.length) break;
    best = depth;
    if (buckets.size > options.maxModules) {
      // One step coarser is the readable one.
      best = Math.max(1, depth - 1);
      break;
    }
  }
  return best;
}

/**
 * The module a file belongs to, as a path prefix.
 *
 * A file with no directory of its own belongs to the root itself, which is a real
 * module — CodeGraph labels it `(root files)` — rather than being dropped.
 */
export function moduleOf(filePath: string, depth: number): string {
  const segments = filePath.split("/").filter(Boolean);
  if (segments.length <= 1) return "(root files)";
  const kept = segments.slice(0, Math.max(1, depth));
  // A file directly in a kept directory has no further segment to name it.
  return kept.length >= segments.length ? segments.slice(0, -1).join("/") || "(root files)" : kept.join("/");
}

/** Whether a path looks like a test file, for the tests toggle. */
export function isTestFile(filePath: string): boolean {
  return /(^|\/)(__tests__|tests?|e2e)(\/|$)|[.\-_](test|spec)\.[cm]?[jt]sx?$/.test(filePath);
}

/** Whether a path looks tool-generated rather than written. */
export function isGeneratedFile(filePath: string): boolean {
  return /(^|\/)(dist|build|generated|gen|__generated__)(\/|$)|[.\-](generated|gen)\./.test(filePath);
}

// ---------------------------------------------------------------------------
// Reading a map out of the index
// ---------------------------------------------------------------------------

/** A file row, as the index reports it. */
export interface IndexedFile {
  filePath: string;
  fileKind: string | null;
  nodes: number;
}

/** An edge between two files, with the file paths resolved. */
export interface IndexedEdge {
  sourceFile: string | null;
  targetFile: string | null;
  kind: string;
}

export interface RepoMap {
  modules: MapModuleInput[];
  links: MapLinkInput[];
  /** The depth that was chosen, so the UI can say "3 folders deep". */
  depth: number;
  /** Whether the depth was picked automatically or requested. */
  depthIsAutomatic: boolean;
  /** Subtree choices, largest first, for the "Showing" selector. */
  roots: Array<{ root: string; label: string; files: number }>;
  /** Links carrying fewer references than the threshold. */
  weakLinkCount: number;
  /** Edges whose endpoints could not be resolved to files, for the honesty note. */
  unresolvedEdges: number;
}

const TEST_THRESHOLD = 0.5;
const GENERATED_THRESHOLD = 1;

/**
 * Turn the index into an architecture map.
 *
 * Modules are directory prefixes, links are the references that cross between
 * them. The depth is chosen so the picture stays readable, and the choices are
 * reported so the UI can state what it did rather than presenting a layout as if
 * it were the only truth.
 */
export function buildRepoMap(
  files: readonly IndexedFile[],
  edges: readonly IndexedEdge[],
  options: { root?: string | null; depth?: number | null; maxModules: number; maxDepth: number } = {
    maxModules: 60,
    maxDepth: 4,
  },
): RepoMap {
  const root = options.root ?? "";
  const scoped = root.length === 0 ? files : files.filter((file) => file.filePath.startsWith(`${root}/`));

  const depth = options.depth ?? chooseModuleDepth(scoped.map((file) => file.filePath), options);
  const depthIsAutomatic = options.depth === null || options.depth === undefined;

  const scopeOf = (filePath: string): string => {
    const trimmed = root.length > 0 && filePath.startsWith(`${root}/`) ? filePath.slice(root.length + 1) : filePath;
    return moduleOf(trimmed, depth);
  };

  // Aggregate files, symbols and flags per module.
  const byModule = new Map<string, { files: number; symbols: number; testFiles: number; generatedFiles: number }>();
  const moduleOfFile = new Map<string, string>();
  for (const file of scoped) {
    const id = scopeOf(file.filePath);
    moduleOfFile.set(file.filePath, id);
    const entry = byModule.get(id) ?? { files: 0, symbols: 0, testFiles: 0, generatedFiles: 0 };
    entry.files += 1;
    entry.symbols += file.nodes;
    if (isTestFile(file.filePath)) entry.testFiles += 1;
    if (isGeneratedFile(file.filePath)) entry.generatedFiles += 1;
    byModule.set(id, entry);
  }

  const modules: MapModuleInput[] = [...byModule.entries()]
    .map(([id, entry]) => ({
      id,
      label: id,
      files: entry.files,
      symbols: entry.symbols,
      // "More than half its files are tests" / "every file is tool-generated",
      // which is how CodeGraph defines the two badges.
      test: entry.files > 0 && entry.testFiles / entry.files > TEST_THRESHOLD,
      generated: entry.files > 0 && entry.generatedFiles / entry.files >= GENERATED_THRESHOLD,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  // Cross-module links, counted per direction, with declared-ness tracked so the
  // UI can say whether the layering had anything to trust.
  const linkKey = (source: string, target: string) => `${source}\u0000${target}`;
  const counts = new Map<string, { source: string; target: string; count: number; declared: number }>();
  let unresolvedEdges = 0;

  for (const edge of edges) {
    if (!edge.sourceFile || !edge.targetFile) {
      unresolvedEdges += 1;
      continue;
    }
    const source = moduleOfFile.get(edge.sourceFile);
    const target = moduleOfFile.get(edge.targetFile);
    if (!source || !target || source === target) continue;

    const key = linkKey(source, target);
    const entry = counts.get(key) ?? { source, target, count: 0, declared: 0 };
    entry.count += 1;
    // An import or a type reference is a stronger statement than a shared name.
    if (edge.kind === "imports" || edge.kind === "references" || edge.kind === "extends") {
      entry.declared += 1;
    }
    counts.set(key, entry);
  }

  const links: MapLinkInput[] = [...counts.values()];

  // Subtree choices: the top-level directories with their file counts, so the
  // "Showing" selector offers real numbers instead of a guess.
  const rootCounts = new Map<string, number>();
  for (const file of files) {
    const segments = file.filePath.split("/").filter(Boolean);
    if (segments.length <= 1) continue;
    const top = segments[0]!;
    rootCounts.set(top, (rootCounts.get(top) ?? 0) + 1);
  }
  const roots = [
    { root: "", label: "whole repository", files: files.length },
    ...[...rootCounts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([top, count]) => ({ root: top, label: top, files: count })),
  ];

  return {
    modules,
    links,
    depth,
    depthIsAutomatic,
    roots,
    weakLinkCount: links.filter((link) => link.count < 4).length,
    unresolvedEdges,
  };
}

// ---------------------------------------------------------------------------
// Reading the index
// ---------------------------------------------------------------------------

/** The three relations the map needs, as plain rows. */
export interface MapSourceRows {
  files: IndexedFile[];
  edges: IndexedEdge[];
}

/**
 * Every file, its symbol count, and every edge with its endpoints' file paths.
 *
 * Three queries rather than one join, because the map needs *all* edges to count
 * references across modules, and a join of nodes to edges would return the same
 * node row many times. The edge query is the big one — 13,374 rows on a real
 * repository — and bounds its own result so a pathological index cannot pull an
 * unbounded amount through the bridge.
 *
 * `nodes.kind = 'file'` is how a file node is identified; symbol counts come from
 * the non-file nodes that live in it. The `contains` edges would give the same
 * answer and cost a join, so they are not used.
 */
export const MAP_FILE_QUERY = `
  SELECT file_path, COUNT(*) AS nodes
    FROM nodes
   WHERE kind <> 'file' AND file_path IS NOT NULL AND file_path <> ''
   GROUP BY file_path`;

export const MAP_EDGE_QUERY = `
  SELECT sn.file_path AS source_file,
         tn.file_path AS target_file,
         e.kind AS kind
    FROM edges e
    LEFT JOIN nodes sn ON sn.id = e.source
    LEFT JOIN nodes tn ON tn.id = e.target
   WHERE sn.file_path <> tn.file_path
   LIMIT ?`;

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

export interface RouteEntry {
  id: string;
  /** `GET`, `POST`, … when the index records one. */
  method: string | null;
  path: string;
  filePath: string;
  line: number | null;
  /** The symbol the route calls, when the graph records one. */
  handler: string | null;
  handlerFile: string | null;
  handlerLine: number | null;
  handlerId: string | null;
}

/**
 * Split a route node's name into its method and path.
 *
 * The index names a route `GET /api/health`; anything without a method prefix is
 * kept whole rather than guessed at, because a route registered dynamically may
 * genuinely have no verb the graph could see.
 */
export function parseRoute(name: string): { method: string | null; path: string } {
  const match = /^([A-Z]{2,7})\s+(.+)$/.exec(name.trim());
  if (!match) return { method: null, path: name.trim() };
  return { method: match[1]!, path: match[2]!.trim() };
}

/** The route entries, ordered by path for scanning, with their handlers attached. */
export function groupRoutes(routes: readonly RouteEntry[]): {
  entries: RouteEntry[];
  byPath: Map<string, RouteEntry>;
  withHandler: number;
  withoutHandler: number;
} {
  const entries = [...routes].sort((a, b) => a.path.localeCompare(b.path) || (a.method ?? "").localeCompare(b.method ?? ""));
  return {
    entries,
    byPath: new Map(entries.map((entry) => [`${entry.method ?? ""} ${entry.path}`, entry])),
    withHandler: entries.filter((entry) => entry.handler !== null).length,
    withoutHandler: entries.filter((entry) => entry.handler === null).length,
  };
}

// ---------------------------------------------------------------------------
// Potentially unreferenced symbols
// ---------------------------------------------------------------------------

export interface DeadCandidate {
  id: string;
  name: string;
  qualifiedName: string;
  kind: string;
  filePath: string;
  startLine: number | null;
  endLine: number | null;
}

export interface DeadCodeReport {
  candidates: DeadCandidate[];
  /** Symbols excluded, and why, so the number is never presented bare. */
  excluded: Array<{ reason: string; count: number }>;
  totalCandidates: number;
}

/**
 * Symbols that no edge reaches.
 *
 * ## This view is weaker than the others, and says so
 *
 * "Nothing references this" is a **hint**, not a finding — CodeGraph's own dead
 * code analysis excludes exported symbols, files nothing reaches, and names
 * mentioned more than once, and on a real repository those exclusions are the
 * majority of the candidates (215 exported, 209 unreachable-file, 63 mentioned).
 * This plugin has no export analysis: the index records that a symbol is
 * *declared*, not whether it is exported, so it cannot reproduce those rules.
 *
 * What it can do honestly is apply the two rules it *can* check and report both
 * the survivors and the count it could not judge:
 *
 *   - a symbol with no inbound edge of any kind is a candidate;
 *   - a symbol whose file nothing reaches is reported separately, because "this
 *     whole file is unreachable" and "this symbol is unused" are different facts;
 *   - entry points are never candidates — a route handler has no inbound call
 *     edge by design, and reporting it as dead would be wrong every time.
 */
/**
 * Edge kinds that mean "something refers to this".
 *
 * **`contains` is deliberately excluded.** It is not a reference: it is the
 * file→symbol parent relation, and there is one for every symbol in the index. When
 * it counted, every symbol appeared referenced and this view could only ever return
 * nothing — which is exactly what happened on a real repository before this list
 * existed, and is why it does now.
 */
export const REFERENCE_EDGE_KINDS = ["calls", "imports", "references", "instantiates"] as const;

export function findUnreferenced(
  symbols: readonly DeadCandidate[],
  options: {
    /** Ids that at least one reference edge arrives at. */
    referenced: ReadonlySet<string>;
    /** Ids of entry points, which are unreferenced by design. */
    entryPoints: ReadonlySet<string>;
    /** Files that have no inbound edge at all. */
    unreachableFiles: ReadonlySet<string>;
    limit: number;
  },
): DeadCodeReport {
  const candidates: DeadCandidate[] = [];
  let entryPointSkips = 0;
  let unreachableFileSkips = 0;
  let referencedSkips = 0;

  for (const symbol of symbols) {
    if (options.entryPoints.has(symbol.id)) {
      entryPointSkips += 1;
      continue;
    }
    if (options.referenced.has(symbol.id)) {
      referencedSkips += 1;
      continue;
    }
    if (options.unreachableFiles.has(symbol.filePath)) {
      unreachableFileSkips += 1;
      continue;
    }
    candidates.push(symbol);
  }

  candidates.sort(
    (a, b) => a.filePath.localeCompare(b.filePath) || (a.startLine ?? 0) - (b.startLine ?? 0),
  );

  return {
    candidates: candidates.slice(0, options.limit),
    excluded: [
      { reason: "referenced", count: referencedSkips },
      { reason: "entry point", count: entryPointSkips },
      { reason: "in a file nothing reaches", count: unreachableFileSkips },
    ],
    totalCandidates: candidates.length,
  };
}
