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

/** http(s) only, no trailing slash, no query or hash. Null when the value is not a usable API address. */
export const normalizeApiBaseUrl = (value: string): string | null => {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
};
