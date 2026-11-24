// Stage 3 — "Prosecuted / convicted". US DOJ press releases API.
//
// Ethics: release bodies and teasers are read for extraction and then discarded.
// Nothing here extracts victim names, and no free text from the body is stored.

import { readCache, writeCache } from "../cache.ts";
import { DOJ_BACKFILL_YEARS } from "../constants.ts";
import { fetchJson, sleep } from "../http.ts";
import { DOJ_TITLE_QUERIES } from "../terms.ts";

const BASE = "https://www.justice.gov/api/v1/press_releases.json";
const PAGE_SIZE = 50;
const REQUEST_GAP_MS = 400;
/** On incremental refreshes, re-read this far back to pick up edited releases. */
const OVERLAP_DAYS = 30;

export type Stage = "charged" | "pleaded" | "convicted" | "sentenced";
export type CaseType = "sex" | "labor" | "both";
export type Confidence = "high" | "medium" | "low";

export interface Sentence {
  text: string;
  months: number | null;
  life: boolean;
}

export interface Defendant {
  name: string;
  /** Stage stated for this person in the release; null if the release does not say. */
  stage: Stage | null;
  sentence: Sentence | null;
}

export interface DojCase {
  uuid: string;
  url: string;
  title: string;
  /** YYYY-MM-DD */
  date: string;
  number: string | null;
  /** Headline stage of the release, from title verbs. null = not a case update (policy, awareness, etc.). */
  stage: Stage | null;
  type: CaseType | null;
  confidence: Confidence;
  confidenceReasons: string[];
  statutes: string[];
  /** Only people the release itself describes as charged / pleaded / convicted / sentenced. Empty when confidence is low. */
  defendants: Defendant[];
  defendantsWithheld: boolean;
  sentence: Sentence | null;
  victimsMentioned: { count: number; text: string } | null;
  /** true = minors mentioned, false = only adults mentioned, null = unknown */
  minorVictims: boolean | null;
  district: string | null;
  components: string[];
  topics: string[];
  matchedQueries: string[];
}

export interface DojCache {
  fetchedAt: string;
  backfillSince: string;
  dropped: number;
  cases: DojCase[];
}

interface ApiRelease {
  uuid: string;
  url: string;
  title: string;
  body: string | null;
  teaser: string | null;
  date: string;
  number: string | null;
  component: { name: string }[] | "" | null;
  topic: { name: string }[] | "" | null;
}
interface ApiPage {
  metadata: { resultset: { count: string | number } };
  results: ApiRelease[];
}

// ---------------------------------------------------------------- text helpers

const ENTITIES: Record<string, string> = {
  amp: "&", nbsp: " ", quot: '"', apos: "'", lt: "<", gt: ">", rsquo: "’", lsquo: "‘",
  ldquo: "“", rdquo: "”", ndash: "–", mdash: "—", sect: "§",
};

export function htmlToText(html: string): string {
  return html
    .replace(/<\/(p|div|li|h\d|br)\s*>|<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m)
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .trim();
}

/** Remove periods that do not end a sentence (U.S., initials, Mr., Jr., St., No.) so sentence regexes can use [^.]. */
export function normalizeText(text: string): string {
  return text
    .replace(/\bU\.\s?S\.(?:C\.)?/g, (m) => m.replace(/[.\s]/g, ""))
    .replace(/\ba\.k\.a\.?/gi, "aka")
    .replace(/\b(Mr|Mrs|Ms|Dr|Jr|Sr|St|No|Inc|Co|Jan|Feb|Aug|Sept|Sep|Oct|Nov|Dec|Ore|Calif|Fla|Tenn|Wash|Mass|Conn|Ill|Mich|Minn|Miss|Okla|Wis|Ala|Ariz|Ark|Colo|Del|Ga|Ind|Kan|Ky|La|Md|Mo|Mont|Neb|Nev|Pa|Tex|Va|Vt|Wyo)\./g, "$1")
    .replace(/\b([A-Z])\.(?=\s|,|[A-Z])/g, "$1")
    .replace(/\s+([,;:])/g, "$1");
}

function splitSentences(text: string): string[] {
  return text
    .split("\n")
    .flatMap((para) => para.split(/(?<=[.!?]["”’)]?)\s+(?=[A-Z“"(])/))
    .map((s) => s.trim())
    .filter(Boolean);
}

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60,
  seventy: 70, eighty: 80, ninety: 90,
};
const NUM = String.raw`(?:\d[\d,]*(?:\.\d+)?|(?:twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:[- ](?:one|two|three|four|five|six|seven|eight|nine))?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen)`;

function parseNumber(s: string): number | null {
  const t = s.toLowerCase().replace(/,/g, "");
  if (/^\d/.test(t)) return Number(t);
  let total = 0;
  for (const part of t.split(/[- ]/)) {
    const n = NUMBER_WORDS[part];
    if (n === undefined) return null;
    total += n;
  }
  return total;
}

// ---------------------------------------------------------------- classification

const STATUTES: Record<string, string> = {
  "1581": "18 U.S.C. § 1581 (peonage)",
  "1584": "18 U.S.C. § 1584 (involuntary servitude)",
  "1589": "18 U.S.C. § 1589 (forced labor)",
  "1590": "18 U.S.C. § 1590 (trafficking for peonage, slavery, involuntary servitude or forced labor)",
  "1591": "18 U.S.C. § 1591 (sex trafficking)",
};
const STATUTE_RE = /(?:U\.?\s?S\.?\s?C\.?|United States Code|Sections?|§+)[^.;\n]{0,40}?\b(1581|1584|1589|1590|1591)\b/gi;
const KEEP_PHRASES = /human trafficking|sex trafficking|forced labou?r|labor trafficking/i;

const SEX_RE = /sex(?:ual)? trafficking|commercial sex|trafficking (?:of )?(?:a |an )?(?:minor|child|children)|\b1591\b/i;
const LABOR_RE = /forced labou?r|labor trafficking|involuntary servitude|\bpeonage\b|domestic servitude|\b15(?:81|84|89)\b/i;

const CHARGE_CONTEXT = new RegExp(
  String.raw`(?:charg(?:ed|es|ing)|indict(?:ed|ment)|convict(?:ed|ion)|guilty|sentenced|counts? of|conspir(?:acy|ing|ed) to(?: commit| engage in)?|arrested)` +
    String.raw`[^.\n]{0,220}?(?:sex trafficking|human trafficking|labor trafficking|forced labou?r|involuntary servitude|peonage|trafficking (?:of|by|a|an|minors|children|persons|victims)\b)`,
  "i",
);
/** Charges given as a list: "• Sex trafficking of a minor", "Counts 4 & 5: Sex trafficking by force ..." */
const CHARGE_LIST = /^\s*(?:[•·*–-]\s*|Counts? [\d&,\s]+(?:(?:and|through) \d+)?\s*[:–-]\s*)[^\n]{0,80}?(?:sex trafficking|human trafficking|labor trafficking|forced labou?r|involuntary servitude|peonage)/im;
const COMPETING: [RegExp, string][] = [
  [/child pornography|child sexual abuse material|\bCSAM\b|sexual exploitation of (?:a )?(?:child|minor|children)|production of (?:child|sexually explicit)/i, "mentions CSAM / child-exploitation charges"],
  [/travel(?:ing|ed|led|ling)?[^.\n]{0,60}illicit sexual conduct|interstate travel[^.\n]{0,40}(?:sex|prostitution)|enticement of a minor|coercion and enticement|transport(?:ation|ing)[^.\n]{0,40}minor/i, "mentions travel / enticement / transportation charges"],
  [/\b(?:fentanyl|methamphetamine|cocaine|heroin|drug trafficking|narcotics trafficking|firearms? trafficking|controlled substances?)\b/i, "mentions drug or firearms offences"],
];

const NEGATED_PRIOR = /\b(?:previously[- ]|formerly[- ])?convicted (?:felon|sex offender|sex trafficker|trafficker|murderer|drug dealer)s?\b/gi;
/** Wording about what might happen, not what did: "faces up to life", "if convicted", "will be sentenced". */
const HYPOTHETICAL = /\bif convicted\b|\bfac(?:es?|ing)\b|\bmaximum\b|\bminimum\b|\bpenalt(?:y|ies)\b|\bpunishable\b|\b(?:will|to|yet to|scheduled to|set to) be sentenced\b|\bsentencing (?:is|has been|was|will be|hearing|date)\b|\bawait(?:s|ing)?\b|\bpresumed innocent\b/i;
const SENTENCED_RE = /\bsentenc(?:ed|es)\b|\b(?:gets|receives?|received|handed|given|ordered to serve)\b[^.\n]{0,40}\b(?:years?|months?|life)\b|\b(?:years?|months?|life) in (?:federal )?prison\b|\b(?:life|prison|year|month)[- ]sentences?\b|\bsentences? imposed\b|\b(?:going|headed|sent|heads|goes) to (?:federal )?prison\b/i;
const CONVICTED_RE = /\bconvict(?:ed|s|ion)\b|\b(?:found|finds|verdict of)\b[^.\n]{0,60}\bguilty\b|\bguilty verdict\b/i;
const PLEADED_RE = /\bplead(?:s|ed)?\b[^.\n]{0,20}\bguilty\b|\bpled guilty\b|\bguilty pleas?\b|\badmit(?:s|ted)\b|\bpleads?\b/i;
const CHARGED_RE = /\bcharg(?:ed|es|ing)\b|\bindict(?:ed|ment|s)\b|\barrest(?:ed|s)?\b|\baccused\b|\bcomplaint\b|\barraigned\b|\bextradited\b|\bfac(?:es?|ing)\b/i;

/**
 * Highest procedural stage a title or sentence states as having happened.
 * Hypothetical wording ("faces life in prison", "if convicted") never counts as sentenced or convicted.
 */
export function detectStage(text: string, isTitle = false): Stage | null {
  const hypothetical = isTitle ? /\bfac(?:es?|ing)\b/i.test(text) : HYPOTHETICAL.test(text);
  const t = text.replace(NEGATED_PRIOR, " ").replace(/\bif convicted\b/gi, " ");
  if (!hypothetical && SENTENCED_RE.test(t)) return "sentenced";
  if (CONVICTED_RE.test(t)) return "convicted";
  if (PLEADED_RE.test(t)) return "pleaded";
  if (CHARGED_RE.test(t)) return "charged";
  return null;
}

const SENT_VERB = String.raw`(?:sentenc\w+[^.\n]{0,160}?\b(?:to|of)|\bgets|\breceives?|\breceived|\bordered to serve|\b(?:going|headed|sent) to (?:federal )?prison for)`;
const SENT_TERM_RE = new RegExp(
  String.raw`${SENT_VERB}\s+(?:a (?:total|term)(?: of imprisonment)? of\s+|more than\s+|over\s+|nearly\s+|almost\s+)?((${NUM})(?:\s+and\s+a\s+half)?[- ](years?|months?)(?:,?\s+(?:and\s+)?(${NUM})[- ](months?))?)`,
  "i",
);
const SENT_LIFE_RE = new RegExp(
  String.raw`${SENT_VERB}\s+(?:\w+\s+)?(?:consecutive\s+|concurrent\s+)?life\b|\blife sentences? imposed\b`,
  "i",
);

/** Parse an imposed sentence from the first non-hypothetical sentence that states one. */
function parseSentence(sentences: string[]): Sentence | null {
  for (const s of sentences) {
    if (HYPOTHETICAL.test(s)) continue;
    const term = SENT_TERM_RE.exec(s);
    const life = SENT_LIFE_RE.exec(s);
    if (term && (!life || term.index <= life.index)) {
      const n = parseNumber(term[2]!);
      const years = term[3]!.toLowerCase().startsWith("year");
      let months = n === null ? null : years ? n * 12 : n;
      if (months !== null && /and\s+a\s+half/i.test(term[1]!)) months += years ? 6 : 0.5;
      if (months !== null && term[4]) months += parseNumber(term[4]) ?? 0;
      return { text: term[1]!.replace(/\s+/g, " "), months: months === null ? null : Math.round(months), life: false };
    }
    if (life) return { text: "life", months: null, life: true };
  }
  return null;
}

/** Title wording wins, unless the body gives the same sentence more precisely ("More Than 17 Years" vs "17 years and 6 months"). */
function headlineSentence(title: string, sentences: string[]): Sentence | null {
  const fromTitle = parseSentence([title]);
  const fromBody = parseSentence(sentences);
  if (!fromTitle) return fromBody;
  if (fromBody && fromTitle.months !== null && fromBody.months !== null && Math.abs(fromBody.months - fromTitle.months) < 12) return fromBody;
  return fromTitle;
}

// "Firstname M. Lastname, 38," / "Firstname Lastname, age 38," / "Firstname Lastname (38)"
const NAME_PART = String.raw`[A-Z][\p{L}’'-]+`;
const NAME_RE = new RegExp(
  String.raw`((?:${NAME_PART})(?:\s+(?:[A-Z]\s+|(?:de|del|de la|van|von|bin|al|el|la|le|da|dos|di)\s+)?(?:${NAME_PART})){1,3}(?:,? (?:Jr|Sr|II|III|IV))?)` +
    String.raw`(?:\s*\([“"][^)]{1,40}\))?` +
    String.raw`(?:,?\s+(?:aka|a\/k\/a|also known as)\s+[^.;\n]{1,80}?[,”"]+)?` +
    String.raw`(?:,\s*(?:aged?\s+)?\d{2}\b|\s+aged?\s+\d{2}\b|\s+\(\d{2}[,)])`,
  "gu",
);
const VICTIM_CONTEXT = /(?:victims?|survivors?|deceased|decedent|death of|deaths of|murder(?:ed|ing)? of|killing of|killed|memory of|honor of|named (?:for|after)|missing|daughter|son|wife|husband|girlfriend|boyfriend|mother|father|sister|brother|niece|nephew|cousin|child|minor|juvenile|officer|agent|detective|deputy|trooper)[\s,:–—-]*(?:identified as\s+|named\s+)?$/i;
const NOT_A_NAME = /^(?:The|This|That|In|On|According|Assistant|Special|Acting|United|District|Judge|Chief|Senior|Attorney|Homeland|Federal|Department|Operation|Count|Counts|Title|January|February|March|April|May|June|July|August|September|October|November|December)\b/;

function extractDefendants(sentences: string[], releaseStage: Stage): Defendant[] {
  const found = new Map<string, Defendant>();
  for (const s of sentences) {
    for (const m of s.matchAll(NAME_RE)) {
      let name = m[1]!.replace(/\s+/g, " ").trim();
      if (name === name.toUpperCase()) name = name.toLowerCase().replace(/(^|[\s'’-])\p{L}/gu, (c) => c.toUpperCase());
      if (NOT_A_NAME.test(name)) continue;
      if (VICTIM_CONTEXT.test(s.slice(0, m.index))) continue;
      if (!found.has(name)) found.set(name, { name, stage: null, sentence: null });
    }
  }
  const rank: Record<Stage, number> = { charged: 1, pleaded: 2, convicted: 3, sentenced: 4 };
  for (const d of found.values()) {
    const surname = d.name.replace(/,? (?:Jr|Sr|II|III|IV)\.?$/, "").split(" ").at(-1)!;
    const re = new RegExp(String.raw`(?<![\p{L}])${surname.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\p{L}])`, "iu");
    for (const s of sentences) {
      if (!re.test(s)) continue;
      const stage = detectStage(s);
      if (stage && (!d.stage || rank[stage] > rank[d.stage])) d.stage = stage;
      if (stage === "sentenced" && !d.sentence) d.sentence = parseSentence([s]);
    }
  }
  // Only people the release states were charged / pleaded / convicted / sentenced.
  // Never report a person at a later stage than the release headline: later-stage wording in the
  // body is often about a prior, unrelated conviction ("previously convicted of ...").
  const out: Defendant[] = [];
  for (const d of found.values()) {
    if (d.stage === null) continue;
    if (rank[d.stage] > rank[releaseStage]) {
      d.stage = releaseStage;
      d.sentence = null;
    }
    if (d.stage !== "sentenced") d.sentence = null;
    out.push(d);
  }
  return out;
}

const VICTIM_COUNT_RE = new RegExp(
  String.raw`\b(${NUM})\s+((?:(?:other|additional|more|adult|minor|juvenile|underage|young|teenage|female|male|foreign|immigrant|migrant|undocumented|identified|known|potential|alleged|child|trafficking|sex[- ]trafficking|labor|human[- ]trafficking)\s+){0,3}(?:victims?|women|girls|minors|children|juveniles|teenagers|teens|workers|laborers|survivors))\b`,
  "gi",
);

/** Number of victims as worded in the title, else the largest such mention in the body. */
function extractVictims(title: string, body: string): { count: number; text: string } | null {
  for (const text of [title, body]) {
    let best: { count: number; text: string } | null = null;
    for (const m of text.matchAll(VICTIM_COUNT_RE)) {
      const count = parseNumber(m[1]!);
      if (count === null || count < 1 || count > 5000 || !Number.isInteger(count)) continue;
      if (!best || count > best.count) best = { count, text: `${m[1]} ${m[2]}`.replace(/\s+/g, " ") };
    }
    if (best) return best;
  }
  return null;
}

const BOILERPLATE = /Project Safe Childhood|To report an incident|child pornography|child sexual abuse material|Hotline|NCMEC|National Center for Missing|Human Trafficking Prevention Month|Task Force/i;
const MINOR_RE = /\bminors?\b|\bunderage\b|\bjuveniles?\b|\b(?:[1-9]|1[0-7])[- ]years?[- ]old\b|\bchild (?:sex trafficking|victims?)\b|\btrafficking (?:of )?(?:a |an )?child(?:ren)?\b|\bunder (?:the age of )?18\b|\bteenage(?:d|rs?)?\b/i;

function minorsMentioned(title: string, sentences: string[]): boolean | null {
  const relevant = [title, ...sentences.filter((s) => !BOILERPLATE.test(s))].join("\n");
  if (MINOR_RE.test(relevant)) return true;
  if (/\badult (?:victims?|women|men|woman|man|females?|males?)\b/i.test(relevant)) return false;
  return null;
}

/** Turn one API release into a stored case, or null if it should be dropped. */
export function toCase(r: ApiRelease, matchedQueries: string[]): DojCase | null {
  const title = htmlToText(r.title ?? "").replace(/\s+/g, " ");
  const body = normalizeText(htmlToText(r.body ?? ""));
  const all = `${title}\n${body}`;

  const statutes = [...new Set([...body.matchAll(STATUTE_RE)].map((m) => m[1]!))].sort();
  const phraseInBody = KEEP_PHRASES.test(body);
  if (!statutes.length && !phraseInBody) return null; // only match was the title; body is about something else

  const sex = SEX_RE.test(all);
  const labor = LABOR_RE.test(all);
  const type: CaseType | null = sex && labor ? "both" : sex ? "sex" : labor ? "labor" : null;

  const stage = detectStage(title, true);
  const chargeContext = CHARGE_CONTEXT.test(body) || CHARGE_LIST.test(body);
  const competing = COMPETING.filter(([re]) => re.test(body)).map(([, why]) => why);

  const reasons: string[] = [];
  let confidence: Confidence;
  if (statutes.length) {
    confidence = "high";
    reasons.push(`cites ${statutes.map((s) => `§ ${s}`).join(", ")}`);
  } else if (chargeContext) {
    confidence = "high";
    reasons.push("body states a trafficking / forced-labor charge, plea, conviction or sentence");
  } else if (competing.length) {
    confidence = "low";
    reasons.push("trafficking term appears, but no trafficking charge was found in the body", ...competing);
  } else {
    confidence = "medium";
    reasons.push("trafficking term in body, but no statute or explicit charge wording found");
  }
  if (!stage) {
    reasons.push("no charged / pleaded / convicted / sentenced verb in title — may not be a case update");
    if (confidence === "high" && !statutes.length) confidence = "medium";
  }

  const sentences = splitSentences(body);
  const defendantsWithheld = confidence === "low" || stage === null;
  const defendants = defendantsWithheld || !stage ? [] : extractDefendants(sentences, stage);

  const components = Array.isArray(r.component) ? r.component.map((c) => c.name) : [];
  const usao = components.find((c) => c.startsWith("USAO - "));
  const ms = Number(r.date) * 1000;

  return {
    uuid: r.uuid,
    url: r.url,
    title,
    date: new Date(ms).toISOString().slice(0, 10),
    number: r.number || null,
    stage,
    type,
    confidence,
    confidenceReasons: reasons,
    statutes: statutes.map((s) => STATUTES[s]!),
    defendants,
    defendantsWithheld,
    sentence: stage === "sentenced" ? headlineSentence(title, sentences) : null,
    victimsMentioned: extractVictims(title, body),
    minorVictims: minorsMentioned(title, sentences),
    district: usao ? usao.slice("USAO - ".length) : null,
    components,
    topics: Array.isArray(r.topic) ? r.topic.map((t) => t.name) : [],
    matchedQueries,
  };
}

// ---------------------------------------------------------------- fetch

function pageUrl(query: string, page: number): string {
  const p = new URLSearchParams({
    "parameters[title]": query,
    pagesize: String(PAGE_SIZE),
    page: String(page),
    sort: "date",
    direction: "DESC",
  });
  return `${BASE}?${p}`;
}

export async function refreshDoj(): Promise<string> {
  const prev = readCache<DojCache>("doj");
  const backfillSince = new Date();
  backfillSince.setUTCFullYear(backfillSince.getUTCFullYear() - DOJ_BACKFILL_YEARS);
  const backfillIso = backfillSince.toISOString().slice(0, 10);

  // First run (or a cache that never completed its backfill): go back 3 years. Otherwise only re-read the recent overlap.
  // (The cache is only ever written after a full successful run, so an existing cache is a complete backfill.)
  const complete = !!prev && prev.cases.length > 0;
  let sinceMs = backfillSince.getTime();
  if (complete) {
    const newest = prev.cases.reduce((a, c) => (c.date > a ? c.date : a), "0000-00-00");
    sinceMs = Math.max(sinceMs, Date.parse(newest) - OVERLAP_DAYS * 86_400_000);
  }

  const raw = new Map<string, { release: ApiRelease; queries: Set<string> }>();
  for (const query of DOJ_TITLE_QUERIES) {
    let page = 0;
    let fetched = 0;
    let total = 0;
    for (;;) {
      const res = await fetchJson<ApiPage>(pageUrl(query, page), { label: `doj "${query}" p${page}` });
      total = Number(res.metadata?.resultset?.count ?? 0);
      const results = res.results ?? [];
      let reachedEnd = results.length < PAGE_SIZE;
      for (const r of results) {
        if (Number(r.date) * 1000 < sinceMs) {
          reachedEnd = true;
          continue;
        }
        fetched++;
        const entry = raw.get(r.uuid);
        if (entry) entry.queries.add(query);
        else raw.set(r.uuid, { release: r, queries: new Set([query]) });
      }
      if (reachedEnd) break;
      page++;
      await sleep(REQUEST_GAP_MS);
    }
    console.log(`[doj] "${query}": ${fetched} in window (of ${total} all-time)`);
    await sleep(REQUEST_GAP_MS);
  }

  const byUuid = new Map<string, DojCase>();
  for (const c of prev?.cases ?? []) if (c.date >= backfillIso) byUuid.set(c.uuid, c);
  let dropped = 0;
  for (const { release, queries } of raw.values()) {
    const c = toCase(release, [...queries]);
    if (c) {
      const old = byUuid.get(c.uuid);
      if (old) c.matchedQueries = [...new Set([...old.matchedQueries, ...c.matchedQueries])];
      byUuid.set(c.uuid, c);
    } else {
      byUuid.delete(release.uuid);
      dropped++;
    }
  }

  const cases = [...byUuid.values()].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.uuid.localeCompare(b.uuid)));
  const cache: DojCache = {
    fetchedAt: new Date().toISOString(),
    backfillSince: backfillIso,
    dropped,
    cases,
  };
  writeCache("doj", cache);

  const by = <K extends string>(f: (c: DojCase) => K | null) => {
    const m: Record<string, number> = {};
    for (const c of cases) m[f(c) ?? "null"] = (m[f(c) ?? "null"] ?? 0) + 1;
    return JSON.stringify(m);
  };
  const summary =
    `${cases.length} releases kept since ${cache.backfillSince} (${raw.size} fetched this run, ${dropped} dropped); ` +
    `stage ${by((c) => c.stage)}; type ${by((c) => c.type)}; confidence ${by((c) => c.confidence)}`;
  console.log(`[doj] ${summary}`);
  return summary;
}

export function getCases(): DojCache | null {
  return readCache<DojCache>("doj");
}
