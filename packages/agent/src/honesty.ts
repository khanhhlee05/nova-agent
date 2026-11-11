import { normalizeText } from "@nova-agent/core";
import type { CompactSnapshot } from "@nova-agent/protocol";

const norm = (text: string): string => normalizeText(text).toLowerCase();

export type HonestyCheck = { ok: boolean; unverified: string[] };

/**
 * Flags item titles, and titles of the student's own deadlines, that the
 * answer names although no tool returned them and the prompt brief did not
 * list them. Only titles of six or more characters count, so short
 * generic titles do not trip it.
 */
export const checkHonesty = (text: string, snapshot: CompactSnapshot, allowedTitles: Iterable<string>): HonestyCheck => {
  const answer = norm(text);
  const allowed = new Set([...allowedTitles].map(norm));
  const unverified = [...snapshot.items.map((item) => item.title), ...(snapshot.personal ?? []).map((deadline) => deadline.title)]
    .filter((title) => title.length >= 6)
    .filter((title) => !allowed.has(norm(title)) && answer.includes(norm(title)));
  return { ok: unverified.length === 0, unverified: [...new Set(unverified)] };
};
