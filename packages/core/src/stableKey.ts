import type { ItemKind } from "./models";

export type StableKeyParts = {
  tenantOrigin: string;
  userId: string;
  kind: ItemKind | "announcement";
  courseId: string;
  sourceId: string;
};

const SEPARATOR = "|";

const clean = (value: string): string => value.replaceAll(SEPARATOR, "%7C");

/**
 * Builds the stable identity `{tenantOrigin}|{userId}|{kind}|{courseId}|{sourceId}`.
 * Items are never matched by title, so a rename is detected as an update, not a
 * removal plus addition.
 */
export const buildStableKey = ({ tenantOrigin, userId, kind, courseId, sourceId }: StableKeyParts): string =>
  [clean(normalizeOrigin(tenantOrigin)), clean(userId), kind, clean(courseId), clean(sourceId)].join(SEPARATOR);

export const parseStableKey = (key: string): StableKeyParts | null => {
  const parts = key.split(SEPARATOR);
  if (parts.length !== 5) return null;
  const [tenantOrigin, userId, kind, courseId, sourceId] = parts as [string, string, string, string, string];
  if (kind !== "assignment" && kind !== "quiz" && kind !== "announcement") return null;
  return { tenantOrigin, userId, kind, courseId, sourceId };
};

/** Lower-cases the host and strips any trailing slash so keys stay stable across builds. */
export const normalizeOrigin = (origin: string): string => {
  try {
    return new URL(origin).origin.toLowerCase();
  } catch {
    return origin.trim().replace(/\/+$/, "").toLowerCase();
  }
};
