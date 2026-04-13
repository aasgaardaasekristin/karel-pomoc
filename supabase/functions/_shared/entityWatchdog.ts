/**
 * entityWatchdog.ts — FÁZE 2.6
 *
 * Entity watchdog: handles uncertain/contextual entities.
 *
 * When Karel encounters an uncertain or contextually important entity:
 * 1. Creates did_pending_questions for BOTH therapists (entity_verification)
 * 2. Enqueues KDO_JE_KDO write with context via did_pending_drive_writes
 * 3. Records relationship/trigger facts to existing context docs
 *
 * NO new DB tables — uses existing:
 * - did_pending_questions
 * - did_pending_drive_writes
 * - KDO_JE_KDO document
 * - PAMET_KAREL/DID/KONTEXTY/TRIGGERY document
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { encodeGovernedWrite } from "./documentWriteEnvelope.ts";
import type { ResolvedEntity, EntityKind } from "./entityResolution.ts";

// ── Types ──

export interface EntitySourceContext {
  thread_id: string;
  thread_label: string;
  sub_mode: string;
  date_label: string;
  content_excerpt: string;
  user_id: string;
}

export interface EntityContextFact {
  fact_type: "relationship" | "trigger" | "role" | "location" | "seasonal";
  related_entity?: string;
  description: string;
}

const DID_OWNER_ID = "8a7816ee-4fd1-43d4-8d83-4230d7517ae1";

// ── Main Functions ──

/**
 * Handle an uncertain entity: create follow-up questions for both therapists
 * and enqueue a KDO_JE_KDO write.
 *
 * Deduplication: skips if an open/answered entity_verification question
 * already exists for this entity.
 */
export async function handleUncertainEntity(
  supabase: ReturnType<typeof createClient>,
  resolved: ResolvedEntity,
  ctx: EntitySourceContext,
): Promise<{ questions_created: number; kdo_je_kdo_written: boolean }> {
  const entityKey = resolved.normalized_name.toUpperCase();
  let questionsCreated = 0;
  let kdoWritten = false;

  // 1. Check for existing pending questions (dedup)
  const { data: existing } = await supabase
    .from("did_pending_questions")
    .select("id, directed_to")
    .eq("subject_type", "entity_verification")
    .eq("subject_id", entityKey)
    .in("status", ["open", "answered"])
    .limit(5);

  const alreadyAskedTo = new Set(
    (existing ?? []).map((r: any) => String(r.directed_to || "").toLowerCase()),
  );

  // 2. Create questions for BOTH therapists (if not already pending)
  const displayName = resolved.raw_name.charAt(0).toUpperCase() + resolved.raw_name.slice(1);
  const questionText =
    `Karel narazil na jméno "${displayName}" ve vlákně "${ctx.thread_label}" (${ctx.date_label}). ` +
    `Nemůžu určit, zda jde o potvrzenou DID část, alias existující části, reálnou osobu, zvíře, ` +
    `symbolickou bytost nebo něco jiného. ` +
    `Můžeš potvrdit identitu "${displayName}"?`;

  const contextSnippet = ctx.content_excerpt.slice(0, 400);
  const contextNote = `Zdroj: ${ctx.sub_mode}/${ctx.thread_label}\n` +
    `Klasifikace: ${resolved.entity_kind} (confidence: ${resolved.confidence})\n` +
    `Důvody: ${resolved.reasons.join("; ")}\n` +
    `Obsah: ${contextSnippet}`;

  for (const therapist of ["hanka", "kata"] as const) {
    if (alreadyAskedTo.has(therapist) || alreadyAskedTo.has("both")) {
      console.log(`[entityWatchdog] Skip question for "${entityKey}" → ${therapist}: already pending`);
      continue;
    }

    const { error } = await supabase.from("did_pending_questions").insert({
      question: questionText,
      directed_to: therapist,
      context: contextNote,
      subject_type: "entity_verification",
      subject_id: entityKey,
      status: "open",
      blocking: "card_creation",
    });

    if (error) {
      console.warn(`[entityWatchdog] Question insert failed (${therapist}): ${error.message}`);
    } else {
      questionsCreated++;
    }
  }

  // 3. Enqueue KDO_JE_KDO write
  const kindLabel = entityKindLabel(resolved.entity_kind);
  const kdoContent =
    `[${ctx.date_label} | ${ctx.sub_mode}] ${displayName}: ${kindLabel}. ` +
    `Kontext: ${contextSnippet.slice(0, 200)}. ` +
    `[K OVĚŘENÍ TERAPEUTY]`;

  const { error: writeErr } = await supabase.from("did_pending_drive_writes").insert({
    target_document: "PAMET_KAREL/DID/KONTEXTY/KDO_JE_KDO",
    content: encodeGovernedWrite(kdoContent, {
      source_type: "entity-watchdog",
      source_id: ctx.thread_id,
      content_type: "general_classification",
      subject_type: "family_context",
      subject_id: resolved.normalized_name,
    }),
    write_type: "append",
    priority: "normal",
    status: "pending",
    user_id: ctx.user_id || DID_OWNER_ID,
  });

  if (writeErr) {
    console.warn(`[entityWatchdog] KDO_JE_KDO write failed: ${writeErr.message}`);
  } else {
    kdoWritten = true;
  }

  return { questions_created: questionsCreated, kdo_je_kdo_written: kdoWritten };
}

/**
 * Record contextual facts about a resolved entity.
 * Writes to KDO_JE_KDO for identity/role facts,
 * and PAMET_KAREL/DID/KONTEXTY/TRIGGERY for trigger associations.
 *
 * Used for entities that aren't uncertain but carry contextual information
 * (external_person, animal, family_member, symbolic_inner_figure, etc.).
 */
export async function recordEntityContext(
  supabase: ReturnType<typeof createClient>,
  resolved: ResolvedEntity,
  facts: EntityContextFact[],
  sourceContext: EntitySourceContext,
): Promise<{ writes_enqueued: number }> {
  let writesEnqueued = 0;
  const displayName = resolved.raw_name.charAt(0).toUpperCase() + resolved.raw_name.slice(1);
  const kindLabel = entityKindLabel(resolved.entity_kind);

  for (const fact of facts) {
    const isTrigger = fact.fact_type === "trigger" || fact.fact_type === "seasonal";
    const targetDoc = isTrigger
      ? "PAMET_KAREL/DID/KONTEXTY/TRIGGERY"
      : "PAMET_KAREL/DID/KONTEXTY/KDO_JE_KDO";

    const content = isTrigger
      ? `[${sourceContext.date_label}] TRIGGER/VZOREC: ${displayName} (${kindLabel}). ` +
        `${fact.description}${fact.related_entity ? ` Souvisí s: ${fact.related_entity}.` : ""}`
      : `[${sourceContext.date_label}] ${displayName} (${kindLabel}): ` +
        `${fact.description}${fact.related_entity ? ` Vazba: ${fact.related_entity}.` : ""}`;

    const { error } = await supabase.from("did_pending_drive_writes").insert({
      target_document: targetDoc,
      content: encodeGovernedWrite(content, {
        source_type: "entity-watchdog",
        source_id: sourceContext.thread_id,
        content_type: isTrigger ? "pattern_observation" : "general_classification",
        subject_type: resolved.entity_kind === "animal" || resolved.entity_kind === "family_member"
          ? "family_context" : "system",
        subject_id: resolved.normalized_name,
      }),
      write_type: "append",
      priority: "normal",
      status: "pending",
      user_id: sourceContext.user_id || DID_OWNER_ID,
    });

    if (error) {
      console.warn(`[entityWatchdog] Context write failed: ${error.message}`);
    } else {
      writesEnqueued++;
    }
  }

  return { writes_enqueued: writesEnqueued };
}

// ── Helpers ──

function entityKindLabel(kind: EntityKind): string {
  const labels: Record<EntityKind, string> = {
    confirmed_did_part: "potvrzená DID část",
    confirmed_part_alias: "alias potvrzené části",
    external_person: "reálná osoba (ne DID část)",
    animal: "zvíře",
    therapist: "terapeut",
    family_member: "rodinný příslušník",
    symbolic_inner_figure: "symbolická/vnitřní bytost",
    inner_world_nonembodied: "vnitřní neztělesněná postava",
    context_object: "kontextový objekt",
    uncertain_entity: "neověřená entita",
    forbidden_as_part: "zakázaná jako DID část",
  };
  return labels[kind] || "neznámá klasifikace";
}
