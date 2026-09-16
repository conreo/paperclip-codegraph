/**
 * Plugin settings page.
 *
 * This exists to delete a class of work: activating CodeGraph used to mean an
 * operator pasting curl commands, then a browser-console snippet, to create a
 * Paperclip tool profile and an MCP gateway. Both of those are board-only
 * objects, and they are the only reason activation was ever manual.
 *
 * Three things are true at once here, and together they make one page enough:
 *
 * 1. `context.companyId` is supplied by the host, so the page never guesses
 *    which company it is configuring.
 * 2. This bundle runs as trusted same-origin code inside the Paperclip app
 *    (PLUGIN_SPEC.md §23), and the app's own UI calls `/api/...` with
 *    `credentials: "include"` (`ui/src/lib/oauthHandoff.ts:74`). So a
 *    credentialed fetch from here carries the *board member's* session — which
 *    is exactly the authority `POST /tools/profiles` and `POST /tools/gateways`
 *    demand. No token is handled, stored, or exposed.
 * 3. The repository folder is not configured here at all: it is declared in
 *    `manifest.localFolders`, so the host renders and validates it natively.
 */

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import {
  usePluginAction,
  usePluginData,
  type PluginSettingsPageProps,
} from "@paperclipai/plugin-sdk/ui";

import {
  GATEWAY_NAME,
  GATEWAY_SLUG,
  PROFILE_KEY,
  describeActivation,
  findProfileId,
  isAlreadyExistsMessage,
  type ActivationSummary,
  type StepOutcome,
} from "../activation.js";


/** Must match the manifest id; the host namespaces tools with it. */
const PLUGIN_ID = "paperclip-codegraph";

const TOOL_SUFFIXES = [
  "explore",
  "search",
  "callers",
  "callees",
  "impact",
  "node",
  "status",
  "files",
] as const;

const READ_ONLY_TOOL_NAMES = TOOL_SUFFIXES.map((name) => `codegraph_${name}`);


/**
 * What goes into the Paperclip profile: the eight read-only tools.
 *
 * `codegraph_request_access` used to be here too. It was removed with the whole
 * request flow: access follows from the agent's project membership, which
 * Paperclip owns, so there is nothing for an agent to request.
 */
const PROFILE_TOOL_NAMES = READ_ONLY_TOOL_NAMES;

interface Readiness {
  enabled: boolean;
  codegraph: { ok: boolean; version: string | null; detail: string };
  /** `required` is true only when a bound repository path is relative. */
  folder: { configured: boolean; alias: string | null; required?: boolean };
  repository: { configured: boolean; key: string | null; indexed: boolean; alias: string | null };
}

/** One credentialed call to the host's own API, as the signed-in board member. */
async function coreApi<T>(
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<T> {
  const response = await fetch(path, {
    method: init?.method ?? "GET",
    credentials: "include",
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  if (!response.ok) {
    const message =
      parsed && typeof parsed === "object" && "error" in parsed
        ? String((parsed as Record<string, unknown>)["error"])
        : `${response.status} ${response.statusText}`;
    throw new Error(message);
  }
  return parsed as T;
}

/**
 * Run one activation step, treating "already exists" as success.
 *
 * Paperclip has no stable conflict code on these routes, so the message decides.
 * Anything unrecognised is rethrown — a real failure must not be reported as a
 * no-op.
 */
async function attempt(fn: () => Promise<unknown>): Promise<StepOutcome> {
  try {
    await fn();
    return "created";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isAlreadyExistsMessage(message)) return "already-existed";
    throw error;
  }
}

export function SettingsPage({ context }: PluginSettingsPageProps) {
  const companyId = context.companyId;

  const { data: readiness, loading: readinessLoading, error: readinessError } =
    usePluginData<Readiness>("readiness");

  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  /**
   * Create the Paperclip objects that make the tools callable.
   *
   * There is deliberately nothing else on this page. There is no repository to
   * choose and no list of agents to tick, because Paperclip already decides both:
   * the repository is the workspace of the project an agent is running in, and
   * which agents may use it follows from who is assigned to that project. Asking
   * here would be a second, parallel authority that could disagree with the
   * first — so the page has no configuration at all.
   */
  const activate = useCallback(async () => {
    if (!companyId) return;
    setBusy("activate");
    setMessage(null);

    const profilesPath = `/api/companies/${companyId}/tools/profiles`;
    const profileBody = {
      profileKey: PROFILE_KEY,
      name: "CodeGraph (read-only)",
      description: "Read-only CodeGraph tools. Every CodeGraph tool is query-only.",
      status: "active",
      defaultAction: "deny",
      entries: PROFILE_TOOL_NAMES.map((toolName) => ({
        selectorType: "tool_name",
        effect: "include",
        toolName: `${PLUGIN_ID}:${toolName}`,
      })),
    };

    try {
      // 1. Profile. On a repeat press this is the step that used to fail, so a
      //    conflict is resolved by reusing the profile this plugin owns rather
      //    than by creating a second one.
      let profileId: string;
      let profileOutcome: StepOutcome;
      try {
        const created = await coreApi<{ id: string }>(profilesPath, {
          method: "POST",
          body: profileBody,
        });
        profileId = created.id;
        profileOutcome = "created";
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!isAlreadyExistsMessage(message)) throw error;
        const listed = await coreApi<unknown>(profilesPath);
        const existingId = findProfileId(listed, PROFILE_KEY);
        if (!existingId) {
          throw new Error(
            `A tool access record named "${PROFILE_KEY}" already exists but could not be found to reuse: ${message}`,
          );
        }
        profileId = existingId;
        profileOutcome = "already-existed";
      }

      // 2. Bind at COMPANY scope on purpose. Paperclip keeps only the narrowest
      //    matching binding tier (narrowestScopeBindings), so an agent-scoped
      //    binding would silently stop the company profile applying to that
      //    agent — granting CodeGraph could revoke their other tools.
      const binding = await attempt(() =>
        coreApi(`${profilesPath}/${profileId}/bind`, {
          method: "POST",
          body: { targetType: "company", targetId: companyId, priority: 100 },
        }),
      );

      // 3. The named MCP gateway. Without one, no agent receives the tools even
      //    with the profile attached and bound.
      const gateway = await attempt(() =>
        coreApi(`/api/companies/${companyId}/tools/gateways`, {
          method: "POST",
          body: { name: GATEWAY_NAME, slug: GATEWAY_SLUG, profileId },
        }),
      );

      const summary: ActivationSummary = {
        profileId,
        profile: profileOutcome,
        binding,
        gateway,
      };
      setMessage({ kind: "ok", text: describeActivation(summary) });
    } catch (error) {
      setMessage({
        kind: "error",
        text: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(null);
    }
  }, [companyId]);

  if (!companyId) {
    return <p style={styles.muted}>Open this page inside a company to configure CodeGraph.</p>;
  }

  return (
    <div style={styles.page}>
      <h2 style={styles.h2}>CodeGraph</h2>
      <p style={styles.muted}>
        Code intelligence for this company&apos;s agents. An agent gets CodeGraph for the
        repository of the Paperclip project it is working in — there is nothing to
        configure here.
      </p>

      <section style={styles.card}>
        <h3 style={styles.h3}>Status</h3>
        {readinessLoading ? (
          <p style={styles.muted}>Checking…</p>
        ) : readinessError ? (
          <p style={styles.bad}>Could not check: {readinessError.message}</p>
        ) : readiness ? (
          <ul style={styles.list}>
            <StatusLine
              ok={readiness.enabled}
              good="CodeGraph is enabled for this company"
              bad="CodeGraph is disabled — turn it on in the Configuration tab above"
            />
            <StatusLine
              ok={readiness.codegraph.ok}
              good={`CodeGraph ${readiness.codegraph.version ?? ""} found`}
              bad={readiness.codegraph.detail}
            />
            <StatusLine
              ok={readiness.repository.indexed}
              good={`Repository "${readiness.repository.alias ?? ""}" is indexed`}
              bad={
                readiness.repository.configured
                  ? `Repository "${readiness.repository.alias ?? ""}" is not indexed yet — enable "Build the index automatically" above, or use Index now`
                  : "No repository yet. One appears once an agent runs in a Paperclip project."
              }
            />
            {readiness.folder.required ? (
              <StatusLine
                ok={readiness.folder.configured}
                good={`Repositories directory: ${readiness.folder.alias ?? ""}`}
                bad='A repository is configured by relative path but no "Repositories directory" is set'
              />
            ) : null}
          </ul>
        ) : null}
      </section>

      <section style={styles.card}>
        <h3 style={styles.h3}>Activate</h3>
        <p style={styles.muted}>
          Creates the Paperclip tool profile and MCP gateway that make the tools callable.
          Safe to run twice.
        </p>
        <div style={styles.row}>
          <button
            style={{ ...styles.button, ...styles.primary }}
            disabled={busy !== null}
            onClick={() => void activate()}
          >
            {busy === "activate" ? "Activating…" : "Activate CodeGraph"}
          </button>
        </div>
      </section>

      {message ? (
        <p style={message.kind === "ok" ? styles.good : styles.bad}>{message.text}</p>
      ) : null}
    </div>
  );
}

function StatusLine({ ok, good, bad }: { ok: boolean; good: string; bad: string }) {
  return (
    <li style={styles.statusRow}>
      <span aria-hidden style={ok ? styles.tick : styles.cross}>
        {ok ? "✓" : "✗"}
      </span>
      <span style={ok ? undefined : styles.muted}>{ok ? good : bad}</span>
    </li>
  );
}

/**
 * Inline styles only. The authoring guide is explicit that a plugin must not
 * import the host's `ui/src` internals, and pulling in a design system would
 * pin this bundle to a Paperclip version it cannot test against.
 */
const styles: Record<string, CSSProperties> = {
  page: { maxWidth: 720, fontFamily: "inherit", color: "inherit" },
  h2: { fontSize: 18, fontWeight: 600, margin: "0 0 4px" },
  h3: { fontSize: 14, fontWeight: 600, margin: "0 0 8px" },
  muted: { color: "var(--muted-foreground, #6b7280)", fontSize: 13 },
  card: {
    border: "1px solid var(--border, #e5e7eb)",
    borderRadius: 8,
    padding: 16,
    marginTop: 16,
  },
  list: { listStyle: "none", padding: 0, margin: "8px 0 0" },
  statusRow: { display: "flex", gap: 8, alignItems: "flex-start", marginBottom: 6, fontSize: 13 },
  checkRow: { marginBottom: 4 },
  checkLabel: { display: "flex", gap: 8, alignItems: "center", fontSize: 13, cursor: "pointer" },
  tick: { color: "var(--success, #16a34a)" },
  cross: { color: "var(--destructive, #dc2626)" },
  good: { color: "var(--success, #16a34a)", fontSize: 13 },
  bad: { color: "var(--destructive, #dc2626)", fontSize: 13 },
  input: {
    width: "100%",
    boxSizing: "border-box",
    padding: "8px 10px",
    borderRadius: 6,
    border: "1px solid var(--border, #e5e7eb)",
    background: "var(--background, transparent)",
    color: "inherit",
    fontSize: 13,
    fontFamily: "inherit",
  },
  row: { display: "flex", gap: 12, alignItems: "center", marginTop: 16 },
  repoRow: { display: "flex", gap: 8, alignItems: "center", marginBottom: 8 },
  iconButton: {
    padding: "6px 10px",
    borderRadius: 6,
    border: "1px solid var(--border, #e5e7eb)",
    background: "transparent",
    color: "inherit",
    fontSize: 12,
    cursor: "pointer",
    fontFamily: "inherit",
    whiteSpace: "nowrap",
  },
  button: {
    padding: "8px 14px",
    borderRadius: 6,
    border: "1px solid var(--border, #e5e7eb)",
    background: "var(--background, transparent)",
    color: "inherit",
    fontSize: 13,
    cursor: "pointer",
    fontFamily: "inherit",
  },
  primary: {
    background: "var(--primary, #111827)",
    color: "var(--primary-foreground, #ffffff)",
    border: "1px solid transparent",
  },
};
