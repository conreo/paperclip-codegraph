import { describe, expect, it } from "vitest";

import {
  describeActivation,
  findGateway,
  findProfileId,
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

describe("findProfileId", () => {
  it("reads the shape the API actually returns — { profiles: [...] }", () => {
    // routes/tool-access.ts: res.json({ profiles: await svc.listProfiles(companyId) })
    const response = {
      profiles: [
        { id: "other-id", profileKey: "something-else" },
        { id: "cde655fc-e744-4caa-ab24-29edb7ba1372", profileKey: "codegraph-read" },
      ],
    };
    expect(findProfileId(response, "codegraph-read")).toBe(
      "cde655fc-e744-4caa-ab24-29edb7ba1372",
    );
  });

  it("also accepts a bare array", () => {
    expect(findProfileId([{ id: "p1", profileKey: "codegraph-read" }], "codegraph-read")).toBe("p1");
  });

  it("returns null when the profile is absent", () => {
    expect(findProfileId({ profiles: [{ id: "p1", profileKey: "other" }] }, "codegraph-read")).toBeNull();
    expect(findProfileId({ profiles: [] }, "codegraph-read")).toBeNull();
  });

  it("returns null rather than throwing on anything unexpected", () => {
    for (const bad of [null, undefined, 42, "nope", {}, { profiles: "nope" }, { profiles: [null, 7] }]) {
      expect(findProfileId(bad, "codegraph-read"), JSON.stringify(bad)).toBeNull();
    }
  });

  it("ignores a row with a matching key but no usable id", () => {
    expect(findProfileId({ profiles: [{ profileKey: "codegraph-read" }] }, "codegraph-read")).toBeNull();
    expect(findProfileId({ profiles: [{ id: 7, profileKey: "codegraph-read" }] }, "codegraph-read")).toBeNull();
  });

  it("does not match a merely similar key", () => {
    expect(
      findProfileId({ profiles: [{ id: "p1", profileKey: "codegraph-read-only" }] }, "codegraph-read"),
    ).toBeNull();
  });
});

describe("findGateway", () => {
  it("reads the shape the API actually returns — { gateways: [...] }", () => {
    // routes/tool-gateway.ts: res.json({ gateways: await listNamedGateways(companyId) })
    const response = {
      gateways: [
        { id: "other", slug: "something-else", profileId: "p-other" },
        { id: "gw-1", slug: "codegraph", profileId: "cde655fc-e744-4caa-ab24-29edb7ba1372" },
      ],
    };
    expect(findGateway(response, "codegraph")).toEqual({
      id: "gw-1",
      profileId: "cde655fc-e744-4caa-ab24-29edb7ba1372",
    });
  });

  it("also accepts a bare array and displaySlug", () => {
    expect(findGateway([{ id: "gw-1", displaySlug: "codegraph" }], "codegraph")).toEqual({
      id: "gw-1",
      profileId: null,
    });
  });

  it("returns null when absent, so the caller creates one", () => {
    expect(findGateway({ gateways: [] }, "codegraph")).toBeNull();
    expect(findGateway({ gateways: [{ id: "x", slug: "other" }] }, "codegraph")).toBeNull();
  });

  it("returns null rather than throwing on anything unexpected", () => {
    for (const bad of [null, undefined, 1, "no", {}, { gateways: "no" }, { gateways: [null, 3] }]) {
      expect(findGateway(bad, "codegraph"), JSON.stringify(bad)).toBeNull();
    }
  });

  it("ignores a row with a matching slug but no id", () => {
    expect(findGateway({ gateways: [{ slug: "codegraph" }] }, "codegraph")).toBeNull();
  });
});

describe("describeActivation — a repaired gateway", () => {
  it("says the gateway was repointed rather than pretending it was fresh", () => {
    const text = describeActivation({
      profileId: "p1",
      profile: "already-existed",
      binding: "already-existed",
      gateway: "repointed",
    });
    expect(text).toMatch(/repaired/);
    expect(text).toMatch(/pointed at the current profile/);
  });
});
