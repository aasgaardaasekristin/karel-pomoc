/**
 * karelLanguageGuard.ts
 * Audit-only language violation detector.
 * Read-only — never modifies, regenerates, or retries output.
 * Logs only metadata, never full therapeutic text.
 */

import type { KarelContext } from "./karelContextNormalizer.ts";

export interface AuditResult {
  violations: Array<{
    phrase: string;
    category: "terminology" | "gender" | "forbidden_question";
  }>;
  clean: boolean;
}

// ─── INTERNAL HELPERS ─────────────────────────────────────

function normalizeForAudit(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

// ─── TERMINOLOGY VIOLATIONS ───────────────────────────────

const TERMINOLOGY_PHRASES: string[] = [
  "stav systemu",
  "casti systemu",
  "prace s castmi",
  "konkretni cast",
  "v chovani casti",
  "did system",
  "fragment did systemu",
  "klientka s did",
  "fragment did",
  "cast did systemu",
  "systemova dynamika",
];

// ─── GENDER VIOLATIONS ───────────────────────────────────

const GENDER_PHRASES: string[] = [
  "vsimla jsem si",
  "jsem rada",
  "budu rada",
  "chtela bych",
  "rekla bych",
  "pokusila jsem se",
];

// ─── AUDIT FUNCTION ──────────────────────────────────────

export function auditKarelOutput(
  text: string,
  ctx: KarelContext,
  requestId?: string,
): AuditResult {
  const normalized = normalizeForAudit(text);
  const seen = new Set<string>();
  const violations: AuditResult["violations"] = [];

  // Check terminology violations (only in DID-facing domains)
  if (
    ctx.domain === "did_terapeut" ||
    ctx.domain === "did_deti" ||
    ctx.domain === "porada"
  ) {
    for (const phrase of TERMINOLOGY_PHRASES) {
      if (!seen.has(phrase) && normalized.includes(phrase)) {
        seen.add(phrase);
        violations.push({ phrase, category: "terminology" });
      }
    }
  }

  // Check gender violations (all domains)
  for (const phrase of GENDER_PHRASES) {
    if (!seen.has(phrase) && normalized.includes(phrase)) {
      seen.add(phrase);
      violations.push({ phrase, category: "gender" });
    }
  }

  const result: AuditResult = {
    violations,
    clean: violations.length === 0,
  };

  // Log metadata only — never the full text
  if (!result.clean) {
    console.warn("[language-guard]", {
      requestId: requestId ?? "unknown",
      domain: ctx.domain,
      audience: ctx.audience,
      violationCount: violations.length,
      violations: violations.map((v) => `${v.category}:${v.phrase}`),
    });
  }

  return result;
}
