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

import { mergeGovernance, type RepositoryRow } from "../governance/merge.js";
import type { CompanyGovernance } from "../governance/types.js";

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
 * What goes into the Paperclip profile.
 *
 * `codegraph_request_access` is included deliberately: it is the one tool not
 * gated by CodeGraph governance, so a denied agent can still ask for access. If
 * it is missing from the profile, the request flow is unreachable and a denied
 * agent has no way to become an allowed one.
 */
const PROFILE_TOOL_NAMES = [...READ_ONLY_TOOL_NAMES, "codegraph_request_access"];

interface Readiness {
  enabled: boolean;
  codegraph: { ok: boolean; version: string | null; detail: string };
  /** `required` is true only when a bound repository path is relative. */
  folder: { configured: boolean; alias: string | null; required?: boolean };
  repository: { configured: boolean; key: string | null; indexed: boolean; alias: string | null };
}

interface GovernanceSummary {
  companies: Record<
    string,
    {
      enabled: boolean;
      defaultProjectKey: string | null;
      projectKeys: string[];
      agentOverrides: string[];
    }
  >;
}

interface AgentRow {
  id: string;
  name: string;
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

export function SettingsPage({ context }: PluginSettingsPageProps) {
  const companyId = context.companyId;

  const { data: readiness, loading: readinessLoading, error: readinessError } =
    usePluginData<Readiness>("readiness");
  const { data: agentsData } = usePluginData<{ agents: AgentRow[] }>("agents");

  const getGovernance = usePluginAction("get-governance");
  const setGovernance = usePluginAction("set-company-governance");

  const [rows, setRows] = useState<RepositoryRow[]>([]);
  const [removedKeys, setRemovedKeys] = useState<string[]>([]);
  const [granted, setGranted] = useState<Record<string, boolean>>({});
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const agentList = useMemo(() => agentsData?.agents ?? [], [agentsData]);

  /**
   * Load the company's current governance once.
   *
   * The form is seeded from real state rather than starting empty, and Save
   * re-reads it before merging — so a stale form can never clobber a change
   * somebody else made in the meantime.
   */
  useEffect(() => {
    if (!companyId || loaded || !agentsData) return;
    let cancelled = false;
    void (async () => {
      try {
        const result = (await getGovernance({ companyId })) as {
          governance: CompanyGovernance | null;
        };
        if (cancelled) return;
        const current = result?.governance ?? null;
        setRows(
          Object.values(current?.projects ?? {}).map((binding) => ({
            key: binding.projectKey,
            path: binding.path,
          })),
        );
        const overrides = current?.agents ?? {};
        const hasOverrides = Object.keys(overrides).length > 0;
        const seed: Record<string, boolean> = {};
        for (const agent of agentList) {
          // A company with no overrides yet grants everybody: this page is an
          // explicit opt-in, and defaulting to deny-everyone would make a first
          // run look broken.
          seed[agent.id] = hasOverrides ? overrides[agent.id]?.enabled !== false : true;
        }
        setGranted(seed);
        setLoaded(true);
      } catch (error) {
        if (!cancelled) {
          setMessage({
            kind: "error",
            text: error instanceof Error ? error.message : String(error),
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [agentList, agentsData, companyId, getGovernance, loaded]);

  const save = useCallback(async () => {
    if (!companyId) return;
    setBusy("saving");
    setMessage(null);
    try {
      // Re-read, then merge. The merge is the only thing allowed to decide what
      // disappears, and it deletes nothing the operator did not remove.
      const result = (await getGovernance({ companyId })) as {
        governance: CompanyGovernance | null;
      };
      const merged = mergeGovernance(
        result?.governance ?? null,
        {
          repositories: rows,
          removedRepositoryKeys: removedKeys,
          grantedAgentIds: agentList.filter((agent) => granted[agent.id]).map((a) => a.id),
          listedAgentIds: agentList.map((a) => a.id),
        },
        { defaultAllowedTools: READ_ONLY_TOOL_NAMES },
      );
      await setGovernance({ companyId, governance: merged });
      setRemovedKeys([]);
      setMessage({ kind: "ok", text: "Saved. Click Activate to grant the tools to Paperclip." });
    } catch (error) {
      setMessage({
        kind: "error",
        text: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(null);
    }
  }, [agentList, companyId, getGovernance, granted, removedKeys, rows, setGovernance]);

  /** Create the Paperclip objects that make the tools callable. */
  const activate = useCallback(async () => {
    if (!companyId) return;
    setBusy("activate");
    setMessage(null);
    try {
      const profile = await coreApi<{ id: string }>(
        `/api/companies/${companyId}/tools/profiles`,
        {
          method: "POST",
          body: {
            profileKey: "codegraph-read",
            name: "CodeGraph (read-only)",
            description: "Read-only CodeGraph tools. Every CodeGraph tool is query-only.",
            status: "active",
            defaultAction: "deny",
            entries: PROFILE_TOOL_NAMES.map((toolName) => ({
              selectorType: "tool_name",
              effect: "include",
              toolName: `${PLUGIN_ID}:${toolName}`,
            })),
          },
        },
      );

      // Bound at COMPANY scope on purpose. Paperclip keeps only the narrowest
      // matching binding tier (narrowestScopeBindings), so an agent-scoped
      // binding would silently stop the company profile applying to that agent —
      // granting CodeGraph could revoke their other tools. Per-agent restriction
      // is done in the plugin's own governance above, which narrows without
      // replacing.
      await coreApi(`/api/companies/${companyId}/tools/profiles/${profile.id}/bind`, {
        method: "POST",
        body: { targetType: "company", targetId: companyId, priority: 100 },
      });

      await coreApi(`/api/companies/${companyId}/tools/gateways`, {
        method: "POST",
        body: { name: "CodeGraph", slug: "codegraph", profileId: profile.id },
      });

      setMessage({
        kind: "ok",
        text: "Activated. Agents on CodeGraph now receive the tools on their next run.",
      });
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
        Code intelligence for this company&apos;s agents, scoped to the repositories you choose.
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
            {readiness.folder.configured || readiness.folder.required ? (
              <StatusLine
                ok={readiness.folder.configured}
                good={`Repositories directory: ${readiness.folder.alias ?? ""}`}
                bad='Repositories are named relative to a directory that is not set — open the "Repositories directory" setting above, or give absolute paths below'
              />
            ) : null}
            <StatusLine
              ok={readiness.repository.indexed}
              good={`Repository "${readiness.repository.alias ?? ""}" is indexed`}
              bad={
                readiness.repository.configured
                  ? `Repository "${readiness.repository.alias ?? ""}" is not indexed yet — enable "Build the index automatically" above, or run codegraph init`
                  : "No repository bound yet — add one below"
              }
            />
          </ul>
        ) : null}
      </section>

      <section style={styles.card}>
        <h3 style={styles.h3}>Repositories</h3>
        <p style={styles.muted}>
          Every repository this company may read. A bare name is resolved inside your
          repositories directory; an absolute path is used as given.
        </p>
        {rows.length === 0 ? (
          <p style={styles.muted}>None yet.</p>
        ) : (
          rows.map((row, index) => (
            <div key={`${row.key}-${index}`} style={styles.repoRow}>
              <input
                style={styles.input}
                value={row.path}
                aria-label="Repository"
                placeholder="pos"
                onChange={(event) => {
                  const path = event.target.value;
                  setRows((current) =>
                    current.map((entry, i) =>
                      i === index ? { key: path.trim() || entry.key, path } : entry,
                    ),
                  );
                }}
              />
              <button
                style={styles.iconButton}
                aria-label={`Remove ${row.path || "repository"}`}
                onClick={() => {
                  setRemovedKeys((current) => [...current, row.key]);
                  setRows((current) => current.filter((_, i) => i !== index));
                }}
              >
                Remove
              </button>
            </div>
          ))
        )}
        <button
          style={{ ...styles.button, marginTop: 8 }}
          onClick={() => setRows((current) => [...current, { key: "", path: "" }])}
        >
          Add repository
        </button>
      </section>

      <section style={styles.card}>
        <h3 style={styles.h3}>Who may use it</h3>
        <p style={styles.muted}>
          Tick the agents that may call CodeGraph for this company. Unticked agents are
          denied; tie-breaks and other agents&apos; settings are left untouched.
        </p>
        {agentList.length > 0 ? (
          <ul style={styles.list}>
            {agentList.map((agent) => (
              <li key={agent.id} style={styles.checkRow}>
                <label style={styles.checkLabel}>
                  <input
                    type="checkbox"
                    checked={granted[agent.id] ?? false}
                    onChange={(event) =>
                      setGranted((current) => ({ ...current, [agent.id]: event.target.checked }))
                    }
                  />
                  {agent.name}
                </label>
              </li>
            ))}
          </ul>
        ) : (
          <p style={styles.muted}>No agents in this company yet.</p>
        )}
        <div style={styles.row}>
          <button style={styles.button} disabled={busy !== null} onClick={() => void save()}>
            {busy === "saving" ? "Saving…" : "Save"}
          </button>
          <span style={styles.muted}>
            Saving never clears a tool denial or another repository.
          </span>
        </div>
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
