import { and, eq, isNull, asc } from "drizzle-orm";
import { db, closeDb } from "../db/client";
import { runs } from "../db/schema";
import { runSearchCycle, abandonStaleRuns } from "../pipeline/cycle";
import { loadSettings } from "../config";

let busy = false;

async function cycle(runId?: number) {
  if (busy) return;
  busy = true;
  const t0 = Date.now();
  try {
    const s = await runSearchCycle({ runId });
    console.log(`[${new Date().toISOString()}] cycle done in ${Math.round((Date.now() - t0) / 1000)}s: ` +
      `boards ${s.boards} (failed ${s.boardFailures}), +${s.inserted} new, ${s.updated} updated, ${s.closed} closed, ` +
      `${s.seeded} seeded, ${s.harvested} harvested, ${s.scored} scored, ${s.filtered} filtered, ${s.scoreFailed} failed` +
      `${s.stoppedForBudget ? ", stopped for budget" : ""}${s.errors.length ? `, ${s.errors.length} errors` : ""}`);
  } catch (e) {
    console.error("cycle crashed:", e);
  } finally {
    busy = false;
  }
}

async function main() {
  if (process.argv.includes("--once")) {
    await cycle();
    await closeDb();
    return;
  }
  await abandonStaleRuns();
  let nextAt = Date.now();
  // Single loop: checks for "Run now" requests every 30s, runs the scheduled cycle when due.
  for (;;) {
    const [req] = await db.select().from(runs).where(and(eq(runs.requested, true), isNull(runs.status))).orderBy(asc(runs.id)).limit(1);
    if (req) await cycle(req.id);
    else if (Date.now() >= nextAt) {
      await cycle();
      const { searchIntervalHours } = await loadSettings();
      nextAt = Date.now() + searchIntervalHours * 3600_000;
    }
    await new Promise((r) => setTimeout(r, 30_000));
  }
}

main();
