import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PDFDocument } from "pdf-lib";
import type { BaseProfile } from "../profile/types";
import type { TailoredResume } from "./types";

const run = promisify(execFile);

/** Escapes text for LaTeX body content. */
export function latexEscape(s: string): string {
  return s
    .replace(/\\/g, "\u0000")
    .replace(/([&%$#_{}])/g, "\\$1")
    .replace(/\u0000/g, "\\textbackslash{}")
    .replace(/~/g, "\\textasciitilde{}")
    .replace(/\^/g, "\\textasciicircum{}")
    .replace(/"([^"]*)"/g, "``$1''")
    .replace(/"/g, "''")
    .replace(/\u2013/g, "--").replace(/\u2014/g, "---");
}

/**
 * The preamble of resume.tex, with the XeTeX font line pointed at TeX Gyre Heros font files bundled with Tectonic
 * (the font isn't installed system-wide, so loading it by name fails).
 */
export function preamble(baseTex: string): string {
  return baseTex.slice(0, baseTex.indexOf("\\begin{document}")).replace(
    /\\setsansfont\{TeX Gyre Heros\}\[Scale=0\.92\]/,
    "\\setsansfont{texgyreheros}[Extension=.otf, UprightFont=*-regular, BoldFont=*-bold, ItalicFont=*-italic, BoldItalicFont=*-bolditalic, Scale=0.92]",
  );
}

const e = latexEscape;
const itemize = (items: string[]) => (items.length ? `\\begin{itemize}\n${items.map((i) => `    \\item{} ${i}`).join("\n")}\n\\end{itemize}\n` : "");

export function renderTex(r: TailoredResume, p: BaseProfile, baseTex: string): string {
  const [email, ...links] = p.links;
  const header = [
    `\\href{mailto:${email}}{${e(email)}}`,
    ...links.map((l) => `\\href{${/^https?:/.test(l) ? l : `https://${l}`}}{${e(l.replace(/^https?:\/\//, ""))}}`),
  ].join(" | ");
  const roles = r.roles.map((role, i) => {
    const b = p.roles[role.roleIdx];
    let s = `\\role{${e(b.title)}}{${e(b.org)}}{${e(b.dates)}}\n${itemize(role.bullets.map((x) => e(x.text)))}`;
    if (role.roleIdx === 0 && r.includeQuote && p.quote) {
      const m = p.quote.match(/^\u201C?(.*?)\u201D?\s*\u2013\s*(.*)$/);
      s += m ? `\\textit{\`\`${e(m[1])}''} -- ${e(m[2])}\\par\n` : `\\textit{${e(p.quote)}}\\par\n`;
    }
    return s + (i < r.roles.length - 1 ? "\\vspace{3pt}\n\n" : "");
  }).join("");
  const projects = r.projects.map((x) => {
    const name = p.projects[Number(x.source.slice(1))]?.name ?? "";
    return `\\textbf{${e(name)}:} ${e(x.text)}`;
  });
  const skills = r.skills.map((c) => `\\textbf{${e(c.category)}:} ${c.items.map(e).join(", ")}`).join("\\par\\vspace{2pt}\n");
  const edu = p.education.map((x) => `\\role{${e(x.degree)}}{${e(x.school)}}{${e(x.dates)}}\n` +
    (x.coursework.length ? `\\textbf{Relevant Coursework:} ${x.coursework.map(e).join(", ")}\n` : "")).join("");
  const awards = p.awards.map((a) => `\\textbf{${e(a.name)}:} ${e(a.text)}`);

  return `${preamble(baseTex)}\\begin{document}

\\begin{center}
{\\LARGE\\textbf{${e(p.name)}}}\\par\\vspace{4pt}
{\\normalsize ${e(r.headline)}}\\par\\vspace{3pt}
\\small
${header}
\\end{center}

\\section{Experience}
${roles}
${projects.length ? `\\section{Projects}\n${itemize(projects)}` : ""}
\\section{Skills}
${skills}

\\section{Education}
${edu}
${awards.length ? `\\section{Awards}\n${itemize(awards)}` : ""}
\\end{document}
`;
}

/** Compiles with Tectonic into outDir/resume.pdf and returns the page count. */
export async function compilePdf(tex: string, outDir: string): Promise<{ pdfPath: string; pages: number }> {
  mkdirSync(outDir, { recursive: true });
  const texPath = path.join(outDir, "resume.tex");
  writeFileSync(texPath, tex);
  try {
    await run("tectonic", ["-X", "compile", texPath, "--outdir", outDir], { timeout: 180_000 });
  } catch (err) {
    const x = err as NodeJS.ErrnoException & { stderr?: string };
    if (x.code === "ENOENT") throw new Error("Tectonic isn't installed (brew install tectonic)");
    const line = (x.stderr ?? "").split("\n").find((l) => /^error|^!/.test(l)) ?? x.message;
    throw new Error(`LaTeX compile failed: ${line.slice(0, 200)}`);
  }
  const pdfPath = path.join(outDir, "resume.pdf");
  const pages = (await PDFDocument.load(readFileSync(pdfPath))).getPageCount();
  return { pdfPath, pages };
}

/** One trim step: last project, then the last bullet of the longest role (min 2), then the quote. Null when nothing is left to trim. */
function trimOnce(r: TailoredResume): TailoredResume | null {
  const t = structuredClone(r);
  if (t.projects.length) { t.projects.pop(); return t; }
  const longest = [...t.roles].sort((a, b) => b.bullets.length - a.bullets.length)[0];
  if (longest && longest.bullets.length > 2) { longest.bullets.pop(); return t; }
  if (t.includeQuote) { t.includeQuote = false; return t; }
  return null;
}

export async function fitOnePage(r: TailoredResume, p: BaseProfile, baseTex: string, outDir: string): Promise<{ resume: TailoredResume; pdfPath: string }> {
  let cur = r;
  for (let i = 0; i <= 8; i++) {
    const { pdfPath, pages } = await compilePdf(renderTex(cur, p, baseTex), outDir);
    if (pages <= 1) return { resume: cur, pdfPath };
    const next = trimOnce(cur);
    if (!next) break;
    cur = next;
  }
  throw new Error("does not fit one page");
}
