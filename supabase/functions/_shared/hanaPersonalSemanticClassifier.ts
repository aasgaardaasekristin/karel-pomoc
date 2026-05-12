/**
 * P33.8A — hanaPersonalSemanticClassifier.ts
 *
 * Pure semantic classifier for Hana/osobní messages. Splits each message into
 * typed content_items so the operational pipeline can route DID-relevant items
 * to memory/cards/CENTRUM/briefing while keeping intimate Hana content out of
 * any child-visible report.
 *
 * Hard rules:
 *  - speaker is ALWAYS "hana_therapist" — never a DID part
 *  - intimate Hana guilt/love/death/self-blame content → never_child_visible
 *  - DID-relevant facts may surface as clinically summarized text (no raw)
 *  - external trigger reports MUST produce lookup query candidates
 *  - privacy instruction from Hana overrides visibility
 *
 * No I/O. Pure function.
 */

export type HanaContentType =
  | "hana_private_intimate"
  | "hana_work_client"
  | "did_relevant_observation"
  | "external_trigger_report"
  | "household_logistical"
  | "safety_privacy_instruction";

export type HanaPrivacyTier =
  | "hana_private_only"
  | "therapist_only"
  | "did_clinical_memory"
  | "child_visible_allowed"
  | "never_child_visible";

export type HanaRecommendedRoute =
  | "hana_personal_memory_private"
  | "did_clinical_memory_safe_summary"
  | "part_card_review_entry"
  | "centrum_review_queue"
  | "operational_05a_signal"
  | "external_trigger_lookup"
  | "session_planning_input"
  | "playroom_planning_input"
  | "therapist_task_hanka"
  | "therapist_task_kata"
  | "privacy_constraint_memory";

export interface HanaContentItem {
  type: HanaContentType;
  privacy: HanaPrivacyTier;
  related_parts: string[];
  related_groups: ("kluci" | "deti" | "casti")[];
  external_trigger_terms: string[];
  /** Safe clinical/operational summary; never raw intimate text. */
  clinical_summary: string;
  /** Hard contract: raw payload never enters Drive writes. */
  raw_text_allowed_in_drive: false;
  /** Whether a child-visible safe summary is allowed at all. */
  child_visible_summary_allowed: boolean;
  confidence: "high" | "medium" | "low";
  recommended_routes: HanaRecommendedRoute[];
}

export interface HanaSemanticClassification {
  speaker: "hana_therapist";
  content_items: HanaContentItem[];
  warnings: string[];
}

export interface HanaSemanticClassifierInput {
  text: string;
  threadContext?: { thread_label?: string | null; sub_mode?: string | null } | null;
  knownParts?: Array<{ canonical_part_name: string; aliases?: string[] }>;
}

// ── lexicons ──

const PART_PATTERNS: Array<{ re: RegExp; canonical: string }> = [
  { re: /\b(?:Tundrupek|Tundrupa|Tundrup\w*)\b/i, canonical: "Tundrupek" },
  { re: /\b(?:Arthur|Art[ií]k(?:ovi|a)?|Artur)\b/i, canonical: "Arthur" },
  { re: /\b(?:Gust[ií]k\w*)\b/i, canonical: "Gustík" },
  { re: /\b(?:Gerhardt|Gerhard)\b/i, canonical: "Gerhardt" },
  { re: /\b(?:Timmy|Timmi(?:ho)?)\b/i, canonical: "Timmy" },
];

const GROUP_PATTERNS: Array<{ re: RegExp; group: "kluci" | "deti" | "casti" }> = [
  { re: /\bkluci|kluk[uy]\b/i, group: "kluci" },
  { re: /\bd[eě]ti\b/i, group: "deti" },
  { re: /\b[čc][aá]st(?:i)?\b/i, group: "casti" },
];

// Intimate Hana lexicon (guilt, love-death, despair, longing) — non-exhaustive.
const INTIMATE_RE =
  /\b(?:miluji|l\u00e1sko|n\u00e1dhern|vina|vin[ae]|sebevin|nen[aá]vid[ií]m\s+sebe|nesplnitel|nev[yi]pln[ie]n|sm[rř]t|um[rř]\w*|chyb[ií]\u0161 mi|toulhneme|dotek|intim|nah[aá])/i;

// External trigger lexicon (current real-world events, reported by Hana on behalf of boys).
const EXTERNAL_TRIGGER_LEXICON: Array<{ re: RegExp; terms: string[]; theme: string }> = [
  {
    re: /Faersk[eéá]|Faerske|Faerské\s+ostrov\w*|Grindadr[aá]p|kulohlav\w*|pilot whale|grindadrap/i,
    terms: ["Faerské ostrovy kulohlavci", "Grindadráp pilot whales", "kulohlavci rtuť tuk svaly"],
    theme: "killing of pilot whales / Faroe Islands / Grindadráp",
  },
  {
    re: /v[aá]lk\w*|war(?: in| na)?|ukrajin\w*|gaz[ay]?\w*|izrael\w*/i,
    terms: ["aktuální vývoj válečného konfliktu"],
    theme: "war / armed conflict",
  },
  {
    re: /po[zž][aá]r\w*|wildfire|earthquake|zem[eě]t[rř]es\w*|povode[ňn]\w*/i,
    terms: ["aktuální přírodní katastrofa"],
    theme: "natural disaster",
  },
];

// Safety / privacy instruction lexicon.
const PRIVACY_INSTRUCTION_RE =
  /\b(?:nechci(?:,)?\s+aby|nepi[sš]|nesm[ií]\s+(?:to\s+)?[čcv]?[ií]?[stl]|nem[aá]\s+to\s+[čc][ií]st|nemus[ií] (?:to )?v[eě]d[eě]t|nezve[rř]ej|d[uů]v[eě]rn[eé])\b/i;

// Household / logistical content (children, money, school, transport, family).
const HOUSEHOLD_RE =
  /\b(?:Brno|XY|kontrol\w*|pen[ií]ze|byt|n[aá]jem|[sš]kol\w*|v[yý]let|maturit\w*|d[eě]t[ií]\s+strach|D[eě]n\s+matek|kytk\w*)\b/i;

// Clinical body/affect lexicon helpful for DID-observation classification.
const CLINICAL_BODY_RE =
  /\b(?:pl[aá][cč]\w*|brec\w*|t[ií]ch\w*|stah\w*\s+ramen|t[eě]l\w*|srd[ií]\u010dko|srdce|[uú]zkost|bez\s*moc|moralizuj\w*|vztek|bojov\w*\s+pl[aá]n)\b/i;

// ── helpers ──

function detectParts(text: string, knownParts?: HanaSemanticClassifierInput["knownParts"]): string[] {
  const found = new Set<string>();
  for (const { re, canonical } of PART_PATTERNS) if (re.test(text)) found.add(canonical);
  if (knownParts) {
    for (const p of knownParts) {
      const aliases = [p.canonical_part_name, ...(p.aliases ?? [])];
      for (const a of aliases) {
        if (a && new RegExp(`\\b${a.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}`, "i").test(text)) {
          found.add(p.canonical_part_name);
        }
      }
    }
  }
  return Array.from(found);
}

function detectGroups(text: string): ("kluci" | "deti" | "casti")[] {
  const found = new Set<"kluci" | "deti" | "casti">();
  for (const { re, group } of GROUP_PATTERNS) if (re.test(text)) found.add(group);
  return Array.from(found);
}

function detectExternalTriggers(text: string): Array<{ terms: string[]; theme: string }> {
  const hits: Array<{ terms: string[]; theme: string }> = [];
  for (const t of EXTERNAL_TRIGGER_LEXICON) if (t.re.test(text)) hits.push({ terms: t.terms, theme: t.theme });
  return hits;
}

function compact(s: string, max = 800): string {
  return s.replace(/\s+/g, " ").trim().slice(0, max);
}

// ── main classifier ──

export function classifyHanaPersonalMessage(input: HanaSemanticClassifierInput): HanaSemanticClassification {
  const text = String(input.text || "");
  const items: HanaContentItem[] = [];
  const warnings: string[] = [];

  if (!text.trim()) {
    return { speaker: "hana_therapist", content_items: [], warnings: ["empty_text"] };
  }

  const parts = detectParts(text, input.knownParts);
  const groups = detectGroups(text);
  const triggers = detectExternalTriggers(text);
  const isIntimate = INTIMATE_RE.test(text);
  const isPrivacyInstruction = PRIVACY_INSTRUCTION_RE.test(text);
  const isHousehold = HOUSEHOLD_RE.test(text);
  const isClinicalSignal = CLINICAL_BODY_RE.test(text) && (parts.length > 0 || groups.length > 0);

  // 1) Privacy instruction — extract first because it constrains all later items.
  if (isPrivacyInstruction) {
    items.push({
      type: "safety_privacy_instruction",
      privacy: "therapist_only",
      related_parts: parts,
      related_groups: groups,
      external_trigger_terms: [],
      clinical_summary:
        "Hanička výslovně požádala, aby konkrétní obsah z osobního vlákna nebyl zpřístupněn klukům (zejm. Artíkovi). Uložit jako privacy rule a respektovat ve všech child-visible výstupech.",
      raw_text_allowed_in_drive: false,
      child_visible_summary_allowed: false,
      confidence: "high",
      recommended_routes: ["privacy_constraint_memory"],
    });
  }

  // 2) DID-relevant observation about parts/group.
  if (isClinicalSignal || (parts.length > 0 && (triggers.length > 0 || /pl[aá][cč]|brec|t[ií]ch/i.test(text)))) {
    const primaryPart = parts[0] ?? null;
    const themeBits: string[] = [];
    if (triggers.length) themeBits.push(triggers.map((t) => t.theme).join("; "));
    if (/pl[aá][cč]|brec/i.test(text)) themeBits.push("pláč / smutek");
    if (/bez\s*moc|moraliz|bojov/i.test(text)) themeBits.push("bezmoc / morální vztek / ochranný plán");
    items.push({
      type: "did_relevant_observation",
      privacy: "did_clinical_memory",
      related_parts: parts,
      related_groups: groups,
      external_trigger_terms: triggers.flatMap((t) => t.terms),
      clinical_summary: compact(
        primaryPart
          ? `Hanička popsala terapeutické pozorování o části ${primaryPart}${groups.length ? " / " + groups.join(", ") : ""}: ${themeBits.join("; ") || "nový citlivostní bod"}. Bez raw textu, bez grafických detailů. Použít jako citlivostní kontext, ne jako diagnostický závěr.`
          : `Hanička popsala terapeutický kontext kolem ${groups.join(", ") || "kluků"}: ${themeBits.join("; ")}. Použít jako citlivostní kontext.`,
      ),
      raw_text_allowed_in_drive: false,
      child_visible_summary_allowed: !isPrivacyInstruction,
      confidence: parts.length > 0 ? "high" : "medium",
      recommended_routes: [
        "did_clinical_memory_safe_summary",
        "part_card_review_entry",
        "centrum_review_queue",
        "operational_05a_signal",
        "session_planning_input",
        "playroom_planning_input",
        "therapist_task_hanka",
        "therapist_task_kata",
      ],
    });
  }

  // 3) External trigger report — independent of DID observation, drives lookup.
  if (triggers.length > 0) {
    const allTerms = Array.from(new Set(triggers.flatMap((t) => t.terms)));
    items.push({
      type: "external_trigger_report",
      privacy: "did_clinical_memory",
      related_parts: parts,
      related_groups: groups,
      external_trigger_terms: allTerms,
      clinical_summary: compact(
        `Hanička nahlásila čerstvý externí trigger (${triggers.map((t) => t.theme).join("; ")})${
          parts.length ? ` v souvislosti s ${parts.join(", ")}` : ""
        }. Vyžaduje ad hoc internetové ověření; výsledek držet source-backed, bez grafických detailů.`,
      ),
      raw_text_allowed_in_drive: false,
      child_visible_summary_allowed: !isPrivacyInstruction,
      confidence: "high",
      recommended_routes: ["external_trigger_lookup", "centrum_review_queue", "session_planning_input"],
    });
  }

  // 4) Household / logistical (only kept when potentially clinically relevant).
  if (isHousehold) {
    items.push({
      type: "household_logistical",
      privacy: isPrivacyInstruction ? "therapist_only" : "did_clinical_memory",
      related_parts: parts,
      related_groups: groups,
      external_trigger_terms: [],
      clinical_summary: compact(
        "Hanička zmínila domácí / rodinný / logistický kontext (děti, peníze, škola, výlet, Den matek apod.). Zaznamenat jako kontextový stresor; nepoužívat jako klinický závěr.",
      ),
      raw_text_allowed_in_drive: false,
      child_visible_summary_allowed: false,
      confidence: "medium",
      recommended_routes: ["operational_05a_signal", "therapist_task_hanka"],
    });
  }

  // 5) Intimate Hana content — always private.
  if (isIntimate) {
    items.push({
      type: "hana_private_intimate",
      privacy: "never_child_visible",
      related_parts: [],
      related_groups: [],
      external_trigger_terms: [],
      clinical_summary:
        "Hanička sdílela intimní osobní obsah (vina, láska, smrt, touha). Ukládat výhradně do hana_personal_memory.private; nikdy nezahrnovat do child-visible výstupů.",
      raw_text_allowed_in_drive: false,
      child_visible_summary_allowed: false,
      confidence: "high",
      recommended_routes: ["hana_personal_memory_private"],
    });
  }

  // 6) If nothing matched but text exists, default to private context.
  if (items.length === 0) {
    items.push({
      type: "hana_private_intimate",
      privacy: "hana_private_only",
      related_parts: [],
      related_groups: [],
      external_trigger_terms: [],
      clinical_summary:
        "Osobní obsah Hany bez DID-relevantních signálů; uložit do soukromé paměti, nepoužívat v Karlově přehledu.",
      raw_text_allowed_in_drive: false,
      child_visible_summary_allowed: false,
      confidence: "medium",
      recommended_routes: ["hana_personal_memory_private"],
    });
    warnings.push("no_specific_signal_detected");
  }

  return { speaker: "hana_therapist", content_items: items, warnings };
}

export const __p33_8a_internals = {
  detectParts,
  detectGroups,
  detectExternalTriggers,
  EXTERNAL_TRIGGER_LEXICON,
  INTIMATE_RE,
  PRIVACY_INSTRUCTION_RE,
};
