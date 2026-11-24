// Search phrases and title-relevance terms. Edit here, not in the fetchers.

/** GDELT article-list queries (each run separately, phrase-quoted). */
export const GDELT_QUERIES = [
  "human trafficking",
  "forced labor",
  "scam compound",
  "debt bondage",
  "trafficking victims",
] as const;

/** DOJ title phrases. "trafficking" alone is useless (drugs / firearms). */
export const DOJ_TITLE_QUERIES = [
  "sex trafficking",
  "human trafficking",
  "forced labor",
  "labor trafficking",
  "involuntary servitude",
  "peonage",
] as const;

/**
 * A news article is relevance:"title" if its title contains any of these
 * (case-insensitive substring match), otherwise "body-only".
 * GDELT matches English phrases against machine-translated text, so titles
 * arrive in the original language — hence the translated terms.
 */
export const TITLE_TERMS = [
  // English
  "human trafficking", "sex trafficking", "labor trafficking", "labour trafficking",
  "child trafficking", "trafficking victim", "trafficking in persons", "trafficking ring",
  "trafficking of", "people trafficking", "person trafficking", "trafficked", "traffickers",
  "forced labor", "forced labour", "scam compound", "scam centre", "scam center",
  "debt bondage", "bonded labor", "bonded labour", "modern slavery", "modern-day slavery",
  "involuntary servitude", "sexual slavery", "sex slave", "enslaved",
  // German
  "menschenhandel", "zwangsarbeit", "zwangsprostitution", "moderne sklaverei",
  // Spanish / Portuguese
  "trata de personas", "tráfico de personas", "trata de blancas", "trabajo forzoso",
  "trabajo forzado", "víctimas de trata", "tráfico de pessoas", "trabalho escravo",
  "trabalho forçado", "tráfico humano",
  // French
  "traite des êtres humains", "traite d'êtres humains", "traite des personnes",
  "travail forcé", "esclavage moderne",
  // Italian / Dutch / Polish / Romanian / Turkish / Indonesian
  "tratta di esseri umani", "lavoro forzato", "mensenhandel", "dwangarbeid",
  "handel ludźmi", "trafic de persoane", "insan ticareti", "insan kaçakçılığı",
  "perdagangan orang", "perdagangan manusia", "tppo",
  // Russian / Ukrainian
  "торговля людьми", "торговли людьми", "торгівля людьми", "торгівлі людьми",
  "принудительный труд",
  // Arabic
  "الاتجار بالبشر", "الإتجار بالبشر", "العمل القسري",
  // Nepali / Hindi / Bengali
  "मानव बेचबिखन", "मानव तस्करी", "बंधुआ", "পাচার",
  // Chinese / Japanese / Korean / Vietnamese / Thai
  "人口贩卖", "人口販賣", "贩卖人口", "拐卖", "强迫劳动", "人身売買", "強制労働",
  "인신매매", "강제노동", "buôn người", "mua bán người", "ค้ามนุษย์",
] as const;
