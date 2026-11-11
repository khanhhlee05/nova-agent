import { BrightspaceFailure, fail } from "./errors";
import { isApprovedFilePath, validateApprovedPath, type ApprovedBrightspacePath } from "./routes";
import type { RawResponse } from "./transport";

/**
 * File downloads. Kept apart from the JSON transport on purpose: a file is
 * only ever requested through a path the allowlist marks as a file route,
 * the body is capped while it streams, and nothing about the response is
 * kept except its bytes, type, and size.
 */

/** No file larger than this ever crosses the bridge, whatever a caller asks for. */
export const HARD_FILE_CAP_BYTES = 20 * 1024 * 1024;

/** The cap for a file attached to an assignment. */
export const ATTACHMENT_CAP_BYTES = 10 * 1024 * 1024;

export const FILE_TIMEOUT_MS = 30_000;

/** Sanitized view of a file response. The only file shape that crosses the content-script bridge. */
export type RawFileResponse = {
  status: number;
  contentType: string | null;
  redirected: boolean;
  /** Pathname of the final URL after redirects; never includes the query string. */
  finalPath: string | null;
  /** Bytes, from Content-Length or from what was read. Null when unknown. */
  size: number | null;
  /** Base64 of the body. Null when the status was not 2xx, the file was over the cap, or only the headers were asked for. */
  base64: string | null;
  /** True when the file is larger than the cap. Its body was not read. */
  tooLarge: boolean;
  headers: RawResponse["headers"];
};

export type RawFileFetchOptions = {
  signal: AbortSignal;
  /** Bytes to accept at most; clamped to `HARD_FILE_CAP_BYTES`. */
  maxBytes: number;
  /** Read the status, type, and size, and drop the body. For the feasibility probe. */
  headOnly?: boolean;
};

/** The lowest-level file request. Implementations must only accept approved file paths. */
export type RawFileFetch = (path: ApprovedBrightspacePath, options: RawFileFetchOptions) => Promise<RawFileResponse>;

const LOGIN_PATH = /\/d2l\/(login|lp\/auth|lp\/login|sso)/i;

const CHUNK = 0x8000;

/** Base64 without building one giant argument list: `btoa` over 32 KB slices. */
export const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += CHUNK) binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
  return btoa(binary);
};

export const base64ToBytes = (base64: string): Uint8Array => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
};

const clampCap = (maxBytes: number): number => Math.max(0, Math.min(Number.isFinite(maxBytes) ? Math.floor(maxBytes) : 0, HARD_FILE_CAP_BYTES));

/** Reads a body up to `cap` bytes. Returns null, having cancelled the stream, as soon as it runs past the cap. */
const readCapped = async (response: Response, cap: number): Promise<Uint8Array | null> => {
  if (!response.body) {
    const all = new Uint8Array(await response.arrayBuffer());
    return all.length > cap ? null : all;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > cap) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
};

/**
 * Same-origin credentialed file fetch for use inside a page on the tenant
 * origin (the content script). Cookies stay in the browser. A path that is
 * not an approved file route is refused before any request is made.
 */
export const createSameOriginFileFetcher = (tenantOrigin: string, fetchImpl: typeof fetch = fetch): RawFileFetch => {
  const origin = new URL(tenantOrigin).origin;
  return async (path, { signal, maxBytes, headOnly = false }) => {
    if (!isApprovedFilePath(path, origin)) fail({ kind: "unsafe-path", path: String(path) });
    const cap = clampCap(maxBytes);
    const response = await fetchImpl(`${origin}${path}`, { method: "GET", credentials: "include", redirect: "follow", headers: { Accept: "*/*" }, signal });
    let finalPath: string | null = null;
    try {
      finalPath = response.url ? new URL(response.url).pathname : null;
    } catch {
      finalPath = null;
    }
    const declared = Number(response.headers.get("content-length"));
    const base: Omit<RawFileResponse, "base64" | "tooLarge" | "size"> = {
      status: response.status,
      contentType: response.headers.get("content-type"),
      redirected: response.redirected,
      finalPath,
      headers: { retryAfter: response.headers.get("retry-after"), rateLimitRemaining: response.headers.get("x-rate-limit-remaining"), rateLimitReset: response.headers.get("x-rate-limit-reset") },
    };
    const known = Number.isFinite(declared) && declared >= 0 && response.headers.get("content-length") !== null ? declared : null;
    const drop = async (): Promise<void> => {
      await response.body?.cancel().catch(() => undefined);
    };
    if (!response.ok || headOnly) {
      await drop();
      return { ...base, size: known, base64: null, tooLarge: known !== null && known > cap };
    }
    if (known !== null && known > cap) {
      await drop();
      return { ...base, size: known, base64: null, tooLarge: true };
    }
    const bytes = await readCapped(response, cap);
    if (!bytes) return { ...base, size: known, base64: null, tooLarge: true };
    return { ...base, size: bytes.length, base64: bytesToBase64(bytes), tooLarge: false };
  };
};

export type FetchedFile = { bytes: Uint8Array; contentType: string | null; size: number };

/** Why a file could not be had, in the terms the panel shows. */
export type FileFailure = "session-expired" | "permission-denied" | "not-found" | "too-large" | "rate-limited" | "network" | "unsafe-path";

export class FileFetchError extends Error {
  constructor(public readonly reason: FileFailure) {
    super(`file fetch failed: ${reason}`);
    this.name = "FileFetchError";
  }
}

/** A login page instead of a file. Unlike the JSON transport, an HTML body alone proves nothing: the file may be HTML. */
const looksLikeLogin = (response: RawFileResponse): boolean => response.status === 401 || (response.finalPath !== null && LOGIN_PATH.test(response.finalPath));

/**
 * Fetches one file through a `RawFileFetch`, with a timeout and a size cap,
 * and maps every way it can fail to a `FileFetchError`. One attempt: a file
 * is fetched because the student asked, and a failure is shown to them.
 */
export const fetchFile = async (rawFileFetch: RawFileFetch, path: ApprovedBrightspacePath, options: { tenantOrigin?: string; maxBytes?: number; timeoutMs?: number } = {}): Promise<FetchedFile> => {
  if (!isApprovedFilePath(path, options.tenantOrigin)) throw new FileFetchError("unsafe-path");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? FILE_TIMEOUT_MS);
  let response: RawFileResponse;
  try {
    response = await rawFileFetch(path, { signal: controller.signal, maxBytes: clampCap(options.maxBytes ?? ATTACHMENT_CAP_BYTES) });
  } catch (error) {
    if (error instanceof BrightspaceFailure && error.error.kind === "unsafe-path") throw new FileFetchError("unsafe-path");
    throw new FileFetchError("network");
  } finally {
    clearTimeout(timer);
  }
  if (looksLikeLogin(response)) throw new FileFetchError("session-expired");
  if (response.status === 403) throw new FileFetchError("permission-denied");
  if (response.status === 404) throw new FileFetchError("not-found");
  if (response.status === 429) throw new FileFetchError("rate-limited");
  if (response.tooLarge) throw new FileFetchError("too-large");
  if (response.status < 200 || response.status >= 300 || response.base64 === null) throw new FileFetchError("network");
  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(response.base64);
  } catch {
    throw new FileFetchError("network");
  }
  return { bytes, contentType: response.contentType, size: bytes.length };
};

/** The operation a file path belongs to, for messages. */
export const fileOperation = (path: string, tenantOrigin?: string): string => validateApprovedPath(path, tenantOrigin)?.operation ?? "file";
