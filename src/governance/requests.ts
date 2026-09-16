/**
 * Agent access requests.
 *
 * An agent that has no CodeGraph grant needs a way to *ask* — otherwise the only
 * path to access is an admin noticing. So there is a tool for it, and that tool
 * is deliberately **not** gated by CodeGraph's own governance: an agent must be
 * able to request access without already having it. (It is still subject to
 * Paperclip's own profile, which is why Activate includes it.)
 *
 * A request is a durable record a human decides on, so the store is pure logic
 * over a pluggable key/value backend — `ctx.state` in production, an in-memory
 * map in tests. Nothing here reads the clock or generates ids by itself, so
 * every transition is deterministic and testable.
 *
 * Decisions are recorded, never inferred: a request carries who decided it, when,
 * and why, because "why was this agent denied" is the question that gets asked
 * afterwards.
 */

/** The composite `ctx.state` key. Declared locally so this module has no deps. */
export interface RequestScopeKey {
  scopeKind: "company";
  scopeId: string;
  namespace: string;
  stateKey: string;
}

export type AccessRequestStatus = "pending" | "approved" | "denied";

export interface AccessRequest {
  id: string;
  companyId: string;
  agentId: string;
  /** Resolved at request time so the board sees a name, not a uuid. */
  agentName: string | null;
  /** Repository the agent asked for, as it typed it. */
  repository: string;
  reason: string;
  status: AccessRequestStatus;
  createdAt: string;
  decidedAt: string | null;
  /** Agent or user id that decided it. */
  decidedBy: string | null;
  decisionReason: string | null;
  /**
   * For an approved request, whether the grant was actually written. Kept
   * separate from `status` so a failure to apply is visible rather than looking
   * like an approved-and-working request.
   */
  appliedAt: string | null;
  applyError: string | null;
}

/** The minimal slice of `ctx.state` this needs. */
export interface RequestStateClient {
  get(input: RequestScopeKey): Promise<unknown>;
  set(input: RequestScopeKey, value: unknown): Promise<void>;
}

export const REQUESTS_NAMESPACE = "access-requests";
export const REQUESTS_KEY = "queue";

/** Bounded so one company cannot grow the state row without limit. */
export const MAX_REQUESTS = 200;
/** A pending request older than this is treated as stale by `prune`. */
export const REQUEST_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export class RequestError extends Error {
  constructor(
    message: string,
    readonly code:
      | "not_found"
      | "already_decided"
      | "invalid_input"
      | "duplicate_pending",
  ) {
    super(message);
    this.name = "RequestError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate a stored row.
 *
 * A malformed entry is dropped rather than trusted, so a hand-edited state row
 * cannot inject a status the rest of the code does not understand.
 */
function parseRequest(value: unknown): AccessRequest | null {
  if (!isRecord(value)) return null;
  const id = value["id"];
  const companyId = value["companyId"];
  const agentId = value["agentId"];
  const repository = value["repository"];
  const status = value["status"];
  if (
    typeof id !== "string" ||
    typeof companyId !== "string" ||
    typeof agentId !== "string" ||
    typeof repository !== "string" ||
    (status !== "pending" && status !== "approved" && status !== "denied")
  ) {
    return null;
  }
  return {
    id,
    companyId,
    agentId,
    agentName: typeof value["agentName"] === "string" ? value["agentName"] : null,
    repository,
    reason: typeof value["reason"] === "string" ? value["reason"] : "",
    status,
    createdAt: typeof value["createdAt"] === "string" ? value["createdAt"] : "",
    decidedAt: typeof value["decidedAt"] === "string" ? value["decidedAt"] : null,
    decidedBy: typeof value["decidedBy"] === "string" ? value["decidedBy"] : null,
    decisionReason:
      typeof value["decisionReason"] === "string" ? value["decisionReason"] : null,
    appliedAt: typeof value["appliedAt"] === "string" ? value["appliedAt"] : null,
    applyError: typeof value["applyError"] === "string" ? value["applyError"] : null,
  };
}

export interface CreateRequestInput {
  companyId: string;
  agentId: string;
  agentName?: string | null;
  repository: string;
  reason: string;
  /** Injected so the store stays deterministic under test. */
  id: string;
  now: string;
}

export class RequestStore {
  constructor(private readonly state: RequestStateClient) {}

  private key(companyId: string): RequestScopeKey {
    return {
      scopeKind: "company",
      scopeId: companyId,
      namespace: REQUESTS_NAMESPACE,
      stateKey: REQUESTS_KEY,
    };
  }

  async list(companyId: string): Promise<AccessRequest[]> {
    const raw = await this.state.get(this.key(companyId));
    if (!Array.isArray(raw)) return [];
    return raw
      .map(parseRequest)
      .filter((entry): entry is AccessRequest => entry !== null);
  }

  private async write(companyId: string, requests: AccessRequest[]): Promise<void> {
    // Keep the newest MAX_REQUESTS, so a chatty agent cannot grow the row
    // without bound.
    const trimmed = [...requests]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(-MAX_REQUESTS);
    await this.state.set(this.key(companyId), trimmed);
  }

  /**
   * Record a request.
   *
   * A second pending request from the same agent for the same repository is
   * rejected rather than queued: duplicates would just be noise for whoever has
   * to decide, and the agent already has an answer coming.
   */
  async create(input: CreateRequestInput): Promise<AccessRequest> {
    const repository = input.repository.trim();
    const reason = input.reason.trim();
    if (repository.length === 0) {
      throw new RequestError("A repository is required", "invalid_input");
    }
    if (reason.length === 0) {
      throw new RequestError(
        "A reason is required — say what you need it for",
        "invalid_input",
      );
    }

    const existing = await this.list(input.companyId);
    const duplicate = existing.find(
      (entry) =>
        entry.status === "pending" &&
        entry.agentId === input.agentId &&
        entry.repository === repository,
    );
    if (duplicate) {
      throw new RequestError(
        `A request for "${repository}" is already pending (${duplicate.id}).`,
        "duplicate_pending",
      );
    }

    const request: AccessRequest = {
      id: input.id,
      companyId: input.companyId,
      agentId: input.agentId,
      agentName: input.agentName ?? null,
      repository,
      reason,
      status: "pending",
      createdAt: input.now,
      decidedAt: null,
      decidedBy: null,
      decisionReason: null,
      appliedAt: null,
      applyError: null,
    };

    await this.write(input.companyId, [...existing, request]);
    return request;
  }

  /**
   * Record a decision.
   *
   * Idempotence is deliberately absent: deciding twice is a mistake worth
   * surfacing, not silently accepting, because the second decision would
   * otherwise overwrite the reason the first one recorded.
   */
  async decide(input: {
    companyId: string;
    requestId: string;
    decision: "approved" | "denied";
    decidedBy: string;
    decisionReason?: string | null;
    now: string;
  }): Promise<AccessRequest> {
    const requests = await this.list(input.companyId);
    const index = requests.findIndex((entry) => entry.id === input.requestId);
    if (index === -1) {
      throw new RequestError(`No request ${input.requestId}`, "not_found");
    }
    const current = requests[index]!;
    if (current.status !== "pending") {
      throw new RequestError(
        `Request ${input.requestId} was already ${current.status}`,
        "already_decided",
      );
    }

    const decided: AccessRequest = {
      ...current,
      status: input.decision,
      decidedAt: input.now,
      decidedBy: input.decidedBy,
      decisionReason: input.decisionReason?.trim() || null,
    };
    requests[index] = decided;
    await this.write(input.companyId, requests);
    return decided;
  }

  /**
   * Record whether an approved grant was actually applied.
   *
   * Kept separate from the decision so a failure to write the grant shows as
   * "approved but not applied" rather than as a working approval.
   */
  async markApplied(input: {
    companyId: string;
    requestId: string;
    now: string;
    error?: string | null;
  }): Promise<AccessRequest> {
    const requests = await this.list(input.companyId);
    const index = requests.findIndex((entry) => entry.id === input.requestId);
    if (index === -1) {
      throw new RequestError(`No request ${input.requestId}`, "not_found");
    }
    const updated: AccessRequest = {
      ...requests[index]!,
      appliedAt: input.error ? null : input.now,
      applyError: input.error ?? null,
    };
    requests[index] = updated;
    await this.write(input.companyId, requests);
    return updated;
  }

  /** Drop decided requests older than the TTL. Returns what survived. */
  async prune(companyId: string, now: string): Promise<AccessRequest[]> {
    const cutoff = new Date(new Date(now).getTime() - REQUEST_TTL_MS).toISOString();
    const requests = await this.list(companyId);
    const kept = requests.filter(
      (entry) => entry.status === "pending" || entry.createdAt >= cutoff,
    );
    if (kept.length !== requests.length) await this.write(companyId, kept);
    return kept;
  }
}

/**
 * What the requesting agent is told.
 *
 * Phrased so an agent understands the outcome and does not simply retry: a
 * pending request is not an error, and a denial names the reason so the agent can
 * change its ask rather than repeat it.
 */
export function describeRequest(
  request: AccessRequest,
  existing: AccessRequest | undefined,
): string {
  if (existing && existing.status === "denied") {
    return [
      `Your request for CodeGraph access to "${request.repository}" was denied.`,
      existing.decisionReason ? `Reason: ${existing.decisionReason}` : null,
      "Do not repeat the same request; ask a board member if you need it reconsidered.",
    ]
      .filter(Boolean)
      .join("\n");
  }
  return [
    `Access request recorded for "${request.repository}" (id ${request.id}).`,
    "A board member will approve or deny it. It is not an error and needs no retry.",
    "Until then, CodeGraph tools will not answer for you.",
  ].join("\n");
}
