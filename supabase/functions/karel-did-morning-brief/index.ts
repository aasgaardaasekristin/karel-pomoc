import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Resend } from "npm:resend@2.0.0";
import { corsHeaders } from "../_shared/auth.ts";

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

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  // Accept both cron (anon/service role) and manual triggers
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
    // ═══ 1. GATHER DATA ═══
    const today = new Date();
    const dayName = today.toLocaleDateString("cs-CZ", { weekday: "long" });
    const dateStr = today.toLocaleDateString("cs-CZ", { day: "numeric", month: "long", year: "numeric" });

    // Pending tasks
    const { data: tasks } = await supabaseAdmin.from("did_therapist_tasks")
      .select("task, assigned_to, status, status_hanka, status_kata, priority, due_date, created_at, escalation_level, category")
      .neq("status", "done")
      .order("priority", { ascending: false });

    // Motivation profiles
    const { data: profiles } = await supabaseAdmin.from("did_motivation_profiles").select("*");

    // Recent direct part activity (last 24h) — only cast threads with direct user messages
    const cutoff24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: recentThreads } = await supabaseAdmin.from("did_threads")
      .select("part_name, last_activity_at, sub_mode, messages")
      .eq("sub_mode", "cast")
      .gte("last_activity_at", cutoff24h)
      .order("last_activity_at", { ascending: false });

    // Last daily cycle
    const { data: lastCycle } = await supabaseAdmin.from("did_update_cycles")
      .select("completed_at, report_summary")
      .eq("cycle_type", "daily")
      .eq("status", "completed")
      .order("completed_at", { ascending: false })
      .limit(1);

    // Read Drive: 05_Operativni_Plan for today's priorities
    let operativniPlan = "";
    try {
      const token = await getAccessToken();
      const kartotekaId = await findFolder(token, "kartoteka_DID");
      if (kartotekaId) {
        const folders = await listFilesInFolder(token, kartotekaId);
        const centrumFolder = folders.find(f => f.name.includes("00_CENTRUM"));
        if (centrumFolder) {
          const centrumFiles = await listFilesInFolder(token, centrumFolder.id);
          const opFile = centrumFiles.find(f => f.name.includes("05_Operativni"));
          if (opFile) {
            operativniPlan = truncate(await readFileContent(token, opFile.id), 3000);
          }
        }
      }
    } catch (e) {
      console.warn("Drive read error (non-fatal):", e);
    }

    // ═══ 2. BUILD CONTEXT ═══
    const taskList = (tasks || []).map((t: any) => {
      const age = Math.floor((Date.now() - new Date(t.created_at).getTime()) / (1000 * 60 * 60 * 24));
      const esc = (t.escalation_level || 0) >= 1 ? ` ⚠️L${t.escalation_level}` : "";
      return `- [${t.priority}${esc}] ${t.task} (pro: ${t.assigned_to}, H:${t.status_hanka}, K:${t.status_kata}, ${age}d)`;
    }).join("\n");

    const recentActivity = (recentThreads || []).map((t: any) =>
      `- ${t.part_name} (${t.sub_mode}) — ${new Date(t.last_activity_at).toLocaleTimeString("cs-CZ", { hour: "2-digit", minute: "2-digit" })}`
    ).join("\n");

    const hankaProfile = (profiles || []).find((p: any) => p.therapist === "Hanka");
    const kataProfile = (profiles || []).find((p: any) => p.therapist === "Káťa");

    // ═══ 3. AI GENERATES BRIEFS ═══
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY not configured");

    const generateBrief = async (therapist: "Hanka" | "Káťa"): Promise<string> => {
      const profile = therapist === "Hanka" ? hankaProfile : kataProfile;
      const profileInfo = profile
        ? `Splněno: ${profile.tasks_completed}, nesplněno: ${profile.tasks_missed}, série: ${profile.streak_current}, styl: ${profile.preferred_style}`
        : "Profil zatím nedostupný";

      const systemPrompt = `Jsi Karel, AI terapeut specializovaný na DID. Píšeš ranní brief pro ${therapist === "Hanka" ? "Haničku (mamka, denní péče, Písek, emoční zázemí)" : "Káťu (koordinace na dálku, Budějovice, škola Townshend, senzorická terapie)"}.

FORMÁT (max 15 řádků, stručný, motivační, konkrétní):

☀️ Dobré ráno, ${therapist === "Hanka" ? "Haničko" : "Káťo"}! (${dayName}, ${dateStr})

🎯 PRIORITA DNE:
[1 hlavní věc na dnešek z operativního plánu]

📋 ÚKOLY K VYŘÍZENÍ:
[Max 3 nejdůležitější nesplněné úkoly s termíny]

${therapist === "Hanka" ? "👶" : "📱"} TIP PRO DNES:
[Personalizovaný tip pro práci s částmi na základě aktuální aktivity]

💪 MOTIVACE:
[Krátká pochvala nebo povzbuzení na míru profilu]

PRAVIDLA:
- NIKDY nenavrhuj dechová cvičení (klientka má epilepsii)
- Buď stručný, konkrétní, laskavý
- Piš česky
- Pokud není co říct, řekni "Dnes je klid, užij si den!"`;

      const userContent = `NESPLNĚNÉ ÚKOLY:
${taskList || "(žádné)"}

AKTIVITA ZA POSLEDNÍCH 24H:
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
        return `☀️ Dobré ráno, ${therapist === "Hanka" ? "Haničko" : "Káťo"}! (${dayName})\n\n📋 ${(tasks || []).length} nesplněných úkolů čeká.\n\n💪 Ať se ti dnes daří!`;
      }

      const data = await resp.json();
      return data.choices?.[0]?.message?.content || `Dobré ráno! Dnes je ${dayName}.`;
    };

    // Generate briefs for both therapists in parallel
    const [hankaBrief, kataBrief] = await Promise.all([
      generateBrief("Hanka"),
      generateBrief("Káťa"),
    ]);

    // ═══ 4. SEND EMAILS ═══
    const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
    if (!RESEND_API_KEY) throw new Error("RESEND_API_KEY not configured");

    const resend = new Resend(RESEND_API_KEY);
    const KATA_EMAIL = Deno.env.get("KATA_EMAIL");
    const MAMKA_EMAIL = "mujosobniasistentnamiru@gmail.com";

    const subject = `☀️ Karlův ranní brief — ${dateStr}`;
    const results: string[] = [];

    // Format as HTML
    const toHtml = (text: string) => `<div style="font-family: 'Segoe UI', sans-serif; font-size: 14px; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
<pre style="white-space: pre-wrap; font-family: inherit;">${text}</pre>
<hr style="border: none; border-top: 1px solid #eee; margin-top: 24px;">
<p style="font-size: 11px; color: #999;">Automatický ranní brief od Karla • DID systém</p>
</div>`;

    // Send to Hanka
    try {
      const { error } = await resend.emails.send({
        from: "Karel <karel@hana-chlebcova.cz>",
        to: [MAMKA_EMAIL],
        subject,
        html: toHtml(hankaBrief),
      });
      if (error) throw error;
      results.push("Hanka: sent");
      console.log("Morning brief sent to Hanka");
    } catch (e) {
      results.push(`Hanka: error (${e})`);
      console.error("Failed to send brief to Hanka:", e);
    }

    // Send to Káťa
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
        console.log("Morning brief sent to Káťa");
      } catch (e) {
        results.push(`Káťa: error (${e})`);
        console.error("Failed to send brief to Káťa:", e);
      }
    }

    return new Response(JSON.stringify({
      success: true,
      results,
      date: dateStr,
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
