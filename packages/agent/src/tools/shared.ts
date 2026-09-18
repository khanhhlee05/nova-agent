import type { CompactAnnouncement, CompactChange, CompactCourse, CompactItem, CompactSnapshot, ToolName, ToolRow } from "@nova-agent/protocol";
import { z } from "zod";

export type ToolContext = { snapshot: CompactSnapshot };

export type ToolResult = { ok: true; summary: string; data: unknown; rows: ToolRow[] } | { ok: false; error: string };

export type ToolSpec<I = unknown> = {
  name: ToolName;
  description: string;
  input: z.ZodType<I, unknown>;
  /** OpenAI-style JSON schema for `input`, derived from the zod schema. */
  jsonSchema: Record<string, unknown>;
  run(input: I, context: ToolContext): ToolResult;
};

/** Rows and data are capped so one tool result stays well under 2 KB of context. */
export const MAX_ROWS = 25;

export const toJsonSchema = (schema: z.ZodType): Record<string, unknown> => {
  const { $schema: _dropped, ...rest } = z.toJSONSchema(schema, { io: "input" }) as Record<string, unknown> & { $schema?: string };
  void _dropped;
  return rest;
};

export const defineTool = <I>(spec: Omit<ToolSpec<I>, "jsonSchema">): ToolSpec<I> => ({ ...spec, jsonSchema: toJsonSchema(spec.input) });

export const normalize = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

export const courseName = (snapshot: CompactSnapshot, id: string): string => snapshot.courses.find((course) => course.id === id)?.name ?? "Course";

const courseList = (snapshot: CompactSnapshot): string => snapshot.courses.map((course) => `${course.name} (id ${course.id})`).join(", ");

/** Resolves a course by id, code, or a case-insensitive name fragment. */
export const resolveCourse = (snapshot: CompactSnapshot, ref: string | undefined): { course: CompactCourse | null; error: string | null } => {
  if (!ref || ref.trim() === "") return { course: null, error: null };
  const wanted = ref.trim();
  const byId = snapshot.courses.find((course) => course.id === wanted);
  if (byId) return { course: byId, error: null };
  const lower = normalize(wanted);
  const byCode = snapshot.courses.find((course) => course.code && normalize(course.code) === lower);
  if (byCode) return { course: byCode, error: null };
  const byName = snapshot.courses.filter((course) => normalize(course.name).includes(lower) || lower.includes(normalize(course.name)));
  if (byName.length === 1) return { course: byName[0] as CompactCourse, error: null };
  if (byName.length > 1) return { course: null, error: `"${wanted}" matches several courses: ${byName.map((course) => course.name).join(", ")}. Use the id.` };
  return { course: null, error: `No course matches "${wanted}". Courses: ${courseList(snapshot)}.` };
};

/**
 * Exact normalized substring first, then token overlap where rarer words
 * weigh more ("fourier" beats "homework"), active items before done ones.
 */
export const findItems = (snapshot: CompactSnapshot, titleQuery: string): CompactItem[] => {
  const query = normalize(titleQuery);
  if (query === "") return [];
  const exact = snapshot.items.filter((item) => normalize(item.title).includes(query));
  if (exact.length > 0) return exact;
  const tokens = query.split(" ").filter((token) => token.length > 1);
  if (tokens.length === 0) return [];
  const wordsOf = new Map(snapshot.items.map((item) => [item.id, new Set(normalize(item.title).split(" "))]));
  const frequency = (token: string) => snapshot.items.filter((item) => wordsOf.get(item.id)?.has(token)).length;
  const weight = new Map(tokens.map((token) => [token, frequency(token) > 0 ? 1 / frequency(token) : 0]));
  return snapshot.items
    .map((item) => {
      const words = wordsOf.get(item.id) ?? new Set<string>();
      return { item, score: tokens.reduce((sum, token) => sum + (words.has(token) ? (weight.get(token) ?? 0) : 0), 0) };
    })
    .filter((entry) => entry.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        Number(a.item.bucket === "completed") - Number(b.item.bucket === "completed") ||
        (a.item.dueAt ?? "~").localeCompare(b.item.dueAt ?? "~"),
    )
    .map((entry) => entry.item);
};

export const itemRow = (snapshot: CompactSnapshot, item: CompactItem): ToolRow => ({
  kind: "item",
  id: item.id,
  title: item.title,
  courseId: item.courseId,
  courseName: courseName(snapshot, item.courseId),
  itemKind: item.kind,
  dueAt: item.dueAt,
  dueLocal: item.dueLocal,
  bucket: item.bucket,
  status: item.status,
  url: item.url,
  priority: item.priority,
});

export const announcementRow = (snapshot: CompactSnapshot, announcement: CompactAnnouncement): ToolRow => ({
  kind: "announcement",
  id: announcement.id,
  title: announcement.title,
  courseId: announcement.courseId,
  courseName: courseName(snapshot, announcement.courseId),
  createdAt: announcement.createdAt,
  createdLocal: announcement.createdLocal,
  pinned: announcement.pinned,
  url: announcement.url,
});

export const changeRow = (snapshot: CompactSnapshot, change: CompactChange): ToolRow => {
  const item = change.itemId ? snapshot.items.find((candidate) => candidate.id === change.itemId) : undefined;
  return {
    kind: "change",
    id: change.id,
    changeKind: change.kind,
    title: change.title,
    courseId: change.courseId,
    courseName: courseName(snapshot, change.courseId),
    detectedAt: change.detectedAt,
    detectedLocal: change.detectedLocal,
    before: change.before,
    after: change.after,
    url: item?.url ?? null,
  };
};

/** The terse shape the model reads. Local dates only; the UI formats ISO dates itself. */
export const itemData = (snapshot: CompactSnapshot, item: CompactItem) => ({
  id: item.id,
  title: item.title,
  course: courseName(snapshot, item.courseId),
  kind: item.kind,
  due: item.dueLocal ?? "no due date",
  dueDate: item.dueDate,
  bucket: item.bucket,
  status: item.status,
  points: item.pointsPossible,
  priority: item.priority,
});

export const changeData = (snapshot: CompactSnapshot, change: CompactChange) => ({
  id: change.id,
  kind: change.kind,
  title: change.title,
  course: courseName(snapshot, change.courseId),
  detected: change.detectedLocal,
  daysAgo: change.daysAgo,
  before: change.before ? { due: change.before.dueLocal ?? change.before.dueAt, status: change.before.status, visibility: change.before.visibility } : null,
  after: change.after ? { due: change.after.dueLocal ?? change.after.dueAt, status: change.after.status, visibility: change.after.visibility } : null,
  read: change.read,
});

export const plural = (count: number, one: string, many = `${one}s`): string => `${count} ${count === 1 ? one : many}`;

export const dueOrder = (a: CompactItem, b: CompactItem): number => (a.dueAt ?? "~").localeCompare(b.dueAt ?? "~") || a.title.localeCompare(b.title);
