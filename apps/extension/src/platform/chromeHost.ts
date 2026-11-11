import { BrightspaceFailure, HARD_FILE_CAP_BYTES, isApprovedBrightspacePath, isApprovedFilePath, isSafeTenantLink, type RawFetch, type RawFileFetch } from "@nova-agent/brightspace";
import { idTokenFromRedirect } from "./googleSignIn";
import { fetchBridgeResultSchema, fileBridgeResultSchema, pingResultSchema } from "../messaging/bridgeSchemas";
import { BADGE_STORAGE_KEY, type NovaMessage, type SyncPhase } from "../messaging/protocol";
import type { ExtensionHost } from "./host";

const tabPattern = (origin: string): string => `${origin}/*`;

const findBrightspaceTabs = async (origin: string): Promise<chrome.tabs.Tab[]> => {
  const tabs = await chrome.tabs.query({ url: tabPattern(origin) });
  return tabs.filter((tab) => typeof tab.id === "number").sort((a, b) => Number(b.active) - Number(a.active));
};

const sendToTab = async <T>(tabId: number, message: NovaMessage): Promise<T | null> => {
  try {
    return (await chrome.tabs.sendMessage(tabId, message)) as T;
  } catch {
    return null;
  }
};

export const createChromeHost = (tenantOrigin: string): ExtensionHost => {
  const origin = new URL(tenantOrigin).origin;

  const findBridgeTab = async (): Promise<number | null> => {
    for (const tab of await findBrightspaceTabs(origin)) {
      const pong = await sendToTab<unknown>(tab.id as number, { type: "PING" });
      if (pingResultSchema.safeParse(pong).success) return tab.id as number;
    }
    return null;
  };

  const rawFetch: RawFetch = async (path) => {
    if (!isApprovedBrightspacePath(path, origin)) throw new BrightspaceFailure({ kind: "unsafe-path", path: String(path) });
    const tabId = await findBridgeTab();
    if (tabId === null) throw new BrightspaceFailure({ kind: "network", retryable: true, operation: "no-brightspace-tab" });
    const raw = await sendToTab<unknown>(tabId, { type: "BRIGHTSPACE_FETCH", path });
    const parsed = fetchBridgeResultSchema.safeParse(raw);
    if (!parsed.success) throw new BrightspaceFailure({ kind: "network", retryable: true, operation: "bridge" });
    if (!parsed.data.ok) {
      if (parsed.data.reason === "unsafe-path") throw new BrightspaceFailure({ kind: "unsafe-path", path: String(path) });
      throw new BrightspaceFailure({ kind: "network", retryable: true, operation: parsed.data.reason });
    }
    return parsed.data.response;
  };

  const rawFetchFile: RawFileFetch = async (path, { maxBytes, headOnly = false }) => {
    if (!isApprovedFilePath(path, origin)) throw new BrightspaceFailure({ kind: "unsafe-path", path: String(path) });
    const tabId = await findBridgeTab();
    if (tabId === null) throw new BrightspaceFailure({ kind: "network", retryable: true, operation: "no-brightspace-tab" });
    const raw = await sendToTab<unknown>(tabId, { type: "BRIGHTSPACE_FETCH_FILE", path, maxBytes: Math.max(1, Math.min(Math.floor(maxBytes), HARD_FILE_CAP_BYTES)), headOnly });
    const parsed = fileBridgeResultSchema.safeParse(raw);
    if (!parsed.success) throw new BrightspaceFailure({ kind: "network", retryable: true, operation: "bridge" });
    if (!parsed.data.ok) {
      if (parsed.data.reason === "unsafe-path") throw new BrightspaceFailure({ kind: "unsafe-path", path: String(path) });
      throw new BrightspaceFailure({ kind: "network", retryable: true, operation: parsed.data.reason });
    }
    return parsed.data.response;
  };

  const broadcast = async (message: NovaMessage): Promise<void> => {
    for (const tab of await findBrightspaceTabs(origin)) await sendToTab(tab.id as number, message);
  };

  return {
    tenantOrigin: origin,
    rawFetch,
    rawFetchFile,
    hasBrightspaceTab: async () => (await findBridgeTab()) !== null,
    openTenantUrl: (url) => {
      if (!isSafeTenantLink(url, origin)) return;
      void chrome.tabs.create({ url });
    },
    publishBadge: async (unread) => {
      await chrome.storage.local.set({ [BADGE_STORAGE_KEY]: unread });
      void broadcast({ type: "SYNC_RESULT", phase: "ready", unreadCount: unread });
    },
    publishSyncPhase: (phase: SyncPhase) => {
      void broadcast({ type: "SYNC_PROGRESS", phase });
    },
    isOnline: () => (typeof navigator === "undefined" ? true : navigator.onLine),
    getGoogleIdToken: async (clientId) => {
      // Google's own window, opened by Chrome. The panel never sees a password, only the ID token Google hands back.
      if (!chrome.identity?.launchWebAuthFlow) return null;
      const nonce = crypto.randomUUID();
      const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      url.searchParams.set("client_id", clientId);
      url.searchParams.set("response_type", "id_token");
      url.searchParams.set("redirect_uri", chrome.identity.getRedirectURL());
      url.searchParams.set("scope", "openid email");
      url.searchParams.set("nonce", nonce);
      url.searchParams.set("prompt", "select_account");
      try {
        const redirect = await chrome.identity.launchWebAuthFlow({ url: url.toString(), interactive: true });
        return redirect ? idTokenFromRedirect(redirect, nonce) : null;
      } catch {
        return null;
      }
    },
  };
};
