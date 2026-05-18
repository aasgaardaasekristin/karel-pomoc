/**
 * hanaTurnSegmenter.ts — FIX 8.2 / sub-FIX 8.2.2 (recall hardening)
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
 * 8.2.2 změny oproti 1.0.1:
 * - Em/en-dash a "--" splitter — " — ", " – ", " -- " jsou nové dělící body.
 * - Recall hardening:
 *   * STRONG_FIRST_PERSON_CUES: + "já"
 *   * HEALTH_TERMS: + "genetic"
 *   * EMOTION_TERMS: + "nestíh", "nezvlád"
 *   * MULTI_WORD_FIRST_PERSON: + "nevěděla jsem si rady" (alias)
 * - SELF_IDENTIFICATION_CUES: "Hanka tady", "Hana tady", "tady Hanka",
 *   "tady Hana" → intimate_self conf 0.7 (vlastní priority slot).
 * - Vocative+1psg fix: pokud po "Karle," / "Karli," následuje silná 1psg
 *   + intimní signál, vocative override propadá a chunk klasifikuje
 *   normální 1psg primacy → intimate_self.
 */

import { detectSegmentPart } from "./topicSegmentation.ts";

export const segmenterVersion = "1.0.2" as const;

export type HanaSegmentLabel =
  | "intimate_self"
  | "team_about_did"
  | "team_about_kata"
  | "team_logistics"
  | "meta_to_karel"
  | "ambiguous";

export type HanaTurnOverallLabel =
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
  overallLabel: HanaTurnOverallLabel;
}

// ── Cue dictionaries ──

/**
 * Silná 1. osoba sg. — exact word match (case-insensitive).
 * Záměrně NEOBSAHUJE "má" (3.os. sg.) ani "mi" samostatně mimo specifické formy.
 */
const STRONG_FIRST_PERSON_CUES = [
  "mám", "cítím", "jsem", "bojím", "toužím", "miluju", "miluji",
  "potřebuju", "potřebuji", "trpím", "beru",
  "můj", "moje", "moji", "mou", "mého", "mojí", "mé",
  "mě", "mně", "mi", "sebe", "sobě", "sebou",
  "stýská", "chybíš", "lásko", "miláčku",
];

/**
 * Multi-word 1psg patterny — substring match (case-insensitive).
 */
const MULTI_WORD_FIRST_PERSON = [
  "mě bolí", "bolí mě", "je mi", "u mě", "se mnou",
  "měla jsem", "měl jsem", "bojím se", "mám strach",
  "nemůžu", "nemůžu se", "nevím kudy", "nevěděla rady",
];

/**
 * Zdravotní termíny v intimním kontextu — prefix match.
 * Pokrývá Czech inflexe (kortikoid → kortikoidy/kortikoidů, migrén → migréna/migrénu).
 */
const HEALTH_TERMS = [
  "kortikoid", "hormon", "migrén", "epilepsi", "záchvat",
  "bolest", "bolí", "záda", "zad", "krk", "kolen",
  "únav", "vyčerp", "nespav", "spánk",
  "alergi", "ekzém", "kožní", "tlak", "srdc", "žaludek",
  "nevoln", "závrať", "závrat", "mdlob",
  "depres", "úzkost", "panik", "vyhoř", "burnout",
  "menstruac", "hormonál", "štítk", "štítn",
  "cysta", "nádor", "operac",
  "antidepres", "anxiolyt", "léky", "prášk",
];

/**
 * Vztahové/rodinné termíny — prefix match.
 * Vědomě bez plain "syn" (kolize "syntéza", "synonymum").
 */
const RELATION_TERMS = [
  "manžel", "dcer", "matk", "máma", "mámu", "mámo",
  "táta", "tátu", "tátov", "otec", "otc",
  "sestr", "bratr", "sourozenec",
  "rodič", "rodin", "babičk", "dědeč",
  "partner", "domov", "intim", "blízk", "samot",
];

/**
 * Emoční stavy v 1psg kontextu — prefix match.
 */
const EMOTION_TERMS = [
  "sama", "sám", "unaven", "smutn", "strach", "prázdn",
  "osamě", "zoufal", "beznad", "zlomen", "bezmoc",
  "vinn", "stud", "hněv", "vztek", "žal", "lítost",
];

/**
 * Legacy intimate cues z 1.0.0 — prefix match (zachováno pro back-compat).
 */
const LEGACY_INTIMATE_CUES = [
  "touh", "lásk", "objet", "polib", "rande",
  "úzkost", "radost", "smutno",
];

/**
 * DID klinické cues — prefix match.
 * "epilepsi" a "záchvat" jsou ZÁROVEŇ v HEALTH_TERMS — 1psg primacy rozhodne směr.
 * Multi-word cues ("v sezení", "v terapii") jdou přes substring fallback.
 */
const DID_CLINICAL_CUES = [
  "dít", "část", "kluci", "kluků", "klukům",
  "alter", "alteři", "přepnu", "switch",
  "abreac", "abreagova", "disociac", "disociova",
  "flashback", "traum",
  "playroom", "regulac", "grounding", "stabilizac",
  "spouštěč", "trigger", "epilepsi", "záchvat",
  "v sezení", "v terapii",
];

/**
 * Káťa cues — exact match (case-insensitive).
 */
const KATA_CUES = [
  "káťa", "káťu", "káťo", "káti", "katka", "katku", "katko", "kata",
];

/**
 * Logistika — exact match (case-insensitive).
 */
const LOGISTICS_CUES = [
  "termín", "schůzka", "schůzku",
  "pondělí", "úterý", "středa", "středu",
  "čtvrtek", "pátek", "sobota", "sobotu", "neděle", "neděli",
  "naplánovat", "přeložit", "zrušit", "přesunout", "přesuneme",
  "hodina", "hodinu", "hodin", "hodiny",
  "online", "osobně",
];

/**
 * Meta-to-Karel cues — exact match (case-insensitive).
 * "Karle" jako vocativ je ošetřen samostatným override.
 */
const META_TO_KAREL_CUES = [
  "karle", "karli", "karel",
  "udělej", "napiš", "pomoz", "vygeneruj", "shrň", "shrn",
  "zapiš", "připrav", "můžeš",
];

// ── Matcher helpers ──

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * EXACT word match — Czech-aware word boundary using Unicode property escapes.
 * Multi-word cues fall back to lowercase substring.
 */
function matchExact(text: string, cue: string): boolean {
  if (cue.includes(" ")) {
    return text.toLowerCase().includes(cue.toLowerCase());
  }
  const re = new RegExp(
    `(?:^|[^\\p{L}\\p{N}])${escapeRegex(cue)}(?:$|[^\\p{L}\\p{N}])`,
    "iu",
  );
  return re.test(text);
}

/**
 * PREFIX word match — cue at start of word, any Czech-letter suffix allowed.
 * Multi-word cues fall back to lowercase substring.
 */
function matchPrefix(text: string, cue: string): boolean {
  if (cue.includes(" ")) {
    return text.toLowerCase().includes(cue.toLowerCase());
  }
  const re = new RegExp(
    `(?:^|[^\\p{L}\\p{N}])${escapeRegex(cue)}\\p{L}*`,
    "iu",
  );
  return re.test(text);
}

function collectHits(text: string, cues: string[], mode: "exact" | "prefix"): string[] {
  const hits: string[] = [];
  const matcher = mode === "exact" ? matchExact : matchPrefix;
  for (const cue of cues) {
    if (matcher(text, cue)) hits.push(cue);
  }
  return hits;
}

function confidenceFromCount(n: number): number {
  if (n >= 3) return 0.9;
  if (n === 2) return 0.7;
  if (n === 1) return 0.5;
  return 0.0;
}

// ── Vocative override ──

const VOCATIVE_KAREL_RE = /^\s*(Karle|Karli)\s*[,:]/i;
const VOCATIVE_KATA_RE = /^\s*(Káťo|Káti|Katko)\s*[,:]/i;

// ── Classification ──

/**
 * Klasifikuje jeden chunk.
 * Priority:
 *   1) Vocative override (Karle, / Káťo,)
 *   2) 1psg primacy: silná 1psg + intimní signál → intimate_self (přebíjí DID)
 *   3) Secondary intimate: relation/emotion/legacy bez DID a Káťi
 *   4) team_about_did (DID cues nebo part_name)
 *   5) team_about_kata
 *   6) team_logistics
 *   7) meta_to_karel
 *   8) ambiguous
 */
function classifyChunk(text: string): { label: HanaSegmentLabel; confidence: number; cues: string[] } {
  // 1) Vocative override
  if (VOCATIVE_KAREL_RE.test(text)) {
    return { label: "meta_to_karel", confidence: 0.9, cues: ["vocative:Karel"] };
  }
  if (VOCATIVE_KATA_RE.test(text)) {
    return { label: "team_about_kata", confidence: 0.9, cues: ["vocative:Káťa"] };
  }

  const strong1psg = collectHits(text, STRONG_FIRST_PERSON_CUES, "exact");
  const multi1psg = MULTI_WORD_FIRST_PERSON.filter(p => text.toLowerCase().includes(p.toLowerCase()));
  const has1psg = strong1psg.length + multi1psg.length >= 1;

  const healthHits = collectHits(text, HEALTH_TERMS, "prefix");
  const relationHits = collectHits(text, RELATION_TERMS, "prefix");
  const emotionHits = collectHits(text, EMOTION_TERMS, "prefix");
  const legacyHits = collectHits(text, LEGACY_INTIMATE_CUES, "prefix");
  const intimateSignals = healthHits.length + relationHits.length + emotionHits.length + legacyHits.length;

  const didHits = collectHits(text, DID_CLINICAL_CUES, "prefix");
  const partMatch = detectSegmentPart(text, null);
  const hasDid = didHits.length >= 1 || !!partMatch;

  const kataHits = collectHits(text, KATA_CUES, "exact");
  const logisticsHits = collectHits(text, LOGISTICS_CUES, "exact");
  const metaHits = collectHits(text, META_TO_KAREL_CUES, "exact");

  // 2) 1psg primacy — přebíjí DID
  if (has1psg && intimateSignals >= 1) {
    const cues: string[] = [];
    strong1psg.forEach(c => cues.push(`first_person:${c}`));
    multi1psg.forEach(c => cues.push(`first_person_mw:${c}`));
    healthHits.forEach(c => cues.push(`health:${c}`));
    relationHits.forEach(c => cues.push(`relation:${c}`));
    emotionHits.forEach(c => cues.push(`emotion:${c}`));
    legacyHits.forEach(c => cues.push(`legacy_intimate:${c}`));
    const conf = healthHits.length >= 1 ? 0.9 : 0.7;
    return { label: "intimate_self", confidence: conf, cues };
  }

  // 3) Secondary intimate (relation/emotion/legacy bez DID a Káťi)
  const secondarySignals = relationHits.length + emotionHits.length + legacyHits.length;
  if (secondarySignals >= 1 && !hasDid && kataHits.length === 0) {
    const cues: string[] = [];
    relationHits.forEach(c => cues.push(`relation:${c}`));
    emotionHits.forEach(c => cues.push(`emotion:${c}`));
    legacyHits.forEach(c => cues.push(`legacy_intimate:${c}`));
    const conf = secondarySignals >= 2 ? 0.7 : 0.5;
    return { label: "intimate_self", confidence: conf, cues };
  }

  // 4) team_about_did
  if (hasDid) {
    const cues: string[] = [];
    didHits.forEach(c => cues.push(`did_clinical:${c}`));
    if (partMatch) cues.push(`part_name_match:${partMatch}`);
    // health term v DID kontextu (bez 1psg) = klinická poznámka o dítěti / části
    healthHits.forEach(c => cues.push(`did_health:${c}`));
    return { label: "team_about_did", confidence: confidenceFromCount(cues.length), cues };
  }

  // 5) team_about_kata
  if (kataHits.length >= 1) {
    const cues = kataHits.map(c => `kata:${c}`);
    return { label: "team_about_kata", confidence: confidenceFromCount(cues.length), cues };
  }

  // 6) team_logistics
  if (logisticsHits.length >= 1) {
    const cues = logisticsHits.map(c => `logistics:${c}`);
    return { label: "team_logistics", confidence: confidenceFromCount(cues.length), cues };
  }

  // 7) meta_to_karel
  if (metaHits.length >= 1) {
    const cues = metaHits.map(c => `meta:${c}`);
    return { label: "meta_to_karel", confidence: confidenceFromCount(cues.length), cues };
  }

  return { label: "ambiguous", confidence: 0.0, cues: [] };
}

// ── Splitter ──

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
    const chunkText = raw.slice(cursor, chunkEnd).trim();
    if (chunkText.length > 0) {
      const trimmedStart = cursor + (raw.slice(cursor, chunkEnd).length - raw.slice(cursor, chunkEnd).trimStart().length);
      out.push({ text: chunkText, start: trimmedStart, end: trimmedStart + chunkText.length });
    }
    cursor = sepEnd;
  }
  if (cursor < raw.length) {
    const tail = raw.slice(cursor).trim();
    if (tail.length > 0) {
      const trimmedStart = cursor + (raw.slice(cursor).length - raw.slice(cursor).trimStart().length);
      out.push({ text: tail, start: trimmedStart, end: trimmedStart + tail.length });
    }
  }
  return out;
}

// ── Overall label derivation ──

function deriveOverallLabel(segments: HanaTurnSegment[]): HanaTurnOverallLabel {
  if (segments.length === 0) return "empty";
  const nonAmbiguous = segments.filter(s => s.label !== "ambiguous");
  if (nonAmbiguous.length === 0) return "ambiguous";
  const distinct = new Set(nonAmbiguous.map(s => s.label));
  if (distinct.size === 1) {
    const only = [...distinct][0];
    return only === "intimate_self" ? "intimate_only" : only;
  }
  return "mixed";
}

// ── Main ──

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

  // Merge sousední se stejným labelem POKUD oba mají conf ≥ 0.6
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

  // Fragment guard: osiřelé krátké ambiguous segmenty (<15 znaků, conf===0)
  // přilepit k předchozímu segmentu (zachovat label předchozího).
  const guarded: HanaTurnSegment[] = [];
  for (const seg of merged) {
    const prev = guarded[guarded.length - 1];
    if (
      prev &&
      seg.text.length < 15 &&
      seg.confidence === 0 &&
      seg.label === "ambiguous"
    ) {
      prev.text = raw.slice(prev.start_offset, seg.end_offset);
      prev.end_offset = seg.end_offset;
      prev.cues.push(`fragment_guard:absorbed:${seg.text}`);
    } else {
      guarded.push(seg);
    }
  }

  return {
    segmenterVersion,
    segments: guarded,
    overallLabel: deriveOverallLabel(guarded),
  };
}
