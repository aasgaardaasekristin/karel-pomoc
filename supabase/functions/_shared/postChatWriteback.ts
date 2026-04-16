/**
 * postChatWriteback.ts — Phase 5
 *
 * Pure helper for post-chat structured writeback:
 * - validates extracted outputs
 * - routes to exact document targets
 * - applies sensitivity guards
 * - deduplicates within a single run
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
  "hanka", "hanička", "hanicka", "hana",
  "káťa", "kata", "kája",
  "tonička", "tonicka",
  "amálka", "amalka",
  "jiří", "jiri",
  "locík", "locik",
]);

function normalizeForGuard(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

const VALID_SECTIONS = new Set(["A","B","C","D","E","F","G","H","I","J","K","L","M"]);

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
  // No direct activity + fact/inference about part → dormant by default
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

  return { valid: true };
}

// ── Sensitivity Guard ──

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

// ── Governed Metadata Resolvers ──

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
  /^(hanička|hanka|káťa|kata|uživatel)\s+(řekla?|napsala?|sdělila?|zmínila?)\s*[,:]/i,
  /^"[^"]{20,}"/,  // Starts with a long quoted string
  /^(dítě|část|arthur|clark)\s+(napsal[oa]?|řekl[oa]?)\s*:/i,
];

function looksLikeRawTranscript(text: string): boolean {
  const trimmed = text.trim();
  for (const pattern of RAW_TRANSCRIPT_PATTERNS) {
    if (pattern.test(trimmed)) return true;
  }
  return false;
}

// ── Deduplication ──

function dedupeKey(output: ExtractedWriteOutput, docKey: string): string {
  return `${output.kind}|${docKey}|${output.summary.trim().slice(0, 100).toLowerCase()}`;
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
 */
export function buildGovernedWriteIntents(
  outputs: ExtractedWriteOutput[],
  ctx: WritebackContext,
): { intents: GovernedWriteIntent[]; rejected: Array<{ output: ExtractedWriteOutput; reason: string }> } {
  const intents: GovernedWriteIntent[] = [];
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
        // KAREL only for Hana/osobní
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

    // 4. Sensitivity guard
    const sensitivityCheck = checkSensitivityGuard(output, target.bucket);
    if (!sensitivityCheck.valid) {
      rejected.push({ output, reason: sensitivityCheck.reason! });
      continue;
    }

    // 5. Deduplicate
    const dk = dedupeKey(output, target.documentKey);
    if (seenKeys.has(dk)) {
      rejected.push({ output, reason: "duplicate" });
      continue;
    }
    seenKeys.add(dk);

    // 6. Build content block
    const todayMarker = new Date().toISOString().slice(0, 10);
    const evidenceLabel = output.evidenceKind === "FACT" ? "FAKT"
      : output.evidenceKind === "INFERENCE" ? "DEDUKCE"
      : output.evidenceKind === "PLAN" ? "PLÁN"
      : "NEOVĚŘENO";

    const contentParts = [
      `\n=== [${evidenceLabel}] ${todayMarker} ===`,
      output.summary,
    ];
    if (output.implication) {
      contentParts.push(`→ Implikace: ${output.implication}`);
    }
    if (output.proposedAction) {
      contentParts.push(`→ Akce: ${output.proposedAction}`);
    }
    if (output.kind === "PART_CARD" && output.section) {
      contentParts[0] = `\n=== SEKCE ${output.section.toUpperCase()} — [${evidenceLabel}] ${todayMarker} ===`;
    }

    intents.push({
      target,
      content: contentParts.join("\n"),
      evidenceKind: output.evidenceKind,
      sourceMode: ctx.sourceMode,
      sourceThreadId: ctx.sourceThreadId,
    });
  }

  return { intents, rejected };
}

/**
 * Build the structured extraction prompt for AI.
 */
export function buildExtractionPrompt(
  userText: string,
  karelResponse: string,
  modeLabel: string,
  isHanaPersonal: boolean,
): string {
  return `Analyzuj pouze relevantní závěry z této konverzace v režimu "${modeLabel}".

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
      "timeHorizon": null
    }
  ]
}`;
}
