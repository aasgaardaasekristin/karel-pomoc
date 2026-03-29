const DIACRITICS_REGEX = /[\u0300-\u036f]/g;
const STATUS_TOKENS = new Set([
  "aktivni",
  "aktivní",
  "active",
  "sleeping",
  "spici",
  "spící",
  "spi",
  "spí",
  "warning",
  "pozor",
]);

/**
 * Names that are NOT DID parts — they are therapists/team members.
 * Normalized (lowercase, no diacritics) for case-insensitive matching.
 */
const NON_DID_ENTITIES = new Set([
  "hanicka", "hanka", "hana", "hanička",
  "kata", "katka", "kata", "káťa", "kaca", "káča",
]);

const DMYTRI_ALIASES = new Set(["dmytri", "dymi", "dymytri", "dymitri"]);

export const stripDiacritics = (value: string) =>
  value.normalize("NFD").replace(DIACRITICS_REGEX, "");

/**
 * Returns true if the name belongs to a therapist/team member, NOT a DID part.
 */
export const isNonDidEntity = (name: string): boolean => {
  const norm = stripDiacritics(name).toLowerCase().trim();
  return NON_DID_ENTITIES.has(norm);
};

export const canonicalizePartAlias = (value: string) => {
  const normalized = stripDiacritics(value).toLowerCase().trim();
  if (DMYTRI_ALIASES.has(normalized)) return "DMYTRI";
  return value.trim();
};

const cleanToken = (token: string) =>
  token
    .replace(/^[-*•\d._\s]+/, "")
    .replace(/^(?:cast|část|fragment)\s*[:\-]?/i, "")
    .replace(/[()[\]{}]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

export const sanitizePartName = (raw: string | null | undefined): string | null => {
  if (!raw) return null;

  const base = String(raw)
    .replace(/^\d+_/, "")
    .replace(/\.(txt|md|doc|docx)$/i, "")
    .trim();

  if (!base) return null;

  // Filter out non-part names like "Dokument bez názvu", "Untitled document"
  const lowerBase = stripDiacritics(base).toLowerCase();
  if (lowerBase.includes("dokument bez nazvu") || lowerBase.includes("untitled")) return null;

  const tokens = base
    .split(/[\n,;|]+/)
    .map(cleanToken)
    .filter(Boolean)
    .filter((token) => !STATUS_TOKENS.has(stripDiacritics(token).toLowerCase()));

  const candidate = tokens[0] ?? cleanToken(base);
  if (!candidate) return null;

  const canonical = canonicalizePartAlias(candidate)
    .replace(/^_+|_+$/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (canonical.length < 2 || canonical.length > 40) return null;
  if (!/[\p{L}\p{N}]/u.test(canonical)) return null;
  if (/(aktivni|aktivní|sleeping|spici|spící|warning)/i.test(canonical)) return null;

  return canonical;
};

export const normalizePartKey = (raw: string | null | undefined) => {
  const sanitized = sanitizePartName(raw);
  if (!sanitized) return "";

  return stripDiacritics(sanitized)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
};

export const uniqueSanitizedPartNames = (values: Array<string | null | undefined>) => {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    const sanitized = sanitizePartName(value);
    const key = normalizePartKey(sanitized);
    if (!sanitized || !key || seen.has(key)) continue;
    seen.add(key);
    result.push(sanitized);
  }

  return result;
};

export const hasMeaningfulPartActivity = (
  messages: Array<{ role?: string; content?: unknown }> | null | undefined,
) => {
  if (!Array.isArray(messages)) return false;

  return messages.some((message) => {
    if (message?.role !== "user") return false;
    if (typeof message.content === "string") return message.content.trim().length > 0;
    return false;
  });
};
