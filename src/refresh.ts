// `npm run refresh` — fetch every source once, write the caches, log counts, exit.

import { readHealth } from "./cache.ts";
import { refreshSource, SOURCE_IDS } from "./runner.ts";

const only = process.argv.slice(2).filter((a) => (SOURCE_IDS as string[]).includes(a));
const ids = only.length ? (only as typeof SOURCE_IDS) : SOURCE_IDS;

console.log(`Refreshing: ${ids.join(", ")} (constants need no fetch)`);
const results = await Promise.all(ids.map((id) => refreshSource(id)));

const health = readHealth();
console.log("\n=== refresh summary ===");
console.log("constants: 4 hardcoded figures (src/constants.ts)");
ids.forEach((id, i) => {
  const h = health[id];
  console.log(results[i] ? `${id}: OK — ${h.lastSummary}` : `${id}: FAILED — ${h.lastError?.message} (last good: ${h.lastSuccess ?? "never"})`);
});
process.exit(results.every(Boolean) ? 0 : 1);
