import { VILLANOVA_BRIGHTSPACE_ORIGIN } from "@nova-agent/brightspace/src/routes-and-transport";
import { parseMessage } from "./messaging/protocol";

/**
 * Service worker: opens the side panel in response to the orb's user gesture
 * and to toolbar clicks. No academic data passes through here.
 */

const TENANT_ORIGIN = VILLANOVA_BRIGHTSPACE_ORIGIN;

chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);
});

chrome.runtime.onMessage.addListener((raw: unknown, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  const message = parseMessage(raw);
  if (!message || message.type !== "OPEN_PANEL") return false;
  const tabId = sender.tab?.id;
  const fromTenant = typeof sender.url === "string" && sender.url.startsWith(`${TENANT_ORIGIN}/`);
  if (typeof tabId !== "number" || !fromTenant) {
    sendResponse({ ok: false });
    return false;
  }
  chrome.sidePanel
    .open({ tabId })
    .then(() => sendResponse({ ok: true }))
    .catch(() => sendResponse({ ok: false }));
  return true;
});
