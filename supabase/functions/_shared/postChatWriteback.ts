/**
 * postChatWriteback.ts — Phase 5 + 5A + 5B
 *
 * Pure helper for post-chat structured writeback:
 * - validates extracted outputs
 * - routes to exact document targets
 * - applies sensitivity guards
 * - applies evidence quality guards (5B)
 * - deduplicates within a single run
 * - renders governed write content with quality metadata
 * - builds governed write intents
 *
 * NO DB queries. NO side effects. NO raw transcript writes.
 * Caller is responsible for AI extraction + enqueue.
 */

import type {
  ExtractedWriteOutput,
  EvidenceKind,
  ExtractionOutputKind,
  WritebackSensitivity,
  LogicalWriteTarget,
  GovernedWriteIntent,
  WriteBucket,
} from "./phase5Types.ts";

// ── Non-part entities that must NEVER be routed as PART_CARD ──
const NON_PART_NAMES = new Set([
  "hanka", "hanicka", "hana",
  "kata", "kaja",
  "tonicka",
  "amalka",
  "jiri",
  "locik",
]);

function normalizeForGuard(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

const VALID_SECTIONS = new Set(["A","B","C","D","E","F","G","H","I","J","K","L","M"]);

// ── Runtime Enum Validation Sets (Phase 5B-A) ──
const VALID_CONFIDENCE = new Set(["low", "medium", "high"]);
const VALID_FRESHNESS = new Set(["immediate", "recent", "historical", "timeless"]);
const VALID_CHANGE_TYPES = new Set(["new", "update", "repeat", "conflict"]);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

// ── Document Key Mapping ──

function resolveTherapistDocKey(
  kind: ExtractionOutputKind,
  therapistKey: "HANKA" | "KATA",
): string {
  switch (kind) {
    case "SITUACNI":
      return `PAMET_KAREL/DID/${therapistKey}/SITUACNI_ANALYZA`;
    case "POZNATKY":
      return `PAMET_KAREL/DID/${therapistKey}/KARLOVY_POZNATKY`;
    case "STRATEGIE":
      return `PAMET_KAREL/DID/${therapistKey}/STRATEGIE_KOMUNIKACE`;
    case "KAREL":
      return `PAMET_KAREL/DID/${therapistKey}/KAREL`;
    default:
      return `PAMET_KAREL/DID/${therapistKey}/KARLOVY_POZNATKY`;
  }
}

function resolveContextDocKey(kind: ExtractionOutputKind): string {
  switch (kind) {
    case "KDO_JE_KDO":
      return "PAMET_KAREL/DID/KONTEXTY/KDO_JE_KDO";
    case "DULEZITA_DATA":
      return "PAMET_KAREL/DID/KONTEXTY/DULEZITA_DATA";
    case "SLOVNIK":
      return "PAMET_KAREL/DID/KONTEXTY/SLOVNIK";
    case "VZORCE":
      return "PAMET_KAREL/DID/KONTEXTY/VZORCE";
    default:
      return "PAMET_KAREL/DID/KONTEXTY/KDO_JE_KDO";
  }
}

// ── Part Card Bucket Resolution ──

export function resolvePartCardBucket(
  registryStatus: string | null,
  hasRecentDirectActivity: boolean,
  evidenceKind: EvidenceKind,
): "active_part_card" | "dormant_part_card" {
  const normStatus = (registryStatus || "").toLowerCase();
  if (normStatus === "dormant" || normStatus === "sleeping" || normStatus === "spící") {
    return "dormant_part_card";
  }
  if (hasRecentDirectActivity) {
    return "active_part_card";
  }
  if (evidenceKind === "FACT" || evidenceKind === "INFERENCE") {
    return "dormant_part_card";
  }
  return "active_part_card";
}

// ── Validation ──

export interface ValidationResult {
  valid: boolean;
  reason?: string;
}

export function validateOutput(output: ExtractedWriteOutput): ValidationResult {
  // Empty summary
  if (!output.summary || output.summary.trim().length < 5) {
    return { valid: false, reason: "empty_summary" };
  }

  // PART_CARD requires partName + valid section
  if (output.kind === "PART_CARD") {
    if (!output.partName) {
      return { valid: false, reason: "part_card_missing_name" };
    }
    if (!output.section || !VALID_SECTIONS.has(output.section.toUpperCase())) {
      return { valid: false, reason: "part_card_invalid_section" };
    }
    // Guard: non-part names must NOT be routed as PART_CARD
    if (NON_PART_NAMES.has(normalizeForGuard(output.partName))) {
      return { valid: false, reason: "part_card_non_part_entity" };
    }
  }

  // PLAN_05A requires today_3d horizon
  if (output.kind === "PLAN_05A" && output.timeHorizon !== "today_3d") {
    return { valid: false, reason: "plan_05a_wrong_horizon" };
  }

  // PLAN_05B requires 15_60d horizon
  if (output.kind === "PLAN_05B" && output.timeHorizon !== "15_60d") {
    return { valid: false, reason: "plan_05b_wrong_horizon" };
  }

  // Phase 5B-A: runtime enum validation (AI JSON cannot be trusted on type alone)
  if (!isNonEmptyString(output.confidence) || !VALID_CONFIDENCE.has(output.confidence)) {
    return { valid: false, reason: "invalid_confidence" };
  }
  if (!isNonEmptyString(output.freshness) || !VALID_FRESHNESS.has(output.freshness)) {
    return { valid: false, reason: "invalid_freshness" };
  }
  if (!isNonEmptyString(output.changeType) || !VALID_CHANGE_TYPES.has(output.changeType)) {
    return { valid: false, reason: "invalid_changeType" };
  }
  if (typeof output.needsVerification !== "boolean") {
    return { valid: false, reason: "missing_needsVerification" };
  }

  // Phase 5B-A: conditional explanatory fields
  if (output.changeType === "update") {
    if (!isNonEmptyString(output.changeSummary) || output.changeSummary!.trim().length < 8) {
      return { valid: false, reason: "update_missing_changeSummary" };
    }
  }
  if (output.changeType === "conflict") {
    if (!isNonEmptyString(output.conflictNote) || output.conflictNote!.trim().length < 8) {
      return { valid: false, reason: "conflict_missing_conflictNote" };
    }
  }

  return { valid: true };
}

// ── Sensitivity Guard (Phase 5A) ──

export function checkSensitivityGuard(output: ExtractedWriteOutput, targetBucket: WriteBucket): ValidationResult {
  // secret_karel_only → ONLY therapist-scoped docs, NEVER contexts/plans/cards
  if (output.sensitivity === "secret_karel_only") {
    const allowed: WriteBucket[] = ["therapist_hanka", "therapist_kata"];
    if (!allowed.includes(targetBucket)) {
      return { valid: false, reason: `secret_karel_only_leaked_to_${targetBucket}` };
    }
    // Additionally restrict to analytical kinds only
    const allowedKinds = new Set(["SITUACNI", "POZNATKY", "STRATEGIE"]);
    if (!allowedKinds.has(output.kind)) {
      return { valid: false, reason: `secret_karel_only_invalid_kind_${output.kind}` };
    }
  }

  // therapist_private → blocked from part cards AND plans (no abstraction layer yet)
  if (output.sensitivity === "therapist_private") {
    const blocked: WriteBucket[] = [
      "active_part_card",
      "dormant_part_card",
      "plan_05A",
      "plan_05B",
    ];
    if (blocked.includes(targetBucket)) {
      return { valid: false, reason: `therapist_private_leaked_to_${targetBucket}` };
    }
  }

  return { valid: true };
}

// ── Evidence Quality Guard (Phase 5B) ──

export function checkEvidenceQualityGuard(
  output: ExtractedWriteOutput,
  targetBucket: WriteBucket,
): ValidationResult {
  // 1. repeat → always reject (write churn)
  if (output.changeType === "repeat") {
    return { valid: false, reason: "repeat_not_enqueued" };
  }

  // Broad buckets that require higher quality
  const broadBuckets: WriteBucket[] = [
    "contexts",
    "active_part_card",
    "dormant_part_card",
    "plan_05A",
    "plan_05B",
  ];

  // 2. UNKNOWN evidence → only therapist notes
  if (output.evidenceKind === "UNKNOWN") {
    if (broadBuckets.includes(targetBucket)) {
      return { valid: false, reason: `unknown_not_allowed_in_${targetBucket}` };
    }
  }

  // 3. needsVerification → only therapist notes
  if (output.needsVerification) {
    if (broadBuckets.includes(targetBucket)) {
      return { valid: false, reason: `needs_verification_blocked_from_${targetBucket}` };
    }
  }

  // 4. low confidence → not into cards or plans
  if (output.confidence === "low") {
    const lowBlocked: WriteBucket[] = [
      "active_part_card",
      "dormant_part_card",
      "plan_05A",
      "plan_05B",
      "contexts",
    ];
    if (lowBlocked.includes(targetBucket)) {
      return { valid: false, reason: `low_confidence_blocked_from_${targetBucket}` };
    }
  }

  // 5. conflict → only therapist-scoped notes
  if (output.changeType === "conflict") {
    const allowed: WriteBucket[] = ["therapist_hanka", "therapist_kata"];
    if (!allowed.includes(targetBucket)) {
      return { valid: false, reason: `conflict_not_allowed_in_${targetBucket}` };
    }
  }

  // 6. PART_CARD stricter admission
  const isPartCard =
    targetBucket === "active_part_card" || targetBucket === "dormant_part_card";
  if (isPartCard) {
    if (!["FACT", "INFERENCE"].includes(output.evidenceKind)) {
      return { valid: false, reason: "part_card_requires_fact_or_inference" };
    }
    if (output.confidence === "low") {
      return { valid: false, reason: "part_card_low_confidence_blocked" };
    }
    if (output.needsVerification) {
      return { valid: false, reason: "part_card_needs_verification_blocked" };
    }
    if (output.changeType === "conflict") {
      return { valid: false, reason: "part_card_conflict_blocked" };
    }
  }

  return { valid: true };
}

// ── Governed Metadata Resolvers (Phase 5A canonical taxonomy) ──

export function resolveGovernedContentType(intent: GovernedWriteIntent): string {
  const bucket = intent.target.bucket;
  const doc = intent.target.documentKey;

  if (bucket === "active_part_card" || bucket === "dormant_part_card") {
    return "card_section_update";
  }
  if (doc.includes("SITUACNI_ANALYZA")) {
    return "situational_analysis";
  }
  if (doc.includes("KARLOVY_POZNATKY") || doc.endsWith("/KAREL")) {
    return "therapist_memory_note";
  }
  if (doc.includes("STRATEGIE_KOMUNIKACE")) {
    return "therapist_memory_note";
  }
  if (bucket === "plan_05A") {
    return "daily_plan";
  }
  if (bucket === "plan_05B") {
    return "strategic_outlook";
  }
  if (bucket === "contexts") {
    return "general_classification";
  }
  return "general_classification";
}

export function resolveGovernedSubjectType(intent: GovernedWriteIntent): string {
  const bucket = intent.target.bucket;

  if (bucket === "active_part_card" || bucket === "dormant_part_card") {
    return "part";
  }
  if (bucket === "therapist_hanka" || bucket === "therapist_kata") {
    return "therapist";
  }
  if (bucket === "contexts") {
    return "family_context";
  }
  if (bucket === "plan_05A" || bucket === "plan_05B") {
    return "system";
  }
  return "system";
}

export function resolveGovernedSubjectId(
  intent: GovernedWriteIntent,
  therapistKey: "HANKA" | "KATA",
): string {
  const bucket = intent.target.bucket;
  const doc = intent.target.documentKey;

  if (bucket === "active_part_card" || bucket === "dormant_part_card") {
    return doc.split("/").pop()?.replace(/^KARTA_/, "").toLowerCase() || "unknown_part";
  }
  if (bucket === "therapist_hanka") return "hanka";
  if (bucket === "therapist_kata") return "kata";
  if (bucket === "contexts") return "family_context";
  if (bucket === "plan_05A" || bucket === "plan_05B") return "did_system";
  return therapistKey.toLowerCase();
}

// ── Raw Transcript Detection ──

const RAW_TRANSCRIPT_PATTERNS = [
  /^(hani\u010dka|hanka|k\u00e1\u0165a|kata|u\u017eivatel)\s+(\u0159ekla?|napsala?|sd\u011blila?|zm\u00ednila?)\s*[,:]/i,
  /^"[^"]{20,}"/,
  /^(d\u00edt\u011b|\u010d\u00e1st|arthur|clark)\s+(napsal[oa]?|\u0159ekl[oa]?)\s*:/i,
];

function looksLikeRawTranscript(text: string): boolean {
  const trimmed = text.trim();
  for (const pattern of RAW_TRANSCRIPT_PATTERNS) {
    if (pattern.test(trimmed)) return true;
  }
  return false;
}

// ── Deduplication (Phase 5B: includes changeType) ──

function dedupeKey(output: ExtractedWriteOutput, docKey: string): string {
  return [
    output.kind,
    docKey,
    output.changeType,
    output.summary.trim().slice(0, 120).toLowerCase(),
  ].join("|");
}

// ── Content Renderer (Phase 5B: includes quality metadata) ──

function renderGovernedWriteContent(output: ExtractedWriteOutput): string {
  const todayMarker = new Date().toISOString().slice(0, 10);

  const evidenceLabel =
    output.evidenceKind === "FACT" ? "FAKT"
    : output.evidenceKind === "INFERENCE" ? "DEDUKCE"
    : output.evidenceKind === "PLAN" ? "PLÁN"
    : "NEOVĚŘENO";

  const confidenceLabel =
    output.confidence === "high" ? "VYSOKÁ JISTOTA"
    : output.confidence === "medium" ? "STŘEDNÍ JISTOTA"
    : "NÍZKÁ JISTOTA";

  const freshnessLabel =
    output.freshness === "immediate" ? "AKUTNÍ"
    : output.freshness === "recent" ? "NEDÁVNÉ"
    : output.freshness === "historical" ? "HISTORICKÉ"
    : "STABILNÍ VZOREC";

  const changeLabel =
    output.changeType === "new" ? "NOVÉ"
    : output.changeType === "update" ? "AKTUALIZACE"
    : output.changeType === "repeat" ? "OPAKOVÁNÍ"
    : "KONFLIKT";

  const headerParts = [
    `[${evidenceLabel}]`,
    `[${changeLabel}]`,
    `[${confidenceLabel}]`,
    `[${freshnessLabel}]`,
  ];

  if (output.needsVerification) {
    headerParts.push("[VYŽADUJE OVĚŘENÍ]");
  }

  // For PART_CARD, include section in header
  const sectionPrefix = (output.kind === "PART_CARD" && output.section)
    ? `SEKCE ${output.section.toUpperCase()} — `
    : "";

  const lines = [
    `\n=== ${sectionPrefix}${headerParts.join(" ")} ${todayMarker} ===`,
    output.summary,
  ];

  if (output.changeSummary) {
    lines.push(`→ Změna: ${output.changeSummary}`);
  }
  if (output.conflictNote) {
    lines.push(`→ Konflikt: ${output.conflictNote}`);
  }
  if (output.implication) {
    lines.push(`→ Implikace: ${output.implication}`);
  }
  if (output.proposedAction) {
    lines.push(`→ Akce: ${output.proposedAction}`);
  }

  return lines.join("\n");
}

// ── Main Router ──

export interface PartRegistryLookup {
  status: string | null;
  hasRecentDirectActivity: boolean;
}

export interface WritebackContext {
  therapistKey: "HANKA" | "KATA";
  sourceMode: string;
  sourceThreadId?: string | null;
  isHanaPersonal: boolean;
  partRegistryLookup?: (partName: string) => PartRegistryLookup | null;
}

/**
 * Route validated outputs to governed write intents.
 * Returns only valid, deduplicated intents.
 *
 * Guard order: structural → raw transcript → resolve target → sensitivity → quality → dedupe → render
 */
/**
 * Pair of (intent, originating output) — used by callers to drive deterministic
 * downstream evidence persistence WITHOUT heuristic substring matching.
 */
export interface GovernedWriteIntentPair {
  intent: GovernedWriteIntent;
  output: ExtractedWriteOutput;
}

export function buildGovernedWriteIntents(
  outputs: ExtractedWriteOutput[],
  ctx: WritebackContext,
): {
  intents: GovernedWriteIntent[];
  pairs: GovernedWriteIntentPair[];
  rejected: Array<{ output: ExtractedWriteOutput; reason: string }>;
} {
  const intents: GovernedWriteIntent[] = [];
  const pairs: GovernedWriteIntentPair[] = [];
  const rejected: Array<{ output: ExtractedWriteOutput; reason: string }> = [];
  const seenKeys = new Set<string>();

  for (const output of outputs.slice(0, 8)) {
    // 1. Structural validation
    const validation = validateOutput(output);
    if (!validation.valid) {
      rejected.push({ output, reason: validation.reason! });
      continue;
    }

    // 2. Raw transcript guard
    if (looksLikeRawTranscript(output.summary)) {
      rejected.push({ output, reason: "raw_transcript_detected" });
      continue;
    }

    // 3. Resolve target
    let target: LogicalWriteTarget;

    switch (output.kind) {
      case "SITUACNI":
      case "POZNATKY":
      case "STRATEGIE":
      case "KAREL": {
        if (output.kind === "KAREL" && !ctx.isHanaPersonal) {
          rejected.push({ output, reason: "karel_not_hana_personal" });
          continue;
        }
        const thKey = output.therapist === "kata" ? "KATA" : ctx.therapistKey;
        const bucket: WriteBucket = thKey === "KATA" ? "therapist_kata" : "therapist_hanka";
        target = {
          bucket,
          documentKey: resolveTherapistDocKey(output.kind, thKey),
          sensitivity: output.sensitivity,
        };
        break;
      }

      case "KDO_JE_KDO":
      case "DULEZITA_DATA":
      case "SLOVNIK":
      case "VZORCE": {
        target = {
          bucket: "contexts",
          documentKey: resolveContextDocKey(output.kind),
          sensitivity: output.sensitivity,
        };
        break;
      }

      case "PART_CARD": {
        const partName = output.partName!;
        const lookup = ctx.partRegistryLookup?.(partName);
        const bucket = resolvePartCardBucket(
          lookup?.status || null,
          lookup?.hasRecentDirectActivity || false,
          output.evidenceKind,
        );
        const folderPrefix = bucket === "active_part_card"
          ? "KARTOTEKA_DID/01_AKTIVNI_FRAGMENTY"
          : "KARTOTEKA_DID/03_ARCHIV_SPICICH";
        target = {
          bucket,
          documentKey: `${folderPrefix}/KARTA_${partName.toUpperCase()}`,
          sensitivity: output.sensitivity,
        };
        break;
      }

      case "PLAN_05A": {
        target = {
          bucket: "plan_05A",
          documentKey: "KARTOTEKA_DID/00_CENTRUM/05A_OPERATIVNI_PLAN",
          sensitivity: output.sensitivity,
        };
        break;
      }

      case "PLAN_05B": {
        target = {
          bucket: "plan_05B",
          documentKey: "KARTOTEKA_DID/00_CENTRUM/05B_STRATEGICKY_VYHLED",
          sensitivity: output.sensitivity,
        };
        break;
      }

      default:
        rejected.push({ output, reason: `unknown_kind_${output.kind}` });
        continue;
    }

    // 4. Sensitivity guard (Phase 5A)
    const sensitivityCheck = checkSensitivityGuard(output, target.bucket);
    if (!sensitivityCheck.valid) {
      rejected.push({ output, reason: sensitivityCheck.reason! });
      continue;
    }

    // 5. Evidence quality guard (Phase 5B)
    const qualityCheck = checkEvidenceQualityGuard(output, target.bucket);
    if (!qualityCheck.valid) {
      rejected.push({ output, reason: qualityCheck.reason! });
      continue;
    }

    // 6. Deduplicate
    const dk = dedupeKey(output, target.documentKey);
    if (seenKeys.has(dk)) {
      rejected.push({ output, reason: "duplicate" });
      continue;
    }
    seenKeys.add(dk);

    // 7. Render content with quality metadata
    const content = renderGovernedWriteContent(output);

    // 8. Build intent + deterministic pair
    const builtIntent: GovernedWriteIntent = {
      target,
      content,
      evidenceKind: output.evidenceKind,
      sourceMode: ctx.sourceMode,
      sourceThreadId: ctx.sourceThreadId,
    };
    intents.push(builtIntent);
    pairs.push({ intent: builtIntent, output });
  }

  return { intents, pairs, rejected };
}

/**
 * Build the structured extraction prompt for AI.
 * Phase 5B: now requires confidence, freshness, changeType, needsVerification.
 * Phase 2 (FÁZE 2): hard firewall for intimate Hana↔Karel content.
 */
export function buildExtractionPrompt(
  userText: string,
  karelResponse: string,
  modeLabel: string,
  isHanaPersonal: boolean,
): string {
  // ── HARD FIREWALL block injected only for Hana/osobní ──
  // Forces any intimate / partner-relational / erotic content to KAREL + secret_karel_only
  // and BANS leaking that content to PART_CARD / PLAN / KDO_JE_KDO / DULEZITA_DATA.
  const intimacyFirewall = isHanaPersonal ? `
═══ HARD FIREWALL — INTIMNÍ HANA↔KAREL OBSAH ═══
Pokud konverzace obsahuje JAKÝKOLI z těchto motivů:
  - intimní / partnerské / vztahové vyznání mezi Haničkou a Karlem
  - erotický / smyslný / fyzický obsah
  - vyznání lásky, něhy, touhy, oslovení typu "miláčku/lásko"
  - sdílení velmi osobních pochybností o vztahu nebo o Karlovi
  - jakékoli sexuální nebo vysoce intimní téma
PAK PLATÍ ABSOLUTNÍ PRAVIDLA (nesmí být porušena):
  1. kind MUSÍ být "KAREL"
  2. sensitivity MUSÍ být "secret_karel_only"
  3. partName MUSÍ být null
  4. section MUSÍ být null
  5. ZAKÁZÁNO vytvořit pro tento obsah jakýkoli output s kind:
       PART_CARD, PLAN_05A, PLAN_05B, KDO_JE_KDO, DULEZITA_DATA, SLOVNIK, VZORCE
  6. ZAKÁZÁNO zmiňovat tento obsah v outputu typu SITUACNI / POZNATKY / STRATEGIE
       (ty mohou popsat jen obecný emoční rámec, NE intimní detail)
  7. Intimní detail NIKDY nesmí téct do DID kartotéky ani do plánů.
Pokud si nejsi jistý, zda je obsah intimní → klasifikuj jako KAREL + secret_karel_only.
` : "";

  return `Analyzuj pouze relevantní závěry z této konverzace v režimu "${modeLabel}".
${intimacyFirewall}

VSTUP UŽIVATELE:
"${userText.slice(0, 1500)}"

ODPOVĚĎ KARLA:
"${karelResponse.slice(0, 1500)}"

PRAVIDLA:
- NIKDY nevypisuj raw transcript
- NIKDY nevypisuj "uživatel řekl" nebo "Hanička řekla"
- VŽDY formuluj: co Karel zjistil, co z toho plyne, co navrhuje
- Jedno vlákno může vytvořit 0-5 výstupů
- Každý výstup max 3 věty
- Piš STRUČNĚ, analyticky, bez přímých citací

CÍLOVÉ TYPY (kind):
- "SITUACNI" = aktuální psychický stav, nálada, zatížení terapeutky
- "POZNATKY" = Karlovy dedukce o kapacitě, potřebách, vzorcích
- "STRATEGIE" = Karlovy strategické závěry pro komunikaci s terapeutkou
- "KAREL" = vztahový obsah mezi Karlem a Haničkou (POUZE pro Hana/osobní režim!)
- "KDO_JE_KDO" = nová informace o osobě v okolí (ne o DID dětech)
- "DULEZITA_DATA" = data, termíny, čísla, schůzky k zapamatování
- "SLOVNIK" = nový výraz, pojem, neologismus k zapamatování
- "VZORCE" = opakující se vzorec chování, reakce, dynamika
- "PART_CARD" = DID informace o konkrétním dítěti (MUSÍ mít part_name + section A-M)
- "PLAN_05A" = operativní akce na následující 1-3 dny (timeHorizon=today_3d)
- "PLAN_05B" = strategický výhled 2-8 týdnů (timeHorizon=15_60d)

EVIDENCE CLASSIFICATION (evidenceKind):
- "FACT" = přímo řečeno nebo prokázáno
- "INFERENCE" = Karlova dedukce z kontextu
- "PLAN" = navrhovaná akce nebo záměr
- "UNKNOWN" = nejasné, vyžaduje ověření

SENSITIVITY:
- "team_operational" = může jít do týmových výstupů
- "child_card_relevant" = patří do karty dítěte
- "therapist_private" = jen do profilace terapeutky
- "secret_karel_only" = jen Karlova tajná paměť

WRITE QUALITY (povinné pro každý output):
- "confidence": "high" = silně opřené o přímé sdělení, "medium" = rozumná dedukce, "low" = slabý odhad
- "freshness": "immediate" = právě akutní, "recent" = posledních pár dnů, "historical" = starší ale relevantní, "timeless" = stabilní vzorec
- "changeType": "new" = nová informace měnící paměť, "update" = posun v již známé oblasti (použij changeSummary), "repeat" = opakování známého bez nové hodnoty, "conflict" = rozpor nebo protichůdná informace (použij conflictNote)
- "needsVerification": true pokud závěr je nejistý a jeho zápis do širší paměti by byl riskantní

${!isHanaPersonal ? 'UPOZORNĚNÍ: Typ "KAREL" je ZAKÁZÁN mimo Hana/osobní režim.' : ""}

Vrať POUZE validní JSON:
{
  "outputs": [
    {
      "kind": "SITUACNI",
      "evidenceKind": "FACT",
      "sensitivity": "therapist_private",
      "summary": "analytický zápis",
      "implication": "co z toho plyne",
      "proposedAction": "co Karel navrhuje",
      "therapist": "hanka",
      "subject": "o kom/čem",
      "partName": null,
      "section": null,
      "timeHorizon": null,
      "confidence": "high",
      "freshness": "recent",
      "changeType": "new",
      "needsVerification": false,
      "changeSummary": null,
      "conflictNote": null
    }
  ]
}`;
}
