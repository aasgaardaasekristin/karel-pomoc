/**
 * signalNormalization.ts — FÁZE 2.6
 *
 * Normalization & Provenance Layer.
 *
 * Every sensitive or indirect signal MUST pass through normalizeSignal()
 * before any operational or clinical write is permitted.
 *
 * FÁZE 2.6 CHANGES:
 * - Hardcoded KNOWN_PARTS removed
 * - detectPartInText() accepts optional EntityRegistry for registry-aware detection
 * - Part name matches here are CANDIDATE SIGNALS ONLY
 * - Identity confirmation requires resolveEntity() by the caller
 */

import type { EntityRegistry } from "./entityRegistry.ts";

// ── Types ──

export type SourceDomain =
  | "hana_personal"
  | "therapist_hanka"
  | "therapist_kata"
  | "part_conversation"
  | "meeting"
  | "post_session"
  | "crisis_thread";

export type SignalType =
  | "capacity"
  | "stress"
  | "relational"
  | "trust"
  | "clinical"
  | "risk"
  | "trigger"
  | "scheduling"
  | "supervision"
  | "attachment"
  | "unknown";

export type EvidenceStrength = "weak" | "moderate" | "strong";
export type Stability = "single_signal" | "emerging_pattern" | "stable_pattern";
export type PrivacyLevel = "private" | "abstracted" | "team_only";
export type ProvenanceKind = "direct" | "inferred" | "aggregated";

export type RecommendedAction =
  | "write_pamet"
  | "write_05a"
  | "write_05b"
  | "write_05c"
  | "write_part_card"
  | "create_task"
  | "create_session_plan"
  | "create_pending_question"
  | "trigger_meeting"
  | "no_action";

export interface NormalizedSignal {
  id: string;
  source_domain: SourceDomain;
  source_id: string;
  source_message_id?: string | null;
  source_timestamp: string;
  privacy_level: PrivacyLevel;
  provenance_kind: ProvenanceKind;
  signal_type: SignalType;
  subject_type: "therapist" | "part" | "system" | "family_context";
  subject_id: string;
  therapist?: "hanka" | "kata" | null;
  part_name?: string | null;
  /** Raw text — ONLY stored in PAMET_KAREL, never forwarded */
  raw_private_signal?: string | null;
  /** Normalized professional summary — safe for internal logging */
  normalized_summary: string;
  /** Safe summary — can appear in operational/clinical docs */
  safe_summary: string;
  confidence: number;
  evidence_strength: EvidenceStrength;
  repeat_count: number;
  stability: Stability;
  operational_relevance: boolean;
  clinical_relevance: boolean;
  derived_operational_implication?: string | null;
  derived_clinical_implication?: string | null;
  recommended_actions: RecommendedAction[];
}

// ── Signal Detection Keywords ──

const CAPACITY_KEYWORDS = [
  "kapacita", "nestíhám", "přetížená", "přetížený", "nemůžu",
  "nespala", "nespím", "nemám sílu", "potřebuju pauzu",
];
const STRESS_KEYWORDS = [
  "vyčerpaná", "unavená", "stres", "zátěž", "bolest",
  "úzkost", "nespala", "nemůžu", "vyčerpaný", "unavený",
];
const RELATIONAL_KEYWORDS = [
  "vztah", "hádka", "důvěra", "blízkost", "odmítnutí",
  "přilnutí", "odtažitost", "láska", "partnerství",
];
const TRUST_KEYWORDS = [
  "důvěra", "věří", "nevěří", "podezřívá", "bezpečí",
  "spolehlivost", "zradil", "zrada",
];
const CLINICAL_KEYWORDS = [
  "disociace", "přepnutí", "switch", "flashback", "trauma",
  "regulace", "grounding", "stabilizace", "sebepoškozování",
  "symptom", "spouštěč", "trigger",
];
const RISK_KEYWORDS = [
  "sebevražda", "sebepoškozování", "krize", "krizový",
  "nebezpečí", "útěk", "akutní", "suicid",
];
const SCHEDULING_KEYWORDS = [
  "sezení", "schůzka", "termín", "naplánovat", "přeložit",
  "zrušit", "domluvit", "kdy",
];
const SUPERVISION_KEYWORDS = [
  "supervize", "konzultace", "doporučení", "postup",
  "etika", "zpětná vazba", "mentoring",
];

// ── Part detection ──

/**
 * Default candidate part names for text-level detection.
 * Used when no EntityRegistry is available.
 * These are CANDIDATE SIGNALS ONLY — they never confirm identity.
 */
const DEFAULT_CANDIDATE_PART_NAMES = [
  "Arthur", "Tundrupek", "Gustík", "Gustik", "Petřík", "Anička", "Anicka",
  "Dmytri", "Dymi", "Bendik", "Einar", "Adam", "Bélo", "Clark", "Gabriel",
  "Gerhardt", "Baltazar", "Sebastián", "Matyáš", "Kvído", "Alvar", "Lobzhang",
  "Emily", "Gejbi", "C.G.", "Bytostne Ja",
];

/**
 * Detect a CANDIDATE part name in text.
 *
 * IMPORTANT: This is a CANDIDATE SIGNAL ONLY.
 * The returned name has NOT been verified as a confirmed DID part.
 * Callers MUST use resolveEntity() for identity confirmation.
 *
 * @param registry - Optional EntityRegistry for registry-aware detection.
 */
export function detectPartInText(
  text: string,
  registry?: EntityRegistry | null,
): string | null {
  const candidates = registry
    ? registry.getAllKnownNames()
    : DEFAULT_CANDIDATE_PART_NAMES;

  for (const p of candidates) {
    if (text.includes(p)) return p;
  }
  return null;
}

// ── Core Functions ──

interface NormalizeInput {
  raw_content: string;
  source_domain: SourceDomain;
  source_id: string;
  source_message_id?: string | null;
  source_timestamp?: string;
  therapist?: "hanka" | "kata" | null;
  /** Optional: pre-detected part name (candidate signal) */
  part_name?: string | null;
  /** Optional: how many times this signal has been seen before */
  prior_occurrences?: number;
  /** Optional: EntityRegistry for registry-aware part detection */
  registry?: EntityRegistry | null;
}

/**
 * Main entry point: normalize a raw signal into a structured, safe representation.
 */
export function normalizeSignal(input: NormalizeInput): NormalizedSignal {
  const lower = input.raw_content.toLowerCase();
  const signalType = detectSignalType(lower);
  const partName = input.part_name || detectPartInText(input.raw_content, input.registry);
  const subjectType = partName ? "part" as const
    : (input.therapist ? "therapist" as const : "system" as const);
  const subjectId = partName || input.therapist || "system";

  const evidenceStrength = assessEvidenceStrength(input);
  const confidence = computeConfidence(signalType, evidenceStrength, input.prior_occurrences || 0);
  const repeatCount = (input.prior_occurrences || 0) + 1;
  const stability = repeatCount >= 3 ? "stable_pattern" as const
    : repeatCount >= 2 ? "emerging_pattern" as const
    : "single_signal" as const;

  const privacyLevel = resolvePrivacyLevel(input.source_domain, signalType);
  const provenanceKind = resolveProvenanceKind(input.source_domain);

  const operationalRelevance = isOperationallyRelevant(signalType, privacyLevel);
  const clinicalRelevance = isClinicallyRelevant(signalType, partName);

  const normalizedSummary = buildNormalizedSummary(signalType, subjectId, input.therapist, partName);
  const safeSummary = buildSafeSummary(signalType, subjectId, input.therapist, partName);

  const derivedOp = operationalRelevance
    ? deriveOperationalImplication(signalType, input.therapist, partName)
    : null;
  const derivedClinical = clinicalRelevance && partName
    ? deriveClinicalImplication(signalType, partName, lower)
    : null;

  const signal: NormalizedSignal = {
    id: `sig-${input.source_id}-${Date.now().toString(36)}`,
    source_domain: input.source_domain,
    source_id: input.source_id,
    source_message_id: input.source_message_id || null,
    source_timestamp: input.source_timestamp || new Date().toISOString(),
    privacy_level: privacyLevel,
    provenance_kind: provenanceKind,
    signal_type: signalType,
    subject_type: subjectType,
    subject_id: subjectId,
    therapist: input.therapist || null,
    part_name: partName || null,
    raw_private_signal: privacyLevel === "private" ? input.raw_content : null,
    normalized_summary: normalizedSummary,
    safe_summary: safeSummary,
    confidence,
    evidence_strength: evidenceStrength,
    repeat_count: repeatCount,
    stability,
    operational_relevance: operationalRelevance,
    clinical_relevance: clinicalRelevance,
    derived_operational_implication: derivedOp,
    derived_clinical_implication: derivedClinical,
    recommended_actions: [],
  };

  signal.recommended_actions = decideRecommendedActions(signal);

  return signal;
}

// ── Signal Type Detection ──

function detectSignalType(lower: string): SignalType {
  if (RISK_KEYWORDS.some(kw => lower.includes(kw))) return "risk";
  if (CLINICAL_KEYWORDS.some(kw => lower.includes(kw))) return "clinical";
  if (CAPACITY_KEYWORDS.some(kw => lower.includes(kw))) return "capacity";
  if (STRESS_KEYWORDS.some(kw => lower.includes(kw))) return "stress";
  if (TRUST_KEYWORDS.some(kw => lower.includes(kw))) return "trust";
  if (RELATIONAL_KEYWORDS.some(kw => lower.includes(kw))) return "relational";
  if (SUPERVISION_KEYWORDS.some(kw => lower.includes(kw))) return "supervision";
  if (SCHEDULING_KEYWORDS.some(kw => lower.includes(kw))) return "scheduling";
  return "unknown";
}

// ── Evidence Strength ──

export function assessEvidenceStrength(input: NormalizeInput): EvidenceStrength {
  if (["therapist_hanka", "therapist_kata"].includes(input.source_domain)) return "moderate";
  if (input.source_domain === "part_conversation") return "moderate";
  if (input.source_domain === "post_session") return "strong";
  if (input.source_domain === "crisis_thread") return "strong";
  if (input.source_domain === "meeting") return "moderate";
  if (input.source_domain === "hana_personal") return "weak";
  return "weak";
}

// ── Confidence Score ──

function computeConfidence(
  signalType: SignalType,
  evidence: EvidenceStrength,
  priorOccurrences: number,
): number {
  let base = 0.3;
  if (evidence === "strong") base += 0.3;
  else if (evidence === "moderate") base += 0.15;
  if (signalType === "risk") base += 0.15;
  if (signalType === "clinical") base += 0.1;
  if (signalType === "capacity" || signalType === "stress") base += 0.05;
  base += Math.min(priorOccurrences * 0.1, 0.2);
  return Math.min(base, 1.0);
}

// ── Privacy Level ──

function resolvePrivacyLevel(domain: SourceDomain, _signalType: SignalType): PrivacyLevel {
  if (domain === "hana_personal") return "private";
  if (domain === "therapist_hanka" || domain === "therapist_kata") return "abstracted";
  return "team_only";
}

// ── Provenance Kind ──

function resolveProvenanceKind(domain: SourceDomain): ProvenanceKind {
  if (domain === "post_session" || domain === "crisis_thread") return "direct";
  if (domain === "meeting") return "direct";
  if (domain === "hana_personal") return "inferred";
  return "inferred";
}

// ── Relevance Checks ──

function isOperationallyRelevant(signalType: SignalType, privacyLevel: PrivacyLevel): boolean {
  if (privacyLevel === "private") {
    return ["capacity", "stress", "risk", "scheduling"].includes(signalType);
  }
  return ["capacity", "stress", "risk", "scheduling", "supervision", "clinical"].includes(signalType);
}

function isClinicallyRelevant(signalType: SignalType, partName: string | null): boolean {
  if (!partName) return false;
  return ["clinical", "risk", "trust", "trigger", "attachment", "relational"].includes(signalType);
}

// ── Summary Builders ──

function buildNormalizedSummary(
  signalType: SignalType,
  subjectId: string,
  therapist?: "hanka" | "kata" | null,
  partName?: string | null,
): string {
  const subj = partName ? `část ${partName}` : (therapist || subjectId);
  const typeLabels: Record<SignalType, string> = {
    capacity: "signál kapacitní zátěže",
    stress: "signál stresu/vyčerpání",
    relational: "vztahový signál",
    trust: "signál důvěry/bezpečí",
    clinical: "klinický signál",
    risk: "rizikový signál",
    trigger: "detekovaný spouštěč",
    scheduling: "organizační signál",
    supervision: "supervizní signál",
    attachment: "signál přilnutí/attachmentu",
    unknown: "nespecifikovaný signál",
  };
  return `${typeLabels[signalType]} u ${subj}`;
}

function buildSafeSummary(
  signalType: SignalType,
  subjectId: string,
  therapist?: "hanka" | "kata" | null,
  partName?: string | null,
): string {
  const today = new Date().toISOString().split("T")[0];
  const subj = partName ? `část ${partName}` : (therapist || subjectId);
  const summaries: Record<SignalType, string> = {
    capacity: `[${today}] Detekován kapacitní signál u ${subj}. Doporučeno zohlednit v plánování.`,
    stress: `[${today}] Signál zvýšené zátěže u ${subj}. Zvážit úpravu plánu.`,
    relational: `[${today}] Vztahový signál u ${subj}. Sledovat dynamiku.`,
    trust: `[${today}] Signál ve vztahové důvěře u ${subj}. Ověřit v kontaktu.`,
    clinical: `[${today}] Klinický signál u ${subj}. Doporučeno ověřit v sezení.`,
    risk: `[${today}] Rizikový signál u ${subj}. Vyžaduje pozornost.`,
    trigger: `[${today}] Spouštěč detekován u ${subj}. Monitorovat reakci.`,
    scheduling: `[${today}] Organizační potřeba u ${subj}.`,
    supervision: `[${today}] Supervizní podnět u ${subj}.`,
    attachment: `[${today}] Signál attachmentu u ${subj}. Ověřit v sezení.`,
    unknown: `[${today}] Nespecifikovaný signál u ${subj}. K ověření.`,
  };
  return summaries[signalType];
}

// ── Derived Implications ──

export function deriveOperationalImplication(
  signalType: SignalType,
  therapist?: "hanka" | "kata" | null,
  partName?: string | null,
): string {
  const who = therapist === "kata" ? "Káti" : (therapist === "hanka" ? "Hanky" : null);
  switch (signalType) {
    case "capacity":
      return who
        ? `Signál snížené kapacity ${who} — zvážit redukci úkolování.`
        : `Kapacitní signál v systému — zvážit prioritizaci.`;
    case "stress":
      return who
        ? `Signál zvýšené zátěže ${who} — zvážit úpravu plánu dne.`
        : `Stresový signál — monitorovat a přizpůsobit plán.`;
    case "risk":
      return partName
        ? `Rizikový signál u části ${partName} — eskalovat, ověřit bezpečnost.`
        : `Rizikový signál — vyžaduje okamžitou pozornost.`;
    case "scheduling":
      return `Organizační potřeba — zapracovat do plánu.`;
    case "supervision":
      return `Supervizní podnět — zařadit do agendy.`;
    case "clinical":
      return partName
        ? `Klinický signál u ${partName} — ověřit v dalším sezení.`
        : `Klinický signál — sledovat vývoj.`;
    default:
      return `Signál vyžadující zohlednění v denním plánování.`;
  }
}

export function deriveClinicalImplication(
  signalType: SignalType,
  partName: string,
  lowerContent: string,
): string {
  const today = new Date().toISOString().split("T")[0];
  const themes: string[] = [];
  if (["strach", "bojí", "úzkost", "panika", "děs"].some(w => lowerContent.includes(w)))
    themes.push("zvýšená úzkostná reaktivita");
  if (["vztek", "agrese", "naštvaný", "zuří"].some(w => lowerContent.includes(w)))
    themes.push("signály zvýšené afektivní tenze");
  if (["smutek", "pláče", "brečí", "stýská", "ztráta"].some(w => lowerContent.includes(w)))
    themes.push("emocionální zranitelnost — smutek/ztráta");
  if (["odmítnutí", "nechce", "odmítá", "zavírá", "stáhl"].some(w => lowerContent.includes(w)))
    themes.push("signál stažení / odmítání kontaktu");
  if (["přepnutí", "switch", "disociace", "ztratil", "zmizel"].some(w => lowerContent.includes(w)))
    themes.push("možný switching / disociativní signál");
  if (["důvěra", "věří", "nevěří", "podezřívá"].some(w => lowerContent.includes(w)))
    themes.push("signál ve vztahové důvěře");
  if (["spánek", "nespí", "noční", "budí se"].some(w => lowerContent.includes(w)))
    themes.push("narušení spánkového vzorce");
  if (["trauma", "flashback", "spouštěč", "trigger"].some(w => lowerContent.includes(w)))
    themes.push("signál traumatické reaktivace");

  if (themes.length === 0) {
    themes.push("nespecifikovaný signál vyžadující ověření v přímém kontaktu");
  }

  return `[${today}] Odvozená klinická implikace pro ${partName}: ${themes.join("; ")}. Doporučeno ověřit v dalším sezení.`;
}

// ── Recommended Actions ──

export function decideRecommendedActions(signal: NormalizedSignal): RecommendedAction[] {
  const actions: RecommendedAction[] = [];

  if (
    signal.privacy_level === "private" ||
    signal.signal_type === "supervision" ||
    signal.signal_type === "relational" ||
    signal.subject_type === "therapist"
  ) {
    actions.push("write_pamet");
  }

  if (canWriteToOperationalLayer(signal)) {
    if (signal.signal_type === "risk" || signal.signal_type === "capacity" || signal.signal_type === "stress") {
      actions.push("write_05a");
    }
    if (signal.stability !== "single_signal" && signal.signal_type === "clinical") {
      actions.push("write_05b");
    }
    if (signal.stability === "stable_pattern") {
      actions.push("write_05c");
    }
  }

  if (canWriteToPartCard(signal)) {
    actions.push("write_part_card");
  }

  if (signal.signal_type === "risk" && signal.confidence >= 0.6) {
    actions.push("create_task");
  }
  if (signal.signal_type === "clinical" && signal.evidence_strength !== "weak" && signal.part_name) {
    actions.push("create_session_plan");
  }
  if (signal.signal_type === "trust" && signal.stability === "emerging_pattern") {
    actions.push("create_pending_question");
  }
  if (signal.signal_type === "risk" && signal.confidence >= 0.7) {
    actions.push("trigger_meeting");
  }

  if (actions.length === 0) {
    actions.push(signal.privacy_level === "private" ? "write_pamet" : "no_action");
  }

  return actions;
}

// ── Gate Functions ──

/**
 * Can the signal be written to operational layer (05A/05B/05C/DASHBOARD)?
 */
export function canWriteToOperationalLayer(signal: NormalizedSignal): boolean {
  if (!signal.derived_operational_implication) return false;
  if (signal.privacy_level === "private") return false;
  if (!signal.operational_relevance) return false;
  if (signal.confidence < 0.45) return false;
  return true;
}

/**
 * Can the signal be written to a part card (KARTA_{PART})?
 */
export function canWriteToPartCard(signal: NormalizedSignal): boolean {
  if (!signal.derived_clinical_implication) return false;
  if (!signal.clinical_relevance) return false;
  if (signal.confidence < 0.55) return false;
  if (signal.evidence_strength === "weak" && signal.repeat_count < 2) return false;
  return true;
}
