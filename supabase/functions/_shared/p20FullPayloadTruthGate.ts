/**
 * P20.2 — Full payload clinical truth gate
 *
 * Skenuje VŠECHNY visible textové sekce briefing payloadu, ne jen opening.
 * Pokud `evidence.can_claim_started === false` (pending_generated_plan,
 * approved_plan_not_started, no_activity, unknown_or_inconsistent),
 * žádná visible sekce nesmí obsahovat fráze typu:
 *   - "zahájené Sezení"
 *   - "doložené jako klinický vstup"
 *   - "práce byla zahájená"
 *   - "otevřené nebo částečně rozpracované"
 *   - "neoznačuji ho jako neproběhlé"
 *   - "včerejší otevřené Sezení"
 *
 * Postup:
 *   1) collectVisibleBriefingTexts(payload)  — vrátí všechny visible cesty.
 *   2) Pro každou cestu volá `sanitizeStartedClaimText` (mutuje hodnotu).
 *   3) Pak `detectEvidenceGuardViolations` na sanitizovaném textu.
 *   4) Pokud po sanitaci zůstaly violations → hard fail:
 *        - audit.p20_clinical_truth_ok = false
 *        - audit.p20_violations_after_repair = [...]
 *        - payload.limited = true
 *        - payload.limited_reasons.push("p20_clinical_truth_violation")
 *
 * Tento modul JE jediný post-generation truth gate. Builder ho VŽDY volá
 * po `applyClinicalRecencyGuard` před zápisem do DB.
 */

import {
  type ClinicalActivityEvidence,
  detectEvidenceGuardViolations,
  sanitizeStartedClaimText,
} from "./clinicalActivityEvidence.ts";

export interface VisibleTextRef {
  path: string;
  text: string;
}

export interface P20GateResult {
  ok: boolean;
  scanned_paths: string[];
  sanitized_paths: string[];
  violations_before_repair: Array<{ path: string; phrase: string; evidence_category: string }>;
  violations_after_repair: Array<{ path: string; phrase: string; evidence_category: string }>;
  evidence_category: string | null;
  evidence_can_claim_started: boolean | null;
  evidence_can_claim_clinical_input: boolean | null;
  applied_part_label: string | null;
  reason: string | null;
  checked_at: string;
}

/**
 * Visible paths in payload that contain Karel-generated clinical prose.
 * Anything user-typed (therapist note quotes) is NOT in this list.
 */
const VISIBLE_TEXT_PATHS: Array<string[]> = [
  ["opening_monologue_text"],
  ["opening_monologue", "greeting"],
  ["opening_monologue", "context_one_liner"],
  ["opening_monologue", "today_is_about"],
  ["opening_monologue", "what_we_know_for_sure"],
  ["opening_monologue", "what_we_dont_know_yet"],
  ["opening_monologue", "for_hanka"],
  ["opening_monologue", "for_kata"],
  ["opening_monologue", "technical_note"],
  ["last_3_days"],
  ["daily_therapeutic_priority"],
  ["closing"],
  ["lingering"],
  // Yesterday session review (Karel-generated visible texts)
  ["yesterday_session_review", "practical_report_text"],
  ["yesterday_session_review", "karel_summary"],
  ["yesterday_session_review", "implications_for_plan"],
  ["yesterday_session_review", "team_acknowledgement"],
  ["yesterday_session_review", "key_finding_about_part"],
  ["yesterday_session_review", "implications_for_part"],
  ["yesterday_session_review", "implications_for_system"],
  ["yesterday_session_review", "recommendations_for_therapists"],
  ["yesterday_session_review", "recommendations_for_next_session"],
  ["yesterday_session_review", "recommendations_for_next_playroom"],
  // Recent session review mirror
  ["recent_session_review", "practical_report_text"],
  ["recent_session_review", "karel_summary"],
  ["recent_session_review", "implications_for_plan"],
  ["recent_session_review", "team_acknowledgement"],
  // Proposed session
  ["proposed_session", "why_today"],
  ["proposed_session", "first_draft"],
  ["proposed_session", "kata_involvement"],
  // Proposed playroom
  ["proposed_playroom", "why_this_part_today"],
  ["proposed_playroom", "main_theme"],
  ["proposed_playroom", "playroom_plan", "child_safe_version"],
  // Yesterday truth + part proposal sections (added in P20.2)
  ["yesterday_truth", "summary_text"],
  ["today_part_proposal", "rationale_text"],
];

function getByPath(obj: any, path: string[]): any {
  let cur: any = obj;
  for (const k of path) {
    if (cur == null) return undefined;
    cur = cur[k];
  }
  return cur;
}

function setByPath(obj: any, path: string[], value: any): boolean {
  let cur: any = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const k = path[i];
    if (cur == null || typeof cur !== "object") return false;
    if (cur[k] == null || typeof cur[k] !== "object") return false;
    cur = cur[k];
  }
  if (cur == null || typeof cur !== "object") return false;
  cur[path[path.length - 1]] = value;
  return true;
}

/**
 * Collects all visible Karel-generated text refs in the payload.
 * Skips empty / non-string values.
 */
export function collectVisibleBriefingTexts(payload: any): VisibleTextRef[] {
  const out: VisibleTextRef[] = [];
  if (!payload || typeof payload !== "object") return out;
  for (const path of VISIBLE_TEXT_PATHS) {
    const v = getByPath(payload, path);
    if (typeof v === "string" && v.trim().length > 0) {
      out.push({ path: path.join("."), text: v });
    }
  }
  // ask_hanka / ask_kata items (.text)
  for (const role of ["ask_hanka", "ask_kata"]) {
    const arr = (payload as any)[role];
    if (Array.isArray(arr)) {
      arr.forEach((item: any, idx: number) => {
        if (item && typeof item === "object" && typeof item.text === "string" && item.text.trim()) {
          out.push({ path: `${role}[${idx}].text`, text: item.text });
        }
      });
    }
  }
  // proposed_playroom.goals[]
  const goals = (payload as any)?.proposed_playroom?.goals;
  if (Array.isArray(goals)) {
    goals.forEach((g: any, idx: number) => {
      if (typeof g === "string" && g.trim()) out.push({ path: `proposed_playroom.goals[${idx}]`, text: g });
    });
  }
  // proposed_playroom.playroom_plan.therapeutic_program[].block/.detail
  const program = (payload as any)?.proposed_playroom?.playroom_plan?.therapeutic_program;
  if (Array.isArray(program)) {
    program.forEach((b: any, idx: number) => {
      if (b && typeof b === "object") {
        if (typeof b.block === "string" && b.block.trim())
          out.push({ path: `proposed_playroom.playroom_plan.therapeutic_program[${idx}].block`, text: b.block });
        if (typeof b.detail === "string" && b.detail.trim())
          out.push({ path: `proposed_playroom.playroom_plan.therapeutic_program[${idx}].detail`, text: b.detail });
      }
    });
  }
  return out;
}

function setByGenericPath(payload: any, path: string, value: string): boolean {
  // Supports paths like "opening_monologue.greeting" and "ask_hanka[2].text"
  const parts: Array<string | number> = [];
  const re = /([^.\[\]]+)|\[(\d+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(path)) !== null) {
    if (m[1] !== undefined) parts.push(m[1]);
    else if (m[2] !== undefined) parts.push(Number(m[2]));
  }
  let cur: any = payload;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (cur == null) return false;
    cur = cur[k as any];
  }
  if (cur == null) return false;
  cur[parts[parts.length - 1] as any] = value;
  return true;
}

/**
 * MAIN ENTRY POINT.
 *
 * Mutuje payload (sanitizace všech visible cest), vrací audit.
 * Pokud po sanitaci zůstanou violations, vrátí ok=false.
 */
export function runP20ClinicalTruthGate(
  payload: any,
  evidence: ClinicalActivityEvidence | null | undefined,
  partLabel?: string,
): P20GateResult {
  const checked_at = new Date().toISOString();
  const refs = collectVisibleBriefingTexts(payload);
  const scanned_paths = refs.map((r) => r.path);

  if (!evidence) {
    return {
      ok: true,
      scanned_paths,
      sanitized_paths: [],
      violations_before_repair: [],
      violations_after_repair: [],
      evidence_category: null,
      evidence_can_claim_started: null,
      evidence_can_claim_clinical_input: null,
      applied_part_label: partLabel ?? null,
      reason: "no_evidence_provided",
      checked_at,
    };
  }

  // Even if evidence allows started claim, we still scan (no-op for those branches).
  const violations_before_repair: P20GateResult["violations_before_repair"] = [];
  for (const ref of refs) {
    const vs = detectEvidenceGuardViolations(ref.text, evidence);
    for (const v of vs) {
      violations_before_repair.push({
        path: ref.path,
        phrase: v.phrase,
        evidence_category: v.evidence_category,
      });
    }
  }

  // Sanitize each path that needs it (only when can_claim_started === false).
  const sanitized_paths: string[] = [];
  if (!evidence.can_claim_started) {
    for (const ref of refs) {
      const cleaned = sanitizeStartedClaimText(ref.text, evidence, partLabel);
      if (cleaned !== ref.text) {
        const wrote = setByGenericPath(payload, ref.path, cleaned);
        if (wrote) sanitized_paths.push(ref.path);
      }
    }
  }

  // Re-scan after sanitization.
  const refsAfter = collectVisibleBriefingTexts(payload);
  const violations_after_repair: P20GateResult["violations_after_repair"] = [];
  for (const ref of refsAfter) {
    const vs = detectEvidenceGuardViolations(ref.text, evidence);
    for (const v of vs) {
      violations_after_repair.push({
        path: ref.path,
        phrase: v.phrase,
        evidence_category: v.evidence_category,
      });
    }
  }

  const ok = violations_after_repair.length === 0;
  return {
    ok,
    scanned_paths,
    sanitized_paths,
    violations_before_repair,
    violations_after_repair,
    evidence_category: evidence.category,
    evidence_can_claim_started: evidence.can_claim_started,
    evidence_can_claim_clinical_input: evidence.can_claim_clinical_input,
    applied_part_label: partLabel ?? evidence.evidence_summary?.part_name ?? null,
    reason: ok ? null : "p20_clinical_truth_violation",
    checked_at,
  };
}
