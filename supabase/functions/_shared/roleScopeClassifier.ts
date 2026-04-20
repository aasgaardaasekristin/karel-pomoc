/**
 * roleScopeClassifier.ts — Hanička Role Separation Slice
 *
 * Classifies each Hana message into role_scope with provenance metadata.
 *
 * Scopes:
 *   partner_personal   — private/intimate, partner layer
 *   therapeutic_team    — therapist role: kluci, Káťa, crisis, plans
 *   mixed              — both layers in one message (needs segmentation)
 *   uncertain           — classifier unsure → treated as partner_personal for safety
 *
 * Routing firewall:
 *   partner_personal / uncertain → NEVER into DID evidence pipeline
 *   therapeutic_team             → full evidence flow
 *   mixed                        → per-segment routing
 */

export type RoleScope = "partner_personal" | "therapeutic_team" | "mixed" | "uncertain";

export type RoleScopeOrigin =
  | "classifier"
  | "heuristic_fastpath"
  | "legacy_backfill"
  | "manual_override"
  | "default_fallback";

export interface RoleScopeMeta {
  origin: RoleScopeOrigin;
  confidence: number;
  classifier_version: string;
  classified_at: string;
  model: string | null;
  needs_role_review: boolean;
  review_reason: string | null;
}

export interface RoleScopeSegment {
  segment_id: string;
  char_start: number;
  char_end: number;
  text: string;
  scope: "partner_personal" | "therapeutic_team";
  confidence: number;
}

export interface RoleScopeResult {
  role_scope: RoleScope;
  role_scope_meta: RoleScopeMeta;
  role_scope_segments?: RoleScopeSegment[];
}

const CLASSIFIER_VERSION = "v1.0.0";

// ── Heuristic fast-path keywords ──

const THERAPEUTIC_SIGNALS = [
  // DID parts / kluci
  "arthur", "clark", "tundrup", "malý", "kluci", "kluků", "klukům",
  "fragment", "přepnutí", "switch", "kartotéka", "karta",
  // Therapist role
  "káťa", "kata", "supervize", "sezení s", "klient", "klientk",
  "terapie", "intervence", "plán", "krize", "krizov",
  // Clinical terms
  "diagnóz", "disociac", "trauma", "stabilizac", "regulac",
  "grounding", "bezpečn", "trigger",
];

const PERSONAL_SIGNALS = [
  // Intimate / partner
  "miláčku", "lásko", "miluju", "líbí se mi", "stýská",
  "intimn", "objím", "mazl", "polibek", "touž",
  // Personal emotions about self (not about parts)
  "bojím se za sebe", "nechci se ti svěřovat", "jsem unavená",
  "potřebuju klid", "nemůžu spát", "je mi smutno",
  // Relationship with Karel
  "ty a já", "náš vztah", "jako partner", "jako pár",
];

function normalizeForMatch(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function countSignals(text: string, signals: string[]): number {
  const norm = normalizeForMatch(text);
  let count = 0;
  for (const s of signals) {
    const normS = normalizeForMatch(s);
    if (norm.includes(normS)) count++;
  }
  return count;
}

/**
 * Heuristic fast-path: cheap keyword matching before AI call.
 * Returns result if confident enough, null otherwise (→ call AI).
 */
function heuristicFastPath(text: string): RoleScopeResult | null {
  const therapeuticHits = countSignals(text, THERAPEUTIC_SIGNALS);
  const personalHits = countSignals(text, PERSONAL_SIGNALS);

  const now = new Date().toISOString();
  const baseMeta: Omit<RoleScopeMeta, "confidence" | "needs_role_review" | "review_reason"> = {
    origin: "heuristic_fastpath",
    classifier_version: CLASSIFIER_VERSION,
    classified_at: now,
    model: null,
  };

  // Strong therapeutic signal, no personal
  if (therapeuticHits >= 2 && personalHits === 0) {
    return {
      role_scope: "therapeutic_team",
      role_scope_meta: {
        ...baseMeta,
        confidence: Math.min(0.95, 0.7 + therapeuticHits * 0.05),
        needs_role_review: false,
        review_reason: null,
      },
    };
  }

  // Strong personal signal, no therapeutic
  if (personalHits >= 2 && therapeuticHits === 0) {
    return {
      role_scope: "partner_personal",
      role_scope_meta: {
        ...baseMeta,
        confidence: Math.min(0.95, 0.7 + personalHits * 0.05),
        needs_role_review: false,
        review_reason: null,
      },
    };
  }

  // Both present → mixed but only if strong enough
  if (therapeuticHits >= 2 && personalHits >= 2) {
    return {
      role_scope: "mixed",
      role_scope_meta: {
        ...baseMeta,
        confidence: 0.65,
        needs_role_review: false,
        review_reason: null,
      },
    };
  }

  // Not confident enough → fall through to AI
  return null;
}

/**
 * AI-based classification via Gemini Flash Lite.
 */
async function classifyWithAI(
  text: string,
  apiKey: string,
): Promise<RoleScopeResult> {
  const now = new Date().toISOString();
  const fallbackResult: RoleScopeResult = {
    role_scope: "uncertain",
    role_scope_meta: {
      origin: "default_fallback",
      confidence: 0.0,
      classifier_version: CLASSIFIER_VERSION,
      classified_at: now,
      model: null,
      needs_role_review: true,
      review_reason: "classifier_failed",
    },
  };

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: "google/gemini-2.5-flash-lite",
        messages: [
          {
            role: "system",
            content: `Klasifikuj zprávu do jedné z kategorií role_scope. Odpovídej POUZE validním JSON.

KATEGORIE:
- "partner_personal" — osobní/intimní/partnerský obsah, emoce o sobě, vztah Hanička↔Karel
- "therapeutic_team" — terapeutický obsah, DID části (kluci), Káťa, klienti, krize, plány, kartotéka
- "mixed" — zpráva obsahuje OBĚ roviny (osobní I terapeutickou)
- "uncertain" — nelze spolehlivě klasifikovat

Pokud je zpráva "mixed", rozděl ji na segmenty (char_start/char_end offsety do původního textu).

Vrať JSON:
{
  "scope": "partner_personal|therapeutic_team|mixed|uncertain",
  "confidence": 0.0-1.0,
  "segments": [{"char_start": 0, "char_end": 30, "scope": "therapeutic_team", "confidence": 0.9}, ...] // jen pro mixed
}`,
          },
          { role: "user", content: text.slice(0, 1500) },
        ],
        temperature: 0.05,
      }),
    });

    clearTimeout(timeout);
    if (!res.ok) {
      console.warn(`[roleScopeClassifier] AI call failed: ${res.status}`);
      return fallbackResult;
    }

    const data = await res.json();
    const raw = data.choices?.[0]?.message?.content || "";
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return fallbackResult;

    const parsed = JSON.parse(jsonMatch[0]);
    const scope: RoleScope = ["partner_personal", "therapeutic_team", "mixed", "uncertain"].includes(parsed.scope)
      ? parsed.scope
      : "uncertain";
    const confidence = typeof parsed.confidence === "number"
      ? Math.max(0, Math.min(1, parsed.confidence))
      : 0.5;

    const meta: RoleScopeMeta = {
      origin: "classifier",
      confidence,
      classifier_version: CLASSIFIER_VERSION,
      classified_at: now,
      model: "google/gemini-2.5-flash-lite",
      needs_role_review: scope === "uncertain" || confidence < 0.5,
      review_reason: scope === "uncertain" ? "uncertain_scope" : confidence < 0.5 ? "low_confidence" : null,
    };

    const result: RoleScopeResult = { role_scope: scope, role_scope_meta: meta };

    // Parse segments for mixed
    if (scope === "mixed" && Array.isArray(parsed.segments) && parsed.segments.length > 0) {
      result.role_scope_segments = parsed.segments
        .filter((s: any) =>
          typeof s.char_start === "number" &&
          typeof s.char_end === "number" &&
          ["partner_personal", "therapeutic_team"].includes(s.scope)
        )
        .map((s: any, i: number) => ({
          segment_id: `seg_${i + 1}`,
          char_start: s.char_start,
          char_end: Math.min(s.char_end, text.length),
          text: text.slice(s.char_start, Math.min(s.char_end, text.length)),
          scope: s.scope as "partner_personal" | "therapeutic_team",
          confidence: typeof s.confidence === "number" ? s.confidence : confidence,
        }));

      // If segmentation failed (no valid segments), treat as uncertain
      if (!result.role_scope_segments || result.role_scope_segments.length === 0) {
        result.role_scope = "uncertain";
        result.role_scope_meta.needs_role_review = true;
        result.role_scope_meta.review_reason = "mixed_unsegmentable";
        delete result.role_scope_segments;
      }
    }

    return result;
  } catch (e: any) {
    if (e?.name === "AbortError") {
      console.warn("[roleScopeClassifier] AI timed out, using fallback");
    } else {
      console.warn("[roleScopeClassifier] AI error:", e);
    }
    return fallbackResult;
  }
}

/**
 * Main entry point: classify a message's role_scope.
 * Tries heuristic fast-path first, falls back to AI.
 */
export async function classifyRoleScope(
  messageText: string,
  apiKey: string,
): Promise<RoleScopeResult> {
  // Very short messages → uncertain (not enough signal)
  if (messageText.trim().length < 10) {
    return {
      role_scope: "uncertain",
      role_scope_meta: {
        origin: "heuristic_fastpath",
        confidence: 0.0,
        classifier_version: CLASSIFIER_VERSION,
        classified_at: new Date().toISOString(),
        model: null,
        needs_role_review: true,
        review_reason: "too_short",
      },
    };
  }

  // Try heuristic first
  const heuristic = heuristicFastPath(messageText);
  if (heuristic) return heuristic;

  // Fall back to AI
  return classifyWithAI(messageText, apiKey);
}

/**
 * Check if a role_scope should block DID evidence pipeline writes.
 * Returns true if DID evidence writes should be SKIPPED.
 */
export function shouldBlockDIDEvidence(scope: RoleScope): boolean {
  return scope === "partner_personal" || scope === "uncertain";
}
