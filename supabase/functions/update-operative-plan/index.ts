import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/auth.ts";
import {
  getAccessToken, resolveKartotekaRoot, findFolder, listFiles,
  readFileContent, overwriteDoc, createBackup, findFileByName,
  FOLDER_MIME, GDOC_MIME, type DriveFile,
} from "../_shared/driveHelpers.ts";

const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY") ?? "";
const GEMINI_MODEL = "google/gemini-2.5-flash";
const TIMEOUT_MS = 110_000;

async function callGemini(prompt: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch("https://api.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: GEMINI_MODEL,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.3,
        max_tokens: 16000,
      }),
      signal: controller.signal,
    });
    const data = await res.json();
    return data.choices?.[0]?.message?.content || "";
  } finally {
    clearTimeout(timer);
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const startTime = Date.now();
  const sb = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  try {
    const token = await getAccessToken();
    const root = await resolveKartotekaRoot(token);
    if (!root) throw new Error("KARTOTEKA_DID not found");

    // Find 05_PLAN folder and 05A file
    const centrumId = await findFolder(token, "00_CENTRUM", root);
    if (!centrumId) throw new Error("00_CENTRUM not found");
    const planFolderId = await findFolder(token, "05_PLAN", centrumId);
    if (!planFolderId) throw new Error("05_PLAN not found");

    // Find 05A document
    const planFiles = await listFiles(token, planFolderId);
    const planFile = planFiles.find(f => f.name.includes("05A") || f.name.includes("Operativni"));
    if (!planFile) throw new Error("05A_Operativni_Plan not found");

    const currentPlan = await readFileContent(token, planFile.id, planFile.mimeType);
    console.log(`[operative-plan] Current plan: ${currentPlan.length} chars`);

    // Read sections I+J from all active part cards
    const activeDir = await findFolder(token, "01_AKTIVNI_FRAGMENTY", root);
    let allSectionsIJ = "";
    const partsIncluded: string[] = [];

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
          // Extract sections I and J
          const sectionI = content.match(/(?:SEKCE I|I\.|I –|I—)[^\n]*\n([\s\S]*?)(?=(?:SEKCE [J-M]|[J-M]\.|[J-M] –|[J-M]—)|$)/i)?.[0] || "";
          const sectionJ = content.match(/(?:SEKCE J|J\.|J –|J—)[^\n]*\n([\s\S]*?)(?=(?:SEKCE [K-M]|[K-M]\.|[K-M] –|[K-M]—)|$)/i)?.[0] || "";

          if (sectionI || sectionJ) {
            allSectionsIJ += `\n\n═══ ${folder.name} ═══\n${sectionI}\n${sectionJ}`;
            partsIncluded.push(folder.name);
          }
        } catch (e) {
          console.warn(`[operative-plan] Skip ${folder.name}: ${e}`);
        }
      }
    }

    // Read pending cross-writes
    const { data: crossWrites } = await sb
      .from("card_crosswrite_queue")
      .select("*")
      .eq("status", "pending")
      .ilike("target_file", "%05A%");
    const crossWriteText = (crossWrites || []).map(cw => `[${cw.source_part}] ${cw.action}: ${cw.content}`).join("\n");

    // Read existing planned sessions
    const { data: existingSessions } = await sb
      .from("planned_sessions")
      .select("*")
      .in("status", ["planned", "scheduled"])
      .order("created_at", { ascending: false })
      .limit(50);
    const sessionsText = (existingSessions || []).map(s =>
      `${s.part_name} — ${s.method_name} — terapeut: ${s.therapist} — priorita: ${s.priority} — status: ${s.status}`
    ).join("\n");

    // Call Gemini
    const prompt = `Jsi Karel — klinický psycholog a koordinátor terapeutického procesu pro DID systém.

Dostáváš:
1. Aktuální operativní plán z Drive
2. Sekce I a J ze všech aktivních karet částí
3. Nové cross-write požadavky z aktualizace karet
4. Aktuálně naplánovaná sezení

TVŮ ÚKOL:
Sestav AKTUALIZOVANÝ operativní plán na nejbližší 3-5 dní.

PRAVIDLA:
a) Pro KAŽDOU aktivní část vyber 1-3 NEJRELEVANTNĚJŠÍ metody/aktivity ze sekce I její karty
b) Prioritizuj podle sekce J (krátkodobé cíle) — co je nejurgentněší?
c) Přiřaď terapeuta:
   - Hanka: mateřské aktivity, emoční podpora, rituály, deníky, pohádky
   - Káťa: arteterapie, projektivní techniky, sandplay, kreativní práce
   - Karel: rozhovory ve vlákně, krizové intervence, psychoedukace, hry
   - Tým (tandem): složitá témata vyžadující více perspektiv
d) Označ horizont: TEĎ (tyto dny) / BRZY (tento týden) / POZDĚJI (příští týdny)
e) U každého sezení napiš:
   - Část + metoda
   - Terapeut
   - Cíl sezení (1 věta)
   - Pomůcky/příprava
   - Priorita (urgent/soon/normal)
f) Odstraň z plánu sezení která jsou již splněná nebo zastaralá
g) Zkontroluj zda plán pokrývá VŠECHNY aktivní části — žádná nesmí být vynechána déle než 3 dny

FORMÁT VÝSTUPU:
Vrať DVĚ věci oddělené:

1. PLAIN TEXT operativního plánu (pro Drive):
═══ OPERATIVNÍ PLÁN ═══
Aktualizováno: ${new Date().toISOString().slice(0, 10)}

🔴 URGENTNÍ (dnes/zítra):
[část] — [metoda] — terapeut: [jméno]
Cíl: [text]
Pomůcky: [text]

🟡 BRZY (tento týden):
...

🟢 PLÁNOVANÉ (příští týdny):
...

📊 POKRYTÍ ČÁSTÍ:
[část]: poslední sezení [datum], další plánované [datum]
...

2. JSON pro DB (planned_sessions):
---SESSIONS JSON---
[
  {
    "part_name": "003_TUNDRUPEK",
    "therapist": "kata",
    "method_name": "Test stromu",
    "method_source": "sekce_I",
    "priority": "soon",
    "horizon": "short",
    "description": "Projektivní test...",
    "expected_outcome": "Diagnostika..."
  }
]
---END SESSIONS JSON---

AKTUÁLNÍ PLÁN:
${currentPlan.slice(0, 8000)}

SEKCE I+J ZE VŠECH KARET:
${allSectionsIJ.slice(0, 12000)}

CROSS-WRITE POŽADAVKY:
${crossWriteText || "(žádné)"}

EXISTUJÍCÍ NAPLÁNOVANÁ SEZENÍ:
${sessionsText || "(žádná)"}`;

    const result = await callGemini(prompt);
    console.log(`[operative-plan] Gemini response: ${result.length} chars`);

    // Parse result
    const jsonMatch = result.match(/---SESSIONS JSON---\s*([\s\S]*?)\s*---END SESSIONS JSON---/);
    const planText = result.replace(/---SESSIONS JSON---[\s\S]*---END SESSIONS JSON---/, "").trim();

    // Backup + overwrite Drive
    await createBackup(token, planFolderId, planFile.name, currentPlan);
    await overwriteDoc(token, planFile.id, planText);
    console.log("[operative-plan] Drive updated");

    // Parse and upsert sessions
    let sessionsPlanned = 0;
    if (jsonMatch?.[1]) {
      try {
        const rawJson = jsonMatch[1].replace(/```json\s*|```/g, "").trim();
        const sessions: any[] = JSON.parse(rawJson);
        for (const s of sessions) {
          await sb.from("planned_sessions").insert({
            part_name: s.part_name,
            therapist: s.therapist,
            method_name: s.method_name,
            method_source: s.method_source || "karel_analysis",
            priority: s.priority || "normal",
            status: "planned",
            horizon: s.horizon || "short",
            description: s.description || "",
            expected_outcome: s.expected_outcome || "",
          });
          sessionsPlanned++;
        }
      } catch (e) {
        console.warn("[operative-plan] Sessions parse error:", e);
      }
    }

    // Mark cross-writes as done
    if (crossWrites?.length) {
      for (const cw of crossWrites) {
        await sb.from("card_crosswrite_queue").update({ status: "done", processed_at: new Date().toISOString() }).eq("id", cw.id);
      }
    }

    // Log
    await sb.from("plan_update_log").insert({
      plan_type: "operative",
      parts_included: partsIncluded,
      sessions_planned: sessionsPlanned,
      processing_time_ms: Date.now() - startTime,
    });

    return new Response(JSON.stringify({
      success: true,
      partsIncluded: partsIncluded.length,
      sessionsPlanned,
      processingTimeMs: Date.now() - startTime,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (error) {
    console.error("[operative-plan] Error:", error);
    await sb.from("plan_update_log").insert({
      plan_type: "operative",
      error: error instanceof Error ? error.message : String(error),
      processing_time_ms: Date.now() - startTime,
    }).catch(() => {});

    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "Unknown" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
