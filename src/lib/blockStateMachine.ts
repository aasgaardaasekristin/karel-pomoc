/**
 * blockStateMachine
 * -----------------
 * Deterministic, server-side authority for "which block is currently
 * active" in a live DID session, plus guardrails for what the AI is
 * allowed to do in the current block.
 *
 * SEV-1 BACKGROUND (2026-04-30):
 * Karel was losing program state and re-initiating already-completed
 * activities (e.g. proposing "draw a person" during the final closing
 * block when therapist responded "ano"). This module shifts authority:
 *
 *   - The DB row in `did_live_session_progress.items[].done` is the
 *     single source of truth for which block is current.
 *   - Therapist short acknowledgements ("ano", "ok", "rozumím") DO NOT
 *     advance to the next block.
 *   - In FINAL blocks (closing/integration/wrap-up), the AI MUST NOT
 *     propose new diagnostic/drawing/projective activities.
 *   - Therapist corrections ("to jsme už dělali", "teď jen měkké
 *     zakončení") realign Karel back to the closing block's instructions.
 */

// ─── Types ──────────────────────────────────────────────────────────

export type BlockKind =
  | "opening"
  | "diagnostic"
  | "narrative"
  | "stabilization"
  | "closing"
  | "generic";

export interface ParsedBlock {
  /** 0-based index in the program */
  index: number;
  /** Title only, no minutes/detail */
  title: string;
  /** Optional inline detail/instruction */
  detail?: string;
  /** Heuristic classification used for guardrails */
  kind: BlockKind;
  /** True if this block is the final/closing/integration block */
  isFinal: boolean;
}

export interface ProgressItem {
  id: string;
  text: string;
  done: boolean;
  observation?: string;
}

export interface CurrentBlockResolution {
  /** 0-based index of the current authoritative block */
  index: number;
  block: ParsedBlock | null;
  /** True if all blocks are done */
  allDone: boolean;
  /** Human-readable reason, useful for logging */
  reason: string;
}

// ─── Heuristics: classify block kind ────────────────────────────────

const FINAL_TOKENS = [
  "ukon", "ukonč", "uzav", "závěr", "zaver",
  "integrac", "měkké ukon", "mekke ukon",
  "wrap", "closure", "closing", "vyhodnoc",
  "shrnut", "rozlou",
];

const DIAGNOSTIC_TOKENS = [
  "kresba", "nakresli", "asocia", "rorschach", "ror ",
  "projektivn", "tat ", "machover", "dap ",
  "test", "diagnost", "stimulus",
];

const NARRATIVE_TOKENS = [
  "vyprav", "narativ", "příběh", "pribeh", "pohádk", "pohadk",
];

const STABILIZATION_TOKENS = [
  "groundin", "stabiliz", "kotven", "bezpečn", "bezpecn",
  "uklidn", "dech", "tělo", "telo",
];

const OPENING_TOKENS = [
  "vstup", "úvod", "uvod", "naladěn", "naladen",
  "ověření přítomnosti", "overeni pritomnosti", "přivítán", "privitan",
];

function classifyBlock(text: string): { kind: BlockKind; isFinal: boolean } {
  const t = text.toLowerCase();
  const isFinal = FINAL_TOKENS.some((tok) => t.includes(tok));
  if (isFinal) return { kind: "closing", isFinal: true };
  if (DIAGNOSTIC_TOKENS.some((tok) => t.includes(tok))) {
    return { kind: "diagnostic", isFinal: false };
  }
  if (NARRATIVE_TOKENS.some((tok) => t.includes(tok))) {
    return { kind: "narrative", isFinal: false };
  }
  if (STABILIZATION_TOKENS.some((tok) => t.includes(tok))) {
    return { kind: "stabilization", isFinal: false };
  }
  if (OPENING_TOKENS.some((tok) => t.includes(tok))) {
    return { kind: "opening", isFinal: false };
  }
  return { kind: "generic", isFinal: false };
}

// ─── Parse program from plan_markdown ───────────────────────────────

const MAX_BLOCKS = 12;
const MIN_TITLE_LEN = 3;

function cleanInline(s: string): string {
  return s.replace(/\*\*/g, "").replace(/__/g, "").replace(/\u00A0/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Parses blocks from `plan_markdown`. Mirrors the client-side
 * `liveProgramParser.ts` for parity, but returns ParsedBlock with
 * classification.
 */
export function parseProgramBlocks(planMarkdown: string): ParsedBlock[] {
  if (!planMarkdown || typeof planMarkdown !== "string") return [];
  const lines = planMarkdown.split(/\r?\n/);
  const sectionRe = /^#{1,6}\s+(?:[^\w\s]+\s*)?program\s+sezen[ií]\s*$/i;
  const bulletRe = /^\s*(?:[-*\u2022]|\d+[.)])\s+(.+)$/;

  type Raw = { title: string; detail?: string };
  const raws: Raw[] = [];
  let inProgram = false;
  let bulletStarted = false;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\u00A0/g, " ").trimEnd();
    if (sectionRe.test(line)) {
      inProgram = true;
      bulletStarted = false;
      continue;
    }
    if (inProgram && /^#{1,6}\s+/.test(line) && !sectionRe.test(line)) break;
    if (!inProgram) continue;
    const m = bulletRe.exec(line);
    if (m) {
      const title = cleanInline(m[1]);
      if (title.length >= MIN_TITLE_LEN) {
        raws.push({ title });
        bulletStarted = true;
      }
      continue;
    }
    if (raws.length > 0 && /^\s{2,}\S/.test(rawLine)) {
      const cont = cleanInline(line);
      if (cont) {
        const last = raws[raws.length - 1];
        last.detail = last.detail ? `${last.detail} ${cont}` : cont;
      }
      continue;
    }
    if (line === "") continue;
    if (bulletStarted) break;
  }

  return raws.slice(0, MAX_BLOCKS).map((r, i) => {
    const fullText = `${r.title}${r.detail ? ` — ${r.detail}` : ""}`;
    const { kind, isFinal } = classifyBlock(fullText);
    // The LAST block of any program is also treated as final regardless of tokens
    return {
      index: i,
      title: r.title,
      detail: r.detail,
      kind,
      isFinal,
    };
  }).map((b, i, arr) => i === arr.length - 1 ? { ...b, isFinal: true, kind: b.kind === "generic" ? "closing" : b.kind } : b);
}

// ─── Authority: which block is current? ─────────────────────────────

/**
 * The DB row is the source of truth. We pick the FIRST not-done block.
 * If all blocks are done, current = last block + allDone=true.
 */
export function resolveCurrentBlockIndex(
  blocks: ParsedBlock[],
  items: ProgressItem[] | null | undefined,
  clientHintIndex?: number | null,
): CurrentBlockResolution {
  if (!blocks.length) {
    return { index: 0, block: null, allDone: false, reason: "no_blocks_parsed" };
  }
  const safeItems = Array.isArray(items) ? items : [];
  // Walk items in order; first not-done wins.
  for (let i = 0; i < blocks.length; i++) {
    const item = safeItems[i];
    if (!item || !item.done) {
      const reason = clientHintIndex !== undefined && clientHintIndex !== null && clientHintIndex !== i
        ? `db_authority_overrode_client_hint(client=${clientHintIndex}, server=${i})`
        : "db_first_not_done";
      return { index: i, block: blocks[i], allDone: false, reason };
    }
  }
  return {
    index: blocks.length - 1,
    block: blocks[blocks.length - 1],
    allDone: true,
    reason: "all_blocks_done",
  };
}

// ─── Therapist intent detection ─────────────────────────────────────

const ACK_PATTERNS = [
  /^ano\.?\s*$/i,
  /^jo\.?\s*$/i,
  /^ok(ay)?\.?\s*$/i,
  /^dobr[řr]?[áeěy]\.?\s*$/i,
  /^rozum[ií]m?\.?\s*$/i,
  /^j[ae]sn[éě]\.?\s*$/i,
  /^v\s*po[řr]ádku\.?\s*$/i,
  /^souhlas[ií]m?\.?\s*$/i,
  /^d[íi]ky\.?\s*$/i,
];

/**
 * Returns true if the therapist message is a short acknowledgement
 * that should NOT advance the block or trigger new activities.
 */
export function isTherapistAcknowledgement(text: string): boolean {
  const t = String(text || "").trim();
  if (!t) return false;
  if (t.length > 30) return false;
  return ACK_PATTERNS.some((re) => re.test(t));
}

const CORRECTION_PATTERNS = [
  /to (jsme )?u[zž] d[eě]l[ae]l/i,
  /to u[zž] (jsme )?(m[aá]m|m[aá]me|bylo)/i,
  /tohle u[zž]/i,
  /nevracej (se )?k/i,
  /nepou[zž]ívej/i,
  /nez[aá]v[aá]d[ěe]j/i,
  /nen[aá]v(racuj|racet)/i,
  /jen (m[ěe]kk[éy]|klidn[éy])\s+(zakon[čc]en|ukon[čc]en|z[aá]v[ěe]r)/i,
  /z[aá]v[ěe]r(e[čc]n)?/i,
  /jen (uzav[rř]i|ukon[čc]i|zakon[čc]i)/i,
  /[zž][aá]dn(á|ou|ý|é|y) (dal[sš][ií]|nov(á|ou|ý|é|y)) aktivit/i,
];

/**
 * Returns true if the therapist explicitly corrects Karel — wants him
 * to abandon a proposed activity and stay in closure mode.
 */
export function isTherapistCorrection(text: string): boolean {
  const t = String(text || "");
  if (!t.trim()) return false;
  return CORRECTION_PATTERNS.some((re) => re.test(t));
}

// ─── Output validator (anti-off-plan AI) ────────────────────────────

const FORBIDDEN_IN_FINAL = [
  /kresb[au] postavy/i,
  /nakresl(i|íš|ime|íme)/i,
  /postav[au] [čc]lov[ěe]ka/i,
  /pov[ěe]z mi o tom [čc]lov[ěe]ku/i,
  /kdo to je a co pr[áa]v[ěe] d[ěe]l[áa]/i,
  /dal[sš][ií] krok/i,
  /pou[zž]ijeme techniku kresby/i,
  /projektivn[ií]/i,
  /asocia[čc]n[ií] (hru|experiment|test)/i,
  /rorschach/i,
  /machover/i,
  /\bdap\b/i,
  /\btat\b/i,
];

export interface ValidationResult {
  ok: boolean;
  violations: string[];
  /** Sanitized fallback text safe for the current (final) block */
  safeFallback?: string;
}

export function validateAiOutputForBlock(
  karelText: string,
  block: ParsedBlock,
  therapistName: string,
): ValidationResult {
  if (!block.isFinal) return { ok: true, violations: [] };
  const text = String(karelText || "");
  const violations: string[] = [];
  for (const re of FORBIDDEN_IN_FINAL) {
    const m = re.exec(text);
    if (m) violations.push(m[0]);
  }
  if (violations.length === 0) return { ok: true, violations: [] };
  const therapistAddr = therapistName === "Káťa" ? "Káťo" : "Hani";
  const safeFallback =
    `${therapistAddr}, jsme v závěrečném bloku "${block.title}". Žádnou novou aktivitu už nezavádíme. ` +
    `Prosím:\n` +
    `1) Krátce shrň, co jsme dnes opravdu společně udělali (jen to, co skutečně proběhlo).\n` +
    `2) Pojmenuj jednu věc, kterou si kluci dnes odnášejí (cokoli konkrétního, co řekli nebo udělali).\n` +
    `3) Jemně uzavři: poděkuj, řekni "uvidíme se příště" a zaznamenej jejich poslední reakci verbatim.`;
  return { ok: false, violations, safeFallback };
}

// ─── Robust AI response parsing ─────────────────────────────────────

export type SafeParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "empty" | "not_json" | "wrong_shape"; raw: string };

/**
 * Parses a JSON string defensively. Returns ok=false with structured
 * reason when the body is empty or invalid. Used by edge functions to
 * avoid 500 errors when AI gateway returns 200 with an empty body.
 */
export function safeParseJsonString<T = unknown>(raw: string | null | undefined): SafeParseResult<T> {
  const txt = String(raw ?? "").trim();
  if (!txt) return { ok: false, reason: "empty", raw: "" };
  try {
    const v = JSON.parse(txt) as T;
    return { ok: true, value: v };
  } catch {
    return { ok: false, reason: "not_json", raw: txt.slice(0, 500) };
  }
}

/**
 * Builds the deterministic fallback text for an empty/invalid AI
 * response. Always safe for the current block — never invents new
 * activities.
 */
export function buildEmptyAiFallback(block: ParsedBlock | null, therapistName: string): string {
  const therapistAddr = therapistName === "Káťa" ? "Káťo" : "Hani";
  if (!block) {
    return `${therapistAddr}, AI teď nevrátila odpověď. Zkus to prosím znovu, nebo pokračuj podle plánu.`;
  }
  if (block.isFinal) {
    return `${therapistAddr}, AI teď nevrátila odpověď. Jsme v závěrečném bloku "${block.title}" — žádnou novou aktivitu nezavádíme. Pokračuj prosím v měkkém uzavření a zaznamenej, co kluci řekli.`;
  }
  return `${therapistAddr}, AI teď nevrátila odpověď. Jsme stále v bloku "${block.title}". Pokračuj podle plánu, žádná nová aktivita; zkusím za chvíli znovu.`;
}
