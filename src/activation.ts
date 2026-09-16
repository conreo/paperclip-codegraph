/**
 * Activating CodeGraph in Paperclip is a create-then-bind-then-create sequence
 * against three board-owned objects. Every one of them fails with a conflict
 * error on a second run, which made the Activate button error the second time it
 * was pressed even though its own copy promised "safe to run twice".
 *
 * A governance button that throws when pressed twice teaches people to distrust
 * it, so the conflict cases are classified here — in a pure, testable function
 * rather than buried in the component — and treated as success by the caller.
 */

/** The profile key the plugin owns. Stable: a rename abandons the old profile. */
export const PROFILE_KEY = "codegraph-read";

/** The gateway slug the plugin owns. Unique per company in Paperclip. */
export const GATEWAY_SLUG = "codegraph";

export const GATEWAY_NAME = "CodeGraph";

/**
 * Whether an error means "this already exists", i.e. a previous activation
 * already did this step.
 *
 * Matched on text because Paperclip does not return a stable conflict code for
 * these routes: `POST /tools/profiles` answers 400 with a message, not 409. The
 * match is deliberately narrow, and anything unrecognised is rethrown rather
 * than swallowed — a real failure must not look like a no-op.
 */
export function isAlreadyExistsMessage(message: string): boolean {
  return /already exists|duplicate key|unique constraint|conflict/i.test(message);
}

/** One step's outcome, so the caller can report what actually happened. */
export type StepOutcome = "created" | "already-existed";

export interface ActivationSummary {
  profileId: string;
  profile: StepOutcome;
  binding: StepOutcome;
  gateway: StepOutcome;
}

/**
 * What to tell the operator.
 *
 * Deliberately distinguishes a first run from a repeat one: "activated" on a
 * no-op press would leave someone wondering whether anything happened.
 */
export function describeActivation(summary: ActivationSummary): string {
  const repeat =
    summary.profile === "already-existed" &&
    summary.binding === "already-existed" &&
    summary.gateway === "already-existed";
  const partial = [summary.profile, summary.binding, summary.gateway].some(
    (step) => step === "created",
  );

  if (repeat) {
    return "CodeGraph was already activated — nothing to do. Agents working in a Paperclip project have its tools.";
  }
  if (partial && summary.profile === "created") {
    return "Activated. Agents working in a Paperclip project now have CodeGraph for that project's repository.";
  }
  return "Activated and repaired: some records already existed. Agents working in a Paperclip project now have CodeGraph.";
}
