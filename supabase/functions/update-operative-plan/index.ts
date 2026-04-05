import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/auth.ts";
import {
  getAccessToken, resolveKartotekaRoot, findFolder, listFiles,
  readFileContent, overwriteDoc, createBackup,
  FOLDER_MIME, GDOC_MIME,
} from "../_shared/driveHelpers.ts";

const today = () => new Date().toISOString().slice(0, 10);
const futureDate = (days: number) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
const pastDate = (days: number) => new Date(Date.now() - days * 86400000).toISOString();

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const startTime = Date.now();
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  try {
    // === LOAD ALL DATA IN PARALLEL ===
    const [
      crisisRes, critTasksRes, blockingQRes,
      partsRes, shortGoalsRes, sessionsRes,
      plannedRes, pendingQRes,
      motivHankaRes, motivKataRes,
      taskCountRes, journalRes
    ] = await Promise.all([
      // Sekce 1
      sb.from("crisis_alerts").select("id,part_name,severity,status,created_at,days_in_crisis,summary").neq("status", "resolved"),
      sb.from("did_therapist_tasks").select("*").in("status", ["pending", "active", "in_progress"]).eq("priority", "critical").lte("due_date", futureDate(3)),
      sb.from("did_pending_questions").select("*").not("subject_type", "is", null).neq("status", "answered").limit(20),
      // Sekce 2
      sb.from("did_part_registry").select("part_name,display_name,status,last_seen_at,health_score,last_emotional_state,next_session_plan").or("status.eq.active,status.eq.Aktivní"),
      sb.from("part_goals").select("*").eq("status", "active").eq("goal_type", "short"),
      sb.from("did_part_sessions").select("part_name,therapist,session_date,session_type,karel_notes").gte("created_at", pastDate(14)).order("session_date", { ascending: false }),
      // Sekce 3
      sb.from("planned_sessions").select("*").in("status", ["planned", "in_progress"]).lte("session_date", futureDate(14)).order("priority", { ascending: true }),
      // Sekce 4
      sb.from("did_pending_questions").select("*").in("status", ["pending", "sent"]).order("created_at", { ascending: true }).limit(10),
      // Sekce 5
      sb.from("did_motivation_profiles").select("*").eq("therapist", "hanka").limit(1),
      sb.from("did_motivation_profiles").select("*").eq("therapist", "kata").limit(1),
      sb.from("did_therapist_tasks").select("assigned_to,status").neq("status", "done"),
      // Sekce 6
      sb.from("crisis_journal").select("crisis_alert_id,crisis_trend,date").order("date", { ascending: false }).limit(50),
    ]);

    const crises = crisisRes.data || [];
    const critTasks = critTasksRes.data || [];
    const blockingQ = (blockingQRes.data || []).filter((q: any) => q.subject_type === 'blocking' || q.subject_type === 'crisis_closure');
    const parts = partsRes.data || [];
    const shortGoals = shortGoalsRes.data || [];
    const sessions14 = sessionsRes.data || [];
    const planned = plannedRes.data || [];
    const pendingQ = pendingQRes.data || [];
    const motivHanka = motivHankaRes.data?.[0];
    const motivKata = motivKataRes.data?.[0];
    const allTasks = taskCountRes.data || [];
    const journalEntries = journalRes.data || [];

    // === BUILD 05A CONTENT ===
    const lines: string[] = [];
    lines.push(`═══ OPERATIVNÍ PLÁN ═══`);
    lines.push(`Aktualizováno: ${today()}\n`);

    // --- SEKCE 1: Kritický kontext 72h ---
    lines.push(`━━━ 1. KRITICKÝ KONTEXT 72h ━━━\n`);
    if (crises.length) {
      lines.push(`🔴 AKTIVNÍ KRIZE (${crises.length}):`);
      for (const c of crises) {
        const journal = journalEntries.find((j: any) => j.crisis_alert_id === c.id);
        lines.push(`  • ${c.part_name} — ${c.severity} — den ${c.days_in_crisis || '?'} — ${c.summary?.slice(0, 100)}`);
        if (journal) lines.push(`    trend: ${journal.crisis_trend}`);
      }
    } else {
      lines.push(`✅ Žádná aktivní krize.`);
    }
    if (critTasks.length) {
      lines.push(`\n⚠️ KRITICKÉ ÚKOLY (${critTasks.length}):`);
      for (const t of critTasks) {
        lines.push(`  • [${t.assigned_to}] ${t.task} — do ${t.due_date}`);
      }
    }
    if (blockingQ.length) {
      lines.push(`\n❓ BLOKUJÍCÍ OTÁZKY (${blockingQ.length}):`);
      for (const q of blockingQ) {
        lines.push(`  • ${q.question?.slice(0, 120)} — směr: ${q.directed_to}`);
      }
    }

    // --- SEKCE 2: Aktivní části ---
    lines.push(`\n━━━ 2. AKTIVNÍ ČÁSTI A OPERATIVNÍ PRIORITY ━━━\n`);
    for (const p of parts) {
      const pGoals = shortGoals.filter((g: any) => g.part_name === p.part_name);
      const pSessions = sessions14.filter((s: any) => s.part_name === p.part_name);
      const lastSession = pSessions[0];
      lines.push(`▸ ${p.display_name || p.part_name} (health: ${p.health_score ?? '?'}, emoce: ${p.last_emotional_state || '?'})`);
      if (lastSession) {
        lines.push(`  Poslední sezení: ${lastSession.session_date} (${lastSession.therapist})`);
      } else {
        lines.push(`  ⚠️ Žádné sezení za 14 dní`);
      }
      if (pGoals.length) {
        for (const g of pGoals) {
          lines.push(`  Cíl: ${g.goal_text} (${g.progress_pct}%)`);
        }
      }
      if (p.next_session_plan) {
        lines.push(`  Plán: ${(p.next_session_plan as string).slice(0, 150)}`);
      }
    }

    // --- SEKCE 3: Rozpracovaná sezení ---
    lines.push(`\n━━━ 3. ROZPRACOVANÁ SEZENÍ ━━━\n`);
    if (planned.length) {
      for (const s of planned) {
        lines.push(`  • ${s.part_name} — ${s.method_name} — terapeut: ${s.therapist} — priorita: ${s.priority} — status: ${s.status}`);
        if (s.description) lines.push(`    ${s.description.slice(0, 120)}`);
      }
    } else {
      lines.push(`  (žádná naplánovaná sezení)`);
    }

    // --- SEKCE 4: Otevřené otázky ---
    lines.push(`\n━━━ 4. OTEVŘENÉ OTÁZKY ━━━\n`);
    if (pendingQ.length) {
      for (const q of pendingQ) {
        lines.push(`  • [${q.directed_to}] ${q.question?.slice(0, 150)} (${q.status})`);
      }
    } else {
      lines.push(`  (žádné otevřené otázky)`);
    }

    // --- SEKCE 5: Kapacity týmu ---
    lines.push(`\n━━━ 5. KAPACITY TÝMU ━━━\n`);
    const hankaTaskCount = allTasks.filter((t: any) => t.assigned_to === 'hanka').length;
    const kataTaskCount = allTasks.filter((t: any) => t.assigned_to === 'kata').length;
    lines.push(`  Hanička: ${hankaTaskCount} aktivních úkolů | streak: ${motivHanka?.streak_current ?? 0} | styl: ${motivHanka?.preferred_style || '?'}`);
    lines.push(`  Káťa: ${kataTaskCount} aktivních úkolů | streak: ${motivKata?.streak_current ?? 0} | styl: ${motivKata?.preferred_style || '?'}`);

    // --- SEKCE 6: Krizové sledování ---
    lines.push(`\n━━━ 6. KRIZOVÉ SLEDOVÁNÍ ━━━\n`);
    if (crises.length) {
      for (const c of crises) {
        const cJournals = journalEntries.filter((j: any) => j.crisis_alert_id === c.id);
        const lastJ = cJournals[0];
        lines.push(`  ${c.part_name}: fáze=${c.status}, den ${c.days_in_crisis || '?'}`);
        if (lastJ) lines.push(`    trend: ${lastJ.crisis_trend}, poslední záznam: ${lastJ.date}`);
      }
    } else {
      lines.push(`  Žádné aktivní krize.`);
    }

    const planContent = lines.join("\n");

    // === WRITE TO DRIVE ===
    const token = await getAccessToken();
    const root = await resolveKartotekaRoot(token);
    if (!root) throw new Error("KARTOTEKA_DID not found");

    const centrumId = await findFolder(token, "00_CENTRUM", root);
    if (!centrumId) throw new Error("00_CENTRUM not found");
    const planFolderId = await findFolder(token, "05_PLAN", centrumId);
    if (!planFolderId) throw new Error("05_PLAN not found");

    const planFiles = await listFiles(token, planFolderId);
    const planFile = planFiles.find(f => f.name.includes("05A") || f.name.includes("Operativni"));
    if (!planFile) throw new Error("05A_Operativni_Plan not found");

    const currentPlan = await readFileContent(token, planFile.id, planFile.mimeType);
    await createBackup(token, planFolderId, planFile.name, currentPlan);
    await overwriteDoc(token, planFile.id, planContent);
    console.log(`[operative-plan] Written ${planContent.length} chars to 05A`);

    // === LOG ===
    await sb.from("system_health_log").insert({
      event_type: "operative_plan_update",
      severity: "info",
      message: `05A updated: ${parts.length} parts, ${crises.length} crises, ${planned.length} sessions`,
      details: { parts_count: parts.length, crises_count: crises.length, sessions_count: planned.length },
    });

    await sb.from("plan_update_log").insert({
      plan_type: "operative",
      parts_included: parts.map((p: any) => p.part_name),
      sessions_planned: planned.length,
      processing_time_ms: Date.now() - startTime,
    });

    return new Response(JSON.stringify({
      success: true,
      partsIncluded: parts.length,
      crisesActive: crises.length,
      sessionsPlanned: planned.length,
      contentLength: planContent.length,
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
