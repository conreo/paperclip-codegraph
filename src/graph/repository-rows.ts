/**
 * How one repository is named and identified in the settings page.
 *
 * Extracted from the worker for the same reason `sidebar-status.ts` was: this is
 * the part that goes wrong quietly. A project holding six checkouts used to render
 * as no row at all, and the naive fix — one row per checkout, each titled after its
 * project — renders six rows all called "Vroomy", which looks like a rendering bug
 * rather than a wrong name.
 *
 * ## The identity
 *
 * `repositoryKey` is the repository's path relative to the project workspace, `""`
 * for the workspace itself. It is what every action takes back, so it must be
 * stable across a reload and free of host layout: a directory name relative to the
 * workspace is both. It is deliberately **not** the absolute path — that never
 * leaves the host — and deliberately not an index into a list, which would silently
 * point at a different repository the moment one is added.
 *
 * ## The title
 *
 * One checkout keeps the project's name, because that is the label the operator
 * gave it and the one they will look for. Several checkouts cannot: the project name
 * is then the *group*, and the repository has to name itself. `projectName` travels
 * alongside either way so the row can say which project it belongs to.
 *
 * Pure: no filesystem, no clock.
 */

/** What the worker knows about a repository before it becomes a row. */
export interface RepositoryFacts {
  projectId: string;
  /** The Paperclip project's name, when it has one. */
  projectName: string | null;
  /** Path relative to the project workspace; `""` is the workspace itself. */
  repositoryKey: string;
  /** Repository name from `origin`, when the checkout has a remote. */
  repositoryName: string | null;
  /** The directory the checkout lives in, used when `origin` says nothing. */
  folderName: string;
  /** How many repositories the project holds, this one included. */
  siblings: number;
  indexed: boolean;
  /** True when an operator has switched CodeGraph off for this project. */
  blocked: boolean;
}

/** One repository, as the settings page and the nav column read it. */
export interface RepositoryRow {
  projectId: string;
  /** Path relative to the workspace. The identity every action takes back. */
  repositoryKey: string;
  /** The row's title. See the file comment for which one wins and why. */
  name: string;
  /** The project's name, so a repository can say which project it belongs to. */
  projectName: string | null;
  /** Repository name from `origin`. May be null: not every checkout has a remote. */
  repoName: string | null;
  indexed: boolean;
  blocked: boolean;
}

/** The repository's own name, falling back to the directory it sits in. */
export function repositoryLabel(facts: Pick<
  RepositoryFacts,
  "repositoryName" | "folderName"
>): string {
  return facts.repositoryName ?? facts.folderName;
}

export function repositoryRow(facts: RepositoryFacts): RepositoryRow {
  const own = repositoryLabel(facts);
  return {
    projectId: facts.projectId,
    repositoryKey: facts.repositoryKey,
    // Several checkouts under one project: the project name would repeat down the
    // whole list, so the repository names itself and the project becomes the aside.
    name: facts.siblings > 1 ? own : (facts.projectName ?? own),
    projectName: facts.projectName,
    repoName: facts.repositoryName,
    indexed: facts.indexed,
    blocked: facts.blocked,
  };
}

/**
 * Which repository a request is about.
 *
 * An absent key means "the primary one": the workspace itself when it is a
 * repository, otherwise the first checkout the workspace holds. The list is
 * ordered by `findRepositories`, so "first" is stable — and this is the case the
 * graph view hits when no project has been chosen yet, which has to resolve to
 * something rather than fail.
 *
 * An explicit key — including `""`, which is a real key and not a missing value —
 * must match exactly. Treating an unmatched key as "fall back to something" would
 * quietly index a different repository than the one the operator clicked, which is
 * worse than an error naming what was not found.
 */
export function selectRepository<T extends { relativePath: string }>(
  candidates: readonly T[],
  key?: string | null,
): T | null {
  if (typeof key !== "string") {
    return candidates.find((candidate) => candidate.relativePath === "") ?? candidates[0] ?? null;
  }
  return candidates.find((candidate) => candidate.relativePath === key) ?? null;
}
