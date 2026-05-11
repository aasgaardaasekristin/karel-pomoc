/**
 * P33.6 — Visible Karel text quality gate.
 *
 * Deterministic Czech-language audit applied to any text intended for the
 * therapist-facing Karel briefing surface. Pure function, no React, no
 * Supabase, mirrored from `supabase/functions/_shared/karelVisibleTextQuality.ts`
 * (kept identical so renderer and UI agree).
 *
 * Returns errors that BLOCK display, plus warnings that downgrade confidence.
 */

export interface VisibleTextQualityResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

/** Phrases / patterns that must NEVER appear in normal therapist UI. */
const HARD_FORBIDDEN: Array<{ re: RegExp; label: string }> = [
  { re: /\bAI polish\b/i, label: "AI polish" },
  { re: /\bTechnick[ée] podklady\b/i, label: "Technické podklady" },
  { re: /\baudit\b/i, label: "audit" },
  { re: /\bpayload\b/i, label: "payload" },
  { re: /truth\s*gate/i, label: "truth gate" },
  { re: /job\s*graph/i, label: "job graph" },
  { re: /provider_status/i, label: "provider_status" },
  { re: /query_plan_version/i, label: "query_plan_version" },
  { re: /source_cycle_id/i, label: "source_cycle_id" },
  { re: /unsupported_claims/i, label: "unsupported_claims" },
  { re: /robotic_phrase/i, label: "robotic_phrase" },
  // double punctuation
  { re: /\.\./, label: "double_period" },
  { re: /,,/, label: "double_comma" },
  // technical part prefixes
  { re: /\b00[0-9]_[A-Za-zÁ-Žá-ž]/, label: "technical_part_prefix" },
  // ungrammatical / robotic Czech currently visible
  { re: /dolo[žz]en[ýy]\s+praktickou/i, label: "dolozeny_praktickou" },
  { re: /opora\s+v\s+podklade?ch\s+je\s+n[ií]zk[áa]/i, label: "opora_je_nizka" },
  { re: /S[ií]la\s+(?:d[ůu]kazu|podklad[ůu])\s+je\s+n[ií]zk[áa]/i, label: "sila_je_nizka" },
  { re: /n[áa]vrh\s+na\s+dne[šs]n[ií]\s+[čc][áa]st\s+je\s+00[0-9]_/i, label: "navrh_002_prefix" },
  { re: /podle\s+posledn[ií]ho\s+p[řr]esn[ěe]\s+datovan[ée]ho\s+review/i, label: "datovaneho_review" },
  // false today-event language for tier2/3 contexts
  { re: /m[ůu][žz]e\s+dnes\s+zat[ií][žz]it/i, label: "muze_dnes_zatizit" },
  { re: /dnes\s+se\s+objevilo/i, label: "dnes_se_objevilo" },
  { re: /dne[šs]n[ií]\s+ud[áa]lost/i, label: "dnesni_udalost" },
  { re: /nem[áa]m\s+u\s+sebe\s+podrobn[ěe]j[šs][íi]\s+p[řr]ehled/i, label: "false_missing_phase_detail" },
];

const LOWERCASE_PART_NAME_RE = /(^|[^\p{L}])(?:arthur|tundrupek)(?=$|[^\p{L}])/iu;

/** Soft warnings — degrade confidence but don't block. */
const SOFT_WARNINGS: Array<{ re: RegExp; label: string }> = [
  { re: /\b(low|medium|high)\b/i, label: "english_evidence_word" },
  { re: /\bSezen[ií]\b.*\bdoloz/i, label: "doloz_session_phrase" },
];

export function auditVisibleKarelText(text: string | null | undefined): VisibleTextQualityResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const t = String(text ?? "");
  if (!t.trim()) {
    return { ok: true, errors, warnings };
  }
  for (const { re, label } of HARD_FORBIDDEN) {
    if (re.test(t)) errors.push(`forbidden:${label}`);
  }
  if (LOWERCASE_PART_NAME_RE.test(t)) errors.push("forbidden:lowercase_part_name");
  for (const { re, label } of SOFT_WARNINGS) {
    if (re.test(t)) warnings.push(`warning:${label}`);
  }
  return { ok: errors.length === 0, errors, warnings };
}

/** Convenience: audit a list of section texts and return aggregate verdict. */
export function auditVisibleKarelSections(
  sections: Array<{ section_id?: string; karel_text?: string }>,
): VisibleTextQualityResult & { per_section: Record<string, VisibleTextQualityResult> } {
  const per_section: Record<string, VisibleTextQualityResult> = {};
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const s of sections) {
    const id = s.section_id || "unknown";
    const r = auditVisibleKarelText(s.karel_text || "");
    per_section[id] = r;
    for (const e of r.errors) errors.push(`${id}:${e}`);
    for (const w of r.warnings) warnings.push(`${id}:${w}`);
  }
  return { ok: errors.length === 0, errors, warnings, per_section };
}
