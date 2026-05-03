/**
 * P1: visibleClinicalTextGuard (frontend)
 *
 * Frontend mirror of supabase/functions/_shared/visibleClinicalTextGuard.ts
 * (edge file is source of truth for write-time guard; this file is the
 * source of truth for render-time UI).
 *
 * Surfaces:
 *   - sanitizeVisibleClinicalText(text, context?)        — generic sanitize
 *   - sanitizeBriefingVisibleText(text)                  — Karlův přehled
 *   - sanitizeDeliberationVisibleText(text)              — Porady (team deliberation)
 *   - sanitizeHernaVisibleText(text)                     — Herna modal (DeliberationRoom in DID kids context)
 *   - sanitizeLiveSessionVisibleText(text)               — Live session
 *   - detectClinicalTextViolations(text, context?)
 *   - countVisibleForbiddenTerms(text, context?)
 *   - visibleTextQualityAudit(text, context?)
 *   - <SafeClinicalText surface="..." as="span">text</SafeClinicalText>
 *   - useVisibleClinicalTextAudit(panelName, ref, options)
 *
 * Context-aware: surface "herna" treats "Živý program sezení" as forbidden,
 * surface "team-deliberation" treats "Změna plánu: beze změny" as forbidden
 * in replan/in_revision context, etc. Negation cues ("ne jako projekce",
 * "ne jako symbol") are allowed even though their bare positive form would
 * be flagged.
 *
 * IMPORTANT: This file is intentionally side-effect-free outside the React
 * hook. Pure helpers usable from any module + Vitest.
 */

import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import * as React from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ClinicalSurface =
  | "generic"
  | "briefing"
  | "team-deliberation"
  | "herna-modal"
  | "live-session";

export type ClinicalTextGuardCtx = {
  surface: ClinicalSurface | string;
  field?: string;
  actor?: string;
  /**
   * For team-deliberation, set to "replan" or "in_revision" to forbid
   * "Změna plánu: beze změny" copy in those statuses.
   */
  status?: string;
  /** For herna-modal, set true when herna is not yet approved. */
  hernaUnapproved?: boolean;
};

export type ClinicalViolationKind =
  | "forbidden_technical_term"
  | "kostrbata_phrase"
  | "context_forbidden_label"
  | "ungrounded_clinical_assertion";

export type ClinicalTextViolation = {
  kind: ClinicalViolationKind;
  match: string;
  index: number;
  surface?: string;
  field?: string;
};

// ---------------------------------------------------------------------------
// Forbidden lexicons (kept in sync with edge file lexicons + the explicit
// list given in the P1 prompt)
// ---------------------------------------------------------------------------

export const FORBIDDEN_TECHNICAL_TERMS: string[] = [
  // P1 prompt list
  "backend",
  "pipeline",
  "source_ref",
  "source_kind",
  "Pantry",
  "karel_pantry_b_entries",
  "DID-relevantní",
  "ingestion",
  "event_ingestion",
  "program_draft",
  "session_params",
  "first_draft",
  "Karel-led",
  "pending_review",
  "evidence_limited",
  "child evidence",
  "operational context",
  "operační kontext",
  "backend_context_inputs",
  "Bezformátový program",
  // Programmer/system jargon (kept from previous file)
  "json",
  "schema",
  "payload",
  "endpoint",
  "edge function",
  "rpc call",
  "supabase",
  "uuid",
  "undefined",
  "fallback",
  "timeout",
  "retry",
  "queue",
  "dispatcher",
  "orchestrator",
  "trigger",
  "rls policy",
  "service role",
  "auth.users",
  "did_event_ingestion_log",
  "did_team_deliberations",
  "did_daily_session_plans",
  "did_daily_briefings",
  "select * from",
  "insert into",
  "update set",
  "merge contract",
  "approval_sync",
  "linked_live_session_id",
  "snapshot id",
  "snapshot_id",
  "mutation snapshot",
  "scope guard",
  "canonical_user_id",
  "block followup",
  "state machine",
  "audit jsonb",
  "merge patch",
  "test_force_",
  "current_block_index",
  "current_block_status",
  // P11: external-reality classifier labels must never reach a clinical surface
  "animal_suffering",
  "rescue_failure",
  "broken_promise",
  "child_abuse",
  "identity_link",
  "injustice",
  "external_reality_events",
  "external_event_impacts",
  "part_external_event_sensitivities",
  "created_task_id",
  "(typy:",
  "(types:",
  // P12: morning briefing truthfulness — these strings must NEVER reach UI.
  "SLA záplata",
  "(SLA záplata)",
  "Aktuální (SLA",
  "Aktuální (auto)",
  "Aktuální (manuální)",
  "Limitovaný ranní přehled",
  "DB/Pantry",
  "DB/Pantry/Event-ingestion",
  "Event-ingestion",
  "daily_cycle_status",
  "generation_method",
  "limited_reason",
  "sla_watchdog_repair",
  // P16: technical phrases that previously leaked into Karlův přehled
  "DB review",
  "DB/review",
  "db_review",
];

const HUMAN_REPLACEMENTS_DB_REVIEW: Array<{ from: RegExp; to: string }> = [
  { from: /\bz\s+DB\s+review\b/giu, to: "z dřívějšího záznamu" },
  { from: /\bDB\s+review\b/giu, to: "dřívější záznam" },
];

export const FORBIDDEN_KOSTRBATE_PHRASES: string[] = [
  // P1 prompt awkward phrases
  "Herna je vedená Karlem práce",
  "Používá důležitý kontext z posledních dní",
  "Co je jen stopa v datech",
  "Zohlednit v nejbližším plánování",
  "Zohlednit ve follow-upu",
  "nepoužije se plán terapeutického sezení ani pracovní návrh",
  // Existing kostrbaté
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

/**
 * Unicode-aware "word boundary" alternative. JavaScript's `\b` is ASCII-only
 * and breaks for Czech (Ž, í, á, etc.) when used together with the `u` flag,
 * so we use Unicode property escape lookarounds instead.
 */
function wb(literalSource: string, flags = "giu"): RegExp {
  const escaped = literalSource.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, flags);
}

/**
 * Soft replacements applied during sanitize() — they fix kostrbatá fráze
 * and the most common "robotic-Karel" leakages so that the visible string
 * is human and auditable.
 */
const HUMAN_REPLACEMENTS: Array<{ from: RegExp; to: string }> = [
  // P1 explicit replacements
  { from: wb("Herna je vedená Karlem práce"), to: "Hernu vede Karel" },
  { from: wb("Používá důležitý kontext z posledních dní"), to: "Vychází z toho, co se v posledních dnech opravdu stalo" },
  { from: wb("Co je jen stopa v datech"), to: "Co se zatím jen mihlo a chce ověřit" },
  { from: wb("Zohlednit v nejbližším plánování"), to: "Vrátit se k tomu při nejbližším plánu" },
  { from: wb("Zohlednit ve follow-upu"), to: "Vrátit se k tomu při dalším kontaktu" },
  {
    from: wb("nepoužije se plán terapeutického sezení ani pracovní návrh"),
    to: "dnes Sezení ani jeho návrh nebudeme používat",
  },
  { from: wb("Bezformátový program"), to: "Program zatím nemá pevnou strukturu" },
  // Internal/system labels that sometimes leak into prose
  { from: wb("program_draft"), to: "návrh programu" },
  { from: wb("first_draft"), to: "první návrh" },
  { from: wb("session_params"), to: "parametry sezení" },
  { from: wb("backend_context_inputs"), to: "kontext z posledních dní" },
  { from: wb("operational context"), to: "kontext z posledních dní" },
  { from: wb("operační kontext"), to: "kontext z posledních dní" },
  { from: wb("pending_review"), to: "otevřené nebo částečně rozpracované" },
  { from: wb("evidence_limited"), to: "zatím jen částečně doložené" },
  { from: wb("child evidence"), to: "vlastní reakce kluků" },
  { from: wb("Karel-led"), to: "vede Karel" },
  { from: wb("DID-relevantní"), to: "důležité pro kluky" },
  // Soft-replace technical "Fallback" labels into human Czech.
  // Order: more specific multi-word forms first, then standalone term.
  { from: /\bFallbacky\s*:/giu, to: "Když to nejde:" },
  { from: /\bFallback\s*:/giu, to: "Když to nejde:" },
  { from: /\bFallbackem je\b/giu, to: "Záložní postup je" },
  { from: /\bfallback(?:em|u|y|ů)?\b/giu, to: "záložní postup" },
  { from: wb("Fallback"), to: "záložní postup" },
  // Existing kostrbaté
  { from: wb("operace selhala"), to: "nepovedlo se to" },
  { from: wb("operace proběhla úspěšně"), to: "podařilo se to" },
  { from: wb("došlo k aktualizaci stavu"), to: "stav se změnil" },
  { from: wb("stav byl aktualizován"), to: "stav se změnil" },
  { from: wb("došlo k zápisu"), to: "uložilo se to" },
  { from: wb("byl proveden zápis"), to: "uložilo se to" },
  { from: wb("z důvodu chyby"), to: "kvůli chybě" },
  { from: wb("vyhozena výjimka"), to: "došlo k chybě" },
  { from: wb("byla vyvolána chyba"), to: "došlo k chybě" },
  { from: wb("zpracování requestu"), to: "zpracování dotazu" },
  { from: wb("validní vstup"), to: "platný vstup" },
  { from: wb("nevalidní vstup"), to: "neplatný vstup" },
  { from: wb("v rámci entity"), to: "u záznamu" },
  { from: wb("v dané entitě"), to: "u záznamu" },
  { from: wb("v dané tabulce"), to: "v záznamech" },
  { from: wb("objekt nebyl nalezen"), to: "záznam se nenašel" },
  { from: wb("entita nebyla nalezena"), to: "záznam se nenašel" },
  { from: wb("spuštění procesu"), to: "spuštění" },
  { from: wb("vyvolání funkce"), to: "spuštění" },
];

// Context-conditional forbidden labels (only forbidden in some surfaces /
// statuses).
const CONTEXT_FORBIDDEN_LABELS: Array<{
  needle: RegExp;
  match: string;
  appliesTo: (ctx: ClinicalTextGuardCtx) => boolean;
}> = [
  {
    needle: wb("Živý program sezení", "iu"),
    match: "Živý program sezení",
    appliesTo: (ctx) => ctx.surface === "herna-modal",
  },
  {
    needle: /(?<![\p{L}\p{N}_])Změna plánu:\s*beze změny(?![\p{L}\p{N}_])/iu,
    match: "Změna plánu: beze změny",
    appliesTo: (ctx) =>
      ctx.surface === "team-deliberation" &&
      (ctx.status === "replan" || ctx.status === "in_revision"),
  },
  {
    needle: /(?<![\p{L}\p{N}_])Vyžaduje terapeutku:\s*Ne(?![\p{L}\p{N}_])/iu,
    match: "Vyžaduje terapeutku: Ne",
    appliesTo: (ctx) => ctx.surface === "herna-modal" && ctx.hernaUnapproved === true,
  },
];

/**
 * Negation guards: positive clinical assertions that should be flagged as
 * "ungrounded_clinical_assertion" UNLESS they appear in a negated form
 * ("ne jako projekce", "nedělat závěr bez reakce kluků" etc.).
 *
 * The list is intentionally small — only the well-known interpretive
 * vocabulary that real Karel UIs already misused.
 */
const POSITIVE_ASSERTION_PATTERNS: Array<{
  positive: RegExp;
  match: string;
  /**
   * Sentence-level negation cues: if any of these appears anywhere in the
   * SAME sentence as the match, the match is treated as a safe negated /
   * instructional formulation and is NOT counted as a violation.
   */
  negationAllowed: RegExp[];
}> = [
  {
    positive: /\bje to projekce\b/iu,
    match: "je to projekce",
    negationAllowed: [
      /\bne jako projekce\b/iu,
      /\bnení to projekce\b/iu,
      /\bnedělat\b[^.!?]*\bprojekc/iu,
      /\bneuzavírat\b[^.!?]*\bprojekc/iu,
      /\bnesmí\b[^.!?]*\bprojekc/iu,
    ],
  },
  {
    positive: /\bsymbolizuje\b/iu,
    match: "symbolizuje",
    negationAllowed: [
      /\bne jako symbol\b/iu,
      /\bnesymbolizuje\b/iu,
      /\bnedělat\b[^.!?]*\bsymbol/iu,
      /\bnesmí\b[^.!?]*\bsymbolick/iu,
    ],
  },
  {
    positive: /\bdiagnostick[ýéaáíé]+\s+(sign[áa]l|z[áa]věr)\b/iu,
    match: "diagnostický signál",
    negationAllowed: [
      /\bne jako\b[^.!?]*\bdiagnostick/iu,
      /\bnesmí\b[^.!?]*\bdiagnostick/iu,
      /\bnedělat\b[^.!?]*\bdiagnostick/iu,
      /\bneuzavírat\b[^.!?]*\bdiagnostick/iu,
      /\bnení to diagnostick/iu,
      /\bnejde o diagnostick/iu,
      /\bbez přímé reakce\b/iu,
      /\bbez vlastních slov kluků\b/iu,
      /\bnepoužívat jako\b/iu,
      /\bsymbolick[ýé]\s+nebo\s+diagnostick/iu,
    ],
  },
];

/**
 * Returns the sentence containing the match `index` (walks back to the
 * previous .!?/newline and forward to the next). Used to evaluate negation
 * cues at sentence scope rather than a fixed 40-char window.
 */
function sentenceWindowAround(text: string, index: number, matchLen: number): string {
  let start = 0;
  for (let i = index - 1; i >= 0; i--) {
    if (/[.!?\n]/.test(text[i] ?? "")) { start = i + 1; break; }
  }
  let end = text.length;
  for (let i = index + matchLen; i < text.length; i++) {
    if (/[.!?\n]/.test(text[i] ?? "")) { end = i + 1; break; }
  }
  return text.slice(start, end);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

export function detectClinicalTextViolations(
  text: string,
  ctx: ClinicalTextGuardCtx = { surface: "generic" },
): ClinicalTextViolation[] {
  if (!text || typeof text !== "string") return [];
  const violations: ClinicalTextViolation[] = [];
  for (const h of findAll(text, FORBIDDEN_TECHNICAL_TERMS)) {
    violations.push({
      kind: "forbidden_technical_term",
      match: h.match,
      index: h.index,
      surface: String(ctx.surface),
      field: ctx.field,
    });
  }
  for (const h of findAll(text, FORBIDDEN_KOSTRBATE_PHRASES)) {
    violations.push({
      kind: "kostrbata_phrase",
      match: h.match,
      index: h.index,
      surface: String(ctx.surface),
      field: ctx.field,
    });
  }
  for (const rule of CONTEXT_FORBIDDEN_LABELS) {
    if (!rule.appliesTo(ctx)) continue;
    const m = rule.needle.exec(text);
    if (m && typeof m.index === "number") {
      violations.push({
        kind: "context_forbidden_label",
        match: rule.match,
        index: m.index,
        surface: String(ctx.surface),
        field: ctx.field,
      });
    }
  }
  for (const rule of POSITIVE_ASSERTION_PATTERNS) {
    const globalRe = new RegExp(rule.positive.source, rule.positive.flags.includes("g") ? rule.positive.flags : rule.positive.flags + "g");
    let m: RegExpExecArray | null;
    while ((m = globalRe.exec(text)) !== null) {
      const idx = m.index ?? 0;
      const sentence = sentenceWindowAround(text, idx, rule.match.length);
      const negated = rule.negationAllowed.some((nr) => nr.test(sentence));
      if (negated) continue;
      violations.push({
        kind: "ungrounded_clinical_assertion",
        match: rule.match,
        index: idx,
        surface: String(ctx.surface),
        field: ctx.field,
      });
    }
  }
  return violations;
}

export function countVisibleForbiddenTerms(
  text: string,
  ctx: ClinicalTextGuardCtx = { surface: "generic" },
): number {
  return detectClinicalTextViolations(text, ctx).length;
}

// ---------------------------------------------------------------------------
// Sanitize (render-time, never throws)
// ---------------------------------------------------------------------------

export type SanitizeResult = {
  text: string;
  violations: ClinicalTextViolation[];
  replaced: boolean;
};

export function sanitizeVisibleClinicalText(
  input: string | null | undefined,
  ctx: ClinicalTextGuardCtx = { surface: "generic" },
): SanitizeResult {
  if (input == null) return { text: "", violations: [], replaced: false };
  let text = String(input);
  let replaced = false;
  for (const rule of HUMAN_REPLACEMENTS) {
    if (rule.from.test(text)) {
      text = text.replace(rule.from, rule.to);
      replaced = true;
    }
  }
  const violations = detectClinicalTextViolations(text, ctx);
  return { text, violations, replaced };
}

/** Backwards-compatible alias kept for existing imports. */
export function sanitizeClinicalText(
  input: string | null | undefined,
): SanitizeResult {
  return sanitizeVisibleClinicalText(input, { surface: "generic" });
}

// Panel-specific wrappers — same engine, surface-tagged for telemetry +
// context-aware label rules.
export const sanitizeBriefingVisibleText = (text: string | null | undefined) =>
  sanitizeVisibleClinicalText(text, { surface: "briefing" }).text;

export const sanitizeDeliberationVisibleText = (
  text: string | null | undefined,
  status?: string,
) => sanitizeVisibleClinicalText(text, { surface: "team-deliberation", status }).text;

export const sanitizeHernaVisibleText = (
  text: string | null | undefined,
  hernaUnapproved?: boolean,
) => sanitizeVisibleClinicalText(text, { surface: "herna-modal", hernaUnapproved }).text;

export const sanitizeLiveSessionVisibleText = (text: string | null | undefined) =>
  sanitizeVisibleClinicalText(text, { surface: "live-session" }).text;

export function visibleTextQualityAudit(
  text: string,
  ctx: ClinicalTextGuardCtx = { surface: "generic" },
): {
  ok: boolean;
  forbidden_count: number;
  violations: ClinicalTextViolation[];
} {
  const violations = detectClinicalTextViolations(text, ctx);
  return { ok: violations.length === 0, forbidden_count: violations.length, violations };
}

// ---------------------------------------------------------------------------
// Write-time guard (kept for parity; UI usually does not throw)
// ---------------------------------------------------------------------------

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
  const violations = detectClinicalTextViolations(String(text), ctx);
  if (violations.length > 0) {
    throw new ClinicalTextGuardError(violations, ctx);
  }
}

// ---------------------------------------------------------------------------
// React surface
// ---------------------------------------------------------------------------

export type SafeClinicalTextProps = {
  children: ReactNode;
  surface?: ClinicalSurface | string;
  field?: string;
  status?: string;
  hernaUnapproved?: boolean;
  as?: "span" | "div" | "p" | "h1" | "h2" | "h3" | "h4" | "li" | "strong" | "em";
  className?: string;
  style?: CSSProperties;
};

/**
 * Render-time safe wrapper. If `children` is a plain string (or array of
 * primitives joined to one), it is sanitized with the panel-specific
 * surface tag. Non-string children pass through unchanged (audit hook
 * still catches them at the panel root).
 */
export function SafeClinicalText({
  children,
  surface = "generic",
  field,
  status,
  hernaUnapproved,
  as = "span",
  className,
  style,
}: SafeClinicalTextProps) {
  const flat = flattenToString(children);
  if (flat == null) {
    return React.createElement(
      as,
      { className, style, "data-clinical-surface": String(surface), "data-clinical-field": field },
      children,
    );
  }
  const ctx: ClinicalTextGuardCtx = {
    surface,
    field,
    status,
    hernaUnapproved,
    actor: "ui:SafeClinicalText",
  };
  const { text } = sanitizeVisibleClinicalText(flat, ctx);
  return React.createElement(
    as,
    {
      className,
      style,
      "data-clinical-surface": String(surface),
      "data-clinical-field": field,
    },
    text,
  );
}

function flattenToString(node: ReactNode): string | null {
  if (node == null || typeof node === "boolean") return null;
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) {
    let out = "";
    for (const c of node) {
      if (typeof c === "string" || typeof c === "number") out += String(c);
      else return null; // Mixed — let pass-through render handle it
    }
    return out;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Post-mount DOM audit hook
// ---------------------------------------------------------------------------

export type AuditOptions = {
  /** Throw inside Vitest / jsdom test environment when violations are found. */
  failInTest?: boolean;
  /** console.warn violations in production. Default true. */
  logInProduction?: boolean;
  /** Extra context (status, hernaUnapproved) for context-aware rules. */
  status?: string;
  hernaUnapproved?: boolean;
  /**
   * Selectors whose textContent should be EXCLUDED from the audit (e.g.
   * raw therapist-authored discussion log, raw transcripts).
   */
  excludeSelectors?: string[];
};

const DEFAULT_EXCLUDE_SELECTORS = [
  "[data-clinical-raw-source='therapist']",
  "[data-clinical-raw-source='transcript']",
  "[data-no-clinical-audit='true']",
];

function isTestEnv(): boolean {
  // Vitest sets these:
  // (import.meta as any).vitest is undefined at runtime, so guard via env.
  if (typeof process !== "undefined") {
    const env = (process as any)?.env ?? {};
    if (env.VITEST || env.NODE_ENV === "test") return true;
  }
  if (typeof navigator !== "undefined" && /jsdom/i.test(navigator.userAgent || "")) return true;
  return false;
}

/**
 * Post-mount DOM audit. Walks the panel root after every commit and
 * collects any forbidden visible text. Excludes raw therapist-authored
 * regions so we never silently rewrite Hanička/Káťa quotes.
 */
export function useVisibleClinicalTextAudit<T extends HTMLElement>(
  panelName: ClinicalSurface | string,
  ref: React.RefObject<T>,
  options: AuditOptions = {},
): void {
  const last = useRef<string>("");
  useEffect(() => {
    // FAIL-CLOSED VERSION: in browser/prod the audit MUST never throw, never
    // tear down the React tree, never blank the screen. Throwing is reserved
    // for jsdom/Vitest AND only when the caller explicitly opts in via
    // `failInTest: true` — that intentional throw escapes the outer guard.
    let intentionalTestThrow: Error | null = null;
    try {
      const node = ref.current;
      if (!node || typeof node.cloneNode !== "function") return;
      let clone: HTMLElement;
      try {
        clone = node.cloneNode(true) as HTMLElement;
      } catch {
        return;
      }
      const exclude = [...DEFAULT_EXCLUDE_SELECTORS, ...(options.excludeSelectors ?? [])];
      for (const sel of exclude) {
        try {
          clone.querySelectorAll(sel).forEach((el) => el.parentNode?.removeChild(el));
        } catch {
          /* ignore selector errors */
        }
      }
      const text = (clone.textContent ?? "").trim();
      if (!text || text === last.current) return;
      last.current = text;
      const ctx: ClinicalTextGuardCtx = {
        surface: panelName,
        actor: `panel:${panelName}`,
        status: options.status,
        hernaUnapproved: options.hernaUnapproved,
      };
      const violations = detectClinicalTextViolations(text, ctx);
      if (violations.length === 0) return;
      const summary = violations
        .slice(0, 12)
        .map((v) => `${v.kind}:"${v.match}"`)
        .join(", ");
      const msg = `[visibleClinicalTextAudit] panel="${panelName}" forbidden_count=${violations.length} — ${summary}`;
      const inTest = isTestEnv();
      if (inTest && options.failInTest === true) {
        // Surface intentionally — let the test framework catch it.
        intentionalTestThrow = new Error(msg);
      } else if (!inTest && options.logInProduction !== false) {
        // eslint-disable-next-line no-console
        console.warn(msg, { violations });
      }
    } catch (e) {
      if (typeof console !== "undefined" && console && typeof console.warn === "function") {
        // eslint-disable-next-line no-console
        console.warn("[visibleClinicalTextAudit] swallowed error (no UI impact)", e);
      }
    }
    if (intentionalTestThrow) throw intentionalTestThrow;
  });
}
