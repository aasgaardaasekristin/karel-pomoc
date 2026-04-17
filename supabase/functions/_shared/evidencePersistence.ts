/**
 * evidencePersistence.ts — FÁZE 2B
 *
 * Sjednocený most mezi post-chat extrakcí (postChatWriteback / phase5Types)
 * a existující evidence pipeline v DB:
 *
 *   ExtractedWriteOutput  ─┬─→ did_observations         (vždy)
 *                          ├─→ did_implications + did_plan_items   (PLAN_05A / PLAN_05B)
 *                          ├─→ did_profile_claims                   (PART_CARD)
 *                          ├─→ did_pending_questions                (needsVerification = true)
 *                          └─→ did_doc_sync_log                     (audit Drive enqueue)
 *
 * NEVYTVÁŘÍ druhou writeback vrstvu, jen dopojuje existující helpers:
 *  - createObservation  (observations.ts)
 *  - deriveImplication  (implications.ts)
 *
 * Sensitivity firewall:
 *  - secret_karel_only  → NIKDY do observations/claims/plan_items/pending_questions.
 *  - therapist_private  → NIKDY do PART_CARD claim ani plan_item.
 *
 * Idempotence:
 *  - source_ref kombinuje sourceMode + threadId + summary hash → skip duplicate.
 *
 * NO Drive I/O, NO AI calls.
 */

import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { createObservation } from "./observations.ts";
import { deriveImplication } from "./implications.ts";
import type {
  ExtractedWriteOutput,
  GovernedWriteIntent,
  WriteConfidence,
  FreshnessBand,
  ChangeType,
  EvidenceKind,
} from "./phase5Types.ts";

// ── Mapping helpers ──

function confidenceToNumber(c: WriteConfidence): number {
  switch (c) {
    case "high": return 0.85;
    case "medium": return 0.6;
    case "low": return 0.3;
    default: return 0.5;
  }
}

function evidenceKindToLevel(kind: EvidenceKind): "D1" | "D2" | "D3" | "I1" | "H1" {
  switch (kind) {
    case "FACT": return "D2";        // direct, observed
    case "INFERENCE": return "I1";   // Karel's inference
    case "PLAN": return "I1";        // intent / planning
    case "UNKNOWN": return "H1";     // hypothesis, needs proof
    default: return "I1";
  }
}

function freshnessToHorizon(f: FreshnessBand): "hours" | "0_14d" | "15_60d" | "long_term" {
  switch (f) {
    case "immediate": return "hours";
    case "recent": return "0_14d";
    case "historical": return "15_60d";
    case "timeless": return "long_term";
    default: return "0_14d";
  }
}

function resolveSubjectType(
  output: ExtractedWriteOutput,
  intent: GovernedWriteIntent,
): "part" | "therapist" | "system" | "context" | "crisis" | "logistics" {
  const bucket = intent.target.bucket;
  if (bucket === "active_part_card" || bucket === "dormant_part_card") return "part";
  if (bucket === "therapist_hanka" || bucket === "therapist_kata") return "therapist";
  if (bucket === "contexts") return "context";
  if (bucket === "plan_05A" || bucket === "plan_05B") return "system";
  return "system";
}

function resolveSubjectId(
  output: ExtractedWriteOutput,
  intent: GovernedWriteIntent,
  therapistKey: "HANKA" | "KATA",
): string {
  const bucket = intent.target.bucket;
  if (bucket === "active_part_card" || bucket === "dormant_part_card") {
    return (output.partName || "unknown_part").toLowerCase();
  }
  if (bucket === "therapist_hanka") return "hanka";
  if (bucket === "therapist_kata") return "kata";
  if (bucket === "contexts") return output.subject?.slice(0, 80) || "family_context";
  if (bucket === "plan_05A" || bucket === "plan_05B") {
    return output.subject?.slice(0, 80) || "did_system";
  }
  return therapistKey.toLowerCase();
}

function resolveImpactType(
  output: ExtractedWriteOutput,
  intent: GovernedWriteIntent,
): "context_only" | "immediate_plan" | "part_profile" | "risk" | "team_coordination" {
  const bucket = intent.target.bucket;
  if (bucket === "plan_05A") return "immediate_plan";
  if (bucket === "plan_05B") return "part_profile";
  if (bucket === "active_part_card" || bucket === "dormant_part_card") return "part_profile";
  if (bucket === "therapist_hanka" || bucket === "therapist_kata") return "team_coordination";
  return "context_only";
}

function hashSummary(s: string): string {
  // simple deterministic hash for source_ref dedupe (not crypto-grade)
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36).slice(0, 8);
}

// ── Public API ──

export interface EvidencePersistenceContext {
  therapistKey: "HANKA" | "KATA";
  sourceMode: string;
  sourceThreadId?: string | null;
  sourceType?:
    | "thread"
    | "task_feedback"
    | "session"
    | "switch"
    | "pulse_check"
    | "board_note"
    | "meeting"
    | "drive_doc"
    | "web_research"
    | "therapist_message"
    | "part_direct";
  userId?: string | null;
}

export interface EvidencePersistenceResult {
  observation_id: string | null;
  implication_id?: string | null;
  plan_item_id?: string | null;
  claim_id?: string | null;
  question_id?: string | null;
  skipped_reason?: string;
}

/**
 * Persist a single (output, intent) pair into the DB evidence pipeline.
 * Sensitivity guard inside: secret_karel_only never lands in DB,
 * therapist_private never lands in part claim or plan item.
 */
export async function persistEvidenceForIntent(
  sb: SupabaseClient,
  output: ExtractedWriteOutput,
  intent: GovernedWriteIntent,
  ctx: EvidencePersistenceContext,
): Promise<EvidencePersistenceResult> {
  // ── Hard firewall: secret_karel_only stays only in Drive's KAREL doc ──
  if (output.sensitivity === "secret_karel_only") {
    return { observation_id: null, skipped_reason: "secret_karel_only_db_blocked" };
  }

  const subjectType = resolveSubjectType(output, intent);
  const subjectId = resolveSubjectId(output, intent, ctx.therapistKey);
  const sourceRef = `${ctx.sourceMode}|${ctx.sourceThreadId || "no-thread"}|${hashSummary(output.summary)}`;

  // ── Idempotence: skip if same source_ref already exists in last 24h ──
  try {
    const { data: existing } = await sb
      .from("did_observations")
      .select("id")
      .eq("source_ref", sourceRef)
      .gte("created_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
      .limit(1)
      .maybeSingle();
    if (existing?.id) {
      return { observation_id: existing.id, skipped_reason: "duplicate_source_ref" };
    }
  } catch (_) {
    // non-fatal — continue
  }

  // ── 1. did_observations (always, when allowed) ──
  let observationId: string | null = null;
  try {
    const obsId = await createObservation(sb, {
      subject_type: subjectType,
      subject_id: subjectId,
      source_type: ctx.sourceType || "thread",
      source_ref: sourceRef,
      fact: output.summary.slice(0, 1000),
      evidence_level: evidenceKindToLevel(output.evidenceKind),
      confidence: confidenceToNumber(output.confidence),
      time_horizon: freshnessToHorizon(output.freshness),
    });

    // Phase 2B: enrich with quality metadata columns
    await sb.from("did_observations").update({
      freshness_band: output.freshness,
      confidence_band: output.confidence,
      change_type: output.changeType,
      needs_verification: !!output.needsVerification,
      evidence_kind: output.evidenceKind,
    }).eq("id", obsId);

    observationId = obsId;
  } catch (e) {
    console.warn(`[evidencePersistence] observation insert failed:`, e);
    return { observation_id: null, skipped_reason: "observation_insert_failed" };
  }

  const result: EvidencePersistenceResult = { observation_id: observationId };

  // ── 2. PLAN_05A / PLAN_05B → implication + plan_item ──
  if (output.kind === "PLAN_05A" || output.kind === "PLAN_05B") {
    if (output.sensitivity === "therapist_private") {
      // Therapist private must not become a generic plan item
      result.skipped_reason = "therapist_private_skipped_plan_item";
    } else {
      try {
        const planType = output.kind === "PLAN_05A" ? "05A" : "05B";
        const reviewHours = planType === "05A" ? 24 : 7 * 24;
        const expiresHours = planType === "05A" ? 72 : 60 * 24;
        const now = Date.now();

        const implId = await deriveImplication(sb, {
          observation_id: observationId,
          impact_type: planType === "05A" ? "immediate_plan" : "part_profile",
          destinations: [planType, intent.target.documentKey],
          implication_text: (output.implication || output.summary).slice(0, 600),
          review_at: new Date(now + reviewHours * 60 * 60 * 1000).toISOString(),
          expires_at: new Date(now + expiresHours * 60 * 60 * 1000).toISOString(),
        });
        result.implication_id = implId;

        // Plan item — only if there is an actionable proposal
        const actionText = output.proposedAction || output.implication || output.summary;
        if (actionText && actionText.trim().length > 5) {
          const { data: planRow } = await sb.from("did_plan_items").insert({
            plan_type: planType,
            section: planType === "05A" ? "akce" : "vyhled",
            subject_type: subjectType === "part" ? "part" : subjectType,
            subject_id: subjectId,
            content: output.summary.slice(0, 800),
            priority: output.confidence === "high" ? "high" : "normal",
            action_required: actionText.slice(0, 500),
            assigned_to: ctx.therapistKey === "KATA" ? "kata" : "hanka",
            status: "active",
            review_at: new Date(now + reviewHours * 60 * 60 * 1000).toISOString(),
            expires_at: new Date(now + expiresHours * 60 * 60 * 1000).toISOString(),
            source_implication_id: implId,
            source_observation_ids: [observationId],
          }).select("id").maybeSingle();
          result.plan_item_id = planRow?.id || null;
        }
      } catch (e) {
        console.warn("[evidencePersistence] plan_item / implication failed:", e);
      }
    }
  }

  // ── 3. PART_CARD → did_profile_claims ──
  if (output.kind === "PART_CARD" && output.partName && output.section) {
    if (output.sensitivity === "therapist_private") {
      result.skipped_reason = "therapist_private_blocked_from_claim";
    } else if (output.evidenceKind === "FACT" || output.evidenceKind === "INFERENCE") {
      try {
        const claimType =
          output.evidenceKind === "FACT" ? "stable_trait" :
          output.changeType === "new" ? "current_state" :
          "hypothesis";
        const { data: claimRow } = await sb.from("did_profile_claims").insert({
          part_name: output.partName,
          card_section: output.section.toUpperCase(),
          claim_type: claimType,
          claim_text: output.summary.slice(0, 800),
          evidence_level: evidenceKindToLevel(output.evidenceKind),
          confidence: confidenceToNumber(output.confidence),
          source_observation_ids: [observationId],
          status: "active",
        }).select("id").maybeSingle();
        result.claim_id = claimRow?.id || null;
      } catch (e) {
        console.warn("[evidencePersistence] claim insert failed:", e);
      }
    }
  }

  // ── 4. needsVerification → did_pending_questions ──
  if (output.needsVerification && output.sensitivity !== "secret_karel_only") {
    try {
      const directedTo =
        ctx.therapistKey === "KATA" ? "kata" :
        intent.target.bucket === "therapist_kata" ? "kata" : "hanka";
      const questionText =
        output.changeType === "conflict" && output.conflictNote
          ? `Konflikt vyžaduje ověření: ${output.conflictNote}`
          : `Ověření závěru: ${output.summary.slice(0, 240)}`;
      const { data: qRow } = await sb.from("did_pending_questions").insert({
        question: questionText.slice(0, 500),
        context: `Zdroj: ${ctx.sourceMode} (${ctx.sourceThreadId || "no-thread"})`,
        subject_type: subjectType,
        subject_id: subjectId,
        directed_to: directedTo,
        status: "open",
        expires_at: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString(),
      }).select("id").maybeSingle();
      result.question_id = qRow?.id || null;
    } catch (e) {
      console.warn("[evidencePersistence] pending question insert failed:", e);
    }
  }

  return result;
}

/**
 * Audit a Drive enqueue into did_doc_sync_log.
 * Does NOT touch evidence tables — pure auditing.
 */
export async function auditDriveEnqueue(
  sb: SupabaseClient,
  args: {
    intent: GovernedWriteIntent;
    observationId: string | null;
    contentType: string;
    subjectType: string;
    subjectId: string;
    userId?: string | null;
    success: boolean;
    errorMessage?: string;
  },
): Promise<void> {
  const { intent, observationId, contentType, subjectType, subjectId, userId, success, errorMessage } = args;
  try {
    await sb.from("did_doc_sync_log").insert({
      source_type: "post_chat_writeback",
      source_id: observationId || crypto.randomUUID(),
      target_document: intent.target.documentKey,
      content_written: intent.content.slice(0, 1500),
      success,
      error_message: errorMessage || null,
      sync_type: "evidence_pipeline",
      content_type: contentType,
      subject_type: subjectType,
      subject_id: subjectId,
      status: success ? "ok" : "error",
      user_id: userId || null,
    });
  } catch (e) {
    // never let audit kill the writeback
    console.warn("[evidencePersistence] audit insert failed (non-fatal):", e);
  }
}
