# Funnel of Disappearance — data layer

Server + JSON API for an awareness piece about human trafficking and people held in
slavery-like conditions. The visualization is a funnel in which fewer and fewer people stay
visible at each stage. This repo is **only the data layer** and a plain debug page; the
visualization is designed elsewhere.

| Stage | What | Source | Refresh |
|---|---|---|---|
| 1. Estimated | People in modern slavery worldwide | ILO / Walk Free / IOM (hardcoded) | never (constants) |
| 2. Detected | Trafficking victims detected by authorities, per country | UN SDG API, indicator 16.2.2 (UNODC) | every 24 h |
| 3. Prosecuted / convicted | US federal cases | DOJ press releases API | every 6 h |
| 4. Reported | News coverage right now, with the images the press used | GDELT DOC 2.0 API | every 15 min |

## Run

Requires Node 20+.

```sh
npm install
npm run refresh   # fetch every source once, write ./cache/*.json, log counts, exit
npm run dev       # server + in-process scheduler on http://localhost:3000 (PORT=… to change)
```

- `npm run refresh sdg|doj|gdelt` refreshes just one source.
- `npm start` is `dev` without file watching (use this in the exhibition).
- `NO_REFRESH=1 npm start` serves from cache only (offline mode, no outbound requests).
- First full refresh takes about 3 minutes (SDG ≈ 90 s, DOJ ≈ 75 s, GDELT ≈ 45 s).

The browser only ever talks to this server. No source API is called from the frontend.

## API

Every response includes `sources: [{id, name, url, fetchedAt, stale}]`, `caveats: string[]`
and a top-level `stale` boolean.

| Route | Returns |
|---|---|
| `GET /api/funnel` | The four stages (`stages[]`, `totals`), latest-year info for Detected, caveats, `lastUpdated` per source |
| `GET /api/detected` | Per country: latest value, time series of totals, series by form of exploitation; `byYear` coverage |
| `GET /api/detected?country=ISO3` | All SDG records for one country, including sex / age breakdowns and source / footnotes |
| `GET /api/cases` | DOJ cases, newest first. `?type=sex\|labor` (`both` matches either), `?since=YYYY-MM-DD`, `?confidence=high\|medium\|low`, `?limit=N` |
| `GET /api/news` | GDELT articles, deduplicated, newest first. `?hours=24` (1–168), `?limit=N` |
| `GET /api/news/timeline` | 3-month daily volume curve |
| `GET /api/health` | Last success / last error / stale per source |
| `GET /api/countries` | The M49 → ISO3 → name mapping table |
| `GET /` | Debug page: funnel numbers, 20 latest cases, 30 latest news items with thumbnails, health. Reloads every 60 s |

Countries are ISO3 everywhere. The mapping table lives in `src/countries.ts` (SDG uses M49
numeric codes, GDELT uses country names; unknown names are logged and returned with `iso3: null`).

### Failure behaviour

- Each source is cached to `cache/<name>.json` (atomic write). If a refresh fails, the last good
  cache keeps being served and the source is marked `stale: true`; `/api/health` shows the error.
- A source is `stale` when its latest attempt failed, it has never succeeded, or its last success
  is older than twice its refresh interval.
- With no cache at all, routes still return valid JSON (empty lists / `null` values, `stale: true`).
  The Estimated stage is a constant and is always present. Run `npm run refresh` once before the
  exhibition so there is a cache to fall back on.
- GDELT: requests are queued one at a time, ≥ 15 s apart. HTTP 429 is retried with backoff
  (30 s, 60 s); if it is still throttled the run stops early and tries again on the next tick.
  Nothing crashes.

## Sources and known limitations

### 1. Constants — `src/constants.ts`

- 50,000,000 people in modern slavery (2021): 27,600,000 in forced labour, 22,000,000 in forced
  marriage — <https://www.ilo.org/resource/news/50-million-people-worldwide-modern-slavery-0>
- US$236 billion annual profit from forced labour —
  <https://www.ilo.org/publications/major-publications/profits-and-poverty-economics-forced-labour>
- **Limitation:** the 50M includes forced marriage; Detected counts only detected trafficking
  victims. This is returned as `caveat` in `/api/funnel`. The estimate is from 2021 and is not updated.

### 2. UN SDG API — `src/sources/sdg.ts`

`https://unstats.un.org/sdgapi/v1/sdg/Series/Data`, series `VC_HTF_DETV` (total), `VC_HTF_DETVFL`
(forced labour), `VC_HTF_DETVSX` (sexual exploitation), `VC_HTF_DETVOG` (organ removal),
`VC_HTF_DETVOP` (other). All pages are fetched (≈ 40,700 records, 185 countries).

- `value` is parsed to a number; `"NaN"` (suppressed for confidentiality) becomes
  `value: null, suppressed: true`. Years are integers.
- Totals use `sex: BOTHSEX` + `age: ALLAGE`; all breakdown rows are kept. Age and sex are stored
  as **codes** — the API's own descriptions are returned in `ageLabels` for information only and at
  least one is wrong upstream (`29-49`).
- `source` and `footnotes` are kept on every record.
- **The latest year is very incomplete.** At the time of writing the latest year is 2025 with only
  10 countries reporting. `/api/funnel` therefore uses a *headline year*: the most recent year whose
  coverage is at least 75 % of the best-covered year (currently 2023, 110 countries). Both are
  returned (`latestYear`, `headlineYear`, and `byYear` for every year) so the designer can choose.
- Yearly totals are sums over the countries that reported that year. They are **not** global
  totals, and never the true number of victims.
- Data derived from different source types should not be compared directly (API footnote).

### 3. DOJ press releases API — `src/sources/doj.ts`

`https://www.justice.gov/api/v1/press_releases.json`, title phrases `sex trafficking`,
`human trafficking`, `forced labor`, `labor trafficking`, `involuntary servitude`, `peonage`,
merged by `uuid`. Initial backfill 3 years (rolling); later refreshes re-read the last 30 days.

- A release is kept only if its **body** cites 18 U.S.C. §§ 1581, 1584, 1589, 1590 or 1591, or
  contains "human trafficking", "sex trafficking", "forced labor" or "labor trafficking".
- `confidence`: `high` = statute cited or the body states a trafficking charge / plea / conviction /
  sentence; `medium` = trafficking wording but no explicit charge found; `low` = trafficking is in
  the title but the charges found are something else (CSAM, travel / enticement, drugs, firearms).
  Low-confidence releases are kept, not dropped; `confidenceReasons` says why.
- `stage` (`charged | pleaded | convicted | sentenced`) comes from the title verbs. `null` means the
  release is not a case update (awareness month, appointments, press conferences).
  `/api/funnel` counts only releases with a stage and confidence ≠ low.
- **Everything except title, date, URL and components is regex / heuristic extraction and can be
  wrong or `null`**: defendants, sentence, victims mentioned, minors, type, district.
  From a sample of ~270 releases: defendants found in about 70 %, sentence length in about 97 % of
  sentenced releases.
- Defendants: only people the release describes as charged / pleaded / convicted / sentenced, each
  with their own stage. A person is never given a later stage than the release headline (later-stage
  wording in a body is often a prior, unrelated conviction), so co-defendants can be *under*-stated.
  Names are withheld (`defendantsWithheld: true`) for low-confidence releases and non-case releases.
- `minorVictims: true` means minors are mentioned in the non-boilerplate text, not that every victim
  was a minor. `victimsMentioned` is a count as worded in the release ("two adult women").
- **Victim names are never extracted. Release bodies and teasers are not stored at all.** The
  DOJ-written title is stored verbatim; in rare cases a title could itself contain a victim's name.
- The `image` field is ignored (almost always empty). Nothing is scraped from bodies.
- This is US federal press releases only — not all prosecutions, and not global. One release can
  cover several defendants, and one case can produce several releases (charged, then sentenced).

### 4. GDELT DOC 2.0 API — `src/sources/gdelt.ts`

`https://api.gdeltproject.org/api/v2/doc/doc`, separate queries for `"human trafficking"`,
`"forced labor"`, `"scam compound"`, `"debt bondage"`, `"trafficking victims"`
(`mode=artlist`, `maxrecords=250`, `timespan=24h`, `sort=datedesc`), plus one
`mode=timelinevol&timespan=3m` request for all phrases OR-ed together.

- Articles are merged by URL and kept for 7 days, so `?hours=` up to 168 works once the server has
  been running that long. Each query returns at most 250 articles per 15-minute fetch.
- **Dedupe:** by normalized title (lowercase, punctuation stripped, trailing " - Section" / " | Outlet"
  removed). The earliest copy is kept; `reprints` counts the others, `reprintDomains` lists them.
- **Relevance:** `"title"` if a term from `src/terms.ts` (English + translations) is in the title,
  else `"body-only"`. Body-only articles are kept; many mention the topic only in passing. The term
  list is not exhaustive for every language.
- **Images:** `image` is the outlet's social-share image URL, stored as a URL only — never
  downloaded or rehosted. They are not filtered: mostly logos, officials, stock photos and police
  raids. Hotlinked images can disappear or be blocked by the outlet.
- Timeline values are "volume intensity" (% of all articles GDELT monitored), not article counts.
- GDELT rate-limits aggressively (HTTP 429 when requests are < 5 s apart, and for a while after).
  If the exhibition network shares an IP with other GDELT users, expect occasional stale periods.

## Ethics rules built into the code

- Victim names are never stored or displayed; release bodies are discarded after extraction.
- A named person appears only if a DOJ release states they were charged / pleaded / convicted /
  sentenced, with that exact stage. Charged is not convicted.
- No missing-persons data from any source.
- Caveats travel with the numbers in every response; Detected is never presented as the true number.

## Layout

```
src/constants.ts     stage-1 figures, caveat texts, refresh intervals
src/terms.ts         GDELT queries, DOJ title phrases, translated title terms
src/countries.ts     M49 → ISO3 → name table + name aliases
src/cache.ts         JSON file cache + per-source health
src/http.ts          fetch with timeout / retry / backoff
src/sources/*.ts     one fetcher + normalizer per source
src/runner.ts        refresh with health bookkeeping; in-process scheduler
src/refresh.ts       `npm run refresh`
src/server.ts        Hono server, /api/* routes
src/debug.html       debug page served at /
cache/               generated, git-ignored
```
