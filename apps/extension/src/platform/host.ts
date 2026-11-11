import type { RawFetch, RawFileFetch } from "@nova-agent/brightspace";
import type { SyncPhase } from "../messaging/protocol";

/**
 * The only surface through which the side panel touches Chrome. The Chrome
 * implementation lives in chromeHost.ts; tests and the preview harness use a
 * stub so the UI never needs `chrome.*` globals.
 */
export interface ExtensionHost {
  readonly tenantOrigin: string;
  /** True when a tab on the tenant origin with the request bridge is available. */
  hasBrightspaceTab(): Promise<boolean>;
  /** Sends an approved path to the content-script bridge and returns the sanitized response. */
  readonly rawFetch: RawFetch;
  /** Sends an approved file path to the content-script bridge and returns the capped, sanitized file. Optional so hosts without it still satisfy the interface. */
  readonly rawFetchFile?: RawFileFetch;
  /** Opens a tenant page in a new tab. The caller must have checked `isSafeTenantLink`. */
  openTenantUrl(url: string): void;
  /** Publishes the unread count for the Nova Orb badge. */
  publishBadge(unread: number): Promise<void>;
  /** Broadcasts sync progress so the orb can reflect it. Best effort. */
  publishSyncPhase(phase: SyncPhase, unread: number): void;
  /** True when the browser reports network connectivity. */
  isOnline(): boolean;
  /**
   * Shows Google's own sign-in window and returns the ID token it issues to `clientId`, or null when the
   * student closed it or it failed. Optional: a host without it cannot sign in to a hosted Nova server.
   */
  getGoogleIdToken?(clientId: string): Promise<string | null>;
}

export type StubHostOptions = Partial<ExtensionHost> & { tenantOrigin?: string };

export const createStubHost = (options: StubHostOptions = {}): ExtensionHost & { opened: string[]; badges: number[] } => {
  const opened: string[] = [];
  const badges: number[] = [];
  return {
    opened,
    badges,
    tenantOrigin: options.tenantOrigin ?? "https://brightspace.villanova.edu",
    hasBrightspaceTab: options.hasBrightspaceTab ?? (async () => true),
    rawFetch:
      options.rawFetch ??
      (async () => {
        throw new Error("stub host has no fetch bridge");
      }),
    ...(options.rawFetchFile ? { rawFetchFile: options.rawFetchFile } : {}),
    openTenantUrl: options.openTenantUrl ?? ((url) => void opened.push(url)),
    publishBadge: options.publishBadge ?? (async (unread) => void badges.push(unread)),
    publishSyncPhase: options.publishSyncPhase ?? (() => {}),
    isOnline: options.isOnline ?? (() => true),
    ...(options.getGoogleIdToken ? { getGoogleIdToken: options.getGoogleIdToken } : {}),
  };
};
