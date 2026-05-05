// P28_CDI_2 — Server-side source-of-truth helper for dynamic pipeline events
// and active activity sessions. Edge functions should call recordServerSubmission()
// after any persisted user submit so pipeline truth does not depend on the FE.

export type ServerSurfaceType =
  | "hana_personal_thread"
  | "did_part_chat_thread"
  | "therapist_task_answer"
  | "team_deliberation_answer"
  | "playroom_deliberation_answer"
  | "session_approval_answer"
  | "live_session_block_update"
  | "playroom_block_update"
  | "card_update_discussion"
  | "daily_plan_edit"
  | "pending_question_answer"
  | "task_completion";

export type ServerEventType =
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

const fnv1a = (s: string): string => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16);
};

export const buildServerDedupeKey = (parts: Array<string | number | null | undefined>): string =>
  fnv1a(parts.map((p) => String(p ?? "")).join("|"));

export interface RecordServerSubmissionInput {
  sb: any;
  userId: string;
  surfaceType: ServerSurfaceType;
  surfaceId: string;
  surface?: string;
  eventType: ServerEventType;
  sourceTable?: string;
  sourceRowId?: string;
  safeSummary?: string;
  rawAllowed?: boolean;
  dedupeKey?: string;
  semanticDedupeKey?: string;
  metadata?: Record<string, unknown>;
  /** Skip activity session upsert (e.g. for pure logging-only events) */
  skipActivitySession?: boolean;
  /** Optional resume_state patch */
  resumeStatePatch?: Record<string, unknown>;
}

export interface RecordServerSubmissionResult {
  activity_id: string | null;
  event_id: string | null;
  resume_id: string | null;
  dedupe_key: string;
}

export async function recordServerSubmission(
  input: RecordServerSubmissionInput,
): Promise<RecordServerSubmissionResult> {
  const {
    sb, userId, surfaceType, surfaceId, surface,
    eventType, sourceTable, sourceRowId, safeSummary, rawAllowed,
    semanticDedupeKey, metadata, skipActivitySession, resumeStatePatch,
  } = input;

  const dedupeKey = input.dedupeKey
    ?? buildServerDedupeKey([surfaceType, surfaceId, eventType, sourceRowId, Math.floor(Date.now() / 1000)]);

  let activity_id: string | null = null;
  let event_id: string | null = null;
  let resume_id: string | null = null;

  if (!skipActivitySession) {
    try {
      const nextProc = new Date(Date.now() + 3 * 60_000).toISOString();
      const { data, error } = await sb
        .from("active_app_activity_sessions")
        .upsert({
          user_id: userId,
          surface: surface ?? surfaceType,
          surface_id: surfaceId,
          surface_type: surfaceType,
          last_activity_at: new Date().toISOString(),
          next_processing_at: nextProc,
          status: "active",
          metadata: metadata ?? {},
        }, { onConflict: "user_id,surface_type,surface_id" })
        .select("id").maybeSingle();
      if (error) {
        console.warn("[dynPipelineServer] activity upsert failed", error.message);
      } else {
        activity_id = (data as { id: string } | null)?.id ?? null;
      }
    } catch (e) {
      console.warn("[dynPipelineServer] activity upsert error", (e as Error)?.message);
    }
  }

  try {
    const { data, error } = await sb
      .from("dynamic_pipeline_events")
      .insert({
        user_id: userId,
        surface_type: surfaceType,
        surface_id: surfaceId,
        event_type: eventType,
        source_table: sourceTable ?? null,
        source_row_id: sourceRowId ?? null,
        safe_summary: safeSummary ?? null,
        raw_allowed: rawAllowed ?? false,
        pipeline_state: "new_event",
        dedupe_key: dedupeKey,
        semantic_dedupe_key: semanticDedupeKey ?? null,
        metadata: metadata ?? {},
        source: "server",
      })
      .select("id").maybeSingle();
    if (error) {
      if ((error as any).code !== "23505") {
        console.warn("[dynPipelineServer] event insert failed", error.message);
      }
    } else {
      event_id = (data as { id: string } | null)?.id ?? null;
    }
  } catch (e) {
    console.warn("[dynPipelineServer] event insert error", (e as Error)?.message);
  }

  if (resumeStatePatch) {
    try {
      const { data, error } = await sb
        .from("surface_resume_state")
        .upsert({
          user_id: userId,
          surface_type: surfaceType,
          surface_id: surfaceId,
          ...resumeStatePatch,
          updated_at: new Date().toISOString(),
        }, { onConflict: "user_id,surface_type,surface_id" })
        .select("id").maybeSingle();
      if (error) {
        console.warn("[dynPipelineServer] resume upsert failed", error.message);
      } else {
        resume_id = (data as { id: string } | null)?.id ?? null;
      }
    } catch (e) {
      console.warn("[dynPipelineServer] resume upsert error", (e as Error)?.message);
    }
  }

  return { activity_id, event_id, resume_id, dedupe_key: dedupeKey };
}
