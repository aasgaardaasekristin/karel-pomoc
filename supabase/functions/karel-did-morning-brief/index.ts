import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Resend } from "npm:resend@2.0.0";
import { corsHeaders } from "../_shared/auth.ts";
import { SYSTEM_RULES } from "../_shared/system-rules.ts";

/**
 * karel-did-morning-brief — Morning brief for therapists.
 * 
 * PRIMARY data source: did_daily_context.analysis_json
 * SECONDARY: Drive (operativní plán), DB (tasks, threads)
 */

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

// Drive helpers
async function findFolder(token: string, name: string): Promise<string | null> {
  const q = `name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const params = new URLSearchParams({ q, fields: "files(id)", pageSize: "50", supportsAllDrives: "true", includeItemsFromAllDrives: "true" });
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  return data.files?.[0]?.id || null;
}

async function listFilesInFolder(token: string, folderId: string): Promise<Array<{ id: string; name: string; mimeType?: string }>> {
  const q = `'${folderId}' in parents and trashed=false`;
  const allFiles: Array<{ id: string; name: string; mimeType?: string }> = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({ q, fields: "nextPageToken,files(id,name,mimeType)", pageSize: "200", supportsAllDrives: "true", includeItemsFromAllDrives: "true" });
    if (pageToken) params.set("pageToken", pageToken);
    const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json();
    allFiles.push(...(data.files || []));
    pageToken = data.nextPageToken || undefined;
  } while (pageToken);
  return allFiles;
}

async function readFileContent(token: string, fileId: string): Promise<string> {
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const exportRes = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/plain&supportsAllDrives=true`, { headers: { Authorization: `Bearer ${token}` } });
    if (!exportRes.ok) throw new Error(`Cannot read file ${fileId}: ${exportRes.status}`);
    return await exportRes.text();
  }
  return await res.text();
}

const truncate = (s: string, max: number) => s.length > max ? s.slice(0, max) + "…" : s;

// ═══ FORMAT analysis_json HELPERS ═══

function formatAnalysisTherapist(analysis: any, name: string): string {
  const t = analysis?.therapists?.[name];
  if (!t) return "  (data nedostupná)";
  const sit = t.situational || {};
  return [
    `  Energie: ${sit.energy || "?"}`,
    sit.health ? `  Zdraví: ${sit.health}` : null,
    sit.current_stressors?.length ? `  Stresory: ${sit.current_stressors.join(", ")}` : null,
    sit.notes ? `  Poznámky: ${sit.notes}` : null,
  ].filter(Boolean).join("\n");
}

function formatAnalysisParts(analysis: any): string {
  const parts = analysis?.parts;
  if (!Array.isArray(parts) || parts.length === 0) return "(žádné části)";

  const active = parts.filter((p: any) => p.status === "active");
  const sleeping = parts.filter((p: any) => p.status === "sleeping");

  let out = "";
  if (active.length > 0) {
    out += `AKTIVNÍ (${active.length}):\n`;
    out += active.map((p: any) => {
      const rec = p.session_recommendation;
      const recStr = rec?.needed ? ` → SEZENÍ: ${rec.who_leads}, ${rec.priority}` : "";
      return `  ▸ ${p.name} | riziko: ${p.risk_level} | emoce: ${p.recent_emotions || "?"}${recStr}`;
    }).join("\n");
  }
  if (sleeping.length > 0) {
    out += `\nSPÍCÍ (${sleeping.length}): ${sleeping.map((p: any) => p.name).join(", ")}`;
  }
  return out;
}

function formatSessionRecs(analysis: any): string {
  const parts = analysis?.parts;
  if (!Array.isArray(parts)) return "(žádná)";
  const recs = parts.filter((p: any) => p.session_recommendation?.needed === true);
  if (recs.length === 0) return "(žádná doporučená sezení)";
  return recs.map((p: any) => {
    const r = p.session_recommendation;
    return `  ▸ ${p.name}: vede ${r.who_leads}, priorita: ${r.priority}, cíle: ${(r.goals || []).join(", ")}`;
  }).join("\n");
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const authHeader = req.headers.get("Authorization") || "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || "";
  const bearerToken = authHeader.startsWith("Bearer ") ? authHeader.replace("Bearer ", "") : "";

  let requestBody: Record<string, unknown> = {};
  try { requestBody = await req.json(); } catch { requestBody = {}; }

  const source = typeof requestBody.source === "string" ? requestBody.source.trim().toLowerCase() : "cron";
  const isCronCall = source === "cron";

  if (isCronCall) {
    const allowed = [serviceRoleKey, anonKey].filter(Boolean);
    if (!bearerToken || !allowed.includes(bearerToken)) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }

  const supabaseAdmin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  try {
    const today = new Date();
    const dayName = today.toLocaleDateString("cs-CZ", { weekday: "long" });
    const dateStr = today.toLocaleDateString("cs-CZ", { day: "numeric", month: "long", year: "numeric" });

    // ═══ 1. LOAD analysis_json AS PRIMARY SOURCE ═══
    const { data: dailyCtx } = await (supabaseAdmin as any).from("did_daily_context")
      .select("context_json, analysis_json, context_date")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const analysis = dailyCtx?.analysis_json || null;
    const hasAnalysis = !!analysis;
    console.log(`[morning-brief] analysis_json available: ${hasAnalysis}, date: ${dailyCtx?.context_date || "none"}`);

    // ═══ 2. SUPPLEMENTARY: tasks, threads, Drive ═══
    const cutoff24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const [tasksRes, threadsRes, profilesRes, lastCycleRes] = await Promise.all([
      supabaseAdmin.from("did_therapist_tasks")
        .select("task, assigned_to, status, status_hanka, status_kata, priority, due_date, created_at, escalation_level, category")
        .neq("status", "done")
        .order("priority", { ascending: false }),
      supabaseAdmin.from("did_threads")
        .select("part_name, last_activity_at, sub_mode, messages")
        .eq("sub_mode", "cast")
        .gte("last_activity_at", cutoff24h)
        .order("last_activity_at", { ascending: false }),
      supabaseAdmin.from("did_motivation_profiles").select("*"),
      supabaseAdmin.from("did_update_cycles")
        .select("completed_at, report_summary")
        .eq("cycle_type", "daily")
        .eq("status", "completed")
        .order("completed_at", { ascending: false })
        .limit(1),
    ]);

    const tasks = tasksRes.data || [];
    const recentThreads = threadsRes.data || [];
    const profiles = profilesRes.data || [];
    const lastCycle = lastCycleRes.data || [];

    // Read Drive: operativní plán
    let operativniPlan = "";
    try {
      const token = await getAccessToken();
      const kartotekaId = await findFolder(token, "kartoteka_DID");
      if (kartotekaId) {
        const folders = await listFilesInFolder(token, kartotekaId);
        const centrumFolder = folders.find(f => f.name.includes("00_CENTRUM") || /^00/.test(f.name));
        if (centrumFolder) {
          const centrumFiles = await listFilesInFolder(token, centrumFolder.id);
          const planFolder = centrumFiles.find(f =>
            f.mimeType === "application/vnd.google-apps.folder" &&
            (/^05.*plan/i.test(f.name) || f.name.includes("05_PLAN"))
          );
          if (planFolder) {
            const planFiles = await listFilesInFolder(token, planFolder.id);
            const opFile = planFiles.find(f => f.name.includes("05_Operativni"));
            if (opFile) operativniPlan = truncate(await readFileContent(token, opFile.id), 3000);
          }
          if (!operativniPlan) {
            const opFileLegacy = centrumFiles.find(f => f.name.includes("05_Operativni"));
            if (opFileLegacy) operativniPlan = truncate(await readFileContent(token, opFileLegacy.id), 3000);
          }
        }
      }
    } catch (e) {
      console.warn("Drive read error (non-fatal):", e);
    }

    // ═══ 3. BUILD CONTEXT ═══
    const taskList = tasks.map((t: any) => {
      const age = Math.floor((Date.now() - new Date(t.created_at).getTime()) / (1000 * 60 * 60 * 24));
      const esc = (t.escalation_level || 0) >= 1 ? ` ⚠️L${t.escalation_level}` : "";
      return `- [${t.priority}${esc}] ${t.task} (pro: ${t.assigned_to}, H:${t.status_hanka}, K:${t.status_kata}, ${age}d)`;
    }).join("\n");

    const recentActivity = recentThreads
      .filter((t: any) => Array.isArray(t.messages) && t.messages.some((m: any) => m?.role === "user" && typeof m?.content === "string" && m.content.trim().length > 0))
      .map((t: any) => {
        const rawName = String(t.part_name || "").trim();
        const canonicalName = /^(dymi|dymytri|dymitri|dmytri)$/i.test(rawName) ? "DMYTRI" : rawName.split(/[\n,;|]+/)[0].trim();
        return `- ${canonicalName} — ${new Date(t.last_activity_at).toLocaleTimeString("cs-CZ", { hour: "2-digit", minute: "2-digit" })}`;
      }).join("\n");

    const hankaProfile = profiles.find((p: any) => p.therapist === "Hanka");
    const kataProfile = profiles.find((p: any) => p.therapist === "Káťa");

    // ═══ 4. AI GENERATES BRIEFS ═══
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY not configured");

    const generateBrief = async (therapist: "Hanka" | "Káťa"): Promise<string> => {
      const profile = therapist === "Hanka" ? hankaProfile : kataProfile;
      const profileInfo = profile
        ? `Splněno: ${profile.tasks_completed}, nesplněno: ${profile.tasks_missed}, série: ${profile.streak_current}, styl: ${profile.preferred_style}`
        : "Profil zatím nedostupný";

      const analysisRules = hasAnalysis ? `
KRITICKÁ PRAVIDLA:
1. NEPOPISUJ část jako „aktivní", pokud v DENNÍ ANALÝZE nemá status = "active".
2. NEZADÁVEJ sezení se spící částí, pokud v analýze nemá session_recommendation.needed = true.
3. Vycházej PRIMÁRNĚ z DENNÍ ANALÝZY. Vlákna a syrová data používej jen jako doplnění.
4. Káťa a Hanka jsou TERAPEUTKY, ne části DID systému. NIKDY je nezařazuj mezi DID části.
5. Spící části NIKDY nenavrhuj na sezení ani úkoly.
6. Locík je PES – NIKDY DID část. NIKDY ho nezmiňuj v kontextu DID systému.
7. ŽÁDNÉ intimní oslovení: "miláčku", "lásko", "drahá" jsou ZAKÁZANÉ. Používej "Haničko"/"Hani" a "Káťo".
8. NIKDY do briefu nezařazuj osobní emoční stavy terapeutek, pocit viny, osobní trauma.
9. U každého návrhu sezení MUSÍŠ uvést: konkrétní techniku, cíle, otevírací větu.
` : "";

      const systemPrompt = `Jsi Karel, AI terapeut specializovaný na DID. Píšeš ranní brief pro ${therapist === "Hanka" ? "Haničku (mamka, denní péče, Písek, emoční zázemí)" : "Káťu (koordinace na dálku, Budějovice, škola Townshend, senzorická terapie)"}.
${analysisRules}
FORMÁT (max 20 řádků, stručný, motivační, konkrétní):

☀️ Dobré ráno, ${therapist === "Hanka" ? "Haničko" : "Káťo"}! (${dayName}, ${dateStr})

🎯 PRIORITA DNE:
[1 hlavní věc z analýzy/operativního plánu]

👥 AKTIVNÍ ČÁSTI:
[POUZE části se status "active" z analýzy – jméno, riziko, emoce]

📋 DOPORUČENÁ SEZENÍ:
[POUZE z session_recommendation.needed = true]

📋 ÚKOLY K VYŘÍZENÍ:
[Max 3 nejdůležitější nesplněné úkoly]

${therapist === "Hanka" ? "👶" : "📱"} TIP PRO DNES:
[Na základě analýzy – konkrétní, ne obecný]

💪 MOTIVACE:
[Krátká pochvala na míru profilu]

PRAVIDLA:
- NIKDY nenavrhuj dechová cvičení (klientka má epilepsii)
- Buď stručný, konkrétní, laskavý
- Piš česky`;

      // USER prompt: analysis first
      let userContent = "";
      if (hasAnalysis) {
        const therapistKey = therapist === "Hanka" ? "Hanka" : "Kata";
        userContent += `═══ DENNÍ ANALÝZA (PRIMÁRNÍ ZDROJ) ═══

STAV TERAPEUTEK:
HANKA:
${formatAnalysisTherapist(analysis, "Hanka")}
KÁŤA:
${formatAnalysisTherapist(analysis, "Kata")}

ČÁSTI DID SYSTÉMU:
${formatAnalysisParts(analysis)}

DOPORUČENÁ SEZENÍ:
${formatSessionRecs(analysis)}

POZOROVÁNÍ TÝMU:
${analysis.team_observations?.cooperation || ""}
${(analysis.team_observations?.warnings || []).join("; ")}
${(analysis.team_observations?.praise || []).join("; ")}

═══ DOPLŇUJÍCÍ DATA ═══
`;
      }

      userContent += `NESPLNĚNÉ ÚKOLY:
${taskList || "(žádné)"}

AKTIVITA ZA POSLEDNÍCH 24H (cast režim):
${recentActivity || "(žádná)"}

OPERATIVNÍ PLÁN:
${operativniPlan || "(nedostupný)"}

MOTIVAČNÍ PROFIL ${therapist.toUpperCase()}:
${profileInfo}

POSLEDNÍ DENNÍ REPORT:
${lastCycle?.[0]?.report_summary ? truncate(lastCycle[0].report_summary, 1000) : "(žádný)"}`;

      const resp = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "google/gemini-2.5-flash-lite",
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userContent },
          ],
        }),
      });

      if (!resp.ok) {
        console.error(`AI brief error for ${therapist}:`, resp.status);
        return `☀️ Dobré ráno, ${therapist === "Hanka" ? "Haničko" : "Káťo"}! (${dayName})\n\n📋 ${tasks.length} nesplněných úkolů čeká.\n\n💪 Ať se ti dnes daří!`;
      }

      const data = await resp.json();
      return data.choices?.[0]?.message?.content || `Dobré ráno! Dnes je ${dayName}.`;
    };

    const [hankaBrief, kataBrief] = await Promise.all([
      generateBrief("Hanka"),
      generateBrief("Káťa"),
    ]);

    // ═══ 5. SEND EMAILS ═══
    const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
    if (!RESEND_API_KEY) throw new Error("RESEND_API_KEY not configured");

    const resend = new Resend(RESEND_API_KEY);
    const KATA_EMAIL = Deno.env.get("KATA_EMAIL");
    const MAMKA_EMAIL = "mujosobniasistentnamiru@gmail.com";

    const subject = `☀️ Karlův ranní brief — ${dateStr}`;
    const results: string[] = [];

    const toHtml = (text: string) => `<div style="font-family: 'Segoe UI', sans-serif; font-size: 14px; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
<pre style="white-space: pre-wrap; font-family: inherit;">${text}</pre>
<hr style="border: none; border-top: 1px solid #eee; margin-top: 24px;">
<p style="font-size: 11px; color: #999;">Automatický ranní brief od Karla • DID systém</p>
</div>`;

    try {
      const { error } = await resend.emails.send({
        from: "Karel <karel@hana-chlebcova.cz>",
        to: [MAMKA_EMAIL],
        subject,
        html: toHtml(hankaBrief),
      });
      if (error) throw error;
      results.push("Hanka: sent");
    } catch (e) {
      results.push(`Hanka: error (${e})`);
      console.error("Failed to send brief to Hanka:", e);
    }

    if (KATA_EMAIL) {
      try {
        const { error } = await resend.emails.send({
          from: "Karel <karel@hana-chlebcova.cz>",
          to: [KATA_EMAIL],
          subject,
          html: toHtml(kataBrief),
        });
        if (error) throw error;
        results.push("Káťa: sent");
      } catch (e) {
        results.push(`Káťa: error (${e})`);
        console.error("Failed to send brief to Káťa:", e);
      }
    }

    return new Response(JSON.stringify({
      success: true,
      results,
      date: dateStr,
      analysisAvailable: hasAnalysis,
      analysisDate: dailyCtx?.context_date || null,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("Morning brief error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
