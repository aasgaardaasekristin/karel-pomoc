import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const sb = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const perplexityKey = Deno.env.get("PERPLEXITY_API_KEY");
  if (!perplexityKey) {
    console.error("[CRISIS-RESEARCH] PERPLEXITY_API_KEY not configured");
    return new Response(JSON.stringify({ error: "PERPLEXITY_API_KEY not configured" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const { data: activeCrises } = await sb
      .from("crisis_alerts")
      .select("id, part_name, summary, days_in_crisis")
      .neq("status", "resolved");

    let researchCount = 0;

    for (const crisis of activeCrises || []) {
      const { data: lastResearch } = await sb
        .from("karel_crisis_research")
        .select("created_at")
        .eq("crisis_alert_id", crisis.id)
        .order("created_at", { ascending: false })
        .limit(1);

      const daysSinceResearch = lastResearch?.[0]
        ? Math.floor((Date.now() - new Date(lastResearch[0].created_at).getTime()) / 86400000)
        : 999;

      const daysActive = crisis.days_in_crisis || 0;

      // ÚSPORNÁ PODMÍNKA
      const needsResearch = daysActive <= 2 || daysSinceResearch >= 7;
      if (!needsResearch) continue;

      // Načti kontext z crisis_journal
      const { data: journal } = await sb
        .from("crisis_journal")
        .select("what_worked, what_failed, crisis_trend, karel_notes")
        .eq("crisis_alert_id", crisis.id)
        .order("date", { ascending: false })
        .limit(5);

      const whatWorked = (journal || []).map((j) => j.what_worked).filter(Boolean).join("; ");
      const whatFailed = (journal || []).map((j) => j.what_failed).filter(Boolean).join("; ");

      const query = `DID dissociative identity disorder crisis intervention: part "${crisis.part_name}", situation: "${(crisis.summary || "").slice(0, 200)}". What worked: ${whatWorked.slice(0, 150)}. What failed: ${whatFailed.slice(0, 150)}. Find 3 specific evidence-based therapy techniques or creative interventions, recent research 2020-2025, trauma-informed, child-appropriate methods. Be concise — max 3 techniques with brief explanation each.`;

      const perplexityRes = await fetch("https://api.perplexity.ai/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${perplexityKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "sonar",
          messages: [{ role: "user", content: query }],
          max_tokens: 800,
        }),
      });

      const perplexityData = await perplexityRes.json();
      const researchText = perplexityData.choices?.[0]?.message?.content || "";
      const citations = perplexityData.citations || [];

      await sb.from("karel_crisis_research").insert({
        crisis_alert_id: crisis.id,
        part_name: crisis.part_name,
        query_used: query.slice(0, 500),
        research_findings: researchText,
        citations,
        days_active_at_research: daysActive,
        model_used: "sonar",
      });

      await sb.from("did_pending_questions").insert({
        question: `Karel našel nové terapeutické metody pro krizi ${crisis.part_name} (den ${daysActive}):\n\n${researchText.slice(0, 600)}\n\nChcete tyto metody zapracovat do příštího sezení?`,
        directed_to: "both",
        subject_type: "crisis_research",
        subject_id: crisis.id,
        status: "pending",
        expires_at: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString(),
      });

      researchCount++;
      console.log(`[CRISIS-RESEARCH] Done for ${crisis.part_name}: ${researchText.length} chars`);
    }

    return new Response(JSON.stringify({ success: true, researchCount }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("[CRISIS-RESEARCH] Error:", error);
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
