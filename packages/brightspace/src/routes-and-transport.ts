/** Lightweight barrel for the content script: allowlist + same-origin fetch only. */
export { validateApprovedPath, isApprovedBrightspacePath, isApprovedFilePath, routes, VILLANOVA_BRIGHTSPACE_ORIGIN } from "./routes";
export type { ApprovedBrightspacePath } from "./routes";
export { createSameOriginFetcher, toRawResponse } from "./transport";
export type { RawResponse, RawFetch } from "./transport";
export { createSameOriginFileFetcher, HARD_FILE_CAP_BYTES, FILE_TIMEOUT_MS } from "./files";
export type { RawFileResponse, RawFileFetch } from "./files";
