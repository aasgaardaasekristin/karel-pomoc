/**
 * karelRender/identity.ts — IDENTITY LAYER (edge mirror)
 *
 * Mirror of src/lib/karelRender/identity.ts. Keep 1:1 with UI version.
 * Pure text — no Deno I/O, no Supabase client.
 */

import {
  normalizeTherapist,
  isTherapistName,
  therapistDisplayName,
  therapistVocative,
  THERAPIST_DISPLAY_NAME,
  THERAPIST_VOCATIVE,
  type TherapistId,
} from "../therapistIdentity.ts";

export type Audience = "team" | "hanka" | "kata";

export interface ResolvedAddressee {
  audience: Audience;
  displayName: string;
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
