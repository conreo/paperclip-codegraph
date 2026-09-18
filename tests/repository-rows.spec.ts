/**
 * How a repository is named and picked.
 *
 * These are the two rules a multi-repository project turns on, and both fail
 * quietly: a wrong title is six rows all called "Vroomy", and a wrong pick indexes
 * a different checkout than the one that was clicked while reporting success.
 */

import { describe, expect, it } from "vitest";

import {
  repositoryLabel,
  repositoryRow,
  selectRepository,
  type RepositoryFacts,
} from "../src/graph/repository-rows.js";

const facts = (overrides: Partial<RepositoryFacts> = {}): RepositoryFacts => ({
  projectId: "p1",
  projectName: "Vroomy",
  repositoryKey: "",
  repositoryName: "vroomy",
  folderName: "vroomy",
  siblings: 1,
  indexed: false,
  blocked: false,
  ...overrides,
});

describe("repositoryRow — naming one repository", () => {
  it("titles a lone checkout after its project", () => {
    // The operator named the project and looks for that name; the folder is an
    // accident of how Paperclip checked the code out.
    const row = repositoryRow(facts());
    expect(row.name).toBe("Vroomy");
    expect(row.projectName).toBe("Vroomy");
    expect(row.repoName).toBe("vroomy");
  });

  it("titles each checkout of a multi-repository project after itself", () => {
    // The project name is the group here. Six rows all called "Vroomy" would be
    // indistinguishable, and the repository is the thing being indexed.
    const row = repositoryRow(
      facts({
        repositoryKey: "vroomy-backend",
        repositoryName: "vroomy-backend",
        folderName: "vroomy-backend",
        siblings: 6,
      }),
    );
    expect(row.name).toBe("vroomy-backend");
    // The project still travels with the row, so the page can say which project it
    // belongs to now that the title cannot.
    expect(row.projectName).toBe("Vroomy");
  });

  it("falls back to the folder when a checkout has no remote", () => {
    // A bare `git init` is a repository. It has no name from `origin`, and the
    // folder is the only name there is.
    const row = repositoryRow(facts({ repositoryName: null, folderName: "checkout-2" }));
    expect(row.name).toBe("Vroomy");
    expect(row.repoName).toBeNull();
    expect(repositoryLabel(facts({ repositoryName: null, folderName: "checkout-2" }))).toBe(
      "checkout-2",
    );
  });

  it("names a multi-repository row from the folder when there is no remote", () => {
    const row = repositoryRow(
      facts({ repositoryName: null, folderName: "vroomy-proto", siblings: 6 }),
    );
    expect(row.name).toBe("vroomy-proto");
  });

  it("falls back to the repository name when the project has no name", () => {
    const row = repositoryRow(facts({ projectName: null }));
    expect(row.name).toBe("vroomy");
  });

  it("carries the key and the flags through untouched", () => {
    // The key is what an action sends back, so it must survive row shaping exactly:
    // `""` is a real key meaning "the project's own checkout", not a missing value.
    const row = repositoryRow(facts({ repositoryKey: "", indexed: true, blocked: true }));
    expect(row.repositoryKey).toBe("");
    expect(row.indexed).toBe(true);
    expect(row.blocked).toBe(true);
    expect(row.projectId).toBe("p1");
  });
});

describe("selectRepository — which repository a request is about", () => {
  const checkouts = [
    { relativePath: "vroomy-backend", path: "/w/vroomy-backend" },
    { relativePath: "vroomy-frontend", path: "/w/vroomy-frontend" },
  ];

  it("takes the workspace itself as the primary when there is one", () => {
    // An ordinary single-checkout project: the only candidate is the workspace.
    const only = [{ relativePath: "", path: "/w" }];
    expect(selectRepository(only, undefined)?.path).toBe("/w");
    expect(selectRepository(only, null)?.path).toBe("/w");
  });

  it("takes the first checkout when the workspace holds several", () => {
    // The graph view's "no project chosen yet" case: it has to resolve to something
    // rather than fail. `findRepositories` orders the list, so this is stable.
    expect(selectRepository(checkouts, undefined)?.relativePath).toBe("vroomy-backend");
  });

  it("prefers the workspace over the first child when both could apply", () => {
    const mixed = [{ relativePath: "", path: "/w" }, ...checkouts];
    expect(selectRepository(mixed, undefined)?.path).toBe("/w");
  });

  it("matches an explicit key exactly", () => {
    expect(selectRepository(checkouts, "vroomy-frontend")?.path).toBe("/w/vroomy-frontend");
  });

  it("treats an empty key as the workspace, not as a missing key", () => {
    // `""` is the key the list hands out for the project's own checkout. Read as
    // "absent" it would fall through to the first child and index the wrong
    // repository — silently, and reporting success.
    const mixed = [{ relativePath: "", path: "/w" }, ...checkouts];
    expect(selectRepository(mixed, "")?.path).toBe("/w");
  });

  it("returns nothing for a key the workspace does not hold", () => {
    // Falling back to "some repository" here would index something the operator did
    // not click. An error naming what was not found is the honest answer.
    expect(selectRepository(checkouts, "vroomy-infra")).toBeNull();
    expect(selectRepository([], undefined)).toBeNull();
  });
});
