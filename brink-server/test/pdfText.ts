// Text of a PDF page by page (pdfjs-dist), plus its info dictionary, for the export tests.
import { createRequire } from "node:module";
import path from "node:path";

export async function pdfText(bytes: Uint8Array): Promise<{ pages: string[]; info: Record<string, unknown> }> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const req = createRequire(import.meta.url);
  const fonts = path.join(path.dirname(req.resolve("pdfjs-dist/package.json")), "standard_fonts") + path.sep;
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0, standardFontDataUrl: fonts, isEvalSupported: false } as Parameters<typeof pdfjs.getDocument>[0]).promise;
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    pages.push(tc.items.map((it) => ("str" in it ? it.str : "")).join(" ").replace(/\s+/g, " "));
  }
  const meta = await doc.getMetadata();
  await doc.destroy();
  return { pages, info: (meta.info ?? {}) as Record<string, unknown> };
}
