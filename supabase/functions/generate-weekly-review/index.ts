import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/auth.ts";
import {
  getAccessToken, resolveKartotekaRoot, findFolder, listFiles,
  readFileContent, appendToDoc, createBackup,
  FOLDER_MIME, GDOC_MIME,
} from "../_shared/driveHelpers.ts";

const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY") ?? "";
const GEMINI_MODEL = "google/gemini-2.5-flash";

async function callGemini(prompt: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 110_000);
  try {
    const res = await fetch("https://api.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: GEMINI_MODEL, messages: [{ role: "user", content: prompt }], temperature: 0.4, max_tokens: 12000 }),
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
    const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
    const dateFrom = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const dateTo = new Date().toISOString().slice(0, 10);

    // Read DB data in parallel
    const [updateLogRes, sessionsRes, goalsRes] = await Promise.all([
      sb.from("card_update_log").select("*").gte("created_at", weekAgo).order("created_at", { ascending: false }),
      sb.from("planned_sessions").select("*").gte("created_at", weekAgo),
      sb.from("strategic_goals").select("*").eq("status", "active"),
    ]);

    const updateLogText = (updateLogRes.data || []).map(l =>
      `${l.part_name}: sections=${(l.sections_updated || []).join(",")}, contradictions=${l.contradictions_found || 0}`
    ).join("\n");

    const sessionsText = (sessionsRes.data || []).map(s =>
      `${s.part_name} — ${s.method_name} — ${s.therapist} — ${s.status}${s.actual_outcome ? ` → ${s.actual_outcome}` : ""}`
    ).join("\n");

    const goalsText = (goalsRes.data || []).map(g =>
      `[${g.part_name || "systém"}] ${g.goal_text} (${g.progress_pct}%)`
    ).join("\n");

    // Read sections E and K from active cards
    const token = await getAccessToken();
    const root = await resolveKartotekaRoot(token);
    if (!root) throw new Error("KARTOTEKA_DID not found");

    const activeDir = await findFolder(token, "01_AKTIVNI_FRAGMENTY", root);
    let sectionsEK = "";
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
          const sE = content.match(/(?:SEKCE E|E\.|E –)[^\n]*\n([\s\S]*?)(?=(?:SEKCE [F-M]|[F-M]\.))/i)?.[0] || "";
          const sK = content.match(/(?:SEKCE K|K\.|K –)[^\n]*\n([\s\S]*?)(?=(?:SEKCE [L-M]|[L-M]\.))/i)?.[0] || "";
          if (sE || sK) sectionsEK += `\n═══ ${folder.name} ═══\n${sE}\n${sK}`;
        } catch (e) { console.warn(`[review] Skip ${folder.name}:`, e); }
      }
    }

    const prompt = `Jsi Karel — autor týdenního review DID terapie.

Sestav TÝDENNÍ REVIEW za období ${dateFrom} - ${dateTo}.

OBSAH REVIEW:

1. SHRNUTÍ TÝDNE (3-5 vět)

2. AKTIVITA ČÁSTÍ:
   - Kdo byl aktivní, kolikrát, hlavní témata
   - Kdo nebyl aktivní (riziko?)

3. SPLNĚNÁ SEZENÍ:
   - Co proběhlo, s jakým výsledkem

4. NESPLNĚNÁ SEZENÍ:
   - Co se nestihlo a proč

5. POKROK U CÍLŮ:
   - Strategické cíle: pokrok za týden

6. ROZPORY A RIZIKA:
   - Co se objevilo nového

7. DOPORUČENÍ PRO PŘÍŠTÍ TÝDEN:
   - Top 3 priority
   - Na co si dát pozor

8. ZPRÁVA PRO HANIČKU:
   - Stručné, lidské shrnutí pro terapeutku
   - Co je třeba vědět, co sledovat

Piš česky, klinickým ale srozumitelným stylem. Formát: čistý text s emoji a nadpisy.

AKTUALIZACE KARET ZA TÝDEN:
${updateLogText || "(žádné)"}

SEZENÍ ZA TÝDEN:
${sessionsText || "(žádná)"}

STRATEGICKÉ CÍLE:
${goalsText || "(žádné)"}

SEKCE E+K ZE VŠECH KARET:
${sectionsEK.slice(0, 10000) || "(prázdné)"}`;

    const review = await callGemini(prompt);
    console.log(`[review] Gemini response: ${review.length} chars`);

    // Append to 06_Tydenni_Review on Drive
    const centrumId = await findFolder(token, "00_CENTRUM", root);
    if (centrumId) {
      const planFolderId = await findFolder(token, "05_PLAN", centrumId);
      if (planFolderId) {
        const planFiles = await listFiles(token, planFolderId);
        const reviewFile = planFiles.find(f => f.name.includes("06") || f.name.includes("Review") || f.name.includes("Tydenni"));
        if (reviewFile) {
          const separator = `\n\n${"═".repeat(50)}\n📋 TÝDENNÍ REVIEW: ${dateFrom} — ${dateTo}\n${"═".repeat(50)}\n\n`;
          await appendToDoc(token, reviewFile.id, separator + review);
          console.log("[review] Appended to 06_Tydenni_Review");
        }
      }
    }

    // Also save to 08_MESICNI_REPORTY as new file
    const reportsFolderId = await findFolder(token, "08_MESICNI_REPORTY", root);
    if (reportsFolderId) {
      const reportName = `${dateTo}_Tydenni_Report`;
      const createRes = await fetch("https://www.googleapis.com/drive/v3/files", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name: reportName, parents: [reportsFolderId], mimeType: "application/vnd.google-apps.document" }),
      });
      if (createRes.ok) {
        const newFile = await createRes.json();
        await fetch(`https://docs.googleapis.com/v1/documents/${newFile.id}:batchUpdate`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ requests: [{ insertText: { location: { index: 1 }, text: review } }] }),
        });
        console.log(`[review] Created report: ${reportName}`);
      }
    }

    // Log
    const doneCount = sessionsRes.data?.filter(s => s.status === "done").length || 0;
    const skippedCount = sessionsRes.data?.filter(s => s.status === "skipped").length || 0;
    await sb.from("plan_update_log").insert({
      plan_type: "weekly_review",
      sessions_completed: doneCount,
      goals_updated: goalsRes.data?.length || 0,
      processing_time_ms: Date.now() - startTime,
    });

    return new Response(JSON.stringify({
      success: true,
      reviewLength: review.length,
      sessionsDone: doneCount,
      sessionsSkipped: skippedCount,
      processingTimeMs: Date.now() - startTime,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (error) {
    console.error("[review] Error:", error);
    await sb.from("plan_update_log").insert({ plan_type: "weekly_review", error: error instanceof Error ? error.message : String(error), processing_time_ms: Date.now() - startTime }).catch(() => {});
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "Unknown" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
