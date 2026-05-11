/**
 * P33.6 — Edge mirror of src/lib/karelVisibleTextQuality.ts (1:1).
 *
 * Deno-side copy. Both files MUST stay in sync.
 */

export interface VisibleTextQualityResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

const HARD_FORBIDDEN: Array<{ re: RegExp; label: string }> = [
  { re: /\bAI polish\b/i, label: "AI polish" },
  { re: /\bTechnick[\u00e9\u011b] podklady\b/i, label: "Technick\u00e9 podklady" },
  { re: /\baudit\b/i, label: "audit" },
  { re: /\bpayload\b/i, label: "payload" },
  { re: /truth\s*gate/i, label: "truth gate" },
  { re: /job\s*graph/i, label: "job graph" },
  { re: /provider_status/i, label: "provider_status" },
  { re: /query_plan_version/i, label: "query_plan_version" },
  { re: /source_cycle_id/i, label: "source_cycle_id" },
  { re: /unsupported_claims/i, label: "unsupported_claims" },
  { re: /robotic_phrase/i, label: "robotic_phrase" },
  { re: /\.\./, label: "double_period" },
  { re: /,,/, label: "double_comma" },
  { re: /\b00[0-9]_[A-Za-z\u00c1-\u017d\u00e1-\u017e]/, label: "technical_part_prefix" },
  { re: /dolo[\u017ez]en[\u00fdy]\s+praktickou/i, label: "dolozeny_praktickou" },
  { re: /opora\s+v\s+podklade?ch\s+je\s+n[\u00ed\u00ec]zk[\u00e1a]/i, label: "opora_je_nizka" },
  { re: /S[\u00ed\u00ec]la\s+(?:d[\u016f\u00fa]kazu|podklad[\u016f\u00fa])\s+je\s+n[\u00ed\u00ec]zk[\u00e1a]/i, label: "sila_je_nizka" },
  { re: /n[\u00e1a]vrh\s+na\s+dne[\u0161s]n[\u00ed\u00ec]\s+[\u010dc][\u00e1a]st\s+je\s+00[0-9]_/i, label: "navrh_002_prefix" },
  { re: /podle\s+posledn[\u00ed\u00ec]ho\s+p[\u0159r]esn[\u011be]\s+datovan[\u00e9e]ho\s+review/i, label: "datovaneho_review" },
  { re: /m[\u016f\u00fa][\u017ez]e\s+dnes\s+zat[\u00ed\u00ec][\u017ez]it/i, label: "muze_dnes_zatizit" },
  { re: /dnes\s+se\s+objevilo/i, label: "dnes_se_objevilo" },
  { re: /dne[\u0161s]n[\u00ed\u00ec]\s+ud[\u00e1a]lost/i, label: "dnesni_udalost" },
];

const SOFT_WARNINGS: Array<{ re: RegExp; label: string }> = [
  { re: /\b(low|medium|high)\b/i, label: "english_evidence_word" },
];

export function auditVisibleKarelText(text: string | null | undefined): VisibleTextQualityResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const t = String(text ?? "");
  if (!t.trim()) return { ok: true, errors, warnings };
  for (const { re, label } of HARD_FORBIDDEN) if (re.test(t)) errors.push(`forbidden:${label}`);
  for (const { re, label } of SOFT_WARNINGS) if (re.test(t)) warnings.push(`warning:${label}`);
  return { ok: errors.length === 0, errors, warnings };
}

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
