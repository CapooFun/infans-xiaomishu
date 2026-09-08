import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";

let pdfjsPromise;
const require = createRequire(import.meta.url);
const pdfPackageDirectory = path.dirname(require.resolve("pdfjs-dist/package.json"));
const standardFontDataUrl = path.join(pdfPackageDirectory, "standard_fonts") + path.sep;

async function pdfjs() {
  pdfjsPromise ??= import("pdfjs-dist/legacy/build/pdf.mjs");
  return pdfjsPromise;
}

export async function extractPdfPages(filePath, options = {}) {
  const { maxPages = Number.POSITIVE_INFINITY } = options;
  const data = new Uint8Array(await fs.readFile(filePath));
  const { getDocument } = await pdfjs();
  const task = getDocument({
    data,
    disableFontFace: true,
    isEvalSupported: false,
    standardFontDataUrl,
    useSystemFonts: false,
  });
  const document = await task.promise;
  const pageCount = Math.min(document.numPages, maxPages);
  const pages = [];

  try {
    for (let number = 1; number <= pageCount; number += 1) {
      const page = await document.getPage(number);
      const content = await page.getTextContent();
      const text = content.items
        .map((item) => ("str" in item ? item.str : ""))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      pages.push({ page: number, text });
      page.cleanup();
    }
  } finally {
    await task.destroy();
  }

  return { totalPages: document.numPages, pages };
}
