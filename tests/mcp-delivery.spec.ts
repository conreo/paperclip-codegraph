/**
 * Whether the plugin correctly identifies an agent that cannot receive a tool.
 *
 * Two runs (CTO, CEO) reported "CodeGraph is not available" against a plugin whose
 * governance was entirely correct, and neither could see the reason: an active
 * profile *permits* tools, it does not *deliver* them. A `pi_local` agent needs an
 * MCP client, and that client must be pointed at the company's MCP config.
 *
 * This mirrors the worker's `mcpDelivery` classification against the real shapes
 * found on the instance, including the CEO's actual `extraArgs`.
 */

import { describe, expect, it } from "vitest";

/** Mirrors the worker's derivation. */
function mcpDelivery(agent: { adapterType?: string | null; adapterConfig?: unknown }) {
  const config = agent.adapterConfig;
  const raw =
    typeof config === "object" && config !== null
      ? (config as { extraArgs?: unknown }).extraArgs
      : undefined;
  const extraArgs = Array.isArray(raw) ? raw.map(String) : [];
  return {
    mcpClientLoaded: extraArgs.some((arg) => arg.includes("pi-mcp-adapter")),
    mcpConfigPassed: extraArgs.includes("--mcp-config"),
  };
}

const ADAPTER = "/paperclip/instances/default/companies/C/pi-extensions/node_modules/pi-mcp-adapter";

describe("mcpDelivery", () => {
  it("flags an agent with no MCP client at all", () => {
    // The five engineer agents on the instance: env, model, no extraArgs.
    expect(mcpDelivery({ adapterType: "pi_local", adapterConfig: { model: "x" } })).toEqual({
      mcpClientLoaded: false,
      mcpConfigPassed: false,
    });
  });

  it("flags the CEO's original state: adapter loaded, but no --mcp-config", () => {
    // Verbatim from the instance. The adapter was loaded, read its own default
    // paths, found no file, and loaded zero servers — which is why deepwiki never
    // worked either.
    const before = {
      adapterType: "pi_local",
      adapterConfig: {
        extraArgs: ["-e", ADAPTER, "--tools", "read,bash,edit,write,grep,find,ls,mcp"],
      },
    };
    expect(mcpDelivery(before)).toEqual({ mcpClientLoaded: true, mcpConfigPassed: false });
  });

  it("accepts the wired state", () => {
    const after = {
      adapterType: "pi_local",
      adapterConfig: {
        extraArgs: [
          "-e",
          ADAPTER,
          "--mcp-config",
          "/paperclip/instances/default/companies/C/mcp.json",
          "--tools",
          "read,bash,edit,write,grep,find,ls,mcp",
        ],
      },
    };
    expect(mcpDelivery(after)).toEqual({ mcpClientLoaded: true, mcpConfigPassed: true });
  });

  it("does not mistake a plain --mcp flag for the config path", () => {
    // `--mcp` alone is not `--mcp-config`; an exact match matters or a different
    // adapter setup reads as wired.
    const config = { extraArgs: ["-e", ADAPTER, "--mcp"] };
    expect(mcpDelivery({ adapterConfig: config }).mcpConfigPassed).toBe(false);
  });

  it("survives a missing or malformed adapter config", () => {
    // adapterConfig is a JSON blob from the database; none of these may throw,
    // because this runs inside a settings page.
    for (const config of [undefined, null, "string", 42, {}, { extraArgs: "nope" }, { extraArgs: null }]) {
      expect(() => mcpDelivery({ adapterConfig: config })).not.toThrow();
      expect(mcpDelivery({ adapterConfig: config }).mcpClientLoaded).toBe(false);
    }
  });

  it("handles extraArgs holding non-strings", () => {
    expect(() => mcpDelivery({ adapterConfig: { extraArgs: [1, {}, ADAPTER] } })).not.toThrow();
    expect(mcpDelivery({ adapterConfig: { extraArgs: [ADAPTER] } }).mcpClientLoaded).toBe(true);
  });
});
