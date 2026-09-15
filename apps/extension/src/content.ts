import { createSameOriginFetcher, validateApprovedPath } from "@nova-agent/brightspace/src/routes-and-transport";
import { BADGE_STORAGE_KEY, parseMessage, type FetchBridgeResult } from "./messaging/protocol";

/**
 * Content script: owns only the Nova Orb launcher and the whitelisted
 * same-origin request bridge. It never reads cookies, never renders the
 * dashboard, and only answers messages from this extension.
 */

const ORB_TAG = "nova-agent-orb";
const FETCH_TIMEOUT_MS = 10_000;

const isTopFrame = (): boolean => {
  try {
    return window.top === window;
  } catch {
    return false;
  }
};

const orbStyles = `
  :host { all: initial; }
  .orb {
    position: fixed; right: 20px; bottom: 20px; z-index: 2147483646;
    width: 44px; height: 44px; border-radius: 50%; border: 0;
    background: #1d5fd1; box-shadow: 0 6px 16px rgba(15, 20, 32, 0.28);
    cursor: pointer; padding: 0; display: grid; place-items: center;
    transition: transform 160ms ease;
    font: 700 11px/1 "Hanken Grotesk", "Helvetica Neue", Arial, system-ui, sans-serif; color: #ffffff;
  }
  .orb:hover { transform: translateY(-1px); }
  .orb:focus-visible { outline: 3px solid #ffffff; outline-offset: 2px; box-shadow: 0 0 0 5px #1d5fd1; }
  .core { width: 14px; height: 14px; border-radius: 50%; background: #ffffff; }
  .orb[data-syncing="true"] .core { animation: nova-pulse 1.1s ease-in-out infinite; }
  .badge {
    position: absolute; top: -4px; right: -4px; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 9px;
    background: #ffffff; color: #1d5fd1; display: none; place-items: center; font-weight: 800;
    border: 2px solid #1d5fd1; box-sizing: border-box;
  }
  .badge[data-visible="true"] { display: grid; }
  @keyframes nova-pulse { 0%, 100% { transform: scale(1); } 50% { transform: scale(0.72); } }
  @media (prefers-reduced-motion: reduce) { .orb, .core { transition: none; animation: none !important; } }
`;

const mountOrb = (): { setBadge: (count: number) => void; setSyncing: (syncing: boolean) => void } | null => {
  if (document.querySelector(ORB_TAG)) return null;
  const hostElement = document.createElement(ORB_TAG);
  const shadow = hostElement.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = orbStyles;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "orb";
  button.setAttribute("aria-label", "Open Nova Mission Control");
  button.title = "Open Nova Mission Control";
  const core = document.createElement("span");
  core.className = "core";
  core.setAttribute("aria-hidden", "true");
  const badge = document.createElement("span");
  badge.className = "badge";
  badge.setAttribute("aria-hidden", "true");
  button.append(core, badge);
  shadow.append(style, button);
  document.documentElement.append(hostElement);

  button.addEventListener("click", () => {
    void chrome.runtime.sendMessage({ type: "OPEN_PANEL" }).catch(() => undefined);
  });

  return {
    setBadge: (count) => {
      const visible = count > 0;
      badge.dataset.visible = String(visible);
      badge.textContent = count > 99 ? "99+" : String(count);
      button.setAttribute("aria-label", visible ? `Open Nova Mission Control, ${count} unread changes` : "Open Nova Mission Control");
    },
    setSyncing: (syncing) => {
      button.dataset.syncing = String(syncing);
    },
  };
};

const withTimeout = async (path: string): Promise<FetchBridgeResult> => {
  const approved = validateApprovedPath(path, location.origin);
  if (!approved) return { ok: false, reason: "unsafe-path" };
  const rawFetch = createSameOriginFetcher(location.origin);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await rawFetch(approved.path, { signal: controller.signal });
    return { ok: true, response };
  } catch (error) {
    return { ok: false, reason: error instanceof Error && error.name === "AbortError" ? "timeout" : "network" };
  } finally {
    clearTimeout(timer);
  }
};

const start = (): void => {
  if (!isTopFrame()) return;
  const orb = mountOrb();

  chrome.storage.local.get(BADGE_STORAGE_KEY).then((stored) => {
    const value = stored[BADGE_STORAGE_KEY];
    if (typeof value === "number") orb?.setBadge(value);
  }).catch(() => undefined);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !(BADGE_STORAGE_KEY in changes)) return;
    const value = changes[BADGE_STORAGE_KEY]?.newValue;
    orb?.setBadge(typeof value === "number" ? value : 0);
  });

  chrome.runtime.onMessage.addListener((raw: unknown, sender, sendResponse) => {
    // Only this extension's own pages and service worker may talk to the bridge.
    if (sender.id !== chrome.runtime.id || sender.tab) return false;
    const message = parseMessage(raw);
    if (!message) return false;
    switch (message.type) {
      case "PING":
        sendResponse({ ok: true, origin: location.origin });
        return false;
      case "BRIGHTSPACE_FETCH":
        void withTimeout(message.path).then(sendResponse);
        return true;
      case "SYNC_PROGRESS":
        orb?.setSyncing(!["ready", "partial", "failed", "offline", "session-expired", "permission-required", "idle"].includes(message.phase));
        return false;
      case "SYNC_RESULT":
        orb?.setSyncing(false);
        orb?.setBadge(message.unreadCount);
        return false;
      default:
        return false;
    }
  });
};

start();
