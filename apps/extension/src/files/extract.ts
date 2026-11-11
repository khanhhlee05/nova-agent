import { unzipSync } from "fflate";

/**
 * Text extraction, on this device only. A file's bytes come in, plain text
 * goes out; nothing is rendered, nothing is executed, and nothing here talks
 * to the network. What a format cannot give as text (images, scans, sheets)
 * is reported as unsupported rather than guessed at.
 */

export type FileKind = "pdf" | "docx" | "pptx" | "html" | "text";

/** One page of a PDF or one slide of a deck. Other formats have a single part with no number. */
export type TextPart = { number: number | null; text: string };

export type ExtractedText = {
  kind: FileKind;
  /** The parts joined, clipped to the limit. */
  text: string;
  parts: TextPart[];
  /** True when the file held more text than the limit. */
  truncated: boolean;
};

export type ExtractFailure = "unsupported" | "empty" | "damaged" | "encrypted";

export type ExtractResult = { ok: true; value: ExtractedText } | { ok: false; reason: ExtractFailure };

/** Reads the text of each page of a PDF. Injected so the heavy PDF library loads only when a PDF is actually read. */
export type PdfReader = (bytes: Uint8Array, options: { maxPages: number }) => Promise<{ ok: true; pages: string[] } | { ok: false; reason: "encrypted" | "damaged" }>;

/** Characters kept per attachment. About ten pages of prose: enough for a handout, small enough to store and to send a part of. */
export const MAX_EXTRACTED_CHARS = 40_000;

export const EXTRACT_LIMITS = { pages: 300, slides: 300, entryBytes: 20 * 1024 * 1024 } as const;

const TEXT_EXTENSIONS = new Set(["txt", "md", "markdown", "csv", "tsv", "json", "xml", "yaml", "yml", "tex", "rst", "log", "py", "js", "ts", "c", "h", "cpp", "java", "m", "v", "sv", "vhd", "asm", "s", "ino", "ipynb"]);

const extensionOf = (name: string): string => /\.([a-z0-9]{1,8})$/i.exec(name.trim())?.[1]?.toLowerCase() ?? "";

const startsWith = (bytes: Uint8Array, signature: readonly number[]): boolean => signature.every((byte, index) => bytes[index] === byte);

/**
 * What a file is, from its bytes first, then its name, then its declared
 * type. A name can lie; "%PDF" and the zip signature cannot, so a file that
 * claims to be text but starts like a PDF is read as a PDF.
 */
export const detectKind = (name: string, contentType: string | null, bytes: Uint8Array): FileKind | null => {
  const extension = extensionOf(name);
  const type = (contentType ?? "").toLowerCase();
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46])) return "pdf";
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) {
    if (extension === "docx" || type.includes("wordprocessingml")) return "docx";
    if (extension === "pptx" || type.includes("presentationml")) return "pptx";
    return null;
  }
  if (extension === "pdf" || extension === "docx" || extension === "pptx") return null; // Named as one, but the bytes are not: damaged or mislabeled.
  if (extension === "html" || extension === "htm" || type.includes("text/html")) return "html";
  if (TEXT_EXTENSIONS.has(extension) || type.startsWith("text/")) return "text";
  return null;
};

/** Control characters out, tabs and runs of spaces collapsed to one space inside a line, line breaks kept, at most one blank line in a row. */
export const tidy = (text: string): string =>
  text
    .replace(/\r\n?/g, "\n")
    .replace(/[^\S\n]+/g, " ")
    .split("\n")
    .map((line) => [...line].filter((char) => char.charCodeAt(0) >= 32).join("").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", copy: "©", deg: "°", times: "×" };

export const decodeEntities = (text: string): string =>
  text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (whole, body: string) => {
    if (body.startsWith("#")) {
      const code = body[1]?.toLowerCase() === "x" ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });

const decodeBytes = (bytes: Uint8Array): string => {
  if (startsWith(bytes, [0xff, 0xfe])) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (startsWith(bytes, [0xfe, 0xff])) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  return new TextDecoder("utf-8").decode(startsWith(bytes, [0xef, 0xbb, 0xbf]) ? bytes.subarray(3) : bytes);
};

/** HTML to text without a DOM and without running anything: scripts and styles dropped whole, block ends become line breaks. */
export const htmlToText = (html: string): string =>
  decodeEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(script|style|noscript|template|svg|head)\b[\s\S]*?<\/\1\s*>/gi, " ")
      .replace(/<(br|hr)\b[^>]*>/gi, "\n")
      .replace(/<\/(p|div|section|article|header|footer|li|ul|ol|tr|table|h[1-6]|blockquote|pre|dd|dt)\s*>/gi, "\n")
      .replace(/<\/(td|th)\s*>/gi, "\t")
      .replace(/<[^>]*>/g, ""),
  );

const WORD_TOKEN = /<w:tab\b[^>]*\/>|<w:(?:br|cr)\b[^>]*\/>|<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g;

/** Word-processing XML to text: runs joined inside a paragraph, a line per paragraph, a tab as a gap, a break as a new line. */
const wordXmlToText = (xml: string): string =>
  xml
    .split(/<\/w:p>/)
    .map((paragraph) =>
      decodeEntities(
        [...paragraph.matchAll(WORD_TOKEN)]
          .map((token) => (token[0].startsWith("<w:tab") ? "\t" : token[0].startsWith("<w:br") || token[0].startsWith("<w:cr") ? "\n" : (token[1] ?? "")))
          .join(""),
      ),
    )
    .join("\n");

/** Drawing XML (slides) to text: a line per paragraph. */
const slideXmlToText = (xml: string): string =>
  xml
    .split(/<\/a:p>/)
    .map((paragraph) => decodeEntities([...paragraph.replace(/<a:br\b[^>]*\/>/g, "<a:t>\n</a:t>").matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g)].map((match) => match[1] ?? "").join("")))
    .join("\n");

const unzipEntries = (bytes: Uint8Array, wanted: (name: string) => boolean): Record<string, Uint8Array> | null => {
  try {
    // The filter runs before anything is inflated, so an entry that claims to be huge is never expanded.
    return unzipSync(bytes, { filter: (file) => wanted(file.name) && file.originalSize <= EXTRACT_LIMITS.entryBytes });
  } catch {
    return null;
  }
};

const finish = (kind: FileKind, raw: TextPart[], limit: number): ExtractResult => {
  const parts = raw.map((part) => ({ number: part.number, text: tidy(part.text) })).filter((part) => part.text !== "");
  if (parts.length === 0) return { ok: false, reason: "empty" };
  const kept: TextPart[] = [];
  let used = 0;
  let truncated = false;
  for (const part of parts) {
    const room = limit - used;
    if (room <= 0) {
      truncated = true;
      break;
    }
    const text = part.text.length > room ? part.text.slice(0, room) : part.text;
    if (text.length < part.text.length) truncated = true;
    kept.push({ number: part.number, text });
    used += text.length + 2;
  }
  return { ok: true, value: { kind, parts: kept, text: kept.map((part) => part.text).join("\n\n"), truncated } };
};

/**
 * Extracts the text of one file. Never throws: a file this cannot read comes
 * back as a reason. `limit` caps the characters kept across the whole file.
 */
export const extractText = async (bytes: Uint8Array, file: { name: string; contentType: string | null }, deps: { readPdf: PdfReader }, limit: number = MAX_EXTRACTED_CHARS): Promise<ExtractResult> => {
  const kind = detectKind(file.name, file.contentType, bytes);
  if (!kind) return { ok: false, reason: ["pdf", "docx", "pptx"].includes(extensionOf(file.name)) && bytes.length > 0 ? "damaged" : "unsupported" };
  try {
    switch (kind) {
      case "pdf": {
        const read = await deps.readPdf(bytes, { maxPages: EXTRACT_LIMITS.pages });
        if (!read.ok) return { ok: false, reason: read.reason };
        return finish("pdf", read.pages.map((text, index) => ({ number: index + 1, text })), limit);
      }
      case "docx": {
        const entries = unzipEntries(bytes, (name) => name === "word/document.xml");
        const xml = entries?.["word/document.xml"];
        if (!xml) return { ok: false, reason: "damaged" };
        return finish("docx", [{ number: null, text: wordXmlToText(new TextDecoder("utf-8").decode(xml)) }], limit);
      }
      case "pptx": {
        const entries = unzipEntries(bytes, (name) => /^ppt\/slides\/slide\d{1,4}\.xml$/.test(name));
        if (!entries) return { ok: false, reason: "damaged" };
        const slides = Object.keys(entries)
          .map((name) => ({ name, number: Number(/slide(\d+)\.xml$/.exec(name)?.[1] ?? "0") }))
          .sort((a, b) => a.number - b.number)
          .slice(0, EXTRACT_LIMITS.slides);
        if (slides.length === 0) return { ok: false, reason: "damaged" };
        return finish("pptx", slides.map((slide) => ({ number: slide.number, text: slideXmlToText(new TextDecoder("utf-8").decode(entries[slide.name] as Uint8Array)) })), limit);
      }
      case "html":
        return finish("html", [{ number: null, text: htmlToText(decodeBytes(bytes)) }], limit);
      case "text":
        return finish("text", [{ number: null, text: decodeBytes(bytes) }], limit);
    }
  } catch {
    return { ok: false, reason: "damaged" };
  }
};

/** What to tell the student when a file gave no text. */
export const EXTRACT_FAILURE_COPY: Record<ExtractFailure, string> = {
  unsupported: "Nova can read PDF, Word, PowerPoint, web page, and plain text files. This one is a different kind.",
  empty: "This file has no text Nova can read. It may be a scan or an image.",
  damaged: "This file could not be opened. It may be damaged or not the kind its name says.",
  encrypted: "This PDF is password protected, so Nova cannot read it.",
};
