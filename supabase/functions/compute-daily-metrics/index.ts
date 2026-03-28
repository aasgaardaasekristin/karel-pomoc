import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { callAiForJson } from "../_shared/aiCallWrapper.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const srvKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, srvKey);

  try {
    const body = await req.json().catch(() => ({}));
    const targetDate = body.date || new Date(Date.now() - 86400000).toISOString().slice(0, 10);

    console.log(`[compute-metrics] Computing metrics for ${targetDate}`);

    // 1. Load active parts
    const { data: parts } = await sb
      .from("did_part_registry")
      .select("part_name")
      .eq("status", "active");

    const partNames = (parts || []).map((p: any) => p.part_name);
    if (partNames.length === 0) {
      return new Response(JSON.stringify({ skipped: true, reason: "no_active_parts" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const results: any[] = [];
    const dayStart = `${targetDate}T00:00:00Z`;
    const dayEnd = `${targetDate}T23:59:59Z`;

    for (const partName of partNames) {
      try {
        // 2. Count messages from threads
        const { data: threads } = await sb
          .from("did_threads")
          .select("id, messages, part_name, updated_at")
          .eq("part_name", partName)
          .gte("updated_at", dayStart)
          .lte("updated_at", dayEnd);

        const dayThreads = threads || [];

        let totalMessages = 0;
        let userMessages = 0;
        let assistantMessages = 0;
        let totalLength = 0;
        const allUserTexts: string[] = [];

        for (const thread of dayThreads) {
          const msgs = Array.isArray(thread.messages) ? thread.messages : [];
          for (const msg of msgs as any[]) {
            totalMessages++;
            const content = typeof msg.content === "string" ? msg.content : "";
            totalLength += content.length;
            if (msg.role === "user") {
              userMessages++;
              allUserTexts.push(content);
            } else if (msg.role === "assistant") {
              assistantMessages++;
            }
          }
        }

        // 3. Switching events
        const { count: switchCount } = await sb
          .from("switching_events")
          .select("id", { count: "exact", head: true })
          .eq("original_part", partName)
          .gte("created_at", dayStart)
          .lte("created_at", dayEnd);

        // 4. Session memory metrics
        const { data: memories } = await sb
          .from("session_memory")
          .select("risk_signals, positive_signals, unresolved, promises, topics")
          .eq("part_name", partName)
          .gte("session_date", dayStart)
          .lte("session_date", dayEnd);

        let riskCount = 0;
        let positiveCount = 0;
        let unresolvedCount = 0;
        let promisesMade = 0;
        let newTopics = 0;

        for (const mem of (memories || []) as any[]) {
          riskCount += (mem.risk_signals || []).length;
          positiveCount += (mem.positive_signals || []).length;
          unresolvedCount += (mem.unresolved || []).length;
          promisesMade += (mem.promises || []).length;
          newTopics += (mem.topics || []).length;
        }

        // 5. Therapist notes count
        const { count: notesCount } = await sb
          .from("therapist_notes")
          .select("id", { count: "exact", head: true })
          .or(`part_name.eq.${partName},part_name.is.null`)
          .gte("created_at", dayStart)
          .lte("created_at", dayEnd);

        // 6. AI emotional metrics (only if 3+ messages)
        let emotionalValence: number | null = null;
        let emotionalArousal: number | null = null;
        let cooperationLevel: number | null = null;
        let opennessLevel: number | null = null;

        if (allUserTexts.length >= 3) {
          const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
          if (LOVABLE_API_KEY) {
            const sampleTexts = allUserTexts.slice(0, 20).join("\n---\n");

            const emotionResult = await callAiForJson({
              systemPrompt: "Jsi analytický modul. Hodnotíš emoční metriky z textu na škále 0-10. Odpovídej POUZE JSON.",
              userPrompt: `Ohodnoť emoční metriky z těchto zpráv části "${partName}" na škále 0.0 až 10.0:\n\n${sampleTexts}\n\nVrať JSON:\n{"valence":5.0,"arousal":5.0,"cooperation":5.0,"openness":5.0}\n\nvalence: 0=velmi negativní, 5=neutrální, 10=velmi pozitivní\narousal: 0=apatický, 5=klidný, 10=agitovaný\ncooperation: 0=odmítá, 5=neutrální, 10=aktivně spolupracuje\nopenness: 0=uzavřený, 5=stručný, 10=otevřeně sdílí`,
              apiKey: LOVABLE_API_KEY,
              model: "google/gemini-2.5-flash-lite",
              requiredKeys: ["valence", "arousal", "cooperation", "openness"],
              maxRetries: 0,
              fallback: null,
              callerName: "compute-daily-metrics",
            });

            if (emotionResult.success && emotionResult.data) {
              const d = emotionResult.data;
              const clamp = (v: any) => {
                const n = parseFloat(v);
                return isNaN(n) ? null : Math.min(10, Math.max(0, Math.round(n * 10) / 10));
              };
              emotionalValence = clamp(d.valence);
              emotionalArousal = clamp(d.arousal);
              cooperationLevel = clamp(d.cooperation);
              opennessLevel = clamp(d.openness);
            }
          }
        }

        // 7. Upsert metrics
        const metricRow = {
          metric_date: targetDate,
          part_name: partName,
          message_count: totalMessages,
          user_message_count: userMessages,
          assistant_message_count: assistantMessages,
          avg_message_length: totalMessages > 0 ? Math.round(totalLength / totalMessages) : 0,
          session_count: dayThreads.length,
          emotional_valence: emotionalValence,
          emotional_arousal: emotionalArousal,
          cooperation_level: cooperationLevel,
          openness_level: opennessLevel,
          switching_count: switchCount || 0,
          risk_signals_count: riskCount,
          positive_signals_count: positiveCount,
          promises_made: promisesMade,
          promises_fulfilled: 0,
          unresolved_topics: unresolvedCount,
          new_topics_introduced: newTopics,
          therapist_notes_count: notesCount || 0,
          computed_at: new Date().toISOString(),
          source: "daily_cycle",
        };

        const { error: upsertErr } = await sb
          .from("daily_metrics")
          .upsert(metricRow, { onConflict: "metric_date,part_name" });

        if (upsertErr) {
          console.warn(`[compute-metrics] Upsert error for ${partName}:`, upsertErr);
        } else {
          results.push({ part: partName, messages: totalMessages, sessions: dayThreads.length });
          console.log(`[compute-metrics] ${partName}: ${totalMessages} msgs, ${dayThreads.length} sessions`);
        }
      } catch (partErr) {
        console.warn(`[compute-metrics] Error for ${partName}:`, partErr);
      }
    }

    // 8. System totals (part_name = NULL)
    try {
      const { count: totalThreads } = await sb
        .from("did_threads")
        .select("id", { count: "exact", head: true })
        .gte("updated_at", dayStart)
        .lte("updated_at", dayEnd);

      const { count: totalSwitches } = await sb
        .from("switching_events")
        .select("id", { count: "exact", head: true })
        .gte("created_at", dayStart)
        .lte("created_at", dayEnd);

      const { count: totalNotes } = await sb
        .from("therapist_notes")
        .select("id", { count: "exact", head: true })
        .gte("created_at", dayStart)
        .lte("created_at", dayEnd);

      const totalMsgs = results.reduce((sum, r) => sum + r.messages, 0);

      await sb.from("daily_metrics").upsert({
        metric_date: targetDate,
        part_name: null,
        message_count: totalMsgs,
        session_count: totalThreads || 0,
        switching_count: totalSwitches || 0,
        therapist_notes_count: totalNotes || 0,
        computed_at: new Date().toISOString(),
        source: "daily_cycle",
      }, { onConflict: "metric_date,part_name" });
    } catch (e) {
      console.warn("[compute-metrics] System totals error:", e);
    }

    console.log(`[compute-metrics] Done: ${results.length} parts computed for ${targetDate}`);

    return new Response(JSON.stringify({ success: true, date: targetDate, parts: results }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("[compute-metrics] Error:", error);
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "Unknown" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
