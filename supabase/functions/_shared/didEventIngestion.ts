// P21: ts-nocheck removed; types kept loose with explicit `any` casts at row boundaries.
/**
 * didEventIngestion.ts — centrální sběr DID-relevantních událostí.
 *
 * Cíl: převést vstupy z různých povrchů na normalizované události,
 * klasifikovat je s důkazovou disciplínou a routovat zpracovaný význam
 * do operační DB vrstvy. Drive zůstává audit/archive výstup, ne ranní
 * source-of-truth.
 */

type SupabaseClient = any;
import { encodeGovernedWrite } from "./documentWriteEnvelope.ts";
import { gateDriveWriteInsert } from "./documentGovernance.ts";
import { appendPantryB, type PantryBEntryKind, type PantryBSourceKind, type PantryBDestination } from "./pantryB.ts";
import { createHash } from "node:crypto";

type IngestionStatus = "captured" | "classified" | "routed" | "skipped" | "failed" | "duplicate";
type EvidenceLevel =
  | "direct_child_evidence"
  | "therapist_observation_D2"
  | "therapist_factual_correction"
  | "external_fact"
  | "team_decision"
  | "program_change"
  | "task_note"
  | "personal_context_not_for_DID"
  | "hana_personal_did_relevant"
  | "technical_event"
  | "hypothesis"
  | "admin_note"
  | "unknown";

// P21 — Hana/Personal cross-surface DID detection
// Maps free-text part names from Hana threads onto canonical part names.
const HANA_PART_NAME_PATTERNS: Array<{ re: RegExp; canonical: string }> = [
  { re: /\b(?:Tundrupek|Tundrupa|Tundrup\w*)\b/i, canonical: "Tundrupek" },
  { re: /\b(?:Arthur|Artik|Art[ií]k(?:ovi)?|ARTHUR)\b/i, canonical: "Arthur" },
  { re: /\b(?:Gust[ií]k|gustik)\b/i, canonical: "gustik" },
  { re: /\b(?:Timmy|Timmi|Timmiho|velryba|velryby|keporak)\b/i, canonical: "Tundrupek" },
];

// Generic DID-context tokens that, even without a part name, indicate the message
// belongs in the DID operational pipeline (kluci/části/terapie/herna...).
const HANA_DID_CONTEXT_RE = /\b(?:kluci|kluk[uy]|d[eě]ti|DID|[čc][aá]st(?:i)?|terapi[ei]|sezen[ií]|hern[aey]|playroom|switch|disociac)\b/i;

// External-reality emotional load tokens (Timmy/velryba) that may impact kluci.
const HANA_EXTERNAL_REALITY_RE = /\b(?:Timmy|Timmi|Timmiho|velryba|velryby|keporak|transport[uem]?)\b/i;

function detectHanaPart(text: string): string | null {
  for (const { re, canonical } of HANA_PART_NAME_PATTERNS) {
    if (re.test(text)) return canonical;
  }
  return null;
}

function isHanaDidRelevant(text: string): boolean {
  return detectHanaPart(text) !== null || HANA_DID_CONTEXT_RE.test(text);
}

function buildHanaSafeSummary(text: string, part: string | null, externalReality: boolean): string {
  const tags: string[] = [];
  if (part) tags.push(part);
  if (externalReality) tags.push("vnější realita: zátěž zvířete (Timmy/velryba)");
  const head = tags.length ? `Z osobního vlákna Hany — ${tags.join(", ")}: ` : "Z osobního vlákna Hany — DID-relevantní bod: ";
  if (externalReality && (part === "Tundrupek" || /kluci|d[eě]ti/i.test(text))) {
    return `${head}kluci mohou být emočně zatížení tématem velryby Timmy; ověřit tělo, emoci, bezpečí. Bez raw intimního obsahu.`;
  }
  if (part) {
    return `${head}zaznamenat zmínku části ${part} k operativnímu kontextu; ověřit přímou reakcí části, neuzavírat klinický závěr bez D1/D2 evidence.`;
  }
  return `${head}téma DID/kluci se objevilo v osobním vlákně; zařadit do dnešního kontextu, ověřit s částmi.`;
}

export const __p21_internals = {
  detectHanaPart,
  isHanaDidRelevant,
  buildHanaSafeSummary,
  HANA_EXTERNAL_REALITY_RE,
};

const CHILD_CLINICAL_BLOCKED_EVIDENCE = new Set<EvidenceLevel>([
  "therapist_factual_correction",
  "external_fact",
  "technical_event",
  "admin_note",
]);

export interface NormalizedDidEvent {
  user_id: string;
  source_table: string;
  source_kind: PantryBSourceKind;
  source_ref: string;
  source_hash: string;
  source_id?: string | null;
  message_id?: string | null;
  occurred_at: string;
  author_role?: string | null;
  author_name?: string | null;
  source_surface?: string | null;
  raw_excerpt: string;
  privacy_class?: "personal_raw" | "therapeutic_note" | "child_direct" | "team_operational" | "external_fact" | "technical" | null;
  related_part_name?: string | null;
  context_type?: string | null;
  evidence_level?: EvidenceLevel;
  event_kind?: string | null;
}

export interface DidEventClassification {
  entry_kind: PantryBEntryKind | "skip";
  evidence_level: EvidenceLevel;
  clinical_implication: string;
  operational_implication: string;
  recommended_action: string;
  what_not_to_conclude: string;
  action_required: boolean;
  requires_human_review: boolean;
  include_in_daily_briefing: boolean;
  include_in_next_session_plan: boolean;
  include_in_next_playroom_plan: boolean;
  write_to_drive: boolean;
  related_part_name?: string | null;
  urgency: "low" | "normal" | "high" | "crisis";
  clinical_relevance: boolean;
  operational_relevance: boolean;
  skip_reason?: string;
}

export interface IngestionResult {
  source_ref: string;
  status: IngestionStatus;
  log_id?: string;
  pantry_entry_id?: string | null;
  observation_id?: string | null;
  implication_id?: string | null;
  task_id?: string | null;
  drive_package_id?: string | null;
  drive_write_id?: string | null;
  card_proposal_id?: string | null;
  hana_memory_state_id?: string | null;
  hana_memory_did_safe_id?: string | null;
  reason?: string;
}

export interface IngestionSummary {
  processed_count: number;
  routed_to_pantry_count: number;
  observation_count: number;
  implication_count: number;
  task_count: number;
  drive_package_count: number;
  skipped_count: number;
  failed_count: number;
  duplicate_count: number;
  blocked_count: number;
  important_sources: string[];
  blocked_sources: string[];
  missing_sources: string[];
  results: IngestionResult[];
}

export type NormalizedDidEventInput = Omit<NormalizedDidEvent, "source_hash"> & {
  source_hash?: string;
};

export interface RunGlobalDidEventIngestionOptions {
  mode?: "last_24h" | "since_cursor" | "source_test" | "fallback_sweeper";
  sinceISO?: string;
  source_filter?: PantryBSourceKind[];
}

const SUPPORTED_SOURCES = [
  "therapist_task_note",
  "therapist_note",
  "hana_personal_ingestion",
  "did_thread_ingestion",
  "live_session_progress",
  "live_session_reality_override",
  "playroom_progress",
  "briefing_ask_resolution",
  "deliberation_event",
  "crisis_safety_event",
];

function stableHash(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) hash = ((hash << 5) + hash + input.charCodeAt(i)) >>> 0;
  return hash.toString(16).padStart(8, "0");
}

function compactText(value: unknown, max = 1200): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function hasAny(text: string, needles: RegExp[]) {
  return needles.some((re) => re.test(text));
}

function inferPartName(text: string, fallback?: string | null): string | null {
  if (fallback && fallback.trim()) return fallback.trim();
  const hana = detectHanaPart(text);
  if (hana) return hana;
  // P20.2: rozšířeno o Tundrupa, Gust(í|i)k, kluci jako fallback signál
  const match = text.match(/\b(?:Tundrupek|Tundrupa|Timmy|Arthur|Gust(?:í|i)k|Maru(?:š|s)ka|Marianna|Aneta|Eli(?:š|s)ka|Tom(?:á|a)(?:š|s))\b/i);
  return match?.[0] ?? null;
}

export function normalizeEvent(input: NormalizedDidEventInput): NormalizedDidEvent {
  const raw = compactText(input.raw_excerpt, 1600);
  const sourceHash = input.source_hash || stableHash(`${input.source_ref}|${raw}`);
  return {
    ...input,
    raw_excerpt: raw,
    source_hash: sourceHash,
    related_part_name: inferPartName(raw, input.related_part_name),
  };
}

export function classifyDidRelevance(event: NormalizedDidEvent): DidEventClassification {
  const text = event.raw_excerpt.toLowerCase();
  const rawText = event.raw_excerpt;
  const sourceKind = event.source_kind;
  const isChild = event.author_role === "child" || sourceKind === "playroom_progress";
  const isRealityOverride = sourceKind === "live_session_reality_override";
  const isTechnical = (sourceKind === "live_session_progress" || isRealityOverride) && hasAny(text, [/replan|override|paused|stop|zastav/i]);
  const isExternalCurrentEvent = hasAny(text, [/skute\u010dn|skutec|re\u00e1ln|realn|aktu[a\u00e1]ln|zpr[a\u00e1]v|odkaz|url|https?:\/\/|\u010dl[a\u00e1]nek|clanek|telefon[a\u00e1]t|\u0161kola|skola|po\u017e[a\u00e1]r|pozar|v[a\u00e1]lk|\u00fatulek|utulek|zdravotn|nemoc|\u00famrt|umrt|ztr[a\u00e1]t|z[a\u00e1]chran|instituc|extern/i]);
  const isFactualCorrection = isRealityOverride || hasAny(text, [/nepochopil\s+jsi\s+situaci|nen[i\u00ed]\s+to\s+(?:symbol|projekce|fiktivn)|skute\u010dn|skutec|re\u00e1ln|realn|faktick|odkaz|url|extern/i]) || (sourceKind === "hana_personal_ingestion" && isExternalCurrentEvent);
  const isRisk = hasAny(text, [/rizik|kriz|sebepo|ubl[i\u00ed]\u017eit|nebezpe|stop sign[a\u00e1]l|disoci/i]);
  const isTask = hasAny(text, [/\u00fakol|ukol|domluv|za\u0159i\u010f|zarid|follow[- ]?up|ov\u011b\u0159|over|p\u0159ipome\u0148|pripomen/i]);
  const isPlan = hasAny(text, [/pl[a\u00e1]n|program|zm[e\u011b]na|p\u0159\u00ed\u0161t\u011b|priste|sezen[i\u00ed]|herna|blok/i]);
  const isClinicalBase = hasAny(text, [/\u010d\u00e1st|cast|kluci|tundrupek|timmy|arthur|\u00fazkost|uzkost|strach|pl[a\u00e1]\u010d|t\u011blo|telo|afekt|reakc|pot\u0159eb|potreb|bezpe|ztichl|ramen|nechci b\u00fdt s[a\u00e1]m|nechci byt sam/i]);

  // P21 — Hana/Personal cross-surface DID detection
  const isHanaSurface = sourceKind === "hana_personal_ingestion";
  const hanaPart = isHanaSurface ? detectHanaPart(rawText) : null;
  const hanaDidContext = isHanaSurface && HANA_DID_CONTEXT_RE.test(rawText);
  const hanaExternalReality = isHanaSurface && HANA_EXTERNAL_REALITY_RE.test(rawText);
  const isHanaDidRelevantHit = isHanaSurface && (hanaPart !== null || hanaDidContext || hanaExternalReality);

  const isClinical = isClinicalBase || isHanaDidRelevantHit;
  const isAdminOnly = hasAny(text, [/technick|login|tla\u010d[i\u00ed]tko|tlacitko|chyba ui|export|soubor/i]) && !isClinical && !isRisk;

  if (!event.raw_excerpt || event.raw_excerpt.length < 8) {
    return skipped("empty_or_too_short", event);
  }
  if (isAdminOnly) {
    return {
      ...skipped("admin_only_no_did_relevance", event),
      entry_kind: "admin_note",
      evidence_level: "admin_note",
      operational_relevance: true,
    };
  }

  // P21 — Hana/Personal without DID keywords stays as personal_context_not_for_DID (skip)
  if (isHanaSurface && !isHanaDidRelevantHit && !isFactualCorrection && !isRisk && !isTask && !isPlan) {
    return {
      ...skipped("hana_personal_no_did_keywords", event),
      evidence_level: "personal_context_not_for_DID",
    };
  }

  const evidence_level: EvidenceLevel = event.evidence_level ?? (isChild
    ? "direct_child_evidence"
    : isFactualCorrection
      ? "therapist_factual_correction"
      : isTechnical
        ? "technical_event"
        : sourceKind === "deliberation_event"
          ? "team_decision"
          : isHanaDidRelevantHit
            ? "hana_personal_did_relevant"
            : isPlan
              ? "program_change"
              : sourceKind === "therapist_task_note"
                ? "task_note"
                : sourceKind === "therapist_note"
                  ? "therapist_observation_D2"
                  : isClinical
                    ? "hypothesis"
                    : sourceKind === "hana_personal_ingestion"
                      ? "personal_context_not_for_DID"
                      : "unknown");

  const inferredPart = hanaPart ?? event.related_part_name ?? null;

  const entry_kind: PantryBEntryKind = isRisk
    ? "risk"
    : isTask
      ? "followup_need"
      : isPlan || isTechnical
        ? "plan_change"
        : isClinical || isChild
          ? "observation"
          : "conclusion";

  const clinicalAllowed = (isClinical || isChild || isRisk) && !CHILD_CLINICAL_BLOCKED_EVIDENCE.has(evidence_level);
  const clinical_implication = isFactualCorrection
    ? "Faktick\u00fd r\u00e1mec od terapeutky/extern\u00ed informace upravuje pr\u00e1ci v realit\u011b, ale nen\u00ed klinick\u00fdm d\u016fkazem o \u010d\u00e1sti."
    : isHanaDidRelevantHit
      ? buildHanaSafeSummary(rawText, inferredPart, hanaExternalReality)
      : clinicalAllowed
        ? `Z ud\u00e1losti plyne pracovn\u00ed klinick\u00fd sign\u00e1l k ${inferredPart || "\u010d\u00e1sti"}; validitu je nutn\u00e9 dr\u017eet podle zdroje evidence.`
        : "Ud\u00e1lost m\u00e1 hlavn\u011b opera\u010dn\u00ed v\u00fdznam; klinick\u00fd z\u00e1v\u011br nelze bezpe\u010dn\u011b d\u011blat bez p\u0159\u00edm\u00e9 reakce \u010d\u00e1sti.";

  return {
    entry_kind,
    evidence_level,
    clinical_implication,
    operational_implication: isHanaDidRelevantHit
      ? `DID-relevantn\u00ed vstup z osobn\u00edho vl\u00e1kna Hany (${inferredPart || "obecn\u00fd kontext"}); za\u0159adit do dne\u0161n\u00edho briefingu jako bezpe\u010dn\u00e9 shrnut\u00ed bez raw textu.`
      : isPlan || isTask || isTechnical
        ? "Zohlednit v nejbli\u017e\u0161\u00edm pl\u00e1nov\u00e1n\u00ed, briefingu nebo follow-upu."
        : "Za\u0159adit do denn\u00edho kontextu, pokud se potvrd\u00ed relevance pro dne\u0161n\u00ed veden\u00ed.",
    recommended_action: isFactualCorrection
      ? "Dr\u017eet realitu \u2192 emoci \u2192 pot\u0159ebu \u2192 bezpe\u010d\u00ed; zaznamenat vlastn\u00ed slova a reakci \u010d\u00e1sti zvl\u00e1\u0161\u0165."
      : isRisk
        ? "Ozna\u010dit jako rizikov\u00fd sign\u00e1l a vy\u017e\u00e1dat lidskou revizi."
        : isHanaDidRelevantHit
          ? "Pou\u017e\u00edt jako bezpe\u010dn\u00e9 shrnut\u00ed v Karlov\u011b p\u0159ehledu (\u017e\u00e1dn\u00fd raw intimn\u00ed text); ov\u011b\u0159it s \u010d\u00e1stmi p\u0159i nejbli\u017e\u0161\u00ed p\u0159\u00edle\u017eitosti."
          : "Pou\u017e\u00edt jako zpracovan\u00fd vstup v dal\u0161\u00edm Karlov\u011b p\u0159ehledu; neukl\u00e1dat surov\u00fd text mimo p\u016fvodn\u00ed zdroj.",
    what_not_to_conclude: isFactualCorrection
      ? "Neuzav\u00edrat, \u017ee extern\u00ed ud\u00e1lost je projekce nebo diagnostick\u00fd sign\u00e1l bez p\u0159\u00edm\u00e9ho materi\u00e1lu \u010d\u00e1sti."
      : "Ned\u011blat definitivn\u00ed z\u00e1v\u011br bez opakovan\u00e9 nebo p\u0159\u00edm\u00e9 evidence.",
    action_required: isRisk || isTask || isPlan || isTechnical || isFactualCorrection || isHanaDidRelevantHit,
    requires_human_review: isRisk || evidence_level === "hypothesis" || isHanaDidRelevantHit,
    include_in_daily_briefing: isClinical || isRisk || isTask || isPlan || isTechnical || isFactualCorrection || isHanaDidRelevantHit,
    include_in_next_session_plan: isClinical || isRisk || isPlan || isFactualCorrection || isHanaDidRelevantHit,
    include_in_next_playroom_plan: isChild || isFactualCorrection,
    // P27 D1: allow safe summaries from Hana personal ingestion to reach Drive (raw text never leaves origin thread).
    write_to_drive: (sourceKind === "hana_personal_ingestion")
      ? (isHanaDidRelevantHit || isFactualCorrection)
      : (isRisk || isPlan || sourceKind === "briefing_ask_resolution" || sourceKind === "deliberation_event"),
    related_part_name: inferredPart,
    urgency: isRisk ? "crisis" : isTask || isPlan || isTechnical ? "high" : isClinical ? "normal" : "low",
    clinical_relevance: isClinical || isChild || isRisk,
    operational_relevance: isTask || isPlan || isTechnical || isFactualCorrection || isHanaDidRelevantHit || sourceKind === "briefing_ask_resolution",
  };
}

function skipped(reason: string, event: NormalizedDidEvent): DidEventClassification {
  return {
    entry_kind: "skip",
    evidence_level: event.evidence_level ?? "unknown",
    clinical_implication: "",
    operational_implication: "",
    recommended_action: "",
    what_not_to_conclude: "",
    action_required: false,
    requires_human_review: false,
    include_in_daily_briefing: false,
    include_in_next_session_plan: false,
    include_in_next_playroom_plan: false,
    write_to_drive: false,
    related_part_name: event.related_part_name,
    urgency: "low",
    clinical_relevance: false,
    operational_relevance: false,
    skip_reason: reason,
  };
}

export async function dedupeBySourceRefAndHash(sb: SupabaseClient, event: NormalizedDidEvent): Promise<{ duplicate: boolean; logId?: string }> {
  const { data, error } = await sb
    .from("did_event_ingestion_log")
    .select("id,status")
    .eq("user_id", event.user_id)
    .eq("source_ref", event.source_ref)
    .eq("source_hash", event.source_hash)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data?.id ? { duplicate: true, logId: data.id } : { duplicate: false };
}

async function insertLog(sb: SupabaseClient, event: NormalizedDidEvent, classification: DidEventClassification, status: IngestionStatus) {
  const { data, error } = await sb.from("did_event_ingestion_log").insert({
    user_id: event.user_id,
    source_table: event.source_table,
    source_kind: event.source_kind,
    source_ref: event.source_ref,
    source_hash: event.source_hash,
    source_id: event.source_id ?? null,
    message_id: event.message_id ?? null,
    occurred_at: event.occurred_at,
    processed_at: status === "skipped" ? new Date().toISOString() : null,
    processed_by: status === "skipped" ? "did-event-ingestion" : null,
    status,
    classification_json: classification,
    event_kind: classification.entry_kind,
    evidence_level: classification.evidence_level,
    related_part_name: classification.related_part_name ?? event.related_part_name ?? null,
    author_role: event.author_role ?? null,
    author_name: event.author_name ?? null,
    source_surface: event.source_surface ?? null,
    raw_excerpt: event.raw_excerpt,
    clinical_relevance: classification.clinical_relevance,
    operational_relevance: classification.operational_relevance,
  }).select("id").single();
  if (error) throw error;
  return data.id as string;
}

export async function createPantryEntry(sb: SupabaseClient, event: NormalizedDidEvent, classification: DidEventClassification) {
  if (classification.entry_kind === "skip" || !classification.include_in_daily_briefing) return null;
  const destinations = new Set<PantryBDestination>(["briefing_input"]);
  if (classification.action_required || classification.entry_kind === "followup_need" || classification.entry_kind === "task") destinations.add("did_therapist_tasks");
  if (isClinicalBridgeEligible(classification)) destinations.add("did_implications");
  const pantry = await appendPantryB(sb, {
    user_id: event.user_id,
    entry_kind: classification.entry_kind as PantryBEntryKind,
    source_kind: event.source_kind,
    source_ref: event.source_ref,
    summary: buildSummary(event, classification),
    detail: {
      evidence_level: classification.evidence_level,
      clinical_implication: classification.clinical_implication,
      operational_implication: classification.operational_implication,
      recommended_action: classification.recommended_action,
      what_not_to_conclude: classification.what_not_to_conclude,
      action_required: classification.action_required,
      requires_human_review: classification.requires_human_review,
      include_in_next_session_plan: classification.include_in_next_session_plan,
      include_in_next_playroom_plan: classification.include_in_next_playroom_plan,
      source_trace: {
        source_table: event.source_table,
        source_kind: event.source_kind,
        source_id: event.source_id ?? null,
        message_id: event.message_id ?? null,
        source_ref: event.source_ref,
        source_hash: event.source_hash,
      },
      privacy_note: event.source_kind === "hana_personal_ingestion" ? "Raw osobní obsah zůstává pouze v původním vlákně; do spíže jde zpracovaná implikace." : undefined,
    },
    intended_destinations: Array.from(destinations),
    related_part_name: classification.related_part_name ?? undefined,
    related_therapist: event.author_role === "kata" ? "kata" : event.author_role === "hanka" ? "hanka" : undefined,
  });
  return pantry?.id ?? null;
}

function buildSummary(event: NormalizedDidEvent, classification: DidEventClassification): string {
  const part = classification.related_part_name || event.related_part_name;
  const prefix = part ? `${part}: ` : "";
  if (classification.evidence_level === "therapist_factual_correction") {
    return `${prefix}faktick\u00e1 korekce reality m\u00e1 p\u0159ednost p\u0159ed p\u016fvodn\u00edm pl\u00e1nem; dr\u017eet evidence discipline.`.slice(0, 1000);
  }
  // P21 — Hana/Personal: NEVER include raw intimate text in summary
  if (classification.evidence_level === "hana_personal_did_relevant") {
    return (classification.clinical_implication || classification.operational_implication || `${prefix}DID-relevantn\u00ed bod z osobn\u00edho vl\u00e1kna; bez raw textu.`).slice(0, 1000);
  }
  return `${prefix}${classification.operational_implication || classification.clinical_implication || event.raw_excerpt}`.slice(0, 1000);
}

function isClinicalBridgeEligible(classification: DidEventClassification): boolean {
  return classification.clinical_relevance && !CHILD_CLINICAL_BLOCKED_EVIDENCE.has(classification.evidence_level);
}

function observationSourceType(event: NormalizedDidEvent): string {
  if (event.source_kind === "therapist_task_note") return "task_feedback";
  if (event.source_kind === "therapist_note" || event.source_kind === "briefing_ask_resolution") return "therapist_message";
  if (event.source_kind === "playroom_progress") return "part_direct";
  if (event.source_kind === "live_session_progress") return "session";
  if (event.source_kind === "deliberation_event") return "meeting";
  return "thread";
}

function observationEvidenceKind(classification: DidEventClassification): string {
  if (classification.evidence_level === "hypothesis") return "INFERENCE";
  if (classification.entry_kind === "plan_change") return "PLAN";
  if (classification.evidence_level === "unknown") return "UNKNOWN";
  return "FACT";
}

export async function createObservationIfNeeded(sb: SupabaseClient, event: NormalizedDidEvent, classification: DidEventClassification): Promise<{ observationId?: string | null; implicationId?: string | null }> {
  if (!isClinicalBridgeEligible(classification)) return {};
  const fact = `${classification.clinical_implication} Zdroj: ${event.source_ref}`.slice(0, 1200);
  const evidenceMap: Record<string, string> = {
    direct_child_evidence: "D1",
    therapist_observation_D2: "D2",
    hypothesis: "H1",
    unknown: "I1",
  };
  const evidence = evidenceMap[classification.evidence_level] ?? "I1";
  const { data: existing } = await sb.from("did_observations").select("id").eq("source_ref", event.source_ref).limit(1).maybeSingle();
  const observationId = existing?.id ?? (await sb.from("did_observations").insert({
    source_type: observationSourceType(event),
    source_ref: event.source_ref,
    subject_type: classification.related_part_name ? "part" : "system",
    subject_id: classification.related_part_name || "global",
    fact,
    evidence_level: evidence,
    evidence_kind: observationEvidenceKind(classification),
    confidence: evidence === "D1" ? 0.9 : evidence === "D2" ? 0.7 : 0.4,
    time_horizon: classification.urgency === "crisis" ? "hours" : "0_14d",
    status: "active",
    needs_verification: classification.requires_human_review,
  }).select("id").single()).data?.id;

  let implicationId: string | null = null;
  if (observationId && classification.clinical_implication) {
    const { data: existingImp } = await sb.from("did_implications").select("id").eq("observation_id", observationId).limit(1).maybeSingle();
    if (existingImp?.id) implicationId = existingImp.id;
    else {
      const { data: imp } = await sb.from("did_implications").insert({
        observation_id: observationId,
        impact_type: classification.urgency === "crisis" ? "risk" : classification.action_required ? "immediate_plan" : "context_only",
        destinations: [
          classification.include_in_next_session_plan ? "next_session_plan" : "daily_briefing",
          classification.include_in_next_playroom_plan ? "next_playroom_plan" : "briefing_context",
        ],
        implication_text: classification.clinical_implication.slice(0, 1200),
        status: "active",
      }).select("id").single();
      implicationId = imp?.id ?? null;
    }
  }
  return { observationId: observationId ?? null, implicationId };
}

export async function createTaskIfNeeded(sb: SupabaseClient, event: NormalizedDidEvent, classification: DidEventClassification): Promise<string | null> {
  if (!classification.action_required || classification.entry_kind === "risk") return null;
  const marker = `did_event_ingestion:${event.source_ref}:${event.source_hash}`;
  const { data: existing } = await sb.from("did_therapist_tasks").select("id").ilike("note", `%${marker}%`).limit(1).maybeSingle();
  if (existing?.id) return existing.id;
  const assigned = event.author_role === "kata" ? "kata" : event.author_role === "hanka" ? "hanka" : "both";
  const { data, error } = await sb.from("did_therapist_tasks").insert({
    user_id: event.user_id,
    task: classification.recommended_action.slice(0, 500),
    assigned_to: assigned,
    status: "pending",
    priority: classification.urgency === "high" || classification.urgency === "crisis" ? "high" : "normal",
    source: "did_event_ingestion",
    category: classification.entry_kind,
    note: JSON.stringify({ marker, source_ref: event.source_ref, evidence_level: classification.evidence_level, related_part_name: classification.related_part_name ?? null }),
  }).select("id").single();
  if (error) throw error;
  return data?.id ?? null;
}

export async function createDrivePackageIfNeeded(sb: SupabaseClient, event: NormalizedDidEvent, classification: DidEventClassification): Promise<{ packageId?: string | null; writeId?: string | null }> {
  if (!classification.write_to_drive) return {};
  const target = chooseDriveTarget(event, classification);
  if (!target) return {};
  const marker = `did_event_ingestion:${event.source_ref}:${event.source_hash}`;
  const content = `<!-- ${marker} -->\n\n### Zpracovaná událost: ${event.source_kind}\n\n**Evidence:** ${classification.evidence_level}\n**Zdroj:** ${event.source_ref}\n\n${buildSummary(event, classification)}\n\n**Doporučený krok:** ${classification.recommended_action}\n\n**Co neuzavírat:** ${classification.what_not_to_conclude}`;
  const { data: existingPkg } = await sb.from("did_pantry_packages").select("id").eq("source_table", "did_event_ingestion_log").eq("metadata->>source_marker", marker).limit(1).maybeSingle();
  if (existingPkg?.id) return { packageId: existingPkg.id };
  const { data: pkg, error: pkgErr } = await sb.from("did_pantry_packages").insert({
    user_id: event.user_id,
    package_type: "event_ingestion_audit",
    source_id: null,
    source_table: "did_event_ingestion_log",
    content_md: content,
    drive_target_path: target,
    metadata: { source_marker: marker, source_ref: event.source_ref, source_hash: event.source_hash, source_kind: event.source_kind, evidence_level: classification.evidence_level },
    status: "pending_drive",
  }).select("id").single();
  if (pkgErr) throw pkgErr;

  // P29A closeout: gate every did_pending_drive_writes insert through governance.
  const gate = gateDriveWriteInsert({
    target_document: target,
    bezpecne_payload: target === "KARTOTEKA_DID/00_CENTRUM/Bezpecne_DID_poznamky_z_osobniho_vlakna" ? content : undefined,
    bezpecne_therapist: "HANKA",
    bezpecne_part_name: classification.related_part_name || undefined,
  });
  if (!gate.ok) {
    console.warn(`[did-event-ingestion] blocked_by_governance: ${target} (${gate.reason})`);
    return { packageId: pkg?.id ?? null, writeId: null };
  }
  const effectiveTarget = gate.target;
  const governed = encodeGovernedWrite(content, {
    source_type: "did_event_ingestion",
    source_id: event.source_ref,
    content_type: effectiveTarget.startsWith("KARTOTEKA_DID/01_AKTIVNI_FRAGMENTY/")
      ? "card_section_update"
      : effectiveTarget.startsWith("PAMET_KAREL/")
        ? "situational_analysis"
        : "daily_plan",
    subject_type: classification.related_part_name ? "part" : "system",
    subject_id: classification.related_part_name || "global",
    payload_fingerprint: event.source_hash,
  });
  const { data: existingWrite } = await sb.from("did_pending_drive_writes").select("id").eq("target_document", effectiveTarget).ilike("content", `%${marker}%`).limit(1).maybeSingle();
  if (existingWrite?.id) return { packageId: pkg?.id ?? null, writeId: existingWrite.id };
  const { data: write, error: writeErr } = await sb.from("did_pending_drive_writes").insert({
    user_id: event.user_id,
    target_document: effectiveTarget,
    content: governed,
    write_type: "append",
    priority: classification.urgency === "crisis" ? "high" : "normal",
    status: "pending",
  }).select("id").single();
  if (writeErr) throw writeErr;
  await sb.from("did_pantry_packages").update({ metadata: { source_marker: marker, source_ref: event.source_ref, source_hash: event.source_hash, source_kind: event.source_kind, evidence_level: classification.evidence_level, pending_drive_write_id: write?.id ?? null, governance_rerouted: gate.rerouted, bezpecne_route: gate.bezpecne_route ?? null } }).eq("id", pkg.id);
  return { packageId: pkg?.id ?? null, writeId: write?.id ?? null };
}

function chooseDriveTarget(event: NormalizedDidEvent, classification: DidEventClassification): string | null {
  // P29A closeout: 05E/05D/05C session-log targets are NOT in canonical governance.
  if (event.source_kind === "deliberation_event" || event.source_kind === "briefing_ask_resolution") return "KARTOTEKA_DID/00_CENTRUM/05A_OPERATIVNI_PLAN";
  if (event.source_kind === "playroom_progress") return "KARTOTEKA_DID/00_CENTRUM/05A_OPERATIVNI_PLAN";
  if (event.source_kind === "live_session_progress") return "KARTOTEKA_DID/00_CENTRUM/05A_OPERATIVNI_PLAN";
  // Hana personal events: part-specific → KARTA, otherwise canonical Hana SITUACNI_ANALYZA.txt.
  if (event.source_kind === "hana_personal_ingestion") {
    if (classification.related_part_name) {
      return `KARTOTEKA_DID/01_AKTIVNI_FRAGMENTY/KARTA_${classification.related_part_name.toUpperCase()}`;
    }
    return "PAMET_KAREL/DID/HANKA/SITUACNI_ANALYZA.txt";
  }
  if (classification.related_part_name && classification.clinical_relevance && classification.evidence_level !== "therapist_factual_correction") {
    return `KARTOTEKA_DID/01_AKTIVNI_FRAGMENTY/KARTA_${classification.related_part_name.toUpperCase()}`;
  }
  return "KARTOTEKA_DID/00_CENTRUM/05A_OPERATIVNI_PLAN";
}

export async function markIngestionProcessed(sb: SupabaseClient, logId: string, status: IngestionStatus, patch: Record<string, unknown> = {}) {
  await sb.from("did_event_ingestion_log").update({
    status,
    processed_at: new Date().toISOString(),
    processed_by: "did-event-ingestion",
    ...patch,
  }).eq("id", logId);
}

// P27 G1: create pending card_update_queue proposal for safe Hana DID-relevant events.
export async function createCardUpdateProposalIfNeeded(sb: SupabaseClient, event: NormalizedDidEvent, classification: DidEventClassification): Promise<string | null> {
  if (event.source_kind !== "hana_personal_ingestion") return null;
  if (!classification.related_part_name) return null;
  if (!classification.clinical_relevance) return null;
  if (classification.evidence_level === "personal_context_not_for_DID") return null;

  const partId = String(classification.related_part_name);
  const safeSummary = classification.clinical_implication?.slice(0, 1500) || "Bezpečné shrnutí z osobního vlákna Hany; ověřit s částí.";
  const reason = `did_event_ingestion: hana_personal -> ${partId}`;

  // dedupe by (part_id, source_thread_id, section, action)
  const sourceThreadId = event.source_id ?? null;
  const section = "Aktuální citlivosti / vnější zátěž (návrh z Hana/osobní)";
  const { data: existing } = await sb.from("card_update_queue")
    .select("id")
    .eq("part_id", partId)
    .eq("section", section)
    .eq("source_thread_id", sourceThreadId)
    .eq("applied", false)
    .limit(1)
    .maybeSingle();
  if (existing?.id) return existing.id as string;

  const { data, error } = await sb.from("card_update_queue").insert({
    user_id: event.user_id,
    part_id: partId,
    section,
    subsection: "",
    action: "add",
    new_content: safeSummary,
    reason,
    source_thread_id: sourceThreadId,
    source_date: event.occurred_at?.slice(0, 10) ?? null,
    priority: 4,
    applied: false,
    status: "pending_therapist_confirmation",
    source: "hana_personal_ingestion",
    payload: {
      source_ref: event.source_ref,
      source_hash: event.source_hash,
      message_id: event.message_id ?? null,
      evidence_level: classification.evidence_level,
      what_not_to_conclude: classification.what_not_to_conclude,
      recommended_action: classification.recommended_action,
      requires_therapist_confirmation: true,
    },
  }).select("id").single();
  if (error) {
    console.error("[did-event-ingestion] card_update_queue insert failed", error);
    return null;
  }
  return data?.id ?? null;
}

// P27 F1/J1: capture Hana persistent memory (emotional state + next opening hint).
export async function upsertHanaPersonalMemoryIfNeeded(sb: SupabaseClient, event: NormalizedDidEvent, classification: DidEventClassification): Promise<{ stateId?: string | null; didSafeId?: string | null }> {
  if (event.source_kind !== "hana_personal_ingestion") return {};
  // Only emit memory for substantive events (DID-relevant, factual correction, risk, plan, task).
  const substantive = classification.clinical_relevance || classification.evidence_level === "therapist_factual_correction" || classification.entry_kind === "risk" || classification.entry_kind === "plan_change" || classification.entry_kind === "followup_need";
  if (!substantive) return {};

  const sourceThreadId = event.source_id;
  if (!sourceThreadId) return {};

  const safeSummary = (classification.clinical_implication || "Bezpečné shrnutí z osobního vlákna Hany.").slice(0, 1500);
  const part = classification.related_part_name ?? null;
  const nextOpening = part
    ? `Haničko, ve včerejším osobním rozhovoru se objevilo téma kolem části ${part}. Nechci to přejít, jako by to nebylo. Jak ti s tím dnes je?`
    : `Haničko, včera večer jsi mi nesla něco důležitého z osobního prostoru. Nechci začít neutrálně. Jak ti je dnes?`;

  // P28 A+B.2 HANA_MEMORY-B1: idempotent writer against partial unique index uq_hana_memory_dedupe_active.
  // dedupe_key MUST match the formula used in the migration backfill:
  //   md5(source_thread_id || '|' || memory_type || '|' || lower(squash_ws(next_opening_hint)))
  const messageRef = event.message_id ? `${sourceThreadId}:${event.message_id}` : `${sourceThreadId}:${event.source_hash}`;
  const computeDedupeKey = (memory_type: string): string => {
    const norm = (nextOpening || "").toLowerCase().replace(/\s+/g, " ");
    const raw = `${sourceThreadId}|${memory_type}|${norm}`;
    return createHash("md5").update(raw).digest("hex");
  };

  const semanticKey = (memory_type: string) => `${memory_type}:${(classification.urgency || "_unspecified").toLowerCase()}`;

  const insertRow = async (memory_type: string, did_relevant: boolean, private_to_hana: boolean) => {
    const dedupeKey = computeDedupeKey(memory_type);

    // 1) Try to find existing active row for this (user, thread, memory_type, dedupe_key).
    const { data: existingActive } = await sb.from("hana_personal_memory")
      .select("id")
      .eq("user_id", event.user_id)
      .eq("source_thread_id", sourceThreadId)
      .eq("memory_type", memory_type)
      .eq("dedupe_key", dedupeKey)
      .eq("pipeline_state", "active")
      .limit(1)
      .maybeSingle();
    if (existingActive?.id) return existingActive.id as string;

    // 2) Fallback: same message_ref already recorded (legacy rows without dedupe_key).
    const { data: existingByMsg } = await sb.from("hana_personal_memory")
      .select("id")
      .eq("source_thread_id", sourceThreadId)
      .eq("memory_type", memory_type)
      .contains("source_message_refs", [messageRef])
      .limit(1)
      .maybeSingle();
    if (existingByMsg?.id) return existingByMsg.id as string;

    // 3) Insert; if the partial unique index fires (23505), recover by selecting the active row.
    const { data, error } = await sb.from("hana_personal_memory").insert({
      user_id: event.user_id,
      source_thread_id: sourceThreadId,
      source_message_refs: [messageRef],
      memory_type,
      emotional_state: classification.urgency,
      safe_summary: safeSummary,
      next_opening_hint: nextOpening,
      do_not_export_raw_text: true,
      did_relevant,
      private_to_hana,
      dedupe_key: dedupeKey,
      semantic_dedupe_key: semanticKey(memory_type),
      pipeline_state: "active",
      retention_state: "active",
    }).select("id").single();
    if (!error) return data?.id ?? null;

    if ((error as any)?.code === "23505") {
      const { data: retry } = await sb.from("hana_personal_memory")
        .select("id")
        .eq("user_id", event.user_id)
        .eq("source_thread_id", sourceThreadId)
        .eq("memory_type", memory_type)
        .eq("dedupe_key", dedupeKey)
        .eq("pipeline_state", "active")
        .limit(1)
        .maybeSingle();
      return retry?.id ?? null;
    }

    console.error("[did-event-ingestion] hana_personal_memory insert failed", error);
    return null;
  };

  const stateId = await insertRow("hana_emotional_state", false, true);
  const didSafeId = classification.clinical_relevance ? await insertRow("hana_to_did_safe_summary", true, true) : null;
  return { stateId, didSafeId };
}

export async function routeEvent(sb: SupabaseClient, eventInput: NormalizedDidEventInput): Promise<IngestionResult> {
  const event = normalizeEvent(eventInput);
  const dedupe = await dedupeBySourceRefAndHash(sb, event);
  if (dedupe.duplicate) return { source_ref: event.source_ref, status: "duplicate", log_id: dedupe.logId, reason: "source_ref_source_hash_seen" };
  const classification = classifyDidRelevance(event);
  const logId = await insertLog(sb, event, classification, classification.entry_kind === "skip" ? "skipped" : "classified");
  if (classification.entry_kind === "skip") return { source_ref: event.source_ref, status: "skipped", log_id: logId, reason: classification.skip_reason };
  try {
    const pantryEntryId = await createPantryEntry(sb, event, classification);
    const observation = await createObservationIfNeeded(sb, event, classification);
    const taskId = await createTaskIfNeeded(sb, event, classification);
    const drive = await createDrivePackageIfNeeded(sb, event, classification);
    const cardProposalId = await createCardUpdateProposalIfNeeded(sb, event, classification);
    const hanaMem = await upsertHanaPersonalMemoryIfNeeded(sb, event, classification);
    await markIngestionProcessed(sb, logId, "routed", {
      pantry_entry_id: pantryEntryId,
      observation_id: observation.observationId ?? null,
      task_id: taskId,
      drive_package_id: drive.packageId ?? null,
      drive_write_id: drive.writeId ?? null,
    });
    return { source_ref: event.source_ref, status: "routed", log_id: logId, pantry_entry_id: pantryEntryId, observation_id: observation.observationId ?? null, implication_id: observation.implicationId ?? null, task_id: taskId, drive_package_id: drive.packageId ?? null, drive_write_id: drive.writeId ?? null, card_proposal_id: cardProposalId, hana_memory_state_id: hanaMem.stateId ?? null, hana_memory_did_safe_id: hanaMem.didSafeId ?? null } as IngestionResult;
  } catch (e) {
    await markIngestionProcessed(sb, logId, "failed", { error_message: String((e as Error)?.message ?? e).slice(0, 1000) });
    return { source_ref: event.source_ref, status: "failed", log_id: logId, reason: String((e as Error)?.message ?? e) };
  }
}

export async function runGlobalDidEventIngestion(sb: SupabaseClient, userId: string, sinceISOOrOptions: string | RunGlobalDidEventIngestionOptions = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()): Promise<IngestionSummary> {
  const options: RunGlobalDidEventIngestionOptions = typeof sinceISOOrOptions === "string" ? { sinceISO: sinceISOOrOptions } : sinceISOOrOptions;
  const sourceFilter = new Set<PantryBSourceKind>(options.source_filter ?? []);
  const wants = (source: PantryBSourceKind) => sourceFilter.size === 0 || sourceFilter.has(source);
  const sinceISO = options.sinceISO || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const events: NormalizedDidEventInput[] = [];
  const blockedSources: string[] = [];
  if (wants("therapist_task_note")) await collectTherapistTaskNotes(sb, userId, sinceISO, events);
  if (wants("therapist_note")) blockedSources.push("therapist_notes:not_supported_yet_missing_user_scope");
  if (wants("hana_personal_ingestion")) await collectHanaPersonal(sb, userId, sinceISO, events);
  if (wants("did_thread_ingestion") || wants("playroom_progress")) await collectDidThreads(sb, userId, sinceISO, events);
  if (wants("live_session_progress") || wants("live_session_reality_override")) await collectLiveProgress(sb, userId, sinceISO, events);
  if (wants("briefing_ask_resolution")) await collectBriefingAskResolutions(sb, userId, sinceISO, events);
  if (wants("deliberation_event")) await collectDeliberations(sb, userId, sinceISO, events);
  if (wants("crisis_safety_event")) blockedSources.push("crisis_safety_tables:not_supported_yet_missing_user_scope");

  const summary: IngestionSummary = { processed_count: 0, routed_to_pantry_count: 0, observation_count: 0, implication_count: 0, task_count: 0, drive_package_count: 0, skipped_count: 0, failed_count: 0, duplicate_count: 0, blocked_count: 0, important_sources: [], blocked_sources: [], missing_sources: [], results: [] };
  for (const event of events) {
    const result = await routeEvent(sb, event);
    summary.results.push(result);
    if (result.status === "routed") summary.processed_count++;
    if (result.status === "skipped") summary.skipped_count++;
    if (result.status === "failed") summary.failed_count++;
    if (result.status === "duplicate") summary.duplicate_count++;
    if (result.pantry_entry_id) summary.routed_to_pantry_count++;
    if (result.observation_id) summary.observation_count++;
    if (result.implication_id) summary.implication_count++;
    if (result.task_id) summary.task_count++;
    if (result.drive_package_id) summary.drive_package_count++;
  }
  const seen = new Set(events.map((e) => e.source_kind));
  summary.important_sources = Array.from(seen);
  const expectedSources = sourceFilter.size ? Array.from(sourceFilter) : SUPPORTED_SOURCES;
  summary.missing_sources = expectedSources.filter((s) => !seen.has(s as PantryBSourceKind));
  summary.blocked_sources = [...blockedSources, ...summary.results.filter((r) => r.status === "failed").map((r) => r.source_ref)].slice(0, 20);
  summary.blocked_count = summary.blocked_sources.length;
  await upsertCursor(sb, userId, "global_did_event_ingestion", sinceISO, summary.results.at(-1)?.source_ref ?? null);
  return summary;
}

async function collectTherapistTaskNotes(sb: SupabaseClient, userId: string, sinceISO: string, out: any[]) {
  const { data } = await sb.from("did_therapist_tasks").select("id, user_id, task, completed_note, note, assigned_to, updated_at, created_at").eq("user_id", userId).gte("updated_at", sinceISO).not("completed_note", "is", null).limit(50);
  for (const row of data ?? []) {
    const text = compactText((row as any).completed_note, 1200);
    if (!text) continue;
    out.push({ user_id: (row as any).user_id || userId, source_table: "did_therapist_tasks", source_kind: "therapist_task_note", source_ref: `did_therapist_tasks:${(row as any).id}:completed_note`, source_id: (row as any).id, occurred_at: (row as any).updated_at || (row as any).created_at, author_role: (row as any).assigned_to, author_name: (row as any).assigned_to, source_surface: "task_board", raw_excerpt: text, context_type: "task_completed_note" });
  }
}

async function collectTherapistNotes(sb: SupabaseClient, userId: string, sinceISO: string, out: any[]) {
  console.warn("[did-event-ingestion] therapist_notes adapter blocked: table has no user_id/safe scope", { userId, sinceISO });
  return;
  const { data } = await sb.from("therapist_notes").select("id, author, note_text, note_type, part_name, priority, created_at").eq("user_id", userId).gte("created_at", sinceISO).limit(80);
  for (const row of data ?? []) {
    const text = compactText((row as any).note_text, 1200);
    if (!text) continue;
    const author = String((row as any).author ?? "").toLowerCase();
    out.push({ user_id: userId, source_table: "therapist_notes", source_kind: "therapist_note", source_ref: `therapist_notes:${(row as any).id}`, source_id: (row as any).id, occurred_at: (row as any).created_at, author_role: author.includes("kat") ? "kata" : "hanka", author_name: (row as any).author, source_surface: "therapist_notes", raw_excerpt: text, related_part_name: (row as any).part_name, context_type: (row as any).note_type });
  }
}

async function collectHanaPersonal(sb: SupabaseClient, userId: string, sinceISO: string, out: any[]) {
  const { data } = await sb.from("karel_hana_conversations").select("id, user_id, messages, sub_mode, thread_label, current_domain, last_activity_at").eq("user_id", userId).gte("last_activity_at", sinceISO).limit(20);
  for (const thread of data ?? []) {
    const messages = Array.isArray((thread as any).messages) ? (thread as any).messages : [];
    // P21 — scan ALL user messages in the thread (no -12 tail slice). Index is the
    // ORIGINAL position so source_ref stays stable and matches real order.
    for (let idx = 0; idx < messages.length; idx++) {
      const m = messages[idx];
      if (String(m?.role ?? "") !== "user") continue;
      const text = compactText(m?.content, 1000);
      if (!text) continue;
      out.push({ user_id: userId, source_table: "karel_hana_conversations", source_kind: "hana_personal_ingestion", source_ref: `karel_hana_conversations:${(thread as any).id}:message:${m?.id ?? idx}`, source_id: (thread as any).id, message_id: m?.id ?? String(idx), occurred_at: m?.timestamp || (thread as any).last_activity_at, author_role: "hanka", author_name: "Hanička", source_surface: "Hana/Osobní", raw_excerpt: text, context_type: (thread as any).current_domain || (thread as any).sub_mode });
    }
  }
}

async function collectDidThreads(sb: SupabaseClient, userId: string, sinceISO: string, out: any[]) {
  const { data } = await sb.from("did_threads").select("id, user_id, messages, sub_mode, part_name, workspace_type, workspace_id, last_activity_at").eq("user_id", userId).gte("last_activity_at", sinceISO).limit(60);
  for (const thread of data ?? []) {
    const messages = Array.isArray((thread as any).messages) ? (thread as any).messages : [];
    const sourceKind = (thread as any).workspace_type === "playroom" || (thread as any).sub_mode === "karel_part_session" ? "playroom_progress" : "did_thread_ingestion";
    for (const [idx, m] of messages.slice(-12).entries()) {
      const role = String(m?.role ?? "");
      if (!role || role === "assistant") continue;
      const text = compactText(m?.content, 1000);
      if (!text) continue;
      out.push({ user_id: userId, source_table: "did_threads", source_kind: sourceKind, source_ref: `did_threads:${(thread as any).id}:message:${m?.id ?? idx}`, source_id: (thread as any).id, message_id: m?.id ?? String(idx), occurred_at: m?.timestamp || (thread as any).last_activity_at, author_role: role === "user" && sourceKind === "playroom_progress" ? "child" : role, source_surface: `${(thread as any).workspace_type || "did_thread"}/${(thread as any).sub_mode || "unknown"}`, raw_excerpt: text, related_part_name: (thread as any).part_name, context_type: (thread as any).workspace_type || (thread as any).sub_mode });
    }
  }
}

async function collectLiveProgress(sb: SupabaseClient, userId: string, sinceISO: string, out: any[]) {
  const { data } = await sb.from("did_live_session_progress").select("id, plan_id, part_name, therapist, items, turns_by_block, artifacts_by_block, current_block_status, live_replan_patch, reality_verification, updated_at, last_activity_at").eq("user_id", userId).gte("updated_at", sinceISO).limit(40);
  for (const row of data ?? []) {
    const bits = [
      compactText((row as any).current_block_status, 200),
      compactText(JSON.stringify((row as any).live_replan_patch ?? {}), 700),
      compactText(JSON.stringify((row as any).reality_verification ?? {}), 500),
      compactText(JSON.stringify((row as any).items ?? []), 700),
    ].filter(Boolean).join(" | ");
    if (!bits) continue;
    out.push({ user_id: userId, source_table: "did_live_session_progress", source_kind: (row as any).live_replan_patch && Object.keys((row as any).live_replan_patch || {}).length ? "live_session_reality_override" : "live_session_progress", source_ref: `did_live_session_progress:${(row as any).id}:${stableHash(bits)}`, source_id: (row as any).id, occurred_at: (row as any).last_activity_at || (row as any).updated_at, author_role: (row as any).therapist, author_name: (row as any).therapist, source_surface: "live_session_progress", raw_excerpt: bits, related_part_name: (row as any).part_name, context_type: "live_progress" });
  }
}

async function collectBriefingAskResolutions(sb: SupabaseClient, userId: string, sinceISO: string, out: any[]) {
  const { data } = await sb.from("briefing_ask_resolutions").select("id, ask_id, therapist_response, assignee, target_part_name, resolution_mode, resolution_status, evidence_level, updated_at, created_at").eq("user_id", userId).gte("updated_at", sinceISO).limit(40);
  for (const row of data ?? []) {
    const text = compactText((row as any).therapist_response || (row as any).resolution_mode, 1000);
    if (!text) continue;
    out.push({ user_id: userId, source_table: "briefing_ask_resolutions", source_kind: "briefing_ask_resolution", source_ref: `briefing_ask_resolutions:${(row as any).id}`, source_id: (row as any).id, message_id: (row as any).ask_id, occurred_at: (row as any).updated_at || (row as any).created_at, author_role: (row as any).assignee, author_name: (row as any).assignee, source_surface: "daily_briefing_ask", raw_excerpt: text, related_part_name: (row as any).target_part_name, evidence_level: (row as any).evidence_level || "therapist_observation_D2", context_type: (row as any).resolution_status });
  }
}

async function collectDeliberations(sb: SupabaseClient, userId: string, sinceISO: string, out: any[]) {
  const { data } = await sb.from("did_team_deliberations").select("id, title, deliberation_type, status, final_summary, discussion_log, program_draft, subject_parts, updated_at").eq("user_id", userId).gte("updated_at", sinceISO).limit(30);
  for (const row of data ?? []) {
    const text = compactText(`${(row as any).title}\n${(row as any).final_summary ?? ""}\n${JSON.stringify((row as any).program_draft ?? [])}`, 1400);
    if (!text) continue;
    out.push({ user_id: userId, source_table: "did_team_deliberations", source_kind: "deliberation_event", source_ref: `did_team_deliberations:${(row as any).id}:${(row as any).status}`, source_id: (row as any).id, occurred_at: (row as any).updated_at, author_role: "team", author_name: "tým", source_surface: "team_deliberation", raw_excerpt: text, related_part_name: Array.isArray((row as any).subject_parts) ? (row as any).subject_parts[0] : null, context_type: (row as any).deliberation_type });
  }
}

async function collectCrisisSafety(sb: SupabaseClient, userId: string, sinceISO: string, out: any[]) {
  console.warn("[did-event-ingestion] crisis/safety adapter blocked: source tables have no user_id/safe scope", { userId, sinceISO });
  return;
  const crisisSources = [
    { table: "crisis_events", textCols: ["part_name", "trigger_description", "clinical_summary", "phase"], dateCol: "updated_at" },
    { table: "crisis_alerts", textCols: ["part_name", "summary", "severity", "karel_assessment"], dateCol: "created_at" },
    { table: "safety_alerts", textCols: ["part_name", "summary", "severity", "status"], dateCol: "created_at" },
    { table: "crisis_daily_assessments", textCols: ["part_name", "karel_decision", "therapist_hana_observation", "therapist_kata_observation"], dateCol: "created_at" },
  ];
  for (const src of crisisSources) {
    try {
      const { data } = await sb.from(src.table).select("id,user_id,part_name,trigger_description,clinical_summary,phase,summary,severity,karel_assessment,status,karel_decision,therapist_hana_observation,therapist_kata_observation,created_at,updated_at").eq("user_id", userId).gte(src.dateCol, sinceISO).limit(20);
      for (const row of data ?? []) {
        const text = compactText(src.textCols.map((c) => (row as any)[c]).filter(Boolean).join(" | "), 1200);
        if (!text) continue;
        out.push({ user_id: (row as any).user_id || userId, source_table: src.table, source_kind: "crisis_safety_event", source_ref: `${src.table}:${(row as any).id}`, source_id: (row as any).id, occurred_at: (row as any)[src.dateCol] || new Date().toISOString(), author_role: "karel", source_surface: "crisis_safety", raw_excerpt: text, related_part_name: (row as any).part_name, context_type: src.table });
      }
    } catch (e) {
      console.warn(`[did-event-ingestion] ${src.table} not supported yet:`, e);
    }
  }
}

async function upsertCursor(sb: SupabaseClient, userId: string, sourceName: string, lastProcessedAt: string, lastProcessedId: string | null) {
  await sb.from("did_event_ingestion_cursors").upsert({
    user_id: userId,
    source_name: sourceName,
    last_processed_at: lastProcessedAt,
    last_processed_id: lastProcessedId,
    updated_at: new Date().toISOString(),
  }, { onConflict: "user_id,source_name" });
}
