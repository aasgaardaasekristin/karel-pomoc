/**
 * Document Governance Layer — centrální routing pro všechny zápisy do Drive dokumentů.
 *
 * Každý zápis musí projít přes tuto vrstvu, která:
 * 1. Rozhodne cílový dokument na základě content_type
 * 2. Určí write_type (append / replace)
 * 3. Loguje do did_doc_sync_log
 *
 * DOKUMENTOVÉ VRSTVY:
 *   A. KARTA_CASTI     — dlouhodobá klinická pravda o části
 *   B. 05A             — denní operativní plán
 *   C. 05B             — střednědobý operační výhled (2–8 týdnů)
 *   D. 05C             — dlouhodobá integrační trajektorie
 *   E. DASHBOARD       — vývěska dne (jen dnešní stav)
 *   F. PAMET_KAREL     — soukromá interní paměť (NESMÍ do UI)
 */

// ── Content Types ──

export type ContentType =
  | "profile_claim"
  | "session_result"
  | "post_session_analysis"
  | "closure_summary"
  | "closure_chronology"
  | "closure_analysis"
  | "closure_recommendations"
  | "daily_plan"
  | "next_day_plan"
  | "therapist_memory_note"
  | "situational_analysis"
  | "strategic_outlook"
  | "long_term_trajectory"
  | "dashboard_status"
  | "crisis_context"
  | "session_log"
  | "card_section_update"
  | "pattern_observation"
  | "test_result";

export type DocumentLayer =
  | "KARTA_CASTI"
  | "05A"
  | "05B"
  | "05C"
  | "DASHBOARD"
  | "PAMET_KAREL";

export type WriteType = "append" | "replace";

export type SubjectType = "part" | "system" | "therapist" | "crisis";

// ── Governance routing map ──

interface RouteResult {
  layer: DocumentLayer;
  /** Drive target path for drive-queue-processor */
  driveTarget: string;
  writeType: WriteType;
  /** Target section letter for KARTA_CASTI writes */
  cardSection?: string;
}

/**
 * Content type → document layer routing.
 * This is the SINGLE SOURCE OF TRUTH for where content goes.
 */
const ROUTING_TABLE: Record<ContentType, (subjectId?: string) => RouteResult> = {
  // ── KARTA_CASTI targets ──
  profile_claim: (partName) => ({
    layer: "KARTA_CASTI",
    driveTarget: `KARTA_${(partName || "UNKNOWN").toUpperCase()}`,
    writeType: "append",
    cardSection: "B",
  }),
  session_result: (partName) => ({
    layer: "KARTA_CASTI",
    driveTarget: `KARTA_${(partName || "UNKNOWN").toUpperCase()}`,
    writeType: "append",
    cardSection: "K",
  }),
  post_session_analysis: (partName) => ({
    layer: "KARTA_CASTI",
    driveTarget: `KARTA_${(partName || "UNKNOWN").toUpperCase()}`,
    writeType: "append",
    cardSection: "G",
  }),
  session_log: (partName) => ({
    layer: "KARTA_CASTI",
    driveTarget: `KARTA_${(partName || "UNKNOWN").toUpperCase()}`,
    writeType: "append",
    cardSection: "E",
  }),
  closure_chronology: (partName) => ({
    layer: "KARTA_CASTI",
    driveTarget: `KARTA_${(partName || "UNKNOWN").toUpperCase()}`,
    writeType: "append",
    cardSection: "E",
  }),
  closure_analysis: (partName) => ({
    layer: "KARTA_CASTI",
    driveTarget: `KARTA_${(partName || "UNKNOWN").toUpperCase()}`,
    writeType: "append",
    cardSection: "M",
  }),
  closure_recommendations: (partName) => ({
    layer: "KARTA_CASTI",
    driveTarget: `KARTA_${(partName || "UNKNOWN").toUpperCase()}`,
    writeType: "append",
    cardSection: "D",
  }),
  closure_summary: (partName) => ({
    layer: "KARTA_CASTI",
    driveTarget: `KARTA_${(partName || "UNKNOWN").toUpperCase()}`,
    writeType: "append",
    cardSection: "E", // primary = chronology
  }),
  card_section_update: (partName) => ({
    layer: "KARTA_CASTI",
    driveTarget: `KARTA_${(partName || "UNKNOWN").toUpperCase()}`,
    writeType: "append",
  }),
  test_result: (partName) => ({
    layer: "KARTA_CASTI",
    driveTarget: `KARTA_${(partName || "UNKNOWN").toUpperCase()}`,
    writeType: "append",
    cardSection: "K",
  }),
  pattern_observation: (partName) => ({
    layer: "KARTA_CASTI",
    driveTarget: `KARTA_${(partName || "UNKNOWN").toUpperCase()}`,
    writeType: "append",
    cardSection: "L",
  }),

  // ── 05A — denní operativa ──
  daily_plan: () => ({
    layer: "05A",
    driveTarget: "KARTOTEKA_DID/00_CENTRUM/05A_OPERATIVNI_PLAN",
    writeType: "replace",
  }),
  next_day_plan: () => ({
    layer: "05A",
    driveTarget: "KARTOTEKA_DID/00_CENTRUM/05A_OPERATIVNI_PLAN",
    writeType: "replace",
  }),
  crisis_context: () => ({
    layer: "05A",
    driveTarget: "KARTOTEKA_DID/00_CENTRUM/05A_OPERATIVNI_PLAN",
    writeType: "replace",
  }),

  // ── 05B — střednědobý výhled ──
  strategic_outlook: () => ({
    layer: "05B",
    driveTarget: "KARTOTEKA_DID/00_CENTRUM/05B_STRATEGICKY_VYHLED",
    writeType: "replace",
  }),

  // ── 05C — dlouhodobá trajektorie ──
  long_term_trajectory: () => ({
    layer: "05C",
    driveTarget: "KARTOTEKA_DID/00_CENTRUM/05C_DLOUHODOBA_INTEGRACNI_TRAJEKTORIE",
    writeType: "replace",
  }),

  // ── DASHBOARD ──
  dashboard_status: () => ({
    layer: "DASHBOARD",
    driveTarget: "KARTOTEKA_DID/00_CENTRUM/DASHBOARD",
    writeType: "replace",
  }),

  // ── PAMET_KAREL ──
  therapist_memory_note: (therapistPath) => ({
    layer: "PAMET_KAREL",
    driveTarget: `PAMET_KAREL/${therapistPath || "DID/KONTEXTY/KDO_JE_KDO"}`,
    writeType: "append",
  }),
  situational_analysis: (therapistPath) => ({
    layer: "PAMET_KAREL",
    driveTarget: `PAMET_KAREL/${therapistPath || "DID/KONTEXTY/KDO_JE_KDO"}`,
    writeType: "append",
  }),
};

// ── Public API ──

export interface GovernanceRequest {
  source_type: string;
  source_id: string;
  content_type: ContentType;
  subject_type: SubjectType;
  subject_id: string;
  payload: string;
  /** Override for PAMET_KAREL sub-path or other custom routing */
  target_hint?: string;
}

export interface GovernanceResult {
  layer: DocumentLayer;
  driveTarget: string;
  writeType: WriteType;
  cardSection?: string;
  payload: string;
}

/**
 * Route a write request to the correct document layer.
 * Returns the resolved target — caller is responsible for actual write.
 */
export function routeWrite(req: GovernanceRequest): GovernanceResult {
  const routeFn = ROUTING_TABLE[req.content_type];
  if (!routeFn) {
    throw new Error(`[governance] Unknown content_type: ${req.content_type}`);
  }

  const subjectOrHint = req.target_hint || req.subject_id;
  const route = routeFn(subjectOrHint);

  return {
    ...route,
    payload: req.payload,
  };
}

/**
 * Build audit log entry for did_doc_sync_log.
 */
export function buildAuditEntry(
  req: GovernanceRequest,
  result: GovernanceResult,
  success: boolean,
  errorMessage?: string,
) {
  return {
    source_type: req.source_type,
    source_id: req.source_id,
    target_document: result.driveTarget,
    content_type: req.content_type,
    subject_type: req.subject_type,
    subject_id: req.subject_id,
    sync_type: `${result.layer}_${result.writeType}`,
    content_written: req.payload.slice(0, 500),
    success,
    status: success ? "ok" : "failed",
    error_message: errorMessage || null,
  };
}

/**
 * Validate that a drive target is allowed by governance.
 * Used by drive-queue-processor to enforce whitelist.
 */
export function isGovernedTarget(target: string): boolean {
  // All KARTA_ targets
  if (/^KARTA_.+$/.test(target)) return true;

  // KARTOTEKA_DID/00_CENTRUM documents
  const centrumDocs = [
    "KARTOTEKA_DID/00_CENTRUM/05A_OPERATIVNI_PLAN",
    "KARTOTEKA_DID/00_CENTRUM/05B_STRATEGICKY_VYHLED",
    "KARTOTEKA_DID/00_CENTRUM/05C_DLOUHODOBA_INTEGRACNI_TRAJEKTORIE",
    "KARTOTEKA_DID/00_CENTRUM/DASHBOARD",
  ];
  if (centrumDocs.includes(target)) return true;

  // PAMET_KAREL whitelisted paths
  const pametAllowed = [
    /^PAMET_KAREL\/DID\/HANKA\//,
    /^PAMET_KAREL\/DID\/KATA\//,
    /^PAMET_KAREL\/DID\/KONTEXTY\//,
  ];
  if (pametAllowed.some((rx) => rx.test(target))) return true;

  return false;
}

/**
 * Targets where full replace (overwrite) is permitted.
 * All others are append-only for safety.
 */
export const REPLACE_ALLOWED_TARGETS = new Set([
  "PAMET_KAREL/DID/HANKA/VLAKNA_3DNY",
  "PAMET_KAREL/DID/KATA/VLAKNA_3DNY",
  "KARTOTEKA_DID/00_CENTRUM/05A_OPERATIVNI_PLAN",
  "KARTOTEKA_DID/00_CENTRUM/05B_STRATEGICKY_VYHLED",
  "KARTOTEKA_DID/00_CENTRUM/05C_DLOUHODOBA_INTEGRACNI_TRAJEKTORIE",
  "KARTOTEKA_DID/00_CENTRUM/DASHBOARD",
]);
