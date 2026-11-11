import { minimalPdf } from "@nova-agent/brightspace";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { EXTRACT_FAILURE_COPY, MAX_EXTRACTED_CHARS, decodeEntities, detectKind, extractText, htmlToText, tidy, type PdfReader } from "../../apps/extension/src/files/extract";
import { readPdf } from "../../apps/extension/src/files/pdf";

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

/** A stand-in reader for tests that are not about pdf.js itself. */
const fakePdf = (pages: string[]): PdfReader => async () => ({ ok: true, pages });
const noPdf: PdfReader = async () => ({ ok: false, reason: "damaged" });

const docx = (paragraphs: string): Uint8Array =>
  zipSync({
    "[Content_Types].xml": strToU8("<Types/>"),
    "word/document.xml": strToU8(`<?xml version="1.0"?><w:document xmlns:w="x"><w:body>${paragraphs}</w:body></w:document>`),
    "word/styles.xml": strToU8("<w:styles>ignored text</w:styles>"),
  });

const pptx = (slides: Record<number, string>): Uint8Array =>
  zipSync({
    "ppt/presentation.xml": strToU8("<p:presentation/>"),
    ...Object.fromEntries(Object.entries(slides).map(([number, body]) => [`ppt/slides/slide${number}.xml`, strToU8(`<p:sld xmlns:a="x"><p:cSld>${body}</p:cSld></p:sld>`)])),
    "ppt/notesSlides/notesSlide1.xml": strToU8("<a:p><a:r><a:t>speaker notes are not slides</a:t></a:r></a:p>"),
  });

const ok = async (promise: ReturnType<typeof extractText>) => {
  const result = await promise;
  if (!result.ok) throw new Error(`extraction failed: ${result.reason}`);
  return result.value;
};

describe("detectKind", () => {
  it("trusts the bytes over the name and the declared type", () => {
    const pdf = minimalPdf([["x"]]);
    expect(detectKind("handout.pdf", "application/pdf", pdf)).toBe("pdf");
    expect(detectKind("notes.txt", "text/plain", pdf)).toBe("pdf");
    expect(detectKind("handout.pdf", "application/pdf", utf8("not a pdf"))).toBeNull();
    expect(detectKind("essay.docx", null, docx("<w:p/>"))).toBe("docx");
    expect(detectKind("deck.pptx", null, pptx({ 1: "" }))).toBe("pptx");
    expect(detectKind("archive.zip", "application/zip", docx("<w:p/>"))).toBeNull();
    expect(detectKind("essay.docx", null, utf8("plain"))).toBeNull();
    expect(detectKind("page.html", null, utf8("<p>x</p>"))).toBe("html");
    expect(detectKind("topic", "text/html; charset=utf-8", utf8("<p>x</p>"))).toBe("html");
    expect(detectKind("lab.ino", null, utf8("void setup() {}"))).toBe("text");
    expect(detectKind("readme", "text/plain", utf8("hi"))).toBe("text");
    expect(detectKind("photo.png", "image/png", new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
    expect(detectKind("data.xlsx", null, new Uint8Array([0x50, 0x4b, 0x03, 0x04]))).toBeNull();
  });
});

describe("extractText", () => {
  it("reads a real PDF page by page through pdf.js", async () => {
    const bytes = minimalPdf([["Lab 3: Timer Interrupts", "Configure Timer1 for a 1 kHz interrupt."], ["Deliverables", "Submit main.c and a timing diagram (PDF)."]]);
    const value = await ok(extractText(bytes, { name: "Lab 3 handout.pdf", contentType: "application/pdf" }, { readPdf }));
    expect(value.kind).toBe("pdf");
    expect(value.parts.map((part) => part.number)).toEqual([1, 2]);
    expect(value.parts[0]?.text).toContain("Lab 3: Timer Interrupts");
    expect(value.parts[0]?.text).toContain("Configure Timer1 for a 1 kHz interrupt.");
    expect(value.parts[1]?.text).toContain("Submit main.c and a timing diagram (PDF).");
    expect(value.truncated).toBe(false);
    // The caller's bytes are still usable afterwards: pdf.js was given a copy.
    expect(bytes.length).toBeGreaterThan(100);
    expect(bytes[0]).toBe(0x25);
  });

  it("reports a damaged PDF instead of throwing", async () => {
    const broken = minimalPdf([["x"]]).slice(0, 40);
    expect(await extractText(broken, { name: "broken.pdf", contentType: null }, { readPdf })).toEqual({ ok: false, reason: "damaged" });
    expect(await extractText(utf8("hello"), { name: "fake.pdf", contentType: "application/pdf" }, { readPdf })).toEqual({ ok: false, reason: "damaged" });
  });

  it("reads Word paragraphs, tabs, breaks, and entities, and nothing outside the document body", async () => {
    const bytes = docx(
      '<w:p><w:r><w:t>Essay </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">prompt &amp; rubric</w:t></w:r></w:p>' +
        "<w:p><w:r><w:t>Name</w:t><w:tab/><w:t>Score</w:t></w:r></w:p>" +
        "<w:p><w:r><w:t>Line one</w:t><w:br/><w:t>Line two &#8212; done</w:t></w:r></w:p>" +
        "<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl>",
    );
    const value = await ok(extractText(bytes, { name: "essay.docx", contentType: null }, { readPdf: noPdf }));
    expect(value.kind).toBe("docx");
    expect(value.text).toBe("Essay prompt & rubric\nName Score\nLine one\nLine two — done\nCell");
    expect(value.text).not.toContain("ignored text");
    expect(value.parts).toEqual([{ number: null, text: value.text }]);
  });

  it("reads slides in numeric order, one part per slide, without the speaker notes", async () => {
    const bytes = pptx({
      10: "<a:p><a:r><a:t>Tenth slide</a:t></a:r></a:p>",
      2: "<a:p><a:r><a:t>Interrupt </a:t></a:r><a:r><a:t>latency</a:t></a:r></a:p><a:p><a:r><a:t>Second line</a:t><a:br/><a:t>after a break</a:t></a:r></a:p>",
      1: "<a:p><a:r><a:t>Lecture 5</a:t></a:r></a:p>",
      3: "<a:p></a:p>",
    });
    const value = await ok(extractText(bytes, { name: "lecture5.pptx", contentType: null }, { readPdf: noPdf }));
    expect(value.kind).toBe("pptx");
    // The empty slide is dropped, and the others keep their own numbers.
    expect(value.parts).toEqual([
      { number: 1, text: "Lecture 5" },
      { number: 2, text: "Interrupt latency\nSecond line\nafter a break" },
      { number: 10, text: "Tenth slide" },
    ]);
    expect(value.text).not.toContain("speaker notes");
  });

  it("turns a web page into text without its scripts, styles, or markup", async () => {
    const html = '<html><head><title>T</title><style>p{color:red}</style></head><body><script>alert("x")</script><h1>Syllabus</h1><p>Late work loses <b>10%</b> per day.</p><ul><li>One</li><li>Two &amp; three</li></ul><!-- hidden --><table><tr><td>A</td><td>B</td></tr></table></body></html>';
    const value = await ok(extractText(utf8(html), { name: "syllabus.html", contentType: "text/html" }, { readPdf: noPdf }));
    // The end of the list and the start of the table leave one blank line between them, never more.
    expect(value.text).toBe("Syllabus\nLate work loses 10% per day.\nOne\nTwo & three\n\nA B");
    expect(htmlToText("<p>a</p><script>evil()</script><p>b</p>")).not.toContain("evil");
    expect(htmlToText('<img src=x onerror="alert(1)">text')).toBe("text");
  });

  it("reads plain text in UTF-8 and UTF-16, and strips control characters", async () => {
    expect((await ok(extractText(utf8("﻿Lab notes\r\n\r\n\r\n\r\nStep  1\u0000\u0007 done"), { name: "notes.txt", contentType: null }, { readPdf: noPdf }))).text).toBe("Lab notes\n\nStep 1 done");
    const utf16 = new Uint8Array([0xff, 0xfe, 0x48, 0x00, 0x69, 0x00]);
    expect((await ok(extractText(utf16, { name: "hi.txt", contentType: null }, { readPdf: noPdf }))).text).toBe("Hi");
    expect(tidy("a \t b\n\n\n\nc  ")).toBe("a b\n\nc");
    // A code point past the Unicode range is dropped; an unknown name is left as it was written.
    expect(decodeEntities("&lt;b&gt; &amp; &#65;&#x42; &nbsp;&unknown; &#9999999;")).toBe("<b> & AB  &unknown; ");
  });

  it("clips to the limit across parts and says so", async () => {
    const pages = ["a".repeat(30), "b".repeat(30), "c".repeat(30)];
    const value = await ok(extractText(minimalPdf([["x"]]), { name: "long.pdf", contentType: null }, { readPdf: fakePdf(pages) }, 50));
    expect(value.truncated).toBe(true);
    expect(value.parts).toEqual([
      { number: 1, text: "a".repeat(30) },
      { number: 2, text: "b".repeat(18) },
    ]);
    expect(value.text.length).toBeLessThanOrEqual(50);
    const whole = await ok(extractText(utf8("short"), { name: "s.txt", contentType: null }, { readPdf: noPdf }));
    expect(whole.truncated).toBe(false);
    expect(MAX_EXTRACTED_CHARS).toBe(40_000);
  });

  it("names why a file gave no text: unsupported, empty, damaged, or encrypted", async () => {
    const extract = (bytes: Uint8Array, name: string, reader: PdfReader = noPdf) => extractText(bytes, { name, contentType: null }, { readPdf: reader });
    expect(await extract(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), "scan.png")).toEqual({ ok: false, reason: "unsupported" });
    expect(await extract(new Uint8Array(0), "nothing.bin")).toEqual({ ok: false, reason: "unsupported" });
    expect(await extract(utf8("   \n\n  "), "blank.txt")).toEqual({ ok: false, reason: "empty" });
    expect(await extract(minimalPdf([["x"]]), "scan.pdf", fakePdf(["", "  "]))).toEqual({ ok: false, reason: "empty" });
    expect(await extract(minimalPdf([["x"]]), "locked.pdf", async () => ({ ok: false, reason: "encrypted" }))).toEqual({ ok: false, reason: "encrypted" });
    expect(await extract(utf8("not a zip"), "essay.docx")).toEqual({ ok: false, reason: "damaged" });
    expect(await extract(zipSync({ "other.xml": strToU8("<x/>") }), "essay.docx")).toEqual({ ok: false, reason: "damaged" });
    expect(await extract(zipSync({ "ppt/presentation.xml": strToU8("<x/>") }), "deck.pptx")).toEqual({ ok: false, reason: "damaged" });
    expect(await extract(minimalPdf([["x"]]), "boom.pdf", async () => Promise.reject(new Error("reader crashed")))).toEqual({ ok: false, reason: "damaged" });
    for (const copy of Object.values(EXTRACT_FAILURE_COPY)) expect(copy.length).toBeGreaterThan(20);
  });
});
