// Stage 1 — "Estimated". Hardcoded global estimates, each with its source URL.

export const ESTIMATES = {
  modernSlavery: {
    value: 50_000_000,
    year: 2021,
    label: "People in modern slavery worldwide",
    breakdown: {
      forcedLabour: 27_600_000,
      forcedMarriage: 22_000_000,
    },
    source: {
      name: "ILO / Walk Free / IOM — Global Estimates of Modern Slavery (2022)",
      url: "https://www.ilo.org/resource/news/50-million-people-worldwide-modern-slavery-0",
    },
  },
  forcedLabourProfit: {
    value: 236_000_000_000,
    unit: "USD per year",
    label: "Annual illegal profit from forced labour",
    source: {
      name: "ILO — Profits and Poverty: The Economics of Forced Labour (2024)",
      url: "https://www.ilo.org/publications/major-publications/profits-and-poverty-economics-forced-labour",
    },
  },
} as const;

export const CAVEATS = {
  estimatedVsDetected:
    "The 50 million estimate includes forced marriage (22M) as well as forced labour (27.6M). The Detected stage counts only trafficking victims detected by authorities, so the two are not the same population.",
  detectedNotTrue:
    "Detected victims are people identified by national authorities and reported to UNODC. This is not the true number of victims; it mostly reflects each country's capacity and willingness to detect and report.",
  detectedCoverage:
    "Country coverage differs by year, and the most recent year is usually incomplete. Yearly totals are sums over the countries that reported that year, not global totals.",
  detectedSources:
    "Data in reference to one country but derived from different types of sources should not be compared between them (UN SDG API footnote).",
  detectedSuppressed:
    "Some values are suppressed for confidentiality (value null, suppressed: true). Suppressed values are excluded from sums.",
  casesScope:
    "Cases are US federal press releases from the Department of Justice only. They are not a count of all prosecutions, not global, and one release may cover several defendants or several releases one case.",
  casesStage:
    "Stage is exact and taken from the release: charged is not convicted. A charge is an allegation; defendants are presumed innocent unless and until proven guilty.",
  casesExtraction:
    "Fields other than title, date and URL are extracted by regex heuristics and can be wrong or null. Releases marked confidence: \"low\" may not be trafficking cases at all (e.g. the charges are actually CSAM or travel offences); defendant names are withheld for those.",
  casesNoVictims: "Victim names are never extracted or stored. Release bodies are not stored.",
  newsNoise:
    "News items are whatever GDELT matched for the query phrases. relevance: \"body-only\" means no trafficking term was found in the title, so the article may mention the topic only in passing.",
  newsImages:
    "Images are the social-share images chosen by each outlet (URL only, not rehosted). They are mostly logos, officials, stock photos and police raids — rarely the people affected.",
  newsDedupe:
    "Articles are deduplicated by normalized title; reprints counts the additional copies of the same story across outlets.",
  timelineUnit:
    "Timeline values are GDELT 'volume intensity': matching articles as a percentage of all articles GDELT monitored in that period, not an article count.",
  funnelUnits:
    "The four stages are not the same unit or the same population (people worldwide, detected victims in reporting countries, US federal press releases, news articles). The funnel shows shrinking visibility, not a conversion rate.",
} as const;

export const SOURCE_INFO = {
  ilo: { name: "ILO / Walk Free / IOM (constants)", url: ESTIMATES.modernSlavery.source.url },
  sdg: {
    name: "UN SDG API — indicator 16.2.2 (UNODC)",
    url: "https://unstats.un.org/sdgapi/v1/sdg/Series/Data",
  },
  doj: {
    name: "US Department of Justice — press releases API",
    url: "https://www.justice.gov/api/v1/press_releases.json",
  },
  gdelt: { name: "GDELT DOC 2.0 API", url: "https://api.gdeltproject.org/api/v2/doc/doc" },
} as const;

export type SourceId = "sdg" | "doj" | "gdelt";

const MIN = 60_000;
export const REFRESH_MS: Record<SourceId, number> = {
  sdg: 24 * 60 * MIN,
  doj: 6 * 60 * MIN,
  gdelt: 15 * MIN,
};

export const DOJ_BACKFILL_YEARS = 3;
export const GDELT_MIN_SPACING_MS = 6_500;
export const NEWS_RETENTION_HOURS = 24 * 7;
