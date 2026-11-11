import { normalizeText } from "@nova-agent/core";
import type { CompactSnapshot } from "@nova-agent/protocol";

const norm = (text: string): string => normalizeText(text).toLowerCase();

export type HonestyCheck = { ok: boolean; unverified: string[] };

/**
 * Flags item titles, and titles of the student's own deadlines, that the
 * answer names although no tool returned them and the prompt brief did not
 * list them. Only titles of six or more characters count, so short generic
 * titles do not trip it.
 */
export const checkHonesty = (text: string, snapshot: CompactSnapshot, allowedTitles: Iterable<string>): HonestyCheck => {
  const answer = norm(text);
  const allowed = new Set([...allowedTitles].map(norm));
  const unverified = [...snapshot.items.map((item) => item.title), ...(snapshot.personal ?? []).map((deadline) => deadline.title)]
    .filter((title) => title.length >= 6)
    .filter((title) => !allowed.has(norm(title)) && answer.includes(norm(title)));
  return { ok: unverified.length === 0, unverified: [...new Set(unverified)] };
};

/**
 * Everything an answer may be checked against for one turn: the text the
 * model was shown (the prompt, the conversation, what tools returned) and
 * the numbers in what tools returned.
 */
export type Evidence = { strings: string[]; numbers: number[] };

export const emptyEvidence = (): Evidence => ({ strings: [], numbers: [] });

const MAX_EVIDENCE_DEPTH = 8;

/** Adds every string and number inside a value to the evidence. Tool data is walked as data, never as serialized JSON, so escapes cannot bend a word. */
export const addEvidence = (evidence: Evidence, value: unknown, depth = 0): void => {
  if (typeof value === "string") evidence.strings.push(value);
  else if (typeof value === "number" && Number.isFinite(value)) evidence.numbers.push(value);
  else if (depth < MAX_EVIDENCE_DEPTH && typeof value === "object" && value !== null) for (const inner of Object.values(value)) addEvidence(evidence, inner, depth + 1);
};

/** Words only: lower case, accents folded, every run of anything else becomes one space. Punctuation and line breaks cannot make two texts differ. */
export const wordsOf = (text: string): string =>
  text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

export const QUOTE_LIMITS = { words: 4, chars: 20 } as const;

/** Straight or curly double quotes around one line of text. */
const QUOTED = /"([^"\n]{1,600})"|“([^”\n]{1,600})”/g;

/**
 * Quotations in the answer that appear in nothing the model was shown. A
 * quotation is a claim that someone wrote exactly this, so it has to be
 * found, word for word, in the prompt, the conversation, or a tool result
 * from this turn. Short quotations (under four words or twenty characters)
 * are left alone: they are names and scare quotes, and the title check
 * already covers names.
 */
export const unverifiedQuotes = (text: string, evidence: Evidence): string[] => {
  const haystack = ` ${evidence.strings.map(wordsOf).join(" ")} `;
  const missing: string[] = [];
  for (const match of text.matchAll(QUOTED)) {
    const quoted = (match[1] ?? match[2] ?? "").trim();
    const words = wordsOf(quoted);
    if (quoted.length < QUOTE_LIMITS.chars || words.split(" ").length < QUOTE_LIMITS.words) continue;
    if (!haystack.includes(` ${words} `)) missing.push(quoted);
  }
  return [...new Set(missing)];
};
