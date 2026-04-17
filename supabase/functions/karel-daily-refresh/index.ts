import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/auth.ts";
import { loadDriveRegistryEntries, type DriveRegistryEntry } from "../_shared/driveRegistry.ts";
import { computeDailyDiff } from "../_shared/dailyDiff.ts";

// OAuth2 token helper
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

async function findKartotekaAndCentrum(token: string): Promise<{ centrumFiles: Array<{ id: string; name: string; mimeType?: string }>; planFiles: Array<{ id: string; name: string; mimeType?: string }> }> {
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

  if (!kartotekaId) return { centrumFiles: [], planFiles: [] };

  // Find 00_CENTRUM
  const q2 = `'${kartotekaId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const r2 = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q2)}&fields=files(id,name)&pageSize=50&supportsAllDrives=true&includeItemsFromAllDrives=true`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const d2 = await r2.json();
  const centrumFolder = (d2.files || []).find((f: any) => /^00/.test(f.name.trim()) || f.name.toLowerCase().includes("centrum"));
  if (!centrumFolder) return { centrumFiles: [], planFiles: [] };

  // List files in 00_CENTRUM
  const q3 = `'${centrumFolder.id}' in parents and trashed=false`;
  const r3 = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q3)}&fields=files(id,name,mimeType)&pageSize=100&supportsAllDrives=true&includeItemsFromAllDrives=true`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const d3 = await r3.json();
  const centrumFiles = d3.files || [];

  // Find 05_PLAN subfolder
  const planFolder = centrumFiles.find((f: any) => f.mimeType === "application/vnd.google-apps.folder" && /05.*plan/i.test(f.name));
  let planFiles: Array<{ id: string; name: string; mimeType?: string }> = [];
  if (planFolder) {
    const q4 = `'${planFolder.id}' in parents and trashed=false`;
    const r4 = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q4)}&fields=files(id,name,mimeType)&pageSize=50&supportsAllDrives=true&includeItemsFromAllDrives=true`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const d4 = await r4.json();
    planFiles = d4.files || [];
  }

  return { centrumFiles, planFiles };
}

const strip = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

function buildClaimsSummary(claims: any[]): Record<string, any[]> {
  const byPart: Record<string, any[]> = {};
  for (const c of claims) {
    if (!byPart[c.part_name]) byPart[c.part_name] = [];
    byPart[c.part_name].push({
      section: c.card_section,
      type: c.claim_type,
      text: c.claim_text?.slice(0, 150),
      confidence: c.confidence,
      confirmations: c.confirmation_count,
      evidence: c.evidence_level,
    });
  }
  return byPart;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    // Resolve user_id (from auth or fallback)
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

    // FÁZE 2C: Prague-day everywhere (matches DID UI / planning logic).
    const pragueDayISO = (d: Date = new Date()): string =>
      new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Prague" }).format(d);
    const today = pragueDayISO();
    console.log(`[daily-refresh] Starting for user=${userId}, date=${today} (Europe/Prague)`);

    // ═══ 1. DRIVE: Read key CENTRUM documents ═══
    let dashboardText = "";
    let operativniPlanText = "";
    let strategickyVyhledText = "";
    let instrukceText = "";
    let pametKarelText = "";

    try {
      const token = await getAccessToken();
      const { centrumFiles, planFiles } = await findKartotekaAndCentrum(token);

      for (const f of centrumFiles) {
        if (f.mimeType === "application/vnd.google-apps.folder") continue;
        const cn = strip(f.name);
        try {
          if (cn.includes("dashboard")) {
            dashboardText = (await readDriveFile(token, f.id)).slice(0, 5000);
          } else if (cn.includes("instrukce") && cn.includes("karel")) {
            instrukceText = (await readDriveFile(token, f.id)).slice(0, 4000);
          } else if (cn.includes("pamet") && cn.includes("karel")) {
            pametKarelText = (await readDriveFile(token, f.id)).slice(0, 4000);
          }
        } catch (e) { console.warn(`[daily-refresh] Error reading ${f.name}:`, e); }
      }

      for (const f of planFiles) {
        const cn = strip(f.name);
        try {
          if (cn.includes("operativn") && cn.includes("plan")) {
            operativniPlanText = (await readDriveFile(token, f.id)).slice(0, 4000);
          } else if (cn.includes("strategick") && cn.includes("vyhled")) {
            strategickyVyhledText = (await readDriveFile(token, f.id)).slice(0, 4000);
          }
        } catch (e) { console.warn(`[daily-refresh] Error reading plan ${f.name}:`, e); }
      }

      console.log(`[daily-refresh] Drive: dashboard=${dashboardText.length}ch, plan=${operativniPlanText.length}ch, strategy=${strategickyVyhledText.length}ch, instrukce=${instrukceText.length}ch, pamet=${pametKarelText.length}ch`);

      // ═══ 1b. DRIVE INDEX → did_part_registry SYNC ═══
      // 01_Index_Vsech_Casti je autoritativní zdroj pravdy pro stavy částí.
      // Čteme ho z Drive, parsujeme a upsertujeme do DB.
      try {
        const registryEntries = await loadDriveRegistryEntries(token);
        console.log(`[daily-refresh] Drive index: ${registryEntries.length} entries found`);

        if (registryEntries.length > 0) {
          let syncedCount = 0;
          for (const entry of registryEntries) {
            if (!entry.primaryName) continue;

            // Mapování statusu z indexu (české → anglické)
            const rawStatus = entry.status.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
            let dbStatus = "sleeping";
            if (rawStatus.includes("aktiv") || rawStatus === "active") dbStatus = "active";
            else if (rawStatus.includes("spi") || rawStatus.includes("dormant") || rawStatus === "sleeping") dbStatus = "sleeping";

            const { error: upsErr } = await sb.from("did_part_registry").upsert(
              {
                user_id: userId,
                part_name: entry.primaryName,
                display_name: entry.primaryName,
                status: dbStatus,
                drive_folder_label: entry.id ? `${entry.id}_${entry.primaryName}` : entry.primaryName,
                updated_at: new Date().toISOString(),
              },
              { onConflict: "user_id,part_name" },
            );
            if (upsErr) {
              console.warn(`[daily-refresh] Upsert error for ${entry.primaryName}:`, upsErr.message);
            } else {
              syncedCount++;
            }
          }
          console.log(`[daily-refresh] ✅ Synced ${syncedCount}/${registryEntries.length} parts from Drive index → did_part_registry`);
        }
      } catch (indexErr) {
        console.warn("[daily-refresh] Drive index sync failed (non-fatal):", indexErr);
      }

    } catch (e) {
      console.warn("[daily-refresh] Drive read failed (non-fatal):", e);
    }

    // ═══ 2. DB: Aggregate current state (POST-SYNC – reflects Drive index) ═══
    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

    const [
      { data: parts },
      { data: tasks },
      { data: recentThreads },
      { data: profiles },
      { data: recentSessions },
      { data: planItems05A },
      { data: openQuestions },
      { data: activeClaims },
      { data: recentObservations },
    ] = await Promise.all([
      sb.from("did_part_registry").select("part_name, display_name, status, last_seen_at, cluster, age_estimate, last_emotional_state, last_emotional_intensity, health_score").eq("user_id", userId),
      sb.from("did_therapist_tasks").select("task, assigned_to, status, status_hanka, status_kata, priority, due_date, created_at, category, escalation_level").eq("user_id", userId).neq("status", "done").order("priority", { ascending: false }),
      sb.from("did_threads").select("part_name, sub_mode, thread_label, last_activity_at, started_at").eq("user_id", userId).order("last_activity_at", { ascending: false }).limit(20),
      sb.from("did_motivation_profiles").select("therapist, preferred_style, tasks_completed, tasks_missed, streak_current, avg_completion_days").eq("user_id", userId),
      sb.from("did_part_sessions").select("part_name, therapist, session_date, session_type, methods_used").eq("user_id", userId).order("session_date", { ascending: false }).limit(10),
      sb.from("did_plan_items").select("section, subject_id, content, priority, action_required, due_date").eq("plan_type", "05A").eq("status", "active").order("priority", { ascending: true }).limit(15),
      sb.from("did_pending_questions").select("question, subject_id, context, directed_to, status").eq("status", "open").order("created_at", { ascending: false }).limit(10),
      sb.from("did_profile_claims").select("part_name, card_section, claim_type, claim_text, confidence, confirmation_count, evidence_level").eq("status", "active").order("part_name", { ascending: true }).limit(30),
      sb.from("did_observations").select("subject_id, fact, evidence_level, created_at, source_type").eq("status", "active").gte("created_at", twoDaysAgo).order("created_at", { ascending: false }).limit(15),
    ]);

    // ═══ 3. Build structured context JSON ═══
    // Počty aktivních/spících nyní odrážejí stav PO synchronizaci s Drive indexem
    const activeParts = (parts || []).filter((p: any) => p.status === "active" || p.status === "aktivní");
    const sleepingParts = (parts || []).filter((p: any) => p.status === "sleeping" || p.status === "dormant");

    const recentCastThreads = (recentThreads || []).filter((t: any) => t.sub_mode === "cast");
    const recentTherapistThreads = (recentThreads || []).filter((t: any) => t.sub_mode === "mamka" || t.sub_mode === "kata");

    // ═══ FÁZE 3B: CANONICAL summary fields for frontend snapshot readers. ═══
    // Frontend (DidSystemOverview, KarelDailyPlan, atd.) NEMÁ resolvovat krizi/sezení
    // z legacy alert vrstev. Tyto pole jsou jediná pravda do `context_json`.
    let canonicalCrisisCount = 0;
    let canonicalCrisisList: Array<{ id: string; partName: string; severity: string | null; phase: string }> = [];
    let canonicalTodaySession: any = null;
    try {
      const { data: openCrises } = await sb
        .from("crisis_events")
        .select("id, part_name, severity, phase")
        .not("phase", "in", '("closed","CLOSED")')
        .order("opened_at", { ascending: false });
      canonicalCrisisList = (openCrises || []).map((c: any) => ({
        id: c.id, partName: c.part_name, severity: c.severity, phase: c.phase,
      }));
      canonicalCrisisCount = canonicalCrisisList.length;
    } catch (e) {
      console.warn("[daily-refresh] canonical crisis snapshot failed:", e);
    }
    try {
      const { data: todayPlan } = await sb
        .from("did_daily_session_plans")
        .select("id, selected_part, therapist, session_lead, urgency_score, status, crisis_event_id")
        .eq("plan_date", today)
        .in("status", ["pending", "planned", "generated", "in_progress"])
        .order("urgency_score", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (todayPlan) canonicalTodaySession = todayPlan;
    } catch (e) {
      console.warn("[daily-refresh] canonical session snapshot failed:", e);
    }

    const contextJson = {
      date: today,
      generated_at: new Date().toISOString(),

      // ═══ FÁZE 3B CANONICAL FIELDS — primary truth for frontend readers ═══
      // Frontend snapshot readers MUST use these instead of resolving from
      // legacy alert / planned_sessions / next_session_plan layers.
      canonical_crisis_count: canonicalCrisisCount,
      canonical_crises: canonicalCrisisList,
      canonical_today_session: canonicalTodaySession, // null = no canonical plan today
      canonical_queue: {
        plan_items_count: (planItems05A || []).length,
        manual_tasks_count: (tasks || []).length,
      },

      // Therapist profiles
      therapists: {
        hanka: {
          role: "první_terapeutka",
          profile: (profiles || []).find((p: any) => p.therapist === "Hanka") || null,
          note: "Životní partnerka Karla. Hlavní terapeutka DID systému.",
        },
        kata: {
          role: "druhá_terapeutka",
          is_NOT_a_part: true,
          profile: (profiles || []).find((p: any) => p.therapist === "Káťa") || null,
          note: "Káťa je DRUHÁ TERAPEUTKA, Hančina biologická dcera. NIKDY ji nezařazuj mezi části DID systému.",
        },
      },

      // Part registry snapshot
      parts: {
        active: activeParts.map((p: any) => ({
          name: p.part_name,
          display_name: p.display_name,
          cluster: p.cluster,
          age: p.age_estimate,
          emotional_state: p.last_emotional_state,
          emotional_intensity: p.last_emotional_intensity,
          health: p.health_score,
          last_seen: p.last_seen_at,
        })),
        sleeping: sleepingParts.map((p: any) => ({
          name: p.part_name,
          display_name: p.display_name,
          cluster: p.cluster,
          status: p.status,
        })),
      },

      // Activity classification
      recent_activity: {
        direct_activity: recentCastThreads.slice(0, 10).map((t: any) => ({
          part: t.part_name,
          label: t.thread_label,
          type: "direct_activity" as const,
          at: t.last_activity_at,
        })),
        therapist_mentions: recentTherapistThreads.slice(0, 10).map((t: any) => ({
          part: t.part_name,
          mentioned_by: t.sub_mode === "mamka" ? "Hanka" : "Káťa",
          type: "therapist_mention" as const,
          at: t.last_activity_at,
        })),
      },

      // Pending tasks
      pending_tasks: (tasks || []).slice(0, 15).map((t: any) => ({
        task: t.task,
        assigned_to: t.assigned_to,
        priority: t.priority,
        due_date: t.due_date,
        age_days: Math.floor((Date.now() - new Date(t.created_at).getTime()) / (1000 * 60 * 60 * 24)),
        escalation: t.escalation_level || 0,
        status_hanka: t.status_hanka,
        status_kata: t.status_kata,
      })),

      // Recent sessions
      recent_sessions: (recentSessions || []).slice(0, 5).map((s: any) => ({
        part: s.part_name,
        therapist: s.therapist,
        date: s.session_date,
        type: s.session_type,
        methods: s.methods_used,
      })),

      // Drive documents (summaries)
      drive_documents: {
        dashboard: dashboardText ? dashboardText.slice(0, 3000) : null,
        operativni_plan: operativniPlanText ? operativniPlanText.slice(0, 3000) : null,
        strategicky_vyhled: strategickyVyhledText ? strategickyVyhledText.slice(0, 2000) : null,
        instrukce_karel: instrukceText ? `[loaded, ${instrukceText.length} chars]` : null,
        pamet_karel: pametKarelText ? pametKarelText.slice(0, 2000) : null,
      },

      // ═══ PIPELINE DATA (Fáze 5) ═══
      pipeline: {
        plan_items_05A: (planItems05A || []).map((i: any) => ({
          subject: i.subject_id,
          content: i.content?.slice(0, 200),
          priority: i.priority,
          action: i.action_required?.slice(0, 150),
          due: i.due_date,
        })),
        open_questions: (openQuestions || []).map((q: any) => ({
          subject: q.subject_id,
          question: q.question,
          directed_to: q.directed_to,
        })),
        recent_observations: (recentObservations || []).map((o: any) => ({
          subject: o.subject_id,
          fact: o.fact?.slice(0, 200),
          evidence: o.evidence_level,
          source: o.source_type,
          at: o.created_at?.slice(0, 16),
        })),
        active_claims_summary: buildClaimsSummary(activeClaims || []),
      },
    };

    // ═══ 4. FÁZE 2B: Compute daily diff vs. yesterday ═══
    let dailyDiff: ReturnType<typeof computeDailyDiff> | null = null;
    try {
      const yesterdayDate = pragueDayISO(
        new Date(Date.now() - 24 * 60 * 60 * 1000),
      );
      const { data: yesterdayCtx } = await sb
        .from("did_daily_context")
        .select("context_json")
        .eq("user_id", userId)
        .eq("context_date", yesterdayDate)
        .maybeSingle();

      dailyDiff = computeDailyDiff(
        contextJson as any,
        (yesterdayCtx?.context_json as any) || null,
      );
      console.log(`[daily-refresh] diff: ${dailyDiff.summary_line}`);
    } catch (diffErr) {
      console.warn("[daily-refresh] diff computation failed (non-fatal):", diffErr);
    }

    // Inline diff into context_json so existing readers see it
    const enrichedContextJson = {
      ...contextJson,
      diff: dailyDiff || null,
    };

    // ═══ 5. Upsert into did_daily_context (with diff in analysis_json) ═══
    const { error: upsertError } = await sb.from("did_daily_context").upsert(
      {
        user_id: userId,
        context_date: today,
        context_json: enrichedContextJson,
        analysis_json: dailyDiff ? { daily_diff: dailyDiff } : null,
        source: "karel-daily-refresh",
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,context_date" },
    );

    if (upsertError) {
      console.error("[daily-refresh] Upsert error:", upsertError);
      return new Response(JSON.stringify({ error: upsertError.message }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    console.log(`[daily-refresh] ✅ Context saved: ${JSON.stringify(enrichedContextJson).length} bytes, parts=${(parts || []).length}, tasks=${(tasks || []).length}, diff_new=${dailyDiff?.new_items.length || 0}, diff_worse=${dailyDiff?.worse_items.length || 0}`);

    return new Response(JSON.stringify({
      success: true,
      date: today,
      stats: {
        active_parts: activeParts.length,
        sleeping_parts: sleepingParts.length,
        pending_tasks: (tasks || []).length,
        drive_docs_loaded: Object.values(contextJson.drive_documents).filter(Boolean).length,
        context_size_bytes: JSON.stringify(enrichedContextJson).length,
        diff: dailyDiff
          ? {
              new: dailyDiff.new_items.length,
              worse: dailyDiff.worse_items.length,
              changed: dailyDiff.changed_items.length,
              unconfirmed: dailyDiff.unconfirmed_items.length,
              has_yesterday: dailyDiff.has_yesterday,
            }
          : null,
      },
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (error) {
    console.error("[daily-refresh] Error:", error);
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
