// Stage 2 — "Detected". UN SDG API, indicator 16.2.2 (custodian UNODC).

import { readCache, writeCache } from "../cache.ts";
import { m49ToIso3 } from "../countries.ts";
import { fetchJson } from "../http.ts";

const BASE = "https://unstats.un.org/sdgapi/v1/sdg/Series/Data";
const PAGE_SIZE = 500;
const CONCURRENCY = 3;

export const SDG_SERIES = {
  VC_HTF_DETV: "total",
  VC_HTF_DETVFL: "forcedLabour",
  VC_HTF_DETVSX: "sexualExploitation",
  VC_HTF_DETVOG: "organRemoval",
  VC_HTF_DETVOP: "otherPurposes",
} as const;
export type SeriesCode = keyof typeof SDG_SERIES;
export const SERIES_CODES = Object.keys(SDG_SERIES) as SeriesCode[];

export interface SdgRecord {
  series: SeriesCode;
  iso3: string | null;
  m49: number;
  country: string;
  year: number;
  /** null when suppressed or not a number */
  value: number | null;
  /** true when the API returned "NaN" (suppressed for confidentiality) */
  suppressed: boolean;
  /** dimension codes, exactly as the API gives them (map by code, never by description) */
  sex: string;
  age: string;
  nature: string | null;
  reportingType: string | null;
  source: string | null;
  footnotes: string[];
}

export interface SdgCache {
  fetchedAt: string;
  seriesDescriptions: Record<string, string>;
  /** code -> API description, informational only. Some are wrong upstream (e.g. "29-49"). */
  ageLabels: Record<string, string>;
  sexLabels: Record<string, string>;
  unmappedAreas: { m49: number; name: string }[];
  records: SdgRecord[];
}

interface ApiCode { code: string; description: string }
interface ApiPage {
  totalElements: number;
  totalPages: number;
  dimensions?: { id: string; codes: ApiCode[] }[];
  data: {
    series: string;
    seriesDescription: string;
    geoAreaCode: string;
    geoAreaName: string;
    timePeriodStart: number;
    value: string | number | null;
    source: string | null;
    footnotes: string[] | null;
    attributes?: Record<string, string>;
    dimensions?: Record<string, string>;
  }[];
}

function pageUrl(series: string, page: number): string {
  return `${BASE}?seriesCode=${series}&pageSize=${PAGE_SIZE}&page=${page}`;
}

function parseValue(raw: string | number | null): { value: number | null; suppressed: boolean } {
  if (raw === null || raw === undefined) return { value: null, suppressed: false };
  const s = String(raw).trim();
  if (s === "NaN") return { value: null, suppressed: true };
  const n = Number(s);
  return Number.isFinite(n) ? { value: n, suppressed: false } : { value: null, suppressed: false };
}

async function fetchSeries(series: SeriesCode, cache: SdgCache, unmapped: Map<number, string>): Promise<number> {
  const opts = { label: `sdg ${series}`, timeoutMs: 90_000, retries: 4 };
  const first = await fetchJson<ApiPage>(pageUrl(series, 1), opts);
  const pages: ApiPage[] = [first];
  const remaining = Array.from({ length: Math.max(0, first.totalPages - 1) }, (_, i) => i + 2);
  while (remaining.length) {
    const batch = remaining.splice(0, CONCURRENCY);
    pages.push(...(await Promise.all(batch.map((p) => fetchJson<ApiPage>(pageUrl(series, p), opts)))));
  }

  for (const dim of first.dimensions ?? []) {
    const target = dim.id === "Age" ? cache.ageLabels : dim.id === "Sex" ? cache.sexLabels : null;
    if (target) for (const c of dim.codes) target[c.code] = c.description;
  }

  let count = 0;
  for (const page of pages) {
    for (const d of page.data) {
      const m49 = Number(d.geoAreaCode);
      const iso3 = m49ToIso3(m49);
      if (!iso3) unmapped.set(m49, d.geoAreaName);
      cache.seriesDescriptions[series] = d.seriesDescription;
      cache.records.push({
        series,
        iso3,
        m49,
        country: d.geoAreaName,
        year: Math.trunc(Number(d.timePeriodStart)),
        ...parseValue(d.value),
        sex: d.dimensions?.Sex ?? "BOTHSEX",
        age: d.dimensions?.Age ?? "ALLAGE",
        nature: d.attributes?.Nature ?? null,
        reportingType: d.dimensions?.["Reporting Type"] ?? null,
        source: d.source ?? null,
        footnotes: d.footnotes ?? [],
      });
      count++;
    }
  }
  if (count !== first.totalElements) {
    throw new Error(`sdg ${series}: expected ${first.totalElements} records, got ${count}`);
  }
  return count;
}

export async function refreshSdg(): Promise<string> {
  const cache: SdgCache = {
    fetchedAt: new Date().toISOString(),
    seriesDescriptions: {},
    ageLabels: {},
    sexLabels: {},
    unmappedAreas: [],
    records: [],
  };
  const unmapped = new Map<number, string>();
  const counts: string[] = [];
  for (const series of SERIES_CODES) {
    const n = await fetchSeries(series, cache, unmapped);
    counts.push(`${series}=${n}`);
    console.log(`[sdg] ${series}: ${n} records`);
  }
  cache.unmappedAreas = [...unmapped].map(([m49, name]) => ({ m49, name }));
  if (cache.unmappedAreas.length) {
    console.warn(`[sdg] areas without ISO3 mapping (regions/aggregates?):`, cache.unmappedAreas);
  }
  writeCache("sdg", cache);
  derivedFor = null;

  const d = getDetected()!;
  const summary =
    `${cache.records.length} records (${counts.join(", ")}); ` +
    `latest year ${d.latestYear.year} with ${d.latestYear.countries} countries reporting a total; ` +
    `headline year ${d.headlineYear.year} with ${d.headlineYear.countries} countries`;
  console.log(`[sdg] ${summary}`);
  return summary;
}

// ---------------------------------------------------------------- derived views

export interface YearPoint {
  year: number;
  value: number | null;
  suppressed: boolean;
  source: string | null;
}

export interface CountryDetected {
  iso3: string;
  m49: number;
  country: string;
  /** BOTHSEX + ALLAGE total detected victims, by year */
  timeSeries: YearPoint[];
  /** BOTHSEX + ALLAGE by form of exploitation, by year */
  byPurpose: Record<string, YearPoint[]>;
  latest: YearPoint | null;
}

export interface YearCoverage {
  year: number;
  /** countries with a non-null total that year */
  countries: number;
  /** sum of those totals — NOT a global total */
  total: number;
  suppressed: number;
}

export interface Detected {
  fetchedAt: string;
  latestYear: YearCoverage;
  /** most recent year whose coverage is at least 75% of the best-covered year */
  headlineYear: YearCoverage;
  byYear: YearCoverage[];
  countries: CountryDetected[];
  cache: SdgCache;
}

let derivedFor: string | null = null;
let derived: Detected | null = null;

const isTotal = (r: SdgRecord) => r.sex === "BOTHSEX" && r.age === "ALLAGE";

/** If a country-year has several BOTHSEX+ALLAGE rows (different sources), keep the largest non-null one. */
function pickPoints(records: SdgRecord[]): YearPoint[] {
  const byYear = new Map<number, YearPoint>();
  for (const r of records) {
    const cur = byYear.get(r.year);
    const point: YearPoint = { year: r.year, value: r.value, suppressed: r.suppressed, source: r.source };
    if (!cur || (point.value ?? -1) > (cur.value ?? -1)) byYear.set(r.year, point);
  }
  return [...byYear.values()].sort((a, b) => a.year - b.year);
}

export function getDetected(): Detected | null {
  const cache = readCacheMemo();
  if (!cache) return null;
  if (derived && derivedFor === cache.fetchedAt) return derived;

  const groups = new Map<string, SdgRecord[]>();
  for (const r of cache.records) {
    if (!r.iso3 || !isTotal(r)) continue;
    const key = `${r.iso3}|${r.series}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = []));
    g.push(r);
  }

  const countries = new Map<string, CountryDetected>();
  for (const [key, recs] of groups) {
    const [iso3, series] = key.split("|") as [string, SeriesCode];
    let c = countries.get(iso3);
    if (!c) {
      c = { iso3, m49: recs[0]!.m49, country: recs[0]!.country, timeSeries: [], byPurpose: {}, latest: null };
      countries.set(iso3, c);
    }
    const points = pickPoints(recs);
    if (series === "VC_HTF_DETV") {
      c.timeSeries = points;
      c.latest = [...points].reverse().find((p) => p.value !== null) ?? null;
    } else {
      c.byPurpose[SDG_SERIES[series]] = points;
    }
  }

  const years = new Map<number, YearCoverage>();
  for (const c of countries.values()) {
    for (const p of c.timeSeries) {
      let y = years.get(p.year);
      if (!y) years.set(p.year, (y = { year: p.year, countries: 0, total: 0, suppressed: 0 }));
      if (p.value !== null) {
        y.countries++;
        y.total += p.value;
      } else if (p.suppressed) y.suppressed++;
    }
  }
  const byYear = [...years.values()].sort((a, b) => a.year - b.year);
  const withData = byYear.filter((y) => y.countries > 0);
  const empty: YearCoverage = { year: 0, countries: 0, total: 0, suppressed: 0 };
  const latestYear = withData.at(-1) ?? empty;
  const peak = Math.max(0, ...withData.map((y) => y.countries));
  const headlineYear = [...withData].reverse().find((y) => y.countries >= 0.75 * peak) ?? latestYear;

  derived = {
    fetchedAt: cache.fetchedAt,
    latestYear,
    headlineYear,
    byYear,
    countries: [...countries.values()].sort((a, b) => a.country.localeCompare(b.country)),
    cache,
  };
  derivedFor = cache.fetchedAt;
  return derived;
}

let memo: SdgCache | null = null;
let memoAt = 0;
/** The SDG cache is large; re-read from disk at most once a minute. */
function readCacheMemo(): SdgCache | null {
  if (!memo || Date.now() - memoAt > 60_000 || derivedFor === null) {
    memo = readCache<SdgCache>("sdg");
    memoAt = Date.now();
  }
  return memo;
}

/** All records (with sex/age breakdowns) for one country. */
export function getCountryRecords(iso3: string): SdgRecord[] {
  return (readCacheMemo()?.records ?? []).filter((r) => r.iso3 === iso3);
}
