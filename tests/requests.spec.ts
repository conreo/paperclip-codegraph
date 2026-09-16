import { describe, expect, it } from "vitest";

import {
  MAX_REQUESTS,
  RequestError,
  RequestStore,
  describeRequest,
  type RequestStateClient,
} from "../src/governance/requests.js";

/** An in-memory stand-in for `ctx.state`, mirroring its composite key. */
function fakeState() {
  const rows = new Map<string, unknown>();
  const keyOf = (input: { scopeKind: string; scopeId?: string; namespace?: string; stateKey: string }) =>
    [input.scopeKind, input.scopeId ?? "", input.namespace ?? "default", input.stateKey].join("::");
  const state: RequestStateClient = {
    async get(input) {
      return rows.get(keyOf(input)) ?? null;
    },
    async set(input, value) {
      rows.set(keyOf(input), structuredClone(value));
    },
  };
  return { state, rows };
}

const COMPANY = "company-a";
const OTHER_COMPANY = "company-b";
const NOW = "2026-09-16T08:00:00.000Z";
const LATER = "2026-09-16T09:00:00.000Z";

function store() {
  const { state, rows } = fakeState();
  return { requests: new RequestStore(state), rows };
}

function ask(
  requests: RequestStore,
  overrides: Partial<Parameters<RequestStore["create"]>[0]> = {},
) {
  return requests.create({
    companyId: COMPANY,
    agentId: "agent-1",
    agentName: "Backend",
    repository: "pos",
    reason: "Need to trace the checkout flow before changing it.",
    id: "req-1",
    now: NOW,
    ...overrides,
  });
}

describe("RequestStore.create", () => {
  it("records a pending request", async () => {
    const { requests } = store();
    const created = await ask(requests);
    expect(created.status).toBe("pending");
    expect(created.decidedAt).toBeNull();
    expect(created.appliedAt).toBeNull();
  });

  it("requires a repository", async () => {
    const { requests } = store();
    await expect(ask(requests, { repository: "   " })).rejects.toThrow(/repository is required/);
  });

  it("requires a reason, so the board has something to decide on", async () => {
    const { requests } = store();
    await expect(ask(requests, { reason: "  " })).rejects.toThrow(/reason is required/);
  });

  it("rejects a duplicate pending request from the same agent and repository", async () => {
    const { requests } = store();
    await ask(requests);
    await expect(ask(requests, { id: "req-2" })).rejects.toMatchObject({
      code: "duplicate_pending",
    });
  });

  it("allows the same agent to ask about a different repository", async () => {
    const { requests } = store();
    await ask(requests);
    await expect(
      ask(requests, { id: "req-2", repository: "identity" }),
    ).resolves.toMatchObject({ repository: "identity" });
  });

  it("allows a different agent to ask for the same repository", async () => {
    const { requests } = store();
    await ask(requests);
    await expect(ask(requests, { id: "req-2", agentId: "agent-2" })).resolves.toBeDefined();
  });

  it("allows a re-ask after a decision", async () => {
    const { requests } = store();
    await ask(requests);
    await requests.decide({
      companyId: COMPANY,
      requestId: "req-1",
      decision: "denied",
      decidedBy: "user-1",
      now: LATER,
    });
    await expect(ask(requests, { id: "req-2" })).resolves.toMatchObject({ status: "pending" });
  });

  it("keeps companies separate", async () => {
    const { requests } = store();
    await ask(requests);
    expect(await requests.list(OTHER_COMPANY)).toEqual([]);
    expect(await requests.list(COMPANY)).toHaveLength(1);
  });

  it("caps the queue so one agent cannot grow state without bound", async () => {
    const { requests } = store();
    for (let i = 0; i < MAX_REQUESTS + 10; i += 1) {
      await ask(requests, {
        id: `req-${i}`,
        agentId: `agent-${i}`,
        now: new Date(Date.parse(NOW) + i * 1000).toISOString(),
      });
    }
    expect(await requests.list(COMPANY)).toHaveLength(MAX_REQUESTS);
  });
});

describe("RequestStore.decide", () => {
  it("approves and records who and why", async () => {
    const { requests } = store();
    await ask(requests);
    const decided = await requests.decide({
      companyId: COMPANY,
      requestId: "req-1",
      decision: "approved",
      decidedBy: "user-1",
      decisionReason: "POS work is in scope",
      now: LATER,
    });
    expect(decided.status).toBe("approved");
    expect(decided.decidedBy).toBe("user-1");
    expect(decided.decidedAt).toBe(LATER);
    expect(decided.decisionReason).toBe("POS work is in scope");
  });

  it("normalizes a blank reason to null rather than an empty string", async () => {
    const { requests } = store();
    await ask(requests);
    const decided = await requests.decide({
      companyId: COMPANY,
      requestId: "req-1",
      decision: "denied",
      decidedBy: "user-1",
      decisionReason: "   ",
      now: LATER,
    });
    expect(decided.decisionReason).toBeNull();
  });

  it("refuses to decide twice, preserving the first reason", async () => {
    const { requests } = store();
    await ask(requests);
    await requests.decide({
      companyId: COMPANY,
      requestId: "req-1",
      decision: "approved",
      decidedBy: "user-1",
      decisionReason: "yes",
      now: LATER,
    });
    await expect(
      requests.decide({
        companyId: COMPANY,
        requestId: "req-1",
        decision: "denied",
        decidedBy: "user-2",
        decisionReason: "actually no",
        now: LATER,
      }),
    ).rejects.toMatchObject({ code: "already_decided" });

    const [only] = await requests.list(COMPANY);
    expect(only?.status).toBe("approved");
    expect(only?.decisionReason).toBe("yes");
  });

  it("reports an unknown request", async () => {
    const { requests } = store();
    await expect(
      requests.decide({
        companyId: COMPANY,
        requestId: "nope",
        decision: "approved",
        decidedBy: "user-1",
        now: LATER,
      }),
    ).rejects.toBeInstanceOf(RequestError);
  });

  it("cannot decide another company's request", async () => {
    const { requests } = store();
    await ask(requests);
    await expect(
      requests.decide({
        companyId: OTHER_COMPANY,
        requestId: "req-1",
        decision: "approved",
        decidedBy: "user-1",
        now: LATER,
      }),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("RequestStore.markApplied", () => {
  it("records a successful application", async () => {
    const { requests } = store();
    await ask(requests);
    await requests.decide({
      companyId: COMPANY,
      requestId: "req-1",
      decision: "approved",
      decidedBy: "user-1",
      now: LATER,
    });
    const applied = await requests.markApplied({
      companyId: COMPANY,
      requestId: "req-1",
      now: LATER,
    });
    expect(applied.appliedAt).toBe(LATER);
    expect(applied.applyError).toBeNull();
  });

  it("distinguishes approved-but-not-applied from a working approval", async () => {
    const { requests } = store();
    await ask(requests);
    await requests.decide({
      companyId: COMPANY,
      requestId: "req-1",
      decision: "approved",
      decidedBy: "user-1",
      now: LATER,
    });
    const failed = await requests.markApplied({
      companyId: COMPANY,
      requestId: "req-1",
      now: LATER,
      error: "repository is not inside any allowed root",
    });
    // The decision stands, but the failure is visible rather than hidden behind
    // an "approved" status.
    expect(failed.status).toBe("approved");
    expect(failed.appliedAt).toBeNull();
    expect(failed.applyError).toMatch(/allowed root/);
  });
});

describe("RequestStore.prune", () => {
  it("drops an old decided request but keeps pending ones", async () => {
    const { requests } = store();
    await ask(requests);
    await requests.decide({
      companyId: COMPANY,
      requestId: "req-1",
      decision: "denied",
      decidedBy: "user-1",
      now: NOW,
    });
    await ask(requests, { id: "req-2", agentId: "agent-2", now: NOW });

    const muchLater = "2027-06-01T00:00:00.000Z";
    const kept = await requests.prune(COMPANY, muchLater);

    // The decided one aged out; the pending one is never dropped, because it is
    // somebody's outstanding work.
    expect(kept.map((entry) => entry.id)).toEqual(["req-2"]);
  });
});

describe("RequestStore robustness", () => {
  it("drops a malformed stored row instead of trusting it", async () => {
    const { state, rows } = fakeState();
    rows.set(`company::${COMPANY}::access-requests::queue`, [
      { id: "good", companyId: COMPANY, agentId: "a", repository: "pos", status: "pending" },
      { id: "bad", status: "escalated" },
      "not an object",
      null,
    ]);
    const requests = new RequestStore(state);
    const listed = await requests.list(COMPANY);
    expect(listed.map((entry) => entry.id)).toEqual(["good"]);
  });

  it("treats a non-array stored value as empty", async () => {
    const { state, rows } = fakeState();
    rows.set(`company::${COMPANY}::access-requests::queue`, { nope: true });
    expect(await new RequestStore(state).list(COMPANY)).toEqual([]);
  });
});

describe("describeRequest", () => {
  it("tells a pending agent not to retry", async () => {
    const { requests } = store();
    const created = await ask(requests);
    const text = describeRequest(created, undefined);
    expect(text).toMatch(/recorded/);
    expect(text).toMatch(/not an error and needs no retry/);
  });

  it("carries the denial reason so the agent can change its ask", async () => {
    const { requests } = store();
    const created = await ask(requests);
    const denied = { ...created, status: "denied" as const, decisionReason: "POS only for now" };
    const text = describeRequest(created, denied);
    expect(text).toMatch(/denied/);
    expect(text).toMatch(/POS only for now/);
    expect(text).toMatch(/Do not repeat the same request/);
  });
});
