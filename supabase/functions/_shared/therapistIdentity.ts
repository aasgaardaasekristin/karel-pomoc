/**
 * therapistIdentity.ts (edge-function copy)
 *
 * Mirror of src/lib/therapistIdentity.ts. Keep in sync manually.
 * See that file for the full rationale.
 *
 * KANONICKÁ identita terapeutek. Single source of truth for edge functions.
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

const ALIAS_TO_CANONICAL: Record<string, TherapistId> = {
  // hanka
  hanka: "hanka",
  hana: "hanka",
  hanicka: "hanka",
  hani: "hanka",
  mamka: "hanka",
  mama: "hanka",
  maminka: "hanka",
  // kata
  kata: "kata",
  katka: "kata",
  kaca: "kata",
};

export function normalizeTherapist(raw: string | null | undefined): TherapistId | null {
  if (!raw || typeof raw !== "string") return null;
  const key = normalizeKey(raw);
  if (!key) return null;
  return ALIAS_TO_CANONICAL[key] ?? null;
}

export function isTherapistName(raw: string | null | undefined): boolean {
  return normalizeTherapist(raw) !== null;
}

export function therapistDisplayName(raw: string | null | undefined): string | null {
  const id = normalizeTherapist(raw);
  return id ? THERAPIST_DISPLAY_NAME[id] : null;
}

export function therapistVocative(raw: string | null | undefined): string | null {
  const id = normalizeTherapist(raw);
  return id ? THERAPIST_VOCATIVE[id] : null;
}
