/**
 * Activating CodeGraph in Paperclip is a create-then-bind-then-create sequence
 * against three board-owned objects. Every one of them fails with a conflict
 * error on a second run, which made the Activate button error the second time it
 * was pressed even though its own copy promised "safe to run twice".
 *
 * A governance button that throws when pressed twice teaches people to distrust
 * it, so the conflict cases are classified here — in a pure, testable function
 * rather than buried in the component — and treated as success by the caller.
 */

/** The profile key the plugin owns. Stable: a rename abandons the old profile. */
export const PROFILE_KEY = "codegraph-read";

/** The gateway slug the plugin owns. Unique per company in Paperclip. */
export const GATEWAY_SLUG = "codegraph";

export const GATEWAY_NAME = "CodeGraph";

/**
 * Whether an error means "this already exists", i.e. a previous activation
 * already did this step.
 *
 * Matched on text because Paperclip does not return a stable conflict code for
 * these routes: `POST /tools/profiles` answers 400 with a message, not 409. The
 * match is deliberately narrow, and anything unrecognised is rethrown rather
 * than swallowed — a real failure must not look like a no-op.
 */
export function isAlreadyExistsMessage(message: string): boolean {
  return /already exists|duplicate key|unique constraint|conflict/i.test(message);
}

/**
 * Find the profile this plugin owns in a list response.
 *
 * `GET /api/companies/:companyId/tools/profiles` answers
 * `{ profiles: [...] }` — not a bare array (routes/tool-access.ts). The first
 * version of the idempotency fix assumed an array, so the lookup silently found
 * nothing and reported "already exists but could not be found to reuse".
 *
 * Both shapes are accepted because guessing one was the bug, but the wrapped form
 * is the one the API actually returns.
 */
export function findProfileId(response: unknown, profileKey: string): string | null {
  const rows = Array.isArray(response)
    ? response
    : typeof response === "object" && response !== null && Array.isArray((response as { profiles?: unknown }).profiles)
      ? ((response as { profiles: unknown[] }).profiles)
      : [];

  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const record = row as { id?: unknown; profileKey?: unknown };
    if (record.profileKey === profileKey && typeof record.id === "string") {
      return record.id;
    }
  }
  return null;
}

/** One step's outcome, so the caller can report what actually happened. */
export type StepOutcome = "created" | "already-existed" | "repointed";

/**
 * Find the gateway this plugin owns in a list response.
 *
 * Same lesson as `findProfileId`, learned the hard way twice:
 * `GET /api/companies/:companyId/tools/gateways` answers `{ gateways: [...] }`,
 * and relying on an error message instead of a lookup is how the gateway step
 * came to surface a raw `Failed query: insert into "tool_mcp_gateways" …` — the
 * unique constraint on `(company_id, slug)` rejected the insert, but the message
 * Paperclip returns for that contains none of the words a conflict classifier
 * would look for. So: look it up first.
 */
export function findGateway(
  response: unknown,
  slug: string,
): { id: string; profileId: string | null } | null {
  const rows = Array.isArray(response)
    ? response
    : typeof response === "object" && response !== null && Array.isArray((response as { gateways?: unknown }).gateways)
      ? ((response as { gateways: unknown[] }).gateways)
      : [];

  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const record = row as {
      id?: unknown;
      slug?: unknown;
      displaySlug?: unknown;
      profileId?: unknown;
    };
    const rowSlug = typeof record.slug === "string" ? record.slug : record.displaySlug;
    if (rowSlug !== slug || typeof record.id !== "string") continue;
    return {
      id: record.id,
      profileId: typeof record.profileId === "string" ? record.profileId : null,
    };
  }
  return null;
}

export interface ActivationSummary {
  profileId: string;
  profile: StepOutcome;
  binding: StepOutcome;
  gateway: StepOutcome;
}

/**
 * What to tell the operator.
 *
 * Deliberately distinguishes a first run from a repeat one: "activated" on a
 * no-op press would leave someone wondering whether anything happened.
 */
export function describeActivation(summary: ActivationSummary): string {
  const repeat =
    summary.profile === "already-existed" &&
    summary.binding === "already-existed" &&
    summary.gateway === "already-existed";
  if (summary.gateway === "repointed") {
    return "Activated and repaired: the MCP gateway already existed and was pointed at the current profile.";
  }
  const partial = [summary.profile, summary.binding, summary.gateway].some(
    (step) => step === "created",
  );

  if (repeat) {
    return "CodeGraph was already activated — nothing to do. Agents working in a Paperclip project have its tools.";
  }
  if (partial && summary.profile === "created") {
    return "Activated. Agents working in a Paperclip project now have CodeGraph for that project's repository.";
  }
  return "Activated and repaired: some records already existed. Agents working in a Paperclip project now have CodeGraph.";
}
