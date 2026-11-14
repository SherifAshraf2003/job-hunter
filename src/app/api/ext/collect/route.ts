import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { denyUnlessExtension } from "../auth";
import { loadSettings } from "@/config";
import { db } from "@/db/client";
import { sites } from "@/db/schema";

export const dynamic = "force-dynamic";

const ROLES = ["AI engineer", "founding engineer", "full stack engineer", "product engineer", "software engineer"];

/** Whether a LinkedIn collection pass is due, and the searches to run (last 24 hours, no location filter). */
export async function GET(req: Request) {
  const deny = await denyUnlessExtension(req);
  if (deny) return deny;
  const cfg = await loadSettings();
  const [li] = await db.select().from(sites).where(eq(sites.site, "linkedin"));
  const last = cfg.linkedinCollectedAt ? +new Date(cfg.linkedinCollectedAt) : 0;
  const due = !cfg.globalPause && !li?.paused && Date.now() - last > cfg.searchIntervalHours * 3600_000;
  const searches = ROLES.map((r) => `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(r)}&f_TPR=r86400&sortBy=DD`);
  return NextResponse.json({ due, searches, perSearch: 10 });
}
