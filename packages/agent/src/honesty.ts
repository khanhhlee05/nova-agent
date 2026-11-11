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

const MONTH = "(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)";
const WEEKDAY = "(Mon(?:day)?|Tue(?:s|sday)?|Wed(?:nesday)?|Thu(?:r|rs|rsday)?|Fri(?:day)?|Sat(?:urday)?|Sun(?:day)?)";
const ORDINAL = "(?:st|nd|rd|th)?";
/** "Sep 9", "September 9th". A year ("March 2026") or a clock time is not a day of the month. */
const monthDay = (flags: string): RegExp => new RegExp(`\\b${MONTH}\\.?\\s+(\\d{1,2})${ORDINAL}(?![\\d:])\\b`, flags);
/** "9 September", "14th of September". */
const dayMonth = (flags: string): RegExp => new RegExp(`\\b(\\d{1,2})${ORDINAL}\\s+(?:of\\s+)?${MONTH}\\b`, flags);
const ISO_DATE = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
const WEEKDAY_DATE = new RegExp(`\\b${WEEKDAY}\\.?,?\\s+(?:the\\s+)?(?:${MONTH}\\.?\\s+(\\d{1,2})${ORDINAL}(?![\\d:])\\b|(\\d{4})-(\\d{2})-(\\d{2})\\b)`, "g");
const POINTS = /\b(\d{1,6}(?:\.\d+)?)\s*(?:points?|pts)\b/gi;
const NUMBER = /\d+(?:\.\d+)?/g;

const MONTH_INDEX = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const WEEKDAY_INDEX = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const monthOf = (name: string): number => MONTH_INDEX.indexOf(name.slice(0, 3).toLowerCase()) + 1;
const weekdayOf = (year: number, month: number, day: number): number => new Date(Date.UTC(year, month - 1, day)).getUTCDay();
const dayKey = (month: number, day: number): string => `${month}-${day}`;

/** A fact in an answer that nothing the model was shown supports. */
export type UnverifiedFact = { kind: "date" | "weekday" | "points"; value: string };

/** The calendar days and numbers found in everything the model was shown. */
const factsIn = (evidence: Evidence): { iso: Set<string>; days: Set<string>; numbers: Set<number> } => {
  const iso = new Set<string>();
  const days = new Set<string>();
  const numbers = new Set<number>(evidence.numbers);
  for (const text of evidence.strings) {
    for (const match of text.matchAll(ISO_DATE)) {
      iso.add(match[0]);
      days.add(dayKey(Number(match[2]), Number(match[3])));
    }
    for (const match of text.matchAll(monthDay("gi"))) days.add(dayKey(monthOf(match[1] ?? ""), Number(match[2])));
    for (const match of text.matchAll(dayMonth("gi"))) days.add(dayKey(monthOf(match[2] ?? ""), Number(match[1])));
    for (const match of text.matchAll(NUMBER)) numbers.add(Number(match[0]));
  }
  return { iso, days, numbers };
};

/**
 * Dates and point values in the answer that appear in nothing the model was
 * shown, and weekdays that do not match the date they are attached to. A
 * date is checked as a calendar day (a `YYYY-MM-DD`, or a month and a day
 * written out), a point value as the number in front of "points" or "pts".
 * Relative words (tomorrow, next week) are not dates and are left alone, and
 * a weekday is only checked when a date follows it, because only then can it
 * be wrong in a way that can be shown.
 *
 * Month and weekday names are matched with their capital letter, so the verb
 * in "you may 5 times" or "she sat 3 exams" is not read as a date.
 */
export const unverifiedFacts = (text: string, evidence: Evidence): UnverifiedFact[] => {
  const known = factsIn(evidence);
  const out = new Map<string, UnverifiedFact>();
  const flag = (kind: UnverifiedFact["kind"], value: string) => out.set(`${kind}:${value}`, { kind, value });
  for (const match of text.matchAll(ISO_DATE)) if (!known.iso.has(match[0])) flag("date", match[0]);
  for (const match of text.matchAll(monthDay("g"))) if (!known.days.has(dayKey(monthOf(match[1] ?? ""), Number(match[2])))) flag("date", match[0]);
  for (const match of text.matchAll(dayMonth("g"))) if (!known.days.has(dayKey(monthOf(match[2] ?? ""), Number(match[1])))) flag("date", match[0]);
  for (const match of text.matchAll(WEEKDAY_DATE)) {
    const named = WEEKDAY_INDEX.indexOf((match[1] ?? "").slice(0, 3).toLowerCase());
    // The same month and day in each year the model was shown; the weekday has to be right for one of them.
    const candidates = match[4] ? [[Number(match[4]), Number(match[5]), Number(match[6])] as const] : [...known.iso].map((date) => date.split("-").map(Number) as [number, number, number]).filter(([, month, day]) => month === monthOf(match[2] ?? "") && day === Number(match[3]));
    if (candidates.length > 0 && !candidates.some(([year, month, day]) => weekdayOf(year, month, day) === named)) flag("weekday", match[0]);
  }
  for (const match of text.matchAll(POINTS)) if (!known.numbers.has(Number(match[1]))) flag("points", match[0]);
  return [...out.values()];
};
