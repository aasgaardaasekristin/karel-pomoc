import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireAuth, corsHeaders } from "../_shared/auth.ts";

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const authResult = await requireAuth(req);
  if (authResult instanceof Response) return authResult;

  const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
  if (!LOVABLE_API_KEY) {
    return new Response(JSON.stringify({ error: "Missing LOVABLE_API_KEY" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  try {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    // Gather data
    const [tasksRes, profilesRes, pulseRes, cyclesRes] = await Promise.all([
      sb.from("did_therapist_tasks").select("*").gte("created_at", thirtyDaysAgo),
      sb.from("did_motivation_profiles").select("*"),
      sb.from("did_pulse_checks").select("*").gte("created_at", thirtyDaysAgo).order("week_start", { ascending: true }),
      sb.from("did_update_cycles").select("status, cycle_type, completed_at").gte("created_at", thirtyDaysAgo),
    ]);

    const tasks = tasksRes.data || [];
    const profiles = profilesRes.data || [];
    const pulses = pulseRes.data || [];
    const cycles = cyclesRes.data || [];

    // Compute stats
    const totalTasks = tasks.length;
    const doneTasks = tasks.filter((t: any) => t.status === "done").length;
    const completionRate = totalTasks > 0 ? Math.round((doneTasks / totalTasks) * 100) : 0;

    const completedTasks = tasks.filter((t: any) => t.status === "done" && t.completed_at);
    const avgDays = completedTasks.length > 0
      ? Math.round(completedTasks.reduce((sum: number, t: any) => {
          return sum + (new Date(t.completed_at).getTime() - new Date(t.created_at).getTime()) / (24 * 60 * 60 * 1000);
        }, 0) / completedTasks.length)
      : 0;

    const escalatedTasks = tasks.filter((t: any) => (t.escalation_level || 0) >= 2).length;
    const highPriorityDone = tasks.filter((t: any) => t.priority === "high" && t.status === "done").length;
    const highPriorityTotal = tasks.filter((t: any) => t.priority === "high").length;

    const dailyCycles = cycles.filter((c: any) => c.cycle_type === "daily" && c.status === "completed").length;
    const failedCycles = cycles.filter((c: any) => c.status === "failed").length;

    const formatProfile = (p: any) =>
      `${p.therapist}: Splněno ${p.tasks_completed}, nesplněno ${p.tasks_missed}, průměr ${p.avg_completion_days}d, série ${p.streak_current} (max ${p.streak_best}), styl ${p.preferred_style}`;

    const pulseAvgs = pulses.length > 0
      ? `Průměr team_feeling: ${(pulses.reduce((s: number, p: any) => s + p.team_feeling, 0) / pulses.length).toFixed(1)}, priority_clarity: ${(pulses.reduce((s: number, p: any) => s + p.priority_clarity, 0) / pulses.length).toFixed(1)}`
      : "Žádné pulse checky za toto období.";

    const dataContext = `
═══ MĚSÍČNÍ DATA (posledních 30 dní) ═══
Celkem úkolů: ${totalTasks}
Splněno: ${doneTasks} (${completionRate}%)
Průměrná doba splnění: ${avgDays} dní
Eskalované úkoly (level 2+): ${escalatedTasks}
High priority: ${highPriorityDone}/${highPriorityTotal} splněno
Denní cykly: ${dailyCycles} úspěšných, ${failedCycles} selhání

═══ MOTIVAČNÍ PROFILY ═══
${profiles.map(formatProfile).join("\n") || "Žádné profily."}

═══ PULSE CHECKS ═══
${pulseAvgs}
${pulses.filter((p: any) => p.karel_feedback).map((p: any) => `${p.respondent} (${p.week_start}): "${p.karel_feedback}"`).join("\n") || "Žádná zpětná vazba."}

═══ NESPLNĚNÉ ÚKOLY ═══
${tasks.filter((t: any) => t.status !== "done").map((t: any) => `- ${t.task} (pro: ${t.assigned_to}, stáří: ${Math.round((Date.now() - new Date(t.created_at).getTime()) / (24*60*60*1000))}d, eskalace: ${t.escalation_level || 0})`).join("\n") || "Vše splněno!"}
`;

    // Generate retrospective via AI
    const aiRes = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          {
            role: "system",
            content: `Jsi Karel – vedoucí terapeutického týmu pro DID případ. Vygeneruj MĚSÍČNÍ RETROSPEKTIVU v češtině, formát Markdown.

Struktura:
# 📊 Měsíční retrospektiva – Terapeutický tým DID

## Celkové hodnocení
Profesionální shrnutí měsíce (1-3 věty). Analytický tón vedoucího týmu.

## Statistiky
- Tabulka: splněno/nesplněno, průměrná doba, completion rate
- Porovnání Hanka vs Káťa (spravedlivě, profesionálně)

## Co šlo skvěle 🌟
- Konkrétní úspěchy obou terapeutek
- Úspěšné série (streak)

## Co lze zlepšit 📈
- Oblasti kde úkoly stagnují
- Vzorce prokrastinace (pokud existují)
- Konkrétní, splnitelná doporučení
- POZOR: Nikdy nezadávej úkoly zahrnující přímou práci se spícími/dormantními částmi!

## Adaptace Karlova vedení
- Co Karel změní příští měsíc ve vedení týmu
- Jak přizpůsobí koordinaci na základě výsledků

## Doporučení pro příští měsíc
- 3-5 konkrétních, splnitelných kroků

Tón: profesionální, analytický, tón vedoucího klinického týmu. Spravedlivý. Motivující. Konkrétní.
ŽÁDNÝ intimní tón, ŽÁDNÉ "milá", "lásko" – toto je konzilium.
NIKDY nezmiňuj profilaci, monitoring terapeutek ani interní dedukce o jejich osobnostech.
NIKDY nezadávej úkoly typu "pracuj s X" pokud X je dormantní část – to je nesplnitelné!`,
          },
          { role: "user", content: dataContext },
        ],
      }),
    });

    if (!aiRes.ok) {
      throw new Error(`AI request failed: ${aiRes.status}`);
    }

    const aiData = await aiRes.json();
    const retrospective = aiData.choices?.[0]?.message?.content || "Nepodařilo se vygenerovat retrospektivu.";

    return new Response(JSON.stringify({ retrospective, stats: { totalTasks, doneTasks, completionRate, avgDays, escalatedTasks } }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Monthly retrospective error:", error);
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
