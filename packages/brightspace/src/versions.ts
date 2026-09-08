import { fail } from "./errors";
import type { ProductVersion } from "./schemas";

export type ResolvedVersions = { lp: string; le: string; resolvedAt: string };

export const VERSION_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const parseVersion = (value: string): [number, number] | null => {
  const match = /^(\d+)\.(\d+)$/.exec(value.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2])];
};

export const compareVersions = (a: string, b: string): number => {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return pa ? 1 : pb ? -1 : 0;
  return pa[0] - pb[0] || pa[1] - pb[1];
};

/** Picks the highest supported version reported for a product code. */
export const selectHighestVersion = (versions: readonly ProductVersion[], product: "lp" | "le"): string | null => {
  const entry = versions.find((candidate) => candidate.ProductCode.toLowerCase() === product);
  if (!entry) return null;
  const candidates = entry.SupportedVersions.filter((v) => parseVersion(v));
  if (candidates.length === 0 && entry.LatestVersion && parseVersion(entry.LatestVersion)) return entry.LatestVersion;
  if (candidates.length === 0) return null;
  return candidates.reduce((best, current) => (compareVersions(current, best) > 0 ? current : best));
};

export const resolveVersions = (versions: readonly ProductVersion[], now: Date): ResolvedVersions => {
  const lp = selectHighestVersion(versions, "lp");
  const le = selectHighestVersion(versions, "le");
  if (!lp) fail({ kind: "unsupported-api", product: "lp" });
  if (!le) fail({ kind: "unsupported-api", product: "le" });
  return { lp: lp as string, le: le as string, resolvedAt: now.toISOString() };
};

export const isVersionCacheFresh = (cached: ResolvedVersions | null, now: Date, ttlMs = VERSION_CACHE_TTL_MS): cached is ResolvedVersions =>
  !!cached && now.getTime() - new Date(cached.resolvedAt).getTime() < ttlMs;

/** Pluggable cache so the extension can persist resolved versions across sessions. */
export interface VersionCacheStore {
  get(): Promise<ResolvedVersions | null>;
  set(value: ResolvedVersions): Promise<void>;
  clear(): Promise<void>;
}

export class MemoryVersionCache implements VersionCacheStore {
  private value: ResolvedVersions | null = null;
  async get(): Promise<ResolvedVersions | null> {
    return this.value;
  }
  async set(value: ResolvedVersions): Promise<void> {
    this.value = value;
  }
  async clear(): Promise<void> {
    this.value = null;
  }
}
