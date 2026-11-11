import { BrightspaceFailure, FileFetchError, HARD_FILE_CAP_BYTES, fetchFile, routes, type ApprovedBrightspacePath, type RawFileFetch } from "@nova-agent/brightspace";
import type { CourseMaterial } from "@nova-agent/core";
import type { MaterialTextRecord, MaterialTocRecord, NovaDb } from "../storage/novaDb";
import { listMaterialTocs, materialTextId, materialTocId, pruneMaterialTexts, putMaterialText, putMaterialToc } from "../storage/repositories";
import { ATTACHMENT_FAILURE_COPY, type AttachmentFailure } from "./attachments";
import { extractText, type PdfReader } from "./extract";
import { splitPassages } from "./search";

/**
 * Reading a course's Content area, on this device and only for a course the
 * student turned on: the table of contents by name, then each chosen file
 * once, its text cut into passages and stored, its bytes dropped.
 */

export const MATERIAL_READ_LIMITS = {
  /** Files read per course. Past this the student chooses which. */
  files: 60,
  /** Bytes downloaded per course, across all its files. */
  courseBytes: 150 * 1024 * 1024,
  /** Bytes per file; the bridge's own hard cap. */
  fileBytes: HARD_FILE_CAP_BYTES,
  /** Characters of text kept per file. */
  fileChars: 120_000,
} as const;

const READABLE = /\.(pdf|docx|pptx|html?|txt|md|markdown|csv|tex|rst)$/i;

/** A topic Nova can try to read: an uploaded file or a page with a name it knows how to open. */
export const isReadable = (material: CourseMaterial): boolean => (material.type === "file" || material.type === "page") && material.fileName !== null && READABLE.test(material.fileName);

/**
 * The topics that will be read for a course: readable ones the student has
 * not unticked, in course order, up to the per-course file limit.
 */
export const topicsToRead = (topics: readonly CourseMaterial[], excluded: ReadonlySet<string>): CourseMaterial[] => topics.filter((topic) => isReadable(topic) && !excluded.has(topic.id)).slice(0, MATERIAL_READ_LIMITS.files);

export type MaterialDeps = {
  db: NovaDb;
  scope: string;
  tenantOrigin: string;
  fetchFile: RawFileFetch | null;
  leVersion: () => Promise<string | null>;
  readPdf: PdfReader;
  now: () => Date;
};

export type MaterialOutcome = { ok: true; record: MaterialTextRecord; cached: boolean } | { ok: false; reason: AttachmentFailure; message: string };

const topicPath = (le: string, material: CourseMaterial): ApprovedBrightspacePath | null => {
  try {
    return routes.contentTopicFile(le, material.courseId, material.id);
  } catch {
    return null;
  }
};

/** A stored read is still good while the topic has not changed since. */
const fresh = (record: MaterialTextRecord | undefined, material: CourseMaterial): record is MaterialTextRecord => !!record && record.sourceUpdatedAt === material.updatedAt;

/** Reads one topic: from storage when it has not changed, otherwise one download, extraction, and a stored row of passages. */
export const readMaterial = async (deps: MaterialDeps, material: CourseMaterial, options: { force?: boolean } = {}): Promise<MaterialOutcome> => {
  const failure = (reason: AttachmentFailure): MaterialOutcome => ({ ok: false, reason, message: reason === "too-large" ? "This file is larger than 20 MB, so Nova did not download it." : ATTACHMENT_FAILURE_COPY[reason] });
  const id = materialTextId(deps.scope, material.courseId, material.id);
  if (!options.force) {
    const stored = await deps.db.materialText.get(id);
    if (fresh(stored, material)) return { ok: true, record: stored, cached: true };
  }
  if (!deps.fetchFile) return failure("no-bridge");
  const le = await deps.leVersion();
  if (!le) return failure("no-version");
  const path = topicPath(le, material);
  if (!path) return failure("bad-ids");
  let file;
  try {
    file = await fetchFile(deps.fetchFile, path, { tenantOrigin: deps.tenantOrigin, maxBytes: MATERIAL_READ_LIMITS.fileBytes });
  } catch (error) {
    return failure(error instanceof FileFetchError ? error.reason : "network");
  }
  const extracted = await extractText(file.bytes, { name: material.fileName ?? material.title, contentType: file.contentType }, { readPdf: deps.readPdf }, MATERIAL_READ_LIMITS.fileChars);
  const passages = extracted.ok ? splitPassages(extracted.value.parts) : [];
  const record: MaterialTextRecord = {
    id,
    scope: deps.scope,
    courseId: material.courseId,
    topicId: material.id,
    title: material.title,
    modulePath: [...material.modulePath],
    kind: extracted.ok ? extracted.value.kind : null,
    passages,
    chars: passages.reduce((sum, passage) => sum + passage.text.length, 0),
    truncated: extracted.ok ? extracted.value.truncated : false,
    failure: extracted.ok ? null : extracted.reason,
    bytes: file.size,
    extractedAt: deps.now().toISOString(),
    sourceUpdatedAt: material.updatedAt,
  };
  await putMaterialText(deps.db, record);
  return { ok: true, record, cached: false };
};

export type CourseReadProgress = { done: number; total: number; title: string | null };

export type CourseReadResult = {
  read: number;
  cached: number;
  /** Topics that could not be downloaded, with why. They are tried again next time. */
  failed: { title: string; message: string }[];
  /** True when reading stopped because the course reached its download limit. */
  stoppedAtLimit: boolean;
};

/**
 * Reads a course's chosen topics one after another, so Brightspace sees one
 * request at a time. Stops at the course's download limit, and at once when
 * the session has expired or Brightspace asks to slow down, because every
 * later file would fail the same way. Stored text for topics that are gone
 * or unticked is dropped.
 */
export const readCourse = async (deps: MaterialDeps, courseId: string, topics: readonly CourseMaterial[], excluded: ReadonlySet<string>, onProgress: (progress: CourseReadProgress) => void = () => undefined, signal?: AbortSignal): Promise<CourseReadResult> => {
  const chosen = topicsToRead(topics, excluded);
  await pruneMaterialTexts(deps.db, deps.scope, courseId, new Set(chosen.map((topic) => topic.id)));
  const result: CourseReadResult = { read: 0, cached: 0, failed: [], stoppedAtLimit: false };
  let bytes = 0;
  for (const [index, topic] of chosen.entries()) {
    if (signal?.aborted) break;
    if (bytes >= MATERIAL_READ_LIMITS.courseBytes) {
      result.stoppedAtLimit = true;
      break;
    }
    onProgress({ done: index, total: chosen.length, title: topic.title });
    const outcome = await readMaterial(deps, topic);
    if (outcome.ok) {
      bytes += outcome.record.bytes;
      if (outcome.cached) result.cached += 1;
      else result.read += 1;
      continue;
    }
    result.failed.push({ title: topic.title, message: outcome.message });
    if (outcome.reason === "session-expired" || outcome.reason === "rate-limited" || outcome.reason === "no-bridge" || outcome.reason === "no-version") break;
  }
  onProgress({ done: chosen.length, total: chosen.length, title: null });
  return result;
};

/** Fetches and stores one course's table of contents. `list` is the Brightspace client's `listMaterials`. */
export const refreshToc = async (db: NovaDb, scope: string, courseId: string, list: (courseId: string) => Promise<CourseMaterial[]>, now: () => Date): Promise<{ ok: true; record: MaterialTocRecord } | { ok: false; message: string }> => {
  try {
    const record: MaterialTocRecord = { id: materialTocId(scope, courseId), scope, courseId, topics: await list(courseId), fetchedAt: now().toISOString() };
    await putMaterialToc(db, record);
    return { ok: true, record };
  } catch (error) {
    const kind = error instanceof BrightspaceFailure ? error.error.kind : "network";
    const message =
      kind === "session-expired"
        ? ATTACHMENT_FAILURE_COPY["session-expired"]
        : kind === "permission-denied"
          ? "Brightspace would not let Nova list this course's materials."
          : kind === "not-found"
            ? "Brightspace has no Content area Nova can list for this course."
            : "Nova could not list this course's materials. Keep a Brightspace tab open and try again.";
    return { ok: false, message };
  }
};

/**
 * One file of a course whose table of contents is on this device, for the
 * file access check. Only courses the student turned on have one. Null when
 * there is nothing to try.
 */
export const firstMaterialPath = async (db: NovaDb, scope: string, le: string): Promise<ApprovedBrightspacePath | null> => {
  for (const record of await listMaterialTocs(db, scope)) {
    for (const material of record.topics) {
      const path = isReadable(material) ? topicPath(le, material) : null;
      if (path) return path;
    }
  }
  return null;
};
