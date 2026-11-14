import { NextResponse } from "next/server";
import { denyUnlessExtension } from "../auth";
import { nextApplication } from "@/apply/queue";
import { loadSettings } from "@/config";

export const dynamic = "force-dynamic";

/** The next job for the extension to open, or why it should idle. */
export async function GET(req: Request) {
  const deny = await denyUnlessExtension(req);
  if (deny) return deny;
  const cfg = await loadSettings();
  return NextResponse.json({ ...(await nextApplication()), pacing: cfg.pacing, dryRun: cfg.dryRun });
}
