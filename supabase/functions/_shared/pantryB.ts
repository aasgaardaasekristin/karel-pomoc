/**
 * pantryB.ts — Spižírna B helpers (denní implikační deník)
 *
 * Spižírna B sedí NAD `did_observations` a `did_implications`. Reprezentuje
 * "co z dneška plyne pro zítřek" — návrhy, závěry, follow-up potřeby,
 * změny plánu/hypotézy — ještě než se to rozroutuje do canonical pipeline.
 *
 * Writer (přes den):
 *   - postChatWriteback (post-chat hook)
 *   - karel-team-deliberation-synthesize
 *   - karel-crisis-session-loop
 *   - karel-did-meeting
 *   - karel-crisis-interview
 *
 * Reader (ráno):
 *   - karel-did-daily-cycle → finalizePantryB() → routovat do
 *     did_implications / did_therapist_tasks / did_pending_questions
 *
 * Zákaz: NEPSAT do Spižírny B raw observations. Ty patří do `did_observations`.
 */

import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

export type PantryBEntryKind =
  | "conclusion"
  | "state_change"
  | "proposal"
  | "risk"
  | "followup_need"
  | "plan_change"
  | "hypothesis_change";

export type PantryBSourceKind =
  | "chat_postwriteback"
  | "team_deliberation"
  | "crisis_session"
  | "therapy_session"
  | "did_meeting"
  | "crisis_contact"
  | "manual";

export type PantryBDestination =
  | "did_implications"
  | "did_therapist_tasks"
  | "did_pending_questions"
  | "crisis_event_update"
  | "briefing_input";

export interface AppendPantryBArgs {
  user_id: string;
  entry_kind: PantryBEntryKind;
  source_kind: PantryBSourceKind;
  source_ref?: string;
  summary: string;
  detail?: Record<string, unknown>;
  intended_destinations: PantryBDestination[];
  related_part_name?: string;
  related_therapist?: "hanka" | "kata";
  related_crisis_event_id?: string;
}

/**
 * Append jeden záznam do Spižírny B.
 * Idempotentní pouze pokud volající poskytne stabilní `source_ref` —
 * (úmyslně neděláme dedup tady, protože různé runtime události mohou
 *  produkovat ze stejného threadu více implikací).
 */
export async function appendPantryB(
  sb: SupabaseClient,
  args: AppendPantryBArgs,
): Promise<{ id: string } | null> {
  const summary = (args.summary || "").trim();
  if (!summary) {
    console.warn("[pantryB] skip empty summary", { source: args.source_kind, ref: args.source_ref });
    return null;
  }

  const { data, error } = await sb
    .from("karel_pantry_b_entries")
    .insert({
      user_id: args.user_id,
      entry_kind: args.entry_kind,
      source_kind: args.source_kind,
      source_ref: args.source_ref ?? null,
      summary: summary.slice(0, 2000),
      detail: args.detail ?? {},
      intended_destinations: args.intended_destinations,
      related_part_name: args.related_part_name ?? null,
      related_therapist: args.related_therapist ?? null,
      related_crisis_event_id: args.related_crisis_event_id ?? null,
    })
    .select("id")
    .single();

  if (error) {
    console.error("[pantryB] append failed", error);
    return null;
  }
  return { id: data.id };
}

/**
 * Čtení nezpracovaných záznamů Spižírny B pro daného uživatele a den.
 * Používá `karel-did-daily-cycle` ráno před flushem.
 */
export async function readUnprocessedPantryB(
  sb: SupabaseClient,
  userId: string,
  beforeISO: string = new Date().toISOString(),
) {
  const { data, error } = await sb
    .from("karel_pantry_b_entries")
    .select(
      "id, entry_kind, source_kind, source_ref, summary, detail, intended_destinations, related_part_name, related_therapist, related_crisis_event_id, created_at, flush_result",
    )
    .eq("user_id", userId)
    .is("processed_at", null)
    .lte("created_at", beforeISO)
    .order("created_at", { ascending: true });
  if (error) {
    console.error("[pantryB] read failed", error);
    return [];
  }
  return data ?? [];
}

/**
 * Označit záznamy jako zpracované po flushi do canonical cílů.
 */
export async function markPantryBProcessed(
  sb: SupabaseClient,
  ids: string[],
  processedBy: string,
  flushResult: Record<string, unknown> = {},
): Promise<void> {
  if (!ids.length) return;
  const { error } = await sb
    .from("karel_pantry_b_entries")
    .update({
      processed_at: new Date().toISOString(),
      processed_by: processedBy,
      flush_result: flushResult,
    })
    .in("id", ids);
  if (error) {
    console.error("[pantryB] mark processed failed", error);
  }
}

/**
 * Hard delete vypršených záznamů (>14 dní). Volá se z denního cronu.
 */
export async function purgeExpiredPantryB(sb: SupabaseClient): Promise<number> {
  const { data, error } = await sb
    .from("karel_pantry_b_entries")
    .delete()
    .lt("expires_at", new Date().toISOString())
    .select("id");
  if (error) {
    console.error("[pantryB] purge failed", error);
    return 0;
  }
  return (data ?? []).length;
}
