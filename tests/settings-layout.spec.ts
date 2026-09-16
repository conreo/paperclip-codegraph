/**
 * The settings page's structural rules.
 *
 * These are source-level checks on purpose. Everything asserted here — the column
 * width, the split row, the switch writing immediately — is a *layout* decision
 * that types cannot see and a renderer cannot verify without a browser. They match
 * Paperclip's own General settings page, and the point of the redesign was to stop
 * inventing a layout the app around it does not use.
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const UI = path.join(process.cwd(), "src", "ui");
const ADMIN = fs.readFileSync(path.join(UI, "admin.tsx"), "utf8");
const CHROME = fs.readFileSync(path.join(UI, "chrome.tsx"), "utf8");

describe("the page follows the host's settings layout", () => {
  it("uses a reading-width column, as the host's settings pages do", () => {
    // `max-w-4xl` on the host is 896px.
    expect(CHROME).toContain("maxWidth: 896");
    expect(CHROME).toMatch(/page: \{[\s\S]*?flexDirection: "column"/);
  });

  it("separates sections with space, not a card around each one", () => {
    // The old page put every block in a bordered card. The host does not.
    expect(CHROME).toMatch(/gap: 32/);
    expect(ADMIN).not.toContain("styles.card");
  });

  it("gives each section a heading and a sentence", () => {
    // The `Section` helper is the only way a section is built, so every section
    // has both by construction.
    expect(ADMIN).toContain("function Section(");
    const sections = ADMIN.match(/<Section\b/g) ?? [];
    expect(sections.length).toBeGreaterThanOrEqual(6);
    expect(ADMIN).toContain("title={");
    expect(ADMIN).toContain("description=");
  });

  it("puts a control opposite its text, as the host's split row does", () => {
    expect(CHROME).toMatch(/sectionSplit: \{[\s\S]*?justifyContent: "space-between"/);
    expect(CHROME).toMatch(/alignItems: "flex-start"/);
  });
});

describe("settings save the way the host's do", () => {
  it("has a switch, not a checkbox", () => {
    // The host uses a capsule switch for settings; a checkbox reads as a form.
    expect(ADMIN).toContain('role="switch"');
    expect(ADMIN).not.toContain('type="checkbox"');
  });

  it("writes a switch immediately rather than behind a Save button", () => {
    // This is the host's whole idiom — General settings has no Save button, and a
    // form that needs saving is one that can be abandoned half-changed.
    const switchUses = ADMIN.match(/onChange=\{\(next\) =>[\s\S]{0,80}?write\(/g) ?? [];
    expect(switchUses.length).toBeGreaterThanOrEqual(3);
  });

  it("keeps a Save button only for values that have to be typed", () => {
    // One `Field` component, and it is the only place a Save button exists.
    const saves = ADMIN.match(/>\s*Save\s*</g) ?? [];
    expect(saves).toHaveLength(1);
    expect(ADMIN).toContain("function Field(");
  });

  it("uses the host's status green for the on state, not primary", () => {
    // `toggle-switch.tsx` records this as a deliberate ruling, so the plugin copies
    // it rather than re-deciding.
    expect(CHROME).toMatch(/switchOn: \{ background: ui\.statusDone/);
    expect(CHROME).toContain("status-task-done");
  });
});

describe("the copy says what happens", () => {
  it("does not describe the switch as a grant", () => {
    // An active profile only *permits* tools; the plugin narrows, it never grants.
    expect(ADMIN).toContain("nothing to grant here");
  });

  it("explains an unindexed repository rather than only reporting it", () => {
    expect(ADMIN).toContain("a repository with no index answers nothing");
  });

  it("says where the fix is when agents cannot receive tools", () => {
    // The gap that two separate runs could not see.
    expect(ADMIN).toContain("cannot receive these tools yet");
    expect(ADMIN).toContain("restart that agent");
  });

  it("describes the directory limit as a limit, not a list", () => {
    // The field nobody could read: it is not a list of repositories.
    expect(ADMIN).toContain("A limit, not a list");
  });
});
