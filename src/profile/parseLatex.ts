import type { BaseProfile } from "./types";

/** Convert a LaTeX fragment to plain text. */
function clean(s: string): string {
  return s
    .replace(/\\href\{[^}]*\}\{([^}]*)\}/g, "$1")
    .replace(/\\(?:vspace|hspace)\{[^}]*\}/g, "")
    .replace(/\\par\b/g, " ")
    .replace(/\\hfill\b/g, " ")
    .replace(/``/g, "“").replace(/''/g, "”")
    .replace(/---/g, "—").replace(/--/g, "–")
    .replace(/\\([%&$#_{}])/g, "$1")
    .replace(/\\textbf\{([^}]*)\}/g, "$1").replace(/\\textit\{([^}]*)\}/g, "$1")
    .replace(/\\(?:LARGE|Large|large|normalsize|small|footnotesize)\b/g, "")
    .replace(/[{}]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function items(block: string): string[] {
  const m = block.match(/\\begin\{itemize\}([\s\S]*?)\\end\{itemize\}/);
  if (!m) return [];
  return m[1].split(/\\item\b/).slice(1).map((x) => x.trim()).filter(Boolean);
}

const ROLE = /\\role\{([^}]*)\}\{([^}]*)\}\{([^}]*)\}/g;

export function parseResumeTex(tex: string): BaseProfile {
  const body = tex.slice(tex.indexOf("\\begin{document}"));
  const header = body.match(/\\begin\{center\}([\s\S]*?)\\end\{center\}/)![1];
  const name = clean(header.match(/\\textbf\{([^}]*)\}/)![1]);
  const headline = clean(header.match(/\\normalsize\s+([^}]*)\}/)![1]);
  const links = [...header.matchAll(/\\href\{([^}]*)\}/g)].map((m) => m[1].replace(/^mailto:/, ""));

  const sections: Record<string, string> = {};
  const parts = body.split(/\\section\{([^}]*)\}/);
  for (let i = 1; i < parts.length; i += 2) sections[parts[i]] = parts[i + 1];

  const roles: BaseProfile["roles"] = [];
  let quote: string | undefined;
  const exp = sections["Experience"] ?? "";
  const roleMatches = [...exp.matchAll(ROLE)];
  roleMatches.forEach((m, idx) => {
    const end = idx + 1 < roleMatches.length ? roleMatches[idx + 1].index! : exp.length;
    const chunk = exp.slice(m.index! + m[0].length, end);
    roles.push({ title: clean(m[1]), org: clean(m[2]), dates: clean(m[3]), bullets: items(chunk).map(clean) });
    const q = chunk.match(/\\end\{itemize\}\s*\\textit\{([\s\S]*?)\}\s*(--[^\n\\]*)/);
    if (q && !quote) quote = clean(q[1] + " " + q[2]);
  });

  const labeled = (raw: string) => {
    const m = raw.match(/^\\textbf\{([^}]*?):?\}:?\s*([\s\S]*)$/);
    return m ? { name: clean(m[1]).replace(/:$/, ""), text: clean(m[2]) } : { name: "", text: clean(raw) };
  };

  const projects = items(sections["Projects"] ?? "").map(labeled);
  const awards = items(sections["Awards"] ?? "").map(labeled);

  const skills: Record<string, string[]> = {};
  for (const m of (sections["Skills"] ?? "").matchAll(/\\textbf\{([^}]*?):\}\s*([^\\\n]*)/g)) {
    skills[clean(m[1])] = m[2].split(",").map((s) => clean(s)).filter(Boolean);
  }

  const education: BaseProfile["education"] = [];
  const edu = sections["Education"] ?? "";
  for (const m of edu.matchAll(ROLE)) {
    const cw = edu.match(/Relevant Coursework:\}\s*([^\n]*)/);
    education.push({
      degree: clean(m[1]), school: clean(m[2]), dates: clean(m[3]),
      coursework: cw ? cw[1].split(",").map((s) => clean(s)).filter(Boolean) : [],
    });
  }

  return {
    name, headline, links, roles, quote, projects, skills, education, awards,
    facts: { citizenship: "Egypt", location: "Egypt", yearsExperience: 2 },
  };
}
