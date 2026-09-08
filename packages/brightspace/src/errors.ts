export type BrightspaceError =
  | { kind: "session-expired" }
  | { kind: "permission-denied"; operation: string }
  | { kind: "not-found"; operation: string }
  | { kind: "rate-limited"; retryAt: string }
  | { kind: "network"; retryable: boolean; operation?: string }
  | { kind: "invalid-response"; operation: string; detail?: string }
  | { kind: "unsupported-api"; product: "lp" | "le" }
  | { kind: "pagination"; operation: string; reason: "loop" | "page-cap" | "unsafe-next" }
  | { kind: "unsafe-path"; path: string }
  | { kind: "partial-sync"; failedCourseIds: string[] };

/** Error wrapper so typed errors can be thrown and caught without losing the union. */
export class BrightspaceFailure extends Error {
  constructor(public readonly error: BrightspaceError) {
    super(describeError(error));
    this.name = "BrightspaceFailure";
  }
}

export const fail = (error: BrightspaceError): never => {
  throw new BrightspaceFailure(error);
};

export const isBrightspaceFailure = (value: unknown): value is BrightspaceFailure => value instanceof BrightspaceFailure;

export const toBrightspaceError = (value: unknown, operation = "unknown"): BrightspaceError => {
  if (isBrightspaceFailure(value)) return value.error;
  if (value instanceof Error && value.name === "AbortError") return { kind: "network", retryable: false, operation };
  return { kind: "network", retryable: true, operation };
};

export const describeError = (error: BrightspaceError): string => {
  switch (error.kind) {
    case "session-expired":
      return "Brightspace session expired. Sign in to Brightspace and try again.";
    case "permission-denied":
      return `Brightspace denied access to ${error.operation}.`;
    case "not-found":
      return `${error.operation} is unavailable for this course.`;
    case "rate-limited":
      return `Brightspace asked us to slow down until ${error.retryAt}.`;
    case "network":
      return error.retryable ? "Could not reach Brightspace." : "The request was cancelled.";
    case "invalid-response":
      return `Brightspace returned an unexpected response for ${error.operation}.`;
    case "unsupported-api":
      return `No supported ${error.product.toUpperCase()} API version was found.`;
    case "pagination":
      return `Stopped paging ${error.operation}: ${error.reason}.`;
    case "unsafe-path":
      return "Refused to request a path outside the Brightspace API allowlist.";
    case "partial-sync":
      return `${error.failedCourseIds.length} course(s) could not be refreshed.`;
  }
};

/** Errors that should end the whole sync rather than just one course. */
export const isFatalForSync = (error: BrightspaceError): boolean =>
  error.kind === "session-expired" || error.kind === "unsupported-api" || error.kind === "rate-limited";
