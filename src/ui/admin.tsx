/**
 * CodeGraph's settings, in **Settings → Plugins → CodeGraph**.
 *
 * The host mounts a `settingsPage` slot at
 * `/:companyPrefix/company/settings/instance/plugins/:pluginId` and, when a
 * plugin declares one, uses it *instead of* the auto-generated config form
 * (`ui/src/pages/PluginSettings.tsx`). That is where per-plugin settings belong,
 * so every control the operator has lives here: status, activation, the org's
 * repositories with their index state, and who may use the tools.
 *
 * Nothing in this file can widen access. Repositories follow the agent's
 * Paperclip project, and unticking an agent is the only edit the access section
 * offers — so the worst a mistake here can do is narrow.
 */

import { useCallback, useEffect, useState } from "react";
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
  findGateway,
  findProfileId,
  isAlreadyExistsMessage,
  type ActivationSummary,
  type StepOutcome,
} from "../activation.js";
import { sanitizeErrorMessage } from "../errors.js";
import { readOperatorConfig, mergeOperatorConfig, type OperatorConfig } from "../config.js";
import { StatusLine, styles } from "./chrome.js";
import { useRefreshSignal } from "./refresh.js";
import { ACTION_KEYS, DATA_KEYS } from "../plugin-keys.js";

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

interface AgentRow {
  id: string;
  name: string;
  /** Absent means allowed — the default is on, and switches only narrow. */
  enabled?: boolean;
}

interface RepoRow {
  projectId: string;
  name: string;
  alias: string;
  repoName?: string | null;
  indexed: boolean;
  /** True when an operator has switched CodeGraph off for this repository. */
  blocked?: boolean;
  fileCount?: number | null;
  nodeCount?: number | null;
  lastIndexed?: string | null;
}

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
  const { refresh, revision } = useRefreshSignal();

  const { data: readiness, loading: readinessLoading, error: readinessError } =
    usePluginData<Readiness>(DATA_KEYS.readiness);

  /**
   * The one read of the repositories for this page.
   *
   * The Status section used to take its repository fact from the governance
   * *binding* while the Repositories section took it from the org's actual
   * projects, so the two contradicted each other on screen: "No repository yet"
   * directly above a repository with 640 files and 12,085 nodes. Bindings are an
   * override mechanism, not a declaration of what exists, so Status now reports
   * the same repositories the rest of the page lists.
   */
  const { data: overview, loading: overviewLoading } = usePluginData<{
    organization?: string | null;
    repositories: RepoRow[];
    skippedProjects?: number;
    enabled?: boolean;
  }>(DATA_KEYS.graphProjects, { companyId, revision });

  const organization = overview?.organization ?? null;
  const repositories = overview?.repositories ?? [];
  const indexedCount = repositories.filter((repo) => repo.indexed).length;
  const unavailableCount = repositories.filter((repo) => repo.blocked === true).length;

  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  /**
   * Create the Paperclip objects that make the tools callable.
   *
   * This is board-only work: `POST /tools/profiles` and `POST /tools/gateways`
   * need a board member, and this bundle runs as trusted same-origin code
   * (`PLUGIN_SPEC.md` §23), so the fetch carries the operator's own session.
   * Safe to run twice: a conflict is resolved by reusing the profile and gateway
   * this plugin owns.
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
        const text = error instanceof Error ? error.message : String(error);
        if (!isAlreadyExistsMessage(text)) throw error;
        const listed = await coreApi<unknown>(profilesPath);
        const existingId = findProfileId(listed, PROFILE_KEY);
        if (!existingId) {
          throw new Error(
            `A tool access record named "${PROFILE_KEY}" already exists but could not be found to reuse: ${text}`,
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
      //
      //    Looked up before creating: `(company_id, slug)` is unique, so a second
      //    create is rejected — and the message Paperclip returns for that is a
      //    raw `Failed query: insert into "tool_mcp_gateways" …` carrying none of
      //    the words a conflict classifier looks for. Looking the gateway up is
      //    both correct and free of message-parsing.
      let gateway: StepOutcome;
      let existingGateway: { id: string; profileId: string | null } | null = null;
      try {
        existingGateway = findGateway(
          await coreApi<unknown>(`/api/companies/${companyId}/tools/gateways`),
          GATEWAY_SLUG,
        );
      } catch {
        // No permission to list, or a shape we do not recognise: fall through to
        // creating, which is what the previous version did unconditionally.
        existingGateway = null;
      }

      if (!existingGateway) {
        gateway = await attempt(() =>
          coreApi(`/api/companies/${companyId}/tools/gateways`, {
            method: "POST",
            body: { name: GATEWAY_NAME, slug: GATEWAY_SLUG, profileId },
          }),
        );
      } else if (existingGateway.profileId !== null && existingGateway.profileId !== profileId) {
        // The gateway exists but points at a different profile — converge it on
        // the one this plugin owns, rather than leaving a stale pointer.
        await coreApi(`/api/tool-gateway/gateways/${existingGateway.id}`, {
          method: "PATCH",
          body: { companyId, profileId },
        });
        gateway = "repointed";
      } else {
        gateway = "already-existed";
      }

      const summary: ActivationSummary = { profileId, profile: profileOutcome, binding, gateway };
      setMessage({ kind: "ok", text: describeActivation(summary) });
    } catch (error) {
      setMessage({
        kind: "error",
        // Sanitised at the display boundary only: the classification above needs
        // the raw text, but a board member must never be shown raw SQL and its
        // bound parameters.
        text: sanitizeErrorMessage(error),
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
      <h2 style={styles.h2}>
        CodeGraph{organization ? ` · ${organization}` : context.companyPrefix ? ` · ${context.companyPrefix}` : ""}
      </h2>
      <p style={styles.muted}>
        Code intelligence for this organization&apos;s agents. An agent gets CodeGraph for
        the repository of the Paperclip project it is working in.
      </p>

      <section style={styles.card}>
        <h3 style={styles.h3}>Status</h3>
        {readinessLoading || (overviewLoading && !overview) ? (
          <p style={styles.muted}>Checking…</p>
        ) : readinessError ? (
          <p style={styles.bad}>Could not check: {sanitizeErrorMessage(readinessError)}</p>
        ) : readiness ? (
          <ul style={styles.list}>
            <StatusLine
              ok={readiness.enabled}
              good="CodeGraph is enabled for this company"
              bad="CodeGraph is disabled — turn it on under Configuration below"
            />
            <StatusLine
              ok={readiness.codegraph.ok}
              good={`CodeGraph ${readiness.codegraph.version ?? ""} found`}
              bad={readiness.codegraph.detail}
            />
            {/*
              The repository line reports what this org actually has, from the
              same read the Repositories section below uses. It previously
              reported the governance *binding*, which is empty on an org that is
              working fine — so it claimed no repository existed above a list of
              one.
            */}
            <StatusLine
              ok={repositories.length > 0 && indexedCount > 0}
              good={
                repositories.length === 1
                  ? `1 repository, ${indexedCount === 1 ? "indexed" : "not indexed yet"}`
                  : `${repositories.length} repositories, ${indexedCount} indexed`
              }
              bad={
                repositories.length === 0
                  ? "No repository yet. One appears once a project in this organization has a repository workspace."
                  : `${repositories.length} repositor${repositories.length === 1 ? "y" : "ies"}, none indexed yet — use Index now below`
              }
            />
            {unavailableCount > 0 ? (
              <StatusLine
                ok={false}
                good=""
                bad={`${unavailableCount} repositor${unavailableCount === 1 ? "y is" : "ies are"} switched off for this organization`}
              />
            ) : null}
          </ul>
        ) : null}
        <div style={styles.row}>
          <button style={styles.iconButton} onClick={refresh}>
            Refresh
          </button>
          <span style={styles.hintInline}>
            Re-reads repositories, agents and index state. Also happens when you return to this tab.
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

      <Configuration companyId={companyId} onMessage={setMessage} />
      <RepositoryAccess
        companyId={companyId}
        onMessage={setMessage}
        revision={revision}
        onChanged={refresh}
      />
      <Indexing
        companyId={companyId}
        onMessage={setMessage}
        revision={revision}
        onChanged={refresh}
      />
      <AgentExceptions
        companyId={companyId}
        onMessage={setMessage}
        revision={revision}
        onChanged={refresh}
      />

      {message ? (
        <p style={message.kind === "ok" ? styles.good : styles.bad}>{message.text}</p>
      ) : null}
    </div>
  );
}

/**
 * The operator's config, which this page has to own.
 *
 * The host mounts a `settingsPage` slot **instead of** its auto-generated config
 * form, not alongside it (`ui/src/pages/PluginSettings.tsx`: `hasCustomSettingsPage
 * ? <PluginSlotMount/> : hasConfigSchema ? <PluginConfigForm/> : …`). So a plugin
 * that declares one takes responsibility for the whole Configuration tab —
 * including the fields the operator had before. Leaving this out would not have
 * hidden the form; it would have silently removed the ability to turn CodeGraph on.
 *
 * The five fields are the closed `instanceConfigSchema`; saving merges into the
 * stored document so nothing outside this form is dropped.
 */
function Configuration({
  companyId,
  onMessage,
}: {
  companyId: string;
  onMessage: (message: { kind: "ok" | "error"; text: string } | null) => void;
}) {
  const path = `/api/plugins/${PLUGIN_ID}/config?companyId=${encodeURIComponent(companyId)}`;

  const [stored, setStored] = useState<Record<string, unknown> | null>(null);
  const [draft, setDraft] = useState<OperatorConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    coreApi<{ configJson?: unknown } | null>(path)
      .then((response) => {
        if (cancelled) return;
        const document =
          response && typeof response === "object" && "configJson" in response
            ? (response as { configJson?: unknown }).configJson
            : response;
        setStored(
          typeof document === "object" && document !== null && !Array.isArray(document)
            ? (document as Record<string, unknown>)
            : {},
        );
        setDraft(readOperatorConfig(document));
        setFailure(null);
      })
      .catch((error) => {
        if (cancelled) return;
        setFailure(sanitizeErrorMessage(error));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  const save = useCallback(async () => {
    if (!draft) return;
    setBusy(true);
    onMessage(null);
    try {
      const configJson = mergeOperatorConfig(stored, draft);
      await coreApi(`/api/plugins/${PLUGIN_ID}/config`, {
        method: "POST",
        body: { companyId, configJson },
      });
      // Re-seed from what was written, so a later save merges against the truth
      // rather than against a stale read.
      setStored(configJson);
      onMessage({ kind: "ok", text: "Configuration saved." });
    } catch (error) {
      onMessage({ kind: "error", text: sanitizeErrorMessage(error) });
    } finally {
      setBusy(false);
    }
  }, [companyId, draft, onMessage, stored]);

  if (loading && !draft) {
    return (
      <section style={styles.card}>
        <h3 style={styles.h3}>Configuration</h3>
        <p style={styles.muted}>Loading…</p>
      </section>
    );
  }

  if (!draft) {
    return (
      <section style={styles.card}>
        <h3 style={styles.h3}>Configuration</h3>
        <p style={styles.bad}>
          Could not read the configuration{failure ? `: ${failure}` : ""}. CodeGraph stays on
          whatever is stored — nothing was changed.
        </p>
      </section>
    );
  }

  const bound = boundsSummary(draft);

  return (
    <section style={styles.card}>
      <h3 style={styles.h3}>Configuration</h3>
      <p style={styles.muted}>
        What this plugin may do on this instance. Saved separately for each company.
      </p>

      <div style={styles.field}>
        <label style={styles.checkLabel}>
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
          />
          <span>
            <strong>Enable CodeGraph</strong>
          </span>
        </label>
        <p style={styles.hint}>
          Turn CodeGraph tools on for this company. While off, every CodeGraph call is denied.
        </p>
      </div>

      <div style={styles.field}>
        <label style={styles.checkLabel}>
          <input
            type="checkbox"
            checked={draft.autoInstall}
            onChange={(event) => setDraft({ ...draft, autoInstall: event.target.checked })}
          />
          <span>
            <strong>Install CodeGraph automatically</strong>
          </span>
        </label>
        <p style={styles.hint}>
          Install CodeGraph on the server if it is missing. Off: you must install it yourself.
        </p>
      </div>

      <div style={styles.field}>
        <label style={styles.checkLabel}>
          <input
            type="checkbox"
            checked={draft.autoIndex}
            onChange={(event) => setDraft({ ...draft, autoIndex: event.target.checked })}
          />
          <span>
            <strong>Build the index automatically</strong>
          </span>
        </label>
        <p style={styles.hint}>
          Index a repository the first time it is queried. Off: run <code>codegraph init</code>{" "}
          yourself, or use Index now below.
        </p>
      </div>

      <div style={styles.field}>
        <label style={styles.fieldLabel} htmlFor="codegraph-command">
          CodeGraph executable
        </label>
        <input
          id="codegraph-command"
          style={styles.input}
          value={draft.codegraphCommand}
          onChange={(event) => setDraft({ ...draft, codegraphCommand: event.target.value })}
        />
        <p style={styles.hint}>
          Set an absolute path if CodeGraph is not on the server&apos;s PATH. Default{" "}
          <code>codegraph</code>.
        </p>
      </div>

      <div style={styles.field}>
        <label style={styles.fieldLabel} htmlFor="codegraph-roots">
          Safety boundary: directories CodeGraph may read
        </label>
        <textarea
          id="codegraph-roots"
          style={styles.textarea}
          rows={3}
          value={draft.allowedProjectRoots.join("\n")}
          placeholder="Leave empty unless more than one organization shares this server"
          onChange={(event) =>
            setDraft({
              ...draft,
              // One per line: a path picker would be a second authority over
              // something Paperclip already owns, and these are containment
              // roots, not repository choices.
              allowedProjectRoots: event.target.value
                .split("\n")
                .map((line) => line.trim())
                .filter((line) => line.length > 0),
            })
          }
        />
        <p style={styles.hint}>
          <strong>What it is:</strong> a ceiling on where this plugin may look for code on
          the server. Any repository outside these directories is refused, even if an agent
          is working in it. It is not a list of repositories — those are detected from
          Paperclip projects, and there is nothing to add here for them.
        </p>
        <p style={styles.hint}>
          <strong>Why it exists:</strong> the plugin runs on the Paperclip host and can read
          files. With the box empty it will read whichever repository a project points at,
          anywhere on the disk. Setting one directory per tenant keeps one organization&apos;s
          CodeGraph from reaching another&apos;s code — {bound}.
        </p>
        <p style={styles.hint}>
          <strong>When to set it:</strong> if more than one organization shares this Paperclip
          instance. On a single-tenant instance, leave it empty.
        </p>
      </div>

      <div style={styles.row}>
        <button
          style={{ ...styles.button, ...styles.primary }}
          disabled={busy}
          onClick={() => void save()}
        >
          {busy ? "Saving…" : "Save configuration"}
        </button>
        <button
          style={styles.button}
          disabled={busy}
          onClick={() => setDraft(readOperatorConfig(stored))}
        >
          Reset
        </button>
      </div>
    </section>
  );
}

/** A one-line summary of what the current roots actually mean. */
function boundsSummary(draft: OperatorConfig): string {
  return draft.allowedProjectRoots.length === 0
    ? "with none set, a repository may live anywhere"
    : `${draft.allowedProjectRoots.length} root${
        draft.allowedProjectRoots.length === 1 ? "" : "s"
      } configured`;
}

/**
 * This org's repositories with their index state, and the two index actions.
 *
 * `repositories` reports file and node counts, which means it runs
 * `codegraph status` per repository — correct here, where an operator is
 * looking at index health, and deliberately not what the sidebar uses.
 */
function Indexing({
  companyId,
  onMessage,
  revision,
  onChanged,
}: {
  companyId: string;
  onMessage: (message: { kind: "ok" | "error"; text: string } | null) => void;
  /** Bumped when the page wants a re-read, e.g. on returning to the tab. */
  revision: number;
  /** Bump to make the whole page re-read after a change. */
  onChanged: () => void;
}) {
  const { data: repos, loading, refresh } = usePluginData<{ repositories: RepoRow[] }>(
    DATA_KEYS.repositories,
    { companyId, revision },
  );
  const indexNow = usePluginAction(ACTION_KEYS.indexNow);
  const [busy, setBusy] = useState<string | null>(null);

  const run = useCallback(
    async (projectId: string, reindex: boolean) => {
      setBusy(`${projectId}:${reindex ? "rebuild" : "index"}`);
      onMessage(null);
      try {
        await indexNow({ companyId, projectId, reindex });
        // The counts and the index state are wrong the instant this returns, so
        // re-read rather than telling the operator to reopen the page.
        refresh();
        onChanged();
        onMessage({
          kind: "ok",
          text: reindex
            ? "Rebuild finished. Counts below are updated."
            : "Indexed. Counts below are updated.",
        });
      } catch (error) {
        onMessage({ kind: "error", text: sanitizeErrorMessage(error) });
      } finally {
        setBusy(null);
      }
    },
    [companyId, indexNow, onChanged, onMessage, refresh],
  );

  const repositories = repos?.repositories ?? [];

  return (
    <section style={styles.card}>
      <h3 style={styles.h3}>Indexing</h3>
      <p style={styles.muted}>
        The index is what the graph and the tools read — a repository with no index answers
        nothing, however many tools are enabled. Building one is explicit because it reads
        the whole repository.
      </p>
      {loading && repositories.length === 0 ? (
        <p style={styles.muted}>Loading…</p>
      ) : repositories.length === 0 ? (
        <p style={styles.muted}>
          No repositories yet. One appears once a project in this company has a workspace.
        </p>
      ) : (
        repositories.map((repo) => (
          <div key={repo.projectId} style={styles.repoCard}>
            <div style={styles.repoHead}>
              <strong>{repo.name}</strong>
              <span style={repo.indexed ? styles.good : styles.bad}>
                {repo.indexed
                  ? `${repo.fileCount ?? "?"} files · ${repo.nodeCount ?? "?"} nodes`
                  : "Not indexed"}
              </span>
            </div>
            <div style={styles.row}>
              <button
                style={styles.button}
                disabled={busy !== null}
                onClick={() => void run(repo.projectId, false)}
              >
                {busy === `${repo.projectId}:index` ? "Indexing…" : "Index now"}
              </button>
              <button
                style={styles.button}
                disabled={busy !== null}
                onClick={() => void run(repo.projectId, true)}
              >
                {busy === `${repo.projectId}:rebuild` ? "Rebuilding…" : "Rebuild"}
              </button>
            </div>
          </div>
        ))
      )}
    </section>
  );
}

/**
 * The primary access control: which of this org's repositories CodeGraph may read.
 *
 * This exists because gating by agent was the wrong primary. An agent's reach
 * already follows the Paperclip project it is working in — that is the
 * organisational fact, and it changes when someone changes team. An agent list is
 * a copy of that fact which does not update when the fact does, so access
 * outlives the reason it was granted. A repository switch is derived from work
 * the operator already did in Paperclip, and cannot drift.
 *
 * It also scales: this org has ~77 agents and two repositories.
 */
function RepositoryAccess({
  companyId,
  onMessage,
  revision,
  onChanged,
}: {
  companyId: string;
  onMessage: (message: { kind: "ok" | "error"; text: string } | null) => void;
  /** Bumped when the page wants a re-read, e.g. on returning to the tab. */
  revision: number;
  /** Bump to make the whole page re-read after a change. */
  onChanged: () => void;
}) {
  const { data, loading, refresh } = usePluginData<{
    organization?: string | null;
    repositories: RepoRow[];
    skippedProjects?: number;
    detail?: string;
  }>(DATA_KEYS.graphProjects, { companyId, revision });
  const setRepositoryAccess = usePluginAction(ACTION_KEYS.setRepositoryAccess);
  const [busy, setBusy] = useState<string | null>(null);

  const repositories = data?.repositories ?? [];

  const toggle = useCallback(
    async (projectId: string, blocked: boolean) => {
      setBusy(projectId);
      onMessage(null);
      try {
        await setRepositoryAccess({ companyId, projectId, blocked });
        // Re-read here for this section, and tell the page so Status agrees.
        refresh();
        onChanged();
        onMessage({
          kind: "ok",
          text: blocked
            ? "CodeGraph is now off for that repository. Agents working in it get no CodeGraph tools."
            : "CodeGraph is available for that repository again.",
        });
      } catch (error) {
        onMessage({ kind: "error", text: sanitizeErrorMessage(error) });
      } finally {
        setBusy(null);
      }
    },
    [companyId, onChanged, onMessage, refresh, setRepositoryAccess],
  );

  const skipped = data?.skippedProjects ?? 0;

  return (
    <section style={styles.card}>
      <h3 style={styles.h3}>Repositories</h3>
      <p style={styles.muted}>
        The repositories this organization may read. Availability follows the Paperclip
        project an agent is working in, so it is set per repository rather than per agent:
        switching one off is the one edit here, and it can only narrow.
      </p>
      {loading && repositories.length === 0 ? (
        <p style={styles.muted}>Loading…</p>
      ) : repositories.length === 0 ? (
        <p style={styles.muted}>
          {data?.detail ??
            "No repositories yet. One appears once a project in this company has a repository workspace."}
        </p>
      ) : (
        <ul style={styles.list}>
          {repositories.map((repo) => (
            <li key={repo.projectId} style={styles.checkRow}>
              <label style={styles.checkLabel}>
                <input
                  type="checkbox"
                  // Checked means available, so the box reads as "CodeGraph here".
                  checked={repo.blocked !== true}
                  disabled={busy !== null}
                  onChange={(event) => void toggle(repo.projectId, !event.target.checked)}
                />
                <span>
                  {repo.name}
                  {repo.repoName && repo.repoName !== repo.name ? (
                    <span style={styles.hintInline}> ({repo.repoName})</span>
                  ) : null}
                  {repo.indexed ? null : (
                    <span style={styles.hintInline}> — not indexed yet</span>
                  )}
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}
      {skipped > 0 ? (
        <p style={styles.hint}>
          {skipped} other project{skipped === 1 ? "" : "s"} in this organization {skipped === 1 ? "is" : "are"}{" "}
          not listed: {skipped === 1 ? "it has" : "they have"} no repository workspace, so there is
          nothing for CodeGraph to read.
        </p>
      ) : null}
    </section>
  );
}

/**
 * Per-agent exceptions.
 *
 * Deliberately secondary, and collapsed by default. Agents already reach the
 * repositories their projects use, so there is nothing to grant here — this is
 * for revoking for one agent in the cases the derived rules cannot express, such
 * as a contractor whose access should not follow their project membership.
 *
 * Kept as an explicit list rather than removed, because "revoke for one agent"
 * is a real need; kept demoted because presenting it as the main control implied
 * that access is granted by ticking, and it never was: Paperclip denies these
 * tools by default until a tool profile allows them.
 */
function AgentExceptions({
  companyId,
  onMessage,
  revision,
  onChanged,
}: {
  companyId: string;
  onMessage: (message: { kind: "ok" | "error"; text: string } | null) => void;
  /** Bumped when the page wants a re-read, e.g. on returning to the tab. */
  revision: number;
  /** Bump to make the whole page re-read after a change. */
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const { data: access, refresh: refreshAccess } = usePluginData<{
    agents: AgentRow[];
    toolCount: number;
  }>(DATA_KEYS.access, { companyId, revision });
  const { data: agents } = usePluginData<{ agents: AgentRow[] }>(DATA_KEYS.agents, {
    companyId,
    revision,
  });
  const setAgentAccess = usePluginAction(ACTION_KEYS.setAgentAccess);

  const rows = access?.agents ?? agents?.agents ?? [];
  const [busy, setBusy] = useState<string | null>(null);

  const revokedCount = rows.filter((agent) => agent.enabled === false).length;

  const toggle = useCallback(
    async (agentId: string, enabled: boolean) => {
      setBusy(agentId);
      onMessage(null);
      try {
        await setAgentAccess({ companyId, agentId, enabled });
        refreshAccess();
        onMessage({
          kind: "ok",
          text: enabled ? "Access restored for that agent." : "Access revoked for that agent.",
        });
      } catch (error) {
        onMessage({ kind: "error", text: sanitizeErrorMessage(error) });
      } finally {
        setBusy(null);
      }
    },
    [companyId, onMessage, refreshAccess, setAgentAccess],
  );

  return (
    <section style={styles.card}>
      <h3 style={styles.h3}>Exceptions</h3>
      <p style={styles.muted}>
        Every agent reaches the repositories its projects use. This is only for taking that
        away from a specific agent
        {revokedCount > 0 ? ` — ${revokedCount} currently revoked` : ""}. Nothing here can
        grant access, so there is nothing to configure unless you need an exception.
      </p>

      <button style={styles.button} onClick={() => setOpen((value) => !value)}>
        {open ? "Hide agents" : `Show ${rows.length} agents`}
      </button>

      {open ? (
        rows.length > 0 ? (
          <ul style={styles.list}>
            {rows.map((agent) => (
              <li key={agent.id} style={styles.checkRow}>
                <label style={styles.checkLabel}>
                  <input
                    type="checkbox"
                    // Checked means the agent still has access. Absent override
                    // means allowed, so the default must read as on.
                    checked={agent.enabled !== false}
                    disabled={busy !== null}
                    onChange={(event) => void toggle(agent.id, event.target.checked)}
                  />
                  {agent.name}
                </label>
              </li>
            ))}
          </ul>
        ) : (
          <p style={styles.muted}>No agents in this company yet.</p>
        )
      ) : null}
    </section>
  );
}

export type { AgentRow, Readiness, RepoRow };
