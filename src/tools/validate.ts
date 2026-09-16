/**
 * Argument validation for CodeGraph tool calls.
 *
 * Lives in its own module rather than inside `worker.ts` so it can be unit
 * tested without importing the worker, which calls `runWorker()` at module load
 * and would try to open a host RPC channel.
 *
 * The host validates plugin-tool arguments before dispatch, but this plugin is
 * the component that hands them to a child process, so it validates again rather
 * than trusting the boundary. Unknown keys are dropped — most importantly
 * `projectPath`, which no declared schema contains and which must never reach
 * the upstream call.
 */

import { MAX_ARG_STRING_CHARS } from "../constants.js";
import type { CodeGraphToolSpec } from "./catalog.js";

export type ArgumentValidation =
  | { ok: true; args: Record<string, unknown>; stripped: string[] }
  | { ok: false; error: string };

export function validateArguments(
  spec: CodeGraphToolSpec,
  raw: unknown,
): ArgumentValidation {
  // Only accept a plain-ish object; anything else is treated as no arguments,
  // which then fails the required-parameter check for tools that need one.
  const input = (
    typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw : {}
  ) as Record<string, unknown>;

  const args: Record<string, unknown> = {};
  const stripped: string[] = [];

  // Read own enumerable keys only, so a JSON `__proto__` key cannot become a
  // property of `args` through the prototype chain.
  for (const key of Object.keys(input)) {
    if (!Object.prototype.hasOwnProperty.call(spec.params, key)) {
      stripped.push(key);
    }
  }

  for (const [name, param] of Object.entries(spec.params)) {
    if (!Object.prototype.hasOwnProperty.call(input, name)) continue;
    const value = input[name];
    if (value === undefined || value === null) continue;

    switch (param.type) {
      case "string": {
        if (typeof value !== "string") {
          return { ok: false, error: `Parameter "${name}" must be a string` };
        }
        if (value.length > MAX_ARG_STRING_CHARS) {
          return {
            ok: false,
            error: `Parameter "${name}" exceeds ${MAX_ARG_STRING_CHARS} characters`,
          };
        }
        if (param.enum && !param.enum.includes(value)) {
          return {
            ok: false,
            error: `Parameter "${name}" must be one of: ${param.enum.join(", ")}`,
          };
        }
        args[name] = value;
        break;
      }
      case "number": {
        if (typeof value !== "number" || !Number.isFinite(value)) {
          return { ok: false, error: `Parameter "${name}" must be a number` };
        }
        args[name] = value;
        break;
      }
      case "boolean": {
        if (typeof value !== "boolean") {
          return { ok: false, error: `Parameter "${name}" must be a boolean` };
        }
        args[name] = value;
        break;
      }
    }
  }

  for (const required of spec.required) {
    if (args[required] === undefined) {
      return { ok: false, error: `Parameter "${required}" is required` };
    }
  }

  return { ok: true, args, stripped };
}
