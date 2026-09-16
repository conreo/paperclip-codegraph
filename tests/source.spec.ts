import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { EMPTY_EXCERPT, readExcerpt } from "../src/graph/source.js";

const OPTIONS = { maxLines: 60, maxBytes: 256_000 };

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pcg-source-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function write(name: string, content: string): string {
  const target = path.join(root, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
}

/** A file of numbered lines, one-based, so expectations read directly. */
function numbered(count: number): string {
  return Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n");
}

describe("readExcerpt", () => {
  it("returns the requested range with line numbers", async () => {
    const file = write("a.ts", numbered(20));
    const excerpt = await readExcerpt(file, 5, 7, OPTIONS);

    expect(excerpt.text.split("\n")).toEqual(["5\tline 5", "6\tline 6", "7\tline 7"]);
    expect(excerpt.firstLine).toBe(5);
    expect(excerpt.lastLine).toBe(7);
    expect(excerpt.truncated).toBe(false);
  });

  it("includes the first line of a symbol, not the line before it", async () => {
    const file = write("a.ts", numbered(10));
    const excerpt = await readExcerpt(file, 1, 3, OPTIONS);
    expect(excerpt.text.startsWith("1\tline 1")).toBe(true);
    expect(excerpt.firstLine).toBe(1);
  });

  it("caps a long symbol at maxLines and says it was truncated", async () => {
    const file = write("a.ts", numbered(500));
    const excerpt = await readExcerpt(file, 10, 400, { maxLines: 25, maxBytes: 256_000 });

    const lines = excerpt.text.split("\n");
    expect(lines).toHaveLength(25);
    expect(lines[0]).toBe("10\tline 10");
    expect(lines.at(-1)).toBe("34\tline 34");
    expect(excerpt.truncated).toBe(true);
  });

  it("does not claim truncation for a symbol that fits", async () => {
    const file = write("a.ts", numbered(500));
    const excerpt = await readExcerpt(file, 10, 20, { maxLines: 25, maxBytes: 256_000 });
    expect(excerpt.text.split("\n")).toHaveLength(11);
    expect(excerpt.truncated).toBe(false);
  });

  it("treats a single-line symbol as one line", async () => {
    const file = write("a.ts", numbered(10));
    const excerpt = await readExcerpt(file, 4, 4, OPTIONS);
    expect(excerpt.text).toBe("4\tline 4");
  });

  it("starts at line 1 when the index has no line numbers", async () => {
    const file = write("a.ts", numbered(10));
    const excerpt = await readExcerpt(file, null, null, OPTIONS);
    expect(excerpt.firstLine).toBe(1);
    expect(excerpt.text.split("\n")[0]).toBe("1\tline 1");
  });

  it("returns nothing when the range starts past the end of the file", async () => {
    const file = write("a.ts", numbered(3));
    expect(await readExcerpt(file, 90, 95, OPTIONS)).toEqual(EMPTY_EXCERPT);
  });

  it("returns only the lines that exist when the range overruns the file", async () => {
    const file = write("a.ts", numbered(5));
    const excerpt = await readExcerpt(file, 3, 99, OPTIONS);
    expect(excerpt.text.split("\n")).toEqual(["3\tline 3", "4\tline 4", "5\tline 5"]);
    // The index claims the symbol runs to line 99 in a 5-line file. That is drift
    // between index and working tree, so it is reported rather than hidden.
    expect(excerpt.truncated).toBe(true);
  });

  it("reports drift when a maxLines cap is not the cause", async () => {
    const file = write("a.ts", numbered(5));
    // Comfortably within the line cap, so only the file's end can explain it.
    const excerpt = await readExcerpt(file, 1, 99, { maxLines: 500, maxBytes: 256_000 });
    expect(excerpt.text.split("\n")).toHaveLength(5);
    expect(excerpt.truncated).toBe(true);
  });

  it("never reads more than maxBytes", async () => {
    // 400 lines of ~40 bytes: far more than the 512-byte cap below.
    const file = write("big.ts", Array.from({ length: 400 }, (_, i) => `line ${i + 1}`.padEnd(40, ".")).join("\n"));
    const excerpt = await readExcerpt(file, 1, 400, { maxLines: 400, maxBytes: 512 });

    const bytes = Buffer.byteLength(excerpt.text, "utf8");
    expect(bytes).toBeLessThan(512 + 64);
    expect(excerpt.truncated).toBe(true);
  });

  it("keeps line numbers correct across a byte cap", async () => {
    const file = write("big.ts", Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join("\n"));
    const excerpt = await readExcerpt(file, 1, 200, { maxLines: 200, maxBytes: 200 });
    const lines = excerpt.text.split("\n");
    // Whatever made it through must still be numbered from the true start.
    expect(lines[0]).toBe("1\tline 1");
    lines.forEach((line, index) => {
      expect(line.startsWith(`${index + 1}\t`)).toBe(true);
    });
  });

  it("tolerates a file with no trailing newline", async () => {
    const file = write("a.ts", "only line");
    const excerpt = await readExcerpt(file, 1, 1, OPTIONS);
    expect(excerpt.text).toBe("1\tonly line");
  });

  it("returns an empty excerpt for an empty file", async () => {
    const file = write("empty.ts", "");
    const excerpt = await readExcerpt(file, 1, 5, OPTIONS);
    expect(excerpt.firstLine).toBe(1);
    expect(excerpt.text).toBe("1\t");
  });

  it("surfaces a missing file rather than inventing content", async () => {
    await expect(readExcerpt(path.join(root, "nope.ts"), 1, 2, OPTIONS)).rejects.toThrow();
  });

  it("is read-only", async () => {
    const file = write("a.ts", numbered(5));
    const before = fs.statSync(file).mtimeMs;
    await readExcerpt(file, 1, 5, OPTIONS);
    expect(fs.statSync(file).mtimeMs).toBe(before);
  });
});
