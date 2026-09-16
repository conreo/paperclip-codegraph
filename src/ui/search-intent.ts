/**
 * Reading a question out of the search box.
 *
 * The placeholder — taken from CodeGraph's own UI — offers *"Search a symbol or
 * file, or ask 'how does execute reach getFile'"*. That second half is a promise,
 * and this plugin cannot keep it: answering it needs the path search that belongs
 * to the Flow view, which is not implemented here.
 *
 * So the question is **recognised** and answered with what is actually available,
 * rather than being treated as a symbol name and returning "no symbol matches".
 * A search box that silently fails on half its own placeholder teaches an operator
 * that the feature is broken, when the truth is that it is elsewhere.
 *
 * Pure, so the parsing is testable without a browser.
 */

export interface SearchIntent {
  kind: "question" | "text";
  /** For a question: the two symbols named, when both could be read. */
  from?: string;
  to?: string;
  /** The original text, for showing back. */
  raw: string;
}

/** `how does X reach Y`, `how does X get to Y`, `does X reach Y`, `path X Y`. */
const PATTERNS: RegExp[] = [
  /\bhow\s+does\s+(.+?)\s+(?:reach|get\s+to|call|lead\s+to|flow\s+to)\s+(.+?)\s*[?.!]*$/i,
  /\bdoes\s+(.+?)\s+(?:reach|call|get\s+to)\s+(.+?)\s*[?.!]*$/i,
  /\bpath\s+(?:from\s+)?(.+?)\s+to\s+(.+?)\s*[?.!]*$/i,
  /\bhow\s+is\s+(.+?)\s+(?:reached|connected)\s+(?:from|by)\s+(.+?)\s*[?.!]*$/i,
];

function clean(value: string): string {
  return value.trim().replace(/^["'“”]|["'“”]$/g, "").trim();
}

/** Classify a search box's contents. */
export function parseSearchIntent(query: string): SearchIntent {
  const raw = query.trim();
  if (raw.length === 0) return { kind: "text", raw };

  for (const pattern of PATTERNS) {
    const match = pattern.exec(raw);
    if (!match) continue;
    const from = clean(match[1] ?? "");
    const to = clean(match[2] ?? "");
    // Both ends must be non-empty and different, or the "question" is malformed
    // and better treated as a name search.
    if (from.length === 0 || to.length === 0 || from === to) continue;
    return { kind: "question", from, to, raw };
  }

  return { kind: "text", raw };
}
