import { readFileSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { profile } from "../db/schema";
import { parseResumeTex } from "./parseLatex";
import type { BaseProfile } from "./types";

export function parseResumeFile(): BaseProfile {
  return parseResumeTex(readFileSync(path.join(process.cwd(), "resume.tex"), "utf8"));
}

export async function saveProfile(p: BaseProfile): Promise<void> {
  await db.insert(profile).values({ id: 1, data: p })
    .onConflictDoUpdate({ target: profile.id, set: { data: p, updatedAt: new Date() } });
}

/** Returns the saved profile; on first use parses resume.tex and saves it. */
export async function loadProfile(): Promise<BaseProfile> {
  const [row] = await db.select().from(profile).where(eq(profile.id, 1));
  if (row) return row.data as BaseProfile;
  const p = parseResumeFile();
  await saveProfile(p);
  return p;
}
