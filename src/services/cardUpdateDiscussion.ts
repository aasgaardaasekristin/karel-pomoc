// P28_CDI_2c — FE helper that submits card update discussion comments
// through the server-side edge function (single source of truth).
import { supabase } from "@/integrations/supabase/client";
import { getAuthHeaders } from "@/lib/auth";

export type CardUpdateDiscussionMode =
  | "discussion_comment"
  | "decision_note"
  | "request_change";

export interface SubmitCardUpdateDiscussionInput {
  cardUpdateId: string;
  message: string;
  author: "hanka" | "kata" | "karel";
  mode?: CardUpdateDiscussionMode;
  idempotencyKey?: string;
}

export interface SubmitCardUpdateDiscussionResult {
  ok: boolean;
  deduplicated?: boolean;
  card_update_id?: string;
  discussion_count?: number;
  pipeline_event_id?: string | null;
  resume_id?: string | null;
  activity_id?: string | null;
  error?: string;
}

/**
 * POSTs to karel-card-update-discussion-event. The edge function persists the
 * comment into card_update_queue.payload.discussion[], emits a server-side
 * dynamic_pipeline_event, upserts active_app_activity_sessions, and writes
 * surface_resume_state. Never write a card_update_discussion event from the
 * client directly — always go through this helper.
 */
export async function submitCardUpdateDiscussion(
  input: SubmitCardUpdateDiscussionInput,
): Promise<SubmitCardUpdateDiscussionResult> {
  const headers = await getAuthHeaders();
  const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/karel-card-update-discussion-event`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        card_update_id: input.cardUpdateId,
        message: input.message,
        author: input.author,
        mode: input.mode ?? "discussion_comment",
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, error: data?.error ?? `http_${res.status}` };
    }
    return { ok: true, ...data };
  } catch (e) {
    return { ok: false, error: (e as Error)?.message ?? "network_error" };
  }
}

/** Convenience: invalidate card_update_queue queries by re-selecting the row. */
export async function refetchCardUpdateRow(cardUpdateId: string) {
  return await supabase
    .from("card_update_queue")
    .select("id, status, payload, applied")
    .eq("id", cardUpdateId)
    .maybeSingle();
}
