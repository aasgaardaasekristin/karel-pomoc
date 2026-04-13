/**
 * topicSegmentation.ts — MEZIFÁZE (pre-FÁZE 3)
 *
 * Pre-normalization split layer.
 * Decomposes mixed messages (especially from Hana/osobní, therapist threads)
 * into single-topic segments BEFORE normalizeSignal() processes them.
 *
 * Pipeline: RAW MESSAGE → segmentMessageIntoTopics() → TopicSegment[]
 *           → per-segment normalizeSignal() → routing
 *
 * RULE: One segment = one dominant information function.
 * RULE: Never mix personal_relational and part_clinical in the same segment.
 * RULE: When uncertain, choose higher privacy + less aggressive routing.
 * RULE: Never merge segments with different dominant subjects (part_name or therapist).
 */

// ── Types ──

export type SegmentType =
  | "personal_relational"
  | "therapist_capacity"
  | "therapist_context"
  | "part_clinical"
  | "family_context"
  | "operational_logistic"
  | "meeting_relevant"
  | "crisis_signal"
  | "background_noise";

export interface TopicSegment {
  id: string;
  source_id: string;
  source_message_id?: string | null;
  raw_segment: string;
  segment_type: SegmentType;
  confidence: number;
  part_name?: string | null;
  therapist?: "hanka" | "kata" | null;
  safe_label: string;
}

// ── Keyword Dictionaries ──

const PERSONAL_RELATIONAL_KW = [
  "miluju", "miluji", "láska", "vztah", "stýská", "chybíš",
  "hádka", "smíření", "blízkost", "partnerství", "objetí",
  "polibek", "romantik", "společný večer", "rande", "náš",
  "spolu", "já a ty", "my dva", "karel a já", "hani a karel",
];

const THERAPIST_CAPACITY_KW = [
  "kapacita", "nestíhám", "přetížená", "přetížený", "vyčerpaná",
  "unavená", "nemůžu", "nemám sílu", "nespala", "nespím",
  "potřebuju pauzu", "volno", "dovolená", "nemoc", "nemocná",
  "bolest", "práce", "směna", "přesčas", "zkouška", "škola",
];

const THERAPIST_CONTEXT_KW = [
  "supervize", "konzultace", "školení", "kurz", "studium",
  "výcvik", "kolegové", "tým", "přístup", "metoda",
];

const PART_CLINICAL_KW = [
  "disociace", "přepnutí", "switch", "flashback", "trauma",
  "regulace", "grounding", "stabilizace", "sebepoškozování",
  "symptom", "spouštěč", "trigger", "část", "alter",
  "Arthur", "Tundrupek", "Gustík", "Petřík", "Anička",
  "Dmytri", "Dymi", "Bendik", "Einar", "Adam", "Bélo",
  "Clark", "Gabriel", "Gerhardt", "Baltazar", "Sebastián",
  "Matyáš", "Kvído", "Alvar", "Lobzhang", "Emily", "Gejbi",
];

const FAMILY_CONTEXT_KW = [
  "máma", "táta", "rodina", "sestra", "bratr", "babička",
  "dědeček", "rodiče", "tchyně", "tchán", "švagr", "švagrová",
  "Káťa", "kata", "katka", "Locík", "pes", "doma", "domácnost",
  "domov", "byt", "nájem", "stěhování",
];

const OPERATIONAL_LOGISTIC_KW = [
  "termín", "sezení", "schůzka", "naplánovat", "přeložit",
  "zrušit", "domluvit", "kdy", "kde", "čas", "hodina",
  "online", "osobně", "místnost", "organizace",
];

const MEETING_KW = [
  "porada", "meeting", "schůzka", "společné", "dohodly",
  "rozhodnutí", "konsenzus", "hlasování", "plán",
];

const CRISIS_KW = [
  "krize", "krizový", "sebevražda", "suicid", "akutní",
  "nebezpečí", "útěk", "ztráta kontroly", "halucinace",
  "dekompenzace", "hospitalizace",
];

// ── Known DID parts for segment-level detection ──

const KNOWN_PARTS = [
  "Arthur", "Tundrupek", "Gustík", "Gustik", "Petřík", "Anička", "Anicka",
  "Dmytri", "Dymi", "Bendik", "Einar", "Adam", "Bélo", "Clark", "Gabriel",
  "Gerhardt", "Baltazar", "Sebastián", "Matyáš", "Kvído", "Alvar", "Lobzhang",
  "Emily", "Gejbi", "C.G.", "Bytostne Ja",
];

/** Sensitive segment types that must NEVER be merged even if adjacent and same type */
const SENSITIVE_SEGMENT_TYPES: SegmentType[] = [
  "part_clinical",
  "personal_relational",
  "crisis_signal",
];

// ── Core Functions ──

/**
 * Main entry: split a single message (or small message cluster) into
 * topical segments. Each segment carries one dominant information function.
 *
 * For short, single-topic messages → returns 1 segment (no overhead).
 * For mixed messages → splits by thematic transitions.
 */
export function segmentMessageIntoTopics(
  text: string,
  sourceId: string,
  messageId?: string | null,
): TopicSegment[] {
  if (!text || text.trim().length < 15) {
    return [];
  }

  // Split into paragraphs / sentence groups
  const rawChunks = splitIntoParagraphs(text);

  // Classify each chunk
  const classified = rawChunks.map((chunk, idx) => ({
    text: chunk,
    type: classifySegmentType(chunk),
    index: idx,
  }));

  // Merge adjacent segments ONLY when safe (same type + same dominant subject)
  const merged = mergeAdjacentClassifiedStrict(classified);

  // Build TopicSegment objects
  return merged
    .filter(seg => isSegmentWorthProcessing(seg.text))
    .map((seg, idx) => ({
      id: `seg-${sourceId}-${idx}-${Date.now().toString(36)}`,
      source_id: sourceId,
      source_message_id: messageId || null,
      raw_segment: seg.text,
      segment_type: seg.type,
      confidence: seg.confidence,
      part_name: detectSegmentPart(seg.text),
      therapist: detectSegmentTherapist(seg.text),
      safe_label: buildSafeLabel(seg.type, seg.text),
    }));
}

/**
 * Build message clusters from an array of messages.
 * A cluster = 1-3 consecutive user messages from the same author
 * within a short time window (or simply consecutive by position).
 */
export function buildMessageClusters(
  messages: Array<{ role: string; content: string; id?: string; timestamp?: string }>,
  maxClusterSize = 3,
  maxGapMs = 5 * 60 * 1000,
): Array<{ text: string; messageIds: string[] }> {
  const userMsgs = messages.filter(m => m.role === "user" && m.content?.trim());

  if (userMsgs.length === 0) return [];

  const clusters: Array<{ text: string; messageIds: string[] }> = [];
  let currentCluster: typeof userMsgs = [];

  for (let i = 0; i < userMsgs.length; i++) {
    const msg = userMsgs[i];
    const prev = i > 0 ? userMsgs[i - 1] : null;

    const shouldSplit = currentCluster.length >= maxClusterSize
      || (prev?.timestamp && msg.timestamp && isTimegapTooLarge(prev.timestamp, msg.timestamp, maxGapMs));

    if (shouldSplit && currentCluster.length > 0) {
      clusters.push({
        text: currentCluster.map(m => m.content).join("\n\n"),
        messageIds: currentCluster.map(m => m.id || ""),
      });
      currentCluster = [];
    }

    currentCluster.push(msg);
  }

  if (currentCluster.length > 0) {
    clusters.push({
      text: currentCluster.map(m => m.content).join("\n\n"),
      messageIds: currentCluster.map(m => m.id || ""),
    });
  }

  return clusters;
}

/**
 * Classify a text chunk into a SegmentType.
 * Uses keyword-based heuristics — no AI call.
 */
export function classifySegmentType(text: string): SegmentType {
  const lower = text.toLowerCase();

  const scores: Record<SegmentType, number> = {
    crisis_signal: countMatches(lower, CRISIS_KW) * 3,
    part_clinical: countMatches(lower, PART_CLINICAL_KW) * 2,
    personal_relational: countMatches(lower, PERSONAL_RELATIONAL_KW) * 2,
    therapist_capacity: countMatches(lower, THERAPIST_CAPACITY_KW) * 1.5,
    family_context: countMatches(lower, FAMILY_CONTEXT_KW) * 1.5,
    therapist_context: countMatches(lower, THERAPIST_CONTEXT_KW) * 1.5,
    meeting_relevant: countMatches(lower, MEETING_KW) * 1.5,
    operational_logistic: countMatches(lower, OPERATIONAL_LOGISTIC_KW) * 1,
    background_noise: 0,
  };

  let best: SegmentType = "background_noise";
  let bestScore = 0;
  for (const [type, score] of Object.entries(scores)) {
    if (score > bestScore) {
      bestScore = score;
      best = type as SegmentType;
    }
  }

  return best;
}

/**
 * Merge adjacent classified chunks ONLY when:
 * 1. Same segment_type
 * 2. NOT a sensitive type (part_clinical, personal_relational, crisis_signal)
 * 3. Same dominant subject (part_name AND therapist)
 *
 * This prevents two different part_clinical passages about different parts
 * from being incorrectly merged.
 */
function mergeAdjacentClassifiedStrict(
  chunks: Array<{ text: string; type: SegmentType; index: number }>,
): Array<{ text: string; type: SegmentType; confidence: number }> {
  if (chunks.length === 0) return [];

  const result: Array<{ text: string; type: SegmentType; confidence: number; partName: string | null; therapist: string | null }> = [
    {
      text: chunks[0].text,
      type: chunks[0].type,
      confidence: computeSegmentConfidence(chunks[0].text, chunks[0].type),
      partName: detectSegmentPart(chunks[0].text),
      therapist: detectSegmentTherapist(chunks[0].text),
    },
  ];

  for (let i = 1; i < chunks.length; i++) {
    const prev = result[result.length - 1];
    const curr = chunks[i];
    const currPartName = detectSegmentPart(curr.text);
    const currTherapist = detectSegmentTherapist(curr.text);

    const sameType = prev.type === curr.type;
    const isSensitive = SENSITIVE_SEGMENT_TYPES.includes(curr.type);
    const sameDominantSubject = prev.partName === currPartName && prev.therapist === currTherapist;

    // Merge only if: same type AND (not sensitive OR same dominant subject)
    if (sameType && (!isSensitive || sameDominantSubject)) {
      prev.text = prev.text + "\n" + curr.text;
      prev.confidence = Math.max(
        prev.confidence,
        computeSegmentConfidence(curr.text, curr.type),
      );
      prev.partName = prev.partName || currPartName;
      prev.therapist = prev.therapist || currTherapist;
    } else {
      result.push({
        text: curr.text,
        type: curr.type,
        confidence: computeSegmentConfidence(curr.text, curr.type),
        partName: currPartName,
        therapist: currTherapist,
      });
    }
  }

  return result.map(r => ({ text: r.text, type: r.type, confidence: r.confidence }));
}

/**
 * Legacy export — kept for backward compat but now delegates to strict merge.
 */
export function mergeAdjacentSegments(
  segments: TopicSegment[],
): TopicSegment[] {
  if (segments.length <= 1) return segments;

  const result: TopicSegment[] = [segments[0]];
  for (let i = 1; i < segments.length; i++) {
    const prev = result[result.length - 1];
    const curr = segments[i];

    const sameType = prev.segment_type === curr.segment_type;
    const isSensitive = SENSITIVE_SEGMENT_TYPES.includes(curr.segment_type);
    const sameDominantSubject = prev.part_name === curr.part_name && prev.therapist === curr.therapist;

    if (sameType && (!isSensitive || sameDominantSubject)) {
      result[result.length - 1] = {
        ...prev,
        raw_segment: prev.raw_segment + "\n" + curr.raw_segment,
        confidence: Math.max(prev.confidence, curr.confidence),
        part_name: prev.part_name || curr.part_name,
        therapist: prev.therapist || curr.therapist,
        safe_label: buildSafeLabel(prev.segment_type, prev.raw_segment + " " + curr.raw_segment),
      };
    } else {
      result.push(curr);
    }
  }
  return result;
}

/**
 * Detect DID part name in a text segment.
 */
export function detectSegmentPart(text: string): string | null {
  for (const p of KNOWN_PARTS) {
    if (text.includes(p)) return p;
  }
  return null;
}

/**
 * Detect therapist mention in a text segment.
 */
export function detectSegmentTherapist(text: string): "hanka" | "kata" | null {
  const lower = text.toLowerCase();
  if (["kata", "káťa", "katka"].some(kw => lower.includes(kw))) return "kata";
  if (["hanka", "hanička", "hanicka", "mamka"].some(kw => lower.includes(kw))) return "hanka";
  return null;
}

/**
 * Filter out segments that are too short or trivial.
 */
export function isSegmentWorthProcessing(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 10) return false;

  const trivialPatterns = [
    /^(ok|ano|ne|jo|díky|děkuji|ahoj|čau|dobře|jasně|hmm|hm|no)\s*[.!?]*$/i,
  ];
  return !trivialPatterns.some(p => p.test(trimmed));
}

// ── Internal Helpers ──

function splitIntoParagraphs(text: string): string[] {
  const chunks = text.split(/\n{2,}/);

  const result: string[] = [];
  for (const chunk of chunks) {
    if (chunk.trim().length === 0) continue;

    const sentences = splitSentences(chunk);
    if (sentences.length <= 2) {
      result.push(chunk.trim());
      continue;
    }

    const subSegments = findTopicBoundaries(sentences);
    for (const sub of subSegments) {
      if (sub.trim().length > 0) {
        result.push(sub.trim());
      }
    }
  }

  return result.filter(c => c.length > 0);
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .filter(s => s.trim().length > 0);
}

function findTopicBoundaries(sentences: string[]): string[] {
  if (sentences.length <= 1) return [sentences.join(" ")];

  const groups: string[][] = [[sentences[0]]];

  for (let i = 1; i < sentences.length; i++) {
    const prevType = classifySegmentType(groups[groups.length - 1].join(" "));
    const currType = classifySegmentType(sentences[i]);

    if (prevType !== currType && currType !== "background_noise" && prevType !== "background_noise") {
      groups.push([sentences[i]]);
    } else {
      groups[groups.length - 1].push(sentences[i]);
    }
  }

  return groups.map(g => g.join(" "));
}

function countMatches(lower: string, keywords: string[]): number {
  let count = 0;
  for (const kw of keywords) {
    if (lower.includes(kw.toLowerCase())) count++;
  }
  return count;
}

function computeSegmentConfidence(text: string, type: SegmentType): number {
  if (type === "background_noise") return 0.2;

  const lower = text.toLowerCase();
  const kwMap: Record<SegmentType, string[]> = {
    crisis_signal: CRISIS_KW,
    part_clinical: PART_CLINICAL_KW,
    personal_relational: PERSONAL_RELATIONAL_KW,
    therapist_capacity: THERAPIST_CAPACITY_KW,
    therapist_context: THERAPIST_CONTEXT_KW,
    family_context: FAMILY_CONTEXT_KW,
    operational_logistic: OPERATIONAL_LOGISTIC_KW,
    meeting_relevant: MEETING_KW,
    background_noise: [],
  };

  const matches = countMatches(lower, kwMap[type] || []);
  if (matches >= 3) return 0.9;
  if (matches >= 2) return 0.75;
  if (matches >= 1) return 0.55;
  return 0.3;
}

function buildSafeLabel(type: SegmentType, text: string): string {
  const labelMap: Record<SegmentType, string> = {
    personal_relational: "osobní/vztahový obsah",
    therapist_capacity: "kapacita terapeuta",
    therapist_context: "kontext terapeuta",
    part_clinical: "klinický obsah (část)",
    family_context: "rodinný kontext",
    operational_logistic: "logistika/organizace",
    meeting_relevant: "relevantní pro poradu",
    crisis_signal: "krizový signál",
    background_noise: "nerelevantní",
  };
  return labelMap[type] || "nespecifikováno";
}

function isTimegapTooLarge(ts1: string, ts2: string, maxGapMs: number): boolean {
  try {
    const t1 = new Date(ts1).getTime();
    const t2 = new Date(ts2).getTime();
    return Math.abs(t2 - t1) > maxGapMs;
  } catch {
    return false;
  }
}
