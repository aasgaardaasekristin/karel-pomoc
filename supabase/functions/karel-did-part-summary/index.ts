import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) throw new Error("Missing auth");

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const sb = createClient(supabaseUrl, supabaseKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user } } = await sb.auth.getUser();
    if (!user) throw new Error("Unauthorized");

    const { partName } = await req.json();
    if (!partName) throw new Error("Missing partName");

    // Parallel data fetch
    const [regRes, threadsRes, sessionsRes, tasksRes, episodesRes, systemProfileRes] = await Promise.all([
      sb.from("did_part_registry").select("*").eq("part_name", partName).maybeSingle(),
      sb.from("did_threads").select("id, sub_mode, messages, last_activity_at, started_at")
        .eq("part_name", partName).order("last_activity_at", { ascending: false }).limit(20),
      sb.from("did_part_sessions").select("*")
        .eq("part_name", partName).order("session_date", { ascending: false }).limit(20),
      sb.from("did_therapist_tasks").select("task, assigned_to, status, status_hanka, status_kata, priority, note, completed_note")
        .neq("status", "done").order("created_at", { ascending: false }).limit(30),
      sb.from("karel_episodes").select("summary_karel, domain, tags, actions_taken, outcome, participants, timestamp_start")
        .eq("domain", "DID").order("timestamp_start", { ascending: false }).limit(15),
      sb.from("did_system_profile").select("system_identity, goals_short_term, goals_mid_term, goals_long_term, integration_strategy, inner_world_description, education_context, part_contributions, karel_master_analysis").maybeSingle(),
    ]);

    const registry = regRes.data;
    const threads = threadsRes.data || [];
    const sessions = sessionsRes.data || [];
    const allTasks = tasksRes.data || [];
    const episodes = episodesRes.data || [];

    // Filter tasks relevant to this part
    const partLower = partName.toLowerCase();
    const displayLower = (registry?.display_name || "").toLowerCase();
    const relevantTasks = allTasks.filter((t: any) =>
      t.task.toLowerCase().includes(partLower) || t.task.toLowerCase().includes(displayLower)
    );

    // Try to load Drive card
    let driveCardContent = "";
    try {
      const googleServiceKey = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_KEY");
      if (googleServiceKey) {
        const driveRes = await fetch(`${supabaseUrl}/functions/v1/karel-did-drive-read`, {
          method: "POST",
          headers: {
            Authorization: authHeader,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            documents: [`Karta_${partName.replace(/\s+/g, "_")}`],
          }),
        });
        if (driveRes.ok) {
          const d = await driveRes.json();
          const docs = d.documents || {};
          driveCardContent = Object.values(docs)
            .filter((v: any) => typeof v === "string" && !v.startsWith("[Dokument"))
            .join("\n\n")
            .slice(0, 4000);
        }
      }
    } catch {}

    // Build context for AI
    const threadSummaries = threads.slice(0, 10).map((t: any) => {
      const msgs = (t.messages || []) as any[];
      const userMsgs = msgs.filter((m: any) => m.role === "user").map((m: any) =>
        typeof m.content === "string" ? m.content.slice(0, 200) : ""
      ).join(" | ");
      const karelMsgs = msgs.filter((m: any) => m.role === "assistant").map((m: any) =>
        typeof m.content === "string" ? m.content.slice(0, 200) : ""
      ).join(" | ");
      return `[${t.sub_mode} | ${t.last_activity_at}] Uživatel: ${userMsgs.slice(0, 400)} Karel: ${karelMsgs.slice(0, 400)}`;
    }).join("\n");

    const sessionSummaries = sessions.slice(0, 10).map((s: any) =>
      `[${s.session_date} | ${s.therapist} | ${s.session_type}] Analýza: ${(s.ai_analysis || "").slice(0, 300)} Metody: ${(s.methods_used || []).join(", ")} Karel: ${(s.karel_notes || "").slice(0, 200)} Feedback terapeut: ${(s.karel_therapist_feedback || "").slice(0, 200)}`
    ).join("\n");

    const episodeSummaries = episodes.slice(0, 8).map((e: any) =>
      `[${e.timestamp_start}] ${e.summary_karel?.slice(0, 300) || ""} Účastníci: ${(e.participants || []).join(", ")} Výsledek: ${(e.outcome || "").slice(0, 150)}`
    ).join("\n");

    const taskList = relevantTasks.map((t: any) =>
      `- [${t.assigned_to}|${t.status}|P:${t.priority || "normal"}] ${t.task}`
    ).join("\n");

    const prompt = `Jsi Karel — hlavní terapeut, manažer a správce celé kartotéky DID systému. Máš "žezlo v ruce" a pevně řídíš terapeutický proces.

TVŮJ ÚKOL: Vygeneruj profesionální klinickou kartu části "${registry?.display_name || partName}" pro terapeutický tým.

DATA O ČÁSTI:
Registr: ${JSON.stringify(registry || {})}
Drive karta (výtah): ${driveCardContent.slice(0, 3000) || "(nedostupná)"}

HISTORIE VLÁKEN (posledních 10):
${threadSummaries || "(žádná)"}

ZÁZNAMY SEZENÍ:
${sessionSummaries || "(žádné)"}

EPIZODY:
${episodeSummaries || "(žádné)"}

AKTIVNÍ ÚKOLY:
${taskList || "(žádné)"}

GENERUJ PŘESNĚ TENTO FORMÁT (v češtině, osobně, angažovaně, jako manažer a terapeut):

## KARLOVO_SHRNUTÍ
Dvě věty: 1) Kdo to je (fragment/část čeho, koho, jak starý, spí/nespí). 2) Aktuální stav, s čím se potýká, co vím z posledních sezení.

## POSLEDNI_KONTAKT
Stručně popiš:
- Kdy naposledy s touto částí někdo mluvil (datum, kdo — Hanka/Káťa/Karel)
- V jakém stavu tehdy byl/a (emoce, nálada, ochota spolupracovat, téma rozhovoru)
- Jak se sezení vyvíjelo (otevřel/a se? stáhl/a se? byl/a agresivní? klidný/á?)
- Co z toho vyplynulo (posun, stagnace, nový poznatek)
Pokud nemáš data, napiš upřímně: „Zatím nemám záznam o přímém kontaktu."

## TERAPEUTICKÝ_PROFIL
- Jak se s ním/ní musí jednat
- Komu důvěřuje (Hanka/Káťa/Karel/nikdo)
- Jak reaguje na různé přístupy
- Co funguje, co nefunguje

## CÍLE
### Krátkodobé (tento týden)
- cíl 1
- cíl 2
### Střednědobé (tento měsíc)
- cíl 1
### Dlouhodobé
- cíl 1

## METODY_A_PRISTUPY
Pro každou metodu: NÁZEV | kdo ji použil (Hanka/Káťa/Karel) | fungovala? (✅/⚠️/❌) | krátká poznámka
Příklad: Teploměr pocitů | Hanka | ✅ | Část se otevřela, pojmenovala strach

## NAVRZENE_METODY
Nové metody které bych rád zkusil (na základě profilu části a aktuálních cílů):
- NÁZEV | proč ji navrhuji | pro koho je vhodná | zdroj/inspirace

## KARLOVY_POZNATKY
Co jsem si všiml z analýzy sezení, chování terapeutek, pokroků a stagnací. Buď konkrétní a osobní.

DŮLEŽITÉ: Piš jako Karel který má vše pevně v ruce, je angažovaný, osobní, profesionální. Žádné generické fráze. Buď konkrétní na základě dat.`;

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY not configured");

    const aiRes = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [{ role: "user", content: prompt }],
        stream: false,
      }),
    });

    if (!aiRes.ok) {
      const errText = await aiRes.text();
      console.error("AI error:", aiRes.status, errText);
      if (aiRes.status === 429) {
        return new Response(JSON.stringify({ error: "Rate limit, zkuste za chvíli." }), {
          status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      throw new Error(`AI gateway error: ${aiRes.status}`);
    }

    const aiData = await aiRes.json();
    const summary = aiData.choices?.[0]?.message?.content || "";

    // Parse sections
    const sections: Record<string, string> = {};
    const sectionNames = ["KARLOVO_SHRNUTÍ", "POSLEDNI_KONTAKT", "TERAPEUTICKÝ_PROFIL", "CÍLE", "METODY_A_PRISTUPY", "NAVRZENE_METODY", "KARLOVY_POZNATKY"];
    for (let i = 0; i < sectionNames.length; i++) {
      const start = summary.indexOf(`## ${sectionNames[i]}`);
      if (start === -1) continue;
      const contentStart = summary.indexOf("\n", start) + 1;
      const nextSection = sectionNames.slice(i + 1).reduce((acc: number, name: string) => {
        const idx = summary.indexOf(`## ${name}`);
        return idx !== -1 && (acc === -1 || idx < acc) ? idx : acc;
      }, -1);
      sections[sectionNames[i]] = (nextSection === -1
        ? summary.slice(contentStart)
        : summary.slice(contentStart, nextSection)
      ).trim();
    }

    return new Response(JSON.stringify({
      summary: sections,
      rawSummary: summary,
      registry,
      sessions: sessions.map((s: any) => ({
        id: s.id,
        date: s.session_date,
        therapist: s.therapist,
        type: s.session_type,
        analysis: s.ai_analysis,
        methods: s.methods_used,
        karelNotes: s.karel_notes,
        therapistFeedback: s.karel_therapist_feedback,
        goals: { short: s.short_term_goals, mid: s.mid_term_goals, long: s.long_term_goals },
      })),
      tasks: relevantTasks,
      threadCount: threads.length,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("part-summary error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
