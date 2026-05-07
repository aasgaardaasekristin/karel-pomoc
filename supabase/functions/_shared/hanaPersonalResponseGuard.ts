/**
 * P32.2 — hanaPersonalResponseGuard.ts
 *
 * Output/response guard for the Hana/personal surface.
 *
 * Hard rules:
 *   - In hana_personal Karel must NEVER address Hana as a DID part.
 *   - Phrases like "část Hana", "část Hanička", "Hana frontuje", "Hanička jako část"
 *     are forbidden.
 *   - When Hana mentions a part (e.g. Gustík), Karel must reply to Hana, not switch
 *     and address the part directly ("Gustíku, ...").
 *   - For ambiguous cases, Karel MUST ask a clarifying question and not draw
 *     a conclusion ("To je Gustík.").
 *   - If anything fails resolver-side, the safest fallback (ambiguous) is used.
 *
 * Pure function. No DB, no fetch, no AI.
 */

import type { HanaPersonalIdentityResolution } from "./hanaPersonalIdentityResolver.ts";

export interface HanaPersonalResponseGuardInput {
  responseText: string;
  identityResolution: HanaPersonalIdentityResolution | null;
  userText?: string;
}

export interface HanaPersonalResponseGuardResult {
  ok: boolean;
  blocked: boolean;
  reason?: string;
  warnings: string[];
  safe_fallback_text?: string;
  rewritten_text?: string;
}

const DIACRITICS_RE = /[\u0300-\u036f]/g;

const stripDiacritics = (s: string): string =>
  s.normalize("NFD").replace(DIACRITICS_RE, "");

const norm = (s: string): string =>
  stripDiacritics(s || "").toLowerCase();

// Forbidden "Hana as a DID part" patterns. Match against diacritics-stripped text.
// Use word-boundary windows so "Haničko," vocative on its own is not blocked.
const FORBIDDEN_HANA_AS_PART_PATTERNS: RegExp[] = [
  /\bcast\s+(hana|hanka|hanicka|hani|hanicko|hanko|maminka|mama|mamka|karel|kata|katka)\b/i,
  /\b(hana|hanka|hanicka|hani|maminka|mamka|karel|kata|katka)\s+jako\s+cast\b/i,
  /\b(hana|hanka|hanicka|hani|maminka|mamka)\s+frontuje\b/i,
  /\b(hana|hanka|hanicka|hani|maminka|mamka)\s+je\s+cast\b/i,
  /\bcast\s+jmenem\s+(hana|hanka|hanicka|hani|maminka|mamka|karel|kata|katka)\b/i,
  /\b(ozyva|ozve|ozyval[aoy]?)\s+se\s+cast\s+(hana|hanka|hanicka|hani|maminka|mamka)\b/i,
  /\bco\s+(hanicka|hana|hanka|hani|maminka|mamka)\s+jako\s+cast\b/i,
  /\b(hanicka|hana|hanka|hani|maminka|mamka)\s+(je|byla|bude)\s+jednou\s+z\s+casti\b/i,
];

// Hana therapist alias roots used to detect therapist references / vocatives.
const HANA_VOCATIVE_ROOTS = ["hanicko", "haniko", "hanko", "hani", "hanko"];

const HANA_NAME_ROOTS = [
  "hana", "hanka", "hanicka", "hani", "hanicko", "hanko", "maminka", "mamka", "mama",
];

const KLUCI_GROUP_TOKENS = ["kluci", "deti", "casti", "kluku", "deti", "klucich"];

function startsByAddressingPart(responseText: string, partName: string): boolean {
  if (!partName) return false;
  const head = norm(responseText).trim().slice(0, 80);
  const part = norm(partName);
  if (!part) return false;
  // Vocative roots: take first 4 letters of canonical part as a stem
  const stem = part.slice(0, Math.max(3, part.length - 2));
  // Allow letters after stem (vocative endings -i, -u, -ovi, -e), then comma/space
  const re = new RegExp(`^(ahoj\\s+|cau\\s+|hej\\s+)?${stem}[a-z]{0,4}\\s*[,!:.\\-]`, "i");
  return re.test(head);
}

function responseAddressesPartDirectly(
  responseText: string,
  parts: { canonical_part_name: string }[],
): { hit: boolean; partName?: string } {
  for (const p of parts) {
    if (startsByAddressingPart(responseText, p.canonical_part_name)) {
      return { hit: true, partName: p.canonical_part_name };
    }
  }
  return { hit: false };
}

function responseMentionsSpecificPartName(
  responseText: string,
  parts: { canonical_part_name: string }[],
): string | null {
  const t = norm(responseText);
  for (const p of parts) {
    const stem = norm(p.canonical_part_name).slice(0, Math.max(3, p.canonical_part_name.length - 2));
    if (!stem) continue;
    const re = new RegExp(`\\b${stem}[a-z]{0,4}\\b`, "i");
    if (re.test(t)) return p.canonical_part_name;
  }
  return null;
}

function responseAsksClarification(responseText: string): boolean {
  if (!responseText) return false;
  if (!responseText.includes("?")) return false;
  const t = norm(responseText);
  // Heuristic: question must seem to ask about who is speaking.
  return (
    /\b(ty\s+sama|za\s+sebe|nekdo\s+z\s+kluku|nekdo\s+z\s+casti|kdo\s+to\s+rika|ty\s+nebo|sama\s+za\s+sebe|nektera\s+z\s+casti|nektery\s+z\s+kluku|jsi\s+to\s+ty)\b/i.test(t)
  );
}

function responseClaimsConcretePart(
  responseText: string,
  parts: { canonical_part_name: string }[],
): string | null {
  const t = norm(responseText);
  for (const p of parts) {
    const stem = norm(p.canonical_part_name).slice(0, Math.max(3, p.canonical_part_name.length - 2));
    if (!stem) continue;
    // Patterns like "to je Gustik", "to bude Gustik", "je to Gustik"
    const re = new RegExp(
      `\\b(to\\s+(je|bude|byl[aoy]?)|je\\s+to|bude\\s+to|jednoznacne\\s+je\\s+to)\\s+${stem}[a-z]{0,4}\\b`,
      "i",
    );
    if (re.test(t)) return p.canonical_part_name;
  }
  return null;
}

const REGISTERED_PART_NAMES = [
  "Gustík", "Tundrupek", "Arthur", "Gerhardt", "Timmy", "Locík", "Áma", "Jirka",
];

export function renderSafeHanaPersonalFallback(
  resolution: HanaPersonalIdentityResolution | null,
): string {
  const kind = resolution?.resolution_kind;
  if (kind === "hana_self") {
    return "Haničko, beru to jako tvoji vlastní věc, ne jako projev nějaké části. Zůstanu teď u tebe: co je pro tebe v tuhle chvíli nejtěžší?";
  }
  if (kind === "hana_mentions_part") {
    const partName = resolution?.mentioned_parts?.[0]?.canonical_part_name || "té části";
    return `Haničko, slyším, že mluvíš o ${partName}. Zůstávám ale v rozhovoru s tebou. Můžeme to vzít opatrně jako tvoje pozorování nebo obavu, ne jako přímou řeč té části.`;
  }
  if (kind === "hana_mentions_multiple_parts") {
    const names = (resolution?.mentioned_parts || [])
      .map((p) => p.canonical_part_name)
      .filter(Boolean)
      .join(" a ") || "více částech";
    return `Haničko, slyším, že mluvíš o ${names}. Zůstávám v rozhovoru s tebou — beru to jako tvoje pozorování, ne jako přímou řeč těch částí.`;
  }
  if (kind === "hana_mentions_group_kluci") {
    return "Haničko, slyším, že mluvíš o klucích obecně. Nebudu z toho vybírat jednu konkrétní část bez další opory. Co je teď pro tebe u nich nejdůležitější?";
  }
  // ambiguous_needs_clarification, non_hana_surface, null → safest path
  return "Haničko, tady si to nechci domyslet. Myslíš to teď za sebe, nebo máš pocit, že se ozývá někdo z kluků?";
}

export function validateHanaPersonalResponseIdentity(
  input: HanaPersonalResponseGuardInput,
): HanaPersonalResponseGuardResult {
  const warnings: string[] = [];
  const text = input.responseText || "";
  const resolution = input.identityResolution;

  if (!text.trim()) {
    return {
      ok: false,
      blocked: true,
      reason: "empty_response",
      warnings: ["empty_response_text"],
      safe_fallback_text: renderSafeHanaPersonalFallback(resolution),
    };
  }

  if (!resolution || resolution.surface !== "hana_personal") {
    // Without resolver context the safest move is to ask for clarification.
    return {
      ok: false,
      blocked: true,
      reason: "missing_resolution",
      warnings: ["resolver_unavailable_using_safe_fallback"],
      safe_fallback_text: renderSafeHanaPersonalFallback(null),
    };
  }

  const normText = norm(text);

  // 1) Forbidden "Hana as a DID part" phrases — always blocked.
  for (const re of FORBIDDEN_HANA_AS_PART_PATTERNS) {
    if (re.test(normText)) {
      return {
        ok: false,
        blocked: true,
        reason: "forbidden_hana_as_part_phrase",
        warnings: ["hana_treated_as_did_part"],
        safe_fallback_text: renderSafeHanaPersonalFallback(resolution),
      };
    }
  }

  const kind = resolution.resolution_kind;

  // 2) When Hana mentions a part, Karel must NOT address that part directly.
  if (kind === "hana_mentions_part" || kind === "hana_mentions_multiple_parts") {
    const direct = responseAddressesPartDirectly(text, resolution.mentioned_parts);
    if (direct.hit) {
      return {
        ok: false,
        blocked: true,
        reason: `part_addressed_directly:${direct.partName}`,
        warnings: ["addressing_part_instead_of_hana"],
        safe_fallback_text: renderSafeHanaPersonalFallback(resolution),
      };
    }
  }

  // 3) Group "kluci" → Karel must not pick one concrete part without evidence.
  if (kind === "hana_mentions_group_kluci") {
    const named = responseMentionsSpecificPartName(text, REGISTERED_PART_NAMES.map((n) => ({ canonical_part_name: n })));
    if (named) {
      return {
        ok: false,
        blocked: true,
        reason: `group_response_picked_specific_part:${named}`,
        warnings: ["specific_part_picked_from_group_without_evidence"],
        safe_fallback_text: renderSafeHanaPersonalFallback(resolution),
      };
    }
  }

  // 4) Ambiguous → Karel must ask clarifying question, not assert a part.
  if (kind === "ambiguous_needs_clarification") {
    const claimed = responseClaimsConcretePart(text, REGISTERED_PART_NAMES.map((n) => ({ canonical_part_name: n })));
    if (claimed) {
      return {
        ok: false,
        blocked: true,
        reason: `ambiguous_response_claims_part:${claimed}`,
        warnings: ["ambiguous_resolved_without_evidence"],
        safe_fallback_text: renderSafeHanaPersonalFallback(resolution),
      };
    }
    if (!responseAsksClarification(text)) {
      return {
        ok: false,
        blocked: true,
        reason: "ambiguous_response_missing_clarification",
        warnings: ["ambiguous_did_not_ask_clarifying_question"],
        safe_fallback_text: renderSafeHanaPersonalFallback(resolution),
      };
    }
  }

  return { ok: true, blocked: false, warnings };
}

// Internal export for tests.
export const __internals = {
  norm,
  startsByAddressingPart,
  responseAddressesPartDirectly,
  responseAsksClarification,
  responseClaimsConcretePart,
  FORBIDDEN_HANA_AS_PART_PATTERNS,
  REGISTERED_PART_NAMES,
};
