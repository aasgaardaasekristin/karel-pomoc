import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/auth.ts";
import {
  getAccessToken, resolveKartotekaRoot, findFolder, listFiles,
  readFileContent, overwriteDoc, createBackup,
  FOLDER_MIME, GDOC_MIME,
} from "../_shared/driveHelpers.ts";

const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY") ?? "";
const GEMINI_MODEL = "google/gemini-2.5-flash";

async function callGemini(prompt: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 170_000);
  try {
    const res = await fetch("https://api.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: GEMINI_MODEL, messages: [{ role: "user", content: prompt }], temperature: 0.3, max_tokens: 16000 }),
      signal: controller.signal,
    });
    const data = await res.json();
    return data.choices?.[0]?.message?.content || "";
  } finally { clearTimeout(timer); }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const startTime = Date.now();
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  try {
    const token = await getAccessToken();
    const root = await resolveKartotekaRoot(token);
    if (!root) throw new Error("KARTOTEKA_DID not found");

    const centrumId = await findFolder(token, "00_CENTRUM", root);
    if (!centrumId) throw new Error("00_CENTRUM not found");
    const planFolderId = await findFolder(token, "05_PLAN", centrumId);
    if (!planFolderId) throw new Error("05_PLAN not found");

    // Find 05B
    const planFiles = await listFiles(token, planFolderId);
    const stratFile = planFiles.find(f => f.name.includes("05B") || f.name.includes("Strategick"));
    if (!stratFile) throw new Error("05B_Strategicky_Vyhled not found");

    const currentOutlook = await readFileContent(token, stratFile.id, stratFile.mimeType);

    // Read sections H from active cards
    const activeDir = await findFolder(token, "01_AKTIVNI_FRAGMENTY", root);
    let allSectionsH = "";
    if (activeDir) {
      const partFolders = (await listFiles(token, activeDir)).filter(f => f.mimeType === FOLDER_MIME);
      for (const folder of partFolders) {
        try {
          const cardFiles = await listFiles(token, folder.id);
          const cardFile = cardFiles.find(f =>
            f.mimeType !== FOLDER_MIME && !f.name.startsWith("BACKUP_") && !f.name.includes("ARCHIV") &&
            (f.mimeType === GDOC_MIME || /\.(txt|md)$/i.test(f.name))
          );
          if (!cardFile) continue;
          const content = await readFileContent(token, cardFile.id, cardFile.mimeType);
          const sectionH = content.match(/(?:SEKCE H|H\.|H –|H—)[^\n]*\n([\s\S]*?)(?=(?:SEKCE [I-M]|[I-M]\.|[I-M] –)|$)/i)?.[0] || "";
          if (sectionH) allSectionsH += `\n═══ ${folder.name} ═══\n${sectionH}`;
        } catch (e) { console.warn(`[strategic] Skip ${folder.name}:`, e); }
      }
    }

    // Read DB data
    const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
    const weekAgoDate = weekAgo.slice(0, 10);
    const [goalsRes, updateLogRes, sessionsRes, weekMetricsRes] = await Promise.all([
      sb.from("strategic_goals").select("*").eq("status", "active"),
      sb.from("card_update_log").select("*").gte("created_at", weekAgo).order("created_at", { ascending: false }).limit(50),
      sb.from("planned_sessions").select("*").gte("created_at", weekAgo).limit(100),
      sb.from("daily_metrics").select("*").gte("metric_date", weekAgoDate).order("metric_date", { ascending: true }),
    ]);

    const goalsText = (goalsRes.data || []).map(g => `[${g.part_name || "systém"}] ${g.goal_text} (${g.progress_pct}%, ${g.category})`).join("\n");
    const statsText = `Card updates: ${updateLogRes.data?.length || 0}, Sessions: ${sessionsRes.data?.length || 0} (done: ${sessionsRes.data?.filter(s => s.status === "done").length || 0})`;
    const weekMetrics = weekMetricsRes.data || [];
    const metricsText = weekMetrics.length ? `\nKVANTITATIVNÍ METRIKY ZA TÝDEN:\n${weekMetrics.map((m: any) =>
      `${m.metric_date} | ${m.part_name || "systém"} | zpráv: ${m.message_count} | valence: ${m.emotional_valence ?? "?"} | spolupráce: ${m.cooperation_level ?? "?"} | switching: ${m.switching_count}`
    ).join("\n")}` : "";

    const prompt = `Jsi Karel — strategický koordinátor DID terapie.

Dostáváš:
1. Aktuální strategický výhled
2. Dlouhodobé cíle ze všech karet (sekce H)
3. Strategické cíle z DB
4. Statistiky za poslední týden

TVŮ ÚKOL:
a) Zhodnoť pokrok u každého strategického cíle (0-100%)
b) Označ cíle které byly dosaženy (evidence z karet)
c) Navrhni nové cíle pokud z karet vyplývají
d) Identifikuj RIZIKA a TRENDY:
   - Která část se zhoršuje?
   - Která část stagnuje?
   - Kde je pozitivní trend?
e) Navrhni DOPORUČENÍ pro příští týden

Vrať:
1. PLAIN TEXT strategického výhledu (pro Drive):
═══ STRATEGICKÝ VÝHLED ═══
Aktualizováno: ${new Date().toISOString().slice(0, 10)}
[obsah]

2. JSON pro DB:
---GOALS JSON---
[
  {
    "part_name": "003_TUNDRUPEK",
    "goal_text": "...",
    "category": "stabilizace",
    "status": "active",
    "progress_pct": 65,
    "evidence": ["vlákno z 2026-03-25: ..."]
  }
]
---END GOALS JSON---

AKTUÁLNÍ VÝHLED:
${currentOutlook.slice(0, 6000)}

SEKCE H ZE VŠECH KARET:
${allSectionsH.slice(0, 8000)}

STRATEGICKÉ CÍLE:
${goalsText || "(žádné)"}

STATISTIKY ZA TÝDEN:
${statsText}`;

    const result = await callGemini(prompt);
    console.log(`[strategic] Gemini response: ${result.length} chars`);

    const jsonMatch = result.match(/---GOALS JSON---\s*([\s\S]*?)\s*---END GOALS JSON---/);
    const outlookText = result.replace(/---GOALS JSON---[\s\S]*---END GOALS JSON---/, "").trim();

    // Backup + overwrite
    await createBackup(token, planFolderId, stratFile.name, currentOutlook);
    await overwriteDoc(token, stratFile.id, outlookText);

    // Upsert goals
    let goalsUpdated = 0;
    if (jsonMatch?.[1]) {
      try {
        const goals: any[] = JSON.parse(jsonMatch[1].replace(/```json\s*|```/g, "").trim());
        for (const g of goals) {
          // Try update existing, else insert
          const { data: existing } = await sb
            .from("strategic_goals")
            .select("id")
            .eq("goal_text", g.goal_text)
            .limit(1);

          if (existing?.length) {
            await sb.from("strategic_goals").update({
              progress_pct: g.progress_pct || 0,
              status: g.status || "active",
              evidence: g.evidence || [],
              achieved_date: g.status === "achieved" ? new Date().toISOString().slice(0, 10) : null,
              updated_at: new Date().toISOString(),
            }).eq("id", existing[0].id);
          } else {
            await sb.from("strategic_goals").insert({
              part_name: g.part_name || null,
              goal_text: g.goal_text,
              category: g.category || null,
              status: g.status || "active",
              progress_pct: g.progress_pct || 0,
              evidence: g.evidence || [],
            });
          }
          goalsUpdated++;
        }
      } catch (e) { console.warn("[strategic] Goals parse error:", e); }
    }

    await sb.from("plan_update_log").insert({
      plan_type: "strategic",
      goals_updated: goalsUpdated,
      processing_time_ms: Date.now() - startTime,
    });

    return new Response(JSON.stringify({ success: true, goalsUpdated, processingTimeMs: Date.now() - startTime }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("[strategic] Error:", error);
    await sb.from("plan_update_log").insert({ plan_type: "strategic", error: error instanceof Error ? error.message : String(error), processing_time_ms: Date.now() - startTime }).catch(() => {});
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "Unknown" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
