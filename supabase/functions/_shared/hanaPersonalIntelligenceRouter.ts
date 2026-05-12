/**
 * P33.8A — hanaPersonalIntelligenceRouter.ts
 *
 * Take semantic classifier output and persist:
 *  - external trigger lookups (hana_personal_external_trigger_lookups)
 *  - privacy rules (hana_personal_privacy_rules)
 *  - 00_CENTRUM review queue markers (hana_personal_centrum_review_queue)
 *  - safe DID-relevant card review proposals (card_update_queue, via existing helper)
 *
 * Hard contract:
 *   - never write raw_excerpt to any of these tables
 *   - only safe clinical_summary from the classifier
 *   - upsert by (user_id, source_ref, …) so re-ingestion is idempotent
 */

type SupabaseClient = any;
import type {
  HanaContentItem,
  HanaSemanticClassification,
} from "./hanaPersonalSemanticClassifier.ts";

export interface HanaIntelligenceRouteContext {
  user_id: string;
  source_ref: string;
  source_thread_id?: string | null;
  source_message_ref?: string | null;
  raw_text_for_classifier_only: string;
}

export interface HanaIntelligenceRouteResult {
  external_trigger_lookups_created: number;
  privacy_rules_created: number;
  centrum_review_entries_created: number;
  warnings: string[];
}

export async function routeHanaSemanticItems(
  sb: SupabaseClient,
  classification: HanaSemanticClassification,
  ctx: HanaIntelligenceRouteContext,
): Promise<HanaIntelligenceRouteResult> {
  const result: HanaIntelligenceRouteResult = {
    external_trigger_lookups_created: 0,
    privacy_rules_created: 0,
    centrum_review_entries_created: 0,
    warnings: [],
  };

  for (const item of classification.content_items) {
    if (item.raw_text_allowed_in_drive !== false) {
      result.warnings.push("raw_text_flag_misconfigured");
      continue;
    }

    if (item.type === "external_trigger_report") {
      await writeExternalTrigger(sb, item, ctx, result);
    }
    if (item.type === "safety_privacy_instruction") {
      await writePrivacyRule(sb, item, ctx, result);
    }
    if (item.type === "did_relevant_observation") {
      await writeCentrumReview(sb, item, ctx, result);
    }
    // hana_private_intimate / household_logistical / hana_work_client are routed elsewhere
    // (hana_personal_memory / pantryB) by the existing didEventIngestion path; no
    // additional Drive writes here, by design.
  }

  return result;
}

async function writeExternalTrigger(
  sb: SupabaseClient,
  item: HanaContentItem,
  ctx: HanaIntelligenceRouteContext,
  result: HanaIntelligenceRouteResult,
) {
  if (!item.external_trigger_terms.length) return;
  const theme = item.clinical_summary.slice(0, 240);
  try {
    const { error } = await sb.from("hana_personal_external_trigger_lookups").upsert(
      {
        user_id: ctx.user_id,
        source_thread_id: ctx.source_thread_id ?? null,
        source_message_ref: ctx.source_message_ref ?? null,
        source_ref: ctx.source_ref,
        related_part_name: item.related_parts[0] ?? null,
        related_groups: item.related_groups,
        theme,
        query_terms: item.external_trigger_terms,
        status: "pending",
      },
      { onConflict: "user_id,source_ref,theme" },
    );
    if (error) {
      result.warnings.push(`external_trigger_upsert_failed: ${error.message}`);
      return;
    }
    result.external_trigger_lookups_created++;
  } catch (e: any) {
    result.warnings.push(`external_trigger_upsert_throw: ${e?.message ?? e}`);
  }
}

async function writePrivacyRule(
  sb: SupabaseClient,
  item: HanaContentItem,
  ctx: HanaIntelligenceRouteContext,
  result: HanaIntelligenceRouteResult,
) {
  try {
    const { error } = await sb.from("hana_personal_privacy_rules").upsert(
      {
        user_id: ctx.user_id,
        source_thread_id: ctx.source_thread_id ?? null,
        source_ref: ctx.source_ref,
        instruction_text: item.clinical_summary.slice(0, 1200),
        applies_to_scope: "never_child_visible",
        related_parts: item.related_parts,
        active: true,
      },
      { onConflict: "user_id,source_ref" },
    );
    if (error) {
      result.warnings.push(`privacy_rule_upsert_failed: ${error.message}`);
      return;
    }
    result.privacy_rules_created++;
  } catch (e: any) {
    result.warnings.push(`privacy_rule_upsert_throw: ${e?.message ?? e}`);
  }
}

async function writeCentrumReview(
  sb: SupabaseClient,
  item: HanaContentItem,
  ctx: HanaIntelligenceRouteContext,
  result: HanaIntelligenceRouteResult,
) {
  const partKey = item.related_parts[0] ?? null;
  try {
    const { error } = await sb.from("hana_personal_centrum_review_queue").upsert(
      {
        user_id: ctx.user_id,
        source_thread_id: ctx.source_thread_id ?? null,
        source_ref: ctx.source_ref,
        related_part_name: partKey,
        related_groups: item.related_groups,
        reason: "did_relevant_observation_from_hana_personal",
        safe_summary: item.clinical_summary.slice(0, 1200),
        status: "pending",
      },
      { onConflict: "user_id,source_ref,related_part_name" },
    );
    if (error) {
      result.warnings.push(`centrum_review_upsert_failed: ${error.message}`);
      return;
    }
    result.centrum_review_entries_created++;
  } catch (e: any) {
    result.warnings.push(`centrum_review_upsert_throw: ${e?.message ?? e}`);
  }
}
