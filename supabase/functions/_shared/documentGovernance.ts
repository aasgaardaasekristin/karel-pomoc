import { blockHanaAliasPartWrite } from "./hanaPersonalIdentityResolver.ts";

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
  // P29A closeout: 05D_HERNY_LOG is NOT in canonical governance.
  // Playroom logs are appended to 05A under the operational plan.
  playroom_log: () => ({
    layer: "05A",
    driveTarget: "KARTOTEKA_DID/00_CENTRUM/05A_OPERATIVNI_PLAN",
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
 * P29A closeout: Canonical Drive target registry — fail-closed, single source of truth.
 *
 * Authoritative governance list. Any target NOT in this set must either:
 *   (a) be rerouted by TARGET_REROUTE_MAP / canonicalizeTarget, or
 *   (b) be rejected (blocked_by_governance).
 *
 * Notes about physical Drive truth (verified 2026-05-05):
 *   - HANKA/KATA memory documents are stored as text/plain files with the
 *     literal name "<NAME>.txt" (e.g. SITUACNI_ANALYZA.txt).
 *   - HANKA/KAREL and KATA/KAREL are stored as Google Docs without extension
 *     (the literal Drive name is "KAREL", mimeType application/vnd.google-apps.document).
 *   - 00_CENTRUM/05E_TEAM_DECISIONS_LOG, 05C_SEZENI_LOG, 05D_HERNY_LOG and
 *     KONTEXTY/SUPERVIZNI_POZNATKY are NOT in the authoritative governance
 *     architecture for P29A and are therefore explicitly excluded.
 */
export const CANONICAL_DRIVE_REGISTRY: ReadonlySet<string> = new Set([
  // KARTOTEKA_DID / 00_CENTRUM
  "KARTOTEKA_DID/00_CENTRUM/01_INDEX",
  "KARTOTEKA_DID/00_CENTRUM/03_VNITRNI_SVET",
  "KARTOTEKA_DID/00_CENTRUM/04_MAPA_VZTAHU",
  "KARTOTEKA_DID/00_CENTRUM/05A_OPERATIVNI_PLAN",
  "KARTOTEKA_DID/00_CENTRUM/05B_STRATEGICKY_VYHLED",
  "KARTOTEKA_DID/00_CENTRUM/05C_DLOUHODOBA_INTEGRACNI_TRAJEKTORIE",
  "KARTOTEKA_DID/00_CENTRUM/DASHBOARD",
  "KARTOTEKA_DID/00_CENTRUM/06_BRADAVICE/PRIBEHY",
  "KARTOTEKA_DID/00_CENTRUM/06_BRADAVICE/STAV_HRY",
  "KARTOTEKA_DID/00_CENTRUM/09_KNIHOVNA/00_PREHLED",
  "KARTOTEKA_DID/00_CENTRUM/09_KNIHOVNA/VYZKUM_DID",
  "KARTOTEKA_DID/00_CENTRUM/09_KNIHOVNA/VZDELAVACI_MATERIALY",

  // PAMET_KAREL / DID / HANKA — text files use .txt; KAREL is bare Google Doc
  "PAMET_KAREL/DID/HANKA/KAREL",
  "PAMET_KAREL/DID/HANKA/KARLOVY_POZNATKY.txt",
  "PAMET_KAREL/DID/HANKA/PROFIL_OSOBNOSTI.txt",
  "PAMET_KAREL/DID/HANKA/SITUACNI_ANALYZA.txt",
  "PAMET_KAREL/DID/HANKA/STRATEGIE_KOMUNIKACE.txt",
  "PAMET_KAREL/DID/HANKA/VLAKNA_3DNY.txt",
  "PAMET_KAREL/DID/HANKA/VLAKNA_POSLEDNI.txt",

  // PAMET_KAREL / DID / KATA — text files use .txt; KAREL is bare Google Doc
  "PAMET_KAREL/DID/KATA/KAREL",
  "PAMET_KAREL/DID/KATA/KARLOVY_POZNATKY.txt",
  "PAMET_KAREL/DID/KATA/PROFIL_OSOBNOSTI.txt",
  "PAMET_KAREL/DID/KATA/SITUACNI_ANALYZA.txt",
  "PAMET_KAREL/DID/KATA/STRATEGIE_KOMUNIKACE.txt",
  "PAMET_KAREL/DID/KATA/VLAKNA_3DNY.txt",
  "PAMET_KAREL/DID/KATA/VLAKNA_POSLEDNI.txt",

  // PAMET_KAREL / DID / KONTEXTY
  "PAMET_KAREL/DID/KONTEXTY/DULEZITA_DATA",
  "PAMET_KAREL/DID/KONTEXTY/KDO_JE_KDO",
  "PAMET_KAREL/DID/KONTEXTY/SLOVNIK",
  "PAMET_KAREL/DID/KONTEXTY/VZORCE",

  // PAMET_KAREL / ORIGINAL — Karlova „minulá inkarnace" (Jung)
  "PAMET_KAREL/ORIGINAL/CHARAKTER_JUNGA",
  "PAMET_KAREL/ORIGINAL/VZPOMINKY_ZIVOT",
  "PAMET_KAREL/ORIGINAL/ZNALOSTI_DILA",
]);

/**
 * P29A closeout: Reroute table for legacy / invalid targets.
 *
 * Auto-applied for purely structural rewrites (.txt suffix, removed
 * unauthorized centrum docs). Content-aware routing for
 * Bezpecne_DID_poznamky_z_osobniho_vlakna lives in
 * routeBezpecnePoznamky() below — the static map only covers a default
 * fallback so legacy queue rows do not block governance.
 */
export const TARGET_REROUTE_MAP: Record<string, string> = {
  // Removed centrum docs → operational plan
  "KARTOTEKA_DID/00_CENTRUM/05E_TEAM_DECISIONS_LOG":
    "KARTOTEKA_DID/00_CENTRUM/05A_OPERATIVNI_PLAN",
  "KARTOTEKA_DID/00_CENTRUM/05C_SEZENI_LOG":
    "KARTOTEKA_DID/00_CENTRUM/05A_OPERATIVNI_PLAN",
  "KARTOTEKA_DID/00_CENTRUM/05D_HERNY_LOG":
    "KARTOTEKA_DID/00_CENTRUM/05A_OPERATIVNI_PLAN",
  // P29A closeout-fix: SUPERVIZNI_POZNATKY is NOT auto-rerouted to KDO_JE_KDO.
  // It is semantically a different document; mechanical rewrite into the
  // people directory would corrupt that target. Such writes must be
  // blocked_by_governance and require explicit manual mapping. Therefore
  // intentionally NOT present in TARGET_REROUTE_MAP.

  // Default fallback for Bezpecne_DID_poznamky_z_osobniho_vlakna
  // (when content-aware routing is not available, e.g. legacy queue row).
  "KARTOTEKA_DID/00_CENTRUM/Bezpecne_DID_poznamky_z_osobniho_vlakna":
    "PAMET_KAREL/DID/HANKA/SITUACNI_ANALYZA.txt",

  // Legacy alias remaps
  "PAMET_KAREL_PROFIL_HANKA": "PAMET_KAREL/DID/HANKA/PROFIL_OSOBNOSTI.txt",
  "PAMET_KAREL_PROFIL_KATA": "PAMET_KAREL/DID/KATA/PROFIL_OSOBNOSTI.txt",
  "05_Operativni_Plan": "KARTOTEKA_DID/00_CENTRUM/05A_OPERATIVNI_PLAN",
  "05A_OPERATIVNI_PLAN": "KARTOTEKA_DID/00_CENTRUM/05A_OPERATIVNI_PLAN",
  // Non-canonical kontexty alias → VZORCE (closest semantic match in governance).
  "PAMET_KAREL/DID/KONTEXTY/TRIGGERY": "PAMET_KAREL/DID/KONTEXTY/VZORCE",

  // Auto-rewrite bare HANKA/KATA names without .txt to canonical .txt form.
  "PAMET_KAREL/DID/HANKA/KARLOVY_POZNATKY": "PAMET_KAREL/DID/HANKA/KARLOVY_POZNATKY.txt",
  "PAMET_KAREL/DID/HANKA/PROFIL_OSOBNOSTI": "PAMET_KAREL/DID/HANKA/PROFIL_OSOBNOSTI.txt",
  "PAMET_KAREL/DID/HANKA/SITUACNI_ANALYZA": "PAMET_KAREL/DID/HANKA/SITUACNI_ANALYZA.txt",
  "PAMET_KAREL/DID/HANKA/STRATEGIE_KOMUNIKACE": "PAMET_KAREL/DID/HANKA/STRATEGIE_KOMUNIKACE.txt",
  "PAMET_KAREL/DID/HANKA/VLAKNA_3DNY": "PAMET_KAREL/DID/HANKA/VLAKNA_3DNY.txt",
  "PAMET_KAREL/DID/HANKA/VLAKNA_POSLEDNI": "PAMET_KAREL/DID/HANKA/VLAKNA_POSLEDNI.txt",
  "PAMET_KAREL/DID/KATA/KARLOVY_POZNATKY": "PAMET_KAREL/DID/KATA/KARLOVY_POZNATKY.txt",
  "PAMET_KAREL/DID/KATA/PROFIL_OSOBNOSTI": "PAMET_KAREL/DID/KATA/PROFIL_OSOBNOSTI.txt",
  "PAMET_KAREL/DID/KATA/SITUACNI_ANALYZA": "PAMET_KAREL/DID/KATA/SITUACNI_ANALYZA.txt",
  "PAMET_KAREL/DID/KATA/STRATEGIE_KOMUNIKACE": "PAMET_KAREL/DID/KATA/STRATEGIE_KOMUNIKACE.txt",
  "PAMET_KAREL/DID/KATA/VLAKNA_3DNY": "PAMET_KAREL/DID/KATA/VLAKNA_3DNY.txt",
  "PAMET_KAREL/DID/KATA/VLAKNA_POSLEDNI": "PAMET_KAREL/DID/KATA/VLAKNA_POSLEDNI.txt",
};

const KARTA_CANONICAL_PREFIX = "KARTOTEKA_DID/01_AKTIVNI_FRAGMENTY/";

export type CanonicalizeOutcome =
  | { ok: true; target: string; rerouted: boolean }
  | { ok: false; reason: string };

/**
 * P29A: Canonicalize a raw target into the registry form. Fail-closed.
 * - bare KARTA_X → KARTOTEKA_DID/01_AKTIVNI_FRAGMENTY/KARTA_X
 * - reroutes legacy aliases via TARGET_REROUTE_MAP (incl. .txt suffix fix)
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
  "PAMET_KAREL/DID/HANKA/VLAKNA_3DNY.txt",
  "PAMET_KAREL/DID/KATA/VLAKNA_3DNY.txt",
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

// ── P29A closeout: Content-aware router for Bezpecne_DID_poznamky_z_osobniho_vlakna ──

export type BezpecneRoute =
  | "SITUACNI_ANALYZA"
  | "STRATEGIE_KOMUNIKACE"
  | "VLAKNA_POSLEDNI"
  | "VLAKNA_3DNY"
  | "PROFIL_OSOBNOSTI"
  | "KAREL_RELATIONAL"
  | "OPERATIVNI_PLAN"
  | "KARTA_PART";

export interface BezpecneRouteResult {
  /** Canonical Drive target inside CANONICAL_DRIVE_REGISTRY */
  target: string;
  /** Why this route was chosen (audit trail) */
  reason: BezpecneRoute;
  /** When KARTA_PART, the canonical part name (uppercased) */
  partName?: string;
}

/**
 * P29A closeout: Classify a "Bezpecne_DID_poznamky" snippet by content
 * and return a canonical Drive target. Fail-soft: defaults to
 * SITUACNI_ANALYZA when content is generic emotional state.
 *
 * therapist defaults to "HANKA" — Bezpecne_DID_poznamky_z_osobniho_vlakna
 * is a Hana-personal channel; pass "KATA" only if upstream caller has
 * explicit evidence the content is about Káťa.
 */
export function routeBezpecnePoznamky(
  content: string,
  options: {
    therapist?: "HANKA" | "KATA";
    partName?: string;
  } = {},
): BezpecneRouteResult {
  const t = options.therapist ?? "HANKA";
  const therapistRoot = `PAMET_KAREL/DID/${t}`;
  const text = (content || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  // 1. DID part-specific implication → canonical KARTA_<PART>
  if (options.partName) {
    const part = options.partName.toUpperCase().replace(/[^A-Z0-9_]/g, "");
    if (part) {
      return {
        target: `${KARTA_CANONICAL_PREFIX}KARTA_${part}`,
        reason: "KARTA_PART",
        partName: part,
      };
    }
  }

  // 2. DID operational implication → 05A
  if (
    /\b(05a|operativ\w*|denn\w* plan|rozhodnut\w* tym|akce na den|ukol pro karla)\b/i
      .test(text)
  ) {
    return {
      target: "KARTOTEKA_DID/00_CENTRUM/05A_OPERATIVNI_PLAN",
      reason: "OPERATIVNI_PLAN",
    };
  }

  // 3. Shared Karel–Hana relational memory
  if (
    /(karel a hank\w*|nas vztah|spolecn\w* pamet|spolecn\w* hranic\w*|nase dohod\w*|mezi nami|jak spolu)/i
      .test(text)
  ) {
    return { target: `${therapistRoot}/KAREL`, reason: "KAREL_RELATIONAL" };
  }

  // 4. Communication strategy / how Karel should talk to Hana
  if (
    /(komunikac\w*|jak ji(?:\b| )|jak mluv\w*|tone|tonalit\w*|nereagov\w*|vyhnout|nezvedat|jak odpov\w*|strateg\w*)/i
      .test(text)
  ) {
    return {
      target: `${therapistRoot}/STRATEGIE_KOMUNIKACE.txt`,
      reason: "STRATEGIE_KOMUNIKACE",
    };
  }

  // 5. Stable personality insight (long-term trait, not today's state)
  if (
    /(osobnost\w*|trvale|dlouhodob\w*|charakter|temperament|hodnot\w*|zivotn\w* vzorec|core belief)/i
      .test(text)
  ) {
    return {
      target: `${therapistRoot}/PROFIL_OSOBNOSTI.txt`,
      reason: "PROFIL_OSOBNOSTI",
    };
  }

  // 6. 3-day rolling summary
  if (/(za posledni\s*3\s*dn\w*|tridenn\w*|3-?denn\w*|trend\s+poslednich)/i.test(text)) {
    return { target: `${therapistRoot}/VLAKNA_3DNY.txt`, reason: "VLAKNA_3DNY" };
  }

  // 7. Latest personal thread safe summary
  if (
    /(posledni\s*vlak\w*|posledni\s*konverz\w*|posledni\s*sezen\w*|dnesn\w*\s*vlak\w*|vcerejs\w*\s*vlak\w*)/i
      .test(text)
  ) {
    return { target: `${therapistRoot}/VLAKNA_POSLEDNI.txt`, reason: "VLAKNA_POSLEDNI" };
  }

  // 8. Default — emotional state / guilt / burnout / heaviness → situational analysis
  return { target: `${therapistRoot}/SITUACNI_ANALYZA.txt`, reason: "SITUACNI_ANALYZA" };
}

// ── P29A closeout: Hard governance gate for ALL did_pending_drive_writes inserts ──

export interface DriveWriteInsertInput {
  target_document: string;
  /** When this is a Bezpecne_DID_poznamky write, pass the raw payload so the
   *  content-aware router can choose the correct sub-target. */
  bezpecne_payload?: string;
  bezpecne_therapist?: "HANKA" | "KATA";
  bezpecne_part_name?: string;
}

export interface DriveWriteGateResult {
  ok: boolean;
  /** Canonical target when ok=true; original raw target when ok=false. */
  target: string;
  rerouted: boolean;
  reason?: string;
  bezpecne_route?: BezpecneRoute;
}

/**
 * P29A closeout: every did_pending_drive_writes insert MUST go through this
 * gate. Returns ok=false when the target cannot be routed onto a canonical
 * registry entry; callers must NOT insert the row in that case.
 */
export function gateDriveWriteInsert(input: DriveWriteInsertInput): DriveWriteGateResult {
  const raw = input.target_document;

  // ── P32.1 hard identity guard: never allow KARTA_HANA / KARTA_KAREL writes ──
  const identityGuard = blockHanaAliasPartWrite({
    target_kind: "did_pending_drive_writes",
    target_document: raw,
    part_name: input.bezpecne_part_name ?? null,
    source: "gateDriveWriteInsert",
  });
  if (identityGuard.blocked) {
    return {
      ok: false,
      target: raw,
      rerouted: false,
      reason: `blocked_by_identity_guard:${identityGuard.normalized_hits.join(",")}`,
    };
  }

  // Bezpecne content-aware routing takes priority over the static reroute.
  if (raw === "KARTOTEKA_DID/00_CENTRUM/Bezpecne_DID_poznamky_z_osobniho_vlakna") {
    if (typeof input.bezpecne_payload === "string" && input.bezpecne_payload.trim()) {
      const r = routeBezpecnePoznamky(input.bezpecne_payload, {
        therapist: input.bezpecne_therapist,
        partName: input.bezpecne_part_name,
      });
      const c = canonicalizeTarget(r.target);
      if (c.ok === false) return { ok: false, target: raw, rerouted: false, reason: c.reason };
      return { ok: true, target: c.target, rerouted: true, bezpecne_route: r.reason };
    }
    // No payload provided → fall through to static reroute (safe default).
  }

  const c = canonicalizeTarget(raw);
  if (c.ok === false) return { ok: false, target: raw, rerouted: false, reason: c.reason };
  return { ok: true, target: c.target, rerouted: c.rerouted };
}

// ── P29A closeout-fix: Logical → Physical Drive title mapping for KARTA_<NAME> ──
//
// On the actual Drive, several active part cards live under file titles that
// are numerically prefixed (e.g. "003_TUNDRUPEK") inside
// KARTOTEKA_DID/01_AKTIVNI_FRAGMENTY. Governance layer always speaks in
// canonical logical targets (KARTA_<NAME>); the resolver in
// karel-drive-queue-processor uses this map to find the physical file.
export interface CardPhysicalMapping {
  logical_target: string;
  physical_drive_title: string;
  parent_folder: "01_AKTIVNI_FRAGMENTY";
}

export const CARD_PHYSICAL_MAP: Record<string, CardPhysicalMapping> = {
  "KARTOTEKA_DID/01_AKTIVNI_FRAGMENTY/KARTA_ANICKA": {
    logical_target: "KARTOTEKA_DID/01_AKTIVNI_FRAGMENTY/KARTA_ANICKA",
    physical_drive_title: "001_ANICKA",
    parent_folder: "01_AKTIVNI_FRAGMENTY",
  },
  "KARTOTEKA_DID/01_AKTIVNI_FRAGMENTY/KARTA_GUSTIK": {
    logical_target: "KARTOTEKA_DID/01_AKTIVNI_FRAGMENTY/KARTA_GUSTIK",
    physical_drive_title: "002_GUSTIK",
    parent_folder: "01_AKTIVNI_FRAGMENTY",
  },
  "KARTOTEKA_DID/01_AKTIVNI_FRAGMENTY/KARTA_TUNDRUPEK": {
    logical_target: "KARTOTEKA_DID/01_AKTIVNI_FRAGMENTY/KARTA_TUNDRUPEK",
    physical_drive_title: "003_TUNDRUPEK",
    parent_folder: "01_AKTIVNI_FRAGMENTY",
  },
  "KARTOTEKA_DID/01_AKTIVNI_FRAGMENTY/KARTA_ARTHUR": {
    logical_target: "KARTOTEKA_DID/01_AKTIVNI_FRAGMENTY/KARTA_ARTHUR",
    physical_drive_title: "004_ARTHUR",
    parent_folder: "01_AKTIVNI_FRAGMENTY",
  },
  "KARTOTEKA_DID/01_AKTIVNI_FRAGMENTY/KARTA_GUSTAV_PUVODNI_CAST": {
    logical_target: "KARTOTEKA_DID/01_AKTIVNI_FRAGMENTY/KARTA_GUSTAV_PUVODNI_CAST",
    physical_drive_title: "017_GUSTAV_PUVODNI_CAST",
    parent_folder: "01_AKTIVNI_FRAGMENTY",
  },
  "KARTOTEKA_DID/01_AKTIVNI_FRAGMENTY/KARTA_QA_TEST": {
    logical_target: "KARTOTEKA_DID/01_AKTIVNI_FRAGMENTY/KARTA_QA_TEST",
    physical_drive_title: "042_QA_TEST",
    parent_folder: "01_AKTIVNI_FRAGMENTY",
  },
};

/** Resolve logical KARTA_* target into the physical Drive file title. */
export function resolveCardPhysicalTitle(logicalTarget: string): string | null {
  const m = CARD_PHYSICAL_MAP[logicalTarget];
  return m ? m.physical_drive_title : null;
}

/**
 * P29A: Hard gate for canonical KARTA_<NAME> writes.
 * Returns the physical title only if the logical target has a confirmed
 * physical Drive mapping. Otherwise the caller MUST block the write as
 * `blocked_by_governance_no_physical_card` (no retry).
 */
export function isCanonicalKartaTarget(target: string): boolean {
  return target.startsWith("KARTOTEKA_DID/01_AKTIVNI_FRAGMENTY/KARTA_");
}
export function hasPhysicalCardMapping(target: string): boolean {
  return Object.prototype.hasOwnProperty.call(CARD_PHYSICAL_MAP, target);
}

/**
 * P29A GERHARDT subpass: KARTA_* targets where the physical Drive reality is
 * ambiguous or mismatched (e.g. file exists only in 03_ARCHIV_SPICICH, or
 * multiple candidates, or registry/file mismatch). These MUST NOT auto-map.
 * Drive Proof for GERHARDT (Drive API):
 *   - 022_GERHARDT exists in 03_ARCHIV_SPICICH (NOT 01_AKTIVNI_FRAGMENTY)
 *   - No 001_GERHARDT in 01_AKTIVNI_FRAGMENTY
 *   - Registry has both active `001_gerhardt` (no physical file) and sleeping
 *     `GERHARDT` → 022_GERHARDT (archive). Ambiguous → manual approval.
 */
export const AMBIGUOUS_PHYSICAL_CARD_TARGETS: ReadonlySet<string> = new Set([
  "KARTOTEKA_DID/01_AKTIVNI_FRAGMENTY/KARTA_GERHARDT",
]);
export function isAmbiguousPhysicalCardTarget(target: string): boolean {
  return AMBIGUOUS_PHYSICAL_CARD_TARGETS.has(target);
}

// ── P29A closeout-fix: shared safe insert helper for did_pending_drive_writes ──
//
// Every did_pending_drive_writes insert MUST funnel through this helper.
// It accepts the FULL original row object and ONLY rewrites `target_document`
// to the canonical form. All other fields (dedupe_key, semantic_dedupe_key,
// source_ref, source_type, content_type, metadata, retry_count, priority,
// rerouted_from_write_id, ...) are preserved verbatim so dedupe / consumption
// tracking / audit are not corrupted by the governance pass.

export interface SafeEnqueueOptions {
  /** Caller name for audit trail. */
  source: string;
  /** When this is a Bezpecne_DID_poznamky write, pass the raw payload so the
   *  content-aware router can choose the correct sub-target. */
  bezpecne_payload?: string;
  bezpecne_therapist?: "HANKA" | "KATA";
  bezpecne_part_name?: string;
  /** Optional select() projection (e.g. "id"). When provided, returns single row. */
  returning?: string;
}

export interface SafeEnqueueResult {
  inserted: boolean;
  blocked: boolean;
  reason?: string;
  target?: string;
  rerouted?: boolean;
  bezpecne_route?: BezpecneRoute;
  data?: any;
}

// Loose Supabase client interface — avoids hard dep on @supabase/supabase-js types.
type SbLike = {
  from: (table: string) => any;
};

/**
 * P29A: Safe enqueue helper.
 * Usage:
 *   const r = await safeEnqueueDriveWrite(sb, originalRow, { source: "..." });
 *   if (!r.inserted) { ... }
 *
 * The original row MUST contain target_document. All other fields are
 * preserved unchanged.
 */
export async function safeEnqueueDriveWrite(
  sb: SbLike,
  originalRow: Record<string, any>,
  options: SafeEnqueueOptions,
): Promise<SafeEnqueueResult> {
  const rawTarget = String(originalRow?.target_document ?? "");
  const gate = gateDriveWriteInsert({
    target_document: rawTarget,
    bezpecne_payload: options.bezpecne_payload,
    bezpecne_therapist: options.bezpecne_therapist,
    bezpecne_part_name: options.bezpecne_part_name,
  });

  if (!gate.ok) {
    console.warn(
      `[${options.source}] blocked_by_governance: ${rawTarget} (${gate.reason})`,
    );
    try {
      await sb.from("system_health_log").insert({
        event_type: "drive_write_blocked_by_governance",
        severity: "warn",
        source: options.source,
        details: { raw_target: rawTarget, reason: gate.reason },
      });
    } catch (_) { /* best-effort */ }
    return { inserted: false, blocked: true, reason: gate.reason, target: rawTarget };
  }

  // Preserve ALL original fields; only canonicalize target_document.
  const row: Record<string, any> = { ...originalRow, target_document: gate.target };

  let q: any = sb.from("did_pending_drive_writes").insert(row);
  if (options.returning) {
    q = q.select(options.returning).single();
  }
  const { data, error } = await q;
  if (error) {
    console.warn(`[${options.source}] insert error for ${gate.target}:`, error.message ?? error);
    return { inserted: false, blocked: false, reason: error.message ?? String(error), target: gate.target };
  }

  return {
    inserted: true,
    blocked: false,
    target: gate.target,
    rerouted: gate.rerouted,
    bezpecne_route: gate.bezpecne_route,
    data,
  };
}

/**
 * Bulk variant — gates each row independently. Rows with invalid targets are
 * dropped (and logged); the remaining rows are inserted in a single batch
 * with all original fields preserved.
 */
export async function safeBulkEnqueueDriveWrites(
  sb: SbLike,
  originalRows: Array<Record<string, any>>,
  options: SafeEnqueueOptions,
): Promise<{ inserted: number; blocked: number; reasons: string[] }> {
  const ok: Array<Record<string, any>> = [];
  const reasons: string[] = [];
  let blocked = 0;
  for (const r of originalRows) {
    const rawTarget = String(r?.target_document ?? "");
    const gate = gateDriveWriteInsert({
      target_document: rawTarget,
      bezpecne_payload: options.bezpecne_payload,
      bezpecne_therapist: options.bezpecne_therapist,
      bezpecne_part_name: options.bezpecne_part_name,
    });
    if (!gate.ok) {
      blocked++;
      reasons.push(`${rawTarget}: ${gate.reason}`);
      console.warn(`[${options.source}] blocked_by_governance: ${rawTarget} (${gate.reason})`);
      try {
        await sb.from("system_health_log").insert({
          event_type: "drive_write_blocked_by_governance",
          severity: "warn",
          source: options.source,
          details: { raw_target: rawTarget, reason: gate.reason },
        });
      } catch (_) { /* best-effort */ }
      continue;
    }
    ok.push({ ...r, target_document: gate.target });
  }
  if (ok.length === 0) return { inserted: 0, blocked, reasons };
  const { error } = await sb.from("did_pending_drive_writes").insert(ok);
  if (error) {
    console.warn(`[${options.source}] bulk insert error:`, error.message ?? error);
    return { inserted: 0, blocked, reasons: [...reasons, error.message ?? String(error)] };
  }
  return { inserted: ok.length, blocked, reasons };
}

// ── Backward-compatible thin wrapper (deprecated; prefer safeEnqueueDriveWrite) ──
export interface SafeInsertInput {
  target_document: string;
  content: string;
  write_type: "append" | "replace";
  priority?: "critical" | "urgent" | "high" | "normal" | "low";
  status?: string;
  user_id?: string | null;
  bezpecne_payload?: string;
  bezpecne_therapist?: "HANKA" | "KATA";
  bezpecne_part_name?: string;
  source: string;
}
export interface SafeInsertResult {
  inserted: boolean;
  blocked: boolean;
  reason?: string;
  target?: string;
  rerouted?: boolean;
  bezpecne_route?: BezpecneRoute;
}
export async function safeInsertGovernedDriveWrite(
  sb: SbLike,
  input: SafeInsertInput,
): Promise<SafeInsertResult> {
  const row: Record<string, any> = {
    target_document: input.target_document,
    content: input.content,
    write_type: input.write_type,
    priority: input.priority ?? "normal",
    status: input.status ?? "pending",
  };
  if (input.user_id) row.user_id = input.user_id;
  const r = await safeEnqueueDriveWrite(sb, row, {
    source: input.source,
    bezpecne_payload: input.bezpecne_payload,
    bezpecne_therapist: input.bezpecne_therapist,
    bezpecne_part_name: input.bezpecne_part_name,
  });
  return {
    inserted: r.inserted,
    blocked: r.blocked,
    reason: r.reason,
    target: r.target,
    rerouted: r.rerouted,
    bezpecne_route: r.bezpecne_route,
  };
}


