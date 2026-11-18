/**
 * What can go wrong fetching from a source, as the shell reports it. The
 * shell sends one of these shapes and nothing else: never a response body,
 * the key or a header.
 */
export type SyncProblem =
  /** No intervals.icu key in the Keychain. Not an error: the source isn't connected. */
  | { kind: "no_key" }
  | { kind: "key_rejected" }
  | { kind: "rate_limited"; retry_after_secs: number | null }
  | { kind: "offline" }
  | { kind: "unexpected"; detail: string };

/** A fetch that failed for a reason the app can name. */
export class SyncFailure extends Error {
  problem: SyncProblem;

  constructor(problem: SyncProblem) {
    super(problem.kind === "unexpected" ? problem.detail : problem.kind);
    this.name = "SyncFailure";
    this.problem = problem;
  }
}

/** A response that parsed as JSON but isn't laid out the way the source documents it. */
export class SourceShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceShapeError";
  }
}

const isDict = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Whatever a fetch or the reading of its response was rejected with, as a
 * problem: the shell's own shape, a `SyncFailure`, or any other error.
 * Anything unrecognised is `unexpected`.
 */
export function asProblem(thrown: unknown): SyncProblem {
  if (thrown instanceof SyncFailure) return thrown.problem;
  if (thrown instanceof Error) return { kind: "unexpected", detail: thrown.message };
  if (isDict(thrown)) {
    switch (thrown.kind) {
      case "no_key":
      case "key_rejected":
      case "offline":
        return { kind: thrown.kind };
      case "rate_limited": {
        const wait = thrown.retry_after_secs;
        return { kind: "rate_limited", retry_after_secs: typeof wait === "number" && Number.isFinite(wait) && wait >= 0 ? wait : null };
      }
      case "unexpected":
        return { kind: "unexpected", detail: typeof thrown.detail === "string" ? thrown.detail : "no detail given" };
    }
  }
  return { kind: "unexpected", detail: typeof thrown === "string" && thrown !== "" ? thrown : "no detail given" };
}
