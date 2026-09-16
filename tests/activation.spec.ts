import { describe, expect, it } from "vitest";

import {
  describeActivation,
  isAlreadyExistsMessage,
  type ActivationSummary,
} from "../src/activation.js";

describe("isAlreadyExistsMessage", () => {
  it("recognizes the message Paperclip actually returns", () => {
    // The exact text reported from a live instance on a second press.
    expect(isAlreadyExistsMessage("A tool access record with that name already exists")).toBe(
      true,
    );
  });

  it("recognizes the other conflict wordings these routes produce", () => {
    expect(isAlreadyExistsMessage("duplicate key value violates unique constraint")).toBe(true);
    expect(isAlreadyExistsMessage("Tool profile already exists")).toBe(true);
    expect(isAlreadyExistsMessage("409 Conflict")).toBe(true);
  });

  it("does NOT swallow a real failure", () => {
    // Anything unrecognised must surface: a genuine error reported as a no-op
    // would be worse than the bug being fixed.
    expect(isAlreadyExistsMessage("Board access required")).toBe(false);
    expect(isAlreadyExistsMessage("repository is not inside any allowed root")).toBe(false);
    expect(isAlreadyExistsMessage("fetch failed")).toBe(false);
    expect(isAlreadyExistsMessage("")).toBe(false);
  });
});

describe("describeActivation", () => {
  const summary = (over: Partial<ActivationSummary> = {}): ActivationSummary => ({
    profileId: "p1",
    profile: "created",
    binding: "created",
    gateway: "created",
    ...over,
  });

  it("says so plainly on a first run", () => {
    expect(describeActivation(summary())).toMatch(/^Activated\./);
  });

  it("says 'already activated' when nothing changed, rather than pretending", () => {
    const text = describeActivation(
      summary({ profile: "already-existed", binding: "already-existed", gateway: "already-existed" }),
    );
    expect(text).toMatch(/already activated/);
  });

  it("reports a repair when only some records existed", () => {
    const text = describeActivation(
      summary({ profile: "already-existed", binding: "created", gateway: "created" }),
    );
    expect(text).toMatch(/Activated and repaired/);
  });

  it("never claims nothing happened when the profile was created", () => {
    const text = describeActivation(
      summary({ profile: "created", binding: "already-existed", gateway: "already-existed" }),
    );
    expect(text).not.toMatch(/already activated/);
  });
});
