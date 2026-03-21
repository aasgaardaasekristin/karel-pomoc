import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Resend } from "npm:resend@2.0.0";
import { corsHeaders } from "../_shared/auth.ts";

/**
 * karel-did-daily-email — Standalone email function for DID daily reports.
 * 
 * ZERO Google Drive dependency. All data comes from DB.
 * Can be triggered by cron independently of karel-did-daily-cycle.
 * 
 * Data sources:
 * - did_threads (24h, all sub_modes)
 * - did_conversations (24h)
 * - karel_hana_conversations (24h)
 * - research_threads (24h)
 * - did_part_registry (current state)
 * - did_therapist_tasks (open + recently completed)
 * - did_meetings (open)
 * - did_update_cycles (latest weekly + monthly report_summary)
 * - client_sessions, crisis_briefs, karel_episodes (24h)
 * - did_pulse_checks (7d)
 * - did_motivation_profiles (adaptive tone)
 * - did_task_feedback (24h)
 */

function getPragueHour(): number {
  const now = new Date();
  const pragueTime = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Prague", hour: "numeric", hour12: false }).format(now);
  return parseInt(pragueTime, 10);
}

function getPragueDate(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Prague" }).format(new Date());
}

function formatThreadSummary(threads: any[], label: string): string {
  if (threads.length === 0) return "";
  const lines = threads.map((t: any) => {
    const msgs = Array.isArray(t.messages) ? t.messages : [];
    const msgCount = msgs.length;
    const lastMsg = msgs[msgCount - 1];
    const preview = lastMsg?.content?.slice(0, 120) || "(prázdné)";
    const subMode = t.sub_mode || "?";
    return `  ▸ [${subMode}] ${t.part_name || t.topic || "?"} (${msgCount} zpráv): ${preview}`;
  }).join("\n");
  return `\n═══ ${label} ═══\n${lines}`;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // Accept both cron (service_role) and manual triggers
  const authHeader = req.headers.get("Authorization") || "";
  const isCron = req.headers.get("user-agent")?.includes("pg_net") ||
    authHeader.includes(Deno.env.get("SUPABASE_ANON_KEY") || "___none___");

  const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
  const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
  const MAMKA_EMAIL = "mujosobniasistentnamiru@gmail.com";
  const KATA_EMAIL = Deno.env.get("KATA_EMAIL") || "K.CC@seznam.cz";

  if (!LOVABLE_API_KEY) {
    return new Response(JSON.stringify({ error: "LOVABLE_API_KEY not configured" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  if (!RESEND_API_KEY) {
    return new Response(JSON.stringify({ error: "RESEND_API_KEY not configured" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const sb = createClient(supabaseUrl, supabaseKey);
  const resend = new Resend(RESEND_API_KEY);

  const reportDatePrague = getPragueDate();
  const dateStr = new Date().toLocaleDateString("cs-CZ");
  const pragueHour = getPragueHour();

  try {
    // ═══ DISPATCH DEDUP: max 1 email per day per recipient ═══
    const reserveSlot = async (recipient: "hanka" | "kata"): Promise<boolean> => {
      const nowIso = new Date().toISOString();
      const { data: existing } = await (sb as any).from("did_daily_report_dispatches")
        .select("id, status, updated_at")
        .eq("report_date", reportDatePrague)
        .eq("recipient", recipient)
        .maybeSingle();

      if (existing?.status === "sent") {
        console.log(`[daily-email] ${recipient} already sent for ${reportDatePrague}, skipping.`);
        return false;
      }

      if (existing) {
        const updatedAt = existing.updated_at ? new Date(existing.updated_at).getTime() : 0;
        const isStalePending = existing.status === "pending" && (Date.now() - updatedAt > 90 * 60 * 1000);
        if (existing.status === "pending" && !isStalePending) return false;

        await (sb as any).from("did_daily_report_dispatches")
          .update({ status: "pending", updated_at: nowIso, error_message: null })
          .eq("id", existing.id);
        return true;
      }

      const { error: insertErr } = await (sb as any).from("did_daily_report_dispatches")
        .insert({ report_date: reportDatePrague, recipient, status: "pending" });
      if (insertErr) {
        if ((insertErr as any).code === "23505") return false;
        console.error(`[daily-email] slot insert failed:`, insertErr.message);
        return false;
      }
      return true;
    };

    const markSent = async (recipient: "hanka" | "kata") => {
      await (sb as any).from("did_daily_report_dispatches")
        .update({ status: "sent", sent_at: new Date().toISOString(), updated_at: new Date().toISOString(), error_message: null })
        .eq("report_date", reportDatePrague).eq("recipient", recipient);
    };

    const markFailed = async (recipient: "hanka" | "kata", err: string) => {
      await (sb as any).from("did_daily_report_dispatches")
        .update({ status: "failed", updated_at: new Date().toISOString(), error_message: err.slice(0, 1000) })
        .eq("report_date", reportDatePrague).eq("recipient", recipient);
    };

    // Check if both already sent
    const hankaReserved = await reserveSlot("hanka");
    const kataReserved = await reserveSlot("kata");
    if (!hankaReserved && !kataReserved) {
      return new Response(JSON.stringify({ success: true, skipped: true, reason: "already_sent_today" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ═══ GATHER ALL DATA FROM DB (0 Drive calls) ═══
    const cutoff24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const [
      threadsRes, convsRes, hanaRes, researchRes,
      registryRes, tasksRes, meetingsRes,
      weeklyRes, monthlyRes,
      sessionsRes, crisisRes, episodesRes,
      pulseRes, profilesRes, feedbackRes,
      sessionPlanRes,
    ] = await Promise.all([
      sb.from("did_threads").select("*").gte("last_activity_at", cutoff24h),
      sb.from("did_conversations").select("*").gte("saved_at", cutoff24h),
      sb.from("karel_hana_conversations").select("*").gte("last_activity_at", cutoff24h),
      sb.from("research_threads").select("*").eq("is_deleted", false).gte("last_activity_at", cutoff24h),
      sb.from("did_part_registry").select("*"),
      sb.from("did_therapist_tasks").select("*").neq("status", "done").order("created_at", { ascending: true }),
      sb.from("did_meetings").select("*").neq("status", "closed"),
      sb.from("did_update_cycles").select("report_summary, completed_at, cycle_type").eq("cycle_type", "weekly").eq("status", "completed").order("completed_at", { ascending: false }).limit(1),
      sb.from("did_update_cycles").select("report_summary, completed_at, cycle_type").eq("cycle_type", "monthly").eq("status", "completed").order("completed_at", { ascending: false }).limit(1),
      sb.from("client_sessions").select("id, client_id, session_date, notes, ai_analysis, report_key_theme, report_risks").gte("updated_at", cutoff24h),
      sb.from("crisis_briefs").select("id, scenario, risk_score, risk_overview, recommended_contact, next_steps, created_at").gte("created_at", cutoff24h),
      sb.from("karel_episodes").select("id, domain, summary_karel, tags, participants, emotional_intensity, hana_state, actions_taken, outcome, timestamp_start").gte("timestamp_start", cutoff24h),
      sb.from("did_pulse_checks").select("respondent, team_feeling, priority_clarity, karel_feedback, week_start, created_at").gte("created_at", weekAgo),
      sb.from("did_motivation_profiles").select("*"),
      sb.from("did_task_feedback").select("*").gte("created_at", cutoff24h),
      (sb as any).from("did_daily_session_plans").select("selected_part, urgency_score, urgency_breakdown, plan_markdown, therapist").eq("plan_date", reportDatePrague).maybeSingle(),
    ]);

    const threads = threadsRes.data || [];
    const conversations = convsRes.data || [];
    const hanaConvs = hanaRes.data || [];
    const researchThreads = researchRes.data || [];
    const registry = registryRes.data || [];
    const tasks = tasksRes.data || [];
    const meetings = meetingsRes.data || [];
    const weeklySummary = weeklyRes.data?.[0]?.report_summary || "";
    const monthlySummary = monthlyRes.data?.[0]?.report_summary || "";
    const clientSessions = sessionsRes.data || [];
    const crisisBriefs = crisisRes.data || [];
    const episodes = episodesRes.data || [];
    const pulseChecks = pulseRes.data || [];
    const profiles = profilesRes.data || [];
    const taskFeedback = feedbackRes.data || [];

    console.log(`[daily-email] Data: ${threads.length} threads, ${conversations.length} convs, ${hanaConvs.length} hana, ${researchThreads.length} research, ${registry.length} registry, ${tasks.length} tasks, ${meetings.length} meetings, ${episodes.length} episodes`);

    // ═══ SPLIT THREADS: yesterday afternoon/evening vs today ═══
    const now = new Date();
    const pragueFormatter = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Prague", year: "numeric", month: "2-digit", day: "2-digit" });
    const todayPrague = pragueFormatter.format(now);

    const yesterdayThreads = threads.filter((t: any) => {
      const d = pragueFormatter.format(new Date(t.last_activity_at));
      return d < todayPrague;
    });
    const todayThreads = threads.filter((t: any) => {
      const d = pragueFormatter.format(new Date(t.last_activity_at));
      return d >= todayPrague;
    });

    // ═══ BUILD COMPREHENSIVE DATA BLOCK ═══
    let dataBlock = `DATUM: ${dateStr} (${pragueHour}:00 SEČ)\n`;
    dataBlock += `\n═══ REGISTR ČÁSTÍ (${registry.length}) ═══\n`;
    dataBlock += registry.map((r: any) => `  ${r.display_name || r.part_name} | status: ${r.status} | naposledy: ${r.last_seen_at || "?"} | emoce: ${r.last_emotional_state || "?"}`).join("\n");

    dataBlock += formatThreadSummary(yesterdayThreads, `VLÁKNA – VČERA ODPOLEDNE/VEČER (${yesterdayThreads.length})`);
    dataBlock += formatThreadSummary(todayThreads, `VLÁKNA – DNES (${todayThreads.length})`);

    if (conversations.length > 0) {
      dataBlock += `\n\n═══ DID KONVERZACE (${conversations.length}) ═══\n`;
      dataBlock += conversations.map((c: any) => `  ▸ [${c.sub_mode}] ${c.label}: ${c.preview?.slice(0, 100) || ""}`).join("\n");
    }

    if (hanaConvs.length > 0) {
      dataBlock += `\n\n═══ HANA KONVERZACE (${hanaConvs.length}) ═══\n`;
      for (const h of hanaConvs) {
        const msgs = Array.isArray(h.messages) ? h.messages : [];
        const lastMsgs = msgs.slice(-3);
        dataBlock += `  ▸ Stav: ${h.current_hana_state}, Doména: ${h.current_domain}\n`;
        for (const m of lastMsgs) {
          dataBlock += `    [${m.role}]: ${(m.content || "").slice(0, 100)}\n`;
        }
      }
    }

    if (researchThreads.length > 0) {
      dataBlock += `\n\n═══ VÝZKUM (${researchThreads.length}) ═══\n`;
      dataBlock += researchThreads.map((r: any) => `  ▸ ${r.topic}`).join("\n");
    }

    if (clientSessions.length > 0) {
      dataBlock += `\n\n═══ KLIENTSKÉ SEZENÍ (${clientSessions.length}) ═══\n`;
      dataBlock += clientSessions.map((s: any) => `  ▸ ${s.session_date}: ${s.report_key_theme || s.notes?.slice(0, 80) || "?"}`).join("\n");
    }

    if (crisisBriefs.length > 0) {
      dataBlock += `\n\n⚠️ ═══ KRIZOVÉ BRIEFY (${crisisBriefs.length}) ═══\n`;
      dataBlock += crisisBriefs.map((b: any) => `  ▸ Scénář: ${b.scenario}, Riziko: ${b.risk_score}/10, ${b.risk_overview?.slice(0, 100)}`).join("\n");
    }

    if (episodes.length > 0) {
      dataBlock += `\n\n═══ EPIZODY (${episodes.length}) ═══\n`;
      dataBlock += episodes.map((e: any) => `  ▸ [${e.domain}] ${e.summary_karel?.slice(0, 100) || e.summary_user?.slice(0, 100) || "?"}`).join("\n");
    }

    // Tasks
    dataBlock += `\n\n═══ OTEVŘENÉ ÚKOLY (${tasks.length}) ═══\n`;
    dataBlock += tasks.map((t: any) => {
      const age = Math.floor((Date.now() - new Date(t.created_at).getTime()) / (1000 * 60 * 60 * 24));
      return `  ${age >= 3 ? "⚠️" : "▸"} [${age}d] ${t.task} | pro: ${t.assigned_to} | Hanka: ${t.status_hanka} | Káťa: ${t.status_kata} | priorita: ${t.priority}`;
    }).join("\n");

    if (taskFeedback.length > 0) {
      dataBlock += `\n\n═══ FEEDBACK K ÚKOLŮM (${taskFeedback.length}) ═══\n`;
      dataBlock += taskFeedback.map((f: any) => `  ▸ [${f.author}]: ${f.message?.slice(0, 100)}`).join("\n");
    }

    if (meetings.length > 0) {
      dataBlock += `\n\n═══ OTEVŘENÉ PORADY (${meetings.length}) ═══\n`;
      dataBlock += meetings.map((m: any) => `  ▸ ${m.topic} (status: ${m.status})`).join("\n");
    }

    if (pulseChecks.length > 0) {
      dataBlock += `\n\n═══ PULSE CHECKS (7d: ${pulseChecks.length}) ═══\n`;
      dataBlock += pulseChecks.map((p: any) => `  ▸ ${p.respondent}: tým=${p.team_feeling}/5, jasnost=${p.priority_clarity}/5`).join("\n");
    }

    // Weekly/Monthly context
    if (weeklySummary) {
      dataBlock += `\n\n═══ POSLEDNÍ TÝDENNÍ ANALÝZA ═══\n${weeklySummary.slice(0, 3000)}`;
    }
    if (monthlySummary) {
      dataBlock += `\n\n═══ POSLEDNÍ MĚSÍČNÍ ANALÝZA ═══\n${monthlySummary.slice(0, 3000)}`;
    }

    // Motivation profiles
    const formatProfile = (p: any) => {
      if (!p) return "Žádný profil zatím.";
      return `Splněno: ${p.tasks_completed}, Nesplněno: ${p.tasks_missed}, Průměr: ${p.avg_completion_days} dní, Série: ${p.streak_current}/${p.streak_best}, Styl: ${p.preferred_style}`;
    };
    const hankaProfile = profiles.find((p: any) => p.therapist === "Hanka");
    const kataProfile = profiles.find((p: any) => p.therapist === "Káťa");

    // ═══ GENERATE PERSONALIZED EMAILS VIA AI ═══
    const generateEmail = async (recipient: "hanka" | "kata"): Promise<string> => {
      const isHanka = recipient === "hanka";
      const profile = isHanka ? hankaProfile : kataProfile;

      const systemPrompt = isHanka
        ? `Jsi Karel – vedoucí terapeutického týmu pro DID případ. Vygeneruj profesionální DENNÍ BRIEFING pro Hanku.
Formát HTML emailu. Struktura:

<h2>Denní briefing – DID terapeutický tým</h2>
<p>Datum: ${dateStr} | Vedoucí: Karel</p>

<h3>PŘEHLED – VČEREJŠÍ ODPOLEDNE/VEČER:</h3>
Rozliš jasně aktivity od včerejšího odpoledne/večera.

<h3>PŘEHLED – DNES:</h3>
Aktivity z dnešního dne.

Pro každou AKTIVNÍ část (PŘÍMÁ komunikace v cast režimu):
▸ Jméno části - Stav, co bylo zaznamenáno, doporučení
POZOR: Pokud se o části pouze HOVOŘILO v terapeutickém rozhovoru, JASNĚ to rozliš!

<h3>AKTUALIZACE – CROSS-MODE AUDIT:</h3>
Přehled aktivit napříč VŠEMI režimy (Hana, výzkum, krizové briefy, klientské sezení).

<h3>⚠️ UPOZORNĚNÍ:</h3> (jen pokud existují rizika)

<h3>📞 KOORDINACE S KÁŤOU:</h3>
Co je potřeba probrat s Káťou

<h3>📋 OPERATIVNÍ PLÁN – KLÍČOVÉ BODY:</h3>
▸ Krátkodobé cíle a aktivní úkoly
▸ NIKDY nezadávej úkoly pro dormantní/spící části!

<h3>📋 HODNOCENÍ SPOLUPRÁCE A PROCESU ÚKOLŮ:</h3>
▸ Úroveň spolupráce, kde to vázne, co jde dobře
▸ Přímé otázky ohledně konkrétních zaseklých úkolů

${weeklySummary ? "<h3>📊 STŘEDNĚDOBÝ KONTEXT (z týdenní analýzy):</h3>\nKlíčové body z poslední týdenní analýzy relevantní pro dnešek." : ""}

Podpis: "Karel – vedoucí DID terapeutického týmu"

Tón: profesionální, věcný, analytický. ŽÁDNÉ "milá Haničko", "lásko".
ADAPTIVNÍ STYL na základě motivačního profilu.
NIKDY nezmiňuj profilaci ani monitoring terapeutek.

PRAVIDLA SOUKROMÍ (KRITICKÉ):
- NIKDY necituj doslovně výroky z konverzací
- Místo citátů piš OPERATIVNÍ INSTRUKCE
- E-mail je OPERATIVNÍ DOKUMENT, ne přepis konverzace`
        : `Jsi Karel – vedoucí terapeutického týmu. Vygeneruj denní briefing pro Káťu. Profesionální tón.
Formát HTML emailu. Struktura:

<h2>Denní briefing pro Káťu</h2>
<p>Datum: ${dateStr} | Vedoucí: Karel</p>

<h3>PŘEHLED – VČEREJŠÍ ODPOLEDNE/VEČER:</h3>
Relevantní aktivity od včera.

<h3>PŘEHLED – DNES:</h3>
Dnešní aktivity relevantní pro Kátinu roli.

<h3>⚠️ UPOZORNĚNÍ:</h3> (jen kritická)

<h3>📞 KOORDINACE S HANKOU:</h3>

<h3>📋 ÚKOLY PRO KÁŤU:</h3>
▸ Konkrétní, splnitelné úkoly
NIKDY nezadávej úkoly pro dormantní/spící části!

<h3>📋 HODNOCENÍ SPOLUPRÁCE:</h3>
▸ Úroveň spolupráce, kde to vázne, co jde dobře
▸ Co Káťa splnila, co zbývá

Podpis: "Karel"

Tón: profesionální, věcný. Nesdílej Hančiny osobní informace.
NIKDY nezmiňuj profilaci.

PRAVIDLA SOUKROMÍ (KRITICKÉ):
- NIKDY necituj doslovně výroky z konverzací
- Místo citátů piš OPERATIVNÍ INSTRUKCE`;

      const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "google/gemini-2.5-flash",
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: `Dnešní data:\n${dataBlock}\n\n═══ MOTIVAČNÍ PROFIL ${isHanka ? "HANKY" : "KÁTI"} ═══\n${formatProfile(profile)}` },
          ],
        }),
      });

      if (response.ok) {
        const d = await response.json();
        const html = (d.choices?.[0]?.message?.content || "").replace(/^```html?\n?/i, "").replace(/\n?```$/i, "");
        if (html) return html;
      }

      // Fallback: plain text
      return `<pre style="font-family: sans-serif; white-space: pre-wrap;">${dataBlock}</pre>`;
    };

    // ═══ SEND EMAILS ═══
    let hankaResult = "skipped";
    let kataResult = "skipped";

    if (hankaReserved) {
      try {
        const hankaHtml = await generateEmail("hanka");
        await resend.emails.send({
          from: "Karel <karel@hana-chlebcova.cz>",
          to: [MAMKA_EMAIL],
          subject: `Karel – denní report ${dateStr}`,
          html: hankaHtml,
        });
        await markSent("hanka");
        hankaResult = "sent";
        console.log(`[daily-email] ✅ Sent to Hanka: ${MAMKA_EMAIL}`);
      } catch (e: any) {
        console.error("[daily-email] Hanka email error:", e);
        await markFailed("hanka", e?.message || String(e));
        hankaResult = "failed";
      }
    }

    if (kataReserved) {
      try {
        const kataHtml = await generateEmail("kata");
        await resend.emails.send({
          from: "Karel <karel@hana-chlebcova.cz>",
          to: [KATA_EMAIL],
          subject: `Karel – report pro Káťu ${dateStr}`,
          html: kataHtml,
        });
        await markSent("kata");
        kataResult = "sent";
        console.log(`[daily-email] ✅ Sent to Káťa: ${KATA_EMAIL}`);
      } catch (e: any) {
        console.error("[daily-email] Káťa email error:", e);
        await markFailed("kata", e?.message || String(e));
        kataResult = "failed";
      }
    }

    return new Response(JSON.stringify({
      success: true,
      hanka: hankaResult,
      kata: kataResult,
      dataStats: {
        threads: threads.length,
        conversations: conversations.length,
        hanaConversations: hanaConvs.length,
        researchThreads: researchThreads.length,
        episodes: episodes.length,
        crisisBriefs: crisisBriefs.length,
        tasks: tasks.length,
      },
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (error: any) {
    console.error("[daily-email] Fatal error:", error);
    return new Response(JSON.stringify({ error: error?.message || "Unknown error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
