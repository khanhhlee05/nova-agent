import { normalizeText } from "@nova-agent/core";
import type { CompactSnapshot } from "@nova-agent/protocol";

const norm = (text: string): string => normalizeText(text).toLowerCase();

export type HonestyCheck = { ok: boolean; unverified: string[] };

/**
 * Flags item titles the answer names that no tool returned and the prompt
 * brief did not list. Only titles of six or more characters count, so short
 * generic titles do not trip it.
 */
export const checkHonesty = (text: string, snapshot: CompactSnapshot, allowedTitles: Iterable<string>): HonestyCheck => {
  const answer = norm(text);
  const allowed = new Set([...allowedTitles].map(norm));
  const unverified = snapshot.items
    .map((item) => item.title)
    .filter((title) => title.length >= 6)
    .filter((title) => !allowed.has(norm(title)) && answer.includes(norm(title)));
  return { ok: unverified.length === 0, unverified: [...new Set(unverified)] };
};
