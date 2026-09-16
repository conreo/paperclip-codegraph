import { describe, expect, it } from "vitest";

import { MAX_ERROR_CHARS, REDACTED, sanitizeErrorMessage } from "../src/errors.js";

/** The exact message a board member saw on the settings page. */
const LEAKED = `Failed query: insert into "tool_mcp_gateways" ("id", "company_id", "gateway_public_id", "name", "slug", "display_slug", "description", "status", "profile_id", "default_profile_mode", "context_scope_type", "context_scope_id", "agent_id", "project_id", "issue_id", "approval_issue_id", "auth_config", "header_policy", "metadata_policy", "on_demand_tools_config", "metadata", "created_by_agent_id", "created_by_user_id", "archived_at", "created_at", "updated_at") values (default, $1, default, $2, $3, $4, $5, default, $6, $7, $8, $9, $10, $11, $12, $13, default, default, default, default, $14, $15, $16, default, $17, $18) returning "id", "company_id", "gateway_public_id", "name", "slug", "display_slug", "description", "status", "profile_id", "default_profile_mode", "context_scope_type", "context_scope_id", "agent_id", "project_id", "issue_id", "approval_issue_id", "auth_config", "header_policy", "metadata_policy", "on_demand_tools_config", "metadata", "created_by_agent_id", "created_by_user_id", "archived_at", "created_at", "updated_at" params: 5705a475-f49e-49b0-b537-b5015b511ffa,CodeGraph,codegraph,codegraph,,cde655fc-e744-4caa-ab24-29edb7ba1372,gateway_only,none,,,,,,{},,n6AvTDdC4Y7g2WyMju12VIug8vqZm9kW,2026-09-16T13:20:59.706Z,2026-09-16T13:20:59.706Z`;

describe("sanitizeErrorMessage — the leak that reached the page", () => {
  it("drops the raw SQL statement and its bound parameters entirely", () => {
    const clean = sanitizeErrorMessage(LEAKED);
    expect(clean).not.toMatch(/insert into/i);
    expect(clean).not.toMatch(/params:/i);
    expect(clean).not.toMatch(/\$1/);
  });

  it("drops the token-looking parameter", () => {
    expect(sanitizeErrorMessage(LEAKED)).not.toContain("n6AvTDdC4Y7g2WyMju12VIug8vqZm9kW");
  });

  it("still says something useful and points at the log", () => {
    const clean = sanitizeErrorMessage(LEAKED);
    expect(clean).toMatch(/server rejected/i);
    expect(clean).toMatch(/server log/i);
  });
});

describe("sanitizeErrorMessage — ordinary messages", () => {
  it("passes a normal error through", () => {
    expect(sanitizeErrorMessage("Board access required")).toBe("Board access required");
  });

  it("keeps the wording a conflict classifier needs", () => {
    // Classification runs on the raw text, but nothing here should rewrite a
    // message that carries real meaning.
    const message = "A tool access record with that name already exists";
    expect(sanitizeErrorMessage(message)).toBe(message);
  });

  it("redacts a long opaque run", () => {
    expect(sanitizeErrorMessage("token abcdefghijklmnopqrstuvwxyz012345 rejected")).toBe(
      `token ${REDACTED} rejected`,
    );
  });

  it("does not mangle a UUID", () => {
    // UUIDs are hyphenated, so each run is short. Losing them would make error
    // messages useless for support.
    const message = "no request 5ebdaf48-3f46-447f-b0f1-be65b0c6f189";
    expect(sanitizeErrorMessage(message)).toBe(message);
  });

  it("does not mangle a profile key", () => {
    expect(sanitizeErrorMessage('"codegraph-read" not found')).toBe('"codegraph-read" not found');
  });

  it("collapses newlines and tabs so a log dump cannot dominate the page", () => {
    expect(sanitizeErrorMessage("a\n\n\tb")).toBe("a b");
  });

  it("truncates a wall of text", () => {
    // Separated words, not one long run: a 1000-character alphanumeric run is
    // token-shaped and gets redacted wholesale, which is the correct behaviour
    // and a different case.
    const long = "word ".repeat(300);
    const clean = sanitizeErrorMessage(long);
    expect(clean.length).toBeLessThanOrEqual(MAX_ERROR_CHARS);
    expect(clean.endsWith("…")).toBe(true);
  });

  it("redacts a very long alphanumeric run rather than truncating it", () => {
    expect(sanitizeErrorMessage("x".repeat(1000))).toBe(REDACTED);
  });

  it("handles an Error, a non-string, and nothing at all", () => {
    expect(sanitizeErrorMessage(new Error("boom"))).toBe("boom");
    expect(sanitizeErrorMessage(undefined)).toBe("undefined");
    expect(sanitizeErrorMessage(null)).toBe("null");
  });
});
