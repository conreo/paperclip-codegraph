import { describe, expect, it } from "vitest";

import { parseSearchIntent } from "../src/ui/search-intent.js";

describe("parseSearchIntent", () => {
  it("reads the placeholder's own example", () => {
    // Verbatim from CodeGraph's UI, which is where the placeholder came from.
    expect(parseSearchIntent("how does execute reach getFile")).toEqual({
      kind: "question",
      from: "execute",
      to: "getFile",
      raw: "how does execute reach getFile",
    });
  });

  it("reads the variants a person actually types", () => {
    const cases: Array<[string, string, string]> = [
      ["how does execute get to getFile", "execute", "getFile"],
      ["does execute reach getFile", "execute", "getFile"],
      ["path from execute to getFile", "execute", "getFile"],
      ["path execute to getFile", "execute", "getFile"],
      ["how is getFile reached from execute", "getFile", "execute"],
    ];
    for (const [input, from, to] of cases) {
      const intent = parseSearchIntent(input);
      expect(intent.kind, input).toBe("question");
      expect(intent.from, input).toBe(from);
      expect(intent.to, input).toBe(to);
    }
  });

  it("tolerates punctuation and quotes", () => {
    expect(parseSearchIntent("How does execute reach getFile?").kind).toBe("question");
    expect(parseSearchIntent('how does "execute" reach "getFile"')).toMatchObject({
      from: "execute",
      to: "getFile",
    });
  });

  it("treats a plain name as text, not a question", () => {
    // The overwhelming majority of queries. Misreading one as a question would
    // replace a working symbol list with an explanation.
    for (const input of ["createOrder", "orderEngine.ts", "useOrderStore", "src/api", "GET /api/health"]) {
      expect(parseSearchIntent(input).kind, input).toBe("text");
    }
  });

  it("does not invent a question from a partial phrase", () => {
    for (const input of ["how does execute", "reach getFile", "how does reach", "path to"]) {
      expect(parseSearchIntent(input).kind, input).toBe("text");
    }
  });

  it("rejects a question naming the same symbol twice", () => {
    // "how does x reach x" is not askable; falling back to a name search is more
    // useful than an explanation of an impossible question.
    expect(parseSearchIntent("how does x reach x").kind).toBe("text");
  });

  it("handles empty and whitespace input", () => {
    expect(parseSearchIntent("")).toEqual({ kind: "text", raw: "" });
    expect(parseSearchIntent("   ").kind).toBe("text");
  });

  it("keeps the raw text for showing back to the operator", () => {
    expect(parseSearchIntent("  how does a reach b  ").raw).toBe("how does a reach b");
  });
});
