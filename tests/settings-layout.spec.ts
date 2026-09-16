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

  it("names the cause that is actually blocking, not the adapter by default", () => {
    // Two states get confused: the plugin being off, and the adapter not being
    // wired. Naming the adapter when the plugin is off sends the operator to the
    // wrong settings page — and off is the state a fresh organization is in.
    const delivery = ADMIN.slice(ADMIN.indexOf("CodeGraph is off for this organization"));
    expect(delivery).toBeTruthy();
    // The off-state note comes first in the conditional chain, before the wiring
    // warning, so it wins when both are true.
    const offAt = ADMIN.indexOf("CodeGraph is off for this organization");
    const wiringAt = ADMIN.indexOf("cannot receive these tools yet");
    expect(offAt).toBeGreaterThan(-1);
    expect(offAt).toBeLessThan(wiringAt);
  });

  it("does not claim agents are the problem when they are switched off", () => {
    // Revoked agents are a choice, not a gap, so they are excluded from the count.
    expect(ADMIN).toContain("agent.enabled !== false && agent.mcpClientLoaded");
  });

  it("describes the directory limit as a limit, not a list", () => {
    // The field nobody could read: it is not a list of repositories.
    expect(ADMIN).toContain("A limit, not a list");
  });
});

/**
 * The switch geometry, transcribed from the host's markup.
 *
 * The classes to match, quoted from a real Paperclip settings page:
 *
 *   track: `relative inline-flex shrink-0 items-center rounded-full border-2
 *           transition-all h-5 w-11 border-transparent bg-input/90`
 *   thumb: `pointer-events-none inline-block rounded-full bg-background shadow-sm
 *           transition-transform h-4 w-6 translate-x-0`
 *
 * These are asserted as numbers because that is what they are, and because the two
 * easy mistakes here — a square thumb and a hardcoded travel distance — are
 * invisible in a diff and obvious on screen next to the host's own rows.
 */
describe("the switch matches the host's geometry", () => {
  it("uses the host's track and thumb sizes", () => {
    // `w-11 h-5` = 44×20; `w-6 h-4` = 24×16. The thumb is wider than it is tall.
    expect(CHROME).toContain("const TRACK_WIDTH = 44");
    expect(CHROME).toContain("const TRACK_HEIGHT = 20");
    expect(CHROME).toContain("const THUMB_WIDTH = 24");
    expect(CHROME).toContain("const THUMB_HEIGHT = 16");
  });

  it("gives the track the host's 2px border", () => {
    // `border-2`, transparent when off — so the border counts toward the height and
    // the inner box is exactly the thumb's height.
    expect(CHROME).toContain("const TRACK_BORDER = 2");
    expect(CHROME).toMatch(/border: `\$\{TRACK_BORDER\}px solid transparent`/);
  });

  it("derives the thumb travel rather than hardcoding it", () => {
    // 44 − 4 − 24 = 16. A literal 16 would desync the moment a size changed.
    expect(CHROME).toContain("const THUMB_TRAVEL = TRACK_WIDTH - TRACK_BORDER * 2 - THUMB_WIDTH");
    expect(ADMIN).not.toContain('translateX(16px)');
  });

  it("reproduces the host's arithmetic", () => {
    const track = 44;
    const border = 2;
    const thumb = 24;
    expect(track - border * 2 - thumb).toBe(16);
  });
});
