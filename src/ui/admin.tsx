/**
 * CodeGraph's settings, following the structure of Paperclip's own General
 * settings page.
 *
 * The shape is taken from `ui/src/pages/InstanceGeneralSettings.tsx` rather than
 * invented, because a plugin page that invents its own layout reads as unfinished
 * next to the app around it:
 *
 *   - a `max-w-4xl` column of spaced sections, one idea each;
 *   - a section is a `text-sm font-semibold` heading and a short muted sentence
 *     saying what it does;
 *   - a setting is saved by a **switch that writes immediately**, right-aligned
 *     beside its text — no Save button, because General settings has none and a
 *     form that needs saving is one that can be abandoned half-changed;
 *   - a text field with a Save button only where a value genuinely needs typing;
 *   - a failure is one destructive-tinted banner, not a scattered message.
 *
 * The copy is deliberately plain. "Availability follows the Paperclip project an
 * agent is working in, so this is set per repository rather than per agent" was
 * accurate and unreadable; it now says what happens, and what the switch does.
 */

import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import {
  usePluginAction,
  usePluginData,
  usePluginToast,
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
import { operatorConfigForSave, readOperatorConfig, type OperatorConfig } from "../config.js";
import { StatusLine, styles, thumbTransform } from "./chrome.js";
import { useRefreshSignal } from "./refresh.js";
import { ACTION_KEYS, DATA_KEYS } from "../plugin-keys.js";

/** Must match the manifest id; the host namespaces tools with it. */
const PLUGIN_ID = "paperclip-codegraph";

const TOOL_NAMES = [
  "explore",
  "search",
  "callers",
  "callees",
  "impact",
  "node",
  "status",
  "files",
].map((name) => `codegraph_${name}`);

interface AgentRow {
  id: string;
  name: string;
  enabled?: boolean;
  mcpClientLoaded?: boolean;
  mcpConfigPassed?: boolean;
}

interface RepoRow {
  projectId: string;
  /**
   * Which repository inside the project. `""` is the project's own checkout, and
   * a name like `vroomy-backend` is one of several under the same project folder.
   * It is what every action sends back, so a row identifies a repository and not
   * just a project.
   */
  repositoryKey: string;
  name: string;
  /** The project's name, so a repository can say which project it belongs to. */
  projectName?: string | null;
  alias: string;
  repoName?: string | null;
  indexed: boolean;
  blocked?: boolean;
  fileCount?: number | null;
  nodeCount?: number | null;
}

/** Stable identity of one row: a project can hold more than one repository. */
function repoId(repo: RepoRow): string {
  return `${repo.projectId}:${repo.repositoryKey}`;
}

/**
 * The aside on a row: whichever of the two names is not already the title.
 *
 * One checkout is titled after its project, so the aside is the repository. Six
 * checkouts cannot be, so they are titled after themselves and the aside is the
 * project they share — which is the only thing that tells them apart from another
 * project's repositories.
 */
function repoAside(repo: RepoRow): string | null {
  const aside = repo.name === repo.projectName ? repo.repoName : repo.projectName;
  return aside && aside !== repo.name ? aside : null;
}

interface Readiness {
  enabled: boolean;
  codegraph: { ok: boolean; version: string | null; detail: string };
  repository: { configured: boolean; indexed: boolean; alias: string | null };
}

type Tone = "success" | "error" | "warn";
type Notify = (text: string, tone: Tone) => void;

/** One credentialed call to the host's own API, as the signed-in board member. */
async function coreApi<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
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
  const { refresh, revision } = useRefreshSignal();
  const toast = usePluginToast();

  const { data: readiness, loading: readinessLoading, error: readinessError } =
    usePluginData<Readiness>(DATA_KEYS.readiness);

  const { data: overview, loading: overviewLoading } = usePluginData<{
    organization?: string | null;
    repositories: RepoRow[];
    skippedProjects?: number;
  }>(DATA_KEYS.graphProjects, { companyId, revision });

  const notify: Notify = useCallback(
    (text, tone) => toast({ title: "CodeGraph", body: text, tone }),
    [toast],
  );

  if (!companyId) {
    return (
      <div style={styles.page}>
        <p style={styles.body}>Open this page inside an organization to configure CodeGraph.</p>
      </div>
    );
  }

  const loading = readinessLoading || (overviewLoading && !overview);
  const repositories = overview?.repositories ?? [];
  const indexed = repositories.filter((repo) => repo.indexed).length;

  return (
    <div style={styles.page}>
      <header style={styles.title}>
        <h1 style={styles.h1}>
          CodeGraph{overview?.organization ? ` · ${overview.organization}` : ""}
        </h1>
        <p style={styles.lead}>
          Code intelligence for your agents. They read the code of the Paperclip project they are
          working in.
        </p>
      </header>

      {readinessError ? (
        <div style={styles.errorBanner}>
          Could not read the current state: {sanitizeErrorMessage(readinessError)}
        </div>
      ) : null}

      <Section title="Status" description="What this organization has right now.">
        {loading ? (
          <p style={styles.muted}>Checking…</p>
        ) : (
          <ul style={styles.list}>
            <StatusLine
              ok={readiness?.enabled === true}
              good="CodeGraph is on for this organization"
              bad="CodeGraph is off — switch it on below"
            />
            <StatusLine
              ok={readiness?.codegraph.ok === true}
              good={`CodeGraph ${readiness?.codegraph.version ?? ""} found`}
              bad={readiness?.codegraph.detail ?? "CodeGraph was not found"}
            />
            <StatusLine
              ok={indexed > 0}
              good={
                repositories.length === 1
                  ? `1 repository · ${indexed === 1 ? "indexed" : "not indexed"}`
                  : `${repositories.length} repositories · ${indexed} indexed`
              }
              bad={
                repositories.length === 0
                  ? "No repository yet — one appears when a project here has a workspace"
                  : "No index yet — build one below"
              }
            />
          </ul>
        )}
      </Section>

      <Configuration companyId={companyId} onSaved={refresh} onMessage={notify} />
      <Activate companyId={companyId} onMessage={notify} />
      <Repositories
        companyId={companyId}
        revision={revision}
        onChanged={refresh}
        onMessage={notify}
      />
      <Indexing companyId={companyId} revision={revision} onChanged={refresh} onMessage={notify} />
      <Exceptions
        companyId={companyId}
        revision={revision}
        onChanged={refresh}
        onMessage={notify}
        enabled={readiness?.enabled === true}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Layout pieces
// ---------------------------------------------------------------------------

/** A heading, a sentence, and its controls. One idea per section. */
function Section({
  title,
  description,
  children,
  control,
}: {
  title: string;
  description: string;
  children?: ReactNode;
  control?: ReactNode;
}) {
  return (
    <section style={styles.section}>
      <div style={control ? styles.sectionSplit : styles.sectionStack}>
        <div style={styles.sectionText}>
          <h2 style={styles.h2}>{title}</h2>
          <p style={styles.body}>{description}</p>
        </div>
        {control}
      </div>
      {children ? <div style={styles.sectionBody}>{children}</div> : null}
    </section>
  );
}

/**
 * The switch, matching the host's `ToggleSwitch`.
 *
 * Capsule track, oval thumb, and the host's status-green when on — taken from
 * `ui/src/components/ui/toggle-switch.tsx`, including its deliberate choice of the
 * status colour over `primary`, which that file records as a ruling.
 */
function Switch({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      // The host's own hook (`data-slot="toggle"`), so anything that styles or
      // targets its switches by that attribute finds this one too.
      data-slot="toggle"
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      style={{
        ...styles.switch,
        ...(checked ? styles.switchOn : styles.switchOff),
        ...(disabled ? styles.switchDisabled : null),
      }}
    >
      <span style={{ ...styles.thumb, transform: thumbTransform(checked) }} />
    </button>
  );
}

function Button({
  children,
  onClick,
  disabled,
  variant = "default",
  title,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  variant?: "default" | "primary";
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        ...styles.button,
        ...(variant === "primary" ? styles.buttonPrimary : null),
        ...(disabled ? styles.buttonDisabled : null),
      }}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function Configuration({
  companyId,
  onSaved,
  onMessage,
}: {
  companyId: string;
  onSaved: () => void;
  onMessage: Notify;
}) {
  const path = `/api/plugins/${PLUGIN_ID}/config?companyId=${encodeURIComponent(companyId)}`;
  const [stored, setStored] = useState<Record<string, unknown> | null>(null);
  const [draft, setDraft] = useState<OperatorConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    coreApi<{ configJson?: unknown } | null>(path)
      .then((response) => {
        if (cancelled) return;
        const document =
          response && typeof response === "object" && "configJson" in response
            ? (response as { configJson?: unknown }).configJson
            : response;
        const record =
          typeof document === "object" && document !== null && !Array.isArray(document)
            ? (document as Record<string, unknown>)
            : {};
        setStored(record);
        setDraft(readOperatorConfig(document));
      })
      .catch((error) => {
        if (!cancelled) setFailure(sanitizeErrorMessage(error));
      });
    return () => {
      cancelled = true;
    };
  }, [path]);

  /** Write one change immediately, the way a General settings switch does. */
  const write = useCallback(
    async (edits: Partial<OperatorConfig>, announce?: string) => {
      if (!draft) return;
      setBusy(true);
      try {
        // Only the schema's own keys are sent: the server validates this payload
        // with a closed schema, so an extra key is a rejected request rather than
        // a preserved setting.
        const { config: configJson, droppedKeys } = operatorConfigForSave(stored, {
          ...draft,
          ...edits,
        });
        await coreApi(`/api/plugins/${PLUGIN_ID}/config`, {
          method: "POST",
          body: { companyId, configJson },
        });
        setStored(configJson);
        setDraft(readOperatorConfig(configJson));
        onSaved();
        if (droppedKeys.length > 0) {
          onMessage(
            `Saved. This plugin no longer uses ${droppedKeys.join(", ")}, so ${
              droppedKeys.length === 1 ? "it was" : "they were"
            } removed.`,
            "warn",
          );
        } else if (announce) {
          onMessage(announce, "success");
        }
      } catch (error) {
        onMessage(sanitizeErrorMessage(error), "error");
      } finally {
        setBusy(false);
      }
    },
    [companyId, draft, onMessage, onSaved, stored],
  );

  if (failure) {
    return (
      <Section title="Configuration" description="Settings for this organization.">
        <div style={styles.errorBanner}>
          Could not read the settings: {failure} Nothing was changed.
        </div>
      </Section>
    );
  }

  if (!draft) {
    return (
      <Section title="Configuration" description="Settings for this organization.">
        <p style={styles.muted}>Loading…</p>
      </Section>
    );
  }

  return (
    <>
      <Section
        title="CodeGraph for this organization"
        description="While this is off, every CodeGraph call is refused, whatever an agent is otherwise allowed. It is off until you turn it on."
        control={
          <Switch
            checked={draft.enabled}
            disabled={busy}
            label="Enable CodeGraph for this organization"
            onChange={(next) =>
              void write({ enabled: next }, next ? "CodeGraph is on." : "CodeGraph is off.")
            }
          />
        }
      />

      <Section
        title="Build the index automatically"
        description="Index a repository the first time something asks for it. Leave it off to build indexes yourself, with the buttons below."
        control={
          <Switch
            checked={draft.autoIndex}
            disabled={busy}
            label="Build the index automatically"
            onChange={(next) => void write({ autoIndex: next })}
          />
        }
      />

      <Section
        title="Install CodeGraph automatically"
        description="Install CodeGraph on this server if it is missing. Off means you install it yourself, which is what a managed host usually wants."
        control={
          <Switch
            checked={draft.autoInstall}
            disabled={busy}
            label="Install CodeGraph automatically"
            onChange={(next) => void write({ autoInstall: next })}
          />
        }
      />

      <Section
        title="CodeGraph executable"
        description="The command to run. Set a full path if CodeGraph is not on the server's PATH."
      >
        <Field
          value={draft.codegraphCommand}
          disabled={busy}
          placeholder="codegraph"
          label="CodeGraph executable"
          onCommit={(value) => void write({ codegraphCommand: value }, "Executable updated.")}
        />
      </Section>

      <Section
        title="Directories CodeGraph may read"
        description="A limit, not a list. Leave it empty to let CodeGraph read whichever repository a project points at, anywhere on this server. Worth setting when more than one organization shares this instance."
      >
        <Field
          value={draft.allowedProjectRoots.join("\n")}
          disabled={busy}
          placeholder="/srv/repos"
          label="Directories CodeGraph may read"
          multiline
          onCommit={(value) =>
            void write({
              allowedProjectRoots: value
                .split("\n")
                .map((line) => line.trim())
                .filter((line) => line.length > 0),
            })
          }
        />
      </Section>
    </>
  );
}

/** A text field that writes on Save, for values that have to be typed. */
function Field({
  value,
  onCommit,
  disabled,
  placeholder,
  label,
  multiline,
}: {
  value: string;
  onCommit: (next: string) => void;
  disabled?: boolean;
  placeholder?: string;
  label: string;
  multiline?: boolean;
}) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const changed = text !== value;

  return (
    <div style={styles.field}>
      {multiline ? (
        <textarea
          aria-label={label}
          value={text}
          rows={3}
          disabled={disabled}
          placeholder={placeholder}
          onChange={(event) => setText(event.target.value)}
          style={styles.textarea}
        />
      ) : (
        <input
          aria-label={label}
          value={text}
          disabled={disabled}
          placeholder={placeholder}
          onChange={(event) => setText(event.target.value)}
          style={styles.input}
        />
      )}
      {changed ? (
        <Button variant="primary" disabled={disabled} onClick={() => onCommit(text)}>
          Save
        </Button>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Activate
// ---------------------------------------------------------------------------

function Activate({ companyId, onMessage }: { companyId: string; onMessage: Notify }) {
  const [busy, setBusy] = useState(false);

  const activate = useCallback(async () => {
    setBusy(true);
    const profilesPath = `/api/companies/${companyId}/tools/profiles`;
    try {
      let profileId: string;
      let profile: StepOutcome;
      try {
        const created = await coreApi<{ id: string }>(profilesPath, {
          method: "POST",
          body: {
            profileKey: PROFILE_KEY,
            name: "CodeGraph (read-only)",
            description: "Read-only CodeGraph tools. Every CodeGraph tool is query-only.",
            status: "active",
            defaultAction: "deny",
            entries: TOOL_NAMES.map((toolName) => ({
              selectorType: "tool_name",
              effect: "include",
              toolName: `${PLUGIN_ID}:${toolName}`,
            })),
          },
        });
        profileId = created.id;
        profile = "created";
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        if (!isAlreadyExistsMessage(text)) throw error;
        const existing = findProfileId(await coreApi<unknown>(profilesPath), PROFILE_KEY);
        if (!existing) throw error;
        profileId = existing;
        profile = "already-existed";
      }

      // Company scope on purpose: Paperclip keeps only the narrowest matching
      // binding tier, so an agent-scoped binding would silently drop this profile
      // for that agent — granting CodeGraph could revoke their other tools.
      let binding: StepOutcome = "created";
      try {
        await coreApi(`${profilesPath}/${profileId}/bind`, {
          method: "POST",
          body: { targetType: "company", targetId: companyId, priority: 100 },
        });
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        if (!isAlreadyExistsMessage(text)) throw error;
        binding = "already-existed";
      }

      const gatewaysPath = `/api/companies/${companyId}/tools/gateways`;
      let gateway: StepOutcome;
      let existingGateway: { id: string; profileId: string | null } | null = null;
      try {
        existingGateway = findGateway(await coreApi<unknown>(gatewaysPath), GATEWAY_SLUG);
      } catch {
        existingGateway = null;
      }

      if (!existingGateway) {
        try {
          await coreApi(gatewaysPath, {
            method: "POST",
            body: { name: GATEWAY_NAME, slug: GATEWAY_SLUG, profileId },
          });
          gateway = "created";
        } catch (error) {
          const text = error instanceof Error ? error.message : String(error);
          if (!isAlreadyExistsMessage(text)) throw error;
          gateway = "already-existed";
        }
      } else if (existingGateway.profileId !== null && existingGateway.profileId !== profileId) {
        await coreApi(`/api/tool-gateway/gateways/${existingGateway.id}`, {
          method: "PATCH",
          body: { companyId, profileId },
        });
        gateway = "repointed";
      } else {
        gateway = "already-existed";
      }

      const summary: ActivationSummary = { profileId, profile, binding, gateway };
      onMessage(describeActivation(summary), "success");
    } catch (error) {
      onMessage(sanitizeErrorMessage(error), "error");
    } finally {
      setBusy(false);
    }
  }, [companyId, onMessage]);

  return (
    <Section
      title="Make the tools callable"
      description="Creates the Paperclip tool profile and MCP gateway that allow these tools at all. Safe to run twice — it reuses what it already made."
      control={
        <Button variant="primary" disabled={busy} onClick={() => void activate()}>
          {busy ? "Activating…" : "Activate"}
        </Button>
      }
    />
  );
}

// ---------------------------------------------------------------------------
// Repositories
// ---------------------------------------------------------------------------

function Repositories({
  companyId,
  revision,
  onChanged,
  onMessage,
}: {
  companyId: string;
  revision: number;
  onChanged: () => void;
  onMessage: Notify;
}) {
  const { data, loading, refresh } = usePluginData<{
    repositories: RepoRow[];
    skippedProjects?: number;
  }>(DATA_KEYS.graphProjects, { companyId, revision });
  const setAccess = usePluginAction(ACTION_KEYS.setRepositoryAccess);
  const [busy, setBusy] = useState<string | null>(null);

  const repositories = data?.repositories ?? [];
  const skipped = data?.skippedProjects ?? 0;

  // The switch is a per-project control, so the list is grouped by project: a
  // project holding several checkouts is one decision, not several. Without this
  // a six-repository project draws six identical switches that all move together.
  const groups = useMemo(() => {
    const byProject = new Map<string, RepoRow[]>();
    for (const repo of repositories) {
      const existing = byProject.get(repo.projectId);
      if (existing) existing.push(repo);
      else byProject.set(repo.projectId, [repo]);
    }
    return [...byProject.values()];
  }, [repositories]);

  const toggle = useCallback(
    async (project: RepoRow[], blocked: boolean) => {
      const first = project[0];
      if (!first) return;
      const title = first.projectName ?? first.name;
      setBusy(first.projectId);
      try {
        await setAccess({ companyId, projectId: first.projectId, blocked });
        refresh();
        onChanged();
        onMessage(
          blocked
            ? `Agents working in ${title} no longer get CodeGraph.`
            : `${title} is available to CodeGraph again.`,
          blocked ? "warn" : "success",
        );
      } catch (error) {
        onMessage(sanitizeErrorMessage(error), "error");
      } finally {
        setBusy(null);
      }
    },
    [companyId, onChanged, onMessage, refresh, setAccess],
  );

  return (
    <Section
      title="Repositories"
      description="Which repositories CodeGraph may read. An agent reaches the one its Paperclip project uses, so this is set here rather than per agent — and switching one off can only narrow."
    >
      {loading && repositories.length === 0 ? (
        <p style={styles.muted}>Loading…</p>
      ) : repositories.length === 0 ? (
        <p style={styles.muted}>
          No repository yet. One appears when a project in this organization has a workspace.
        </p>
      ) : (
        <ul style={styles.rows}>
          {groups.map((project) => {
            const first = project[0]!;
            const title = first.projectName ?? first.name;
            const indexed = project.filter((repo) => repo.indexed).length;
            return (
              <li key={first.projectId} style={styles.row}>
                <div style={styles.rowText}>
                  <span style={styles.rowTitle}>
                    {title}
                    {project.length === 1 && repoAside(first) ? (
                      <span style={styles.rowAside}> · {repoAside(first)}</span>
                    ) : null}
                  </span>
                  <span style={styles.rowMeta}>
                    {indexed === 0
                      ? "Not indexed"
                      : project.length === 1
                        ? first.fileCount === null || first.fileCount === undefined
                          ? "Indexed"
                          : `Indexed · ${first.fileCount} files, ${first.nodeCount ?? "?"} symbols`
                        : `${indexed} of ${project.length} repositories indexed`}
                  </span>
                  {/*
                    Only when there is something to disambiguate. A single
                    checkout under a project would just repeat the row's title.
                  */}
                  {project.length > 1 ? (
                    <ul style={styles.subRows}>
                      {project.map((repo) => (
                        <li key={repoId(repo)} style={styles.subRow}>
                          <span style={styles.subRowTitle}>{repo.name}</span>
                          <span style={styles.rowMeta}>
                            {repo.indexed ? "Indexed" : "Not indexed"}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
                <Switch
                  checked={first.blocked !== true}
                  disabled={busy !== null}
                  label={`Allow CodeGraph to read ${title}`}
                  onChange={(next) => void toggle(project, !next)}
                />
              </li>
            );
          })}
        </ul>
      )}
      {skipped > 0 ? (
        <p style={styles.note}>
          {skipped} other project{skipped === 1 ? "" : "s"} here {skipped === 1 ? "is" : "are"} not
          listed, because {skipped === 1 ? "it has" : "they have"} no repository workspace.
        </p>
      ) : null}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Indexing
// ---------------------------------------------------------------------------

function Indexing({
  companyId,
  revision,
  onChanged,
  onMessage,
}: {
  companyId: string;
  revision: number;
  onChanged: () => void;
  onMessage: Notify;
}) {
  const { data, loading, refresh } = usePluginData<{ repositories: RepoRow[] }>(
    DATA_KEYS.repositories,
    { companyId, revision },
  );
  const indexNow = usePluginAction(ACTION_KEYS.indexNow);
  const [busy, setBusy] = useState<string | null>(null);

  const run = useCallback(
    async (repo: RepoRow, reindex: boolean) => {
      setBusy(`${repoId(repo)}:${reindex ? "rebuild" : "index"}`);
      try {
        // The key matters: a project can hold several checkouts, and indexing the
        // wrong one would report success while the operator's repository stayed
        // unindexed.
        await indexNow({
          companyId,
          projectId: repo.projectId,
          repositoryKey: repo.repositoryKey,
          reindex,
        });
        refresh();
        onChanged();
        onMessage(
          reindex ? `Rebuilt the index for ${repo.name}.` : `Indexed ${repo.name}.`,
          "success",
        );
      } catch (error) {
        onMessage(sanitizeErrorMessage(error), "error");
      } finally {
        setBusy(null);
      }
    },
    [companyId, indexNow, onChanged, onMessage, refresh],
  );

  const repositories = data?.repositories ?? [];

  return (
    <Section
      title="Index"
      description="The index is what everything reads — a repository with no index answers nothing. Building one reads the whole repository, which is why it happens when you ask rather than by itself."
    >
      {loading && repositories.length === 0 ? (
        <p style={styles.muted}>Loading…</p>
      ) : repositories.length === 0 ? (
        <p style={styles.muted}>Nothing to index yet.</p>
      ) : (
        <ul style={styles.rows}>
          {repositories.map((repo) => (
            <li key={repoId(repo)} style={styles.row}>
              <div style={styles.rowText}>
                <span style={styles.rowTitle}>
                  {repo.name}
                  {repoAside(repo) ? (
                    <span style={styles.rowAside}> · {repoAside(repo)}</span>
                  ) : null}
                </span>
                <span style={styles.rowMeta}>
                  {repo.indexed
                    ? `${repo.fileCount ?? "?"} files · ${repo.nodeCount ?? "?"} symbols`
                    : "Not indexed yet"}
                </span>
              </div>
              <div style={styles.rowActions}>
                <Button disabled={busy !== null} onClick={() => void run(repo, false)}>
                  {busy === `${repoId(repo)}:index` ? "Indexing…" : "Index now"}
                </Button>
                <Button
                  disabled={busy !== null}
                  title="Discard the index and build it again from scratch"
                  onClick={() => void run(repo, true)}
                >
                  {busy === `${repoId(repo)}:rebuild` ? "Rebuilding…" : "Rebuild"}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Exceptions
// ---------------------------------------------------------------------------

function Exceptions({
  companyId,
  revision,
  onChanged,
  onMessage,
  enabled,
}: {
  companyId: string;
  revision: number;
  onChanged: () => void;
  onMessage: Notify;
  /** Whether the plugin is on for this organization at all. */
  enabled: boolean;
}) {
  const { data: access, refresh: refreshAccess } = usePluginData<{ agents: AgentRow[] }>(
    DATA_KEYS.access,
    { companyId, revision },
  );
  const { data: agents } = usePluginData<{ agents: AgentRow[] }>(DATA_KEYS.agents, {
    companyId,
    revision,
  });
  const setAgentAccess = usePluginAction(ACTION_KEYS.setAgentAccess);
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const rows = access?.agents ?? agents?.agents ?? [];
  const revoked = rows.filter((agent) => agent.enabled === false).length;
  const noClient = rows.filter(
    (agent) => agent.enabled !== false && agent.mcpClientLoaded !== true,
  ).length;
  const noConfig = rows.filter(
    (agent) =>
      agent.enabled !== false && agent.mcpClientLoaded === true && agent.mcpConfigPassed !== true,
  ).length;

  const toggle = useCallback(
    async (agent: AgentRow, enabled: boolean) => {
      setBusy(agent.id);
      try {
        await setAgentAccess({ companyId, agentId: agent.id, enabled });
        refreshAccess();
        onChanged();
        onMessage(
          enabled
            ? `${agent.name} can use CodeGraph again.`
            : `${agent.name} no longer gets CodeGraph tools.`,
          enabled ? "success" : "warn",
        );
      } catch (error) {
        onMessage(sanitizeErrorMessage(error), "error");
      } finally {
        setBusy(null);
      }
    },
    [companyId, onChanged, onMessage, refreshAccess, setAgentAccess],
  );

  return (
    <Section
      title="Exceptions"
      description="Every agent reaches the repositories its projects use, so there is nothing to grant here. This is only for taking that away from one agent."
      control={
        rows.length > 0 ? (
          <Button onClick={() => setOpen((value) => !value)}>
            {open ? "Hide agents" : `Show ${rows.length} agents`}
          </Button>
        ) : null
      }
    >
      {revoked > 0 ? (
        <p style={styles.note}>
          {revoked} agent{revoked === 1 ? " is" : "s are"} revoked.
        </p>
      ) : null}

      {!enabled ? (
        /*
         * Two states get confused, and naming the wrong one sends the operator to
         * the wrong place. When the plugin is off, no agent receives anything
         * whatever its adapter says — so the adapter is not the problem and must
         * not be described as one. This is the state a fresh organization is in.
         */
        <p style={styles.note}>
          CodeGraph is off for this organization, so no agent receives these tools yet whatever
          its adapter is set to. Switch it on at the top of this page, and this section will
          say whether anything else is still missing.
        </p>
      ) : noClient + noConfig > 0 ? (
        <div style={styles.banner}>
          <strong>
            {noClient + noConfig} of {rows.length} agents cannot receive these tools yet.
          </strong>
          <p style={styles.bannerBody}>
            CodeGraph is on, and an active profile makes these tools <em>allowed</em> — but an
            agent also needs an MCP client pointed at this organization&apos;s MCP config before
            the tools can reach it.
            {noClient > 0 ? ` ${noClient} load no MCP client at all.` : ""}
            {noConfig > 0 ? ` ${noConfig} load one but never pass --mcp-config.` : ""}
          </p>
          <p style={styles.bannerBody}>
            Fix it per agent in its adapter settings, then restart that agent. Until then these
            agents can still reach CodeGraph through the plugin API — governed and audited — but
            they will not see the tools.
          </p>
        </div>
      ) : rows.length > 0 ? (
        <p style={styles.note}>
          All {rows.length} agents load an MCP client pointed at this organization&apos;s MCP
          config.
        </p>
      ) : null}

      {open ? (
        <ul style={styles.rows}>
          {rows.map((agent) => (
            <li key={agent.id} style={styles.row}>
              <div style={styles.rowText}>
                <span style={styles.rowTitle}>{agent.name}</span>
                <span style={styles.rowMeta}>
                  {agent.enabled === false
                    ? "Revoked"
                    : agent.mcpClientLoaded !== true
                      ? "No MCP client"
                      : agent.mcpConfigPassed !== true
                        ? "MCP client without a config"
                        : "Can use CodeGraph"}
                </span>
              </div>
              <Switch
                checked={agent.enabled !== false}
                disabled={busy !== null}
                label={`Let ${agent.name} use CodeGraph`}
                onChange={(next) => void toggle(agent, next)}
              />
            </li>
          ))}
        </ul>
      ) : null}
    </Section>
  );
}
