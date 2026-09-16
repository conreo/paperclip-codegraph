import { describe, expect, it } from "vitest";

import manifest from "../src/manifest.js";
import { CODEGRAPH_TOOLS, PLUGIN_ID } from "../src/constants.js";
import {
  buildNativeMcpPlan,
  renderPlanAsCurl,
} from "../src/governance/provision.js";

describe("manifest — UI slots", () => {
  /**
   * The host validates slot type against capability and rejects the manifest
   * without the matching declaration, so this pairing is a real contract rather
   * than documentation.
   */
  const REQUIRED_CAPABILITY: Record<string, string> = {
    settingsPage: "instance.settings.register",
    sidebar: "ui.sidebar.register",
    page: "ui.page.register",
    // The host's own map (`plugin-capability-validator.ts:172`) pairs the route
    // sidebar with the ordinary sidebar capability.
    routeSidebar: "ui.sidebar.register",
  };

  it("declares the capability each slot requires", () => {
    const slots = manifest.ui?.slots ?? [];
    expect(slots.length).toBeGreaterThan(0);

    for (const slot of slots) {
      const required = REQUIRED_CAPABILITY[slot.type];
      expect(required, `no capability mapping for slot type "${slot.type}"`).toBeDefined();
      expect(
        manifest.capabilities,
        `slot "${slot.id}" (${slot.type}) requires ${required}`,
      ).toContain(required);
    }
  });

  it("gives every slot a unique id and a named export", () => {
    const slots = manifest.ui?.slots ?? [];
    const ids = slots.map((slot) => slot.id);
    expect(new Set(ids).size).toBe(ids.length);

    for (const slot of slots) {
      expect(slot.displayName.length).toBeGreaterThan(0);
      expect(slot.exportName.length).toBeGreaterThan(0);
    }
  });

  it("routes the graph page somewhere the host has not reserved", () => {
    // `routePath` is only valid on page / routeSidebar / companySettingsPage;
    // on any other slot the host ignores or rejects it.
    const routed = (manifest.ui?.slots ?? []).filter(
      (slot) => "routePath" in slot && slot.routePath,
    );
    for (const slot of routed) {
      expect(["page", "routeSidebar", "companySettingsPage"]).toContain(slot.type);
      // Reserved segments map to first-class host pages and would collide.
      expect([
        "dashboard", "onboarding", "companies", "company", "settings", "plugins",
        "org", "agents", "projects", "issues", "goals", "approvals", "costs",
        "activity", "inbox", "workspaces", "design-guide", "tests",
      ]).not.toContain(slot.routePath);
    }
  });

  it("pairs its route sidebar with its page, which is what removes the host's Back button", () => {
    // `PluginPage.tsx` draws `{!routeSidebarActive && <Back>}`, and the host only
    // treats the route as taken over when `resolveRouteSidebarSlot` finds a
    // routeSidebar whose routePath matches the page slot's, in the same plugin.
    // Losing this pairing silently brings the Back button back.
    const slots = manifest.ui?.slots ?? [];
    const page = slots.find((slot) => slot.type === "page");
    const rails = slots.filter((slot) => slot.type === "routeSidebar");
    expect(page?.routePath).toBeDefined();
    expect(rails).toHaveLength(1);
    expect(rails[0]!.routePath).toBe(page!.routePath);
  });

  it("exposes the graph page the UI bundle actually exports", () => {
    const page = (manifest.ui?.slots ?? []).find((slot) => slot.type === "page");
    expect(page).toBeDefined();
    expect(page!.exportName).toBe("CodeGraphPage");
  });
});

describe("manifest", () => {
  it("uses a schema-valid plugin id", () => {
    expect(manifest.id).toMatch(/^[a-z0-9][a-z0-9._-]*$/);
    expect(manifest.id).toBe(PLUGIN_ID);
  });

  it("targets plugin API version 1 with a semver version", () => {
    expect(manifest.apiVersion).toBe(1);
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("declares the capability required by its tools array", () => {
    // The host rejects a manifest that declares tools without this capability.
    expect(manifest.tools?.length).toBeGreaterThan(0);
    expect(manifest.capabilities).toContain("agent.tools.register");
  });

  it("declares every capability it actually uses", () => {
    for (const capability of [
      "agent.tools.register",
      // Used to derive the repository from the run's project workspace.
      // `project.workspaces.read` is the capability the host's operation map
      // actually requires for getPrimaryWorkspace — not `projects.read`.
      "project.workspaces.read",
      "agents.read",
      "plugin.state.read",
      "plugin.state.write",
      "activity.log.write",
      "instance.settings.register",
    ]) {
      expect(manifest.capabilities).toContain(capability);
    }
  });

  it("declares the capabilities its handlers actually call", () => {
    // Least privilege, checked in both directions: every capability maps to a
    // host call, and every host call has its capability.
    //
    // `companies.read` was removed as unused, then came back deliberately: the
    // graph-projects handler calls `companies.get` for the org's display name so
    // the surfaces can say whose code they are showing. `projects.read` covers
    // the project listings that back the repository selector.
    expect(manifest.capabilities).toContain("companies.read");
    expect(manifest.capabilities).toContain("projects.read");
  });

  it("declares no local folders, so Paperclip renders no folder panel", () => {
    // A declared folder is rendered by the host with a health badge, and an
    // unconfigured one reads as "Needs attention" even when the deployment does
    // not need it — repositories come from the run's project workspace, or from
    // absolute bindings. A standing false alarm is worse than no picker, so the
    // declaration is gone and the capability with it.
    expect(manifest.localFolders ?? []).toHaveLength(0);
    expect(manifest.capabilities).not.toContain("local.folders");
  });

  it("declares exactly the eight CodeGraph tools", () => {
    const names = manifest.tools?.map((tool) => tool.name) ?? [];
    expect(names).toEqual([...CODEGRAPH_TOOLS]);
  });
  it("gives every tool a display name, description and object schema", () => {
    for (const tool of manifest.tools ?? []) {
      expect(tool.displayName.length).toBeGreaterThan(0);
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.parametersSchema["type"]).toBe("object");
    }
  });

  it("uses unique tool names", () => {
    const names = (manifest.tools ?? []).map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("keeps every description inside the host's 500-char manifest limit", () => {
    expect(manifest.description.length).toBeLessThanOrEqual(500);
  });

  it("ships an instance config schema that defaults to disabled", () => {
    const schema = manifest.instanceConfigSchema as Record<string, unknown>;
    const properties = schema["properties"] as Record<string, Record<string, unknown>>;
    expect(properties["enabled"]?.["default"]).toBe(false);
  });
});

describe("buildNativeMcpPlan", () => {
  const base = {
    companyId: "co-1",
    command: "codegraph",
    args: ["serve", "--mcp"],
    projectPath: "/srv/tenant-a/repo",
    deploymentMode: "local_trusted",
  };

  it("orders the steps so each dependency exists first", () => {
    const plan = buildNativeMcpPlan(base);
    const paths = plan.steps.map((step) => step.path);
    expect(paths[0]).toContain("/tools/stdio-templates");
    expect(paths[1]).toContain("/tools/applications");
    expect(paths[2]).toContain("/tools/connections");
    expect(paths[3]).toContain("/catalog/refresh");
    expect(paths[4]).toContain("/tools/profiles");
    expect(paths[5]).toContain("/bind");
  });

  it("creates the approved stdio template local_stdio requires", () => {
    const plan = buildNativeMcpPlan(base);
    const template = plan.steps[0]!.body!;
    expect(template["templateId"]).toBe("codegraph-mcp");
    expect(template["command"]).toBe("codegraph");
    expect(template["args"]).toEqual(["serve", "--mcp"]);
    // The template seeds the catalog, so it must describe all eight tools.
    expect((template["tools"] as unknown[]).length).toBe(8);
  });

  it("registers the connection with the transport and application type Paperclip accepts", () => {
    const plan = buildNativeMcpPlan(base);
    const application = plan.steps[1]!.body!;
    const connection = plan.steps[2]!.body!;
    expect(application["type"]).toBe("mcp_stdio");
    expect(connection["transport"]).toBe("local_stdio");
    expect(connection["authKind"]).toBe("none");
    expect(connection["connectionKind"]).toBe("managed");
  });

  it("pins the project path in transportConfig, not in agent-reachable arguments", () => {
    const plan = buildNativeMcpPlan(base);
    const config = plan.steps[2]!.body!["transportConfig"] as Record<string, unknown>;
    expect(config["projectPath"]).toBe("/srv/tenant-a/repo");
    expect(config["templateId"]).toBe("codegraph-mcp");
  });

  it("keeps telemetry off in the connection's own environment", () => {
    const plan = buildNativeMcpPlan(base);
    const config = plan.steps[2]!.body!["transportConfig"] as Record<string, unknown>;
    const env = config["env"] as Record<string, string>;
    expect(env["DO_NOT_TRACK"]).toBe("1");
    expect(env["CODEGRAPH_TELEMETRY"]).toBe("0");
  });

  it("defaults the profile to deny so nothing is implicitly visible", () => {
    const plan = buildNativeMcpPlan(base);
    const profile = plan.steps[4]!.body!;
    expect(profile["defaultAction"]).toBe("deny");
    expect(profile["status"]).toBe("active");
  });

  it("includes all eight tools by default, and only those", () => {
    const plan = buildNativeMcpPlan(base);
    const entries = plan.steps[4]!.body!["entries"] as Array<Record<string, unknown>>;
    expect(entries).toHaveLength(8);
    expect(entries.every((entry) => entry["effect"] === "include")).toBe(true);
    expect(entries.every((entry) => entry["selectorType"] === "tool_name")).toBe(true);
    expect(entries.map((entry) => entry["toolName"])).toEqual([...CODEGRAPH_TOOLS]);
  });

  it("honours a narrowed allow list", () => {
    const plan = buildNativeMcpPlan({
      ...base,
      allowedTools: ["codegraph_explore", "codegraph_node"],
    });
    const entries = plan.steps[4]!.body!["entries"] as Array<Record<string, unknown>>;
    expect(entries.map((entry) => entry["toolName"])).toEqual([
      "codegraph_explore",
      "codegraph_node",
    ]);
  });

  it("removes a denied tool even when it was also allowed", () => {
    const plan = buildNativeMcpPlan({
      ...base,
      allowedTools: ["codegraph_explore", "codegraph_impact"],
      deniedTools: ["codegraph_impact"],
    });
    const entries = plan.steps[4]!.body!["entries"] as Array<Record<string, unknown>>;
    const included = entries
      .filter((entry) => entry["effect"] === "include")
      .map((entry) => entry["toolName"]);
    expect(included).toEqual(["codegraph_explore"]);
  });

  it("passes the resolved allowlist upstream via CODEGRAPH_MCP_TOOLS", () => {
    const plan = buildNativeMcpPlan({ ...base, allowedTools: ["codegraph_explore"] });
    const config = plan.steps[2]!.body!["transportConfig"] as Record<string, unknown>;
    const env = config["env"] as Record<string, string>;
    expect(env["CODEGRAPH_MCP_TOOLS"]).toBe("explore");
  });

  it("binds the profile at company scope", () => {
    const plan = buildNativeMcpPlan(base);
    expect(plan.steps[5]!.body).toMatchObject({
      targetType: "company",
      targetId: "co-1",
    });
  });

  it("flags a non-local-trusted deployment as a preflight failure", () => {
    const plan = buildNativeMcpPlan({
      ...base,
      deploymentMode: "authenticated",
    });
    expect(plan.preflight.ok).toBe(false);
    expect(plan.preflight.detail).toContain("authenticated");
    expect(plan.notes[0]).toMatch(/local_trusted/);
  });

  it("passes preflight on local_trusted", () => {
    expect(buildNativeMcpPlan(base).preflight.ok).toBe(true);
  });

  it("notes the governance semantics a reviewer needs", () => {
    const notes = buildNativeMcpPlan(base).notes.join("\n");
    expect(notes).toMatch(/mcp_local_stdio/);
    expect(notes).toMatch(/defaultAction is `deny`/);
    expect(notes).toMatch(/approved stdio command template/);
  });

  it("carries no placeholder steps", () => {
    const plan = buildNativeMcpPlan(base);
    for (const step of plan.steps) {
      expect(step.purpose.length).toBeGreaterThan(10);
      expect(step.purpose).not.toMatch(/placeholder/i);
    }
    expect(plan.steps).toHaveLength(6);
  });
});

describe("renderPlanAsCurl", () => {
  const plan = buildNativeMcpPlan({
    companyId: "co-1",
    command: "codegraph",
    args: ["serve", "--mcp"],
    projectPath: "/srv/tenant-a/repo",
    deploymentMode: "local_trusted",
  });
  const rendered = renderPlanAsCurl(plan, "http://127.0.0.1:3100");

  it("emits one curl per step with the auth header by reference", () => {
    expect(rendered.match(/curl -fsS -X POST/g)).toHaveLength(plan.steps.length);
    expect(rendered).toContain("Bearer $PAPERCLIP_BOARD_API_KEY");
  });

  it("never inlines a secret value", () => {
    // Only the shell variable reference may appear.
    expect(rendered).not.toMatch(/Bearer [A-Za-z0-9_\-.]{16,}/);
  });

  it("prefixes every request with the target base url", () => {
    expect(rendered).toContain("http://127.0.0.1:3100/api/companies/co-1/tools/");
  });

  it("tells the operator which ids to capture from responses", () => {
    expect(rendered).toContain("$applicationId");
    expect(rendered).toContain("$connectionId");
    expect(rendered).toContain("$profileId");
  });

  it("carries the plan notes as comments", () => {
    expect(rendered).toContain("# NOTE:");
  });
});
