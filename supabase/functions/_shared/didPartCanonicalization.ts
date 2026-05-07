/**
 * P30.4 — DID part canonicalization helper.
 *
 * Single source of truth for "is this raw part_name displayable as a
 * canonical DID part?". Used by active-part daily brief generation and
 * any read path that materializes part identity into briefing/app context.
 *
 * Rules (do not relax without P30.x ticket):
 * - Czech diacritics are stripped and case is folded for the normalized key.
 * - Forbidden non-parts (Hana/Karel/Káťa and their aliases) NEVER resolve
 *   to a canonical part, even if the registry contains a matching row.
 * - Placeholder names ("", "Dokument bez názvu", "unknown", null/undefined)
 *   NEVER resolve to a canonical part.
 * - Case variants of the same registry part collapse to ONE canonical row,
 *   preferring an existing proper-case registry entry.
 * - This helper never invents a part name.
 */

export type CanonicalPartStatus =
  | "canonical"
  | "case_alias"
  | "forbidden_non_part"
  | "placeholder"
  | "unmapped";

export interface CanonicalPartNameResult {
  input_part_name: string;
  normalized_key: string;
  canonical_part_name: string | null;
  status: CanonicalPartStatus;
  reason: string;
}

const DIACRITICS = /[\u0300-\u036f]/g;

const FORBIDDEN_KEYS = new Set([
  // Hana / Hanička (therapist)
  "hana",
  "hanka",
  "hanicka",
  "hani",
  "hanko",
  // Karel (system / agent identity)
  "karel",
  "karle",
  "karla",
  "karlovi",
  // Káťa (therapist)
  "kata",
  "katka",
  "kato",
  "kaca",
]);

const PLACEHOLDER_KEYS = new Set([
  "",
  "dokumentbeznazvu",
  "unknown",
  "untitled",
  "untitleddocument",
  "null",
  "undefined",
]);

export function normalizeCzechPartKey(value: string | null | undefined): string {
  if (value == null) return "";
  return String(value)
    .normalize("NFD")
    .replace(DIACRITICS, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

export function isForbiddenNonPartName(value: string | null | undefined): boolean {
  return FORBIDDEN_KEYS.has(normalizeCzechPartKey(value));
}

export function isPlaceholderPartName(value: string | null | undefined): boolean {
  if (value == null) return true;
  const raw = String(value).trim();
  if (raw === "") return true;
  return PLACEHOLDER_KEYS.has(normalizeCzechPartKey(raw));
}

function preferCanonicalForm(candidates: string[]): string {
  // Prefer an exact proper-case entry (mixed case, not all-upper, not all-lower)
  // over uppercase or lowercase aliases.
  const properCase = candidates.find(
    (c) => c !== c.toUpperCase() && c !== c.toLowerCase(),
  );
  if (properCase) return properCase;
  // Then prefer the longest non-uppercase variant.
  const nonUpper = candidates
    .filter((c) => c !== c.toUpperCase())
    .sort((a, b) => b.length - a.length);
  if (nonUpper[0]) return nonUpper[0];
  // Otherwise pick the longest available (last resort).
  return [...candidates].sort((a, b) => b.length - a.length)[0] ?? candidates[0];
}

export function canonicalizeDidPartName(
  rawPartName: string | null | undefined,
  registryParts: Array<{ part_name: string; status?: string | null }>,
): CanonicalPartNameResult {
  const input = rawPartName == null ? "" : String(rawPartName);
  const normalized_key = normalizeCzechPartKey(input);

  if (isPlaceholderPartName(input)) {
    return {
      input_part_name: input,
      normalized_key,
      canonical_part_name: null,
      status: "placeholder",
      reason: "input is empty / placeholder / 'Dokument bez názvu'",
    };
  }

  if (isForbiddenNonPartName(input)) {
    return {
      input_part_name: input,
      normalized_key,
      canonical_part_name: null,
      status: "forbidden_non_part",
      reason: "input matches therapist/system identity (Hana/Karel/Káťa)",
    };
  }

  // Find all registry rows whose normalized key matches.
  const matches = (registryParts ?? [])
    .map((r) => r?.part_name)
    .filter((name): name is string => typeof name === "string" && name.length > 0)
    .filter((name) => normalizeCzechPartKey(name) === normalized_key);

  if (matches.length === 0) {
    return {
      input_part_name: input,
      normalized_key,
      canonical_part_name: null,
      status: "unmapped",
      reason: "no registry part matches normalized key",
    };
  }

  // Re-check forbidden against matches (safety: registry must never elevate
  // a therapist name into a canonical part even if it appears).
  if (matches.some((m) => isForbiddenNonPartName(m))) {
    return {
      input_part_name: input,
      normalized_key,
      canonical_part_name: null,
      status: "forbidden_non_part",
      reason: "matched registry row is a forbidden therapist/system identity",
    };
  }

  const canonical = preferCanonicalForm(matches);
  const isExact = canonical === input;
  return {
    input_part_name: input,
    normalized_key,
    canonical_part_name: canonical,
    status: isExact ? "canonical" : "case_alias",
    reason: isExact
      ? "input matches canonical registry form"
      : `input is a case alias of canonical '${canonical}'`,
  };
}
