import type { BrightspaceError, SyncWarning } from "@nova-agent/brightspace";
import type { SyncPhase } from "../messaging/protocol";

/**
 * Explicit sync state machine.
 *
 *   idle → checking-session → discovering-versions → loading-courses
 *        → loading-course-data → normalizing → comparing → saving → ready
 *
 * Terminal or recoverable: session-expired | permission-required | offline | partial | failed
 */

export const RUNNING_PHASES: readonly SyncPhase[] = [
  "checking-session",
  "discovering-versions",
  "loading-courses",
  "loading-course-data",
  "normalizing",
  "comparing",
  "saving",
];

export const isRunningPhase = (phase: SyncPhase): boolean => RUNNING_PHASES.includes(phase);

export const PHASE_LABELS: Record<SyncPhase, string> = {
  idle: "Idle",
  "checking-session": "Checking your Brightspace session",
  "discovering-versions": "Discovering API versions",
  "loading-courses": "Loading courses",
  "loading-course-data": "Loading assignments, quizzes, and news",
  normalizing: "Organizing",
  comparing: "Comparing with your last visit",
  saving: "Saving locally",
  ready: "Up to date",
  "session-expired": "Brightspace session expired",
  "permission-required": "Connection requires authorization",
  offline: "Brightspace is unreachable",
  partial: "Some courses could not be refreshed",
  failed: "Refresh failed",
};

/** Data older than this triggers an automatic refresh when the panel opens. */
export const STALE_AFTER_MS = 15 * 60 * 1000;

export type SyncRuntimeState = {
  phase: SyncPhase;
  reason: "manual" | "auto" | null;
  progress: { completed: number; total: number } | null;
  error: BrightspaceError | null;
  warnings: SyncWarning[];
  failedCourseIds: string[];
  startedAt: string | null;
  finishedAt: string | null;
  newEventCount: number;
};

export const IDLE_STATE: SyncRuntimeState = {
  phase: "idle",
  reason: null,
  progress: null,
  error: null,
  warnings: [],
  failedCourseIds: [],
  startedAt: null,
  finishedAt: null,
  newEventCount: 0,
};

export const phaseForError = (error: BrightspaceError): Extract<SyncPhase, "session-expired" | "permission-required" | "offline" | "failed"> => {
  switch (error.kind) {
    case "session-expired":
      return "session-expired";
    case "permission-denied":
      return "permission-required";
    case "network":
      return "offline";
    default:
      return "failed";
  }
};

export const isStale = (lastSuccessfulSyncAt: string | null, now: Date, staleAfterMs = STALE_AFTER_MS): boolean =>
  !lastSuccessfulSyncAt || now.getTime() - new Date(lastSuccessfulSyncAt).getTime() > staleAfterMs;
