// P28_CDI_2c — server-side endpoint for card_update_discussion surface.
// Records: card_update_queue.payload.discussion comment + dynamic_pipeline_event
// + active_app_activity_session + surface_resume_state. Canonical scope guarded.
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { recordServerSubmission } from "../_shared/dynamicPipelineServer.ts";
import {
  assertCanonicalDidScopeOrThrow,
  CanonicalUserScopeError,
} from "../_shared/canonicalUserScopeGuard.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

type Mode = "discussion_comment" | "decision_note" | "request_change";
const MODES: Mode[] = ["discussion_comment", "decision_note", "request_change"];
const AUTHORS = new Set(["hanka", "kata", "karel"]);

function safeSummary(input: string, mode: Mode): string {
  const trimmed = String(input || "").trim().replace(/\s+/g, " ");
  const tag =
    mode === "decision_note"
      ? "decision note"
      : mode === "request_change"
      ? "request change"
      : "discussion";
  return `[card update ${tag}] therapist comment added (${trimmed.length} chars)`;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  const authHeader = req.headers.get("Authorization") ?? "";
  const cronSecret = req.headers.get("X-Karel-Cron-Secret") ?? "";

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "invalid_json" }, 400); }

  const cardUpdateId = String(body?.card_update_id ?? "").trim();
  const message = String(body?.message ?? "").trim();
  const author = String(body?.author ?? "").trim().toLowerCase();
  const mode = String(body?.mode ?? "discussion_comment") as Mode;
  const idempotencyKey = body?.idempotency_key
    ? String(body.idempotency_key).trim().slice(0, 128)
    : null;

  if (!cardUpdateId) return json({ error: "missing_card_update_id" }, 400);
  if (!message) return json({ error: "missing_message" }, 400);
  if (message.length > 2000) return json({ error: "message_too_long", limit: 2000 }, 400);
  if (!AUTHORS.has(author)) return json({ error: "invalid_author" }, 400);
  if (!MODES.includes(mode)) return json({ error: "invalid_mode" }, 400);

  // Resolve canonical user (cron path = service-side smoke, JWT path = therapist UI).
  let canonicalUserId: string;
  try {
    if (cronSecret) {
      const ok = await admin.rpc("verify_karel_cron_secret", { p_secret: cronSecret });
      if (!ok.data) return json({ error: "invalid_cron_secret" }, 401);
      const { data } = await admin.rpc("get_canonical_did_user_id");
      if (!data || typeof data !== "string") return json({ error: "canonical_user_unresolved" }, 500);
      canonicalUserId = data;
    } else {
      const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        global: { headers: { Authorization: authHeader } },
      });
      const { data: u } = await userClient.auth.getUser();
      const callingUserId = u?.user?.id ?? null;
      canonicalUserId = await assertCanonicalDidScopeOrThrow(admin, callingUserId);
    }
  } catch (e) {
    if (e instanceof CanonicalUserScopeError) {
      return json({ error: e.code, message: e.message }, 403);
    }
    return json({ error: "auth_failed", message: (e as Error)?.message }, 401);
  }

  // Locate card_update_queue row (must belong to canonical user).
  const { data: row, error: rowErr } = await admin
    .from("card_update_queue")
    .select("id, user_id, payload, status, part_id, section")
    .eq("id", cardUpdateId)
    .maybeSingle();
  if (rowErr) return json({ error: "lookup_failed", message: rowErr.message }, 500);
  if (!row) return json({ error: "card_update_not_found" }, 404);
  if (row.user_id !== canonicalUserId) return json({ error: "card_update_scope_mismatch" }, 403);

  // Append discussion entry into payload.discussion[]
  const summary = safeSummary(message, mode);
  const nowIso = new Date().toISOString();
  const prevPayload = (row.payload && typeof row.payload === "object") ? row.payload : {};
  const summary = safeSummary(message, mode);
  const nowIso = new Date().toISOString();
  const prevPayload = (row.payload && typeof row.payload === "object") ? row.payload : {};
  const existingDiscussion: any[] = Array.isArray((prevPayload as any).discussion)
    ? [...(prevPayload as any).discussion]
    : [];

  // Idempotency: short-circuit if same key already recorded.
  if (idempotencyKey) {
    const dup = existingDiscussion.find((d) => d?.idempotency_key === idempotencyKey);
    if (dup) {
      // Look up the existing pipeline event for this dedupe key.
      const { data: ev } = await admin
        .from("dynamic_pipeline_events")
        .select("id")
        .eq("surface_type", "card_update_discussion")
        .eq("surface_id", cardUpdateId)
        .eq("dedupe_key", idempotencyKey)
        .maybeSingle();
      return json({
        ok: true,
        deduplicated: true,
        card_update_id: cardUpdateId,
        discussion_count: existingDiscussion.length,
        pipeline_event_id: ev?.id ?? null,
        resume_id: null,
        activity_id: null,
      });
    }
  }

  const newEntry = {
    at: nowIso,
    author,
    mode,
    safe_summary: summary,
    message_length: message.length,
    ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
  };
  const discussion = [...existingDiscussion, newEntry];
  const newPayload = { ...prevPayload, discussion, last_discussion_at: nowIso };

  const { error: updErr } = await admin
    .from("card_update_queue")
    .update({ payload: newPayload })
    .eq("id", cardUpdateId);
  if (updErr) return json({ error: "card_update_persist_failed", message: updErr.message }, 500);

  // Server-side dynamic pipeline event + activity + resume state
  let recorded: any = null;
  try {
    recorded = await recordServerSubmission({
      sb: admin,
      userId: canonicalUserId,
      surfaceType: "card_update_discussion",
      surfaceId: cardUpdateId,
      surface: "did_kartoteka",
      eventType: "card_update_discussed",
      sourceTable: "card_update_queue",
      sourceRowId: cardUpdateId,
      safeSummary: summary,
      rawAllowed: false,
      dedupeKey: idempotencyKey ?? undefined,
      metadata: {
        mode,
        author,
        part_id: row.part_id,
        section: row.section,
        discussion_count: discussion.length,
        idempotency_key: idempotencyKey,
      },
      resumeStatePatch: {
        card_update_id: cardUpdateId,
        decision_status: mode === "decision_note" ? "decision_recorded" : "discussion_updated",
        last_therapist_answer: summary,
        next_resume_point: "review_card_update_proposal",
        what_changed_since_plan: [
          {
            at: nowIso,
            change: "therapist discussed proposed card update",
            mode,
            author,
          },
        ],
      },
    });
  } catch (e) {
    console.warn("[card-update-discussion-event] recordServerSubmission failed", (e as Error)?.message);
  }

  return json({
    ok: true,
    deduplicated: false,
    card_update_id: cardUpdateId,
    discussion_count: discussion.length,
    pipeline_event_id: recorded?.event_id ?? null,
    resume_id: recorded?.resume_id ?? null,
    activity_id: recorded?.activity_id ?? null,
  });
});
