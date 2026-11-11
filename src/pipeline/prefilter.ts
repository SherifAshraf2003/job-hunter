const INCLUDE = /\b(software|engineer|engineering|developer|full[- ]?stack|back[- ]?end|front[- ]?end|ai|ml|machine learning|llm|founding|product engineer)\b/i;
const EXCLUDE = /\b(intern|internship|staff|principal|director|vp|vice president|head of|manager|sales|account executive|recruit\w*|designer|analyst|qa|tester|support|technician|mechanical|electrical|civil|hardware)\b/i;
const TOO_SENIOR = /\b([89]|1\d)\+?\s*(years|yrs)\b/i;

/** Free, code-only filter that drops obvious non-matches before any paid scoring call. */
export function prefilter(j: { title: string; descriptionText: string }): { pass: true } | { pass: false; reason: string } {
  if (!INCLUDE.test(j.title)) return { pass: false, reason: "not a software role" };
  const ex = j.title.match(EXCLUDE);
  if (ex) return { pass: false, reason: `excluded title: ${ex[1].toLowerCase()}` };
  if (TOO_SENIOR.test(j.descriptionText)) return { pass: false, reason: "requires 8+ years" };
  return { pass: true };
}
