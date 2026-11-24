// Runs a source refresh with health bookkeeping. A failing source never throws past here.

import { readHealth, recordError, recordSuccess } from "./cache.ts";
import { REFRESH_MS, type SourceId } from "./constants.ts";
import { refreshDoj } from "./sources/doj.ts";
import { refreshGdelt } from "./sources/gdelt.ts";
import { refreshSdg } from "./sources/sdg.ts";

const REFRESHERS: Record<SourceId, () => Promise<string>> = {
  sdg: refreshSdg,
  doj: refreshDoj,
  gdelt: refreshGdelt,
};
export const SOURCE_IDS = Object.keys(REFRESHERS) as SourceId[];

const inFlight = new Map<SourceId, Promise<boolean>>();

/** Refresh one source. Resolves true on success, false on failure (the last good cache stays in place). */
export function refreshSource(id: SourceId): Promise<boolean> {
  const running = inFlight.get(id);
  if (running) return running;
  const started = Date.now();
  const p = (async () => {
    try {
      const summary = await REFRESHERS[id]();
      recordSuccess(id, summary);
      console.log(`[${id}] ok in ${((Date.now() - started) / 1000).toFixed(1)}s`);
      return true;
    } catch (err) {
      recordError(id, err);
      console.error(`[${id}] FAILED: ${err instanceof Error ? err.message : String(err)} — serving last good cache`);
      return false;
    } finally {
      inFlight.delete(id);
    }
  })();
  inFlight.set(id, p);
  return p;
}

/** Start the in-process schedule: refresh anything overdue now, then on each source's interval. */
export function startScheduler(): void {
  const health = readHealth();
  for (const id of SOURCE_IDS) {
    const last = health[id].lastSuccess ? Date.parse(health[id].lastSuccess!) : 0;
    const age = Date.now() - last;
    if (age >= REFRESH_MS[id]) {
      console.log(`[scheduler] ${id}: ${last ? "cache is overdue" : "no cache yet"}, refreshing now`);
      void refreshSource(id);
    } else {
      console.log(`[scheduler] ${id}: cache is ${Math.round(age / 60_000)} min old, next refresh on schedule`);
    }
    setInterval(() => void refreshSource(id), REFRESH_MS[id]).unref?.();
  }
}
