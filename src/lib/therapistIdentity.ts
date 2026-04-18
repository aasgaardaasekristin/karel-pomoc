/**
 * therapistIdentity.ts
 *
 * KANONICKÁ identita terapeutek. Single source of truth.
 *
 * - therapist_id (canonical key, used in DB columns assigned_to / directed_to,
 *   in routing, in feature flags, in tests):
 *     "hanka" | "kata"
 *
 * - display_name (user-facing, prompts, briefing, UI labels):
 *     "Hanička" | "Káťa"
 *
 * - aliases (accepted on input, normalized to canonical id; NEVER stored):
 *     hanka:  hana, hanka, hanička, hanicka, hani, mamka, máma, maminka
 *     kata:   kata, káťa, katka, kaca, káča
 *
 * RULES
 * 1. Therapist != DID part. Use isTherapistName() as a guard wherever DID
 *    part_name surfaces are rendered (briefings, registries, narrative
 *    prose) to prevent therapists from leaking into part-only UI.
 * 2. "mamka" is ONLY a legacy routing/sub-mode token. It must NEVER be used
 *    as a user-facing identity, prompt subject, or display name. The
 *    canonical user-facing form is "Hanička".
 * 3. DB writes to assigned_to / directed_to MUST use the canonical id
 *    ("hanka" / "kata"). Never write "hanicka", "mamka", or any alias.
 * 4. Vocative forms ("Haničko", "Káťo") are presentation-only and live
 *    in the briefing layer. They are not identities.
 */

export type TherapistId = "hanka" | "kata";

export const THERAPIST_DISPLAY_NAME: Record<TherapistId, string> = {
  hanka: "Hanička",
  kata: "Káťa",
};

export const THERAPIST_VOCATIVE: Record<TherapistId, string> = {
  hanka: "Haničko",
  kata: "Káťo",
};

const DIACRITICS_REGEX = /[\u0300-\u036f]/g;

const stripDiacritics = (value: string): string =>
  value.normalize("NFD").replace(DIACRITICS_REGEX, "");

const normalizeKey = (value: string): string =>
  stripDiacritics(value).toLowerCase().trim();

/**
 * All accepted alias keys → canonical therapist id.
 * Keys are stored already normalized (lowercase, no diacritics, trimmed).
 *
 * "mamka" / "mama" / "maminka" are legacy aliases coming from the early
 * routing layer (DidSubMode = "mamka"). They MUST normalize to "hanka",
 * but must never reappear in user-facing text.
 */
const ALIAS_TO_CANONICAL: Record<string, TherapistId> = {
  // hanka
  hanka: "hanka",
  hana: "hanka",
  hanicka: "hanka", // "Hanička" stripped of diacritics
  hani: "hanka",
  mamka: "hanka",
  mama: "hanka", // "máma" stripped of diacritics
  maminka: "hanka",
  // kata
  kata: "kata",
  katka: "kata",
  kaca: "kata", // "káča" stripped of diacritics
};

/**
 * Normalize any therapist alias to the canonical id.
 * Returns null for unknown values, empty input, or non-therapist strings.
 *
 * Use at the BOUNDARY of every layer that may receive raw therapist
 * identifiers (URL params, AI output, DB rows, legacy code).
 */
export function normalizeTherapist(raw: string | null | undefined): TherapistId | null {
  if (!raw || typeof raw !== "string") return null;
  const key = normalizeKey(raw);
  if (!key) return null;
  return ALIAS_TO_CANONICAL[key] ?? null;
}

/**
 * True if the input string refers to a therapist (Hanka or Káťa) under
 * any of their accepted aliases. Use as a guard in DID-part surfaces
 * (narrative briefings, part registries, recent-thread filters) to
 * prevent therapists from being treated as DID parts.
 */
export function isTherapistName(raw: string | null | undefined): boolean {
  return normalizeTherapist(raw) !== null;
}

/**
 * Canonical user-facing display name for a therapist.
 * Returns null if the input cannot be resolved.
 */
export function therapistDisplayName(raw: string | null | undefined): string | null {
  const id = normalizeTherapist(raw);
  return id ? THERAPIST_DISPLAY_NAME[id] : null;
}

/**
 * Canonical vocative form for direct address ("Haničko" / "Káťo").
 * Returns null if the input cannot be resolved.
 */
export function therapistVocative(raw: string | null | undefined): string | null {
  const id = normalizeTherapist(raw);
  return id ? THERAPIST_VOCATIVE[id] : null;
}
