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

  // Parse force parameter for manual resend bypass
  let forceResend = false;
  try {
    const body = await req.clone().json();
    forceResend = body?.force === true;
  } catch { /* no body or not JSON */ }

  console.log(`[daily-email] START | date=${reportDatePrague} | hour=${pragueHour} | force=${forceResend} | hanka=${MAMKA_EMAIL} | kata=${KATA_EMAIL}`);

  try {
    // ═══ DISPATCH DEDUP ═══
    const reserveSlot = async (recipient: "hanka" | "kata"): Promise<boolean> => {
      const nowIso = new Date().toISOString();
      const { data: existing } = await (sb as any).from("did_daily_report_dispatches")
        .select("id, status, updated_at")
        .eq("report_date", reportDatePrague)
        .eq("recipient", recipient)
        .maybeSingle();

      if (existing?.status === "sent" && !forceResend) {
        console.log(`[daily-email] ${recipient} already sent for ${reportDatePrague}, skipping.`);
        return false;
      }
      if (existing?.status === "sent" && forceResend) {
        console.log(`[daily-email] ${recipient} force resend — overriding "sent" status.`);
        await (sb as any).from("did_daily_report_dispatches")
          .update({ status: "pending", updated_at: nowIso, error_message: "force_resend" })
          .eq("id", existing.id);
        return true;
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
      metricsRes, weekMetricsRes,
      goalsRes, switchesRes,
      unreadNotesRes, aiErrorCountRes,
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
      // F7: enriched data
      (sb as any).from("daily_metrics").select("*").eq("metric_date", reportDatePrague),
      (sb as any).from("daily_metrics").select("part_name, emotional_valence, cooperation_level, message_count").gte("metric_date", new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10)).order("metric_date", { ascending: true }),
      (sb as any).from("part_goals").select("part_name, goal_text, progress_pct, evaluation_notes, status, milestones, proposed_by").in("status", ["active", "proposed", "completed"]).order("part_name"),
      (sb as any).from("switching_events").select("original_part, detected_part, confidence, created_at").gte("created_at", reportDatePrague).order("created_at", { ascending: false }),
      (sb as any).from("therapist_notes").select("author, part_name, note_type, note_text, priority").eq("is_read_by_karel", false).order("priority", { ascending: true }).limit(10),
      (sb as any).from("ai_error_log").select("id", { count: "exact", head: true }).gte("created_at", reportDatePrague),
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

    // F7: enriched data
    const todayMetrics: any[] = metricsRes.data || [];
    const weekMetrics: any[] = weekMetricsRes.data || [];
    const allGoals: any[] = goalsRes.data || [];
    const todaySwitches: any[] = switchesRes.data || [];
    const unreadNotes: any[] = unreadNotesRes.data || [];
    const aiErrorCount: number = aiErrorCountRes.count || 0;

    console.log(`[daily-email] F7 enriched: metrics=${todayMetrics.length}, goals=${allGoals.length}, switches=${todaySwitches.length}, notes=${unreadNotes.length}, aiErrors=${aiErrorCount}`);

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

    // ═══ F7: ENRICHED REPORT SECTIONS ═══
    // Metrics
    if (todayMetrics.length > 0) {
      suppBlock += `\n\n📊 ═══ DENNÍ METRIKY ═══\n`;
      for (const m of todayMetrics) {
        if (!m.part_name) continue;
        const valIcon = m.emotional_valence != null
          ? (m.emotional_valence >= 6 ? "🟢" : m.emotional_valence >= 3 ? "🟡" : "🔴")
          : "⚪";
        suppBlock += `${valIcon} ${m.part_name}: ${m.message_count || 0} zpráv, valence ${m.emotional_valence?.toFixed?.(1) || "?"}/10, spolupráce ${m.cooperation_level?.toFixed?.(1) || "?"}/10${m.switching_count ? `, ${m.switching_count} switchingů` : ""}${m.risk_signals_count ? `, ⚠️ ${m.risk_signals_count} rizik` : ""}\n`;
      }
    }

    // Weekly trends
    if (weekMetrics.length > 0) {
      const partNames = [...new Set(weekMetrics.filter((m: any) => m.part_name).map((m: any) => m.part_name))];
      if (partNames.length > 0) {
        suppBlock += `\n📈 ═══ TÝDENNÍ TRENDY ═══\n`;
        for (const pn of partNames) {
          const partData = weekMetrics.filter((m: any) => m.part_name === pn);
          if (partData.length < 2) continue;
          const first = partData[0];
          const last = partData[partData.length - 1];
          const valTrend = first.emotional_valence != null && last.emotional_valence != null
            ? (last.emotional_valence > first.emotional_valence + 0.5 ? "↗ zlepšuje se"
              : last.emotional_valence < first.emotional_valence - 0.5 ? "↘ zhoršuje se" : "→ stabilní")
            : "? nedostatek dat";
          const totalMsgs = partData.reduce((s: number, m: any) => s + (m.message_count || 0), 0);
          suppBlock += `${pn}: valence ${valTrend}, ${totalMsgs} zpráv za týden\n`;
        }
      }
    }

    // Goals
    const activeGoalsList = allGoals.filter((g: any) => g.status === "active");
    const completedGoals = allGoals.filter((g: any) => g.status === "completed");
    const pendingGoals = allGoals.filter((g: any) => g.status === "proposed");
    if (activeGoalsList.length > 0 || completedGoals.length > 0 || pendingGoals.length > 0) {
      suppBlock += `\n🎯 ═══ CÍLE ═══\n`;
      if (completedGoals.length > 0) {
        suppBlock += `🎉 Dnes splněné:\n`;
        for (const g of completedGoals) suppBlock += `  ✅ ${g.part_name}: ${g.goal_text}\n`;
      }
      if (pendingGoals.length > 0) {
        suppBlock += `🆕 Čekají na schválení:\n`;
        for (const g of pendingGoals) suppBlock += `  🤖 ${g.part_name}: ${g.goal_text}\n`;
      }
      if (activeGoalsList.length > 0) {
        suppBlock += `Aktivní cíle:\n`;
        for (const g of activeGoalsList) {
          const bar = "█".repeat(Math.round((g.progress_pct || 0) / 10)) + "░".repeat(10 - Math.round((g.progress_pct || 0) / 10));
          suppBlock += `  ${g.part_name}: ${g.goal_text} [${bar}] ${g.progress_pct}%${g.evaluation_notes ? ` — ${g.evaluation_notes}` : ""}\n`;
        }
      }
    }

    // Switching
    if (todaySwitches.length > 0) {
      suppBlock += `\n🔄 ═══ SWITCHING EVENTY (${todaySwitches.length}) ═══\n`;
      for (const sw of todaySwitches.slice(0, 5)) {
        suppBlock += `  ${sw.original_part} → ${sw.detected_part || "?"} (${sw.confidence}) ${new Date(sw.created_at).toLocaleTimeString("cs-CZ")}\n`;
      }
      if (todaySwitches.length > 5) suppBlock += `  ... a dalších ${todaySwitches.length - 5}\n`;
    }

    // Unread therapist notes
    if (unreadNotes.length > 0) {
      suppBlock += `\n📝 ═══ NEPŘEČTENÉ POZNÁMKY (${unreadNotes.length}) ═══\n`;
      for (const n of unreadNotes) {
        const prioIcon = n.priority === "urgent" ? "🔴" : n.priority === "high" ? "🟠" : "";
        suppBlock += `  ${prioIcon} [${n.author}] ${n.part_name || "obecné"}: ${(n.note_text || "").slice(0, 100)}\n`;
      }
    }

    // System status
    if (aiErrorCount > 0) {
      suppBlock += `\n🔧 SYSTÉM: ${aiErrorCount} AI chyb dnes\n`;
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
    // ═══ LOAD did_tasks (pending) FOR EMAIL ═══
    let pendingDidTasks: any[] = [];
    try {
      const { data: dtData } = await (sb as any).from("did_tasks")
        .select("*")
        .eq("status", "pending")
        .order("created_at", { ascending: true });
      pendingDidTasks = dtData || [];
    } catch (e) { console.warn("[daily-email] did_tasks load error:", e); }

    const isMonday = new Date().getDay() === 1;

    const generateEmail = async (recipient: "hanka" | "kata"): Promise<string> => {
      const isHanka = recipient === "hanka";
      const profile = isHanka ? hankaProfile : kataProfile;

      // Filter did_tasks for this therapist
      const myDidTasks = pendingDidTasks.filter((t: any) => t.assigned_to === recipient || t.assigned_to === "both");
      const overdueTasks = myDidTasks.filter((t: any) => t.due_date && new Date(t.due_date) < new Date());
      const followUpTasks = myDidTasks.filter((t: any) => t.follow_up_needed);

      // Build did_tasks block for email
      let didTasksBlock = "";
      if (myDidTasks.length > 0) {
        didTasksBlock = `\n═══ KAREL AUTOMATICKÉ ÚKOLY (z chatu) ═══\n`;
        didTasksBlock += myDidTasks.map((t: any) => {
          const age = Math.floor((Date.now() - new Date(t.created_at).getTime()) / (1000 * 60 * 60 * 24));
          const overdue = t.due_date && new Date(t.due_date) < new Date() ? " ⚠️ ZPOŽDĚNÝ" : "";
          return `  ▸ [${t.task_type}|${t.priority}${overdue}] ${t.description} (${age}d${t.related_part ? `, část: ${t.related_part}` : ""})`;
        }).join("\n");
      }

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

═══ NOVÉ DATOVÉ SEKCE (pokud jsou k dispozici) ═══
Report MUSÍ obsahovat tyto sekce, pokud mají data:
1. 📊 Souhrnné metriky dne (valence, spolupráce, aktivita)
2. 📈 Trendy (zlepšení/zhoršení za týden — emoji šipky)
3. 🎯 Pokrok v cílech (progress bary textové █░, procenta)
4. 🔄 Switching eventy (pokud byly — stručně)
5. ⚠️ Varování a rizika
6. ✅ Pozitivní signály a pokroky
7. 📝 Akční body pro zítřek
8. 🆕 Cíle ke schválení (pokud Karel navrhl nové micro-cíle)
Neincluduj prázdné sekce. Integruj data přirozeně do textu.
` : "";

      const systemPrompt = isHanka
        ? `Jsi Karel – vedoucí terapeutického týmu pro DID případ.
Píšeš DENNÍ BRIEFING přímo Hance. Oslovuj ji „Hani" nebo „Haničko".
Jsi její mentor, vedoucí týmu a supervizor – ne neutrální zprávodaj.
${analysisRules}

═══ TVOJE ROLE V TOMTO MAILU ═══
- Vyber 2–3 nejdůležitější témata DNEŠKA.
- U každého vysvětli, PROČ na něm záleží.
- Dej KONKRÉTNÍ návrhy kroků a sezení.
- Piš ve stylu: „Haničko, všímám si, že…" nebo „Hani, doporučuju dnes…"
- NEPIŠ o Hance ve třetí osobě („Hanka se potýká s…").

═══ SOUKROMÍ – ABSOLUTNÍ ZÁKAZ ═══
- NIKDY nepiš do mailu:
  - detailní popisy Hančiny viny, výčitek, osobních pocitů,
  - soukromé metafory (sedmikrásky, intimní symboly),
  - detaily z Hančiných osobních sezení nebo osobní terapie,
  - formulace jako „nevyřízená vina ovlivňuje tvou kapacitu".
- Tyto informace používej POUZE pro vlastní rozhodování – NIKDY je nepiš.
- Pokud chceš zmínit osobní téma, napiš MAXIMÁLNĚ obecně:
  „Hani, vím, že téma kolem Tundrupka je pro tebe náročné. Navrhuju, abychom ho
   dnes vzali jako společné téma sezení."

═══ ČÁSTI – KONKRÉTNOST ═══
- U každé části, o které píšeš, MUSÍŠ uvést:
  - KDY a KDE komunikovala (např. „včera večer ve vlákně DID/Kluci/Gustík"),
  - co bylo hlavní téma (rozladěnost, hra, noční děsy…),
  - co z toho pro DNEŠEK vyplývá.
- Pokud partsForEmail je prázdný, NEPIŠ žádná doporučení sezení s částmi.

═══ POVINNOST NAVRHNOUT SEZENÍ ═══
- Pro KAŽDOU část v partsForEmail MUSÍŠ navrhnout konkrétní sezení:
  - KDO ho vede (Hanka / Káťa / Karel),
  - FORMÁT (rozhovor, hra, kreslení, relaxace, procházka…),
  - ODHAD DÉLKY (10 min, 20 min, 30 min),
  - 2–3 CÍLE sezení,
  - KONKRÉTNÍ OTEVÍRACÍ VĚTU (jak začít rozhovor s částí).
- Pokud partsForEmail je prázdný, místo sezení napiš „Dnes žádné sezení s částmi
  není potřeba – zaměřte se na úkoly a koordinaci."

═══ NOVÁ STRUKTURA MAILU (5 SEKCÍ) ═══

Strukturuj denní mail do PŘESNĚ těchto sekcí:

1. 🔴 AKUTNÍ POZORNOST
   Části vykazující známky distresu, zhoršení nebo krize.
   U každé uveď: co jsi zachytil, co navrhuješ, jaký konkrétní úkol má terapeutka.

2. 🟡 UDRŽOVACÍ KONTAKT
   Části které jsou stabilní ale potřebují pravidelný kontakt.
   U každé: navržená aktivita nebo hra, frekvence, kanál (fyzicky přítomná).

3. ⚪ RADAR — TICHÉ ČÁSTI
   Části které nekomunikovaly 3+ dny.
   U každé: jak dlouho mlčí, co byla poslední komunikace, návrh jak oslovit.

4. 📋 TVOJE ÚKOLY NA DNES
   Konkrétní úkoly s termínem:
   - Zpětná vazba z včerejších sezení
   - Doplňující otázky od Karla (z did_tasks)
   - Navržená sezení na dnes/zítra s plánem a důvodem
   - Zpožděné úkoly (pokud existují) — ZVÝRAZNI

5. 📊 TÝDENNÍ PULZ (pouze v PONDĚLNÍM mailu)
   Hodnocení uplynulého týdne — jen pokud je pondělí.

PERSONALIZACE PRO HANKU:
- Zaměř se na fyzické aktivity, přímá sezení, domácí rituály, senzorické hry
- Hanka je FYZICKY PŘÍTOMNÁ s klukama v Písku

Formát HTML emailu:
<h2>Denní briefing – ${dateStr}</h2>

<h3>🔴 AKUTNÍ POZORNOST:</h3>
Pro každé téma:
<h4>[Název]</h4>
<p><strong>Co se stalo:</strong> KDY, KDE, S KÝM – konkrétně.</p>
<p><strong>Co z toho vyplývá:</strong> riziko / příležitost.</p>
<p><strong>Doporučení:</strong> konkrétní kroky.</p>

<h3>🟡 UDRŽOVACÍ KONTAKT:</h3>
Stabilní části — navržená aktivita, frekvence.

<h3>⚪ RADAR — TICHÉ ČÁSTI:</h3>
Části bez kontaktu 3+ dny — jak oslovit.

<h3>📋 TVOJE ÚKOLY NA DNES:</h3>
▸ EXISTUJÍCÍ úkoly – neduplikuj!
▸ Karel-automatické úkoly (z chatu) — zahrň je.
▸ U zpožděných vysvětli proč jsou důležité.

<h3>📞 KOORDINACE S KÁŤOU:</h3>
Co je potřeba probrat.

${todaySessionPlan ? `<h3>🗓️ AUTOMATICKÝ PLÁN SEZENÍ:</h3>
Shrň klíčové body.` : ""}

Podpis: "Karel – vedoucí DID terapeutického týmu"

Tón: přátelský, profesionální, osobní – jako mentor píšící své kolegyni.
ADAPTIVNÍ STYL na základě motivačního profilu.
NIKDY nezmiňuj profilaci ani monitoring terapeutek.`
        : `Jsi Karel – vedoucí terapeutického týmu. Píšeš denní briefing přímo Kátě.
Oslovuj ji „Káťo" nebo „Katko". Jsi její mentor a supervizor.
${analysisRules}

═══ TVOJE ROLE ═══
- Vyber 2–3 nejdůležitější témata dneška.
- Dej konkrétní návrhy kroků.
- Piš ve stylu: „Káťo, doporučuju dnes…"

═══ KÁŤINA SPECIFICKÁ ROLE V TÝMU ═══
Káťa je DRUHÁ TERAPEUTKA v tandemu s Hankou. Její role se od Hanky LIŠÍ:

KÁŤA:
- Je odborně zaměřená na arteterapii, kreativní techniky a neverbální práci s částmi.
- Pracuje převážně s částmi, které potřebují kreativní přístup (kreslení, modelování, hry).
- Je zodpovědná za přípravky a pomůcky na sezení (Gustíkova krabička, barvy, fidget toys).
- Komunikuje s částmi často přes aktivitu (hra, tvoření), ne jen přes rozhovor.
- Je klidnější, trpělivější – vhodná pro části, které se těžko verbalizují.

HANKA:
- Je hlavní terapeutka – vede většinu rozhovorových sezení.
- Má osobní vazbu na systém (zná části déle, je „mamka" pro některé).
- Řeší celkovou strategii, koordinaci s okolím, krizové situace.
- Má tendenci se přetěžovat – Káťa ji v tom zastupuje a odlehčuje.

V mailu pro KÁŤU:
- Zdůrazni JEJÍ konkrétní úkoly – co má dělat ONA, ne co dělá Hanka.
- Pokud Hanka vede sezení, napiš Kátě, jak se má PŘIPRAVIT nebo CO MÁ DOPLNIT.
- Pokud Káťa vede sezení, dej jí detailní instrukce: techniku, pomůcky, cíle.
- Uveď, jaké pomůcky nebo materiály si má připravit.

═══ SOUKROMÍ ═══
- NIKDY nesdílej Hančiny osobní informace, pocity, vinu ani soukromá témata.
- O Hance piš pouze pracovně: „Hanka dnes pracuje na…", „koordinuj s Hankou ohledně…"

═══ ČÁSTI – KONKRÉTNOST ═══
- U každé části uveď KDY a KDE komunikovala, hlavní téma, co z toho vyplývá.
- Pokud partsForEmail je prázdný, NEPIŠ doporučení sezení s částmi.

═══ POVINNOST NAVRHNOUT SEZENÍ ═══
- Pro KAŽDOU část v partsForEmail napiš:
  kdo vede (Hanka NEBO Káťa – dle analýzy), formát, odhad délky, 2–3 cíle, otevírací větu.
  Pokud Káťa vede: přidej KONKRÉTNÍ techniku (arteterapie, hra, modelování…) a POMŮCKY.
  Pokud Hanka vede: napiš Kátě, čím může sezení podpořit (příprava pomůcek, pozorování, zápis).
- Pokud partsForEmail prázdný: „Dnes žádné sezení s částmi není potřeba."

═══ NOVÁ STRUKTURA MAILU (5 SEKCÍ) ═══

Strukturuj denní mail do PŘESNĚ těchto sekcí:

1. 🔴 AKUTNÍ POZORNOST
   Části vykazující známky distresu, zhoršení nebo krize.

2. 🟡 UDRŽOVACÍ KONTAKT
   Části stabilní ale potřebující kontakt.
   U každé: navržená aktivita, kanál (vzdáleně – chat, video, nahrávka).

3. ⚪ RADAR — TICHÉ ČÁSTI
   Části bez kontaktu 3+ dny — jak oslovit VZDÁLENĚ.

4. 📋 TVOJE ÚKOLY NA DNES
   Karel-automatické úkoly + zpožděné úkoly + koordinace.

5. 📊 TÝDENNÍ PULZ (pouze pondělí)

PERSONALIZACE PRO KÁŤU:
- Zaměř se na VZDÁLENÉ aktivity (video, chat, nahrávky)
- Káťa je v Českých Budějovicích, kluci v Písku (~100km)
- Koordinace se školou Townshend, analytické úkoly
- Pokud aktivita vyžaduje fyzickou přítomnost, uveď explicitně "při návštěvě" a zda potřebuje Hanku jako prostředníka

Formát HTML emailu:
<h2>Denní briefing pro Káťu – ${dateStr}</h2>

<h3>🔴 AKUTNÍ POZORNOST:</h3>
<h4>[Název]</h4>
<p><strong>Co se stalo:</strong> konkrétně.</p>
<p><strong>Co z toho vyplývá:</strong> ...</p>
<p><strong>Doporučení PRO TEBE:</strong> co přesně má Káťa udělat (VZDÁLENĚ).</p>

<h3>🟡 UDRŽOVACÍ KONTAKT:</h3>
Stabilní části — vzdálená aktivita, frekvence.

<h3>⚪ RADAR — TICHÉ ČÁSTI:</h3>
Části bez kontaktu — jak oslovit vzdáleně.

<h3>📋 TVOJE ÚKOLY NA DNES:</h3>
▸ Konkrétní, splnitelné – neduplikuj existující!
▸ Karel-automatické úkoly z chatu.
▸ Zahrň přípravu pomůcek, materiálů.

<h3>📞 KOORDINACE S HANKOU:</h3>
Co je potřeba domluvit – kdo co dělá, kdy, kde.

${todaySessionPlan ? `<h3>🗓️ PLÁN SEZENÍ:</h3>
Shrň klíčové body z pohledu Káti.` : ""}

Podpis: "Karel"

Tón: přátelský, profesionální, konkrétní. NIKDY nezmiňuj profilaci.`;
      // ═══ FILTER: only parts that are truly active + recommended ═══
      const BANNED_PART_NAMES = new Set([
        "LOCIK","LOCÍK","LOCEK", // pes – NIKDY DID část
        "HANKA","KATA","KÁŤA","KATKA","KATEŘINA","KAREL", // terapeutky/AI – NIKDY DID části
        "JIŘÍ","JIRI","AMÁLKA","AMALKA","TONIČKA","TONICKA", // biologické děti
        "BENDIK_BONDEVIK","BENDIK","CLARK","KLARK",
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

      // Include did_tasks auto-extracted from chat
      if (didTasksBlock) {
        userContent += didTasksBlock + "\n\n";
      }

      // Overdue tasks highlight
      if (overdueTasks.length > 0) {
        userContent += `⚠️ ZPOŽDĚNÉ ÚKOLY (${overdueTasks.length}):\n`;
        userContent += overdueTasks.map((t: any) => `  🔴 ${t.description} (měl být hotov: ${new Date(t.due_date).toLocaleDateString("cs-CZ")})`).join("\n");
        userContent += "\n\n";
      }

      if (weeklySummary) {
        userContent += `═══ POSLEDNÍ TÝDENNÍ ANALÝZA ═══\n${weeklySummary.slice(0, 2000)}\n\n`;
      }

      userContent += `═══ MOTIVAČNÍ PROFIL ${isHanka ? "HANKY" : "KÁTI"} ═══\n${formatProfile(profile)}`;

      // Monday: add weekly pulse instruction
      if (isMonday) {
        userContent += `\n\n═══ PONDĚLNÍ INSTRUKCE ═══\nDnes je pondělí — PŘIDEJ na konec mailu sekci:\n<h3>📊 TÝDENNÍ PULZ</h3>\n- Které části se minulý týden zlepšily / zhoršily / stagnovaly\n- Co fungovalo / nefungovalo\n- Plán a priority na tento týden`;
      }

      // ═══ AI CALL WITH RETRY ON CONNECTION RESET ═══
      const callAI = async (attempt = 1): Promise<Response> => {
        try {
          const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
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
          // Retry on 502/503 (often connection reset / gateway error)
          if ((res.status === 502 || res.status === 503) && attempt < 3) {
            console.warn(`[daily-email] AI gateway returned ${res.status} on attempt ${attempt}, retrying in 3s...`);
            await new Promise(r => setTimeout(r, 3000));
            return callAI(attempt + 1);
          }
          return res;
        } catch (fetchErr: any) {
          // Retry on network-level errors (connection reset, ECONNRESET, etc.)
          const msg = fetchErr?.message || String(fetchErr);
          if (attempt < 3 && (msg.includes("reset") || msg.includes("ECONNRESET") || msg.includes("connection") || msg.includes("aborted"))) {
            console.warn(`[daily-email] AI fetch error on attempt ${attempt}: ${msg}, retrying in 3s...`);
            await new Promise(r => setTimeout(r, 3000));
            return callAI(attempt + 1);
          }
          throw fetchErr;
        }
      };

      const response = await callAI();

      if (response.ok) {
        const d = await response.json();
        const html = (d.choices?.[0]?.message?.content || "").replace(/^```html?\n?/i, "").replace(/\n?```$/i, "");
        if (html) {
          console.log(`[daily-email] Generated HTML (first 3000ch): ${html.slice(0, 3000)}`);
          return html;
        }
      } else {
        console.error(`[daily-email] AI gateway final status: ${response.status}`);
      }

      return `<pre style="font-family: sans-serif; white-space: pre-wrap;">${analysisBlock || suppBlock}</pre>`;
    };

    // ═══ SEND EMAILS ═══
    let hankaResult = "skipped";
    let kataResult = "skipped";

    if (hankaReserved) {
      try {
        const hankaHtml = await generateEmail("hanka");
        const { data: sendData, error: sendError } = await resend.emails.send({
          from: "Karel <karel@hana-chlebcova.cz>",
          to: [MAMKA_EMAIL],
          subject: `Karel – denní report ${dateStr}`,
          html: hankaHtml,
        });
        if (sendError) {
          throw new Error(`Resend API error: ${sendError.message || JSON.stringify(sendError)}`);
        }
        console.log(`[daily-email] ✅ Resend ID (hanka): ${sendData?.id || "unknown"}`);
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
        const { data: sendData, error: sendError } = await resend.emails.send({
          from: "Karel <karel@hana-chlebcova.cz>",
          to: [KATA_EMAIL],
          subject: `Karel – report pro Káťu ${dateStr}`,
          html: kataHtml,
        });
        if (sendError) {
          throw new Error(`Resend API error: ${sendError.message || JSON.stringify(sendError)}`);
        }
        console.log(`[daily-email] ✅ Resend ID (kata): ${sendData?.id || "unknown"}`);
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
