import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/auth.ts";
import { loadDriveRegistryEntries } from "../_shared/driveRegistry.ts";

// ── OAuth2 token ──
async function getAccessToken(): Promise<string> {
  const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
  const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET");
  const refreshToken = Deno.env.get("GOOGLE_REFRESH_TOKEN");
  if (!clientId || !clientSecret || !refreshToken) throw new Error("Missing Google OAuth credentials");
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(`Token error: ${JSON.stringify(data)}`);
  return data.access_token;
}

// ── Read a Drive file (binary → text, or Google Docs export) ──
async function readDriveFile(token: string, fileId: string): Promise<string> {
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const expRes = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/plain&supportsAllDrives=true`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!expRes.ok) throw new Error(`Cannot read file ${fileId}`);
    return expRes.text();
  }
  return res.text();
}

// ── Find PAMET_KAREL in 00_CENTRUM ──
async function findPametKarel(token: string): Promise<string> {
  const strip = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

  // Find kartoteka root
  const rootNames = ["kartoteka_DID", "Kartoteka_DID", "Kartotéka_DID", "KARTOTEKA_DID"];
  let kartotekaId: string | null = null;
  for (const name of rootNames) {
    const q = `name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
    const res = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id)&pageSize=5&supportsAllDrives=true&includeItemsFromAllDrives=true`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    if (data.files?.[0]?.id) { kartotekaId = data.files[0].id; break; }
  }
  if (!kartotekaId) return "";

  // Find 00_CENTRUM
  const q2 = `'${kartotekaId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const r2 = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q2)}&fields=files(id,name)&pageSize=50&supportsAllDrives=true&includeItemsFromAllDrives=true`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const d2 = await r2.json();
  const centrumFolder = (d2.files || []).find((f: any) => /^00/.test(f.name.trim()) || f.name.toLowerCase().includes("centrum"));
  if (!centrumFolder) return "";

  // List files in 00_CENTRUM
  const q3 = `'${centrumFolder.id}' in parents and trashed=false`;
  const r3 = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q3)}&fields=files(id,name,mimeType)&pageSize=100&supportsAllDrives=true&includeItemsFromAllDrives=true`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const d3 = await r3.json();
  const centrumFiles = d3.files || [];

  // Find PAMET_KAREL
  const pametFile = centrumFiles.find((f: any) => {
    if (f.mimeType === "application/vnd.google-apps.folder") return false;
    const cn = strip(f.name);
    return cn.includes("pamet") && cn.includes("karel");
  });

  if (!pametFile) return "";
  try {
    return (await readDriveFile(token, pametFile.id)).slice(0, 8000);
  } catch {
    return "";
  }
}

// ── AI analysis call via Lovable AI ──
async function callAI(systemPrompt: string, userPrompt: string): Promise<string> {
  const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
  if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY not configured");

  const res = await fetch("https://ai.lovable.dev/api/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${LOVABLE_API_KEY}` },
    body: JSON.stringify({
      model: "google/gemini-2.5-flash",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.3,
      max_tokens: 4000,
    }),
  });

  if (!res.ok) throw new Error(`AI API error: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content || "";
}

// ── Extract JSON from AI response ──
function extractJSON(text: string): any {
  // Try direct parse
  try { return JSON.parse(text); } catch {}
  // Try markdown fence
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) { try { return JSON.parse(fenceMatch[1]); } catch {} }
  // Try first { to last }
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) { try { return JSON.parse(text.slice(first, last + 1)); } catch {} }
  throw new Error("Cannot extract JSON from AI response");
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    // ── Resolve user_id ──
    let userId: string | null = null;
    const authHeader = req.headers.get("Authorization");
    if (authHeader?.startsWith("Bearer ")) {
      const userClient = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
        global: { headers: { Authorization: authHeader } },
      });
      const { data: { user } } = await userClient.auth.getUser();
      userId = user?.id || null;
    }
    if (!userId) {
      const { data: fallback } = await sb.from("did_part_registry").select("user_id").limit(1).single();
      userId = fallback?.user_id || null;
    }
    if (!userId) {
      return new Response(JSON.stringify({ error: "No user found" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    console.log(`[daily-analyzer] Starting for user=${userId}, date=${today}`);

    // ══════════════════════════════════════════════════════════
    // 1. GATHER DATA FROM ALL SOURCES
    // ══════════════════════════════════════════════════════════

    // 1a. DB queries (parallel)
    const [
      { data: dailyCtx },
      { data: recentThreads },
      { data: tasks },
      { data: recentSessions },
      { data: parts },
      { data: motivProfiles },
      { data: bonds },
    ] = await Promise.all([
      sb.from("did_daily_context")
        .select("context_json, context_date")
        .eq("user_id", userId)
        .order("context_date", { ascending: false })
        .limit(1)
        .single(),
      sb.from("did_threads")
        .select("part_name, sub_mode, thread_label, messages, last_activity_at, started_at")
        .eq("user_id", userId)
        .gte("last_activity_at", yesterday)
        .order("last_activity_at", { ascending: false })
        .limit(30),
      sb.from("did_therapist_tasks")
        .select("task, assigned_to, status, status_hanka, status_kata, priority, due_date, created_at, category, escalation_level, detail_instruction")
        .eq("user_id", userId)
        .neq("status", "done")
        .order("priority", { ascending: false }),
      sb.from("did_part_sessions")
        .select("part_name, therapist, session_date, session_type, methods_used, ai_analysis, karel_notes, handoff_note, short_term_goals")
        .eq("user_id", userId)
        .order("session_date", { ascending: false })
        .limit(15),
      sb.from("did_part_registry")
        .select("part_name, display_name, status, cluster, age_estimate, last_seen_at, last_emotional_state, last_emotional_intensity, health_score, known_triggers, known_strengths, role_in_system")
        .eq("user_id", userId),
      sb.from("did_motivation_profiles")
        .select("therapist, preferred_style, tasks_completed, tasks_missed, streak_current, avg_completion_days, praise_effectiveness, deadline_effectiveness, instruction_effectiveness")
        .eq("user_id", userId),
      sb.from("did_countertransference_bonds")
        .select("therapist, part_name, bond_type, bond_description, intensity, therapeutic_implication")
        .eq("user_id", userId),
    ]);

    // 1b. Drive: PAMET_KAREL + Index
    let pametKarelText = "";
    let driveIndexSummary = "";
    try {
      const token = await getAccessToken();
      const [pamet, registryEntries] = await Promise.all([
        findPametKarel(token),
        loadDriveRegistryEntries(token),
      ]);
      pametKarelText = pamet;
      if (registryEntries.length > 0) {
        driveIndexSummary = registryEntries.map(e =>
          `${e.id} | ${e.primaryName}${e.aliases.length ? ` (${e.aliases.join(", ")})` : ""} | Status: ${e.status}`
        ).join("\n");
      }
    } catch (e) {
      console.warn("[daily-analyzer] Drive read error (non-fatal):", e);
    }

    // 1c. Summarize recent threads (last 24h)
    const threadSummaries = (recentThreads || []).map((t: any) => {
      const msgs = Array.isArray(t.messages) ? t.messages : [];
      const lastMsgs = msgs.slice(-3).map((m: any) => `${m.role}: ${String(m.content || "").slice(0, 200)}`).join("\n  ");
      return `[${t.sub_mode}] ${t.part_name} – "${t.thread_label || "bez názvu"}" (${t.last_activity_at?.slice(0, 16)})\n  ${lastMsgs}`;
    }).join("\n\n");

    // 1d. Active/sleeping parts
    const activeParts = (parts || []).filter((p: any) => p.status === "active");
    const sleepingParts = (parts || []).filter((p: any) => p.status === "sleeping" || p.status === "dormant");

    // 1e. Therapist profiles
    const hankaProfile = (motivProfiles || []).find((p: any) => p.therapist === "Hanka");
    const kataProfile = (motivProfiles || []).find((p: any) => p.therapist === "Káťa" || p.therapist === "Kata");

    // 1f. Bonds summary (for Karel's internal use only, NOT for therapist-facing output)
    const bondsSummary = (bonds || []).map((b: any) =>
      `${b.therapist}→${b.part_name}: ${b.bond_type} (intenzita ${b.intensity}/5) – ${b.bond_description || ""}`
    ).join("\n");

    console.log(`[daily-analyzer] Data: threads=${(recentThreads || []).length}, tasks=${(tasks || []).length}, sessions=${(recentSessions || []).length}, parts=${(parts || []).length}, pamet=${pametKarelText.length}ch, index=${driveIndexSummary.length}ch`);

    // ══════════════════════════════════════════════════════════
    // 2. BUILD AI PROMPT
    // ══════════════════════════════════════════════════════════

    const systemPrompt = `Jsi Karel – AI asistent DID terapeutického týmu. Tvým úkolem je provést DENNÍ ANALÝZU stavu celého DID systému a obou terapeutek.

TVOJE ROLE:
- Analyzuješ data z posledních 24 hodin (vlákna, sezení, úkoly).
- Čteš PAMET_KAREL (tvá dlouhodobá paměť o terapeutkách – NIKDY ji nezobrazuj přímo).
- Čteš Index Všech Částí (autoritativní seznam částí a jejich stavů).
- Znáš emoční vazby (countertransference bonds) mezi terapeutkami a částmi.

KRITICKÁ PRAVIDLA:
- Káťa NENÍ část DID systému. Je to DRUHÁ TERAPEUTKA (dcera Hanky).
- Hanka je PRVNÍ TERAPEUTKA (životní partnerka Karla).
- Soukromá data o terapeutkách (emoční vazby, osobní stresory) se NIKDY nesmí zobrazit v UI. Používej je pouze pro svou dedukci.
- "active" = část se přímo projevila (sub_mode=cast). "sleeping" = neprojevila se, ale je v registru.
- Pokud část nebyla aktivní v posledních 24h ale je v registru jako "active", i tak ji uveď jako active.

VÝSTUP: Vrať POUZE jeden validní JSON objekt (bez markdown fences, bez komentářů) přesně v tomto formátu:
{
  "date": "${today}",
  "therapists": {
    "Hanka": {
      "long_term": {
        "traits": ["...popisné rysy z PAMET_KAREL..."],
        "style": "stručný popis terapeutického stylu",
        "reliability": "high|medium|low",
        "experience_notes": "poznámky k zkušenostem"
      },
      "situational": {
        "energy": "low|medium|high",
        "health": "stručný odhad",
        "current_stressors": ["...aktuální stresory z vláken/kontextu..."],
        "notes": "situační poznámka"
      }
    },
    "Kata": {
      "long_term": {
        "traits": ["..."],
        "style": "",
        "reliability": "",
        "experience_notes": ""
      },
      "situational": {
        "energy": "low|medium|high",
        "health": "",
        "current_stressors": ["..."],
        "notes": ""
      }
    }
  },
  "parts": [
    {
      "name": "JMÉNO",
      "status": "active|sleeping",
      "recent_emotions": "stručný popis emočního stavu",
      "needs": ["potřeba1", "potřeba2"],
      "risk_level": "low|medium|high",
      "relationship_to_therapists": {
        "Hanka": "stručný popis vztahu",
        "Kata": "stručný popis vztahu"
      },
      "session_recommendation": {
        "needed": true,
        "who_leads": "Hanka|Kata|Karel",
        "priority": "today|soon|later",
        "goals": ["cíl1", "cíl2"]
      }
    }
  ],
  "team_observations": {
    "cooperation": "stručný popis spolupráce týmu",
    "warnings": ["varování1"],
    "praise": ["pochvala1"]
  }
}

Pro KAŽDOU část v registru (aktivní i spící) vytvoř záznam v "parts". U spících částí bude session_recommendation.needed=false a priority="later".`;

    const userPrompt = `═══ DATA PRO ANALÝZU (${today}) ═══

═══ INDEX VŠECH ČÁSTÍ (z Drive – zdroj pravdy) ═══
${driveIndexSummary || "(nepodařilo se načíst)"}

═══ REGISTR ČÁSTÍ V DB (po synchronizaci s indexem) ═══
AKTIVNÍ (${activeParts.length}):
${activeParts.map((p: any) => `• ${p.display_name || p.part_name} – klastr: ${p.cluster || "?"}, věk: ${p.age_estimate || "?"}, emoce: ${p.last_emotional_state || "?"} (${p.last_emotional_intensity || "?"}/10), zdraví: ${p.health_score || "?"}, role: ${p.role_in_system || "?"}, triggery: ${(p.known_triggers || []).join(", ") || "?"}, síly: ${(p.known_strengths || []).join(", ") || "?"}`).join("\n") || "žádné"}

SPÍCÍ (${sleepingParts.length}):
${sleepingParts.map((p: any) => `• ${p.display_name || p.part_name} – klastr: ${p.cluster || "?"}`).join("\n") || "žádné"}

═══ VLÁKNA ZA POSLEDNÍCH 24H ═══
${threadSummaries || "(žádná aktivita)"}

═══ NESPLNĚNÉ ÚKOLY ═══
${(tasks || []).slice(0, 20).map((t: any) => {
  const ageDays = Math.floor((Date.now() - new Date(t.created_at).getTime()) / (1000 * 60 * 60 * 24));
  return `• [${t.priority}${t.escalation_level >= 2 ? " ⚠️ESK" : ""}] ${t.task} → ${t.assigned_to} (${ageDays}d, H:${t.status_hanka}, K:${t.status_kata})`;
}).join("\n") || "(žádné)"}

═══ POSLEDNÍ SEZENÍ ═══
${(recentSessions || []).slice(0, 10).map((s: any) => `• ${s.session_date}: ${s.part_name} s ${s.therapist} (${s.session_type}) – metody: ${(s.methods_used || []).join(", ") || "?"}, cíle: ${(s.short_term_goals || []).join(", ") || "?"}`).join("\n") || "(žádná)"}

═══ PROFILY TERAPEUTEK (motivace) ═══
Hanka: styl=${hankaProfile?.preferred_style || "?"}, splněno=${hankaProfile?.tasks_completed || 0}, zmeškaných=${hankaProfile?.tasks_missed || 0}, streak=${hankaProfile?.streak_current || 0}, průměr dokončení=${hankaProfile?.avg_completion_days || "?"}d
Káťa: styl=${kataProfile?.preferred_style || "?"}, splněno=${kataProfile?.tasks_completed || 0}, zmeškaných=${kataProfile?.tasks_missed || 0}, streak=${kataProfile?.streak_current || 0}, průměr dokončení=${kataProfile?.avg_completion_days || "?"}d

═══ PAMĚŤ KARLA (dlouhodobá) ═══
${pametKarelText || "(nepodařilo se načíst)"}

═══ EMOČNÍ VAZBY (countertransference – POUZE pro tvou dedukci) ═══
${bondsSummary || "(žádné záznamy)"}

═══ DENNÍ KONTEXT Z KAREL-DAILY-REFRESH ═══
${dailyCtx?.context_json ? `Dashboard: ${(dailyCtx.context_json as any)?.drive_documents?.dashboard?.slice(0, 1000) || "(nenačten)"}
Operativní plán: ${(dailyCtx.context_json as any)?.drive_documents?.operativni_plan?.slice(0, 1000) || "(nenačten)"}` : "(denní kontext není k dispozici)"}

Proveď analýzu a vrať JSON.`;

    // ══════════════════════════════════════════════════════════
    // 3. CALL AI
    // ══════════════════════════════════════════════════════════
    console.log(`[daily-analyzer] Calling AI, prompt size: system=${systemPrompt.length}ch, user=${userPrompt.length}ch`);
    const aiResponse = await callAI(systemPrompt, userPrompt);
    console.log(`[daily-analyzer] AI response: ${aiResponse.length}ch`);

    const analysisJson = extractJSON(aiResponse);

    // Validate basic structure
    if (!analysisJson.date || !analysisJson.therapists || !analysisJson.parts) {
      throw new Error("AI response missing required fields (date, therapists, parts)");
    }

    // ══════════════════════════════════════════════════════════
    // 4. SAVE TO did_daily_context.analysis_json
    // ══════════════════════════════════════════════════════════
    const { error: updateError } = await sb.from("did_daily_context")
      .update({ analysis_json: analysisJson, updated_at: new Date().toISOString() })
      .eq("user_id", userId)
      .eq("context_date", today);

    if (updateError) {
      // If no row exists for today yet, insert one
      if (updateError.code === "PGRST116" || updateError.message?.includes("0 rows")) {
        const { error: insertError } = await sb.from("did_daily_context").insert({
          user_id: userId,
          context_date: today,
          context_json: dailyCtx?.context_json || {},
          analysis_json: analysisJson,
          source: "karel-did-daily-analyzer",
          updated_at: new Date().toISOString(),
        });
        if (insertError) {
          console.error("[daily-analyzer] Insert error:", insertError);
          return new Response(JSON.stringify({ error: insertError.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
      } else {
        console.error("[daily-analyzer] Update error:", updateError);
        return new Response(JSON.stringify({ error: updateError.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
    }

    console.log(`[daily-analyzer] ✅ Analysis saved: ${JSON.stringify(analysisJson).length} bytes, parts=${analysisJson.parts?.length || 0}`);

    return new Response(JSON.stringify({
      success: true,
      date: today,
      stats: {
        parts_analyzed: analysisJson.parts?.length || 0,
        threads_reviewed: (recentThreads || []).length,
        tasks_pending: (tasks || []).length,
        pamet_loaded: pametKarelText.length > 0,
        drive_index_loaded: driveIndexSummary.length > 0,
      },
      analysis: analysisJson,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (error) {
    console.error("[daily-analyzer] Error:", error);
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
