import { fail } from "./errors";
import { validateApprovedPath, type ApprovedBrightspacePath } from "./routes";

/** Generous but finite. A course should never need this many pages. */
export const MAX_PAGES = 50;

export type BookmarkPage<T> = { PagingInfo: { Bookmark?: string | null; HasMoreItems: boolean }; Items: T[] };

/** Follows `PagingInfo.Bookmark` + `HasMoreItems` with loop protection. */
export const collectBookmarkPages = async <T>(
  operation: string,
  fetchPage: (bookmark: string | undefined) => Promise<BookmarkPage<T>>,
  maxPages = MAX_PAGES,
): Promise<T[]> => {
  const items: T[] = [];
  const seen = new Set<string>();
  let bookmark: string | undefined;
  for (let page = 0; ; page++) {
    if (page >= maxPages) fail({ kind: "pagination", operation, reason: "page-cap" });
    const result = await fetchPage(bookmark);
    items.push(...result.Items);
    if (!result.PagingInfo.HasMoreItems) return items;
    const next = result.PagingInfo.Bookmark ?? "";
    if (!next || seen.has(next)) fail({ kind: "pagination", operation, reason: "loop" });
    seen.add(next);
    bookmark = next;
  }
};

export type NextPage<T> = { Objects: T[]; Next?: string | null };

/**
 * Follows `Next` + `Objects`. The `Next` URL must have the tenant origin and
 * begin with `/d2l/api/`; anything else ends paging with a typed error.
 */
export const collectNextPages = async <T>(
  operation: string,
  tenantOrigin: string,
  firstPath: ApprovedBrightspacePath,
  fetchPage: (path: ApprovedBrightspacePath) => Promise<NextPage<T>>,
  maxPages = MAX_PAGES,
): Promise<T[]> => {
  const items: T[] = [];
  const seen = new Set<string>([firstPath]);
  let path = firstPath;
  for (let page = 0; ; page++) {
    if (page >= maxPages) fail({ kind: "pagination", operation, reason: "page-cap" });
    const result = await fetchPage(path);
    items.push(...result.Objects);
    if (!result.Next) return items;
    const approved = validateApprovedPath(result.Next, tenantOrigin);
    if (!approved) fail({ kind: "pagination", operation, reason: "unsafe-next" });
    const nextPath = (approved as NonNullable<typeof approved>).path;
    if (seen.has(nextPath)) fail({ kind: "pagination", operation, reason: "loop" });
    seen.add(nextPath);
    path = nextPath;
  }
};
