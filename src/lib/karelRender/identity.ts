/**
 * karelRender/identity.ts — IDENTITY LAYER (pure-text)
 *
 * Single source of truth for therapist vs DID-part identity inside the
 * shared render pipeline. NO React, NO Supabase, NO fetch.
 *
 * Reuses canonical helpers from src/lib/therapistIdentity.ts so we never
 * fork the alias map. This module adds RENDER-SPECIFIC concerns on top:
 *   - resolveAddressee() — picks display + vocative for greeting/address
 *   - guardPartName()    — drops therapist aliases from part-only surfaces
 *   - pseudo-name guard  — blocks "system"/"karel"/"ai" leaks
 *
 * Mirror: supabase/functions/_shared/karelRender/identity.ts (1:1).
 */

import {
  normalizeTherapist,
  isTherapistName,
  therapistDisplayName,
  therapistVocative,
  THERAPIST_DISPLAY_NAME,
  THERAPIST_VOCATIVE,
  type TherapistId,
} from "@/lib/therapistIdentity";

export type Audience = "team" | "hanka" | "kata";

export interface ResolvedAddressee {
  audience: Audience;
  /** User-facing name in nominative ("Hanička" / "Káťa" / "tým"). */
  displayName: string;
  /** Vocative form for direct address ("Haničko" / "Káťo" / null for team). */
  vocative: string | null;
}

const NARRATIVE_PSEUDO_NAMES = new Set([
  "",
  "system",
  "karel",
  "ai",
  "bot",
  "assistant",
]);

/**
 * Resolve an arbitrary input string into a render addressee.
 * - Falls back to "team" when the value cannot be resolved to a therapist.
 * - Use this AT THE BOUNDARY where briefing/asks are composed.
 */
export function resolveAddressee(raw: string | null | undefined): ResolvedAddressee {
  const id = normalizeTherapist(raw);
  if (id) {
    return {
      audience: id,
      displayName: THERAPIST_DISPLAY_NAME[id],
      vocative: THERAPIST_VOCATIVE[id],
    };
  }
  return { audience: "team", displayName: "tým", vocative: null };
}

/**
 * Guard a part_name candidate before it surfaces in part-only narrative.
 * Returns the cleaned label, or null if the value must NOT appear there.
 *
 * Rejects:
 *  - empty/whitespace
 *  - pseudo-names ("system", "karel", "ai", "bot")
 *  - therapist aliases (Hana/Hanka/Hanička/mamka/Káťa/...)
 *  - too-short labels (< 3 chars)
 */
export function guardPartName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = String(raw).trim();
  if (!cleaned) return null;
  const lower = cleaned.toLocaleLowerCase("cs");
  if (NARRATIVE_PSEUDO_NAMES.has(lower)) return null;
  if (isTherapistName(cleaned)) return null;
  if (cleaned.length < 3) return null;
  return cleaned;
}

/** Convenience: canonical therapist id or null. */
export function asTherapistId(raw: string | null | undefined): TherapistId | null {
  return normalizeTherapist(raw);
}

export {
  THERAPIST_DISPLAY_NAME,
  THERAPIST_VOCATIVE,
  isTherapistName,
  therapistDisplayName,
  therapistVocative,
};
export type { TherapistId };
