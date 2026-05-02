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
 * Soft replacements applied during sanitize() — they fix kostrbatá fráze
 * and the most common "robotic-Karel" leakages so that the visible string
 * is human and auditable.
 */
const HUMAN_REPLACEMENTS: Array<{ from: RegExp; to: string }> = [
  // P1 explicit replacements
  { from: /\bHerna je vedená Karlem práce\b/giu, to: "Hernu vede Karel" },
  { from: /\bPoužívá důležitý kontext z posledních dní\b/giu, to: "Vychází z toho, co se v posledních dnech opravdu stalo" },
  { from: /\bCo je jen stopa v datech\b/giu, to: "Co se zatím jen mihlo a chce ověřit" },
  { from: /\bZohlednit v nejbližším plánování\b/giu, to: "Vrátit se k tomu při nejbližším plánu" },
  { from: /\bZohlednit ve follow-upu\b/giu, to: "Vrátit se k tomu při dalším kontaktu" },
  {
    from: /\bnepoužije se plán terapeutického sezení ani pracovní návrh\b/giu,
    to: "dnes Sezení ani jeho návrh nebudeme používat",
  },
  { from: /\bBezformátový program\b/giu, to: "Program zatím nemá pevnou strukturu" },
  // Internal/system labels that sometimes leak into prose
  { from: /\bprogram_draft\b/giu, to: "návrh programu" },
  { from: /\bfirst_draft\b/giu, to: "první návrh" },
  { from: /\bsession_params\b/giu, to: "parametry sezení" },
  { from: /\bbackend_context_inputs\b/giu, to: "kontext z posledních dní" },
  { from: /\boperational context\b/giu, to: "kontext z posledních dní" },
  { from: /\boperační kontext\b/giu, to: "kontext z posledních dní" },
  { from: /\bpending_review\b/giu, to: "otevřené nebo částečně rozpracované" },
  { from: /\bevidence_limited\b/giu, to: "zatím jen částečně doložené" },
  { from: /\bchild evidence\b/giu, to: "vlastní reakce kluků" },
  { from: /\bKarel-led\b/giu, to: "vede Karel" },
  { from: /\bDID-relevantní\b/giu, to: "důležité pro kluky" },
  // Existing kostrbaté
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

// Context-conditional forbidden labels (only forbidden in some surfaces /
// statuses).
const CONTEXT_FORBIDDEN_LABELS: Array<{
  needle: RegExp;
  match: string;
  appliesTo: (ctx: ClinicalTextGuardCtx) => boolean;
}> = [
  {
    needle: /\bŽivý program sezení\b/iu,
    match: "Živý program sezení",
    appliesTo: (ctx) => ctx.surface === "herna-modal",
  },
  {
    needle: /\bZměna plánu:\s*beze změny\b/iu,
    match: "Změna plánu: beze změny",
    appliesTo: (ctx) =>
      ctx.surface === "team-deliberation" &&
      (ctx.status === "replan" || ctx.status === "in_revision"),
  },
  {
    needle: /\bVyžaduje terapeutku:\s*Ne\b/iu,
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
  /** allowed if any of these negation cues precede it within ~40 chars */
  negationAllowed: RegExp[];
}> = [
  {
    positive: /\bje to projekce\b/iu,
    match: "je to projekce",
    negationAllowed: [/\bne jako projekce\b/iu, /\bnení to projekce\b/iu],
  },
  {
    positive: /\bsymbolizuje\b/iu,
    match: "symbolizuje",
    negationAllowed: [/\bne jako symbol\b/iu, /\bnesymbolizuje\b/iu],
  },
  {
    positive: /\bdiagnostick[ýé]\s+sign[áa]l\b/iu,
    match: "diagnostický signál",
    negationAllowed: [/\bne jako diagnostick[ýé]\s+sign[áa]l\b/iu],
  },
];

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
    const m = rule.positive.exec(text);
    if (!m) continue;
    const idx = m.index ?? 0;
    const window = text.slice(Math.max(0, idx - 40), idx + rule.match.length + 4);
    const negated = rule.negationAllowed.some((nr) => nr.test(window));
    if (negated) continue;
    violations.push({
      kind: "ungrounded_clinical_assertion",
      match: rule.match,
      index: idx,
      surface: String(ctx.surface),
      field: ctx.field,
    });
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
    const node = ref.current;
    if (!node) return;
    // Clone & remove excluded subtrees so therapist quotes are not audited.
    const clone = node.cloneNode(true) as HTMLElement;
    const exclude = [...DEFAULT_EXCLUDE_SELECTORS, ...(options.excludeSelectors ?? [])];
    for (const sel of exclude) {
      clone.querySelectorAll(sel).forEach((el) => el.parentNode?.removeChild(el));
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
    if (isTestEnv() && options.failInTest !== false) {
      throw new Error(msg);
    }
    if (options.logInProduction !== false) {
      // eslint-disable-next-line no-console
      console.warn(msg, { violations });
    }
  });
}
