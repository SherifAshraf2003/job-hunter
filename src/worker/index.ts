import { and, eq, isNull, asc } from "drizzle-orm";
import { db, closeDb } from "../db/client";
import { runs } from "../db/schema";
import { runSearchCycle, abandonStaleRuns } from "../pipeline/cycle";
import { loadSettings } from "../config";

let busy = false;

async function cycle(runId?: number, skipSearch = false) {
  if (busy) return;
  busy = true;
  const t0 = Date.now();
  try {
    const s = await runSearchCycle({ runId, skipSearch });
    console.log(`[${new Date().toISOString()}] cycle done in ${Math.round((Date.now() - t0) / 1000)}s: ` +
      `boards ${s.boards} (failed ${s.boardFailures}), +${s.inserted} new, ${s.updated} updated, ${s.closed} closed, ` +
      `${s.seeded} seeded, ${s.harvested} harvested, ${s.scored} scored, ${s.filtered} filtered, ${s.scoreFailed} failed, ` +
      `tailored ${s.tailored} (${Object.entries((s as { tailoredByTier?: Record<string, number> }).tailoredByTier ?? {}).map(([k, v]) => `${k} ${v}`).join(", ")})${s.tailorFailed ? `, ${s.tailorFailed} tailoring failed` : ""}` +
      `${s.stoppedForBudget ? ", stopped for budget" : ""}${s.errors.length ? `, ${s.errors.length} errors` : ""}`);
  } catch (e) {
    console.error("cycle crashed:", e);
  } finally {
    busy = false;
  }
}

async function main() {
  if (process.argv.includes("--once")) {
    await cycle(undefined, process.argv.includes("--skip-search"));
    await closeDb();
    return;
  }
  await abandonStaleRuns();
  let nextAt = Date.now();
  // Single loop: checks for "Run now" requests every 30s, runs the scheduled cycle when due.
  for (;;) {
    try {
      const [req] = await db.select().from(runs).where(and(eq(runs.requested, true), isNull(runs.status))).orderBy(asc(runs.id)).limit(1);
      if (req) await cycle(req.id);
      else if (Date.now() >= nextAt) {
        await cycle();
        const { searchIntervalHours } = await loadSettings();
        nextAt = Date.now() + searchIntervalHours * 3600_000;
      }
    } catch (e) {
      // e.g. Postgres restarted: log and keep the worker alive; the next loop retries.
      console.error(`[${new Date().toISOString()}] worker loop error:`, (e as Error).message);
    }
    await new Promise((r) => setTimeout(r, 30_000));
  }
}

main().catch((e) => { console.error("worker crashed:", e); process.exit(1); });
