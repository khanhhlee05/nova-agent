import { DEMO_LE_VERSION, buildDemoTenant, demoFileFetch, fetchFile, routes } from "@nova-agent/brightspace";
import { beforeAll, describe, expect, it } from "vitest";
import { extractText } from "../../apps/extension/src/files/extract";
import { readPdf } from "../../apps/extension/src/files/pdf";
import { HITS_PER_TOPIC, PASSAGE_CHARS, buildIndex, searchIndex, splitPassages, tokenize, type IndexedFile, type MaterialIndex } from "../../apps/extension/src/files/search";
import { NOW, TENANT } from "../helpers/demoDashboard";

const words = (text: string): string[] => text.split(/\s+/).filter(Boolean);

describe("splitPassages", () => {
  it("keeps short paragraphs together and never lets a passage span two pages", () => {
    const passages = splitPassages([
      { number: 1, text: "Late work\nLate work loses 10 percent per day.\n\n\nOffice hours are Tuesday." },
      { number: 2, text: "Grading\nLabs are 40 percent." },
      { number: 3, text: "   \n  " },
    ]);
    expect(passages).toEqual([
      { part: 1, text: "Late work\nLate work loses 10 percent per day.\nOffice hours are Tuesday." },
      { part: 2, text: "Grading\nLabs are 40 percent." },
    ]);
  });

  it("starts a new passage when the next paragraph would not fit, and loses no words", () => {
    const paragraphs = Array.from({ length: 12 }, (_, index) => `Paragraph ${index} ${"word ".repeat(30).trim()}.`);
    const passages = splitPassages([{ number: null, text: paragraphs.join("\n") }], 400);
    expect(passages.length).toBeGreaterThan(3);
    for (const passage of passages) {
      expect(passage.text.length).toBeLessThanOrEqual(400);
      expect(passage.part).toBeNull();
      // Paragraphs are never split when they fit: every passage starts at a paragraph start.
      expect(passage.text.startsWith("Paragraph ")).toBe(true);
    }
    expect(words(passages.map((passage) => passage.text).join(" "))).toEqual(words(paragraphs.join(" ")));
  });

  it("cuts one long paragraph at sentence ends when it can, at a space when it cannot, and mid-run only as a last resort", () => {
    const sentences = Array.from({ length: 40 }, (_, index) => `Sentence number ${index} explains one more thing about timers.`).join(" ");
    const bySentence = splitPassages([{ number: 4, text: sentences }], 300);
    expect(bySentence.length).toBeGreaterThan(5);
    for (const passage of bySentence) {
      expect(passage.text.length).toBeLessThanOrEqual(300);
      expect(passage.text.endsWith(".")).toBe(true);
      expect(passage.part).toBe(4);
    }
    expect(words(bySentence.map((passage) => passage.text).join(" "))).toEqual(words(sentences));

    const noSentences = "alpha beta gamma delta ".repeat(60).trim();
    const bySpace = splitPassages([{ number: null, text: noSentences }], 200);
    for (const passage of bySpace) {
      expect(passage.text.length).toBeLessThanOrEqual(200);
      expect(/^(alpha|beta|gamma|delta)\b/.test(passage.text) && /\b(alpha|beta|gamma|delta)$/.test(passage.text)).toBe(true);
    }
    expect(words(bySpace.map((passage) => passage.text).join(" "))).toEqual(words(noSentences));

    const unbroken = "x".repeat(950);
    const hard = splitPassages([{ number: null, text: unbroken }], 300);
    expect(hard.map((passage) => passage.text.length)).toEqual([300, 300, 300, 50]);
    expect(hard.map((passage) => passage.text).join("")).toBe(unbroken);
  });

  it("uses a passage size that fits several passages in one tool result", () => {
    expect(PASSAGE_CHARS).toBe(800);
    expect(splitPassages([])).toEqual([]);
  });
});

describe("tokenize", () => {
  it("lower-cases, folds accents, drops common words and single letters, and folds simple plurals", () => {
    expect(tokenize("What does the Syllabus say about LATE work?")).toEqual(["syllabus", "late", "work"]);
    expect(tokenize("Résumé naïve café")).toEqual(["resume", "naive", "cafe"]);
    expect(tokenize("policies labs quizzes interrupts classes boxes matches wishes")).toEqual(["policy", "lab", "quiz", "interrupt", "class", "box", "match", "wish"]);
    // Words that only look plural are left alone.
    expect(tokenize("class status analysis bus")).toEqual(["class", "status", "analysis", "bus"]);
    expect(tokenize("a I x 5 f_clk OCR1A 16-bit")).toEqual(["clk", "ocr1a", "16", "bit"]);
    expect(tokenize("the of and to")).toEqual([]);
    expect(tokenize("")).toEqual([]);
  });

  it("gives a question and the material the same words for the same thing", () => {
    expect(tokenize("interrupt")).toEqual(tokenize("Interrupts"));
    expect(tokenize("late-work policy")).toEqual(tokenize("Late work policies"));
    expect(tokenize("quiz")).toEqual(tokenize("Quizzes"));
  });
});

describe("searching the demo course materials", () => {
  let index: MaterialIndex;
  let files: IndexedFile[];

  beforeAll(async () => {
    const fetch = demoFileFetch(buildDemoTenant(NOW));
    const load = async (courseId: string, topicId: string, title: string, modulePath: string[], name: string): Promise<IndexedFile> => {
      const file = await fetchFile(fetch, routes.contentTopicFile(DEMO_LE_VERSION, courseId, topicId), { tenantOrigin: TENANT });
      const extracted = await extractText(file.bytes, { name, contentType: file.contentType }, { readPdf });
      if (!extracted.ok) throw new Error(`fixture changed: ${name} gave ${extracted.reason}`);
      return { courseId, topicId, title, modulePath, kind: extracted.value.kind, passages: splitPassages(extracted.value.parts) };
    };
    files = [
      await load("31001", "8101", "Syllabus", ["Course information"], "syllabus.html"),
      await load("31001", "8102", "Lecture 5: Interrupts", ["Week 3: Interrupts"], "lecture5-interrupts.pptx"),
      await load("31001", "8104", "Lab manual", ["Week 3: Interrupts", "Lab materials"], "lab-manual.pdf"),
      await load("31003", "8301", "Fourier series notes", ["Notes"], "fourier-notes.txt"),
    ];
    index = buildIndex(files);
  });

  it("reads each demo file into passages that keep their page or slide", () => {
    expect(files.map((file) => file.kind)).toEqual(["html", "pptx", "pdf", "text"]);
    expect(files[0]?.passages.every((passage) => passage.part === null)).toBe(true);
    expect(files[1]?.passages.map((passage) => passage.part)).toEqual([1, 2, 3]);
    expect(files[2]?.passages.map((passage) => passage.part)).toEqual([1, 2]);
    expect(JSON.stringify(files[0]?.passages)).not.toContain("font-family");
  });

  it("finds the late work policy in the syllabus, word for word", () => {
    const hits = searchIndex(index, "What does the syllabus say about late work");
    expect(hits[0]).toMatchObject({ courseId: "31001", topicId: "8101", title: "Syllabus", modulePath: ["Course information"], kind: "html", part: null });
    expect(hits[0]?.text).toContain("Late work loses 10 percent per day, for up to three days. After three days it is not accepted.");
    expect(hits[0]?.score).toBeGreaterThan(0);
  });

  it("names the slide or page a passage is on", () => {
    expect(searchIndex(index, "interrupt latency clock cycles")[0]).toMatchObject({ topicId: "8102", kind: "pptx", part: 3 });
    expect(searchIndex(index, "volatile shared variables")[0]).toMatchObject({ topicId: "8102", part: 2 });
    expect(searchIndex(index, "Timer1 CTC OCR1A")[0]).toMatchObject({ topicId: "8104", kind: "pdf", part: 1 });
    expect(searchIndex(index, "oscilloscope probe rising edge")[0]).toMatchObject({ topicId: "8104", part: 2 });
    expect(searchIndex(index, "office hours")[0]?.text).toContain("Tuesday 2 to 4 PM in CEER 210");
  });

  it("searches only the courses it is given", () => {
    expect(searchIndex(index, "fourier cosine terms")[0]).toMatchObject({ courseId: "31003", topicId: "8301" });
    expect(searchIndex(index, "fourier cosine terms", { courseIds: new Set(["31001"]) })).toEqual([]);
    expect(searchIndex(index, "late work", { courseIds: new Set(["31003"]) })).toEqual([]);
    expect(searchIndex(index, "late work", { courseIds: new Set() })).toEqual([]);
  });

  it("returns nothing for words that are not there, for common words alone, and for an empty index", () => {
    expect(searchIndex(index, "photosynthesis mitochondria")).toEqual([]);
    expect(searchIndex(index, "what does the say about")).toEqual([]);
    expect(searchIndex(index, "   ")).toEqual([]);
    expect(searchIndex(buildIndex([]), "late work")).toEqual([]);
  });

  it("does not count a matching title as a hit when the passage itself has none of the words", () => {
    // "manual" is in the lab manual's title and nowhere in the other files' text.
    const hits = searchIndex(index, "manual", { limit: 8 });
    expect(hits.every((hit) => hit.topicId === "8104")).toBe(true);
    expect(hits.every((hit) => /manual/i.test(hit.text))).toBe(true);
  });

  it("is deterministic, honours the limit, and takes at most three passages from one topic", () => {
    const again = searchIndex(index, "interrupt latency", { limit: 8 });
    expect(searchIndex(index, "interrupt latency", { limit: 8 })).toEqual(again);
    expect(searchIndex(index, "interrupt latency", { limit: 1 })).toHaveLength(1);
    expect(searchIndex(index, "interrupt latency")).toHaveLength(Math.min(5, again.length));
    const long: IndexedFile = { courseId: "9", topicId: "1", title: "Long notes", modulePath: [], kind: "text", passages: Array.from({ length: 10 }, (_, part) => ({ part: null, text: `Passage ${part} is about entropy and nothing else.` })) };
    const other: IndexedFile = { courseId: "9", topicId: "2", title: "Other notes", modulePath: [], kind: "text", passages: [{ part: null, text: "A short aside on entropy." }] };
    const crowded = searchIndex(buildIndex([long, other]), "entropy", { limit: 8 });
    expect(crowded.filter((hit) => hit.topicId === "1")).toHaveLength(HITS_PER_TOPIC);
    expect(crowded.filter((hit) => hit.topicId === "2")).toHaveLength(1);
    // Equal scores fall back to position, so the order never depends on anything but the index.
    expect(crowded.filter((hit) => hit.topicId === "1").map((hit) => hit.text.slice(0, 9))).toEqual(["Passage 0", "Passage 1", "Passage 2"]);
  });

  it("ranks a passage that has the rare word above one that has only the common word", () => {
    const common: IndexedFile = { courseId: "9", topicId: "1", title: "A", modulePath: [], kind: "text", passages: Array.from({ length: 6 }, (_, part) => ({ part: null, text: `The exam covers chapter ${part + 1}.` })) };
    const rare: IndexedFile = { courseId: "9", topicId: "2", title: "B", modulePath: [], kind: "text", passages: [{ part: null, text: "The exam allows one handwritten formula sheet." }] };
    expect(searchIndex(buildIndex([common, rare]), "exam formula sheet")[0]?.topicId).toBe("2");
  });
});
