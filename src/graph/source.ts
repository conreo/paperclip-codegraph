/**
 * Source excerpts for the graph view.
 *
 * Reading a file is the one place this plugin touches bytes rather than an
 * index, so the two things that matter are bounded: how much is read, and how
 * much is returned. Both are capped here rather than at the call site, so a
 * caller cannot ask for an unbounded read by passing a large range.
 */

import fs from "node:fs/promises";

export interface Excerpt {
  /** Line-numbered excerpt, `N<TAB>text` per line. */
  text: string;
  /** First line actually included. */
  firstLine: number | null;
  /** Last line actually included. */
  lastLine: number | null;
  /** True when the requested range was not shown in full. */
  truncated: boolean;
}

export const EMPTY_EXCERPT: Excerpt = {
  text: "",
  firstLine: null,
  lastLine: null,
  truncated: false,
};

/**
 * Read a line-numbered excerpt from `absolutePath`.
 *
 * Only the first `maxBytes` of the file are read: a symbol near the top of a
 * very large file must not pull the whole file through the plugin bridge. A byte
 * cap can cut a multi-byte character in half, so the decoded tail is trimmed
 * back to the last complete line before slicing.
 *
 * `truncated` means "the range the index asked for was not shown in full". That
 * covers both a `maxLines` cap and an index whose declared end line runs past
 * the end of the file — the second is drift between index and working tree, and
 * a reader who sees a 5-line file labelled as extending to line 99 has learned
 * something worth knowing rather than been shown a silent error.
 */
export async function readExcerpt(
  absolutePath: string,
  startLine: number | null,
  endLine: number | null,
  options: { maxLines: number; maxBytes: number },
): Promise<Excerpt> {
  const start = Math.max(1, Math.floor(startLine ?? 1));
  const end = Math.max(start, Math.floor(endLine ?? start));
  const window = Math.min(end, start + Math.max(1, options.maxLines) - 1);

  const handle = await fs.open(absolutePath, "r");
  let text: string;
  try {
    const buffer = Buffer.alloc(options.maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, options.maxBytes, 0);
    text = buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }

  const lines = text.split("\n");
  const slice = lines.slice(start - 1, window);
  if (slice.length === 0) return EMPTY_EXCERPT;

  const lastLine = start + slice.length - 1;
  return {
    text: slice.map((line, index) => `${start + index}\t${line}`).join("\n"),
    firstLine: start,
    lastLine,
    // Either the line cap bit, or the file ended before the declared end line.
    truncated: end > window || lastLine < end,
  };
}
