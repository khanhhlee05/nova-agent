/**
 * Ask Nova settings live under their own preference key so the existing
 * UiPreferences shape and every test that spreads it stay untouched.
 */
export type AskSettings = {
  /** Off by default. Turning it on is the consent step: the setup card says what is sent where. */
  enabled: boolean;
  apiBaseUrl: string;
  /** Optional shared bearer token for a locally run API. Null when the API has none. */
  token: string | null;
};

export const ASK_SETTINGS_PREFERENCE = "ai.settings";

export const DEFAULT_ASK_SETTINGS: AskSettings = { enabled: false, apiBaseUrl: "http://localhost:8787", token: null };

export type ApiBaseUrlReason = "invalid" | "insecure";
export type ApiBaseUrlCheck = { url: string; reason: null } | { url: null; reason: ApiBaseUrlReason };

/** Hosts that never leave the machine, so plain http cannot expose the token or course data. `URL.hostname` keeps IPv6 brackets. */
const LOCAL_HOST = /^(localhost|[a-z0-9-]+\.localhost|127(\.\d{1,3}){3}|\[::1\])$/i;

/**
 * Validates an API address: http(s) only, no trailing slash, no query or
 * hash, and plain http only for local hosts. Course data and the bearer
 * token travel in the request, so a remote address must be https.
 */
export const checkApiBaseUrl = (value: string): ApiBaseUrlCheck => {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return { url: null, reason: "invalid" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { url: null, reason: "invalid" };
  if (url.protocol === "http:" && !LOCAL_HOST.test(url.hostname)) return { url: null, reason: "insecure" };
  return { url: `${url.origin}${url.pathname.replace(/\/+$/, "")}`, reason: null };
};

export const normalizeApiBaseUrl = (value: string): string | null => checkApiBaseUrl(value).url;

export const API_URL_MESSAGES: Record<ApiBaseUrlReason, string> = {
  invalid: "Enter the full address, starting with http:// or https://.",
  insecure: "This address must start with https://. Only a server on this computer (localhost) can use http://.",
};

/** "localhost:8787" from "http://localhost:8787", for showing an address in a sentence. */
export const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/** Settings saved before the https rule existed: a failing address turns Ask off so the setup card explains why. */
export const effectiveAskSettings = (settings: AskSettings): AskSettings => (normalizeApiBaseUrl(settings.apiBaseUrl) === null ? { ...settings, enabled: false } : settings);
