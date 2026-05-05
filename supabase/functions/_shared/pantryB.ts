// P21: ts-nocheck removed; this file is Deno-side; we rely on existing typings.
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

type SupabaseClient = any;

export type PantryBEntryKind =
  | "conclusion"
  | "observation"
  | "state_change"
  | "proposal"
  | "risk"
  | "followup_need"
  | "plan_change"
  | "hypothesis_change"
  | "task"
  | "admin_note";

export type PantryBSourceKind =
  | "chat_postwriteback"
  | "team_deliberation"
  | "team_deliberation_answer"
  | "briefing_ask_resolution"
  | "crisis_session"
  | "playroom"
  | "therapy_session"
  | "live_session_reality_override"
  | "therapist_task_note"
  | "therapist_note"
  | "hana_personal_ingestion"
  | "did_thread_ingestion"
  | "live_session_progress"
  | "playroom_progress"
  | "deliberation_event"
  | "crisis_safety_event"
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

  if (args.source_ref) {
    let lookup = sb
      .from("karel_pantry_b_entries")
      .select("id")
      .eq("source_kind", args.source_kind)
      .eq("source_ref", args.source_ref)
      .eq("entry_kind", args.entry_kind)
      .order("created_at", { ascending: true })
      .limit(1)
    lookup = args.related_part_name ? lookup.eq("related_part_name", args.related_part_name) : lookup.is("related_part_name", null);
    const { data: existing, error: lookupError } = await lookup.maybeSingle();

    if (lookupError) {
      console.error("[pantryB] idempotency lookup failed", lookupError);
    } else if (existing?.id) {
      return { id: existing.id };
    }
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
  const processedAt = new Date().toISOString();
  const { error } = await sb
    .from("karel_pantry_b_entries")
    .update({
      processed_at: processedAt,
      processed_by: processedBy,
      flush_result: flushResult,
      consumed_by: (flushResult as any)?.briefing_id
        ? [{ layer: "briefing", id: (flushResult as any).briefing_id, via: "pantry_b", at: processedAt }]
        : undefined,
      consumed_at: (flushResult as any)?.briefing_id ? processedAt : undefined,
      pipeline_state: (flushResult as any)?.briefing_id ? "consumed_by_briefing" : undefined,
    })
    .in("id", ids);
  if (error) {
    console.error("[pantryB] mark processed failed", error);
    return;
  }

  // P28 A+B.2 CONSUMPTION-B1: propagate consumed_by markers back into did_event_ingestion_log
  // for any rows whose source_ref was just flushed via pantry → briefing.
  const briefingId = (flushResult as any)?.briefing_id as string | undefined;
  if (!briefingId) return;
  try {
    const { data: pantryRows } = await sb
      .from("karel_pantry_b_entries")
      .select("id, source_ref")
      .in("id", ids);
    const sourceRefs = Array.from(new Set((pantryRows ?? []).map((r: any) => r.source_ref).filter(Boolean)));
    if (!sourceRefs.length) return;
    const { data: logs } = await sb
      .from("did_event_ingestion_log")
      .select("id, source_ref, consumed_by, pipeline_state")
      .in("source_ref", sourceRefs);
    const lockedStates = new Set([
      "drive_written","drive_queued","drive_skipped_governance",
      "drive_failed_unresolved_target","governance_skipped_wrong_target",
    ]);
    for (const log of logs ?? []) {
      const existing: any[] = Array.isArray(log.consumed_by) ? log.consumed_by : [];
      if (existing.some((x: any) => x?.layer === "briefing" && x?.id === briefingId)) continue;
      const pantryRow = (pantryRows ?? []).find((p: any) => p.source_ref === log.source_ref);
      const next = [...existing, {
        layer: "briefing", id: briefingId, via: "pantry_b",
        pantry_id: pantryRow?.id ?? null, at: processedAt,
      }];
      await sb.from("did_event_ingestion_log").update({
        consumed_by: next,
        consumed_at: processedAt,
        pipeline_state: lockedStates.has(log.pipeline_state) ? log.pipeline_state : "consumed_by_briefing",
      }).eq("id", log.id);
    }
  } catch (e) {
    console.error("[pantryB] consumed_by propagation failed", e);
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
