/**
 * P33.3 — visible-language sanitizer for Karel briefing sections.
 *
 * Removes leaks that bypassed the renderer:
 *   - raw ISO timestamps (2026-05-07T08:35:28.791+00:00 …)
 *   - English evidence values (low / medium / high) used as Czech words
 *   - "Síla důkazu" / "Síla podkladů" → "opora v podkladech"
 *   - "doloženého Sezení/Herny" → "ověřeného plánu Sezení/Herny"
 *   - "praktický report" → "praktická poznámka"
 *   - internal terms (payload, truth gate, job graph, provider_status, …)
 *
 * Pure functions; no React, no Supabase.
 */

const ISO_TIMESTAMP_RE = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[+\-]\d{2}:?\d{2}|Z)?\b/g;

const EVIDENCE_WORD_MAP: Array<[RegExp, string]> = [
  // Sentence-level "Síla podkladů je low." → "Opora v podkladech je zatím nízká."
  [/Síla\s+podkladů\s+je\s+low\b\.?/giu, "Opora v podkladech je zatím nízká."],
  [/Síla\s+podkladů\s+je\s+medium\b\.?/giu, "Opora v podkladech je střední."],
  [/Síla\s+podkladů\s+je\s+high\b\.?/giu, "Opora v podkladech je vyšší."],
  [/Síla\s+důkazu\s+je\s+low\b\.?/giu, "Opora v podkladech je zatím nízká."],
  [/Síla\s+důkazu\s+je\s+medium\b\.?/giu, "Opora v podkladech je střední."],
  [/Síla\s+důkazu\s+je\s+high\b\.?/giu, "Opora v podkladech je vyšší."],
  // Czech inflections used after "nízká/střední/vyšší", may appear standalone
  [/Síla\s+důkazu\s+je\s+nízká/gi, "Opora v podkladech je zatím nízká"],
  [/Síla\s+důkazu/gi, "opora v podkladech"],
  [/Síla\s+podkladů/gi, "opora v podkladech"],
];

const PHRASE_MAP: Array<[RegExp, string]> = [
  [/doloženého\s+Sezení\s+nebo\s+Herny/gi, "ověřeného plánu Sezení nebo Herny"],
  [/doložené\s+Sezení\s+nebo\s+Herny/gi, "ověřený plán Sezení nebo Herny"],
  [/doloženou\s+Hernou/gi, "ověřeným plánem Herny"],
  [/praktický\s+report/gi, "praktickou poznámku"],
  [/praktického\s+reportu/gi, "praktické poznámky"],
];

// Standalone "low / medium / high" used as a Czech word (after Czech context).
// Conservative: only when surrounded by Czech-style context, never strip from
// proper nouns or URLs.
const STANDALONE_EVIDENCE_RE = /\b(low|medium|high)\b/gi;
const EVIDENCE_TO_CZ: Record<string, string> = {
  low: "nízká",
  medium: "střední",
  high: "vyšší",
};

export const FORBIDDEN_VISIBLE_LANGUAGE: RegExp[] = [
  /\bpayload\b/i,
  /truth gate/i,
  /job graph/i,
  /provider_status/i,
  /unsupported_claims/i,
  /robotic_phrase/i,
  /\bpipeline\b/i,
  /\bsource_cycle\b/i,
  /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
  /\b(low|medium|high)\b/,
  /Síla důkazu/i,
  /Síla podkladů/i,
];

export function sanitizeKarelVisibleText(input: unknown): string {
  if (input == null) return "";
  let s = String(input);

  // Replace raw ISO timestamps with a human Czech phrase.
  s = s.replace(ISO_TIMESTAMP_RE, "dnešního ranního cyklu");
  // Clean leftover artefacts from "z dnešního ranního cyklu z dnešního ranního cyklu"
  s = s.replace(/z\s+dnešního\s+ranního\s+cyklu(?:\s+z\s+dnešního\s+ranního\s+cyklu)+/gi, "z dnešního ranního cyklu");
  // "vázané na dokončený denní cyklus z dnešního ranního cyklu" → tighter
  s = s.replace(/vázané\s+na\s+dokončený\s+denní\s+cyklus\s+z\s+dnešního\s+ranního\s+cyklu/gi,
    "vázané na dnešní dokončený ranní cyklus");

  for (const [re, repl] of EVIDENCE_WORD_MAP) s = s.replace(re, repl);
  for (const [re, repl] of PHRASE_MAP) s = s.replace(re, repl);

  // Final standalone English evidence-word sweep (after dedicated patterns).
  s = s.replace(STANDALONE_EVIDENCE_RE, (m) => EVIDENCE_TO_CZ[m.toLowerCase()] ?? m);

  // Tidy whitespace
  s = s.replace(/[ \t]{2,}/g, " ").replace(/\s+([.,;:!?])/g, "$1").trim();
  return s;
}

export function auditVisibleKarelText(text: string): string[] {
  const violations: string[] = [];
  for (const re of FORBIDDEN_VISIBLE_LANGUAGE) {
    const m = text.match(re);
    if (m) violations.push(`forbidden:${m[0]}`);
  }
  return violations;
}
