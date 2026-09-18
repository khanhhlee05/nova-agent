/** Exact origins, or a prefix pattern ending in `*` such as `chrome-extension://*` (dev only). */
export const matchOrigin = (origin: string, patterns: readonly string[]): boolean =>
  patterns.some((pattern) => (pattern.endsWith("*") ? origin.startsWith(pattern.slice(0, -1)) && origin.length > pattern.length - 1 : origin === pattern));
