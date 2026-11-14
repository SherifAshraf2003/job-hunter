import { PDFDocument, StandardFonts } from "pdf-lib";
import type { BaseProfile } from "../profile/types";

/** A plain one-or-two page cover letter PDF: name and contact header, then wrapped paragraphs. */
export async function coverLetterPdf(text: string, profile: BaseProfile): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const W = 612, H = 792, M = 72, size = 11, lead = 15;
  let page = doc.addPage([W, H]);
  let y = H - M;
  page.drawText(profile.name, { x: M, y, size: 16, font: bold }); y -= 20;
  page.drawText(profile.links.join("  |  "), { x: M, y, size: 9, font }); y -= 30;
  // Standard fonts only cover WinAnsi; swap the usual typographic characters for plain ones.
  const clean = text.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-").replace(/[^\x09\x0A\x0D\x20-\x7E]/g, "");
  for (const para of clean.split(/\n\s*\n|\n/)) {
    let line = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) > W - 2 * M) {
        if (y < M) { page = doc.addPage([W, H]); y = H - M; }
        page.drawText(line, { x: M, y, size, font }); y -= lead; line = word;
      } else line = next;
    }
    if (line) { if (y < M) { page = doc.addPage([W, H]); y = H - M; } page.drawText(line, { x: M, y, size, font }); y -= lead; }
    y -= lead / 2;
  }
  return doc.save();
}
