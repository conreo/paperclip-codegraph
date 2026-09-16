/**
 * Shared chrome for every CodeGraph surface.
 *
 * Inline styles only, and no import of the host's `ui/src` internals: a plugin
 * bundle that reached into the host's design system would be pinned to a
 * Paperclip version it cannot test against. Colours are read through the host's
 * CSS custom properties with a fallback, so the surfaces follow the operator's
 * theme — including dark mode — without knowing what the theme is.
 */

import type { CSSProperties } from "react";

export function StatusLine({ ok, good, bad }: { ok: boolean; good: string; bad: string }) {
  return (
    <li style={styles.statusRow}>
      <span aria-hidden style={ok ? styles.tick : styles.cross}>
        {ok ? "✓" : "✗"}
      </span>
      <span style={ok ? undefined : styles.muted}>{ok ? good : bad}</span>
    </li>
  );
}

export const styles: Record<string, CSSProperties> = {
  page: { maxWidth: 720, fontFamily: "inherit", color: "inherit" },
  h2: { fontSize: 18, fontWeight: 600, margin: "0 0 4px" },
  h3: { fontSize: 14, fontWeight: 600, margin: "0 0 8px" },
  h4: {
    fontSize: 12,
    fontWeight: 600,
    margin: "16px 0 4px",
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  muted: { color: "var(--muted-foreground, #6b7280)", fontSize: 13 },
  card: {
    border: "1px solid var(--border, #e5e7eb)",
    borderRadius: 8,
    padding: 16,
    marginTop: 16,
  },
  /** A card inside a card: one repository within the Repositories section. */
  repoCard: {
    border: "1px solid var(--border, #e5e7eb)",
    borderRadius: 8,
    padding: 12,
    marginTop: 10,
  },
  repoHead: {
    display: "flex",
    justifyContent: "space-between",
    gap: 8,
    fontSize: 13,
    marginBottom: 8,
  },
  list: { listStyle: "none", padding: 0, margin: "8px 0 0" },
  statusRow: { display: "flex", gap: 8, alignItems: "flex-start", marginBottom: 6, fontSize: 13 },
  checkRow: { marginBottom: 4 },
  checkLabel: { display: "flex", gap: 8, alignItems: "center", fontSize: 13, cursor: "pointer" },
  tick: { color: "var(--success, #16a34a)" },
  cross: { color: "var(--destructive, #dc2626)" },
  good: { color: "var(--success, #16a34a)", fontSize: 13 },
  bad: { color: "var(--destructive, #dc2626)", fontSize: 13 },
  input: {
    width: "100%",
    boxSizing: "border-box",
    padding: "8px 10px",
    borderRadius: 6,
    border: "1px solid var(--border, #e5e7eb)",
    background: "var(--background, transparent)",
    color: "inherit",
    fontSize: 13,
    fontFamily: "inherit",
  },
  textarea: {
    width: "100%",
    boxSizing: "border-box",
    padding: "8px 10px",
    borderRadius: 6,
    border: "1px solid var(--border, #e5e7eb)",
    background: "var(--background, transparent)",
    color: "inherit",
    fontSize: 13,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    resize: "vertical",
  },
  /** A block that groups a label, its control and its explanation. */
  field: { marginBottom: 18 },
  fieldLabel: { display: "block", fontSize: 13, fontWeight: 500, marginBottom: 4 },
  /** The supporting line under a control: the part operators actually read. */
  hint: {
    color: "var(--muted-foreground, #6b7280)",
    fontSize: 12,
    margin: "4px 0 0",
    lineHeight: 1.45,
  },
  /** A quiet aside inside a label, e.g. the repository name beside a project name. */
  hintInline: { color: "var(--muted-foreground, #6b7280)", fontSize: 12 },
  row: { display: "flex", gap: 12, alignItems: "center", marginTop: 12, flexWrap: "wrap" },
  repoRow: { display: "flex", gap: 8, alignItems: "center", marginBottom: 8 },
  iconButton: {
    padding: "6px 10px",
    borderRadius: 6,
    border: "1px solid var(--border, #e5e7eb)",
    background: "transparent",
    color: "inherit",
    fontSize: 12,
    cursor: "pointer",
    fontFamily: "inherit",
    whiteSpace: "nowrap",
  },
  button: {
    padding: "8px 14px",
    borderRadius: 6,
    border: "1px solid var(--border, #e5e7eb)",
    background: "var(--background, transparent)",
    color: "inherit",
    fontSize: 13,
    cursor: "pointer",
    fontFamily: "inherit",
  },
  primary: {
    background: "var(--primary, #111827)",
    color: "var(--primary-foreground, #ffffff)",
    border: "1px solid transparent",
  },

  // -- Nav column ---------------------------------------------------------
  // These mirror the host's own `SidebarNavItem` row so the entry sits in the
  // nav column rather than beside it. Taken from that component's classes:
  //   "flex items-center gap-2.5 mx-2 rounded-lg px-2 py-1.5
  //    text-(length:--text-compact) font-medium transition-colors"
  //   active: bg-sidebar-accent text-sidebar-accent-foreground
  //   idle:   text-foreground/80 hover:bg-sidebar-accent
  // Same rhythm, same inset pill, same hover — otherwise the row reads as a
  // foreign object in the list, which is exactly what it looked like.
  sidebarWrap: { display: "flex", flexDirection: "column", gap: 0 },
  sidebarLink: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    margin: "0 8px",
    borderRadius: 8,
    padding: "6px 8px",
    color: "var(--foreground)",
    opacity: 0.8,
    textDecoration: "none",
    fontSize: "var(--text-compact, 13px)",
    fontWeight: 500,
    lineHeight: 1.35,
    transition: "background-color 120ms ease, color 120ms ease",
  },
  /** Matches `h-4 w-4 text-foreground/80` on the host's icons. */
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
  sidebarDotOk: {
    flex: "0 0 auto",
    width: 6,
    height: 6,
    borderRadius: "50%",
    background: "var(--primary)",
  },
  sidebarDotIdle: {
    flex: "0 0 auto",
    width: 6,
    height: 6,
    borderRadius: "50%",
    background: "var(--muted-foreground)",
  },
  /** The note sits under the row, aligned to the label's left edge. */
  sidebarNotes: { listStyle: "none", padding: "0 16px 0 34px", margin: "2px 0 0" },
};

/**
 * Surfaces the reader draws in Paperclip's own design language.
 *
 * Switched from CodeGraph's warm-paper palette to the host's tokens at the
 * operator's request: a plugin page that repaints itself in another tool's
 * colours reads as a foreign window inside Paperclip, and it ignores the theme
 * the operator chose. Every value here is a host custom property, so light and
 * dark both work without this plugin knowing which is active.
 *
 * `var(--x, fallback)` rather than the raw property: the tokens are defined at
 * `:root` by the host, and the fallbacks keep the page legible if one is ever
 * renamed.
 */
export const ui = {
  /** Page surface. */
  background: "var(--background, #ffffff)",
  foreground: "var(--foreground, #16150f)",
  /** Panels and inputs. */
  card: "var(--card, #ffffff)",
  muted: "var(--muted, rgba(0,0,0,0.04))",
  mutedForeground: "var(--muted-foreground, rgba(0,0,0,0.55))",
  border: "var(--border, rgba(0,0,0,0.10))",
  input: "var(--input, rgba(0,0,0,0.12))",
  primary: "var(--primary, #16150f)",
  primaryForeground: "var(--primary-foreground, #ffffff)",
  accent: "var(--accent, rgba(0,0,0,0.05))",
  accentForeground: "var(--accent-foreground, #16150f)",
  /** The one accent used for selected and active states. */
  ring: "var(--ring, rgba(0,0,0,0.35))",
  destructive: "var(--destructive, #dc2626)",
  /** Named like the host's own scale. */
  fontSans: 'var(--font-sans, "InterVariable", Inter, ui-sans-serif, system-ui, sans-serif)',
  fontMono: 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
  /** Row height and radius constants taken from the host's sidebar rows. */
  radius: "var(--radius, 8px)",
} as const;
