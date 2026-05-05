// P28 C+D+I — client-side helper for active activity sessions and dynamic pipeline events.
// Every submit/send/reply/update surface should call markActivity() and writeDynamicPipelineEvent()
// so Karel reacts to live actions instead of waiting for the 15-min global poll.
import { supabase } from "@/integrations/supabase/client";

export type SurfaceType =
  | "hana_personal_thread"
  | "did_part_chat_thread"
  | "therapist_task_answer"
  | "team_deliberation_answer"
  | "playroom_deliberation_answer"
  | "session_approval_answer"
  | "live_session_block_update"
  | "playroom_block_update"
  | "card_update_discussion"
  | "daily_plan_edit";

export type DynamicEventType =
  | "message_sent"
  | "task_answered"
  | "deliberation_answered"
  | "block_updated"
  | "block_completed"
  | "block_skipped"
  | "block_changed"
  | "plan_edited"
  | "session_paused"
  | "session_resumed";

export interface MarkActivityInput {
  surface: string;
  surfaceId: string;
  surfaceType: SurfaceType;
  metadata?: Record<string, unknown>;
}

export interface WritePipelineEventInput {
  surfaceType: SurfaceType;
  surfaceId: string;
  eventType: DynamicEventType;
  sourceTable?: string;
  sourceRowId?: string;
  safeSummary?: string;
  rawAllowed?: boolean;
  dedupeKey?: string;
  semanticDedupeKey?: string;
  metadata?: Record<string, unknown>;
}

const fnv1a = (s: string): string => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16);
};

export const buildDedupeKey = (parts: Array<string | number | null | undefined>): string =>
  fnv1a(parts.map((p) => String(p ?? "")).join("|"));

export async function markActivity(input: MarkActivityInput): Promise<string | null> {
  try {
    const { data, error } = await (supabase as any).rpc("upsert_active_activity_session", {
      p_surface: input.surface,
      p_surface_id: input.surfaceId,
      p_surface_type: input.surfaceType,
      p_metadata: input.metadata ?? {},
    });
    if (error) {
      console.warn("[dynamicPipeline] markActivity failed", error.message);
      return null;
    }
    return (data as string) ?? null;
  } catch (e) {
    console.warn("[dynamicPipeline] markActivity error", (e as Error)?.message);
    return null;
  }
}

export async function writeDynamicPipelineEvent(input: WritePipelineEventInput): Promise<string | null> {
  try {
    const { data: u } = await supabase.auth.getUser();
    const userId = u?.user?.id;
    if (!userId) return null;

    const dedupeKey =
      input.dedupeKey ??
      buildDedupeKey([input.surfaceType, input.surfaceId, input.eventType, input.sourceRowId, Date.now()]);

    const { data, error } = await (supabase as any)
      .from("dynamic_pipeline_events")
      .insert({
        user_id: userId,
        surface_type: input.surfaceType,
        surface_id: input.surfaceId,
        event_type: input.eventType,
        source_table: input.sourceTable ?? null,
        source_row_id: input.sourceRowId ?? null,
        safe_summary: input.safeSummary ?? null,
        raw_allowed: input.rawAllowed ?? false,
        pipeline_state: "new_event",
        dedupe_key: dedupeKey,
        semantic_dedupe_key: input.semanticDedupeKey ?? null,
        metadata: input.metadata ?? {},
      })
      .select("id")
      .maybeSingle();

    if (error) {
      // 23505 = unique violation (dedupe). Treat as success — event already captured.
      if ((error as any).code === "23505") return null;
      console.warn("[dynamicPipeline] writeEvent failed", error.message);
      return null;
    }
    return (data as { id: string } | null)?.id ?? null;
  } catch (e) {
    console.warn("[dynamicPipeline] writeEvent error", (e as Error)?.message);
    return null;
  }
}

/** Convenience: mark + write in one call. Fire-and-forget safe. */
export async function recordSurfaceSubmission(
  activity: MarkActivityInput,
  event: Omit<WritePipelineEventInput, "surfaceType" | "surfaceId"> & {
    surfaceType?: SurfaceType;
    surfaceId?: string;
  },
): Promise<{ activityId: string | null; eventId: string | null }> {
  const [activityId, eventId] = await Promise.all([
    markActivity(activity),
    writeDynamicPipelineEvent({
      surfaceType: event.surfaceType ?? activity.surfaceType,
      surfaceId: event.surfaceId ?? activity.surfaceId,
      eventType: event.eventType,
      sourceTable: event.sourceTable,
      sourceRowId: event.sourceRowId,
      safeSummary: event.safeSummary,
      rawAllowed: event.rawAllowed,
      dedupeKey: event.dedupeKey,
      semanticDedupeKey: event.semanticDedupeKey,
      metadata: event.metadata,
    }),
  ]);
  return { activityId, eventId };
}

export async function upsertResumeState(input: {
  surfaceType: SurfaceType;
  surfaceId: string;
  patch: Record<string, unknown>;
}): Promise<void> {
  try {
    const { data: u } = await supabase.auth.getUser();
    const userId = u?.user?.id;
    if (!userId) return;
    const { error } = await (supabase as any).from("surface_resume_state").upsert(
      {
        user_id: userId,
        surface_type: input.surfaceType,
        surface_id: input.surfaceId,
        ...input.patch,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,surface_type,surface_id" },
    );
    if (error) console.warn("[dynamicPipeline] resume upsert failed", error.message);
  } catch (e) {
    console.warn("[dynamicPipeline] resume upsert error", (e as Error)?.message);
  }
}
