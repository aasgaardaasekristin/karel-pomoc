// P28 C+D+I (CDI_2) — Active session processor with domain dispatch.
// Picks active activity sessions whose next_processing_at is due, then for
// each surface_type runs the matching domain processor. After dispatch the
// pipeline events are marked consumed (with consumed_by/processor metadata)
// and active sessions either reschedule or transition to idle_closed.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { corsHeaders } from "../_shared/auth.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

type DispatchOutcome = {
  ok: boolean;
  dispatch_kind: string;
  details?: Record<string, unknown>;
  error?: string;
};

async function dispatchHanaThread(sb: any, session: any, eventCount: number): Promise<DispatchOutcome> {
  // Trigger thread-scoped DID-safe ingestion. Service-role call to existing
  // event-ingest fn — passes thread filter so we do NOT scan all Hana threads.
  try {
    const url = `${SUPABASE_URL}/functions/v1/karel-did-event-ingest`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${SERVICE_KEY}` },
      body: JSON.stringify({
        mode: "since_cursor",
        userId: session.user_id,
        source_filter: ["hana_personal"],
        // hint for downstream — non-breaking extra field
        scope_thread_id: session.surface_id,
        triggered_by: "active_session_processor",
        event_count: eventCount,
      }),
    });
    const txt = await res.text();
    return { ok: res.ok, dispatch_kind: "hana_thread_ingest", details: { status: res.status, body: txt.slice(0, 240) } };
  } catch (e) {
    return { ok: false, dispatch_kind: "hana_thread_ingest", error: (e as Error)?.message };
  }
}

async function dispatchDidPartChat(sb: any, session: any, eventCount: number): Promise<DispatchOutcome> {
  try {
    const url = `${SUPABASE_URL}/functions/v1/karel-did-event-ingest`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${SERVICE_KEY}` },
      body: JSON.stringify({
        mode: "since_cursor",
        userId: session.user_id,
        source_filter: ["did_chat"],
        scope_thread_id: session.surface_id,
        triggered_by: "active_session_processor",
        event_count: eventCount,
      }),
    });
    const txt = await res.text();
    return { ok: res.ok, dispatch_kind: "did_part_chat_ingest", details: { status: res.status, body: txt.slice(0, 240) } };
  } catch (e) {
    return { ok: false, dispatch_kind: "did_part_chat_ingest", error: (e as Error)?.message };
  }
}

async function dispatchTaskAnswer(sb: any, session: any): Promise<DispatchOutcome> {
  // Mark related task as having unread therapist input + bump updated_at so
  // dashboard refetch picks it up. Lightweight, no AI call here — observations
  // were already created inside karel-task-feedback.
  try {
    const { error } = await sb.from("did_therapist_tasks")
      .update({ updated_at: new Date().toISOString(), has_new_therapist_input: true })
      .eq("id", session.surface_id);
    return { ok: !error, dispatch_kind: "task_answer_observation", details: { task_id: session.surface_id }, error: error?.message };
  } catch (e) {
    // Column may not exist — fall back to plain bump
    try {
      await sb.from("did_therapist_tasks").update({ updated_at: new Date().toISOString() }).eq("id", session.surface_id);
      return { ok: true, dispatch_kind: "task_answer_observation_fallback", details: { task_id: session.surface_id } };
    } catch (e2) {
      return { ok: false, dispatch_kind: "task_answer_observation", error: (e2 as Error)?.message };
    }
  }
}

async function dispatchDeliberationAnswer(sb: any, session: any): Promise<DispatchOutcome> {
  // Synthesis was already invalidated inside iterate. Here we just bump the
  // updated_at to trigger realtime + dashboard subscribers, and queue a
  // re-synthesis hint (non-blocking).
  try {
    await sb.from("did_team_deliberations")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", session.surface_id);
    return { ok: true, dispatch_kind: "deliberation_resync_hint", details: { deliberation_id: session.surface_id } };
  } catch (e) {
    return { ok: false, dispatch_kind: "deliberation_resync_hint", error: (e as Error)?.message };
  }
}

async function dispatchBlockUpdate(sb: any, session: any, eventCount: number): Promise<DispatchOutcome> {
  // Live session / playroom block updates: ensure a resume_state row exists
  // (the actual delta is written client-side via upsertResumeState; here we
  // ensure idempotent presence + timestamp bump).
  try {
    await sb.from("surface_resume_state").upsert({
      user_id: session.user_id,
      surface_type: session.surface_type,
      surface_id: session.surface_id,
      next_resume_point: "block_update_acknowledged",
      updated_at: new Date().toISOString(),
    }, { onConflict: "user_id,surface_type,surface_id" });
    return { ok: true, dispatch_kind: "block_update_resume_sync", details: { events: eventCount } };
  } catch (e) {
    return { ok: false, dispatch_kind: "block_update_resume_sync", error: (e as Error)?.message };
  }
}

async function dispatchSurface(sb: any, session: any, eventCount: number): Promise<DispatchOutcome> {
  switch (session.surface_type) {
    case "hana_personal_thread": return dispatchHanaThread(sb, session, eventCount);
    case "did_part_chat_thread": return dispatchDidPartChat(sb, session, eventCount);
    case "therapist_task_answer":
    case "task_completion":      return dispatchTaskAnswer(sb, session);
    case "team_deliberation_answer":
    case "playroom_deliberation_answer":
    case "session_approval_answer": return dispatchDeliberationAnswer(sb, session);
    case "live_session_block_update":
    case "playroom_block_update":   return dispatchBlockUpdate(sb, session, eventCount);
    default:
      return { ok: true, dispatch_kind: `noop:${session.surface_type}`, details: { events: eventCount } };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const sb = createClient(SUPABASE_URL, SERVICE_KEY);

  const cronSecret = req.headers.get("X-Karel-Cron-Secret") || "";
  const auth = req.headers.get("Authorization") || "";
  const isService = auth === `Bearer ${SERVICE_KEY}`;
  let isCron = false;
  if (cronSecret) {
    try {
      const { data } = await sb.rpc("verify_karel_cron_secret", { p_secret: cronSecret });
      isCron = data === true;
    } catch (_) { /* ignore */ }
  }
  if (!isService && !isCron) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Optional body { force_surface_id, force_user_id } — used by smoke tests
  // to deterministically trigger processing without waiting for next_processing_at.
  let body: any = {};
  try { body = await req.json(); } catch (_) { body = {}; }

  const nowIso = new Date().toISOString();

  let dueQuery = sb.from("active_app_activity_sessions").select("*");
  if (body?.force_surface_id) {
    dueQuery = dueQuery.eq("surface_id", body.force_surface_id);
  } else {
    dueQuery = dueQuery.eq("status", "active").lte("next_processing_at", nowIso);
  }
  const { data: due, error: dueErr } = await dueQuery
    .order("next_processing_at", { ascending: true, nullsFirst: false })
    .limit(25);

  if (dueErr) {
    return new Response(JSON.stringify({ ok: false, error: dueErr.message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const processed: any[] = [];

  for (const s of (due ?? [])) {
    const idleMs = Date.now() - new Date(s.last_activity_at).getTime();
    const idleAfterMs = (s.idle_after_minutes ?? 45) * 60_000;
    const intervalMs = (s.processing_interval_minutes ?? 15) * 60_000;
    const goingIdle = idleMs >= idleAfterMs;

    const { count: eventCount } = await sb
      .from("dynamic_pipeline_events")
      .select("id", { count: "exact", head: true })
      .eq("user_id", s.user_id)
      .eq("surface_type", s.surface_type)
      .eq("surface_id", s.surface_id)
      .eq("pipeline_state", "new_event");

    let dispatch: DispatchOutcome = { ok: true, dispatch_kind: "skipped_no_events" };
    if ((eventCount ?? 0) > 0 || body?.force_surface_id) {
      dispatch = await dispatchSurface(sb, s, eventCount ?? 0);
    }

    const patch: Record<string, unknown> = { last_processed_at: nowIso };
    if (goingIdle) {
      patch.status = "idle_closed";
      patch.next_processing_at = null;
      patch.current_phase = "final_flush";
    } else {
      patch.next_processing_at = new Date(Date.now() + intervalMs).toISOString();
    }

    await sb.from("active_app_activity_sessions").update(patch).eq("id", s.id);

    if ((eventCount ?? 0) > 0) {
      await sb
        .from("dynamic_pipeline_events")
        .update({
          pipeline_state: dispatch.ok ? "consumed" : "queued_for_consumption",
          consumed_at: nowIso,
          consumed_by: {
            processor: "active_session_processor",
            session_id: s.id,
            dispatch_kind: dispatch.dispatch_kind,
            dispatch_ok: dispatch.ok,
          },
        })
        .eq("user_id", s.user_id)
        .eq("surface_type", s.surface_type)
        .eq("surface_id", s.surface_id)
        .eq("pipeline_state", "new_event");
    }

    processed.push({
      session_id: s.id,
      surface_type: s.surface_type,
      surface_id: s.surface_id,
      events: eventCount ?? 0,
      status: patch.status ?? s.status,
      dispatch,
    });
  }

  return new Response(JSON.stringify({
    ok: true, processed_count: processed.length, processed, ranAt: nowIso,
  }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
});
