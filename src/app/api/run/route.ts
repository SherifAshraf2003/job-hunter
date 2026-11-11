import { NextResponse } from "next/server";
import { db } from "@/db/client";
import { runs } from "@/db/schema";

/** "Run now": queues a run; the worker picks it up within 30 seconds. */
export async function POST() {
  const [r] = await db.insert(runs).values({ requested: true }).returning({ id: runs.id });
  return NextResponse.json({ queued: r.id });
}
