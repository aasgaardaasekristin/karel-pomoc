/**
 * Frontend mirror of supabase/functions/_shared/visibleClinicalTextGuard.ts.
 *
 * The edge file is the source of truth (it runs in Deno with .ts extension
 * imports). This file is a clean re-export of the same logic for the React
 * app and Vitest. We duplicate the file content (not a symlink) because Vite
 * does not allow imports outside of `src/` and edge functions cannot import
 * from `src/`.
 *
 * IF YOU CHANGE forbidden lexicons OR replacements: edit BOTH files.
 * The Vitest test `src/test/visibleClinicalTextGuard.test.ts` asserts they
 * stay byte-equal in their lexicons.
 */

export type ClinicalTextGuardCtx = {
  surface: string;
  field?: string;
  actor?: string;
};

export type ClinicalTextViolation = {
  kind: "forbidden_technical_term" | "kostrbata_phrase";
  match: string;
  index: number;
};

export const FORBIDDEN_TECHNICAL_TERMS: string[] = [
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
  "herna modal",
  "block followup",
  "state machine",
  "audit jsonb",
  "merge patch",
  "test_force_",
  "session block",
  "block index",
  "current_block_index",
  "current_block_status",
];

export const FORBIDDEN_KOSTRBATE_PHRASES: string[] = [
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
];

function normalize(text: string): string {
  return text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
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

export function sanitizeClinicalText(input: string | null | undefined): {
  text: string;
  violations: ClinicalTextViolation[];
  replaced: boolean;
} {
  if (input == null) return { text: "", violations: [], replaced: false };
  let text = String(input);
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
