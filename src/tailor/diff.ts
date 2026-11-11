import type { BaseProfile } from "../profile/types";
import type { TailoredResume } from "./types";
import { sourceText } from "./truth";

export type DiffRow = { section: string; base: string | null; tailored: string | null; kind: "changed" | "moved" | "dropped" | "same" };

/** Per-bullet comparison with the base resume, in tailored order, followed by dropped bullets. */
export function diffAgainstBase(r: TailoredResume, p: BaseProfile): DiffRow[] {
  const rows: DiffRow[] = [];
  const used = new Set<string>();
  const add = (section: string, items: { source: string; text: string }[], baseOrder: string[]) => {
    items.forEach((b, i) => {
      used.add(b.source);
      const base = sourceText(p, b.source);
      const kind = base !== b.text ? "changed" : baseOrder.indexOf(b.source) > i ? "moved" : "same";
      rows.push({ section, base, tailored: b.text, kind });
    });
  };
  for (const role of r.roles) {
    const b = p.roles[role.roleIdx];
    add(`${b.title}, ${b.org}`, role.bullets, b.bullets.map((_, j) => `r${role.roleIdx}b${j}`));
  }
  add("Projects", r.projects, p.projects.map((_, i) => `p${i}`));
  p.roles.forEach((role, i) => role.bullets.forEach((text, j) => {
    if (!used.has(`r${i}b${j}`)) rows.push({ section: `${role.title}, ${role.org}`, base: text, tailored: null, kind: "dropped" });
  }));
  p.projects.forEach((x, i) => { if (!used.has(`p${i}`)) rows.push({ section: "Projects", base: `${x.name}: ${x.text}`, tailored: null, kind: "dropped" }); });
  return rows;
}
