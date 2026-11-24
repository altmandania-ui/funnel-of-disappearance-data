// Stage 4 — "Reported". GDELT DOC 2.0 API: article lists + 3-month volume timeline.

import { readCache, writeCache } from "../cache.ts";
import { GDELT_MIN_SPACING_MS, NEWS_RETENTION_HOURS } from "../constants.ts";
import { nameToIso3 } from "../countries.ts";
import { fetchText, sleep } from "../http.ts";
import { GDELT_QUERIES, TITLE_TERMS } from "../terms.ts";

const BASE = "https://api.gdeltproject.org/api/v2/doc/doc";

export interface Article {
  url: string;
  title: string;
  /** ISO timestamp of when GDELT first saw the article */
  seenAt: string;
  /** Social-share image chosen by the outlet. URL only — never downloaded or rehosted. */
  image: string | null;
  domain: string;
  language: string | null;
  sourceCountry: string | null;
  iso3: string | null;
  /** "title": a trafficking term is in the title. "body-only": matched only in the article text. */
  relevance: "title" | "body-only";
  matchedQueries: string[];
}

export interface NewsItem extends Article {
  /** additional copies of the same story (same normalized title) on other URLs */
  reprints: number;
  reprintDomains: string[];
}

export interface NewsCache {
  fetchedAt: string;
  queries: string[];
  failedQueries: string[];
  articles: Article[];
}

export interface TimelineCache {
  fetchedAt: string;
  query: string;
  timespan: string;
  unit: string;
  series: { date: string; value: number }[];
}

// ---------------------------------------------------------------- rate-limited queue

let queue: Promise<unknown> = Promise.resolve();
let lastRequestAt = 0;

/** All GDELT requests go through here: strictly one at a time, at least GDELT_MIN_SPACING_MS apart. */
function gdeltRequest(params: Record<string, string>, label: string): Promise<unknown> {
  const run = async () => {
    const wait = lastRequestAt + GDELT_MIN_SPACING_MS - Date.now();
    if (wait > 0) await sleep(wait);
    try {
      // 429s are retried inside fetchText with 30s / 60s backoff, which also keeps the spacing.
      // Bounded on purpose: every request made while throttled seems to extend GDELT's penalty,
      // and a refresh must not stay open past the next 15-minute tick.
      const text = await fetchText(`${BASE}?${new URLSearchParams(params)}`, {
        label: `gdelt ${label}`,
        transport: "https",
        timeoutMs: 60_000,
        retries: 2,
        backoffMs: 30_000,
      });
      return parseLooseJson(text, label);
    } finally {
      lastRequestAt = Date.now();
    }
  };
  const result = queue.then(run, run);
  queue = result.catch(() => undefined);
  return result;
}

/** GDELT answers errors as plain text with HTTP 200, and occasionally emits unescaped control characters. */
function parseLooseJson(text: string, label: string): unknown {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) {
    throw new Error(`gdelt ${label}: non-JSON response: ${trimmed.slice(0, 120)}`);
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    // eslint-disable-next-line no-control-regex
    return JSON.parse(trimmed.replace(/[\u0000-\u001f]+/g, " "));
  }
}

// ---------------------------------------------------------------- normalisation

function parseSeenDate(s: string): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(s ?? "");
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z` : null;
}

const LOWER_TERMS = TITLE_TERMS.map((t) => t.toLowerCase());

export function titleRelevance(title: string): "title" | "body-only" {
  // GDELT tokenises some titles with spaces around punctuation ("Menschenhandel : Razzia"); collapse first.
  const t = title.toLowerCase().normalize("NFC").replace(/\s+/g, " ");
  return LOWER_TERMS.some((term) => t.includes(term)) ? "title" : "body-only";
}

/** Dedupe key: lowercase, drop trailing " - Section" / " | Outlet" suffixes, strip punctuation. */
export function normalizeTitle(title: string): string {
  let t = title.toLowerCase().normalize("NFKC").trim();
  for (let i = 0; i < 2; i++) {
    const m = /^(.{15,})\s+[-–—|·]\s+[^-–—|·]{1,40}$/u.exec(t);
    if (!m) break;
    t = m[1]!;
  }
  return t.replace(/[\p{P}\p{S}]/gu, " ").replace(/\s+/g, " ").trim();
}

interface ApiArticle {
  url: string;
  title: string;
  seendate: string;
  socialimage?: string;
  domain: string;
  language?: string;
  sourcecountry?: string;
}

const unmappedCountries = new Set<string>();

function toArticle(a: ApiArticle, query: string): Article | null {
  const seenAt = parseSeenDate(a.seendate);
  if (!a.url || !a.title || !seenAt) return null;
  const iso3 = nameToIso3(a.sourcecountry);
  if (a.sourcecountry && !iso3 && !unmappedCountries.has(a.sourcecountry)) {
    unmappedCountries.add(a.sourcecountry);
    console.warn(`[gdelt] no ISO3 mapping for source country "${a.sourcecountry}" — add it to src/countries.ts`);
  }
  const title = a.title.replace(/\s+/g, " ").trim();
  return {
    url: a.url,
    title,
    seenAt,
    image: a.socialimage && /^https?:\/\//.test(a.socialimage) ? a.socialimage : null,
    domain: a.domain,
    language: a.language || null,
    sourceCountry: a.sourcecountry || null,
    iso3,
    relevance: titleRelevance(title),
    matchedQueries: [query],
  };
}

// ---------------------------------------------------------------- refresh

export async function refreshGdelt(): Promise<string> {
  const prev = readCache<NewsCache>("news");
  const byUrl = new Map<string, Article>();
  const cutoff = Date.now() - NEWS_RETENTION_HOURS * 3_600_000;
  for (const a of prev?.articles ?? []) if (Date.parse(a.seenAt) >= cutoff) byUrl.set(a.url, a);

  const failed: string[] = [];
  const counts: string[] = [];
  let lastError: unknown = null;

  let throttled = false;
  for (const query of GDELT_QUERIES) {
    if (throttled) {
      failed.push(query); // a previous query exhausted its retries: stop, try again next tick
      continue;
    }
    try {
      const res = (await gdeltRequest(
        { query: `"${query}"`, mode: "artlist", format: "json", maxrecords: "250", timespan: "24h", sort: "datedesc" },
        `"${query}"`,
      )) as { articles?: ApiArticle[] };
      const articles = res.articles ?? [];
      let added = 0;
      for (const raw of articles) {
        const a = toArticle(raw, query);
        if (!a) continue;
        const existing = byUrl.get(a.url);
        if (existing) {
          if (!existing.matchedQueries.includes(query)) existing.matchedQueries.push(query);
        } else {
          byUrl.set(a.url, a);
          added++;
        }
      }
      counts.push(`"${query}"=${articles.length} (+${added} new)`);
      console.log(`[gdelt] "${query}": ${articles.length} articles, ${added} new`);
    } catch (err) {
      failed.push(query);
      lastError = err;
      throttled = true; // retries exhausted (429 or timeout): do not keep knocking
      console.warn(`[gdelt] "${query}" failed: ${(err as Error).message} — skipping remaining queries this run`);
    }
  }

  let timelineNote = "timeline ok";
  try {
    if (throttled) throw new Error("skipped after earlier failure");
    const query = `(${GDELT_QUERIES.map((q) => `"${q}"`).join(" OR ")})`;
    const res = (await gdeltRequest({ query, mode: "timelinevol", format: "json", timespan: "3m" }, "timeline")) as {
      timeline?: { series: string; data: { date: string; value: number }[] }[];
    };
    const data = res.timeline?.[0]?.data ?? [];
    if (!data.length) throw new Error("gdelt timeline: empty series");
    const timeline: TimelineCache = {
      fetchedAt: new Date().toISOString(),
      query,
      timespan: "3m",
      unit: "volume intensity (% of all articles monitored by GDELT)",
      series: data.map((d) => ({ date: parseSeenDate(d.date)?.slice(0, 10) ?? d.date, value: d.value })),
    };
    writeCache("timeline", timeline);
    console.log(`[gdelt] timeline: ${timeline.series.length} points`);
  } catch (err) {
    timelineNote = `timeline failed (${(err as Error).message})`;
    console.warn(`[gdelt] ${timelineNote}`);
  }

  // Nothing at all came back: keep the last good cache untouched and report the failure.
  if (failed.length === GDELT_QUERIES.length) {
    throw lastError instanceof Error ? lastError : new Error("gdelt: all queries failed");
  }

  const articles = [...byUrl.values()].sort((a, b) => (a.seenAt < b.seenAt ? 1 : a.seenAt > b.seenAt ? -1 : 0));
  writeCache("news", {
    fetchedAt: new Date().toISOString(),
    queries: [...GDELT_QUERIES],
    failedQueries: failed,
    articles,
  } satisfies NewsCache);

  const day = getNews(24);
  const summary =
    `${articles.length} articles retained (${day.rawCount} in last 24h → ${day.items.length} after dedupe, ` +
    `${day.items.filter((i) => i.image).length} with image); ${counts.join(", ")}` +
    (failed.length ? `; FAILED: ${failed.join(", ")}` : "") +
    `; ${timelineNote}`;
  console.log(`[gdelt] ${summary}`);
  return summary;
}

// ---------------------------------------------------------------- views

/** Articles seen in the last `hours`, deduped by normalized title (earliest kept), newest first. */
export function getNews(hours: number): { fetchedAt: string | null; rawCount: number; items: NewsItem[]; failedQueries: string[] } {
  const cache = readCache<NewsCache>("news");
  if (!cache) return { fetchedAt: null, rawCount: 0, items: [], failedQueries: [] };

  // Window is measured from the last successful fetch, so a stale cache still returns its last articles.
  const anchor = Math.min(Date.now(), Date.parse(cache.fetchedAt));
  const cutoff = anchor - hours * 3_600_000;
  const window = cache.articles.filter((a) => Date.parse(a.seenAt) >= cutoff);

  const groups = new Map<string, NewsItem>();
  for (const a of [...window].sort((x, y) => (x.seenAt < y.seenAt ? -1 : x.seenAt > y.seenAt ? 1 : 0))) {
    const key = normalizeTitle(a.title) || a.url;
    const first = groups.get(key);
    if (!first) {
      groups.set(key, { ...a, matchedQueries: [...a.matchedQueries], reprints: 0, reprintDomains: [] });
    } else {
      first.reprints++;
      if (a.domain !== first.domain && !first.reprintDomains.includes(a.domain)) first.reprintDomains.push(a.domain);
      for (const q of a.matchedQueries) if (!first.matchedQueries.includes(q)) first.matchedQueries.push(q);
      if (!first.image && a.image) first.image = a.image;
    }
  }
  const items = [...groups.values()].sort((a, b) => (a.seenAt < b.seenAt ? 1 : a.seenAt > b.seenAt ? -1 : 0));
  return { fetchedAt: cache.fetchedAt, rawCount: window.length, items, failedQueries: cache.failedQueries };
}

export function getTimeline(): TimelineCache | null {
  return readCache<TimelineCache>("timeline");
}
