/**
 * hanaTurnSegmenter.ts — FIX 8.2 / 8.2.1
 *
 * Deterministická pure function pro segmentaci Hančiných tahů (turns)
 * v rámci Hana/Osobní režimu. Rozdělí jeden text na 1..N segmentů,
 * každý s vlastním labelem, confidence a auditovatelnými cues.
 *
 * GARANCE:
 * - Pure: žádné DB volání, žádný fetch, žádný Deno.env, žádné side effects.
 * - Determinismus: stejný vstup → stejný výstup.
 * - Žádné LLM volání.
 * - Žádné DB writy.
 * - Žádný call-site (zatím se nikam nevolá; integrace je 8.3+).
 *
 * Reuse: `detectSegmentPart` z `./topicSegmentation.ts` jako single source
 * of truth pro kanonický seznam jmen částí (CANDIDATE SIGNAL ONLY).
 *
 * 8.2.1 změny (architektonická díra O-13):
 *  - rozšíření INTIMATE cues o zdravotní / vztahové / emoční termíny,
 *  - pravidlo prvenství 1. osoby (strong 1psg + intimate signal vyhrává
 *    nad team_about_did, i když je v segmentu DID/part_name cue),
 *  - rodina/emoce v 1psg-less segmentu padne na intimate_self
 *    (pokud zároveň není DID cue),
 *  - vocative override (Karle, / Káťo, na začátku → meta/team),
 *  - fragment guard pro krátké osiřelé chunky bez cues,
 *  - cue matching s Unicode word-boundary (vyloučí "mám" uvnitř "máma"),
 *  - overallLabel ("intimate_only" | label name | "mixed" | "empty").
 */

import { detectSegmentPart } from "./topicSegmentation.ts";

export const segmenterVersion = "1.0.1" as const;

export type HanaSegmentLabel =
  | "intimate_self"
  | "team_about_did"
  | "team_about_kata"
  | "team_logistics"
  | "meta_to_karel"
  | "ambiguous";

export type HanaOverallLabel =
  | "empty"
  | "intimate_only"
  | "team_about_did"
  | "team_about_kata"
  | "team_logistics"
  | "meta_to_karel"
  | "ambiguous"
  | "mixed";

export interface HanaTurnSegment {
  label: HanaSegmentLabel;
  text: string;
  start_offset: number;
  end_offset: number;
  confidence: number;
  cues: string[];
}

export interface HanaTurnSegmenterInput {
  rawText: string;
}

export interface HanaTurnSegmenterOutput {
  segmenterVersion: typeof segmenterVersion;
  segments: HanaTurnSegment[];
  overallLabel: HanaOverallLabel;
}

// ── Cue dictionaries ──

/** Silná 1. osoba sg. — slovesa, posesivy, osobní zájmena. */
const STRONG_FIRST_PERSON_CUES = [
  "mám", "měla jsem", "měl jsem", "cítím", "cítím se",
  "jsem", "bojím", "bojím se", "trpím", "beru",
  "je mi", "bolí mě", "mě bolí", "nemůžu", "nemohu",
  "můj", "moje", "moji", "mně", "mě", "mi", "u mě",
  "miluju", "miluji", "potřebuju", "potřebuji",
  "toužím", "chybíš", "stýská", "myslím si",
  "lásko",
];

/** Zdravotní termíny — Hana o svém těle. */
const HEALTH_TERMS = [
  "kortikoidy", "hormony", "hormonální", "migréna", "migrény",
  "bolest hlavy", "bolest", "bolesti", "bolest zad", "záda",
  "krk", "kolena", "únava", "vyčerpání", "nespavost", "spánek",
  "alergie", "ekzém", "kožní", "krevní tlak", "tlak", "srdce",
  "žaludek", "nevolnost", "závrať", "závratě", "mdloba", "mdloby",
  "epilepsie", "záchvat", "záchvaty", "deprese", "úzkost",
  "panika", "panická", "vyhoření", "burnout", "menstruace",
  "štítná žláza", "štítka", "cysta", "nádor", "operace",
  "léky", "antidepresiva", "anxiolytika",
];

/** Vztahové / rodinné termíny. */
const RELATION_TERMS = [
  "manžel", "manžela", "manželovi", "manželem",
  "dcera", "dceru", "dceři", "dcerou",
  "syn", "syna", "synovi", "synem",
  "máma", "mámu", "mámě", "matka", "matku", "matce",
  "táta", "tátu", "tátovi", "otec", "otce", "otcem",
  "sourozenec", "sestra", "sestru", "bratr", "bratra",
  "rodiče", "rodina", "rodinu", "babička", "babičku", "babičky",
  "dědeček", "dědečka", "partner", "partnera",
  "doma", "domov", "domova",
];

/** Emoční stavy v 1. osobě nebo obecně intimní. */
const EMOTION_TERMS = [
  "smutná", "smutný", "smutno", "unavená", "unavený",
  "divně", "špatně", "sama", "sám", "osaměla",
  "prázdno", "strach", "panika",
];

/** Legacy intimate content (zachováno z 1.0.0 — vztah / blízkost). */
const INTIMATE_LEGACY_CUES = [
  "vztah", "blízkost", "samota", "lásk", "objetí",
  "polibek", "rande", "spolu", "my dva", "touh",
  "radost", "sex", "intim",
];

const DID_CLINICAL_CUES = [
  "dítě", "děti", "dětí", "dětem", "dětech", "dítěte",
  "část", "části", "kluci", "kluků", "klukům",
  "alter", "alteři", "přepnul", "přepnula", "přepnutí",
  "switch", "abreace", "abreagoval", "abreagovala",
  "disociace", "disociova", "flashback", "trauma",
  "v sezení", "playroom", "regulace", "grounding",
  "stabilizace", "spouštěč", "trigger",
  "v terapii",
];

const KATA_CUES = ["Káťa", "Káťo", "Káti", "Kata", "Katka", "Káťu"];

const LOGISTICS_CUES = [
  "termín", "schůzka", "pondělí", "úterý", "středa",
  "čtvrtek", "pátek", "sobota", "neděle", "naplánovat",
  "přeložit", "zrušit", "přesunout", "přesuneme", "hodina",
  "hodin", "v kolik", "online", "osobně", "přesuňme",
];

const META_TO_KAREL_CUES = [
  "Karle", "Karli", "Karel", "udělej", "napiš mi", "pomoz mi",
  "vygeneruj", "shrň", "shrn ", "zapiš", "připrav mi",
  "můžeš mi", "potřebuju od tebe", "AI",
];

const VOCATIVE_KAREL_RE = /^\s*(Karle|Karli)\s*[,:]/u;
const VOCATIVE_KATA_RE = /^\s*(Káťo|Káti|Katko)\s*[,:]/u;

// ── Helpers ──

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Cue match s Unicode word-boundary (vyloučí "mám" uvnitř "máma"). */
function hasCue(text: string, cue: string, caseSensitive: boolean): boolean {
  const flags = caseSensitive ? "u" : "iu";
  const re = new RegExp(`(?<![\\p{L}])${escapeRe(cue.trim())}(?![\\p{L}])`, flags);
  return re.test(text);
}

function countCueHits(text: string, cues: string[]): string[] {
  const hits: string[] = [];
  for (const cue of cues) {
    const firstChar = cue.charAt(0);
    const isProperNoun =
      firstChar !== firstChar.toLowerCase() &&
      firstChar === firstChar.toUpperCase();
    if (hasCue(text, cue, isProperNoun)) hits.push(cue);
  }
  return hits;
}

function confidenceFromCount(n: number): number {
  if (n >= 3) return 0.9;
  if (n === 2) return 0.7;
  if (n === 1) return 0.5;
  return 0.0;
}

/**
 * Klasifikuje jeden chunk (větu nebo sub-větu) podle priority:
 *  1) vocative override → meta / kata
 *  2) intimate_self (1psg primacy: i když je DID cue, 1psg + intimní signál vyhrává)
 *  3) team_about_did (DID cue / part_name)
 *  4) intimate_self z relation/emotion bez 1psg, pokud žádný DID/kata
 *  5) team_about_kata
 *  6) team_logistics
 *  7) meta_to_karel
 *  8) ambiguous
 */
function classifyChunk(text: string): { label: HanaSegmentLabel; confidence: number; cues: string[] } {
  // 1) vocative override
  const isVocativeKarel = VOCATIVE_KAREL_RE.test(text);
  const isVocativeKata = VOCATIVE_KATA_RE.test(text);

  const strong1psg = countCueHits(text, STRONG_FIRST_PERSON_CUES);
  const healthHits = countCueHits(text, HEALTH_TERMS);
  const relationHits = countCueHits(text, RELATION_TERMS);
  const emotionHits = countCueHits(text, EMOTION_TERMS);
  const legacyHits = countCueHits(text, INTIMATE_LEGACY_CUES);
  const didHits = countCueHits(text, DID_CLINICAL_CUES);
  const kataHits = countCueHits(text, KATA_CUES);
  const logisticsHits = countCueHits(text, LOGISTICS_CUES);
  const metaHits = countCueHits(text, META_TO_KAREL_CUES);

  const partMatch = detectSegmentPart(text, null);
  const partCue = partMatch ? [`part_name_match:${partMatch}`] : [];

  if (isVocativeKarel) {
    const cues = ["vocative:Karel", ...metaHits.map(c => `meta:${c}`)];
    return { label: "meta_to_karel", confidence: 0.9, cues };
  }
  if (isVocativeKata) {
    const cues = ["vocative:Káťa", ...kataHits.map(c => `kata:${c}`)];
    return { label: "team_about_kata", confidence: 0.9, cues };
  }

  const intimateSignalCount =
    healthHits.length + relationHits.length + emotionHits.length + legacyHits.length;

  // 2) intimate_self s 1psg primacy
  if (strong1psg.length >= 1 && intimateSignalCount >= 1) {
    const cues: string[] = [
      ...strong1psg.map(c => `first_person:${c}`),
      ...healthHits.map(c => `intimate_health:${c}`),
      ...relationHits.map(c => `intimate_relation:${c}`),
      ...emotionHits.map(c => `intimate_emotion:${c}`),
      ...legacyHits.map(c => `intimate_legacy:${c}`),
    ];
    // 0.9 pokud 1psg + zdravotní, jinak 0.7
    const conf = healthHits.length >= 1 ? 0.9 : 0.7;
    return { label: "intimate_self", confidence: conf, cues };
  }

  // 3) team_about_did
  const didAllHits = [...didHits, ...partCue];
  if (didAllHits.length >= 1) {
    const cues = [...didHits.map(c => `did_clinical:${c}`), ...partCue];
    return { label: "team_about_did", confidence: confidenceFromCount(cues.length), cues };
  }

  // 4) intimate_self bez 1psg (rodina / emoce / legacy bez DID/kata)
  if (
    (relationHits.length >= 1 || emotionHits.length >= 1 || legacyHits.length >= 1) &&
    kataHits.length === 0
  ) {
    const cues: string[] = [
      ...relationHits.map(c => `intimate_relation:${c}`),
      ...emotionHits.map(c => `intimate_emotion:${c}`),
      ...legacyHits.map(c => `intimate_legacy:${c}`),
    ];
    const conf = cues.length >= 2 ? 0.7 : 0.5;
    return { label: "intimate_self", confidence: conf, cues };
  }

  if (kataHits.length >= 1) {
    const cues = kataHits.map(c => `kata:${c}`);
    return { label: "team_about_kata", confidence: confidenceFromCount(cues.length), cues };
  }

  if (logisticsHits.length >= 1) {
    const cues = logisticsHits.map(c => `logistics:${c}`);
    return { label: "team_logistics", confidence: confidenceFromCount(cues.length), cues };
  }

  if (metaHits.length >= 1) {
    const cues = metaHits.map(c => `meta:${c}`);
    return { label: "meta_to_karel", confidence: confidenceFromCount(cues.length), cues };
  }

  return { label: "ambiguous", confidence: 0.0, cues: [] };
}

/**
 * Rozdělí text na chunky se zachováním offsetů.
 * Dělící body: [.!?;] a sub-větné spojky (" a ", " ale ", " ovšem ", " zatímco ").
 */
function splitWithOffsets(raw: string): Array<{ text: string; start: number; end: number }> {
  const splitRe = /([.!?;])\s+|\s+(a|ale|ovšem|zatímco)\s+/g;
  const out: Array<{ text: string; start: number; end: number }> = [];
  let cursor = 0;
  let m: RegExpExecArray | null;
  while ((m = splitRe.exec(raw)) !== null) {
    const sepStart = m.index;
    const sepEnd = splitRe.lastIndex;
    const includePunct = !!m[1];
    const chunkEnd = includePunct ? sepStart + 1 : sepStart;
    const slice = raw.slice(cursor, chunkEnd);
    const chunkText = slice.trim();
    if (chunkText.length > 0) {
      const leadOffset = slice.length - slice.trimStart().length;
      const trimmedStart = cursor + leadOffset;
      out.push({ text: chunkText, start: trimmedStart, end: trimmedStart + chunkText.length });
    }
    cursor = sepEnd;
  }
  if (cursor < raw.length) {
    const slice = raw.slice(cursor);
    const tail = slice.trim();
    if (tail.length > 0) {
      const leadOffset = slice.length - slice.trimStart().length;
      const trimmedStart = cursor + leadOffset;
      out.push({ text: tail, start: trimmedStart, end: trimmedStart + tail.length });
    }
  }
  return out;
}

function computeOverallLabel(segments: HanaTurnSegment[]): HanaOverallLabel {
  if (segments.length === 0) return "empty";
  const distinct = new Set(segments.map(s => s.label));
  if (distinct.size === 1) {
    const only = segments[0].label;
    if (only === "intimate_self") return "intimate_only";
    return only;
  }
  // Pokud jediný "ne-ambiguous" label se opakuje a zbytek je ambiguous,
  // bereme to jako jeho label_only (ambiguous fragmenty nepočítají).
  const nonAmbiguous = new Set(
    segments.filter(s => s.label !== "ambiguous").map(s => s.label),
  );
  if (nonAmbiguous.size === 1) {
    const only = [...nonAmbiguous][0];
    if (only === "intimate_self") return "intimate_only";
    return only;
  }
  return "mixed";
}

/**
 * Hlavní vstupní bod. Pure deterministická funkce.
 */
export function segmentHanaTurn(input: HanaTurnSegmenterInput): HanaTurnSegmenterOutput {
  const raw = input.rawText ?? "";
  if (!raw.trim()) {
    return { segmenterVersion, segments: [], overallLabel: "empty" };
  }

  const chunks = splitWithOffsets(raw);
  const classified = chunks.map(c => ({
    ...c,
    ...classifyChunk(c.text),
  }));

  // Krok A: merge sousední se stejným labelem POKUD oba mají conf ≥ 0.6
  const merged: HanaTurnSegment[] = [];
  for (const c of classified) {
    const prev = merged[merged.length - 1];
    if (
      prev &&
      prev.label === c.label &&
      prev.confidence >= 0.6 &&
      c.confidence >= 0.6
    ) {
      prev.text = raw.slice(prev.start_offset, c.end);
      prev.end_offset = c.end;
      prev.confidence = Math.max(prev.confidence, c.confidence);
      const seen = new Set(prev.cues);
      for (const cue of c.cues) {
        if (!seen.has(cue)) {
          prev.cues.push(cue);
          seen.add(cue);
        }
      }
    } else {
      merged.push({
        label: c.label,
        text: c.text,
        start_offset: c.start,
        end_offset: c.end,
        confidence: c.confidence,
        cues: [...c.cues],
      });
    }
  }

  // Krok B: fragment guard — segmenty <15 znaků s conf=0 přilepit k předchozímu
  const guarded: HanaTurnSegment[] = [];
  for (const seg of merged) {
    const prev = guarded[guarded.length - 1];
    const isOrphanFragment = seg.text.length < 15 && seg.confidence === 0;
    if (prev && isOrphanFragment) {
      prev.text = raw.slice(prev.start_offset, seg.end_offset);
      prev.end_offset = seg.end_offset;
      // label & cues zůstávají z prev, jen rozšíříme rozsah
      continue;
    }
    guarded.push(seg);
  }

  return {
    segmenterVersion,
    segments: guarded,
    overallLabel: computeOverallLabel(guarded),
  };
}
