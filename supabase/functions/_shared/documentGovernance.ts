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
  | "playroom_detail_analysis"
  | "playroom_practical_report"
  | "playroom_log"
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
  | "team_decision_log"
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
  playroom_detail_analysis: (partName) => ({
    layer: "KARTA_CASTI",
    driveTarget: `KARTA_${(partName || "UNKNOWN").toUpperCase()}`,
    writeType: "append",
    cardSection: "K",
  }),
  playroom_practical_report: (partName) => ({
    layer: "KARTA_CASTI",
    driveTarget: `KARTA_${(partName || "UNKNOWN").toUpperCase()}`,
    writeType: "append",
    cardSection: "D",
  }),
  playroom_log: () => ({
    layer: "05A",
    driveTarget: "KARTOTEKA_DID/00_CENTRUM/05D_HERNY_LOG",
    writeType: "append",
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
  // P29A: 05E_TEAM_DECISIONS_LOG is NOT in canonical governance.
  // Team decisions are appended to 05A under "Rozhodnutí týmu / denní audit změn" section.
  team_decision_log: () => ({
    layer: "05A",
    driveTarget: "KARTOTEKA_DID/00_CENTRUM/05A_OPERATIVNI_PLAN",
    writeType: "append",
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

// P29A: Legacy PAMET_KAREL_ALLOWED_TARGETS and STATIC_REPLACE_ALLOWED_TARGETS
// have been replaced by CANONICAL_DRIVE_REGISTRY and STATIC_REPLACE_TARGETS_BASE
// defined below. They are the single source of truth for governance.

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

  if (req.source_type === "update-part-profile" && req.content_type === "profile_claim") {
    return {
      layer: "KARTA_CASTI",
      driveTarget: `KARTA_${(subjectOrHint || "UNKNOWN").toUpperCase()}`,
      writeType: "replace",
      payload: req.payload,
    };
  }

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
  success: boolean | null,
  errorMessage?: string,
  status?: string,
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
    status: status || (success === true ? "ok" : success === false ? "failed" : "pending"),
    error_message: errorMessage || null,
  };
}

/**
 * P29A: Canonical Drive target registry — fail-closed.
 * Single source of truth.
 */
export const CANONICAL_DRIVE_REGISTRY: ReadonlySet<string> = new Set([
  "KARTOTEKA_DID/00_CENTRUM/01_INDEX",
  "KARTOTEKA_DID/00_CENTRUM/03_VNITRNI_SVET",
  "KARTOTEKA_DID/00_CENTRUM/04_MAPA_VZTAHU",
  "KARTOTEKA_DID/00_CENTRUM/05A_OPERATIVNI_PLAN",
  "KARTOTEKA_DID/00_CENTRUM/05B_STRATEGICKY_VYHLED",
  "KARTOTEKA_DID/00_CENTRUM/05C_DLOUHODOBA_INTEGRACNI_TRAJEKTORIE",
  "KARTOTEKA_DID/00_CENTRUM/05C_SEZENI_LOG",
  "KARTOTEKA_DID/00_CENTRUM/05D_HERNY_LOG",
  "KARTOTEKA_DID/00_CENTRUM/DASHBOARD",
  "KARTOTEKA_DID/00_CENTRUM/06_BRADAVICE/PRIBEHY",
  "KARTOTEKA_DID/00_CENTRUM/06_BRADAVICE/STAV_HRY",
  "KARTOTEKA_DID/00_CENTRUM/09_KNIHOVNA/00_PREHLED",
  "KARTOTEKA_DID/00_CENTRUM/09_KNIHOVNA/VYZKUM_DID",
  "KARTOTEKA_DID/00_CENTRUM/09_KNIHOVNA/VZDELAVACI_MATERIALY",
  "PAMET_KAREL/DID/HANKA/KAREL",
  "PAMET_KAREL/DID/HANKA/KARLOVY_POZNATKY",
  "PAMET_KAREL/DID/HANKA/PROFIL_OSOBNOSTI",
  "PAMET_KAREL/DID/HANKA/SITUACNI_ANALYZA",
  "PAMET_KAREL/DID/HANKA/STRATEGIE_KOMUNIKACE",
  "PAMET_KAREL/DID/HANKA/VLAKNA_3DNY",
  "PAMET_KAREL/DID/HANKA/VLAKNA_POSLEDNI",
  "PAMET_KAREL/DID/KATA/KAREL",
  "PAMET_KAREL/DID/KATA/KARLOVY_POZNATKY",
  "PAMET_KAREL/DID/KATA/PROFIL_OSOBNOSTI",
  "PAMET_KAREL/DID/KATA/SITUACNI_ANALYZA",
  "PAMET_KAREL/DID/KATA/STRATEGIE_KOMUNIKACE",
  "PAMET_KAREL/DID/KATA/VLAKNA_3DNY",
  "PAMET_KAREL/DID/KATA/VLAKNA_POSLEDNI",
  "PAMET_KAREL/DID/KONTEXTY/DULEZITA_DATA",
  "PAMET_KAREL/DID/KONTEXTY/KDO_JE_KDO",
  "PAMET_KAREL/DID/KONTEXTY/SLOVNIK",
  "PAMET_KAREL/DID/KONTEXTY/VZORCE",
  "PAMET_KAREL/DID/KONTEXTY/SUPERVIZNI_POZNATKY",
]);

/** P29A: Reroute table for legacy / invalid targets. */
export const TARGET_REROUTE_MAP: Record<string, string> = {
  "KARTOTEKA_DID/00_CENTRUM/05E_TEAM_DECISIONS_LOG":
    "KARTOTEKA_DID/00_CENTRUM/05A_OPERATIVNI_PLAN",
  "KARTOTEKA_DID/00_CENTRUM/Bezpecne_DID_poznamky_z_osobniho_vlakna":
    "PAMET_KAREL/DID/HANKA/SITUACNI_ANALYZA",
  "PAMET_KAREL_PROFIL_HANKA": "PAMET_KAREL/DID/HANKA/PROFIL_OSOBNOSTI",
  "PAMET_KAREL_PROFIL_KATA": "PAMET_KAREL/DID/KATA/PROFIL_OSOBNOSTI",
  "05_Operativni_Plan": "KARTOTEKA_DID/00_CENTRUM/05A_OPERATIVNI_PLAN",
  "05A_OPERATIVNI_PLAN": "KARTOTEKA_DID/00_CENTRUM/05A_OPERATIVNI_PLAN",
};

const KARTA_CANONICAL_PREFIX = "KARTOTEKA_DID/01_AKTIVNI_FRAGMENTY/";

export type CanonicalizeOutcome =
  | { ok: true; target: string; rerouted: boolean }
  | { ok: false; reason: string };

/**
 * P29A: Canonicalize a raw target into the registry form. Fail-closed.
 * - bare KARTA_X → KARTOTEKA_DID/01_AKTIVNI_FRAGMENTY/KARTA_X
 * - reroutes legacy aliases via TARGET_REROUTE_MAP
 * - strips parenthetical part-name aliases (e.g. "KARTA_ARTHUR (ARTUR, ARTÍK)")
 * - rejects 03_ARCHIV_SPICICH writes and unknown targets
 */
export function canonicalizeTarget(rawTarget: string): CanonicalizeOutcome {
  if (!rawTarget) return { ok: false, reason: "empty target" };
  let target = rawTarget.trim();
  let rerouted = false;

  if (target.startsWith("KARTOTEKA_DID/03_ARCHIV_SPICICH/")) {
    return { ok: false, reason: "archive folder is not a write target" };
  }

  if (TARGET_REROUTE_MAP[target]) {
    target = TARGET_REROUTE_MAP[target];
    rerouted = true;
  }

  // Strip and uppercase KARTA_<NAME> in either bare or canonical form.
  const stripPart = (raw: string): string | null => {
    const part = raw.split("(")[0].trim().split(/[\s,]+/)[0];
    if (!part) return null;
    return part.toUpperCase().replace(/[^A-Z0-9_]/g, "");
  };

  const bare = target.match(/^KARTA_(.+)$/);
  if (bare) {
    const part = stripPart(bare[1]);
    if (!part) return { ok: false, reason: `unparseable KARTA_ name: ${rawTarget}` };
    target = `${KARTA_CANONICAL_PREFIX}KARTA_${part}`;
    rerouted = true;
  } else if (target.startsWith(KARTA_CANONICAL_PREFIX)) {
    const tail = target.slice(KARTA_CANONICAL_PREFIX.length);
    const m = tail.match(/^KARTA_(.+)$/);
    if (m) {
      const part = stripPart(m[1]);
      if (!part) return { ok: false, reason: `unparseable KARTA_ name: ${rawTarget}` };
      const canon = `${KARTA_CANONICAL_PREFIX}KARTA_${part}`;
      if (canon !== target) rerouted = true;
      target = canon;
    }
  }

  if (!isGovernedTarget(target)) {
    return { ok: false, reason: `target not in canonical registry: ${target}` };
  }

  return { ok: true, target, rerouted: rerouted || target !== rawTarget };
}

/**
 * Validate that a drive target is allowed by governance. Fail-closed.
 */
export function isGovernedTarget(target: string): boolean {
  if (!target) return false;
  if (CANONICAL_DRIVE_REGISTRY.has(target)) return true;
  if (
    target.startsWith(KARTA_CANONICAL_PREFIX)
    && /^KARTA_[A-Z0-9_]+$/.test(target.slice(KARTA_CANONICAL_PREFIX.length))
  ) {
    return true;
  }
  return false;
}

const STATIC_REPLACE_TARGETS_BASE: ReadonlySet<string> = new Set([
  "PAMET_KAREL/DID/HANKA/VLAKNA_3DNY",
  "PAMET_KAREL/DID/KATA/VLAKNA_3DNY",
  "KARTOTEKA_DID/00_CENTRUM/05A_OPERATIVNI_PLAN",
  "KARTOTEKA_DID/00_CENTRUM/05B_STRATEGICKY_VYHLED",
  "KARTOTEKA_DID/00_CENTRUM/05C_DLOUHODOBA_INTEGRACNI_TRAJEKTORIE",
  "KARTOTEKA_DID/00_CENTRUM/DASHBOARD",
]);

export function isReplaceAllowed(
  target: string,
  sourceType?: string | null,
  contentType?: string | null,
): boolean {
  if (STATIC_REPLACE_TARGETS_BASE.has(target)) return true;
  if (target.startsWith(KARTA_CANONICAL_PREFIX) || /^KARTA_.+$/.test(target)) {
    return sourceType === "update-part-profile" && contentType === "profile_claim";
  }
  return false;
}
