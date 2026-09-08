/** Lightweight barrel for the content script: allowlist + same-origin fetch only. */
export { validateApprovedPath, isApprovedBrightspacePath, routes, VILLANOVA_BRIGHTSPACE_ORIGIN } from "./routes";
export type { ApprovedBrightspacePath } from "./routes";
export { createSameOriginFetcher, toRawResponse } from "./transport";
export type { RawResponse, RawFetch } from "./transport";
