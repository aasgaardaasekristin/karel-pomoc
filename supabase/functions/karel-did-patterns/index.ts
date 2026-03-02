import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { requireAuth, corsHeaders } from "../_shared/auth.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const authResult = await requireAuth(req);
  if (authResult instanceof Response) return authResult;

  try {
    const authHeader = req.headers.get("Authorization")!;
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );

    // 1. Fetch all threads from past 30 days
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    
    const { data: threads } = await supabase
      .from("did_threads")
      .select("part_name, messages, started_at, last_activity_at, sub_mode")
      .gte("last_activity_at", thirtyDaysAgo)
      .order("last_activity_at", { ascending: false });

    // 2. Fetch weekly cycle reports
    const { data: cycles } = await supabase
      .from("did_update_cycles")
      .select("report_summary, completed_at, cycle_type")
      .eq("status", "completed")
      .gte("completed_at", thirtyDaysAgo)
      .order("completed_at", { ascending: false })
      .limit(10);

    if (!threads || threads.length === 0) {
      return new Response(JSON.stringify({ 
        patterns: [],
        alerts: [],
        summary: "Zatím nedostatek dat pro analýzu vzorců. Data se naplní po více rozhovorech."
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 3. Build activity summary for AI
    const partSummaries: Record<string, { count: number; lastSeen: string; themes: string[] }> = {};
    
    for (const t of threads) {
      if (!partSummaries[t.part_name]) {
        partSummaries[t.part_name] = { count: 0, lastSeen: t.last_activity_at, themes: [] };
      }
      partSummaries[t.part_name].count++;
      
      // Extract key themes from messages (last few messages)
      const msgs = Array.isArray(t.messages) ? t.messages : [];
      const recentMsgs = msgs.slice(-6);
      for (const m of recentMsgs) {
        if (typeof m === "object" && m !== null && "content" in m && typeof m.content === "string") {
          // Trim to first 200 chars
          partSummaries[t.part_name].themes.push(m.content.slice(0, 200));
        }
      }
    }

    const activitySummary = Object.entries(partSummaries).map(([name, data]) => 
      `Část "${name}": ${data.count} rozhovorů, poslední aktivita ${data.lastSeen}, úryvky: ${data.themes.slice(0, 4).join(" | ")}`
    ).join("\n\n");

    const cycleReports = (cycles || []).map(c => 
      `[${c.cycle_type} – ${c.completed_at}]: ${(c.report_summary || "").slice(0, 500)}`
    ).join("\n\n");

    // 4. AI analysis
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY not configured");

    const prompt = `Jsi Karel, AI supervizní asistent pro DID systém. Analyzuj data z posledních 30 dní a identifikuj:

1. OPAKUJÍCÍ SE VZORCE (patterns): Témata, emoce, chování, které se opakují u jednotlivých částí nebo napříč systémem
2. UPOZORNĚNÍ (alerts): Potenciální rizika, známky dysregulace, části vyžadující pozornost
3. POZITIVNÍ TRENDY: Co funguje dobře, stabilizační pokroky

DATA O AKTIVITĚ ČÁSTÍ:
${activitySummary}

REPORTY Z CYKLŮ:
${cycleReports || "(žádné reporty)"}

Odpověz STRIKTNĚ v tomto JSON formátu:
{
  "patterns": [
    {"type": "recurring_theme" | "emotional_pattern" | "behavioral_pattern" | "communication_pattern", "description": "popis vzorce", "parts_involved": ["jméno1"], "severity": "info" | "watch" | "concern"}
  ],
  "alerts": [
    {"message": "popis upozornění", "severity": "info" | "warning" | "critical", "parts": ["jméno1"]}
  ],
  "positive_trends": ["popis pozitivního trendu"],
  "summary": "celkové shrnutí za 2-3 věty"
}`;

    const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          { role: "system", content: "Jsi klinický analytik pro DID systém. Odpovídej VŽDY validním JSON." },
          { role: "user", content: prompt },
        ],
        response_format: { type: "json_object" },
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      console.error("AI gateway error:", response.status, text);
      throw new Error("AI analysis failed");
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || "{}";
    
    let result;
    try {
      result = JSON.parse(content);
    } catch {
      result = { patterns: [], alerts: [], positive_trends: [], summary: content };
    }

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Pattern detection error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
