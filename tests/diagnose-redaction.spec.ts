import { describe, expect, it } from "vitest";
import path from "node:path";

/**
 * What a diagnostic may disclose.
 *
 * `graph-diagnose` reports where the plugin looked, and a diagnostic that leaks
 * the host's filesystem layout is worse than none: it would put a full managed
 * workspace path in front of every board member to answer a question an operator
 * asks. These pin the rule the handler follows.
 *
 * The first version used `redactPath` here, which is built for *audit keys* — two
 * trailing path segments plus a hash — so a managed workspace came out as
 * `5ebdaf48-3f46-447f-b0f1-be65b0c6f189-pos-<hash>`, disclosing the project UUID it
 * was supposed to hide. `path.basename` is the correct tool for a label.
 */
describe("diagnostic path disclosure", () => {
  const managed =
    "/paperclip/instances/default/projects/5705a475-f49e-49b0-b537-b5015b511ffa/5ebdaf48-3f46-447f-b0f1-be65b0c6f189/pos";

  it("reduces a managed workspace to its last segment", () => {
    expect(path.basename(managed)).toBe("pos");
  });

  it("discloses no host prefix and no project UUID", () => {
    const label = path.basename(managed);
    expect(label).not.toContain("/");
    expect(label).not.toContain("paperclip");
    expect(label).not.toContain("5ebdaf48");
    expect(label).not.toContain("5705a475");
  });

  it("labels an index path by its repository and the fixed directory name", () => {
    // `.codegraph` alone says nothing; the repository it sits in is the point.
    const label = `${path.basename(managed)}/.codegraph`;
    expect(label).toBe("pos/.codegraph");
    expect(label).not.toContain("paperclip");
  });

  it("does not blow up on a bare root", () => {
    expect(typeof path.basename("/")).toBe("string");
  });
});
