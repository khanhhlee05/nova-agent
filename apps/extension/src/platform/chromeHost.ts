import { BrightspaceFailure, isApprovedBrightspacePath, isSafeTenantLink, type RawFetch } from "@nova-agent/brightspace";
import { fetchBridgeResultSchema, pingResultSchema } from "../messaging/bridgeSchemas";
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

  const broadcast = async (message: NovaMessage): Promise<void> => {
    for (const tab of await findBrightspaceTabs(origin)) await sendToTab(tab.id as number, message);
  };

  return {
    tenantOrigin: origin,
    rawFetch,
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
  };
};
