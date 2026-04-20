/**
 * karel-wm-inspect — Working Memory Slice 1 read endpoint
 *
 * Vrací aktuální (nebo žádaný) snapshot z karel_working_memory_snapshots.
 * Pouze read; nemodifikuje žádný kanonický zdroj.
 *
 * Vstupy (query params nebo JSON body):
 *   - snapshot_key?: string (YYYY-MM-DD; default = latest by generated_at)
 *
 * Auth: Bearer <user JWT>. Server čte přes user-scoped client → RLS automaticky
 * filtruje na vlastní rows.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const url = Deno.env.get("SUPABASE_URL")!;
  const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
  const userClient = createClient(url, anon, {
    global: { headers: { Authorization: auth } },
  });

  const { data: userData, error: authErr } = await userClient.auth.getUser();
  if (authErr || !userData?.user) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  let snapshotKey: string | undefined;
  try {
    if (req.method === "GET") {
      const u = new URL(req.url);
      snapshotKey = u.searchParams.get("snapshot_key") ?? undefined;
    } else {
      const body = await req.json().catch(() => ({}));
      snapshotKey = body?.snapshot_key;
    }
  } catch {}

  let q = userClient
    .from("karel_working_memory_snapshots")
    .select(
      "id, snapshot_key, snapshot_json, events_json, sync_state_json, source_meta_json, generated_at, created_at, updated_at",
    )
    .eq("user_id", userData.user.id);

  if (snapshotKey) {
    q = q.eq("snapshot_key", snapshotKey).limit(1);
  } else {
    q = q.order("generated_at", { ascending: false }).limit(1);
  }

  const { data, error } = await q.maybeSingle();
  if (error) {
    return new Response(
      JSON.stringify({ error: "read_failed", detail: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  if (!data) {
    return new Response(
      JSON.stringify({
        ok: true,
        snapshot: null,
        hint: "No snapshot yet. Call karel-wm-bootstrap to hydrate.",
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  return new Response(
    JSON.stringify({
      ok: true,
      snapshot: data,
      summary: {
        snapshot_key: data.snapshot_key,
        generated_at: data.generated_at,
        events_count: Array.isArray(data.events_json) ? data.events_json.length : 0,
        observations_24h: data.snapshot_json?.evidence?.observations_24h ?? 0,
        implications_24h: data.snapshot_json?.evidence?.implications_24h ?? 0,
        profile_claims_24h: data.snapshot_json?.evidence?.profile_claims_24h ?? 0,
        crises_open: Array.isArray(data.snapshot_json?.crises_open)
          ? data.snapshot_json.crises_open.length
          : 0,
        drive_queue: data.sync_state_json?.drive_queue ?? null,
        degraded_sources: data.source_meta_json?.degraded_sources ?? [],
        stale_sources: data.source_meta_json?.stale_sources ?? [],
        role_scope_breakdown_24h: data.snapshot_json?.role_scope_breakdown_24h ?? null,
        therapist_state: data.snapshot_json?.therapist_state ?? null,
      },
    }),
    { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});
