import { NextResponse } from "next/server";
import { denyUnlessExtension } from "../auth";
import { applyReport } from "@/apply/report";
import type { Report } from "@/apply/types";

export const dynamic = "force-dynamic";

const OUTCOMES = new Set(["submitting", "applied", "stopped", "needs_you", "closed", "failed", "captcha", "blocked", "login_wall"]);

/** What happened on the page for one job. */
export async function POST(req: Request) {
  const deny = await denyUnlessExtension(req);
  if (deny) return deny;
  const b = (await req.json().catch(() => null)) as (Report & { jobId?: unknown }) | null;
  const jobId = Number(b?.jobId);
  if (!b || !Number.isInteger(jobId) || !OUTCOMES.has(b.outcome)) return NextResponse.json({ error: "Expected {jobId, outcome}" }, { status: 400 });
  await applyReport(jobId, {
    outcome: b.outcome, reason: typeof b.reason === "string" ? b.reason.slice(0, 300) : null,
    url: typeof b.url === "string" && /^https?:\/\//.test(b.url) ? b.url : undefined,
    status: b.status === "ready_to_submit" ? "ready_to_submit" : b.status === "needs_you" ? "needs_you" : undefined,
  });
  return NextResponse.json({ ok: true });
}
