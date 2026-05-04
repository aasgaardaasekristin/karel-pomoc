/**
 * P1: visibleClinicalTextGuard
 *
 * Shared sanitizer + write-time guard for visible clinical text across the app.
 *
 * Two surfaces:
 *   - sanitizeClinicalText(text) — used at render time. NEVER throws. Returns
 *     a cleaned, human-sounding string. Used by panels.
 *   - assertCleanClinicalTextOrThrow(text, ctx) — used at DB write time inside
 *     edge functions. Throws on forbidden technical terms / forbidden
 *     kostrbaté Czech phrases. Fail-closed.
 *
 * Forbidden technical terms (must never appear in clinical-facing text)
 * Forbidden kostrbaté phrases (low-quality machine-translation feel)
 * Required human replacements (terapeuticky znějící CZ formulace)
 *
 * Pure TypeScript — works in Deno (edge fns) and Vitest (jsdom).
 */

export type ClinicalTextGuardCtx = {
  surface: string; // e.g. "did_team_deliberations.program_draft", "herna_modal", "live_session_plan"
  field?: string;
  actor?: string; // "edge:karel-team-deliberation-iterate", "panel:LiveSessionPanel" etc.
};

export type ClinicalTextViolation = {
  kind: "forbidden_technical_term" | "kostrbata_phrase";
  match: string;
  index: number;
};

// --- Forbidden lexicons -----------------------------------------------------

// Technical / system / programming / DB jargon that must never reach a clinical
// surface. Stored as lowercase. Czech accent variants handled via NFD compare.
const FORBIDDEN_TECHNICAL_TERMS: string[] = [
  // Programmer/system jargon
  "json",
  "schema",
  "payload",
  "endpoint",
  "edge function",
  "rpc call",
  "supabase",
  "uuid",
  "null",
  "undefined",
  "object",
  "array",
  "boolean",
  "string",
  "integer",
  "fallback",
  "timeout",
  "retry",
  "queue",
  "dispatcher",
  "orchestrator",
  "pipeline",
  "trigger",
  "rls policy",
  "service role",
  "auth.users",
  "did_",
  "select * from",
  "insert into",
  "update set",
  "merge contract",
  "approval_sync",
  "program_draft",
  "session_params",
  "linked_live_session_id",
  "snapshot id",
  "snapshot_id",
  "mutation snapshot",
  "scope guard",
  "canonical user",
  "canonical_user_id",
  // Internal labels that must not show clinically
  "herna modal",
  "block followup",
  "state machine",
  "audit jsonb",
  "merge patch",
  "test_force_",
  // English clinical-system jargon (use Czech)
  "session block",
  "block index",
  "current_block_index",
  "current_block_status",
  // P16
  "DB review",
  "DB/review",
  "db_review",
];

// P20: Fráze, které smí být použité POUZE pokud evidence_category je
// completed_session nebo started_session. Builder nesmí tato slova vložit
// do visible textu, pokud yesterday_session_review.evidence.can_claim_started=false.
// Tento seznam je čistě dokumentační — runtime guard sedí v
// `clinicalActivityEvidence.ts` → `detectEvidenceGuardViolations`.
export const P20_STARTED_CLAIM_PHRASES_DOCS: string[] = [
  "zahájené Sezení",
  "doložené jako klinický vstup",
  "práce byla zahájená",
  "včerejší otevřené Sezení",
  "navazuje hlavně na včerejší otevřené Sezení",
];

// Kostrbaté / nepřirozené české fráze — strojový překlad / robotická čeština.
const FORBIDDEN_KOSTRBATE_PHRASES: string[] = [
  "provedení akce",
  "iterace nad",
  "v rámci entity",
  "uživatelský identifikátor",
  "validní vstup",
  "nevalidní vstup",
  "zpracování requestu",
  "zpracování dotazu",
  "zpracovat odpověď",
  "vyvolání funkce",
  "spuštění procesu",
  "byl proveden zápis",
  "došlo k zápisu",
  "objekt nebyl nalezen",
  "entita nebyla nalezena",
  "stav byl aktualizován",
  "došlo k aktualizaci stavu",
  "z důvodu chyby",
  "vyhozena výjimka",
  "byla vyvolána chyba",
  "operace selhala",
  "operace proběhla úspěšně",
  "v dané entitě",
  "v dané tabulce",
];

// Optional: human-sounding replacements applied during sanitize().
// Only applied to soft-bad phrases, never to hard-forbidden technical terms.
const HUMAN_REPLACEMENTS: Array<{ from: RegExp; to: string }> = [
  { from: /\boperace selhala\b/giu, to: "nepovedlo se to" },
  { from: /\boperace proběhla úspěšně\b/giu, to: "podařilo se to" },
  { from: /\bdošlo k aktualizaci stavu\b/giu, to: "stav se změnil" },
  { from: /\bstav byl aktualizován\b/giu, to: "stav se změnil" },
  { from: /\bdošlo k zápisu\b/giu, to: "uložilo se to" },
  { from: /\bbyl proveden zápis\b/giu, to: "uložilo se to" },
  { from: /\bz důvodu chyby\b/giu, to: "kvůli chybě" },
  { from: /\bvyhozena výjimka\b/giu, to: "došlo k chybě" },
  { from: /\bbyla vyvolána chyba\b/giu, to: "došlo k chybě" },
  { from: /\bzpracování requestu\b/giu, to: "zpracování dotazu" },
  { from: /\bvalidní vstup\b/giu, to: "platný vstup" },
  { from: /\bnevalidní vstup\b/giu, to: "neplatný vstup" },
  { from: /\bv rámci entity\b/giu, to: "u záznamu" },
  { from: /\bv dané entitě\b/giu, to: "u záznamu" },
  { from: /\bv dané tabulce\b/giu, to: "v záznamech" },
  { from: /\bobjekt nebyl nalezen\b/giu, to: "záznam se nenašel" },
  { from: /\bentita nebyla nalezena\b/giu, to: "záznam se nenašel" },
  { from: /\bspuštění procesu\b/giu, to: "spuštění" },
  { from: /\bvyvolání funkce\b/giu, to: "spuštění" },
  // P16: legacy "DB review" → human Czech
  { from: /\bz\s+DB\s+review\b/giu, to: "z dřívějšího záznamu" },
  { from: /\bDB\s+review\b/giu, to: "dřívější záznam" },
];

// --- Helpers ----------------------------------------------------------------

function normalize(text: string): string {
  // NFD strips diacritics for case-insensitive scanning of forbidden terms.
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function findAll(haystackRaw: string, needles: string[]): Array<{ match: string; index: number }> {
  const haystack = normalize(haystackRaw);
  const hits: Array<{ match: string; index: number }> = [];
  for (const needle of needles) {
    const n = normalize(needle);
    if (!n) continue;
    let from = 0;
    while (true) {
      const idx = haystack.indexOf(n, from);
      if (idx < 0) break;
      hits.push({ match: needle, index: idx });
      from = idx + n.length;
    }
  }
  return hits;
}

// --- Public API -------------------------------------------------------------

export function detectClinicalTextViolations(text: string): ClinicalTextViolation[] {
  if (!text || typeof text !== "string") return [];
  const violations: ClinicalTextViolation[] = [];
  for (const h of findAll(text, FORBIDDEN_TECHNICAL_TERMS)) {
    violations.push({ kind: "forbidden_technical_term", match: h.match, index: h.index });
  }
  for (const h of findAll(text, FORBIDDEN_KOSTRBATE_PHRASES)) {
    violations.push({ kind: "kostrbata_phrase", match: h.match, index: h.index });
  }
  return violations;
}

/**
 * Render-time sanitize. NEVER throws. Applies human replacements for
 * kostrbaté phrases. Does NOT silently strip hard-forbidden technical terms —
 * those are flagged in returned `violations` so the panel can show a
 * fallback message instead of leaking jargon.
 */
export function sanitizeClinicalText(input: string | null | undefined): {
  text: string;
  violations: ClinicalTextViolation[];
  replaced: boolean;
} {
  if (input == null) return { text: "", violations: [], replaced: false };
  const original = String(input);
  let text = original;
  let replaced = false;
  for (const rule of HUMAN_REPLACEMENTS) {
    if (rule.from.test(text)) {
      text = text.replace(rule.from, rule.to);
      replaced = true;
    }
  }
  const violations = detectClinicalTextViolations(text);
  return { text, violations, replaced };
}

/**
 * Write-time guard. THROWS on hard-forbidden technical terms or kostrbaté
 * phrases. Used inside edge functions before persisting a row.
 */
export class ClinicalTextGuardError extends Error {
  public readonly code = "VISIBLE_CLINICAL_TEXT_FORBIDDEN" as const;
  public readonly violations: ClinicalTextViolation[];
  public readonly ctx: ClinicalTextGuardCtx;
  constructor(violations: ClinicalTextViolation[], ctx: ClinicalTextGuardCtx) {
    super(
      `VISIBLE_CLINICAL_TEXT_FORBIDDEN at ${ctx.surface}${ctx.field ? "." + ctx.field : ""} — ${violations
        .map((v) => `${v.kind}:"${v.match}"`)
        .join(", ")}`,
    );
    this.violations = violations;
    this.ctx = ctx;
  }
}

export function assertCleanClinicalTextOrThrow(
  text: string | null | undefined,
  ctx: ClinicalTextGuardCtx,
): void {
  if (text == null || text === "") return;
  const violations = detectClinicalTextViolations(String(text));
  if (violations.length > 0) {
    throw new ClinicalTextGuardError(violations, ctx);
  }
}

/**
 * Convenience: walk all string leaves in a JSON-like value and assert each one.
 * Useful for `program_draft`, `session_params`, etc.
 */
export function assertCleanClinicalJsonOrThrow(
  value: unknown,
  ctx: ClinicalTextGuardCtx,
  path: string[] = [],
): void {
  if (value == null) return;
  if (typeof value === "string") {
    assertCleanClinicalTextOrThrow(value, {
      ...ctx,
      field: ctx.field ? `${ctx.field}${path.length ? "." + path.join(".") : ""}` : path.join("."),
    });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertCleanClinicalJsonOrThrow(v, ctx, [...path, String(i)]));
    return;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      assertCleanClinicalJsonOrThrow(v, ctx, [...path, k]);
    }
  }
}
