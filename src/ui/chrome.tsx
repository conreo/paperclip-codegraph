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
  // Sized and coloured to sit among the host's own nav items rather than
  // announce itself as foreign: same compact text size, same muted default,
  // and a glyph on the left like every sibling entry.
  sidebarWrap: { display: "flex", flexDirection: "column", gap: 2 },
  sidebarLink: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "6px 8px",
    borderRadius: 6,
    color: "inherit",
    textDecoration: "none",
    fontSize: 13,
    fontWeight: 500,
    lineHeight: 1.2,
  },
  sidebarGlyph: { display: "inline-flex", flex: "0 0 auto", opacity: 0.8 },
  sidebarLabel: { flex: "1 1 auto", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  sidebarDotOk: {
    flex: "0 0 auto",
    width: 6,
    height: 6,
    borderRadius: "50%",
    background: "var(--success, #16a34a)",
  },
  sidebarDotIdle: {
    flex: "0 0 auto",
    width: 6,
    height: 6,
    borderRadius: "50%",
    background: "var(--muted-foreground, #9ca3af)",
  },
  sidebarNotes: { listStyle: "none", padding: "0 8px", margin: 0 },
};
