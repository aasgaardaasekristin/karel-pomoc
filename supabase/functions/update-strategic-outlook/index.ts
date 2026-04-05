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
      medGoalsRes, partsActiveRes, partsInactiveRes,
      obsRes, blockedGoalsRes,
      metricsRes, promotionRes
    ] = await Promise.all([
      // Sekce 1
      sb.from("part_goals").select("*").eq("goal_type", "medium").eq("status", "active"),
      // Sekce 2
      sb.from("did_part_registry").select("part_name,display_name,status,last_seen_at,health_score").or("status.eq.active,status.eq.Aktivní"),
      sb.from("did_part_registry").select("part_name,display_name,status,last_seen_at,health_score,notes").not("status", "in", "(active,Aktivní)"),
      // Sekce 3
      sb.from("did_observations").select("*").eq("time_horizon", "medium").eq("status", "pending").order("created_at", { ascending: false }).limit(20),
      // Sekce 4
      sb.from("part_goals").select("*").in("status", ["blocked", "paused"]),
      // Sekce 5
      sb.from("daily_metrics").select("*").gte("metric_date", new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10)).order("metric_date", { ascending: true }),
      // Sekce 6
      sb.from("planned_sessions").select("*").eq("status", "planned").gte("session_date", futureDate(15)).lte("session_date", futureDate(60)),
    ]);

    const medGoals = medGoalsRes.data || [];
    const partsActive = partsActiveRes.data || [];
    const partsInactive = partsInactiveRes.data || [];
    const observations = obsRes.data || [];
    const blockedGoals = blockedGoalsRes.data || [];
    const metrics = metricsRes.data || [];
    const promotionSessions = promotionRes.data || [];

    // Check overdue parts (>14 days without session)
    const overdueThreshold = new Date(Date.now() - 14 * 86400000).toISOString();

    // === BUILD 05B CONTENT ===
    const lines: string[] = [];
    lines.push(`═══ STRATEGICKÝ VÝHLED ═══`);
    lines.push(`Aktualizováno: ${today()}\n`);

    // --- SEKCE 1: Střednědobé linie ---
    lines.push(`━━━ 1. HLAVNÍ STŘEDNĚDOBÉ LINIE PRÁCE ━━━\n`);
    const goalsByPart = new Map<string, any[]>();
    for (const g of medGoals) {
      const key = g.part_name || "systém";
      if (!goalsByPart.has(key)) goalsByPart.set(key, []);
      goalsByPart.get(key)!.push(g);
    }
    if (goalsByPart.size) {
      for (const [part, goals] of goalsByPart) {
        lines.push(`▸ ${part}:`);
        for (const g of goals) {
          lines.push(`  • ${g.goal_text} (${g.progress_pct}%, kategorie: ${g.category || '?'})`);
        }
      }
    } else {
      lines.push(`  (žádné střednědobé cíle)`);
    }

    // --- SEKCE 2: Části doporučené k práci ---
    lines.push(`\n━━━ 2. ČÁSTI — READINESS (15-60 dní) ━━━\n`);
    lines.push(`AKTIVNÍ ČÁSTI:`);
    for (const p of partsActive) {
      const overdue = p.last_seen_at && p.last_seen_at < overdueThreshold;
      lines.push(`  ${overdue ? '⚠️' : '▸'} ${p.display_name || p.part_name} — health: ${p.health_score ?? '?'}, last: ${p.last_seen_at?.slice(0, 10) || 'nikdy'}${overdue ? ' — PŘESČAS >14 dní' : ''}`);
    }
    // Sleeping parts as activation candidates
    const candidates = partsInactive.filter((p: any) => p.health_score && p.health_score > 0);
    if (candidates.length) {
      lines.push(`\nSPÍCÍ ČÁSTI — KANDIDÁTI NA AKTIVIZACI:`);
      for (const p of candidates) {
        lines.push(`  • ${p.display_name || p.part_name} — health: ${p.health_score}, last: ${p.last_seen_at?.slice(0, 10) || 'nikdy'}`);
      }
    }

    // --- SEKCE 3: Kandidátní intervence ---
    lines.push(`\n━━━ 3. KANDIDÁTNÍ INTERVENCE ━━━\n`);
    if (observations.length) {
      for (const o of observations) {
        lines.push(`  • [${o.subject_type}/${o.subject_id || '?'}] ${o.fact?.slice(0, 150)} (conf: ${o.confidence}, evidence: ${o.evidence_level})`);
      }
    } else {
      lines.push(`  (žádné střednědobé observace)`);
    }

    // --- SEKCE 4: Blokátory ---
    lines.push(`\n━━━ 4. BLOKÁTORY ━━━\n`);
    if (blockedGoals.length) {
      for (const g of blockedGoals) {
        lines.push(`  • ${g.part_name || 'systém'}: ${g.goal_text} — status: ${g.status}${g.pause_reason ? ` — důvod: ${g.pause_reason}` : ''}`);
      }
    } else {
      lines.push(`  (žádné blokované cíle)`);
    }

    // --- SEKCE 5: Trendy ---
    lines.push(`\n━━━ 5. TRENDY V PRÁCI TÝMU (30 dní) ━━━\n`);
    if (metrics.length) {
      // Aggregate by week
      const weeks = new Map<string, { msgs: number; switching: number; valence: number[]; count: number }>();
      for (const m of metrics) {
        const weekKey = m.metric_date.slice(0, 7); // month grouping
        if (!weeks.has(weekKey)) weeks.set(weekKey, { msgs: 0, switching: 0, valence: [], count: 0 });
        const w = weeks.get(weekKey)!;
        w.msgs += m.message_count || 0;
        w.switching += m.switching_count || 0;
        if (m.emotional_valence != null) w.valence.push(m.emotional_valence);
        w.count++;
      }
      for (const [period, w] of weeks) {
        const avgVal = w.valence.length ? (w.valence.reduce((a, b) => a + b, 0) / w.valence.length).toFixed(1) : '?';
        lines.push(`  ${period}: zpráv ${w.msgs}, switching ${w.switching}, avg valence ${avgVal} (${w.count} dní)`);
      }
    } else {
      lines.push(`  (žádné metriky za 30 dní)`);
    }

    // --- SEKCE 6: Kritéria pro povýšení do 05A ---
    lines.push(`\n━━━ 6. KRITÉRIA PRO POVÝŠENÍ Z 05B DO 05A ━━━\n`);
    if (promotionSessions.length) {
      lines.push(`Sezení plánovaná na 15-60 dní:`);
      for (const s of promotionSessions) {
        lines.push(`  • ${s.part_name} — ${s.method_name} — ${s.session_date || '?'} — terapeut: ${s.therapist}`);
      }
    } else {
      lines.push(`  (žádná sezení v horizontu 15-60 dní)`);
    }
    // Goals nearing promotion
    const nearPromotion = medGoals.filter((g: any) => g.progress_pct >= 70);
    if (nearPromotion.length) {
      lines.push(`\nCíle blízko dokončení (>70%):`);
      for (const g of nearPromotion) {
        lines.push(`  • ${g.part_name || 'systém'}: ${g.goal_text} (${g.progress_pct}%)`);
      }
    }

    const outlookContent = lines.join("\n");

    // === WRITE TO DRIVE ===
    const token = await getAccessToken();
    const root = await resolveKartotekaRoot(token);
    if (!root) throw new Error("KARTOTEKA_DID not found");

    const centrumId = await findFolder(token, "00_CENTRUM", root);
    if (!centrumId) throw new Error("00_CENTRUM not found");
    const planFolderId = await findFolder(token, "05_PLAN", centrumId);
    if (!planFolderId) throw new Error("05_PLAN not found");

    const planFiles = await listFiles(token, planFolderId);
    const stratFile = planFiles.find(f => f.name.includes("05B") || f.name.includes("Strategick"));
    if (!stratFile) throw new Error("05B_Strategicky_Vyhled not found");

    const currentOutlook = await readFileContent(token, stratFile.id, stratFile.mimeType);
    await createBackup(token, planFolderId, stratFile.name, currentOutlook);
    await overwriteDoc(token, stratFile.id, outlookContent);
    console.log(`[strategic] Written ${outlookContent.length} chars to 05B`);

    // === LOG ===
    await sb.from("system_health_log").insert({
      event_type: "strategic_outlook_update",
      severity: "info",
      message: `05B updated: ${medGoals.length} med goals, ${observations.length} observations, ${blockedGoals.length} blocked`,
      details: { med_goals: medGoals.length, observations: observations.length, blocked: blockedGoals.length },
    });

    await sb.from("plan_update_log").insert({
      plan_type: "strategic",
      goals_updated: medGoals.length,
      processing_time_ms: Date.now() - startTime,
    });

    return new Response(JSON.stringify({
      success: true,
      medGoals: medGoals.length,
      observations: observations.length,
      contentLength: outlookContent.length,
      processingTimeMs: Date.now() - startTime,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (error) {
    console.error("[strategic] Error:", error);
    await sb.from("plan_update_log").insert({
      plan_type: "strategic",
      error: error instanceof Error ? error.message : String(error),
      processing_time_ms: Date.now() - startTime,
    }).catch(() => {});
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "Unknown" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
