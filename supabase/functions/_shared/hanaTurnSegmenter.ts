/**
 * hanaTurnSegmenter.ts — FIX 8.2
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
 */

import { detectSegmentPart } from "./topicSegmentation.ts";

export const segmenterVersion = "1.0.0" as const;

export type HanaSegmentLabel =
  | "intimate_self"
  | "team_about_did"
  | "team_about_kata"
  | "team_logistics"
  | "meta_to_karel"
  | "ambiguous";

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
}

// ── Cue dictionaries ──

const INTIMATE_FIRST_PERSON_CUES = [
  "já ", " já,", " já.", "mě ", "mně", " mi ", "mi.", "mi,",
  "můj", "moje", "moji", "mám", "měla jsem", "měl jsem",
  "potřebuju", "potřebuji", "cítím", "myslím si", "miluju",
  "miluji", "lásko", "stýská", "chybíš", "toužím",
];

const INTIMATE_CONTENT_CUES = [
  "bolest hlavy", "bolest", "tělo", "hormonální", "hormony",
  "menstruace", "sex", "intim", "vztah", "blízkost", "samota",
  "lásk", "objetí", "polibek", "rande", "spolu", "my dva",
  "touh", "smutno", "úzkost", "strach", "radost",
];

const DID_CLINICAL_CUES = [
  "dítě", "děti", "dětí", "dětem", "dětech", "dítěte",
  "část", "části", "kluci", "kluků", "klukům",
  "alter", "alteři", "přepnul", "přepnula", "přepnutí",
  "switch", "abreace", "abreagoval", "abreagovala",
  "disociace", "disociova", "flashback", "trauma",
  "v sezení", "playroom", "regulace", "grounding",
  "stabilizace", "spouštěč", "trigger", "epilepsie",
  "záchvat", "v terapii",
];

const KATA_CUES = ["Káťa", "Kata", "Katka", "káťa", "katka"];

const LOGISTICS_CUES = [
  "termín", "sezení", "schůzka", "pondělí", "úterý", "středa",
  "čtvrtek", "pátek", "sobota", "neděle", "naplánovat",
  "přeložit", "zrušit", "přesunout", "přesuneme", "hodina",
  "hodin", "v kolik", "kdy", "online", "osobně",
];

const META_TO_KAREL_CUES = [
  "Karle", "Karli", "Karel", "udělej", "napiš mi", "pomoz mi",
  "vygeneruj", "shrň", "shrn ", "zapiš", "připrav mi",
  "můžeš mi", "potřebuju od tebe", "AI",
];

// ── Helpers ──

function countCueHits(lower: string, original: string, cues: string[]): string[] {
  const hits: string[] = [];
  for (const cue of cues) {
    // Case-sensitive cues (jména, "Karle") vs case-insensitive
    const isProperNoun = /[A-ZÁ-Ž]/.test(cue);
    const found = isProperNoun
      ? original.includes(cue)
      : lower.includes(cue.toLowerCase());
    if (found) hits.push(cue);
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
 * intimate_self → team_about_did → team_about_kata → team_logistics → meta_to_karel → ambiguous
 */
function classifyChunk(text: string): { label: HanaSegmentLabel; confidence: number; cues: string[] } {
  const lower = text.toLowerCase();

  const firstPersonHits = countCueHits(lower, text, INTIMATE_FIRST_PERSON_CUES);
  const intimateContentHits = countCueHits(lower, text, INTIMATE_CONTENT_CUES);
  const didHits = countCueHits(lower, text, DID_CLINICAL_CUES);
  const kataHits = countCueHits(lower, text, KATA_CUES);
  const logisticsHits = countCueHits(lower, text, LOGISTICS_CUES);
  const metaHits = countCueHits(lower, text, META_TO_KAREL_CUES);

  // Part name match z registry (single source of truth)
  const partMatch = detectSegmentPart(text, null);
  const partCue = partMatch ? [`part_name_match:${partMatch}`] : [];

  // intimate_self: musí mít 1. osobu + (intimate content NEBO další 1. osoba)
  //   Pozn.: 1. osoba sama o sobě nestačí ("Mám telefon" není intimate).
  if (firstPersonHits.length >= 1 && intimateContentHits.length >= 1) {
    const cues = [...firstPersonHits.map(c => `first_person:${c.trim()}`),
                  ...intimateContentHits.map(c => `intimate_content:${c}`)];
    return { label: "intimate_self", confidence: confidenceFromCount(cues.length), cues };
  }

  // team_about_did: klinické cues (3. osoba) NEBO part_name match
  const didAllHits = [...didHits, ...partCue];
  if (didAllHits.length >= 1) {
    const cues = [...didHits.map(c => `did_clinical:${c}`), ...partCue];
    return { label: "team_about_did", confidence: confidenceFromCount(cues.length), cues };
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
 * Dělící body: [.!?] a sub-větné spojky (" a ", " ale ", " ovšem ", " zatímco "),
 * dále [;].
 *
 * Vrací pole {text, start, end}, kde text NEOBSAHUJE oddělovač.
 */
function splitWithOffsets(raw: string): Array<{ text: string; start: number; end: number }> {
  // Regex hledá oddělovače: . ! ? ; nebo " a " / " ale " / " ovšem " / " zatímco "
  const splitRe = /([.!?;])\s+|\s+(a|ale|ovšem|zatímco)\s+/g;
  const out: Array<{ text: string; start: number; end: number }> = [];
  let cursor = 0;
  let m: RegExpExecArray | null;
  while ((m = splitRe.exec(raw)) !== null) {
    const sepStart = m.index;
    const sepEnd = splitRe.lastIndex;
    // Chunk je [cursor, sepStart) — include trailing punctuation if it's . ! ? ;
    const includePunct = !!m[1];
    const chunkEnd = includePunct ? sepStart + 1 : sepStart;
    const chunkText = raw.slice(cursor, chunkEnd).trim();
    if (chunkText.length > 0) {
      const trimmedStart = cursor + (raw.slice(cursor, chunkEnd).length - raw.slice(cursor, chunkEnd).trimStart().length);
      out.push({ text: chunkText, start: trimmedStart, end: trimmedStart + chunkText.length });
    }
    cursor = sepEnd;
  }
  // Zbytek
  if (cursor < raw.length) {
    const tail = raw.slice(cursor).trim();
    if (tail.length > 0) {
      const trimmedStart = cursor + (raw.slice(cursor).length - raw.slice(cursor).trimStart().length);
      out.push({ text: tail, start: trimmedStart, end: trimmedStart + tail.length });
    }
  }
  return out;
}

/**
 * Hlavní vstupní bod. Pure deterministická funkce.
 */
export function segmentHanaTurn(input: HanaTurnSegmenterInput): HanaTurnSegmenterOutput {
  const raw = input.rawText ?? "";
  if (!raw.trim()) {
    return { segmenterVersion, segments: [] };
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
      const mergedText = raw.slice(prev.start_offset, c.end_offset);
      prev.text = mergedText;
      prev.end_offset = c.end_offset;
      prev.confidence = Math.max(prev.confidence, c.confidence);
      // Dedup cues
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

  return { segmenterVersion, segments: merged };
}
