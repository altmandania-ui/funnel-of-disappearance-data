// HTTP server: one JSON API for the frontend + a plain debug page. The browser never calls a source API.

import { readFileSync } from "node:fs";
import { serve } from "@hono/node-server";
import { Hono, type Context } from "hono";
import { isStale, readHealth } from "./cache.ts";
import { CAVEATS, DOJ_BACKFILL_YEARS, ESTIMATES, REFRESH_MS, SOURCE_INFO, type SourceId } from "./constants.ts";
import { COUNTRY_TABLE } from "./countries.ts";
import { startScheduler } from "./runner.ts";
import { getCases, type DojCase } from "./sources/doj.ts";
import { getNews, getTimeline } from "./sources/gdelt.ts";
import { getCountryRecords, getDetected } from "./sources/sdg.ts";

const app = new Hono();

type Caveat = keyof typeof CAVEATS;

/** Every response carries `sources` (with fetchedAt + stale) and `caveats`. */
function respond(c: Context, data: Record<string, unknown>, sourceIds: (SourceId | "ilo")[], caveats: Caveat[], status: 200 | 400 | 404 = 200) {
  const health = readHealth();
  const sources = sourceIds.map((id) =>
    id === "ilo"
      ? { id, ...SOURCE_INFO.ilo, fetchedAt: null, stale: false, note: "hardcoded constant" }
      : { id, ...SOURCE_INFO[id], fetchedAt: health[id].lastSuccess, stale: isStale(id, health) },
  );
  return c.json({ ...data, stale: sources.some((s) => s.stale), sources, caveats: caveats.map((k) => CAVEATS[k]) }, status);
}

function intParam(v: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(v);
  return v !== undefined && Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : fallback;
}

const countable = (c: DojCase) => c.stage !== null && c.confidence !== "low";

// ---------------------------------------------------------------- /api/funnel

app.get("/api/funnel", (c) => {
  const health = readHealth();
  const detected = getDetected();
  const doj = getCases();
  const news = getNews(24);

  const cases = (doj?.cases ?? []).filter(countable);
  const tally = <K extends string>(f: (x: DojCase) => K | null) => {
    const out: Record<string, number> = {};
    for (const x of cases) {
      const k = f(x);
      if (k) out[k] = (out[k] ?? 0) + 1;
    }
    return out;
  };

  const stages = [
    {
      id: "estimated",
      label: ESTIMATES.modernSlavery.label,
      value: ESTIMATES.modernSlavery.value,
      unit: "people",
      year: ESTIMATES.modernSlavery.year,
      scope: "worldwide",
      breakdown: ESTIMATES.modernSlavery.breakdown,
      related: { forcedLabourProfitUsdPerYear: ESTIMATES.forcedLabourProfit.value, source: ESTIMATES.forcedLabourProfit.source },
      source: ESTIMATES.modernSlavery.source,
      caveat: CAVEATS.estimatedVsDetected,
      stale: false,
    },
    {
      id: "detected",
      label: "Trafficking victims detected by authorities",
      // Headline = most recent year with near-complete country coverage; the latest year is reported alongside.
      value: detected?.headlineYear.total ?? null,
      unit: "detected victims",
      year: detected?.headlineYear.year ?? null,
      scope: detected ? `sum over the ${detected.headlineYear.countries} countries that reported for ${detected.headlineYear.year}` : null,
      countriesReporting: detected?.headlineYear.countries ?? null,
      latestYear: detected?.latestYear ?? null,
      byYear: detected?.byYear ?? [],
      source: SOURCE_INFO.sdg,
      caveat: CAVEATS.detectedNotTrue,
      stale: isStale("sdg", health),
    },
    {
      id: "prosecuted",
      label: "US federal trafficking cases announced by the Department of Justice",
      value: doj ? cases.length : null,
      unit: "press releases",
      scope: `United States, federal, last ${DOJ_BACKFILL_YEARS} years`,
      since: doj?.backfillSince ?? null,
      byStage: tally((x) => x.stage),
      byType: tally((x) => x.type),
      excluded: doj
        ? {
            lowConfidence: doj.cases.filter((x) => x.confidence === "low").length,
            notCaseUpdates: doj.cases.filter((x) => x.stage === null && x.confidence !== "low").length,
          }
        : null,
      source: SOURCE_INFO.doj,
      caveat: CAVEATS.casesScope,
      stale: isStale("doj", health),
    },
    {
      id: "reported",
      label: "News articles in the last 24 hours",
      value: news.fetchedAt ? news.items.length : null,
      unit: "articles (deduplicated)",
      scope: "worldwide, last 24 hours",
      rawArticles: news.rawCount,
      titleRelevant: news.items.filter((i) => i.relevance === "title").length,
      withImage: news.items.filter((i) => i.image).length,
      source: SOURCE_INFO.gdelt,
      caveat: CAVEATS.newsNoise,
      stale: isStale("gdelt", health),
    },
  ];

  return respond(
    c,
    {
      stages,
      totals: Object.fromEntries(stages.map((s) => [s.id, s.value])),
      latestYear: detected ? { detected: detected.latestYear, headline: detected.headlineYear } : null,
      caveat: CAVEATS.estimatedVsDetected,
      lastUpdated: { constants: null, sdg: health.sdg.lastSuccess, doj: health.doj.lastSuccess, gdelt: health.gdelt.lastSuccess },
    },
    ["ilo", "sdg", "doj", "gdelt"],
    ["estimatedVsDetected", "funnelUnits", "detectedNotTrue", "detectedCoverage", "casesScope", "casesStage", "newsNoise"],
  );
});

// ---------------------------------------------------------------- /api/detected

app.get("/api/detected", (c) => {
  const detected = getDetected();
  const caveats: Caveat[] = ["detectedNotTrue", "detectedCoverage", "detectedSources", "detectedSuppressed", "estimatedVsDetected"];
  const country = c.req.query("country")?.toUpperCase();

  if (country) {
    if (!/^[A-Z]{3}$/.test(country)) return respond(c, { error: "country must be an ISO3 code, e.g. ?country=NPL" }, ["sdg"], caveats, 400);
    const summary = detected?.countries.find((x) => x.iso3 === country) ?? null;
    return respond(
      c,
      {
        country: summary,
        // every record, including Sex (BOTHSEX/MALE/FEMALE) and Age breakdowns; totals are BOTHSEX + ALLAGE
        records: getCountryRecords(country),
        ageLabels: detected?.cache.ageLabels ?? {},
        sexLabels: detected?.cache.sexLabels ?? {},
        seriesDescriptions: detected?.cache.seriesDescriptions ?? {},
      },
      ["sdg"],
      caveats,
    );
  }

  const year = detected?.latestYear.year ?? null;
  const headline = detected?.headlineYear.year ?? null;
  const at = (points: { year: number; value: number | null; suppressed: boolean }[], y: number | null) => points.find((p) => p.year === y) ?? null;
  return respond(
    c,
    {
      latestYear: detected?.latestYear ?? null,
      headlineYear: detected?.headlineYear ?? null,
      byYear: detected?.byYear ?? [],
      countries: (detected?.countries ?? []).map((x) => ({
        iso3: x.iso3,
        m49: x.m49,
        country: x.country,
        latest: x.latest,
        latestYearValue: at(x.timeSeries, year),
        headlineYearValue: at(x.timeSeries, headline),
        timeSeries: x.timeSeries,
        byPurpose: x.byPurpose,
      })),
      unmappedAreas: detected?.cache.unmappedAreas ?? [],
      seriesDescriptions: detected?.cache.seriesDescriptions ?? {},
    },
    ["sdg"],
    caveats,
  );
});

// ---------------------------------------------------------------- /api/cases

app.get("/api/cases", (c) => {
  const caveats: Caveat[] = ["casesScope", "casesStage", "casesExtraction", "casesNoVictims"];
  const type = c.req.query("type");
  const since = c.req.query("since");
  const confidence = c.req.query("confidence");
  if (type && type !== "sex" && type !== "labor") return respond(c, { error: "type must be sex or labor" }, ["doj"], caveats, 400);
  if (since && !/^\d{4}-\d{2}-\d{2}$/.test(since)) return respond(c, { error: "since must be YYYY-MM-DD" }, ["doj"], caveats, 400);

  const cache = getCases();
  let cases = cache?.cases ?? []; // stored newest first
  if (type) cases = cases.filter((x) => x.type === type || x.type === "both");
  if (since) cases = cases.filter((x) => x.date >= since);
  if (confidence) cases = cases.filter((x) => x.confidence === confidence);
  const total = cases.length;
  const limit = intParam(c.req.query("limit"), total, 1, 5000);
  return respond(c, { total, backfillSince: cache?.backfillSince ?? null, cases: cases.slice(0, limit) }, ["doj"], caveats);
});

// ---------------------------------------------------------------- /api/news

app.get("/api/news", (c) => {
  const hours = intParam(c.req.query("hours"), 24, 1, 24 * 7);
  const news = getNews(hours);
  const limit = intParam(c.req.query("limit"), news.items.length, 1, 5000);
  return respond(
    c,
    {
      hours,
      total: news.items.length,
      rawArticles: news.rawCount,
      // true when the last refresh only got some of the queries through (rate limit); see failedQueries
      partial: news.failedQueries.length > 0,
      failedQueries: news.failedQueries,
      articles: news.items.slice(0, limit),
    },
    ["gdelt"],
    ["newsNoise", "newsImages", "newsDedupe"],
  );
});

app.get("/api/news/timeline", (c) => {
  const t = getTimeline();
  return respond(
    c,
    { timelineStale: !t || Date.now() - Date.parse(t.fetchedAt) > 2 * REFRESH_MS.gdelt, query: t?.query ?? null, timespan: t?.timespan ?? "3m", unit: t?.unit ?? null, timelineFetchedAt: t?.fetchedAt ?? null, series: t?.series ?? [] },
    ["gdelt"],
    ["timelineUnit", "newsNoise"],
  );
});

// ---------------------------------------------------------------- /api/health, /api/countries

app.get("/api/health", (c) => {
  const health = readHealth();
  const per = Object.fromEntries(
    (["sdg", "doj", "gdelt"] as SourceId[]).map((id) => [
      id,
      { ...health[id], stale: isStale(id, health), refreshEveryMinutes: REFRESH_MS[id] / 60_000 },
    ]),
  );
  return respond(c, { ok: !Object.values(per).some((p) => p.stale), now: new Date().toISOString(), health: per }, ["sdg", "doj", "gdelt"], []);
});

/** The country mapping table (M49 → ISO3 → name) used across the API. */
app.get("/api/countries", (c) =>
  respond(c, { countries: COUNTRY_TABLE.map(([m49, iso3, name]) => ({ m49, iso3, name })) }, [], []),
);

app.get("/", (c) => c.html(readFileSync(new URL("./debug.html", import.meta.url), "utf8")));

app.notFound((c) => c.json({ error: "not found", sources: [], caveats: [] }, 404));
app.onError((err, c) => {
  console.error("[server]", err);
  return c.json({ error: "internal error", stale: true, sources: [], caveats: [] }, 500);
});

// Never let a background failure take the exhibition down.
process.on("unhandledRejection", (err) => console.error("[unhandledRejection]", err));
process.on("uncaughtException", (err) => console.error("[uncaughtException]", err));

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port }, () => {
  console.log(`Funnel data layer on http://localhost:${port}  (debug page at /, API under /api)`);
  if (process.env.NO_REFRESH === "1") console.log("[scheduler] NO_REFRESH=1 — serving from cache only");
  else startScheduler();
});
