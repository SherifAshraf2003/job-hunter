import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { answers } from "../db/schema";

/** Bank key for a form label: lowercase, no "*" or "(optional)", no punctuation, single spaces. */
export function normalizeQuestion(label: string): string {
  return label.toLowerCase()
    .replace(/\((optional|required)\)/g, " ")
    .replace(/[*?:.,!"'’()[\]/\\-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export async function lookupBank(label: string): Promise<string | null> {
  const [row] = await db.select().from(answers).where(eq(answers.key, normalizeQuestion(label)));
  return row?.answer ?? null;
}

/** Saves a newly drafted answer for Sherif to review. Never overwrites a seeded or edited answer. */
export async function saveDrafted(label: string, answer: string): Promise<void> {
  const key = normalizeQuestion(label);
  if (!key) return;
  const [row] = await db.select().from(answers).where(eq(answers.key, key));
  if (row && row.source !== "drafted") return;
  await db.insert(answers).values({ key, question: label, answer, source: "drafted", isNew: true })
    .onConflictDoUpdate({ target: answers.key, set: { answer, isNew: true, updatedAt: new Date() } });
}

export type BankSetup = { phone: string; city: string; noticePeriod: string; relocate: "Yes" | "No"; heardFrom: string };

const PHRASES: Record<keyof BankSetup, string[]> = {
  phone: ["Phone", "Phone number", "Mobile", "Mobile number", "Phone Number"],
  city: ["City", "Location", "Current location", "Location (City)", "Where are you based?", "Where are you located?"],
  noticePeriod: ["Notice period", "When can you start?", "Start date", "Earliest start date", "Availability to start"],
  relocate: ["Willing to relocate?", "Are you willing to relocate?", "Would you be willing to relocate?"],
  heardFrom: ["How did you hear about us?", "How did you hear about this job?", "How did you hear about this position?", "Source"],
};

/** Writes the setup form into the bank under the common phrasings of each question. Overwrites earlier seeds. */
export async function seedBank(setup: BankSetup): Promise<void> {
  for (const [field, phrases] of Object.entries(PHRASES) as [keyof BankSetup, string[]][]) {
    const answer = setup[field]?.trim();
    if (!answer) continue;
    for (const q of phrases) {
      const key = normalizeQuestion(q);
      await db.insert(answers).values({ key, question: q, answer, source: "seed", isNew: false })
        .onConflictDoUpdate({ target: answers.key, set: { answer, source: "seed", isNew: false, updatedAt: new Date() } });
    }
  }
}
