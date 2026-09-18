/**
 * Shared chrome for the CodeGraph surfaces.
 *
 * Two things are deliberate here.
 *
 * **The tokens are the host's.** Every colour is a Paperclip custom property, so
 * light and dark both work without this plugin knowing which is active. A plugin
 * that repaints itself in another tool's palette reads as a foreign window inside
 * Paperclip and ignores the theme the operator chose.
 *
 * **The rhythm is the host's too**, taken from its own General settings page
 * (`ui/src/pages/InstanceGeneralSettings.tsx`) and its `ToggleSwitch`
 * (`ui/src/components/ui/toggle-switch.tsx`) rather than invented: a reading-width
 * column of sections, each a heading and a sentence with its control on the right
 * at `flex items-start justify-between gap-4`, and a capsule switch that writes
 * immediately. Those files are the reference; the numbers below are copied from
 * them, including the switch's use of the status green rather than `primary`,
 * which that component records as a deliberate ruling.
 *
 * Inline styles only. A plugin must not import the host's `ui/src` internals, so
 * nothing here reaches into its Tailwind or its components.
 */

import type { CSSProperties } from "react";

/**
 * The switch's geometry, named and derived rather than sprinkled as literals.
 *
 * From the host's `ToggleSwitch`: `h-5 w-11` track (20×44), `border-2`, and a
 * `h-4 w-6` thumb (16×24). The border counts toward the height, so the track's
 * inner box is 40×16 — exactly the thumb's height, which is what makes it sit
 * flush. The thumb's travel is what is left over horizontally.
 */
const TRACK_WIDTH = 44;
const TRACK_HEIGHT = 20;
const TRACK_BORDER = 2;
const THUMB_WIDTH = 24;
const THUMB_HEIGHT = 16;
/** 44 − 2×2 − 24 = 16. Written as arithmetic so a size change cannot desync it. */
const THUMB_TRAVEL = TRACK_WIDTH - TRACK_BORDER * 2 - THUMB_WIDTH;

/** The host's design tokens, with fallbacks so a renamed one is still legible. */
export const ui = {
  background: "var(--background, #ffffff)",
  foreground: "var(--foreground, #16150f)",
  card: "var(--card, #ffffff)",
  muted: "var(--muted, rgba(0,0,0,0.04))",
  mutedForeground: "var(--muted-foreground, rgba(0,0,0,0.55))",
  border: "var(--border, rgba(0,0,0,0.10))",
  input: "var(--input, rgba(0,0,0,0.12))",
  primary: "var(--primary, #16150f)",
  primaryForeground: "var(--primary-foreground, #ffffff)",
  accent: "var(--accent, rgba(0,0,0,0.05))",
  destructive: "var(--destructive, #dc2626)",
  success: "var(--success, #16a34a)",
  /** The host's status green, which its own switch uses for the on state. */
  statusDone: "var(--status-task-done, #16a34a)",
  fontSans: 'var(--font-sans, "InterVariable", Inter, ui-sans-serif, system-ui, sans-serif)',
  fontMono: 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
} as const;

/**
 * A line of status: a tick or a cross, then what it means.
 *
 * The `bad` sentence is required rather than optional, because a cross with no
 * explanation is the failure mode this whole page exists to avoid.
 */
export function StatusLine({ ok, good, bad }: { ok: boolean; good: string; bad: string }) {
  return (
    <li style={styles.statusRow}>
      <span aria-hidden style={ok ? styles.tick : styles.cross}>
        {ok ? "✓" : "✗"}
      </span>
      <span style={ok ? styles.statusGood : styles.statusBad}>{ok ? good : bad}</span>
    </li>
  );
}

/** The transform that moves the thumb to the on position. */
export const thumbTransform = (checked: boolean): string =>
  checked ? `translateX(${THUMB_TRAVEL}px)` : "translateX(0)";

export const styles: Record<string, CSSProperties> = {
  // -- Page ---------------------------------------------------------------
  /**
   * A reading column of spaced sections, as the host's settings pages are: no card
   * around each section, because space separates them rather than borders.
   */
  page: {
    maxWidth: 896,
    display: "flex",
    flexDirection: "column",
    gap: 32,
    fontFamily: "inherit",
    color: "inherit",
  },
  title: { display: "flex", flexDirection: "column", gap: 6 },
  h1: { fontSize: 18, fontWeight: 600, margin: 0, letterSpacing: -0.2 },
  h2: { fontSize: 14, fontWeight: 600, margin: 0 },
  lead: { fontSize: 14, color: ui.mutedForeground, margin: 0, lineHeight: 1.5 },
  body: { fontSize: 14, color: ui.mutedForeground, margin: 0, lineHeight: 1.5 },
  note: { fontSize: 13, color: ui.mutedForeground, margin: 0, lineHeight: 1.5 },
  muted: { fontSize: 14, color: ui.mutedForeground, margin: 0 },

  // -- Section ------------------------------------------------------------
  section: { display: "flex", flexDirection: "column", gap: 12 },
  /** Heading left, control right — the host's split row. */
  sectionSplit: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 16,
  },
  sectionStack: { display: "flex", flexDirection: "column" },
  sectionText: { display: "flex", flexDirection: "column", gap: 6, maxWidth: 672 },
  sectionBody: { display: "flex", flexDirection: "column", gap: 8 },

  // -- Rows ---------------------------------------------------------------
  /** One setting per row, with its switch or buttons on the right. */
  rows: { listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column" },
  row: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 16,
    padding: "10px 0",
    borderBottom: `1px solid ${ui.border}`,
  },
  rowText: { display: "flex", flexDirection: "column", gap: 2, minWidth: 0 },
  rowTitle: { fontSize: 14, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis" },
  rowAside: { color: ui.mutedForeground, fontWeight: 400 },
  rowMeta: { fontSize: 12.5, color: ui.mutedForeground, fontFamily: ui.fontMono },
  rowActions: { display: "flex", gap: 8, flex: "0 0 auto" },

  /**
   * The checkouts inside one project, listed under the project's own row.
   *
   * One switch governs a whole project, so a project holding six repositories
   * cannot be six switched rows: the switch would repeat six times and all six
   * would move together. The switch belongs to the project; the repositories it
   * contains are listed under it.
   */
  subRows: {
    listStyle: "none",
    padding: 0,
    margin: "3px 0 0",
    display: "flex",
    flexDirection: "column",
    gap: 3,
  },
  subRow: {
    display: "flex",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: 12,
    minWidth: 0,
  },
  subRowTitle: {
    fontSize: 13,
    color: ui.foreground,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },

  // -- Status list --------------------------------------------------------
  list: { listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 6 },
  statusRow: { display: "flex", gap: 8, alignItems: "flex-start", fontSize: 14, lineHeight: 1.5 },
  statusGood: {},
  statusBad: { color: ui.mutedForeground },
  tick: { color: ui.success, flex: "0 0 auto" },
  cross: { color: ui.destructive, flex: "0 0 auto" },

  // -- Controls -----------------------------------------------------------
  /**
   * The switch, transcribed from the host's `ToggleSwitch` markup:
   *
   *   track: `h-5 w-11 rounded-full border-2` — on: `border-(--status-task-done)
   *          bg-(--status-task-done)`; off: `border-transparent bg-input/90`
   *   thumb: `h-4 w-6 rounded-full bg-background shadow-sm`, `translate-x-4` when on
   *
   * Two details are easy to get wrong and were: the **thumb is wider than it is
   * tall** (`w-6 h-4`, not a square), and the track carries a **2px border that is
   * transparent when off** — so the border contributes to the 20px height and the
   * capsule's inner height is 16px, which is exactly the thumb. A square thumb
   * looks subtly wrong beside the host's rows, which is the whole point of matching.
   *
   * The status green rather than `primary` is copied deliberately: that component
   * records the choice as a ruling not to be swapped back.
   */
  switch: {
    position: "relative",
    display: "inline-flex",
    alignItems: "center",
    flex: "0 0 auto",
    boxSizing: "border-box",
    width: TRACK_WIDTH,
    height: TRACK_HEIGHT,
    padding: 0,
    borderRadius: 999,
    border: `${TRACK_BORDER}px solid transparent`,
    cursor: "pointer",
    transition: "background-color 150ms ease, border-color 150ms ease",
  },
  switchOn: { background: ui.statusDone, borderColor: ui.statusDone },
  /** `bg-input/90`: the host runs the input token at 90% opacity when off. */
  switchOff: {
    background: `color-mix(in srgb, ${ui.input} 90%, transparent)`,
    borderColor: "transparent",
  },
  switchDisabled: { opacity: 0.5, cursor: "not-allowed" },
  thumb: {
    display: "inline-block",
    boxSizing: "border-box",
    width: THUMB_WIDTH,
    height: THUMB_HEIGHT,
    borderRadius: 999,
    background: ui.background,
    boxShadow: "0 1px 2px rgba(0,0,0,0.05)",
    transition: "transform 150ms ease",
    pointerEvents: "none",
  },

  /** The host's own button: `h-9 rounded-md border`. */
  button: {
    height: 36,
    padding: "0 14px",
    borderRadius: 6,
    border: `1px solid ${ui.border}`,
    background: ui.background,
    color: "inherit",
    fontSize: 13,
    fontWeight: 500,
    cursor: "pointer",
    fontFamily: "inherit",
    whiteSpace: "nowrap",
  },
  buttonPrimary: { background: ui.primary, color: ui.primaryForeground, borderColor: "transparent" },
  buttonDisabled: { opacity: 0.5, cursor: "not-allowed" },

  field: { display: "flex", gap: 8, alignItems: "flex-start", maxWidth: 672 },
  input: {
    flex: "1 1 auto",
    width: "100%",
    boxSizing: "border-box",
    height: 36,
    padding: "0 12px",
    borderRadius: 6,
    border: `1px solid ${ui.input}`,
    background: "transparent",
    color: "inherit",
    fontSize: 13,
    fontFamily: "inherit",
  },
  textarea: {
    flex: "1 1 auto",
    boxSizing: "border-box",
    padding: "8px 12px",
    borderRadius: 6,
    border: `1px solid ${ui.input}`,
    background: "transparent",
    color: "inherit",
    fontSize: 13,
    fontFamily: ui.fontMono,
    resize: "vertical",
  },

  // -- Callouts -----------------------------------------------------------
  /** One banner for a failure, rather than a message beside each control. */
  errorBanner: {
    border: `1px solid ${ui.destructive}`,
    background: ui.muted,
    color: ui.destructive,
    borderRadius: 6,
    padding: "8px 12px",
    fontSize: 13,
    lineHeight: 1.5,
  },
  /** A callout for something the operator has to act on. */
  banner: {
    border: `1px solid ${ui.border}`,
    borderLeft: `3px solid ${ui.primary}`,
    borderRadius: 8,
    background: ui.muted,
    padding: "12px 14px",
    fontSize: 13,
  },
  bannerBody: {
    margin: "6px 0 0",
    color: ui.mutedForeground,
    fontSize: 12.5,
    lineHeight: 1.5,
  },

  // -- Nav column ---------------------------------------------------------
  // The nav entry is not a link any more, but it keeps the host's row rhythm so it
  // sits in the list rather than beside it: same `mx-2 rounded-lg px-2 py-1.5` inset
  // as every `SidebarNavItem`.
  sidebarWrap: { display: "flex", flexDirection: "column", gap: 0 },
  sidebarRow: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    margin: "0 8px",
    borderRadius: 8,
    padding: "6px 8px",
    color: ui.foreground,
    opacity: 0.8,
    fontSize: "var(--text-compact, 13px)",
    fontWeight: 500,
    lineHeight: 1.35,
  },
  sidebarGlyph: {
    display: "inline-flex",
    flex: "0 0 auto",
    width: 16,
    height: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  sidebarLabel: {
    flex: "1 1 auto",
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  sidebarDotOk: { flex: "0 0 auto", width: 6, height: 6, borderRadius: "50%", background: ui.statusDone },
  sidebarDotIdle: {
    flex: "0 0 auto",
    width: 6,
    height: 6,
    borderRadius: "50%",
    background: ui.mutedForeground,
  },
  /** The note sits under the row, aligned with the label's left edge. */
  sidebarNotes: { listStyle: "none", padding: "0 16px 0 34px", margin: "2px 0 0" },
};
