// P28 C+D+I — Active session processor.
// Replaces global "scan all threads" polling with a focused processor that only
// touches surfaces whose active_app_activity_sessions row says next_processing_at <= now().
// Marks sessions idle_closed after the configured idle window.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { corsHeaders } from "../_shared/auth.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const sb = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const cronSecret = req.headers.get("X-Karel-Cron-Secret") || "";
  const auth = req.headers.get("Authorization") || "";
  const isService = auth === `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`;
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

  const nowIso = new Date().toISOString();

  // 1) Pick active sessions due for processing.
  const { data: due, error: dueErr } = await sb
    .from("active_app_activity_sessions")
    .select("*")
    .eq("status", "active")
    .lte("next_processing_at", nowIso)
    .order("next_processing_at", { ascending: true })
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

    // Count new pipeline events since last processed.
    const { count: eventCount } = await sb
      .from("dynamic_pipeline_events")
      .select("id", { count: "exact", head: true })
      .eq("user_id", s.user_id)
      .eq("surface_type", s.surface_type)
      .eq("surface_id", s.surface_id)
      .gt("created_at", s.last_processed_at ?? s.started_at);

    const patch: Record<string, unknown> = {
      last_processed_at: nowIso,
    };
    if (goingIdle) {
      patch.status = "idle_closed";
      patch.next_processing_at = null;
      patch.current_phase = "final_flush";
    } else {
      patch.next_processing_at = new Date(Date.now() + intervalMs).toISOString();
    }

    await sb.from("active_app_activity_sessions").update(patch).eq("id", s.id);

    // Mark consumed pipeline events for this surface.
    if ((eventCount ?? 0) > 0) {
      await sb
        .from("dynamic_pipeline_events")
        .update({
          pipeline_state: goingIdle ? "consumed" : "queued_for_consumption",
          consumed_at: nowIso,
          consumed_by: { processor: "active_session_processor", session_id: s.id },
        })
        .eq("user_id", s.user_id)
        .eq("surface_type", s.surface_type)
        .eq("surface_id", s.surface_id)
        .eq("pipeline_state", "new_event");
    }

    processed.push({
      session_id: s.id, surface_type: s.surface_type, surface_id: s.surface_id,
      events: eventCount ?? 0, status: patch.status ?? s.status,
    });
  }

  return new Response(JSON.stringify({
    ok: true, processed_count: processed.length, processed, ranAt: nowIso,
  }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
});
