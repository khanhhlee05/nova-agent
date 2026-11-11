import type { FileKind, TextPart } from "./extract";

/**
 * Passages and keyword search over course materials, entirely on this
 * device. Nothing here needs a model or a network: a file's text is cut into
 * passages, and a query is matched against them with BM25, the standard
 * keyword ranking. What a search returns is a handful of passages; the rest
 * of the text never leaves the extension's storage.
 */

/** A stretch of one file's text, with the page or slide it came from when the file has them. */
export type Passage = { part: number | null; text: string };

export const PASSAGE_CHARS = 800;

/** Cuts text at a sentence or line end near `size`, never in the middle of a word when one can be avoided. */
const cut = (text: string, size: number): string[] => {
  const out: string[] = [];
  let rest = text.trim();
  while (rest.length > size) {
    const window = rest.slice(0, size + 1);
    const sentence = Math.max(window.lastIndexOf(". "), window.lastIndexOf("? "), window.lastIndexOf("! "), window.lastIndexOf("\n"));
    const space = window.lastIndexOf(" ");
    const at = sentence >= size * 0.5 ? sentence + 1 : space >= size * 0.5 ? space : size;
    out.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest !== "") out.push(rest);
  return out;
};

/**
 * Splits a file's parts into passages of about `size` characters. A passage
 * never spans two pages or slides, so the page it names is the page it is
 * on. Paragraphs are kept whole when they fit.
 */
export const splitPassages = (parts: readonly TextPart[], size: number = PASSAGE_CHARS): Passage[] => {
  const passages: Passage[] = [];
  for (const part of parts) {
    let current = "";
    const flush = () => {
      if (current.trim() !== "") passages.push({ part: part.number, text: current.trim() });
      current = "";
    };
    for (const paragraph of part.text.split(/\n+/)) {
      const line = paragraph.trim();
      if (line === "") continue;
      if (line.length > size) {
        flush();
        for (const piece of cut(line, size)) passages.push({ part: part.number, text: piece });
        continue;
      }
      if (current !== "" && current.length + 1 + line.length > size) flush();
      current = current === "" ? line : `${current}\n${line}`;
    }
    flush();
  }
  return passages;
};

const STOPWORDS = new Set(
  "a an and are as at be but by can do does for from had has have how i if in into is it its may me my no not of on or our should so than that the their them then there these they this to was we were what when where which who why will with would you your about say says said".split(" "),
);

/** One word without its plural ending, by the few rules that are safe: quizzes, classes, boxes, policies, labs. Words that only look plural (class, status, analysis) are left alone. */
const singular = (token: string): string => {
  if (token.length > 4 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.length > 5 && token.endsWith("zzes")) return token.slice(0, -3);
  if (token.length > 4 && /(ss|x|ch|sh)es$/.test(token)) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith("s") && !/(ss|us|is)$/.test(token)) return token.slice(0, -1);
  return token;
};

/** Lower case, accents folded, split on anything that is not a letter or digit, common words dropped, simple plurals folded. */
export const tokenize = (text: string): string[] =>
  text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 1 && !STOPWORDS.has(token))
    .map(singular);

/** What the index needs to know about one read file. */
export type IndexedFile = { courseId: string; topicId: string; title: string; modulePath: readonly string[]; kind: FileKind | null; passages: readonly Passage[] };

type Entry = { file: IndexedFile; passage: Passage; terms: Map<string, number>; length: number; titleTerms: Set<string> };

export type MaterialIndex = { entries: Entry[]; documentFrequency: Map<string, number>; averageLength: number };

export type SearchHit = { courseId: string; topicId: string; title: string; modulePath: readonly string[]; kind: FileKind | null; part: number | null; text: string; score: number };

export const buildIndex = (files: readonly IndexedFile[]): MaterialIndex => {
  const entries: Entry[] = [];
  const documentFrequency = new Map<string, number>();
  for (const file of files) {
    const titleTerms = new Set(tokenize(`${file.title} ${file.modulePath.join(" ")}`));
    for (const passage of file.passages) {
      const tokens = tokenize(passage.text);
      if (tokens.length === 0) continue;
      const terms = new Map<string, number>();
      for (const token of tokens) terms.set(token, (terms.get(token) ?? 0) + 1);
      for (const term of terms.keys()) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
      entries.push({ file, passage, terms, length: tokens.length, titleTerms });
    }
  }
  const averageLength = entries.length > 0 ? entries.reduce((sum, entry) => sum + entry.length, 0) / entries.length : 0;
  return { entries, documentFrequency, averageLength };
};

const K1 = 1.2;
const B = 0.75;
/** How much a query word in the topic's own title or module adds, as a share of that word's weight. */
const TITLE_BONUS = 0.5;
/** At most this many passages from one topic, so one long file cannot fill the results. */
export const HITS_PER_TOPIC = 3;

/**
 * The passages that best match the query, best first. Deterministic: ties
 * fall back to topic and position, so the same index and query always give
 * the same results.
 */
export const searchIndex = (index: MaterialIndex, query: string, options: { courseIds?: ReadonlySet<string>; limit?: number } = {}): SearchHit[] => {
  const terms = [...new Set(tokenize(query))];
  if (terms.length === 0 || index.entries.length === 0) return [];
  const total = index.entries.length;
  const idf = new Map(terms.map((term) => [term, Math.log(1 + (total - (index.documentFrequency.get(term) ?? 0) + 0.5) / ((index.documentFrequency.get(term) ?? 0) + 0.5))]));
  const scored: { entry: Entry; score: number; order: number }[] = [];
  index.entries.forEach((entry, order) => {
    if (options.courseIds && !options.courseIds.has(entry.file.courseId)) return;
    let score = 0;
    let matched = false;
    for (const term of terms) {
      const frequency = entry.terms.get(term) ?? 0;
      const weight = idf.get(term) ?? 0;
      if (frequency > 0) {
        matched = true;
        score += (weight * frequency * (K1 + 1)) / (frequency + K1 * (1 - B + (B * entry.length) / (index.averageLength || 1)));
      }
      if (entry.titleTerms.has(term)) score += weight * TITLE_BONUS;
    }
    // A passage has to contain at least one of the words itself; a matching title alone does not make every passage a hit.
    if (matched) scored.push({ entry, score, order });
  });
  scored.sort((a, b) => b.score - a.score || a.order - b.order);
  const perTopic = new Map<string, number>();
  const hits: SearchHit[] = [];
  for (const { entry, score } of scored) {
    const key = `${entry.file.courseId}#${entry.file.topicId}`;
    const taken = perTopic.get(key) ?? 0;
    if (taken >= HITS_PER_TOPIC) continue;
    perTopic.set(key, taken + 1);
    hits.push({ courseId: entry.file.courseId, topicId: entry.file.topicId, title: entry.file.title, modulePath: entry.file.modulePath, kind: entry.file.kind, part: entry.passage.part, text: entry.passage.text, score: Math.round(score * 1000) / 1000 });
    if (hits.length >= (options.limit ?? 5)) break;
  }
  return hits;
};
