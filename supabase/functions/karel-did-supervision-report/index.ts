import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { requireAuth, corsHeaders } from "../_shared/auth.ts";

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const authResult = await requireAuth(req);
  if (authResult instanceof Response) return authResult;
  const { user } = authResult;

  try {
    const { periodDays = 14 } = await req.json().catch(() => ({}));

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const since = new Date(Date.now() - periodDays * 24 * 60 * 60 * 1000).toISOString();

    // Fetch all data in parallel
    const [sessionsRes, registryRes, tasksRes, profileRes] = await Promise.all([
      supabase
        .from("did_part_sessions")
        .select("part_name, therapist, session_date, ai_analysis, karel_notes, handoff_note, methods_used, methods_effectiveness, karel_therapist_feedback")
        .eq("user_id", user.id)
        .gte("session_date", since.slice(0, 10))
        .order("session_date", { ascending: false }),
      supabase
        .from("did_part_registry")
        .select("part_name, display_name, status, last_seen_at, last_emotional_state, last_emotional_intensity, known_triggers, known_strengths, role_in_system, cluster")
        .eq("user_id", user.id),
      supabase
        .from("did_therapist_tasks")
        .select("task, assigned_to, status, status_hanka, status_kata, category, priority, created_at, completed_at")
        .eq("user_id", user.id)
        .gte("created_at", since),
      supabase
        .from("did_system_profile")
        .select("system_identity, goals_short_term, goals_mid_term, goals_long_term, current_priorities, risk_factors, integration_strategy")
        .eq("user_id", user.id)
        .limit(1)
        .single(),
    ]);

    const sessions = sessionsRes.data || [];
    const registry = registryRes.data || [];
    const tasks = tasksRes.data || [];
    const systemProfile = profileRes.data;

    // Extract switch logs from karel_notes
    const switchData: { session_date: string; part: string; switches: string[] }[] = [];
    const reflections: { session_date: string; therapist: string; part: string; text: string }[] = [];

    for (const s of sessions) {
      const notes = s.karel_notes || "";
      
      // Parse SWITCH LOG
      const switchMatch = notes.match(/## SWITCH LOG\n([\s\S]*?)(?=\n## |$)/);
      if (switchMatch) {
        const lines = switchMatch[1].trim().split("\n").filter((l: string) => l.trim());
        switchData.push({ session_date: s.session_date, part: s.part_name, switches: lines });
      }

      // Parse REFLEXE TERAPEUTKY
      const refMatch = notes.match(/## REFLEXE TERAPEUTKY([\s\S]*?)(?=\n## |$)/);
      if (refMatch) {
        reflections.push({
          session_date: s.session_date,
          therapist: s.therapist,
          part: s.part_name,
          text: refMatch[1].trim(),
        });
      }
    }

    // Build aggregation summary
    const partSessionCounts: Record<string, number> = {};
    const therapistSessionCounts: Record<string, number> = {};
    const methodsAgg: Record<string, { used: number; effective: number; partial: number; ineffective: number }> = {};

    for (const s of sessions) {
      partSessionCounts[s.part_name] = (partSessionCounts[s.part_name] || 0) + 1;
      therapistSessionCounts[s.therapist] = (therapistSessionCounts[s.therapist] || 0) + 1;

      for (const m of (s.methods_used || [])) {
        if (!methodsAgg[m]) methodsAgg[m] = { used: 0, effective: 0, partial: 0, ineffective: 0 };
        methodsAgg[m].used++;
      }
      const eff = s.methods_effectiveness || {};
      for (const [method, result] of Object.entries(eff)) {
        if (!methodsAgg[method]) methodsAgg[method] = { used: 0, effective: 0, partial: 0, ineffective: 0 };
        if (result === "effective") methodsAgg[method].effective++;
        else if (result === "partial") methodsAgg[method].partial++;
        else if (result === "ineffective") methodsAgg[method].ineffective++;
      }
    }

    const taskStats = {
      total: tasks.length,
      done: tasks.filter(t => t.status === "done").length,
      pending: tasks.filter(t => t.status === "pending").length,
      hankaActive: tasks.filter(t => t.status_hanka === "in_progress" || t.status_hanka === "done").length,
      kataActive: tasks.filter(t => t.status_kata === "in_progress" || t.status_kata === "done").length,
    };

    // Build the prompt for AI supervision report
    const dataPayload = `
═══ DATA PRO SUPERVIZNÍ REPORT (posledních ${periodDays} dní) ═══

SYSTÉMOVÝ PROFIL:
${systemProfile ? `Identita: ${systemProfile.system_identity}
Krátkodobé cíle: ${(systemProfile.goals_short_term || []).join(", ")}
Střednědobé cíle: ${(systemProfile.goals_mid_term || []).join(", ")}
Dlouhodobé cíle: ${(systemProfile.goals_long_term || []).join(", ")}
Priority: ${(systemProfile.current_priorities || []).join(", ")}
Rizikové faktory: ${(systemProfile.risk_factors || []).join(", ")}
Integrační strategie: ${systemProfile.integration_strategy}` : "Profil nenalezen"}

REGISTR ČÁSTÍ (${registry.length}):
${registry.map(p => `- ${p.part_name} (${p.display_name}) | status: ${p.status} | emoce: ${p.last_emotional_state} (${p.last_emotional_intensity}/5) | role: ${p.role_in_system || "?"} | cluster: ${p.cluster || "?"} | triggery: ${(p.known_triggers || []).join(", ") || "?"} | síly: ${(p.known_strengths || []).join(", ") || "?"}`).join("\n")}

SEZENÍ (${sessions.length}):
${Object.entries(partSessionCounts).map(([p, c]) => `- ${p}: ${c} sezení`).join("\n")}
Rozdělení terapeutek: ${Object.entries(therapistSessionCounts).map(([t, c]) => `${t}: ${c}`).join(", ")}

DETAILY SEZENÍ:
${sessions.slice(0, 20).map(s => `[${s.session_date}] ${s.part_name} (${s.therapist}): ${(s.ai_analysis || "").slice(0, 300)}…`).join("\n\n")}

SWITCHE (${switchData.length} sezení se switchi):
${switchData.length > 0 ? switchData.map(sd => `[${sd.session_date}] ${sd.part}: ${sd.switches.join(", ")}`).join("\n") : "Žádné switche zaznamenány"}

REFLEXE TERAPEUTEK (${reflections.length}):
${reflections.length > 0 ? reflections.map(r => `[${r.session_date}] ${r.therapist} o ${r.part}:\n${r.text}`).join("\n\n") : "Žádné reflexe"}

METODY (efektivita):
${Object.entries(methodsAgg).map(([m, stats]) => `- ${m}: použito ${stats.used}×, ✅${stats.effective} ⚠️${stats.partial} ❌${stats.ineffective}`).join("\n") || "Žádné metody"}

ÚKOLY: celkem ${taskStats.total}, splněno ${taskStats.done}, čeká ${taskStats.pending}
Hanka aktivní: ${taskStats.hankaActive}, Káťa aktivní: ${taskStats.kataActive}

HANDOFF NOTES (posledních 5):
${sessions.filter(s => s.handoff_note?.trim()).slice(0, 5).map(s => `[${s.session_date}] ${s.therapist} → kolegyni o ${s.part_name}:\n${s.handoff_note?.slice(0, 200)}`).join("\n\n") || "Žádné"}

ZPĚTNÁ VAZBA KARLA TERAPEUTKÁM:
${sessions.filter(s => s.karel_therapist_feedback?.trim()).slice(0, 5).map(s => `[${s.session_date}] ${s.therapist} — ${s.part_name}:\n${s.karel_therapist_feedback?.slice(0, 200)}`).join("\n\n") || "Žádná"}
`;

    const supervisionVoiceGuide = buildKarelVoiceGuide({ mode: "supervision", omitTemplate: true });
    const systemPrompt = supervisionVoiceGuide + `\n\nJsi Karel, expertní klinický supervizor specializovaný na DID (disociativní poruchu identity). Generuješ komplexní SUPERVIZNÍ REPORT pro tým terapeutek pracujících se systémem.

═══ KRITICKÁ PRAVIDLA ═══

1. ODDĚLENÍ ROLÍ:
- Hanka a Káťa jsou TERAPEUTKY – NIKDY je nezařazuj mezi DID části
- Locík je PES – NIKDY ho nezařazuj mezi DID části
- Karel je AI asistent – NIKDY ho nezařazuj mezi DID části

2. SPÍCÍ vs. AKTIVNÍ:
- Rozlišuj části s PŘÍMOU AKTIVITOU (sezení, komunikace) od pouze ZMÍNĚNÝCH
- U spících částí nenavrhuj přímou práci – pouze monitoring

3. PROFESIONÁLNÍ TÓN:
- ŽÁDNÉ intimní oslovení ("miláčku", "lásko", "drahá")
- Oslovuj: "Hani"/"Haničko", "Káťo"
- Tón: profesionální konzilium

4. SOUKROMÍ TERAPEUTEK:
- NIKDY do reportu nezařazuj: osobní emoční stavy terapeutek, pocit viny, osobní trauma
- Pouze klinicky relevantní vzorce v práci s klienty

5. NIKDY nenavrhuj dechová cvičení – klientka má epilepsii

FORMÁT REPORTU (striktně dodržuj):

# 🧠 DID Supervizní report — ${new Date().toLocaleDateString("cs-CZ")}

## 1. Shrnutí období
Stručný přehled: kolik sezení, s kolika částmi, klíčové trendy.

## 2. Mapa aktivity systému
Pro každou AKTIVNÍ část (s reálnými sezeními): kolik sezení, jaký emoční trend, klíčové události. Spící/neaktivní části uveď odděleně s poznámkou o monitoringu.

## 3. Vzorce switchování
Analyzuj switch logy: které části přepínají na které, v jakých situacích, co to znamená klinicky.

## 4. Reflexe terapeutek — meta-analýza
Shrň subjektivní reflexe obou terapeutek. Hledej KLINICKÉ vzorce: opakující se emoce, protipřenos, oblasti nejistoty. NIKDY nezveřejňuj soukromá/osobní data o terapeutkách.

## 5. Efektivita metod
Které metody fungují nejlépe, které ne. Doporuč úpravy přístupu.

## 6. Koordinace týmu
Jak fungují handoffy mezi terapeutkami. Jsou úkoly plněny? Je komunikace dostatečná?

## 7. Rizika a doporučení
Konkrétní rizika identifikovaná z dat. Doporučení pro příští období. Návrhy sezení POUZE pro aktivní části s konkrétní technikou, cíli a otevírací větou.

## 8. Supervizní otázky
3-5 otázek, které by měl tým probrat na supervizi.

Piš česky, profesionálně, klinicky přesně. Buď konkrétní — odkazuj na reálná data.`;

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY not configured");

    const aiResponse = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: dataPayload },
        ],
        max_tokens: 4000,
      }),
    });

    if (!aiResponse.ok) {
      const errText = await aiResponse.text();
      throw new Error(`AI API error: ${aiResponse.status} ${errText}`);
    }

    const aiData = await aiResponse.json();
    const report = aiData.choices?.[0]?.message?.content || "Report nebyl vygenerován.";

    const meta = {
      periodDays,
      sessionCount: sessions.length,
      partCount: Object.keys(partSessionCounts).length,
      switchCount: switchData.reduce((a, s) => a + s.switches.length, 0),
      reflectionCount: reflections.length,
      taskStats,
    };

    // Persist report to DB
    await supabase.from("did_supervision_reports").insert({
      user_id: user.id,
      period_days: periodDays,
      report_markdown: report,
      meta_json: meta,
    });

    return new Response(
      JSON.stringify({ report, meta }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Supervision report error:", error);
    return new Response(
      JSON.stringify({ error: error.message || "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
