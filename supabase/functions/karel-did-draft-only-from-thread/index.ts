// P27 I1: draft-only generator from a Hana/personal thread.
// - never starts live session
// - never bypasses signoff
// - only writes draft daily_session_plan rows via existing auto-session-plan generator
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-karel-cron-secret",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

async function callEdge(fn: string, body: any) {
  const r = await fetch(`${SUPABASE_URL}/functions/v1/${fn}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${SERVICE_KEY}`,
      "X-Karel-Cron-Secret": Deno.env.get("KAREL_CRON_SECRET") ?? "",
    },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* keep text */ }
  return { ok: r.ok, status: r.status, body: json ?? text };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  try {
    const sb = createClient(SUPABASE_URL, SERVICE_KEY);
    const { thread_id, user_id, part_name, mode } = await req.json();
    if (!thread_id) {
      return new Response(JSON.stringify({ error: "thread_id required" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    const reqMode: "session" | "playroom" | "both" = mode === "playroom" ? "playroom" : mode === "session" ? "session" : "both";

    // Resolve user from thread if not provided
    let userId = user_id ?? null;
    let resolvedPart = part_name ?? null;
    if (!userId) {
      const { data: thr } = await sb.from("karel_hana_conversations").select("user_id").eq("id", thread_id).maybeSingle();
      userId = thr?.user_id ?? null;
    }
    if (!userId) {
      return new Response(JSON.stringify({ error: "cannot_resolve_user" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // Pull recent card proposals + hana memory to form therapistContext (safe summary only)
    const [{ data: proposals }, { data: mems }] = await Promise.all([
      sb.from("card_update_queue").select("part_id, new_content").eq("source_thread_id", thread_id).eq("applied", false).limit(10),
      sb.from("hana_personal_memory").select("memory_type, safe_summary, did_relevant").eq("source_thread_id", thread_id).is("superseded_at", null).limit(10),
    ]);

    if (!resolvedPart && proposals && proposals.length > 0) resolvedPart = proposals[0].part_id;

    const contextLines: string[] = [];
    contextLines.push(`Zdroj: P27 draft-only z osobního vlákna Hany (thread=${thread_id}).`);
    contextLines.push("Bezpečné shrnutí (raw text není dostupný; není povolený):");
    for (const p of proposals || []) contextLines.push(`- Část ${p.part_id}: ${p.new_content}`);
    for (const m of mems || []) {
      if (m.memory_type === "hana_to_did_safe_summary") contextLines.push(`- DID-SAFE: ${m.safe_summary}`);
    }
    contextLines.push("Plán je DRAFT-ONLY. Nestartuj live, nečiň klinické závěry, vyžaduje terapeutčin podpis.");
    contextLines.push("Sezení: Hanka fyzicky stabilizační/somatický check; Káťa vzdálený bezpečný blok (telefon/chat/audio); Karel asistuje.");
    contextLines.push("Téma jen jemné ověření (Tundrupek/Timmy, Gustík/K.G. nesmí být past).");

    const therapistContext = contextLines.join("\n").slice(0, 4000);

    const results: Record<string, any> = { thread_id, user_id: userId, part_name: resolvedPart, mode: reqMode };

    if (reqMode === "session" || reqMode === "both") {
      results.session = await callEdge("karel-did-auto-session-plan", {
        userId,
        forcePart: resolvedPart,
        therapistContext,
        mode: "draft_only",
        source: "p27_hana_thread_draft",
        sessionFormat: "individual",
      });
    }
    if (reqMode === "playroom" || reqMode === "both") {
      results.playroom = await callEdge("karel-did-auto-session-plan", {
        userId,
        forcePart: resolvedPart,
        therapistContext: therapistContext + "\nFORMÁT: Herna (Karel-led, low-threshold), pouze DRAFT, nespouštět.",
        mode: "draft_only",
        source: "p27_hana_thread_draft_playroom",
        sessionFormat: "playroom",
      });
    }

    // Audit which draft plans now exist for the thread (last 2h)
    const { data: drafts } = await sb.from("did_daily_session_plans")
      .select("id, selected_part, status, lifecycle_status, program_status, started_at, created_at")
      .eq("user_id", userId)
      .gte("created_at", new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString())
      .order("created_at", { ascending: false })
      .limit(10);

    return new Response(JSON.stringify({ ok: true, ...results, recent_drafts: drafts ?? [] }, null, 2), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String((e as Error)?.message ?? e) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
