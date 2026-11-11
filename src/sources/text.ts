import type { NormalizedJob, Salary } from "./types";

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'", rsquo: "’", lsquo: "‘",
  rdquo: "”", ldquo: "“", mdash: "—", ndash: "–", hellip: "…", bull: "•",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z0-9]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Strips HTML to readable text. Handles entity-escaped HTML (Greenhouse double-escapes content). */
export function htmlToText(html: string): string {
  let s = html ?? "";
  for (let i = 0; i < 3 && /&(lt|amp|gt|quot|#\d+);/i.test(s); i++) s = decodeEntities(s);
  s = s
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|ul|ol|tr)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, " ");
  s = decodeEntities(s);
  return s.split("\n").map((l) => l.replace(/[ \t ]+/g, " ").trim()).filter(Boolean).join("\n").trim();
}

const CUR_SYMBOL: Record<string, string> = { $: "USD", "£": "GBP", "€": "EUR" };
const CUR_CODES = ["USD", "EUR", "GBP", "CAD", "AED", "SAR", "EGP", "INR", "AUD", "CHF"];

function num(raw: string, k: string | undefined): number {
  const n = parseFloat(raw.replace(/,/g, ""));
  return k && /k/i.test(k) ? n * 1000 : n;
}

/** Finds the first salary-looking amount or range in free text. Returns null when none is found. */
export function parseSalary(text: string): Salary | null {
  if (!text) return null;
  const t = text.replace(/–|—/g, "-");
  const re = new RegExp(
    String.raw`(?:(${CUR_CODES.join("|")})\s*|([$£€])\s?)(\d[\d,]*(?:\.\d+)?)\s*(k)?` +
    String.raw`(?:\s*(?:-|to)\s*(?:(?:${CUR_CODES.join("|")})\s*|[$£€]\s?)?(\d[\d,]*(?:\.\d+)?)\s*(k)?)?` +
    String.raw`(?:\s*(${CUR_CODES.join("|")}))?`, "i");
  const g = new RegExp(re.source, "gi");
  for (const m of t.matchAll(g)) {
    const start = m.index ?? 0, end = start + m[0].length;
    const after = t.slice(end, end + 40).toLowerCase();
    const before = t.slice(Math.max(0, start - 100), start).toLowerCase();
    // "$170 million in funding" and similar are not salaries.
    if (/^\s*(million|billion|mn|bn|m\b|b\b)/.test(after)) continue;
    const isRange = Boolean(m[5]);
    const payContext = /salary|pay|compensation|base|ote|earnings|wage|range|annual|per year|\/\s*y(ea)?r/.test(before + " " + after);
    if (!isRange && !payContext && !m[4]) continue;
    // A trailing currency code ("$58,000 - $68,000 CAD") beats the leading symbol.
    const currency = (m[7] ?? m[1] ?? (m[2] ? CUR_SYMBOL[m[2]] : undefined) ?? "USD").toUpperCase();
    const min = num(m[3], m[4] ?? m[6]);
    const max = m[5] ? num(m[5], m[6] ?? m[4]) : min;
    if (!Number.isFinite(min) || min < 10 || max < min) continue;
    let period: Salary["period"] = "year";
    if (/(per|\/|an?)\s*(hour|hr)|hourly/.test(after)) period = "hour";
    else if (/(per|\/|an?)\s*(month|mo)\b|monthly/.test(after)) period = "month";
    else if (max < 1000 && currency === "USD") period = "hour";
    return { min, max, currency, period };
  }
  return null;
}

/** Midpoint of a salary converted to USD per year, or null if the currency has no rate. */
export function toUsdYearMid(s: Salary, fx: Record<string, number>): number | null {
  const rate = fx[s.currency];
  const lo = s.min ?? s.max, hi = s.max ?? s.min;
  if (rate == null || lo == null || hi == null) return null;
  const mid = (lo + hi) / 2;
  const perYear = s.period === "month" ? mid * 12 : s.period === "hour" ? mid * 2080 : mid;
  return Math.round(perYear * rate);
}

export function inferRemote(location: string, text: string): NormalizedJob["remotePolicy"] {
  const l = (location ?? "").toLowerCase();
  if (/hybrid/.test(l)) return "hybrid";
  if (/remote|anywhere|worldwide/.test(l)) return "remote";
  const t = (text ?? "").slice(0, 3000).toLowerCase();
  if (/\bhybrid\b/.test(t)) return "hybrid";
  if (/\bfully remote\b|\bremote-first\b|\b100% remote\b/.test(t)) return "remote";
  if (l) return "onsite";
  return "unknown";
}

const COUNTRY_PATTERNS: [RegExp, string][] = [
  [/\b(egypt|cairo|alexandria|giza|new cairo|6th of october|smart village)\b/i, "EG"],
  [/\b(united kingdom|uk|london|manchester|edinburgh|england|scotland)\b/i, "GB"],
  [/\b(germany|berlin|munich|hamburg)\b/i, "DE"],
  [/\b(uae|united arab emirates|dubai|abu dhabi)\b/i, "AE"],
  [/\b(saudi|riyadh|jeddah|ksa)\b/i, "SA"],
  [/\b(canada|toronto|vancouver|montreal)\b/i, "CA"],
  [/\b(netherlands|amsterdam|rotterdam)\b/i, "NL"],
  [/\b(france|paris)\b/i, "FR"],
  [/\b(spain|madrid|barcelona)\b/i, "ES"],
  [/\b(poland|warsaw|krakow)\b/i, "PL"],
  [/\b(united states|usa|u\.s\.|us|san francisco|new york|nyc|seattle|austin|boston|chicago|los angeles|denver|palo alto|mountain view|sf bay area|bay area|ca|ny|tx|wa|ma)\b/i, "US"],
];

export function inferCountry(location: string): string | null {
  if (!location) return null;
  for (const [re, code] of COUNTRY_PATTERNS) if (re.test(location)) return code;
  return null;
}
