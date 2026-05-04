/**
 * P20 — Clinical Activity Evidence Hierarchy
 *
 * Centrální klasifikátor klinické aktivity: jasně odděluje
 * "plán existoval" od "sezení proběhlo".
 *
 * Kategorie (od nejsilnějšího po nejslabší):
 *   completed_session         — did_session_reviews + completed
 *   started_session           — did_part_sessions OR live_progress (started)
 *   approved_plan_not_started — plan approved/signatures, ale bez started
 *   pending_generated_plan    — pouze pending/draft plán bez approval
 *   no_activity               — vůbec nic
 *   unknown_or_inconsistent   — protichůdné signály
 *
 * Každá kategorie nese tvrdé booleany:
 *   activity_happened
 *   can_claim_started
 *   can_claim_clinical_input
 *
 * + visible_label, allowed_phrases, forbidden_phrases pro renderer.
 *
 * Tento modul JE jediný zdroj pravdy. Builder visible textu MUSÍ číst tyto flagy
 * a ne `sess.exists === true` jako v incidentu 2026-05-04.
 */

export type ClinicalEvidenceCategory =
  | "completed_session"
  | "started_session"
  | "approved_plan_not_started"
  | "pending_generated_plan"
  | "no_activity"
  | "unknown_or_inconsistent";

export interface ClinicalActivityEvidence {
  category: ClinicalEvidenceCategory;
  activity_happened: boolean;
  can_claim_started: boolean;
  can_claim_clinical_input: boolean;
  visible_label: string;
  allowed_phrases: string[];
  forbidden_phrases: string[];
  // Auditní stopa pro debugging:
  evidence_summary: {
    has_session_review: boolean;
    has_part_session: boolean;
    has_live_progress_started: boolean;
    has_approved_plan: boolean;
    has_pending_plan_only: boolean;
    part_name?: string | null;
    plan_status?: string | null;
    plan_lifecycle_status?: string | null;
    plan_program_status?: string | null;
    plan_generated_by?: string | null;
  };
}

export interface ClinicalEvidenceInputs {
  /** did_session_reviews row(s) for the date+part — completed reviews. */
  session_reviews?: Array<{
    id?: string;
    status?: string | null;
    part_name?: string | null;
    session_date?: string | null;
  }> | null;
  /** did_part_sessions row(s) for the date+part. */
  part_sessions?: Array<{
    id?: string;
    part_name?: string | null;
    session_date?: string | null;
  }> | null;
  /** did_live_session_progress row(s) for the date+part. */
  live_progress?: Array<{
    id?: string;
    part_name?: string | null;
    completed_blocks?: number | null;
    total_blocks?: number | null;
    last_activity_at?: string | null;
    finalized_at?: string | null;
  }> | null;
  /** did_daily_session_plans row(s) for the date+part. */
  plans?: Array<{
    id?: string;
    selected_part?: string | null;
    status?: string | null;
    lifecycle_status?: string | null;
    program_status?: string | null;
    approved_at?: string | null;
    started_at?: string | null;
    completed_at?: string | null;
    generated_by?: string | null;
  }> | null;
}

const FORBIDDEN_WHEN_NOT_STARTED: string[] = [
  "zahájené Sezení",
  "zahájeného Sezení",
  "doložené jako klinický vstup",
  "doložená jako klinický vstup",
  "práce byla zahájená",
  "práce byla zahájena",
  "včerejší otevřené Sezení",
  "navazuje hlavně na včerejší otevřené Sezení",
  "klinický vstup",
  "rozpracované Sezení",
  "otevřené Sezení",
  "zahájená Herna",
  "doložená Herna",
];

function plansHaveApproval(plans: NonNullable<ClinicalEvidenceInputs["plans"]>): boolean {
  return plans.some((p) => {
    if (p?.approved_at) return true;
    const ps = String(p?.program_status ?? "").toLowerCase();
    if (["approved", "ready_to_start", "in_progress", "completed"].includes(ps)) return true;
    return false;
  });
}

function plansHaveStarted(plans: NonNullable<ClinicalEvidenceInputs["plans"]>): boolean {
  return plans.some((p) => {
    if (p?.started_at) return true;
    if (p?.completed_at) return true;
    const st = String(p?.status ?? "").toLowerCase();
    const ls = String(p?.lifecycle_status ?? "").toLowerCase();
    const ps = String(p?.program_status ?? "").toLowerCase();
    if (["in_progress", "started", "active", "completed"].includes(st)) return true;
    if (["in_progress", "started", "active", "completed"].includes(ls)) return true;
    if (["in_progress", "completed"].includes(ps)) return true;
    return false;
  });
}

function liveProgressHasStarted(progress: NonNullable<ClinicalEvidenceInputs["live_progress"]>): boolean {
  return progress.some((p) => {
    if (Number(p?.completed_blocks ?? 0) > 0) return true;
    if (p?.finalized_at) return true;
    if (p?.last_activity_at) return true;
    return false;
  });
}

/**
 * Centrální klasifikátor.
 *
 * HARD RULES:
 *  - pending_generated_plan.can_claim_started        = false
 *  - pending_generated_plan.can_claim_clinical_input = false
 *  - approved_plan_not_started.can_claim_started     = false
 *  - no_activity.can_claim_started                   = false
 *  - JEN started_session / completed_session smí mluvit o
 *    "zahájeno", "klinický vstup", "proběhlo".
 */
export function classifyClinicalActivityEvidence(
  inputs: ClinicalEvidenceInputs,
): ClinicalActivityEvidence {
  const reviews = (inputs.session_reviews ?? []).filter(Boolean);
  const partSessions = (inputs.part_sessions ?? []).filter(Boolean);
  const liveProgress = (inputs.live_progress ?? []).filter(Boolean);
  const plans = (inputs.plans ?? []).filter(Boolean);

  const has_session_review = reviews.some((r) => {
    const st = String(r?.status ?? "").toLowerCase();
    return st === "analyzed" || st === "completed";
  });
  const has_part_session = partSessions.length > 0;
  const has_live_progress_started = liveProgressHasStarted(liveProgress);
  const has_approved_plan = plans.length > 0 && plansHaveApproval(plans);
  const has_started_plan = plans.length > 0 && plansHaveStarted(plans);
  const has_pending_plan_only = plans.length > 0 && !has_approved_plan && !has_started_plan;

  // Reprezentativní plán pro audit (nejnovější):
  const repPlan = plans[0] ?? null;
  const partName =
    repPlan?.selected_part ??
    reviews[0]?.part_name ??
    partSessions[0]?.part_name ??
    liveProgress[0]?.part_name ??
    null;

  const evidence_summary: ClinicalActivityEvidence["evidence_summary"] = {
    has_session_review,
    has_part_session,
    has_live_progress_started,
    has_approved_plan,
    has_pending_plan_only,
    part_name: partName,
    plan_status: repPlan?.status ?? null,
    plan_lifecycle_status: repPlan?.lifecycle_status ?? null,
    plan_program_status: repPlan?.program_status ?? null,
    plan_generated_by: repPlan?.generated_by ?? null,
  };

  // 1) completed_session — máme hotový review (nejsilnější důkaz)
  if (has_session_review) {
    return {
      category: "completed_session",
      activity_happened: true,
      can_claim_started: true,
      can_claim_clinical_input: true,
      visible_label: "Sezení proběhlo a má klinický závěr",
      allowed_phrases: [
        "sezení proběhlo",
        "klinicky doložené",
        "klinický vstup",
        "uzavřený klinický závěr",
      ],
      forbidden_phrases: [],
      evidence_summary,
    };
  }

  // 2) started_session — existuje part_session nebo live progress se started evidencí
  if (has_part_session || has_live_progress_started || has_started_plan) {
    return {
      category: "started_session",
      activity_happened: true,
      can_claim_started: true,
      can_claim_clinical_input: false,
      visible_label: "Sezení bylo zahájeno (bez uzavřeného závěru)",
      allowed_phrases: ["sezení bylo zahájené", "práce začala", "otevřené sezení"],
      forbidden_phrases: ["uzavřený klinický závěr", "doložené jako klinický vstup"],
      evidence_summary,
    };
  }

  // 3) approved_plan_not_started — plán schválený, ale neproběhl
  if (has_approved_plan) {
    return {
      category: "approved_plan_not_started",
      activity_happened: false,
      can_claim_started: false,
      can_claim_clinical_input: false,
      visible_label: "Plán byl schválen, ale sezení neproběhlo",
      allowed_phrases: [
        "plán byl schválen, ale sezení nebylo spuštěno",
        "připravený plán bez realizace",
      ],
      forbidden_phrases: FORBIDDEN_WHEN_NOT_STARTED,
      evidence_summary,
    };
  }

  // 4) pending_generated_plan — pouze automaticky vygenerovaný návrh
  if (has_pending_plan_only) {
    return {
      category: "pending_generated_plan",
      activity_happened: false,
      can_claim_started: false,
      can_claim_clinical_input: false,
      visible_label: "Existoval pouze automaticky vygenerovaný návrh, který nebyl schválen ani spuštěn",
      allowed_phrases: [
        "existoval pouze návrh",
        "automaticky vygenerovaný návrh",
        "nebyl schválen ani spuštěn",
        "nebyla otevřena",
      ],
      forbidden_phrases: FORBIDDEN_WHEN_NOT_STARTED,
      evidence_summary,
    };
  }

  // 5) no_activity — vůbec nic
  if (
    !has_session_review &&
    !has_part_session &&
    !has_live_progress_started &&
    plans.length === 0
  ) {
    return {
      category: "no_activity",
      activity_happened: false,
      can_claim_started: false,
      can_claim_clinical_input: false,
      visible_label: "Žádná doložená aktivita",
      allowed_phrases: ["neproběhla žádná doložená komunikace ani sezení"],
      forbidden_phrases: FORBIDDEN_WHEN_NOT_STARTED,
      evidence_summary,
    };
  }

  // 6) inconsistent fallback
  return {
    category: "unknown_or_inconsistent",
    activity_happened: false,
    can_claim_started: false,
    can_claim_clinical_input: false,
    visible_label: "Důkazy jsou nejednoznačné",
    allowed_phrases: ["důkazy jsou nejednoznačné"],
    forbidden_phrases: FORBIDDEN_WHEN_NOT_STARTED,
    evidence_summary,
  };
}

/**
 * Contextual guard: text smí obsahovat fráze typu "zahájené Sezení" jen pokud
 * evidence kategorie umožňuje can_claim_started=true.
 *
 * Vrací list porušení; prázdný = OK.
 */
export interface EvidenceGuardViolation {
  phrase: string;
  evidence_category: ClinicalEvidenceCategory;
  reason: string;
}

const STARTED_CLAIM_PHRASES_RE = [
  /zahájen[éaá]\s+Sezení/giu,
  /zahájen[éaá]\s+Hern[ay]/giu,
  /doložen[éaá]\s+jako\s+klinick[ýáé]\s+vstup/giu,
  /práce\s+byla\s+zahájen[áa]/giu,
  /včerejší\s+otevřené\s+Sezení/giu,
  /navazuje\s+hlavně\s+na\s+včerejší\s+otevřené\s+Sezení/giu,
  // P20.2 — additional started/partial claim phrases observed in incident 2026-05-04
  /otevřené\s+nebo\s+částečně\s+rozpracované/giu,
  /částečně\s+rozpracované/giu,
  /Prob[eě]hlo\s+nebo\s+bylo\s+zahájeno/giu,
  /neoznačuji\s+ho\s+jako\s+neproběhlé/giu,
  /Sezení\s+s\s+\S+\s+bylo\s+otevřené/giu,
  /Sezení\s+bylo\s+otevřené/giu,
  /čeká\s+na\s+plné\s+dovyhodnocení/giu,
  /otevřený\s+materiál,\s+ne\s+jako\s+neproběhlé/giu,
];

/**
 * P20.2 — Replace forbidden started-claim sentences in `text` with the
 * pravdivý ekvivalent given the actual evidence category. Used as a hard
 * post-processor for visible briefing text.
 */
export function sanitizeStartedClaimText(
  text: string,
  evidence: ClinicalActivityEvidence,
  partLabel?: string,
): string {
  if (!text || typeof text !== "string") return text;
  if (evidence.can_claim_started) return text;
  const part = partLabel || evidence.evidence_summary?.part_name || "vybranou část";
  const truthful =
    evidence.category === "approved_plan_not_started"
      ? `Pro ${part} byl schválený plán, ale Sezení nebylo spuštěno; nedělám z toho klinický závěr.`
      : evidence.category === "pending_generated_plan"
      ? `Pro ${part} existoval pouze automaticky vygenerovaný návrh plánu, který nebyl schválen ani spuštěn; nedělám z toho klinický závěr.`
      : `V DID režimu nemám pro tento den doložené Sezení; nedělám z toho klinický závěr.`;

  // Split into sentences and replace any sentence containing a forbidden phrase
  const sentences = text.split(/(?<=[.!?])\s+/);
  const out: string[] = [];
  let replaced = false;
  for (const s of sentences) {
    let hit = false;
    for (const re of STARTED_CLAIM_PHRASES_RE) {
      re.lastIndex = 0;
      if (re.test(s)) { hit = true; break; }
    }
    if (hit) {
      if (!replaced) { out.push(truthful); replaced = true; }
      continue;
    }
    out.push(s);
  }
  return out.join(" ").replace(/\s{2,}/g, " ").trim();
}

export function detectEvidenceGuardViolations(
  text: string,
  evidence: ClinicalActivityEvidence,
): EvidenceGuardViolation[] {
  if (!text || typeof text !== "string") return [];
  if (evidence.can_claim_started) return [];
  const violations: EvidenceGuardViolation[] = [];
  for (const re of STARTED_CLAIM_PHRASES_RE) {
    re.lastIndex = 0;
    const matches = text.match(re);
    if (matches) {
      for (const m of matches) {
        violations.push({
          phrase: m,
          evidence_category: evidence.category,
          reason: `Fráze "${m}" smí být použita jen pokud evidence_category je completed_session nebo started_session, ale je ${evidence.category}.`,
        });
      }
    }
  }
  return violations;
}

/**
 * Last-real-session výpočet.
 * Hledá nejnovější doložené sezení — POUZE z did_part_sessions / did_live_session_progress
 * (s reálnou aktivitou) / did_session_reviews. Pending generated plans se nepoužívají.
 */
export interface LastRealSessionInputs {
  part_sessions?: Array<{
    id?: string;
    part_name?: string | null;
    session_date?: string | null;
    created_at?: string | null;
  }> | null;
  live_progress?: Array<{
    id?: string;
    part_name?: string | null;
    completed_blocks?: number | null;
    finalized_at?: string | null;
    last_activity_at?: string | null;
    created_at?: string | null;
  }> | null;
  session_reviews?: Array<{
    id?: string;
    part_name?: string | null;
    session_date?: string | null;
    status?: string | null;
    created_at?: string | null;
  }> | null;
}

export interface LastRealSessionResult {
  found: boolean;
  part_name?: string | null;
  session_date?: string | null;
  evidence_source?: "session_review" | "part_session" | "live_progress";
  evidence_id?: string | null;
}

export function computeLastRealSession(
  inputs: LastRealSessionInputs,
): LastRealSessionResult {
  const candidates: Array<{
    date: string;
    part_name: string | null;
    source: "session_review" | "part_session" | "live_progress";
    id: string | null;
  }> = [];

  for (const r of inputs.session_reviews ?? []) {
    const st = String(r?.status ?? "").toLowerCase();
    if (st !== "analyzed" && st !== "completed") continue;
    const d = r?.session_date ?? r?.created_at;
    if (!d) continue;
    candidates.push({
      date: String(d).slice(0, 10),
      part_name: r?.part_name ?? null,
      source: "session_review",
      id: r?.id ?? null,
    });
  }
  for (const ps of inputs.part_sessions ?? []) {
    const d = ps?.session_date ?? ps?.created_at;
    if (!d) continue;
    candidates.push({
      date: String(d).slice(0, 10),
      part_name: ps?.part_name ?? null,
      source: "part_session",
      id: ps?.id ?? null,
    });
  }
  for (const lp of inputs.live_progress ?? []) {
    const hasReal =
      Number(lp?.completed_blocks ?? 0) > 0 ||
      !!lp?.finalized_at ||
      !!lp?.last_activity_at;
    if (!hasReal) continue;
    const d = lp?.finalized_at ?? lp?.last_activity_at ?? lp?.created_at;
    if (!d) continue;
    candidates.push({
      date: String(d).slice(0, 10),
      part_name: lp?.part_name ?? null,
      source: "live_progress",
      id: lp?.id ?? null,
    });
  }

  if (candidates.length === 0) return { found: false };
  candidates.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const top = candidates[0];
  return {
    found: true,
    part_name: top.part_name,
    session_date: top.date,
    evidence_source: top.source,
    evidence_id: top.id,
  };
}
