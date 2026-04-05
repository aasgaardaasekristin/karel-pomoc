import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/auth.ts";
import {
  getAccessToken, resolveKartotekaRoot, findFolder, listFiles,
  readFileContent, overwriteDoc, createBackup,
  FOLDER_MIME, GDOC_MIME,
} from "../_shared/driveHelpers.ts";

const today = () => new Date().toISOString().slice(0, 10);
const pastDate = (days: number) => new Date(Date.now() - days * 86400000).toISOString();

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const startTime = Date.now();
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  try {
    // === LOAD ALL DATA IN PARALLEL ===
    const [
      longGoalsRes, stratGoalsRes,
      partsActiveRes, partsInactiveRes, profilesRes,
      evaluationsRes
    ] = await Promise.all([
      // Sekce 1
      sb.from("part_goals").select("*").eq("goal_type", "long").eq("status", "active"),
      sb.from("strategic_goals").select("*").eq("status", "active"),
      // Sekce 2
      sb.from("did_part_registry").select("part_name,display_name,status,last_seen_at,health_score").or("status.eq.active,status.eq.Aktivní"),
      // Sekce 3
      sb.from("did_part_registry").select("part_name,display_name,status,last_seen_at,health_score,notes").not("status", "in", "(active,Aktivní)"),
      sb.from("did_part_profiles").select("part_name,therapeutic_approach,challenges,strengths,needs"),
      // Sekce 4
      sb.from("goal_evaluations").select("*").gte("created_at", pastDate(90)).order("created_at", { ascending: false }),
    ]);

    const longGoals = longGoalsRes.data || [];
    const stratGoals = stratGoalsRes.data || [];
    const partsActive = partsActiveRes.data || [];
    const partsInactive = partsInactiveRes.data || [];
    const profiles = profilesRes.data || [];
    const evaluations = evaluationsRes.data || [];

    const profileMap = new Map(profiles.map((p: any) => [p.part_name, p]));

    // === BUILD 05C CONTENT ===
    const lines: string[] = [];
    lines.push(`═══ DLOUHODOBÝ VÝHLED ═══`);
    lines.push(`Aktualizováno: ${today()}\n`);

    // --- SEKCE 1: Celkové cíle DID systému (3-12 měsíců) ---
    lines.push(`━━━ 1. CELKOVÉ CÍLE DID SYSTÉMU (3-12 MĚSÍCŮ) ━━━\n`);
    if (longGoals.length) {
      lines.push(`DLOUHODOBÉ CÍLE ČÁSTÍ:`);
      for (const g of longGoals) {
        lines.push(`  • [${g.part_name || 'systém'}] ${g.goal_text} (${g.progress_pct}%, kategorie: ${g.category || '?'})`);
        if (g.description) lines.push(`    ${g.description.slice(0, 150)}`);
      }
    }
    if (stratGoals.length) {
      lines.push(`\nSTRATEGICKÉ CÍLE:`);
      for (const g of stratGoals) {
        lines.push(`  • [${g.part_name || 'systém'}] ${g.goal_text} (${g.progress_pct}%)`);
        if (g.evidence?.length) lines.push(`    Evidence: ${g.evidence.slice(0, 3).join('; ')}`);
      }
    }
    if (!longGoals.length && !stratGoals.length) {
      lines.push(`  (žádné dlouhodobé cíle)`);
    }

    // --- SEKCE 2: Integrační trajektorie ---
    lines.push(`\n━━━ 2. INTEGRAČNÍ TRAJEKTORIE ━━━\n`);
    for (const p of partsActive) {
      const profile = profileMap.get(p.part_name);
      const partLongGoals = longGoals.filter((g: any) => g.part_name === p.part_name);
      lines.push(`▸ ${p.display_name || p.part_name}`);
      lines.push(`  Health: ${p.health_score ?? '?'} | Poslední kontakt: ${p.last_seen_at?.slice(0, 10) || 'nikdy'}`);
      if (profile?.therapeutic_approach) {
        lines.push(`  Terapeutický přístup: ${(profile.therapeutic_approach as string).slice(0, 150)}`);
      }
      if (profile?.challenges) {
        lines.push(`  Výzvy: ${(profile.challenges as string).slice(0, 150)}`);
      }
      if (partLongGoals.length) {
        for (const g of partLongGoals) {
          lines.push(`  Dlouhodobý cíl: ${g.goal_text} (${g.progress_pct}%)`);
        }
      } else {
        lines.push(`  ℹ️ Nemá definovaný dlouhodobý cíl`);
      }
    }

    // --- SEKCE 3: Spící části — plán aktivizace ---
    lines.push(`\n━━━ 3. SPÍCÍ ČÁSTI — PLÁN AKTIVIZACE ━━━\n`);
    if (partsInactive.length) {
      for (const p of partsInactive) {
        const profile = profileMap.get(p.part_name);
        const hasGoals = longGoals.some((g: any) => g.part_name === p.part_name);
        lines.push(`▸ ${p.display_name || p.part_name} (status: ${p.status})`);
        lines.push(`  Naposledy aktivní: ${p.last_seen_at?.slice(0, 10) || 'neznámo'}`);
        lines.push(`  Health: ${p.health_score ?? '?'} | Má cíle: ${hasGoals ? 'ano' : 'ne'}`);
        if (profile?.needs) lines.push(`  Potřeby: ${(profile.needs as string).slice(0, 120)}`);
        if (p.notes) lines.push(`  Poznámka: ${(p.notes as string).slice(0, 120)}`);
        const potential = (p.health_score && p.health_score > 30) || hasGoals ? 'STŘEDNÍ-VYSOKÝ' : 'NÍZKÝ';
        lines.push(`  Potenciál aktivizace: ${potential}`);
      }
    } else {
      lines.push(`  (žádné spící části)`);
    }

    // --- SEKCE 4: Systémové milníky ---
    lines.push(`\n━━━ 4. SYSTÉMOVÉ MILNÍKY (posledních 90 dní) ━━━\n`);
    if (evaluations.length) {
      for (const e of evaluations) {
        lines.push(`  • ${e.created_at?.slice(0, 10)}: ${e.previous_progress}% → ${e.new_progress}% — ${e.evaluation_text?.slice(0, 150)}`);
        if (e.evidence) lines.push(`    Evidence: ${(e.evidence as string).slice(0, 120)}`);
      }
    } else {
      lines.push(`  (žádné evaluace za 90 dní)`);
    }

    const longtermContent = lines.join("\n");

    // === WRITE TO DRIVE ===
    const token = await getAccessToken();
    const root = await resolveKartotekaRoot(token);
    if (!root) throw new Error("KARTOTEKA_DID not found");

    const centrumId = await findFolder(token, "00_CENTRUM", root);
    if (!centrumId) throw new Error("00_CENTRUM not found");
    const planFolderId = await findFolder(token, "05_PLAN", centrumId);
    if (!planFolderId) throw new Error("05_PLAN not found");

    // Find or create 05C
    const planFiles = await listFiles(token, planFolderId);
    let ltFile = planFiles.find(f => f.name.includes("05C") || f.name.includes("Dlouhodob"));

    if (!ltFile) {
      // Create new Google Doc
      const createRes = await fetch("https://www.googleapis.com/drive/v3/files", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "05C_Dlouhodoby_Vyhled", parents: [planFolderId], mimeType: GDOC_MIME }),
      });
      if (!createRes.ok) throw new Error(`Create 05C failed: ${createRes.status}`);
      const newFile = await createRes.json();
      ltFile = { id: newFile.id, name: newFile.name, mimeType: GDOC_MIME };
      console.log(`[longterm] Created new 05C: ${newFile.id}`);
    } else {
      // Backup existing
      const currentContent = await readFileContent(token, ltFile.id, ltFile.mimeType);
      await createBackup(token, planFolderId, ltFile.name, currentContent);
    }

    await overwriteDoc(token, ltFile.id, longtermContent);
    console.log(`[longterm] Written ${longtermContent.length} chars to 05C`);

    // === LOG ===
    await sb.from("system_health_log").insert({
      event_type: "longterm_outlook_update",
      severity: "info",
      message: `05C updated: ${longGoals.length} long goals, ${stratGoals.length} strategic, ${partsInactive.length} sleeping parts`,
      details: { long_goals: longGoals.length, strategic_goals: stratGoals.length, inactive_parts: partsInactive.length, evaluations: evaluations.length },
    });

    await sb.from("plan_update_log").insert({
      plan_type: "longterm",
      goals_updated: longGoals.length + stratGoals.length,
      processing_time_ms: Date.now() - startTime,
    });

    return new Response(JSON.stringify({
      success: true,
      longGoals: longGoals.length,
      strategicGoals: stratGoals.length,
      inactiveParts: partsInactive.length,
      contentLength: longtermContent.length,
      processingTimeMs: Date.now() - startTime,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (error) {
    console.error("[longterm] Error:", error);
    await sb.from("plan_update_log").insert({
      plan_type: "longterm",
      error: error instanceof Error ? error.message : String(error),
      processing_time_ms: Date.now() - startTime,
    }).catch(() => {});
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "Unknown" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
