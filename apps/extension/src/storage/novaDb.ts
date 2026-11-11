import Dexie, { type EntityTable } from "dexie";
import type { FeasibilityReport, ResolvedVersions, SyncWarning, BrightspaceError } from "@nova-agent/brightspace";
import type { AcademicSnapshot, ChangeEvent, CourseMaterial } from "@nova-agent/core";
import type { ExtractFailure, FileKind, TextPart } from "../files/extract";
import type { Passage } from "../files/search";
import type { SyncPhase } from "../messaging/protocol";
import type { AskMessage } from "../sidepanel/ask/thread";

/** Snapshot rows carry the tenant|user scope so multiple accounts never mix. */
export type StoredSnapshot = AcademicSnapshot & { scope: string };
export type StoredChangeEvent = ChangeEvent & { scope: string };

export type DataMode = "fixture" | "live";

export type SyncStatusRecord = {
  key: "current";
  mode: DataMode;
  phase: SyncPhase;
  /** Scope (tenant|user) of the data currently shown. */
  scope: string | null;
  displayName: string | null;
  lastSuccessfulSyncAt: string | null;
  lastAttemptedSyncAt: string | null;
  lastOutcome: Extract<SyncPhase, "ready" | "partial" | "session-expired" | "permission-required" | "offline" | "failed"> | null;
  error: BrightspaceError | null;
  failedCourseIds: string[];
  warnings: SyncWarning[];
};

export type PreferenceRecord = { key: string; value: unknown };

export type VersionCacheRecord = { tenantOrigin: string; value: ResolvedVersions };

export type FeasibilityRecord = { tenantOrigin: string; report: FeasibilityReport };

/**
 * A "done" mark the student set on this device. Brightspace is read-only, so
 * this never reaches the LMS; it is deleted as soon as Brightspace reports the
 * item as submitted or completed, or stops listing it.
 */
export type LocalMarkRecord = { key: string; scope: string; markedAt: string };

/**
 * A deadline the student typed in. Lives only here: never part of a snapshot,
 * never diffed, and shown only on the Week tab. Ask Nova, when it is on, gets
 * the title, date, course, and done flag in a list of its own.
 */
export type PersonalItemRecord = {
  id: string;
  scope: string;
  title: string;
  dueAt: string;
  /** A course of the student's, or null for "no course". */
  courseId: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** The study plan this deadline is a slot of, when it came from Ask Nova's "Add to Week". */
  planId?: string | null;
};

/**
 * One saved Ask Nova conversation. Written only while the student has
 * "Save conversations on this device" on; the messages are kept exactly as
 * the thread held them, rows included, so a saved answer re-renders as it was.
 */
export type ConversationRecord = {
  id: string;
  scope: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: AskMessage[];
};

/**
 * The text of one assignment file, extracted on this device after the student
 * asked for it. Kept so a second question does not download the file again.
 * A file that gave no text is remembered too, with the reason, for the same
 * purpose. The bytes themselves are never stored.
 */
export type AttachmentTextRecord = {
  /** `${itemKey}#${fileId}`. */
  id: string;
  itemKey: string;
  fileId: string;
  scope: string;
  name: string;
  /** Null when the file gave no text; `failure` says why. */
  kind: FileKind | null;
  parts: TextPart[];
  truncated: boolean;
  failure: ExtractFailure | null;
  /** Size of the file that was read, in bytes. */
  bytes: number;
  extractedAt: string;
};

/**
 * The table of contents of one course's Content area: topic names and
 * places only. Fetched for a course whose materials the student has Nova
 * read, and refreshed with the course.
 */
export type MaterialTocRecord = {
  /** `${scope}#${courseId}`. */
  id: string;
  scope: string;
  courseId: string;
  topics: CourseMaterial[];
  fetchedAt: string;
};

/**
 * The text of one Content topic, cut into passages, extracted on this device.
 * The search index is built from these rows. A topic that gave no text is
 * kept with the reason, so it is not downloaded again each time.
 */
export type MaterialTextRecord = {
  /** `${scope}#${courseId}#${topicId}`. */
  id: string;
  scope: string;
  courseId: string;
  topicId: string;
  title: string;
  modulePath: string[];
  kind: FileKind | null;
  passages: Passage[];
  /** Characters of text kept. */
  chars: number;
  truncated: boolean;
  failure: ExtractFailure | null;
  /** Size of the file that was read, in bytes. */
  bytes: number;
  extractedAt: string;
  /** The topic's last-modified time when it was read; a later one means it is read again. */
  sourceUpdatedAt: string | null;
};

/**
 * What the student thought of one answer. Kept on this device for the
 * project's own evaluation and exported by hand; never sent anywhere. It
 * holds the question, not the answer.
 */
export type AskFeedbackRecord = {
  /** `${scope}#${messageId}`. */
  id: string;
  scope: string;
  messageId: string;
  conversationId: string;
  verdict: "up" | "down";
  question: string;
  toolNames: string[];
  /** Whether the answer passed the check against the data; null when the turn did not report it. */
  grounded: boolean | null;
  /** True when a first draft was withdrawn and rewritten. */
  revised: boolean;
  model: string | null;
  /** Set when the answer was made on the device without a model. */
  offline: string | null;
  at: string;
};

export class NovaDb extends Dexie {
  snapshots!: EntityTable<StoredSnapshot, "id">;
  changeEvents!: EntityTable<StoredChangeEvent, "id">;
  syncStatus!: EntityTable<SyncStatusRecord, "key">;
  preferences!: EntityTable<PreferenceRecord, "key">;
  versionCache!: EntityTable<VersionCacheRecord, "tenantOrigin">;
  feasibility!: EntityTable<FeasibilityRecord, "tenantOrigin">;
  localMarks!: EntityTable<LocalMarkRecord, "key">;
  personalItems!: EntityTable<PersonalItemRecord, "id">;
  conversations!: EntityTable<ConversationRecord, "id">;
  attachmentText!: EntityTable<AttachmentTextRecord, "id">;
  materialToc!: EntityTable<MaterialTocRecord, "id">;
  materialText!: EntityTable<MaterialTextRecord, "id">;
  askFeedback!: EntityTable<AskFeedbackRecord, "id">;

  constructor(name = "nova-agent") {
    super(name);
    this.version(1).stores({
      snapshots: "id, scope, capturedAt, [scope+capturedAt]",
      changeEvents: "id, scope, fingerprint, detectedAt, readAt, [scope+fingerprint], [scope+detectedAt]",
      syncStatus: "key",
      preferences: "key",
      versionCache: "tenantOrigin",
      feasibility: "tenantOrigin",
    });
    this.version(2).stores({ localMarks: "key, scope" });
    this.version(3).stores({ personalItems: "id, scope, dueAt" });
    this.version(4).stores({ conversations: "id, scope, updatedAt" });
    this.version(5).stores({ attachmentText: "id, scope, itemKey, extractedAt" });
    this.version(6).stores({ materialToc: "id, scope", materialText: "id, scope, [scope+courseId]" });
    this.version(7).stores({ askFeedback: "id, scope, at" });
  }
}

export const createNovaDb = (name?: string): NovaDb => new NovaDb(name);
