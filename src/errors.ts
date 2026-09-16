/**
 * Sanitising server errors before they reach a board member's screen.
 *
 * Paperclip passes database errors through verbatim. Pressing Activate on an
 * already-activated company rendered this on the settings page:
 *
 *   Failed query: insert into "tool_mcp_gateways" ("id", "company_id", …)
 *   values (default, $1, default, …)
 *   params: 5705a475-…,CodeGraph,codegraph,…,,n6AvTDdC4Y7g2WyMju12VIug8vqZm9kW,…
 *
 * That is a full SQL statement **and its bound parameters** — which can include
 * secrets — displayed in a governance UI. Two separate problems: it leaks, and it
 * is useless to the person reading it.
 *
 * Applied at the display boundary only. Conflict classification still sees the raw
 * text, because deciding "already exists" from a sanitised message would be
 * deciding it from a message we wrote ourselves.
 */

/** Marker substituted for anything that looks like a credential. */
export const REDACTED = "[redacted]";

/** How much of a legitimate message is worth showing. */
export const MAX_ERROR_CHARS = 300;

/**
 * A run of characters with no separators is almost never an identifier we want to
 * show — UUIDs are hyphenated, profile keys are short and use `-` or `_`. A
 * 20-plus alphanumeric run is the shape of a bearer token or a generated key.
 */
const TOKEN_LIKE = /[A-Za-z0-9]{20,}/g;

/** Drizzle/Paperclip's raw SQL echo, with or without bound params. */
const RAW_QUERY = /failed query:/i;

export function sanitizeErrorMessage(raw: unknown): string {
  const text = typeof raw === "string" ? raw : raw instanceof Error ? raw.message : String(raw);

  // The SQL echo is dropped whole rather than redacted in place: its parameters
  // are the sensitive part, and a partially redacted statement is still no use to
  // an operator. The server log has the detail they would actually need.
  if (RAW_QUERY.test(text)) {
    return "The Paperclip server rejected that request. The underlying error is in the server log.";
  }

  const collapsed = text.replace(/\s+/g, " ").trim();
  const withoutTokens = collapsed.replace(TOKEN_LIKE, REDACTED);

  if (withoutTokens.length <= MAX_ERROR_CHARS) return withoutTokens;
  return `${withoutTokens.slice(0, MAX_ERROR_CHARS - 1)}…`;
}
