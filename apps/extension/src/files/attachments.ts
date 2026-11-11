import { ATTACHMENT_CAP_BYTES, FileFetchError, fetchFile, routes, type ApprovedBrightspacePath, type FileFailure, type RawFileFetch } from "@nova-agent/brightspace";
import type { AcademicItem, ItemAttachment } from "@nova-agent/core";
import type { AttachmentTextRecord, NovaDb } from "../storage/novaDb";
import { attachmentTextId, getAttachmentText, putAttachmentText } from "../storage/repositories";
import { EXTRACT_FAILURE_COPY, MAX_EXTRACTED_CHARS, extractText, type PdfReader } from "./extract";

/**
 * Reading one assignment file, start to finish, on this device: the cached
 * text if the file was read before, otherwise one download through the
 * student's own Brightspace session, text extraction, and a row in the
 * extension's storage. The bytes are dropped as soon as the text is out.
 */

export type AttachmentDeps = {
  db: NovaDb;
  scope: string;
  tenantOrigin: string;
  /** Null when nothing can serve files right now (no Brightspace tab, or a host without the file bridge). */
  fetchFile: RawFileFetch | null;
  /** The Brightspace LE API version the last refresh used, or null when there has been no refresh. */
  leVersion: () => Promise<string | null>;
  readPdf: PdfReader;
  now: () => Date;
};

export type AttachmentFailure = FileFailure | "no-bridge" | "no-version" | "bad-ids";

export type AttachmentOutcome = { ok: true; record: AttachmentTextRecord; cached: boolean } | { ok: false; reason: AttachmentFailure; message: string };

export const ATTACHMENT_FAILURE_COPY: Record<AttachmentFailure, string> = {
  "session-expired": "Brightspace asked you to sign in again. Sign in to Brightspace, then try again.",
  "permission-denied": "Brightspace would not let Nova download this file.",
  "not-found": "Brightspace no longer has this file.",
  "too-large": "This file is larger than 10 MB, so Nova did not download it.",
  "rate-limited": "Brightspace asked Nova to slow down. Try again in a minute.",
  network: "Nova could not download this file. Keep a Brightspace tab open and try again.",
  "unsafe-path": "Nova refused to request this file: its address is not one Nova is allowed to read.",
  "no-bridge": "Open Brightspace in a tab so Nova can download the file through your session.",
  "no-version": "Refresh Nova once, then try again.",
  "bad-ids": "Brightspace listed this file in a way Nova cannot request.",
};

/** The approved route for one file, or null when its ids are not ones the allowlist accepts. */
export const attachmentPath = (le: string, item: Pick<AcademicItem, "courseId" | "sourceId">, attachment: ItemAttachment): ApprovedBrightspacePath | null => {
  try {
    if (attachment.source === "instructor") return routes.dropboxAttachment(le, item.courseId, item.sourceId, attachment.id);
    return attachment.submissionId ? routes.submissionFile(le, item.courseId, item.sourceId, attachment.submissionId, attachment.id) : null;
  } catch {
    return null;
  }
};

export const readAttachment = async (deps: AttachmentDeps, item: AcademicItem, attachment: ItemAttachment, options: { force?: boolean } = {}): Promise<AttachmentOutcome> => {
  const failure = (reason: AttachmentFailure): AttachmentOutcome => ({ ok: false, reason, message: ATTACHMENT_FAILURE_COPY[reason] });
  if (!options.force) {
    const cached = await getAttachmentText(deps.db, item.key, attachment.id);
    // A cached read stays good while the file is the same one: same name, and the same size when Brightspace states it.
    if (cached && cached.name === attachment.name && (attachment.size === null || cached.bytes === attachment.size)) return { ok: true, record: cached, cached: true };
  }
  if (!deps.fetchFile) return failure("no-bridge");
  const le = await deps.leVersion();
  if (!le) return failure("no-version");
  const path = attachmentPath(le, item, attachment);
  if (!path) return failure("bad-ids");
  let file;
  try {
    file = await fetchFile(deps.fetchFile, path, { tenantOrigin: deps.tenantOrigin, maxBytes: ATTACHMENT_CAP_BYTES });
  } catch (error) {
    return failure(error instanceof FileFetchError ? error.reason : "network");
  }
  const extracted = await extractText(file.bytes, { name: attachment.name, contentType: file.contentType }, { readPdf: deps.readPdf }, MAX_EXTRACTED_CHARS);
  const record: AttachmentTextRecord = {
    id: attachmentTextId(item.key, attachment.id),
    itemKey: item.key,
    fileId: attachment.id,
    scope: deps.scope,
    name: attachment.name,
    kind: extracted.ok ? extracted.value.kind : null,
    parts: extracted.ok ? extracted.value.parts : [],
    truncated: extracted.ok ? extracted.value.truncated : false,
    failure: extracted.ok ? null : extracted.reason,
    bytes: file.size,
    extractedAt: deps.now().toISOString(),
  };
  await putAttachmentText(deps.db, record);
  return { ok: true, record, cached: false };
};

/** The text of a read file as one string, with page or slide marks where the file has them. */
export const attachmentBody = (record: Pick<AttachmentTextRecord, "parts" | "kind">): string =>
  record.parts.map((part) => (part.number === null ? part.text : `[${record.kind === "pptx" ? "Slide" : "Page"} ${part.number}]\n${part.text}`)).join("\n\n");

/** Why a read file has no text, for the student. Null when it has text. */
export const attachmentNote = (record: Pick<AttachmentTextRecord, "failure">): string | null => (record.failure ? EXTRACT_FAILURE_COPY[record.failure] : null);

/** "48 KB", "1.2 MB". */
export const formatBytes = (bytes: number | null): string => {
  if (bytes === null) return "size unknown";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};
