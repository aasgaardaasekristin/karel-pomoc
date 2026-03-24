import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Resend } from "npm:resend@2.0.0";
import { corsHeaders } from "../_shared/auth.ts";

/**
 * karel-did-daily-email — Standalone email function for DID daily reports.
 * 
 * PRIMARY data source: did_daily_context.analysis_json (from karel-did-daily-analyzer)
 * SECONDARY data source: raw DB tables (threads, tasks, etc.) as supplementary context
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

// ═══ FORMAT analysis_json INTO STRUCTURED TEXT BLOCKS ═══

function formatAnalysisTherapist(analysis: any, name: string): string {
  const t = analysis?.therapists?.[name];
  if (!t) return `  (data nedostupná)`;
  const sit = t.situational || {};
  const lt = t.long_term || {};
  return [
    `  Energie: ${sit.energy || "?"}`,
    sit.health ? `  Zdraví: ${sit.health}` : null,
    sit.current_stressors?.length ? `  Stresory: ${sit.current_stressors.join(", ")}` : null,
    sit.notes ? `  Poznámky: ${sit.notes}` : null,
    lt.reliability ? `  Spolehlivost: ${lt.reliability}` : null,
    lt.style ? `  Styl: ${lt.style}` : null,
  ].filter(Boolean).join("\n");
}

function formatAnalysisParts(analysis: any): string {
  const parts = analysis?.parts;
  if (!Array.isArray(parts) || parts.length === 0) return "(žádné části v analýze)";

  const active = parts.filter((p: any) => p.status === "active");
  const sleeping = parts.filter((p: any) => p.status === "sleeping");

  let out = "";
  if (active.length > 0) {
    out += `AKTIVNÍ ČÁSTI (${active.length}):\n`;
    out += active.map((p: any) => {
      const rec = p.session_recommendation;
      const recStr = rec?.needed ? ` → DOPORUČENÉ SEZENÍ: ${rec.who_leads}, priorita: ${rec.priority}, cíle: ${(rec.goals || []).join(", ")}` : "";
      return `  ▸ ${p.name} | riziko: ${p.risk_level} | emoce: ${p.recent_emotions || "?"} | potřeby: ${(p.needs || []).join(", ")}${recStr}`;
    }).join("\n");
  }
  if (sleeping.length > 0) {
    out += `\nSPÍCÍ ČÁSTI (${sleeping.length}):\n`;
    out += sleeping.map((p: any) => `  ▸ ${p.name} (spí)`).join("\n");
  }
  return out;
}

function formatAnalysisTeam(analysis: any): string {
  const team = analysis?.team_observations;
  if (!team) return "";
  let out = "";
  if (team.cooperation) out += `  Spolupráce: ${team.cooperation}\n`;
  if (team.warnings?.length) out += `  ⚠️ Varování: ${team.warnings.join("; ")}\n`;
  if (team.praise?.length) out += `  ✅ Pochvaly: ${team.praise.join("; ")}\n`;
  return out;
}

function formatSessionRecommendations(analysis: any): string {
  const parts = analysis?.parts;
  if (!Array.isArray(parts)) return "(žádná doporučení)";
  const recommended = parts.filter((p: any) => p.session_recommendation?.needed === true);
  if (recommended.length === 0) return "(žádná doporučená sezení)";
  return recommended.map((p: any) => {
    const rec = p.session_recommendation;
    return `  ▸ ${p.name}: vede ${rec.who_leads}, priorita: ${rec.priority}, cíle: ${(rec.goals || []).join(", ")}`;
  }).join("\n");
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

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
    // ═══ DISPATCH DEDUP ═══
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

    const hankaReserved = await reserveSlot("hanka");
    const kataReserved = await reserveSlot("kata");
    if (!hankaReserved && !kataReserved) {
      return new Response(JSON.stringify({ success: true, skipped: true, reason: "already_sent_today" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ═══ LOAD analysis_json AS PRIMARY SOURCE ═══
    const { data: dailyCtx } = await (sb as any).from("did_daily_context")
      .select("context_json, analysis_json, context_date")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const analysis = dailyCtx?.analysis_json || null;
    const contextJson = dailyCtx?.context_json || null;
    const hasAnalysis = !!analysis;
    console.log(`[daily-email] analysis_json available: ${hasAnalysis}, date: ${dailyCtx?.context_date || "none"}`);

    // ═══ GATHER SUPPLEMENTARY DATA FROM DB ═══
    const cutoff24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const [
      threadsRes, convsRes, hanaRes,
      tasksRes, meetingsRes,
      weeklyRes,
      sessionsRes, crisisRes,
      profilesRes, feedbackRes,
      sessionPlanRes,
    ] = await Promise.all([
      sb.from("did_threads").select("*").gte("last_activity_at", cutoff24h),
      sb.from("did_conversations").select("*").gte("saved_at", cutoff24h),
      sb.from("karel_hana_conversations").select("*").gte("last_activity_at", cutoff24h),
      sb.from("did_therapist_tasks").select("*").neq("status", "done").order("created_at", { ascending: true }),
      sb.from("did_meetings").select("*").neq("status", "closed"),
      sb.from("did_update_cycles").select("report_summary, completed_at, cycle_type").eq("cycle_type", "weekly").eq("status", "completed").order("completed_at", { ascending: false }).limit(1),
      sb.from("client_sessions").select("id, client_id, session_date, notes, ai_analysis, report_key_theme, report_risks").gte("updated_at", cutoff24h),
      sb.from("crisis_briefs").select("id, scenario, risk_score, risk_overview, recommended_contact, next_steps, created_at").gte("created_at", cutoff24h),
      sb.from("did_motivation_profiles").select("*"),
      sb.from("did_task_feedback").select("*").gte("created_at", cutoff24h),
      (sb as any).from("did_daily_session_plans").select("selected_part, urgency_score, urgency_breakdown, plan_markdown, therapist").eq("plan_date", reportDatePrague).maybeSingle(),
    ]);

    const threads = threadsRes.data || [];
    const conversations = convsRes.data || [];
    const hanaConvs = hanaRes.data || [];
    const tasks = tasksRes.data || [];
    const meetings = meetingsRes.data || [];
    const weeklySummary = weeklyRes.data?.[0]?.report_summary || "";
    const clientSessions = sessionsRes.data || [];
    const crisisBriefs = crisisRes.data || [];
    const profiles = profilesRes.data || [];
    const taskFeedback = feedbackRes.data || [];
    const todaySessionPlan = sessionPlanRes.data || null;

    console.log(`[daily-email] Supplementary: ${threads.length} threads, ${tasks.length} tasks, analysis: ${hasAnalysis}`);

    // ═══ SPLIT THREADS ═══
    const now = new Date();
    const pragueFormatter = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Prague", year: "numeric", month: "2-digit", day: "2-digit" });
    const todayPrague = pragueFormatter.format(now);

    const yesterdayThreads = threads.filter((t: any) => pragueFormatter.format(new Date(t.last_activity_at)) < todayPrague);
    const todayThreads = threads.filter((t: any) => pragueFormatter.format(new Date(t.last_activity_at)) >= todayPrague);

    // ═══ BUILD SUPPLEMENTARY DATA BLOCK (secondary context) ═══
    let suppBlock = "";
    suppBlock += formatThreadSummary(yesterdayThreads, `VLÁKNA – VČERA (${yesterdayThreads.length})`);
    suppBlock += formatThreadSummary(todayThreads, `VLÁKNA – DNES (${todayThreads.length})`);

    if (conversations.length > 0) {
      suppBlock += `\n\n═══ DID KONVERZACE (${conversations.length}) ═══\n`;
      suppBlock += conversations.map((c: any) => `  ▸ [${c.sub_mode}] ${c.label}: ${c.preview?.slice(0, 100) || ""}`).join("\n");
    }

    if (hanaConvs.length > 0) {
      suppBlock += `\n\n═══ HANA KONVERZACE (${hanaConvs.length}) ═══\n`;
      for (const h of hanaConvs) {
        const msgs = Array.isArray(h.messages) ? h.messages : [];
        const lastMsgs = msgs.slice(-3);
        suppBlock += `  ▸ Stav: ${h.current_hana_state}, Doména: ${h.current_domain}\n`;
        for (const m of lastMsgs) {
          suppBlock += `    [${m.role}]: ${(m.content || "").slice(0, 100)}\n`;
        }
      }
    }

    if (clientSessions.length > 0) {
      suppBlock += `\n\n═══ KLIENTSKÉ SEZENÍ (${clientSessions.length}) ═══\n`;
      suppBlock += clientSessions.map((s: any) => `  ▸ ${s.session_date}: ${s.report_key_theme || s.notes?.slice(0, 80) || "?"}`).join("\n");
    }

    if (crisisBriefs.length > 0) {
      suppBlock += `\n\n⚠️ ═══ KRIZOVÉ BRIEFY (${crisisBriefs.length}) ═══\n`;
      suppBlock += crisisBriefs.map((b: any) => `  ▸ Scénář: ${b.scenario}, Riziko: ${b.risk_score}/10, ${b.risk_overview?.slice(0, 100)}`).join("\n");
    }

    // Tasks
    suppBlock += `\n\n═══ OTEVŘENÉ ÚKOLY (${tasks.length}) ═══\n`;
    suppBlock += tasks.map((t: any) => {
      const age = Math.floor((Date.now() - new Date(t.created_at).getTime()) / (1000 * 60 * 60 * 24));
      return `  ${age >= 3 ? "⚠️" : "▸"} [${age}d] ${t.task} | pro: ${t.assigned_to} | Hanka: ${t.status_hanka} | Káťa: ${t.status_kata} | priorita: ${t.priority}`;
    }).join("\n");

    if (taskFeedback.length > 0) {
      suppBlock += `\n\n═══ FEEDBACK K ÚKOLŮM (${taskFeedback.length}) ═══\n`;
      suppBlock += taskFeedback.map((f: any) => `  ▸ [${f.author}]: ${f.message?.slice(0, 100)}`).join("\n");
    }

    if (meetings.length > 0) {
      suppBlock += `\n\n═══ OTEVŘENÉ PORADY (${meetings.length}) ═══\n`;
      suppBlock += meetings.map((m: any) => `  ▸ ${m.topic} (status: ${m.status})`).join("\n");
    }

    if (todaySessionPlan) {
      const bp = todaySessionPlan.urgency_breakdown || {};
      const bpStr = Object.entries(bp).map(([k, v]) => `${k}(+${v})`).join(", ");
      suppBlock += `\n\n🎯 ═══ AUTOMATICKÝ PLÁN SEZENÍ ═══\n`;
      suppBlock += `Vybraná část: ${todaySessionPlan.selected_part} | Naléhavost: ${todaySessionPlan.urgency_score} | Důvody: ${bpStr}\n`;
      suppBlock += `\n${(todaySessionPlan.plan_markdown || "").slice(0, 4000)}`;
    }

    // Motivation profiles
    const formatProfile = (p: any) => {
      if (!p) return "Žádný profil zatím.";
      return `Splněno: ${p.tasks_completed}, Nesplněno: ${p.tasks_missed}, Průměr: ${p.avg_completion_days} dní, Série: ${p.streak_current}/${p.streak_best}, Styl: ${p.preferred_style}`;
    };
    const hankaProfile = profiles.find((p: any) => p.therapist === "Hanka");
    const kataProfile = profiles.find((p: any) => p.therapist === "Káťa");

    // ═══ BUILD PRIMARY ANALYSIS BLOCK ═══
    let analysisBlock = "";
    if (hasAnalysis) {
      analysisBlock = `═══ DENNÍ ANALÝZA (PRIMÁRNÍ ZDROJ – analysis_json z ${dailyCtx.context_date}) ═══

═══ STAV TERAPEUTEK ═══
HANKA:
${formatAnalysisTherapist(analysis, "Hanka")}
KÁŤA:
${formatAnalysisTherapist(analysis, "Kata")}

═══ ČÁSTI DID SYSTÉMU ═══
${formatAnalysisParts(analysis)}

═══ DOPORUČENÁ SEZENÍ ═══
${formatSessionRecommendations(analysis)}

═══ POZOROVÁNÍ TÝMU ═══
${formatAnalysisTeam(analysis)}`;
    }

    // ═══ GENERATE PERSONALIZED EMAILS VIA AI ═══
    const generateEmail = async (recipient: "hanka" | "kata"): Promise<string> => {
      const isHanka = recipient === "hanka";
      const profile = isHanka ? hankaProfile : kataProfile;

      // CRITICAL RULES injected into EVERY system prompt
      const analysisRules = hasAnalysis ? `
KRITICKÁ PRAVIDLA PRO PRÁCI S DATY:

═══ ROZDÍL ROLE TERAPEUTEK ═══
- Hanka a Káťa NEJSOU části DID systému. Piš o nich POUZE jako o terapeutkách / členech týmu.
- Nepopisuj jejich emoční stav ve formátu karet částí (žádné "EMO_*").
- NEZVEŘEJŇUJ jejich intimní osobní procesy (vina, sedmikrásky, soukromá terapie) –
  tyto informace patří jen do PAMET_KAREL, ne do mailu.

═══ AKTIVNÍ VS. SPÍCÍ ČÁSTI ═══
- Část je "aktivní" POUZE tehdy, pokud:
  a) má v analysis_json.parts.status = "active" A
  b) v posledních 24 hodinách s Karlem PŘÍMO komunikovala (sub_mode=cast).
- Pokud se o části pouze mluvilo (Hanka ji zmínila, pracovalo se s kartou),
  NEPIŠ, že je aktivní a NENAVRHUJ s ní sezení. Je stále "spící" část.
- NIKDY nenavrhuj sezení se spící částí, pokud nemá session_recommendation.needed = true.

═══ PRIORITY ═══
- Zaměř se NAPŘED na:
  - části s risk_level = "high" nebo "medium",
  - části, které přestaly komunikovat,
  - části s rozladěním, strachem, nočními děsy nebo konfliktem,
  - úkoly dlouho "not_started" klíčové pro stabilitu systému.

═══ FORMÁT – MAX 3–5 NEJDŮLEŽITĚJŠÍCH TÉMAT ═══
Pro KAŽDÉ vybrané téma napiš:
1. "CO SE STALO" – 1–2 věty, fakticky.
2. "CO Z TOHO VYPLÝVÁ" – 1 věta (riziko / příležitost).
3. "DOPORUČENÍ NA DNES" – 1–3 konkrétní kroky pro Hanku a/nebo Káťu.
Neopisuj celou historii, nevyjmenovávej VŠECHNY části. Soustřeď se na to, co je DNES nejdůležitější.

═══ ÚKOLY ═══
- NEVytvářej duplikátní úkoly se stejným obsahem. Pokud úkol již existuje, jen ho připomeň.
- Nedávej terapeutkám úkoly "zapsat X do karty" – Karel si tyto věci zapisuje sám.

═══ SOUKROMÉ VS. TÝMOVÉ ═══
- Informace z osobních vláken Hany ("Hana/osobní") používej JEN jako kontext pro rozhodování – NEPIŠ je do mailu.
- V mailu buď POUZE: vedoucí týmu, koordinátor, odborný supervizor.
- Partnerství s Haničkou a její soukromá témata do mailu NEPATŘÍ.
- NIKDY necituj doslovně výroky z konverzací – místo citátů piš OPERATIVNÍ INSTRUKCE.
` : "";

      const systemPrompt = isHanka
        ? `Jsi Karel – vedoucí terapeutického týmu pro DID případ. Vygeneruj profesionální DENNÍ BRIEFING pro Hanku.
${analysisRules}
Formát HTML emailu. Struktura:

<h2>Denní briefing – DID terapeutický tým</h2>
<p>Datum: ${dateStr} | Vedoucí: Karel</p>

<h3>🔴 NEJDŮLEŽITĚJŠÍ TÉMATA DNES (max 3–5):</h3>
Pro každé téma použij strukturu:
<h4>[Název tématu]</h4>
<p><strong>Co se stalo:</strong> ...</p>
<p><strong>Co z toho vyplývá:</strong> ...</p>
<p><strong>Doporučení na dnes:</strong> ...</p>

<h3>STAV TÝMU:</h3>
Krátké shrnutí situačního stavu Hanky a Káti z DENNÍ ANALÝZY (energie, stresory, zdraví).
BEZ intimních osobních detailů – jen pracovně relevantní kontext.

<h3>📞 KOORDINACE S KÁŤOU:</h3>
Co je potřeba probrat s Káťou.

<h3>📋 OTEVŘENÉ ÚKOLY:</h3>
▸ Pouze EXISTUJÍCÍ úkoly – neduplikuj!
▸ U dlouho nesplněných vysvětli, proč jsou dnes důležité.
▸ NIKDY nezadávej úkoly pro spící části!

${todaySessionPlan ? `<h3>🎯 PLÁN SEZENÍ NA DNES:</h3>
Shrň klíčové body plánu sezení.` : ""}

${weeklySummary ? "<h3>📊 STŘEDNĚDOBÝ KONTEXT:</h3>\nKlíčové body z týdenní analýzy." : ""}

Podpis: "Karel – vedoucí DID terapeutického týmu"

Tón: profesionální, věcný, analytický. ŽÁDNÉ "milá Haničko", "lásko".
ADAPTIVNÍ STYL na základě motivačního profilu.
NIKDY nezmiňuj profilaci ani monitoring terapeutek.`
        : `Jsi Karel – vedoucí terapeutického týmu. Vygeneruj denní briefing pro Káťu. Profesionální tón.
${analysisRules}
Formát HTML emailu. Struktura:

<h2>Denní briefing pro Káťu</h2>
<p>Datum: ${dateStr} | Vedoucí: Karel</p>

<h3>🔴 NEJDŮLEŽITĚJŠÍ TÉMATA DNES (max 3–5):</h3>
Pro každé téma použij strukturu:
<h4>[Název tématu]</h4>
<p><strong>Co se stalo:</strong> ...</p>
<p><strong>Co z toho vyplývá:</strong> ...</p>
<p><strong>Doporučení na dnes:</strong> ...</p>

<h3>STAV TÝMU:</h3>
Krátké shrnutí – BEZ Hančiných osobních informací.

<h3>📞 KOORDINACE S HANKOU:</h3>

<h3>📋 ÚKOLY PRO KÁŤU:</h3>
▸ Konkrétní, splnitelné úkoly – neduplikuj existující!
NIKDY nezadávej úkoly pro spící části!

${todaySessionPlan ? `<h3>🎯 PLÁN SEZENÍ NA DNES:</h3>
Shrň klíčové body. Pokud je úkol pro Káťu, zdůrazni formát A/B.` : ""}

Podpis: "Karel"

Tón: profesionální, věcný. Nesdílej Hančiny osobní informace.
NIKDY nezmiňuj profilaci.`;
      // ═══ FILTER: only parts that are truly active + recommended ═══
      const BANNED_PART_NAMES = new Set([
        "LOCIK","LOCÍK","BENDIK_BONDEVIK","BENDIK","CLARK","KLARK",
        "ADAM","EINAR","BELO","BÉLO","GERHARDT",
      ]);

      const partsForEmail = hasAnalysis
        ? (analysis.parts || []).filter((p: any) =>
            p.status === "active" &&
            p.session_recommendation?.needed === true &&
            !BANNED_PART_NAMES.has((p.name || "").toUpperCase().replace(/\s+/g, "_").trim())
          )
        : [];

      console.log(`[daily-email] partsForEmail: ${partsForEmail.length} (from ${(analysis?.parts || []).length} total)`);

      // USER prompt: analysis first, supplementary second
      let userContent = `DATUM: ${dateStr} (${pragueHour}:00 SEČ)\n\n`;

      if (hasAnalysis) {
        // Include full analysis for context but mark which parts are eligible for sessions
        userContent += `═══ PRIMÁRNÍ ZDROJ: DENNÍ ANALÝZA ═══\n${analysisBlock}\n\n`;
        userContent += `═══ ČÁSTI ZPŮSOBILÉ PRO DOPORUČENÍ SEZENÍ (partsForEmail) ═══\n`;
        if (partsForEmail.length > 0) {
          userContent += partsForEmail.map((p: any) => {
            const rec = p.session_recommendation;
            return `  ▸ ${p.name} | riziko: ${p.risk_level} | emoce: ${p.recent_emotions || "?"} | vede: ${rec?.who_leads} | priorita: ${rec?.priority} | cíle: ${(rec?.goals || []).join(", ")}`;
          }).join("\n");
        } else {
          userContent += `  (ŽÁDNÉ – nenavrhuj žádná sezení s částmi)`;
        }
        userContent += `\n\nV tomto e-mailu pracuj POUZE s částmi ze seznamu partsForEmail výše.\nNepracuj s jinými jmény (např. Locik, Bendik, Clark) ani když se objeví v doplňkových textech.\nPokud je seznam partsForEmail prázdný, NEPIŠ žádná doporučení sezení s částmi.\n\n`;
      }

      userContent += `═══ DOPLŇUJÍCÍ KONTEXT (syrová data) ═══\n${suppBlock}\n\n`;

      if (weeklySummary) {
        userContent += `═══ POSLEDNÍ TÝDENNÍ ANALÝZA ═══\n${weeklySummary.slice(0, 2000)}\n\n`;
      }

      userContent += `═══ MOTIVAČNÍ PROFIL ${isHanka ? "HANKY" : "KÁTI"} ═══\n${formatProfile(profile)}`;

      const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "google/gemini-2.5-flash",
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userContent },
          ],
        }),
      });

      if (response.ok) {
        const d = await response.json();
        const html = (d.choices?.[0]?.message?.content || "").replace(/^```html?\n?/i, "").replace(/\n?```$/i, "");
        if (html) {
          console.log(`[daily-email] Generated HTML (first 3000ch): ${html.slice(0, 3000)}`);
          return html;
        }
      }

      return `<pre style="font-family: sans-serif; white-space: pre-wrap;">${analysisBlock || suppBlock}</pre>`;
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
      analysisAvailable: hasAnalysis,
      analysisDate: dailyCtx?.context_date || null,
      dataStats: {
        threads: threads.length,
        conversations: conversations.length,
        hanaConversations: hanaConvs.length,
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
