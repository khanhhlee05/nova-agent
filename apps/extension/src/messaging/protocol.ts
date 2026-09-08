/**
 * Every message crossing an extension boundary is a discriminated union
 * validated on receipt. Paths are validated again against the route allowlist
 * by the receiver; a message can never turn an arbitrary string into a fetch
 * URL.
 *
 * Validation here is hand-written so the content script and service worker
 * stay dependency-free. The side panel validates bridge responses with Zod in
 * bridgeSchemas.ts.
 */

export const SYNC_PHASES = [
  "idle",
  "checking-session",
  "discovering-versions",
  "loading-courses",
  "loading-course-data",
  "normalizing",
  "comparing",
  "saving",
  "ready",
  "session-expired",
  "permission-required",
  "offline",
  "partial",
  "failed",
] as const;
export type SyncPhase = (typeof SYNC_PHASES)[number];

export const isSyncPhase = (value: unknown): value is SyncPhase => typeof value === "string" && (SYNC_PHASES as readonly string[]).includes(value);

export type NovaMessage =
  | { type: "OPEN_PANEL" }
  | { type: "PING" }
  | { type: "BRIGHTSPACE_FETCH"; path: string }
  | { type: "SYNC_REQUEST"; reason: "manual" | "auto" }
  | { type: "SYNC_PROGRESS"; phase: SyncPhase }
  | { type: "SYNC_RESULT"; phase: SyncPhase; unreadCount: number };

export type FetchBridgeFailure = "unsafe-path" | "network" | "timeout" | "no-tab" | "no-bridge";

export type FetchBridgeResult = { ok: true; response: import("@nova-agent/brightspace").RawResponse } | { ok: false; reason: FetchBridgeFailure };

/** chrome.storage.local key the side panel writes and the orb reads. Holds only a count. */
export const BADGE_STORAGE_KEY = "nova:unread";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

export const parseMessage = (value: unknown): NovaMessage | null => {
  if (!isRecord(value) || typeof value.type !== "string") return null;
  switch (value.type) {
    case "OPEN_PANEL":
    case "PING":
      return { type: value.type };
    case "BRIGHTSPACE_FETCH":
      return typeof value.path === "string" && value.path.length > 0 && value.path.length <= 2048 ? { type: "BRIGHTSPACE_FETCH", path: value.path } : null;
    case "SYNC_REQUEST":
      return value.reason === "manual" || value.reason === "auto" ? { type: "SYNC_REQUEST", reason: value.reason } : null;
    case "SYNC_PROGRESS":
      return isSyncPhase(value.phase) ? { type: "SYNC_PROGRESS", phase: value.phase } : null;
    case "SYNC_RESULT":
      return isSyncPhase(value.phase) && typeof value.unreadCount === "number" && Number.isInteger(value.unreadCount) && value.unreadCount >= 0
        ? { type: "SYNC_RESULT", phase: value.phase, unreadCount: value.unreadCount }
        : null;
    default:
      return null;
  }
};
