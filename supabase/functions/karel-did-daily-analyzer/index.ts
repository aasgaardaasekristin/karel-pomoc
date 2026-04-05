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

  const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${LOVABLE_API_KEY}` },
    body: JSON.stringify({
      model: "google/gemini-2.5-flash",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.2,
      max_tokens: 6000,
      response_format: { type: "json_object" },
    }),
  });

  if (!res.ok) throw new Error(`AI API error: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content || "";
}

// ── Extract JSON from AI response ──
function extractJSON(text: string): any {
  // Strip thinking tags if present
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  // Try direct parse
  try { return JSON.parse(cleaned); } catch {}
  // Try markdown fence
  const fenceMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) { try { return JSON.parse(fenceMatch[1]); } catch {} }
  // Try first { to last }
  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first >= 0 && last > first) { try { return JSON.parse(cleaned.slice(first, last + 1)); } catch {} }
  // Fallback: try to parse the first valid JSON object
  try {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
  } catch {}
  // All attempts failed — return empty fallback instead of crashing
  console.error(`[DAILY-ANALYZER] JSON parse failed, using empty fallback. First 500 chars: ${cleaned.slice(0, 500)}`);
  return {};
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

    // ── Build set of parts that had DIRECT communication in last 24h ──
    const directlyActiveParts = new Set<string>();
    for (const t of (recentThreads || [])) {
      if (t.sub_mode === "cast" && t.part_name) {
        directlyActiveParts.add(t.part_name.toUpperCase().trim());
      }
    }
    console.log(`[daily-analyzer] Directly active parts (sub_mode=cast, 24h): ${[...directlyActiveParts].join(", ") || "(none)"}`);

    // ── Banned entities that are NEVER DID parts ──
    const BANNED_ENTITIES = new Set([
      "LOCIK", "LOCÍK", "LOCEK", // pes, domácí zvíře – NIKDY DID část
      "HANKA", "KATA", "KÁŤA", "KATKA", "KATEŘINA", // terapeutky – NIKDY DID části
      "KAREL", // AI asistent – NIKDY DID část
      "JIŘÍ", "JIRI", "AMÁLKA", "AMALKA", "TONIČKA", "TONICKA", // biologické děti – NIKDY DID části
    ]);

    // ── Parts that must NOT be marked active unless they had direct communication ──
    const STRICT_SLEEPING_UNLESS_DIRECT = new Set([
      "BENDIK", "BENDIK_BONDEVIK",
      "CLARK", "KLARK",
      "ADAM",
      "EINAR",
      "BELO", "BÉLO",
      "GERHARDT",
    ]);

    const systemPrompt = `Jsi Karel – AI asistent DID terapeutického týmu. Tvým úkolem je provést DENNÍ ANALÝZU stavu celého DID systému a obou terapeutek.

TVOJE ROLE:
- Analyzuješ data z posledních 24 hodin (vlákna, sezení, úkoly).
- Čteš PAMET_KAREL (tvá dlouhodobá paměť o terapeutkách – NIKDY ji nezobrazuj přímo).
- Čteš Index Všech Částí (autoritativní seznam částí a jejich stavů).
- Znáš emoční vazby (countertransference bonds) mezi terapeutkami a částmi.
- Locík je PES, domácí zvíře – NIKDY ho nezařazuj do analysis_json.parts.

═══ TVRDÁ PRAVIDLA (NESMÍŠ PORUŠIT) ═══

1. ZDROJ PRAVDY PRO ČÁSTI
- Seznam částí je POUZE 01_Index_Vsech_Casti (Excel), synchronizovaný do did_part_registry.
- Jakákoliv entita, která NENÍ v Indexu (např. Locik, jiná zvířata, metafory),
  NIKDY nesmí být považována za část DID systému ani se objevit v analysis_json.parts.
- Locik je PES – NIKDY ho nezařazuj do analysis_json.parts.

2. STATUS "ACTIVE" VS "SLEEPING"
- Část má status "active" POUZE tehdy, když:
  a) je v did_part_registry jako existující část A
  b) v posledních 24 hodinách existuje vlákno v DID/kluci,
     kde sub_mode = "cast" a part_name odpovídá této části (včetně aliasů).
- Pokud podmínka b) NENÍ splněná, musí mít status "sleeping",
  i když je v indexu jako "aktivní" nebo se o ní mluví v jiných vláknech.
- PŘÍMO AKTIVNÍ ČÁSTI (sub_mode=cast za posledních 24h): ${[...directlyActiveParts].join(", ") || "ŽÁDNÉ"}
- Všechny ostatní části MUSÍ mít status = "sleeping".

3. ZMÍNKA O ČÁSTI ≠ AKTIVACE
- Pokud Hanka nebo Káťa mluví "o Bendikovi", "o Clarkovi" atd.,
  ale část sama v posledních 24h nepsala v DID/kluci (sub_mode=cast),
  tak:
  - status MUSÍ být "sleeping",
  - session_recommendation.needed = false.

4. ZÁKAZ PRO SPECIFICKÁ JMÉNA
- Tyto entity se NESMÍ objevit jako "active" ani jako adresáti sezení,
  pokud nemají PŘÍMOU komunikaci (sub_mode=cast) za posledních 24h:
  Bendik, Clark/Klark, Adam, Einar, Bélo/Belo, Gerhardt.
- Locik NIKDY není část systému a NESMÍ být v analysis_json.parts vůbec.

5. KÁŤA NENÍ ČÁST DID SYSTÉMU
- Káťa je DRUHÁ TERAPEUTKA (dcera Hanky). NIKDY ji nezařazuj do parts.
- Hanka je PRVNÍ TERAPEUTKA (životní partnerka Karla).

6. SOUKROMÉ INFORMACE
- Soukromá data o terapeutkách (emoční vazby, osobní stresory) se NIKDY nesmí
  zobrazit v UI. Používej je pouze pro svou dedukci.

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

PRAVIDLA PRO POLE "parts":
- Pro KAŽDOU část v registru (aktivní i spící) vytvoř záznam.
- U spících částí: session_recommendation.needed=false, priority="later".
- PŘIPOMENUTÍ: status="active" POUZE pokud je v seznamu PŘÍMO AKTIVNÍCH ČÁSTÍ výše.
- Všechny ostatní MUSÍ mít status="sleeping", i když je v registru "active".`;

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

    // ── POST-PROCESSING: enforce hard rules on AI output ──
    if (Array.isArray(analysisJson.parts)) {
      // Remove banned entities (e.g. Locik)
      analysisJson.parts = analysisJson.parts.filter((p: any) => {
        const nameUpper = (p.name || "").toUpperCase().replace(/\s+/g, "_").trim();
        if (BANNED_ENTITIES.has(nameUpper)) {
          console.log(`[daily-analyzer] REMOVED banned entity from parts: ${p.name}`);
          return false;
        }
        return true;
      });

      // Force correct status based on direct communication
      for (const p of analysisJson.parts) {
        const nameUpper = (p.name || "").toUpperCase().replace(/\s+/g, "_").trim();
        const hadDirectComm = directlyActiveParts.has(nameUpper);

        if (!hadDirectComm) {
          // Check aliases: strip diacritics for matching
          const nameNorm = nameUpper.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
          const hadDirectNorm = [...directlyActiveParts].some(dp =>
            dp.normalize("NFD").replace(/[\u0300-\u036f]/g, "") === nameNorm
          );

          if (!hadDirectNorm) {
            if (p.status === "active") {
              console.log(`[daily-analyzer] FORCED sleeping: ${p.name} (no direct comm in 24h)`);
              p.status = "sleeping";
            }
            if (p.session_recommendation) {
              p.session_recommendation.needed = false;
              p.session_recommendation.priority = "later";
            }
          }
        }

        // Extra guard for strict-sleeping list
        if (STRICT_SLEEPING_UNLESS_DIRECT.has(nameUpper) && !directlyActiveParts.has(nameUpper)) {
          p.status = "sleeping";
          if (p.session_recommendation) {
            p.session_recommendation.needed = false;
            p.session_recommendation.priority = "later";
          }
        }
      }

      const activeCount = analysisJson.parts.filter((p: any) => p.status === "active").length;
      const sleepingCount = analysisJson.parts.filter((p: any) => p.status === "sleeping").length;
      console.log(`[daily-analyzer] Post-processing: ${activeCount} active, ${sleepingCount} sleeping`);
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
