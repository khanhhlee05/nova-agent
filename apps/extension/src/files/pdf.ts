import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import type { PdfReader } from "./extract";

/**
 * PDF text through pdf.js, loaded only when a PDF is actually read. The
 * legacy build is used because the extension still supports Chrome 116.
 * Nothing is rendered: only the text layer is read, with font loading off.
 */
export const readPdf: PdfReader = async (bytes, { maxPages }) => {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  // In the extension the parser runs in a worker bundled with it. Without Worker (tests, Node) pdf.js runs it in place.
  if (typeof Worker !== "undefined") pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  // pdf.js takes ownership of the buffer it is given, so it gets a copy.
  const task = pdfjs.getDocument({ data: bytes.slice(), disableFontFace: true, useSystemFonts: false, verbosity: 0 });
  try {
    const document = await task.promise;
    const pages: string[] = [];
    for (let number = 1; number <= Math.min(document.numPages, maxPages); number++) {
      const page = await document.getPage(number);
      const content = await page.getTextContent();
      pages.push(content.items.map((item) => ("str" in item ? `${item.str}${item.hasEOL ? "\n" : ""}` : "")).join(""));
      page.cleanup();
    }
    return { ok: true, pages };
  } catch (error) {
    return { ok: false, reason: error instanceof Error && error.name === "PasswordException" ? "encrypted" : "damaged" };
  } finally {
    await task.destroy().catch(() => undefined);
  }
};
