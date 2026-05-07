/**
 * P32 — hanaPersonalIdentityResolver.ts
 *
 * Pure identity resolver for the Hana/personal surface.
 *
 * In hana_personal:
 *   - speaker is ALWAYS the human therapist Hana ("hana_therapist").
 *   - Hana / Hanka / Hanička / Hani / Hanicka / Haničko / Hanko are therapist
 *     aliases and MUST NEVER be treated as a DID part.
 *   - Mentions of DID parts (Gustík/Tundrupek/Arthur/Gerhardt …) only mean
 *     "Hana is talking ABOUT that part". They never switch the speaker.
 *   - "kluci" / "děti" / "části" are group references, not a single part.
 *   - Ambiguous self-vs-part text → ambiguous_needs_clarification (no part write).
 *
 * No I/O, no DB, no fetch. Pure function.
 *
 * Mirrors guardrails of src/lib/therapistIdentity.ts but adds the Hana-personal
 * resolution semantics needed by the chat / writeback pipelines.
 */

export type HanaPersonalResolutionKind =
  | "hana_self"
  | "hana_mentions_part"
  | "hana_mentions_group_kluci"
  | "hana_mentions_multiple_parts"
  | "ambiguous_needs_clarification"
  | "non_hana_surface";

export interface MentionedPart {
  canonical_part_name: string;
  matched_text: string;
  match_type: "exact" | "alias" | "czech_inflection" | "registry_alias";
  confidence: "high" | "medium" | "low";
}

export interface HanaPersonalIdentityResolution {
  surface: "hana_personal";
  speaker_identity: "hana_therapist";
  addressed_identity: "karel";
  resolution_kind: HanaPersonalResolutionKind;
  self_reference_target: "hana_therapist" | "ambiguous";
  mentioned_parts: MentionedPart[];
  mentioned_groups: ("kluci" | "deti" | "casti")[];
  should_switch_speaker_to_part: false;
  should_create_part_card_update: boolean;
  should_create_hana_memory: boolean;
  should_create_part_observation: boolean;
  recommended_memory_targets: string[];
  response_instruction: string;
  confidence: "high" | "medium" | "low";
  warnings: string[];
}

export interface HanaResolverInput {
  text: string;
  knownParts: Array<{
    canonical_part_name: string;
    aliases?: string[];
  }>;
  surface: "hana_personal" | string;
}

// ── Therapist aliases (NEVER a DID part) ──
const HANA_THERAPIST_ALIASES = new Set([
  "hana", "hanka", "hani", "hanicka", "hanicko", "hanko", "maminka", "mama", "mamka",
]);

// ── Czech-stemmed roots for known DID parts (no diacritics, lowercase) ──
// These are conservative stems used for inflection matching.
const BUILTIN_PART_STEMS: Array<{ canonical: string; stems: string[]; minLen: number }> = [
  { canonical: "Gustík",     stems: ["gusti"],      minLen: 5 },
  { canonical: "Tundrupek",  stems: ["tundrup"],    minLen: 7 },
  { canonical: "Arthur",     stems: ["arthur", "artur", "artik", "artic"], minLen: 5 },
  { canonical: "Gerhardt",   stems: ["gerhardt", "gerhard"], minLen: 7 },
  { canonical: "Timmy",      stems: ["timmi", "timmy"], minLen: 5 },
];

const GROUP_TOKENS: Record<string, "kluci" | "deti" | "casti"> = {
  kluci: "kluci", klukum: "kluci", kluku: "kluci",
  deti: "deti", deti_: "deti", det: "deti", detem: "deti",
  casti: "casti", castmi: "casti", castem: "casti",
};

const SELF_REFERENCE_TOKENS = [
  /\bj[aá]\b/i,          // já
  /\bm[ěe]\b/i,          // mě
  /\bmn[eě]\b/i,         // mně
  /\bse\s+mnou\b/i,
  /\bo\s+mn[eě]\b/i,
  /\bjsem\b/i,
  /\bc[ií]t[ií]m\b/i,    // cítím
  /\bm[áa]m\s+pocit\b/i,
  /\bpot[rř]ebuji\b/i,
];

const QUOTING_PART_TOKENS = [
  /\b[čc][áa]st\s+mi\s+[rř]ekla\b/i,
  /\bgust[ií]k\s+[rř]ekl\b/i,
  /\bgust[ií]k\s+mi\s+[rř]ekl\b/i,
  /\btundrup(ek|ka)\s+[rř]ekl\b/i,
  /\barthur\s+[rř]ekl\b/i,
];

const AMBIGUOUS_PHRASES = [
  /nev[ií]m,?\s+(?:jestli\s+)?(?:to\s+)?(?:[rř][ií]k[áa]m|jsem|m[ií]n[ií]m|c[ií]t[ií]m)\s+j[aá]\s+nebo/i,
  /jestli\s+(?:to\s+)?(?:[rř][ií]k[áa]m|m[ií]n[ií]m)\s+j[aá]\s+nebo/i,
];

function stripDiacritics(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function normalizeCzech(s: string): string {
  return stripDiacritics(s).toLowerCase();
}

function tokenize(s: string): string[] {
  return normalizeCzech(s).split(/[^a-z0-9]+/g).filter((t) => t.length > 0);
}

export function isHanaAlias(token: string): boolean {
  return HANA_THERAPIST_ALIASES.has(normalizeCzech(token));
}

/**
 * Conservative Czech-stem match.
 * Requires:
 *   - both strings normalized (no diacritics, lowercase)
 *   - common prefix length >= minLen
 *   - common prefix ratio against the known stem >= 0.75
 *   - never matches Hana aliases
 *   - never matches very short tokens (< 5)
 */
export function isLikelySamePartName(
  knownStem: string,
  token: string,
  minLen = 5,
): boolean {
  const k = normalizeCzech(knownStem);
  const t = normalizeCzech(token);
  if (t.length < minLen) return false;
  if (HANA_THERAPIST_ALIASES.has(t)) return false;
  let i = 0;
  while (i < k.length && i < t.length && k[i] === t[i]) i++;
  if (i < minLen) return false;
  return i / k.length >= 0.75;
}

function matchPartFromToken(
  token: string,
  knownParts: HanaResolverInput["knownParts"],
): MentionedPart | null {
  if (HANA_THERAPIST_ALIASES.has(token)) return null;
  if (token.length < 4) return null;

  // 1) registry aliases first (highest confidence)
  for (const kp of knownParts) {
    const canon = kp.canonical_part_name;
    const canonNorm = normalizeCzech(canon);
    if (HANA_THERAPIST_ALIASES.has(canonNorm)) continue; // safety: never accept Hana from registry
    if (token === canonNorm) {
      return { canonical_part_name: canon, matched_text: token, match_type: "exact", confidence: "high" };
    }
    for (const alias of kp.aliases || []) {
      if (normalizeCzech(alias) === token) {
        return { canonical_part_name: canon, matched_text: token, match_type: "registry_alias", confidence: "high" };
      }
    }
    if (isLikelySamePartName(canonNorm, token, Math.max(5, Math.min(canonNorm.length, 6)))) {
      return { canonical_part_name: canon, matched_text: token, match_type: "czech_inflection", confidence: "medium" };
    }
  }

  // 2) builtin stems
  for (const b of BUILTIN_PART_STEMS) {
    for (const stem of b.stems) {
      if (isLikelySamePartName(stem, token, b.minLen)) {
        return { canonical_part_name: b.canonical, matched_text: token, match_type: "czech_inflection", confidence: "medium" };
      }
    }
  }
  return null;
}

function detectGroups(text: string): ("kluci" | "deti" | "casti")[] {
  const tokens = tokenize(text);
  const out = new Set<"kluci" | "deti" | "casti">();
  for (const t of tokens) {
    const g = GROUP_TOKENS[t];
    if (g) out.add(g);
    if (/^kluk/.test(t)) out.add("kluci");
    if (/^det/.test(t)) out.add("deti");
    if (/^cast/.test(t) && t.length >= 4) out.add("casti");
  }
  return [...out];
}

function detectSelfReference(text: string): boolean {
  return SELF_REFERENCE_TOKENS.some((re) => re.test(text));
}

function detectQuotingPart(text: string): boolean {
  return QUOTING_PART_TOKENS.some((re) => re.test(text));
}

function detectAmbiguous(text: string): boolean {
  return AMBIGUOUS_PHRASES.some((re) => re.test(text));
}

function dedupParts(parts: MentionedPart[]): MentionedPart[] {
  const seen = new Set<string>();
  const out: MentionedPart[] = [];
  for (const p of parts) {
    if (seen.has(p.canonical_part_name)) continue;
    seen.add(p.canonical_part_name);
    out.push(p);
  }
  return out;
}

const HANKA_MEMORY_BASE = "PAMET_KAREL/DID/HANKA";
const HANKA_TARGETS = {
  situational: `${HANKA_MEMORY_BASE}/SITUACNI_ANALYZA.txt`,
  strategy:    `${HANKA_MEMORY_BASE}/STRATEGIE_KOMUNIKACE.txt`,
  threadsLast: `${HANKA_MEMORY_BASE}/VLAKNA_POSLEDNI.txt`,
  threads3d:   `${HANKA_MEMORY_BASE}/VLAKNA_3DNY.txt`,
  profile:     `${HANKA_MEMORY_BASE}/PROFIL_OSOBNOSTI.txt`,
  karel:       `${HANKA_MEMORY_BASE}/KAREL`,
} as const;

function pickMemoryTargetsForSelf(text: string): string[] {
  const t = normalizeCzech(text);
  const targets = new Set<string>([HANKA_TARGETS.situational]);
  if (/strateg|mluv|jinak|pomalej|drz|rytm|tempo/i.test(t)) {
    targets.add(HANKA_TARGETS.strategy);
  }
  targets.add(HANKA_TARGETS.threadsLast);
  return [...targets];
}

export function resolveHanaPersonalIdentity(
  input: HanaResolverInput,
): HanaPersonalIdentityResolution {
  const text = String(input.text || "");
  const warnings: string[] = [];

  if (input.surface !== "hana_personal") {
    return {
      surface: "hana_personal",
      speaker_identity: "hana_therapist",
      addressed_identity: "karel",
      resolution_kind: "non_hana_surface",
      self_reference_target: "ambiguous",
      mentioned_parts: [],
      mentioned_groups: [],
      should_switch_speaker_to_part: false,
      should_create_part_card_update: false,
      should_create_hana_memory: false,
      should_create_part_observation: false,
      recommended_memory_targets: [],
      response_instruction: "Resolver invoked on a non-hana surface. No identity decision made.",
      confidence: "low",
      warnings: ["non_hana_surface"],
    };
  }

  // Filter known parts: registry rows that resolve to Hana aliases must be ignored.
  const safeKnownParts = (input.knownParts || []).filter((kp) => {
    if (!kp?.canonical_part_name) return false;
    if (HANA_THERAPIST_ALIASES.has(normalizeCzech(kp.canonical_part_name))) {
      warnings.push(`registry_part_is_hana_alias_ignored:${kp.canonical_part_name}`);
      return false;
    }
    return true;
  });

  const tokens = tokenize(text);
  const groups = detectGroups(text);

  // Mentions
  const mentions: MentionedPart[] = [];
  for (const tok of tokens) {
    const m = matchPartFromToken(tok, safeKnownParts);
    if (m) mentions.push(m);
  }
  const parts = dedupParts(mentions);

  // Detect ambiguity / self / quoting
  const ambiguous = detectAmbiguous(text);
  const selfRef = detectSelfReference(text);
  const quotesPart = detectQuotingPart(text);

  // Phrase like "část Hana" with no known Hana part → ambiguous
  const explicitPartHana = /\b[čc][áa]st(?:i|í|em|ech)?\s+han(?:a|ka|i[čc]?ka|y|ou)?\b/i.test(text);
  if (explicitPartHana) {
    return {
      surface: "hana_personal",
      speaker_identity: "hana_therapist",
      addressed_identity: "karel",
      resolution_kind: "ambiguous_needs_clarification",
      self_reference_target: "ambiguous",
      mentioned_parts: parts,
      mentioned_groups: groups,
      should_switch_speaker_to_part: false,
      should_create_part_card_update: false,
      should_create_hana_memory: false,
      should_create_part_observation: false,
      recommended_memory_targets: [],
      response_instruction:
        "Hana zmínila „část Hana“. Hana NENÍ DID část. Polož jí jemnou ujasňující otázku, koho přesně myslí, a nezakládej žádný záznam o části.",
      confidence: "low",
      warnings: [...warnings, "explicit_part_hana_phrase"],
    };
  }

  if (ambiguous) {
    return {
      surface: "hana_personal",
      speaker_identity: "hana_therapist",
      addressed_identity: "karel",
      resolution_kind: "ambiguous_needs_clarification",
      self_reference_target: "ambiguous",
      mentioned_parts: parts,
      mentioned_groups: groups,
      should_switch_speaker_to_part: false,
      should_create_part_card_update: false,
      should_create_hana_memory: false,
      should_create_part_observation: false,
      recommended_memory_targets: [],
      response_instruction:
        "Hana sama signalizuje nejistotu, kdo mluví. Jemně se zeptej, jestli to říká za sebe, nebo má pocit, že mluví někdo z kluků. Nezakládej kartu části ani observation.",
      confidence: "low",
      warnings,
    };
  }

  if (parts.length >= 2) {
    return {
      surface: "hana_personal",
      speaker_identity: "hana_therapist",
      addressed_identity: "karel",
      resolution_kind: "hana_mentions_multiple_parts",
      self_reference_target: "hana_therapist",
      mentioned_parts: parts,
      mentioned_groups: groups,
      should_switch_speaker_to_part: false,
      should_create_part_card_update: false,
      should_create_hana_memory: true,
      should_create_part_observation: true,
      recommended_memory_targets: [HANKA_TARGETS.situational, HANKA_TARGETS.threadsLast],
      response_instruction:
        "Hana mluví o více částech najednou. Reaguj jako Karel s Hanou, ne jako k částem. Případnou observation ulož vždy jako reported_by_hana_about_part, nikdy jako řeč části.",
      confidence: "medium",
      warnings,
    };
  }

  if (parts.length === 1) {
    const explicitQuote = quotesPart;
    return {
      surface: "hana_personal",
      speaker_identity: "hana_therapist",
      addressed_identity: "karel",
      resolution_kind: "hana_mentions_part",
      self_reference_target: "hana_therapist",
      mentioned_parts: parts,
      mentioned_groups: groups,
      should_switch_speaker_to_part: false,
      should_create_part_card_update: false,
      should_create_hana_memory: true,
      should_create_part_observation: explicitQuote || parts[0].confidence !== "low",
      recommended_memory_targets: [HANKA_TARGETS.situational, HANKA_TARGETS.threadsLast],
      response_instruction:
        `Hana mluví o části ${parts[0].canonical_part_name}, ale mluvčí zůstává Hana. ` +
        `Neformuluj odpověď jako bys mluvil k ${parts[0].canonical_part_name}. ` +
        `Pokud zakládáš záznam, musí být typu reported_by_hana_about_part (speaker=hana_therapist, about_part=${parts[0].canonical_part_name}).`,
      confidence: "high",
      warnings,
    };
  }

  if (groups.length > 0) {
    return {
      surface: "hana_personal",
      speaker_identity: "hana_therapist",
      addressed_identity: "karel",
      resolution_kind: "hana_mentions_group_kluci",
      self_reference_target: "hana_therapist",
      mentioned_parts: [],
      mentioned_groups: groups,
      should_switch_speaker_to_part: false,
      should_create_part_card_update: false,
      should_create_hana_memory: true,
      should_create_part_observation: false,
      recommended_memory_targets: [HANKA_TARGETS.situational, HANKA_TARGETS.threadsLast],
      response_instruction:
        "Hana mluví o klucích/dětech jako o skupině. Nevybírej jednu konkrétní část. Reaguj k Haně, ne k částem.",
      confidence: "high",
      warnings,
    };
  }

  // Default: Hana speaks about herself
  return {
    surface: "hana_personal",
    speaker_identity: "hana_therapist",
    addressed_identity: "karel",
    resolution_kind: "hana_self",
    self_reference_target: "hana_therapist",
    mentioned_parts: [],
    mentioned_groups: [],
    should_switch_speaker_to_part: false,
    should_create_part_card_update: false,
    should_create_hana_memory: true,
    should_create_part_observation: false,
    recommended_memory_targets: pickMemoryTargetsForSelf(text),
    response_instruction:
      "Hana mluví sama za sebe jako lidská terapeutka. Reaguj jí osobně, NIKDY jako by byla DID část. Nezakládej žádnou kartu části.",
    confidence: selfRef ? "high" : "medium",
    warnings,
  };
}

/**
 * Render a short identity context block to inject into the system prompt.
 */
export function renderIdentityContextBlock(r: HanaPersonalIdentityResolution): string {
  const partList = r.mentioned_parts.length > 0
    ? r.mentioned_parts.map((p) => p.canonical_part_name).join(", ")
    : "(žádné)";
  const groups = r.mentioned_groups.length > 0 ? r.mentioned_groups.join(", ") : "(žádné)";
  return [
    "═══ IDENTITY CONTEXT (Hana/osobní) ═══",
    "- Surface: Hana personal thread.",
    "- Speaker: Hana / Hanka / Hanička je lidská terapeutka, NE DID část.",
    "- Addressed: Karel.",
    `- Resolution: ${r.resolution_kind}`,
    `- Mentioned DID parts: ${partList}`,
    `- Mentioned groups: ${groups}`,
    `- Pravidlo: pokud Hana řekne „já / mně / mě / jsem / cítím“, je to její vlastní výpověď, ne řeč části.`,
    `- NIKDY nereaguj, jako by Hana byla DID část.`,
    `- Mluvčího nepřepínej na část bez explicitní citace.`,
    `- Response instruction: ${r.response_instruction}`,
  ].join("\n");
}
