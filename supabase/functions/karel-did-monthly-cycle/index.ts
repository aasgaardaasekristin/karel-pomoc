import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Resend } from "npm:resend@2.0.0";
import { requireAuth, corsHeaders } from "../_shared/auth.ts";

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
const canonicalText = (v: string) => v.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\.(txt|md|doc|docx|xls|xlsx)$/gi, "").replace(/[^a-z0-9]/g, "");

async function appendToDoc(token: string, fileId: string, textToAppend: string): Promise<void> {
  const docRes = await fetch(`https://docs.googleapis.com/v1/documents/${fileId}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!docRes.ok) return;
  const doc = await docRes.json();
  const endIndex = doc.body?.content?.slice(-1)?.[0]?.endIndex || 1;
  await fetch(`https://docs.googleapis.com/v1/documents/${fileId}:batchUpdate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ requests: [{ insertText: { location: { index: endIndex - 1 }, text: textToAppend } }] }),
  });
}

async function createFileInFolder(token: string, fileName: string, content: string, folderId: string): Promise<any> {
  const boundary = "----MonthlyCycleBoundary";
  const DRIVE_DOC_MIME = "application/vnd.google-apps.document";
  const metadata = JSON.stringify({ name: fileName, parents: [folderId], mimeType: DRIVE_DOC_MIME });
  const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${content}\r\n--${boundary}--`;
  const res = await fetch(`https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": `multipart/related; boundary=${boundary}` },
    body,
  });
  if (!res.ok) throw new Error(`Drive create failed: ${await res.text()}`);
  return await res.json();
}

async function createFolderInParent(token: string, name: string, parentId: string): Promise<string> {
  const res = await fetch("https://www.googleapis.com/drive/v3/files?supportsAllDrives=true", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name, parents: [parentId], mimeType: "application/vnd.google-apps.folder" }),
  });
  const data = await res.json();
  return data.id;
}

const truncate = (s: string, max: number) => s.length > max ? s.slice(0, max) + "…" : s;
const canonicalText = (v: string) => v.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const authHeader = req.headers.get("Authorization") || "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || "";

  let requestBody: Record<string, unknown> = {};
  try { requestBody = await req.json(); } catch { requestBody = {}; }

  const source = typeof requestBody.source === "string" ? requestBody.source.trim().toLowerCase() : "manual";
  const isCronCall = source === "cron";
  const bearerToken = authHeader.startsWith("Bearer ") ? authHeader.replace("Bearer ", "") : "";
  let requesterUserId: string | null = null;

  if (isCronCall) {
    const cronAllowedTokens = [serviceRoleKey, anonKey].filter(Boolean);
    if (!bearerToken || !cronAllowedTokens.includes(bearerToken)) {
      return new Response(JSON.stringify({ error: "Unauthorized cron trigger" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  } else {
    const authResult = await requireAuth(req);
    if (authResult instanceof Response) return authResult;
    requesterUserId = authResult.user?.id ?? null;
  }

  const supabaseAdmin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  let cycleId: string | null = null;

  try {
    // Check cooldown: no monthly cycle in last 25 days
    const { data: recentMonthly } = await supabaseAdmin
      .from("did_update_cycles")
      .select("id, completed_at")
      .eq("cycle_type", "monthly")
      .eq("status", "completed")
      .order("completed_at", { ascending: false })
      .limit(1);

    if (recentMonthly && recentMonthly.length > 0) {
      const lastCompleted = new Date(recentMonthly[0].completed_at!).getTime();
      if (Date.now() - lastCompleted < 25 * 24 * 60 * 60 * 1000) {
        return new Response(JSON.stringify({ skipped: true, reason: "cooldown", lastCompleted: recentMonthly[0].completed_at }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // Check concurrency
    const { data: running } = await supabaseAdmin
      .from("did_update_cycles")
      .select("id, started_at")
      .eq("cycle_type", "monthly")
      .eq("status", "running")
      .order("started_at", { ascending: false })
      .limit(1);

    if (running && running.length > 0) {
      const elapsed = Date.now() - new Date(running[0].started_at).getTime();
      if (elapsed < 15 * 60 * 1000) {
        return new Response(JSON.stringify({ skipped: true, reason: "already_running" }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      // Stuck cycle — mark failed
      await supabaseAdmin.from("did_update_cycles").update({ status: "failed" }).eq("id", running[0].id);
    }

    // Create cycle record
    // Find a user_id for the cycle record
    let userId = requesterUserId;
    if (!userId) {
      const { data: anyThread } = await supabaseAdmin.from("did_threads").select("user_id").limit(1);
      userId = anyThread?.[0]?.user_id || null;
    }

    const { data: cycleRow } = await supabaseAdmin.from("did_update_cycles").insert({
      cycle_type: "monthly",
      status: "running",
      user_id: userId || "00000000-0000-0000-0000-000000000000",
    }).select("id").single();
    cycleId = cycleRow?.id || null;

    // ═══ GATHER DATA ═══
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    // NO report_summary – only metadata. Drive is the single source of truth.
    const [dailyCyclesRes, weeklyCyclesRes, threadsRes, tasksRes] = await Promise.all([
      supabaseAdmin.from("did_update_cycles")
        .select("completed_at, cards_updated")
        .eq("cycle_type", "daily").eq("status", "completed")
        .gte("completed_at", thirtyDaysAgo)
        .order("completed_at", { ascending: false }),
      supabaseAdmin.from("did_update_cycles")
        .select("completed_at")
        .eq("cycle_type", "weekly").eq("status", "completed")
        .gte("completed_at", thirtyDaysAgo)
        .order("completed_at", { ascending: false }),
      supabaseAdmin.from("did_threads")
        .select("part_name, messages, last_activity_at, sub_mode")
        .gte("last_activity_at", thirtyDaysAgo)
        .order("last_activity_at", { ascending: false }),
      supabaseAdmin.from("did_therapist_tasks")
        .select("task, status, status_hanka, status_kata, completed_at, created_at")
        .order("created_at", { ascending: false })
        .limit(100),
    ]);

    const dailyCycles = dailyCyclesRes.data || [];
    const weeklyCycles = weeklyCyclesRes.data || [];
    const threads = threadsRes.data || [];
    const tasks = tasksRes.data || [];

    // Part activity stats
    const partStats: Record<string, { count: number; lastSeen: string; msgCount: number }> = {};
    for (const t of threads) {
      const msgs = Array.isArray(t.messages) ? t.messages : [];
      if (!partStats[t.part_name]) {
        partStats[t.part_name] = { count: 0, lastSeen: t.last_activity_at, msgCount: 0 };
      }
      partStats[t.part_name].count++;
      partStats[t.part_name].msgCount += msgs.length;
      if (t.last_activity_at > partStats[t.part_name].lastSeen) {
        partStats[t.part_name].lastSeen = t.last_activity_at;
      }
    }

    // Task stats
    const completedTasks = tasks.filter((t: any) => t.status === "done");
    const pendingTasks = tasks.filter((t: any) => t.status !== "done");

    // Drive: read centrum docs
    let driveContext = "";
    try {
      const token = await getAccessToken();
      const kartotekaId = await findFolder(token, "kartoteka_DID");
      if (kartotekaId) {
        const folders = await listFilesInFolder(token, kartotekaId);
        const centrumFolder = folders.find(f => f.name.includes("00_CENTRUM"));
        if (centrumFolder) {
          const centrumFiles = await listFilesInFolder(token, centrumFolder.id);
          const docsToRead = ["00_Dashboard", "03_Geografie", "04_Mapa_Vztahu", "05_Operativni", "06_Strategicky"];
          for (const prefix of docsToRead) {
            const file = centrumFiles.find(f => f.name.includes(prefix));
            if (file) {
              const content = await readFileContent(token, file.id);
              driveContext += `\n\n=== ${file.name} ===\n${truncate(content, 2000)}`;
            }
          }
        }
      }
    } catch (e) {
      console.warn("Drive read error (non-fatal):", e);
    }

    // Only metadata – cards_updated and dates. NO report_summary (stale data risk).
    const dailySummaries = dailyCycles.slice(0, 15).map((c: any) =>
      `[${new Date(c.completed_at).toLocaleDateString("cs-CZ")}] Aktualizované karty: ${JSON.stringify(c.cards_updated || [])}`
    ).join("\n---\n");

    const weeklySummaries = weeklyCycles.slice(0, 4).map((c: any) =>
      `[${new Date(c.completed_at).toLocaleDateString("cs-CZ")}] Týdenní cyklus dokončen`
    ).join("\n---\n");

    // Part activity summary
    const partActivitySummary = Object.entries(partStats)
      .sort((a, b) => b[1].msgCount - a[1].msgCount)
      .map(([name, stats]) => `- ${name}: ${stats.count} konverzací, ${stats.msgCount} zpráv, naposledy ${new Date(stats.lastSeen).toLocaleDateString("cs-CZ")}`)
      .join("\n");

    // ═══ AI ANALYSIS ═══
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY not configured");

    const systemPrompt = `Jsi Karel, AI asistent specializovaný na DID (disociativní porucha identity).
Provádíš MĚSÍČNÍ ANALÝZU systému za posledních 30 dní.

Tvým úkolem je:
1. Vytvořit komplexní měsíční report
2. Identifikovat změny a trendy
3. Navrhnout KONKRÉTNÍ redistribuci informací do dokumentů v kartotéce
4. Provést hloubkovou revizi STRATEGICKÉHO VÝHLEDU (06_Strategicky_Vyhled):
   - Revize dlouhodobých cílů (sekce 3)
   - Strategická reflexe (sekce 7)
   - Přehodnocení střednědobých cílů na základě měsíčních dat

FORMÁT VÝSTUPU (JSON):
{
  "report": "markdown text měsíčního reportu",
  "redistributions": [
    {
      "target": "název cílového dokumentu (00_Dashboard | 03_Geografie | 04_Mapa_Vztahu | 05_Operativni_Plan | 06_Strategicky_Vyhled | karta_[jmeno_casti])",
      "action": "append | update_section",
      "content": "text k zápisu/aktualizaci",
      "reason": "proč tato změna"
    }
  ],
  "status_changes": [
    {
      "part_name": "jméno části",
      "old_status": "aktivní|spící|varovný",
      "new_status": "aktivní|spící|varovný",
      "reason": "důvod změny"
    }
  ],
  "key_insights": ["klíčový poznatek 1", "klíčový poznatek 2"],
  "accountability": {
    "team_score": 8,
    "hanka_summary": "hodnocení plnění Hanky za měsíc",
    "kata_summary": "hodnocení plnění Káti za měsíc",
    "unresolved_issues": ["problém 1", "problém 2"],
    "recommendations": ["doporučení 1"]
  }
}

REPORT musí obsahovat:
## 📊 Měsíční přehled systému (datum)
### Aktivita částí — trendy
### Splněné vs. nesplněné úkoly
### Hodnocení spolupráce terapeutického týmu
### Změny ve vzorcích chování
### Posun v terapeutických cílech
### Doporučení pro další měsíc
### Návrhy na aktualizaci kartotéky
### Strategická reflexe (pro 06_Strategicky_Vyhled sekce 7)

Buď konkrétní, klinicky relevantní. Piš česky.
DŮLEŽITÉ: Nikdy nenavrhuj dechová cvičení — klientka má epilepsii.`;

    const userContent = `AKTIVITA ČÁSTÍ ZA 30 DNÍ:
${partActivitySummary || "(žádná aktivita)"}

DENNÍ REPORTY (posledních 15):
${dailySummaries || "(žádné)"}

TÝDENNÍ REPORTY:
${weeklySummaries || "(žádné)"}

ÚKOLY: ${completedTasks.length} splněných, ${pendingTasks.length} nesplněných

AKTUÁLNÍ DOKUMENTY V KARTOTÉCE:
${driveContext || "(nedostupné)"}`;

    const aiController = new AbortController();
    const aiTimeout = setTimeout(() => aiController.abort(), 180000);
    let aiResp: Response;
    try {
      aiResp = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "google/gemini-2.5-pro",
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userContent },
          ],
          stream: false,
        }),
        signal: aiController.signal,
      });
    } finally {
      clearTimeout(aiTimeout);
    }

    if (!aiResp.ok) throw new Error(`AI error: ${aiResp.status} ${await aiResp.text()}`);

    const aiData = await aiResp.json();
    const rawContent = aiData.choices?.[0]?.message?.content || "";

    // Parse JSON from response
    let analysis: any = { report: rawContent, redistributions: [], status_changes: [], key_insights: [] };
    try {
      const jsonMatch = rawContent.match(/\{[\s\S]*\}/);
      if (jsonMatch) analysis = JSON.parse(jsonMatch[0]);
    } catch {
      console.warn("Could not parse structured output, using raw report");
    }

    const reportText = analysis.report || rawContent;

    // ═══ REDISTRIBUTION TO DRIVE ═══
    const redistributions = Array.isArray(analysis.redistributions) ? analysis.redistributions : [];
    const cardsUpdated: string[] = [];

    if (redistributions.length > 0) {
      try {
        const token = await getAccessToken();
        const kartotekaId = await findFolder(token, "kartoteka_DID");
        if (kartotekaId) {
          const folders = await listFilesInFolder(token, kartotekaId);
          const centrumFolder = folders.find(f => f.name.includes("00_CENTRUM"));
          const aktivniFolder = folders.find(f => f.name.includes("01_AKTIVNI"));

          for (const redist of redistributions) {
            try {
              const target = redist.target || "";
              const content = redist.content || "";
              if (!content) continue;

              const datePrefix = `\n\n[MĚSÍČNÍ UPDATE ${new Date().toISOString().slice(0, 10)}]\n`;

              if (target.startsWith("karta_") && aktivniFolder) {
                const partName = target.replace("karta_", "");
                const files = await listFilesInFolder(token, aktivniFolder.id);
                const partCanonical = canonicalText(partName);
                const match = files.find(f => canonicalText(f.name).includes(partCanonical));
                if (match) {
                  await appendToDoc(token, match.id, datePrefix + content);
                  cardsUpdated.push(`Karta: ${partName}`);
                }
              } else if (centrumFolder) {
                const centrumFiles = await listFilesInFolder(token, centrumFolder.id);
                const match = centrumFiles.find(f => f.name.includes(target));
                if (match) {
                  await appendToDoc(token, match.id, datePrefix + content);
                  cardsUpdated.push(target);
                }
              }
            } catch (e) {
              console.warn(`Redistribution to ${redist.target} failed:`, e);
            }
          }

          // Save monthly report to Drive
          try {
            // Find or create 08_Mesicni_Reporty folder
            let reportsFolder = folders.find(f => f.name.includes("08_Mesicni"));
            let reportsFolderId: string;
            if (reportsFolder) {
              reportsFolderId = reportsFolder.id;
            } else {
              reportsFolderId = await createFolderInParent(token, "08_Mesicni_Reporty", kartotekaId);
            }
            const reportFileName = `Mesicni_Report_${new Date().toISOString().slice(0, 7)}`;
            await createFileInFolder(token, reportFileName, reportText, reportsFolderId);
            cardsUpdated.push("08_Mesicni_Reporty/" + reportFileName);
          } catch (e) {
            console.warn("Failed to save report to Drive:", e);
          }
        }
      } catch (e) {
        console.warn("Drive redistribution error:", e);
      }
    }

    // ═══ DRIVE AUTO-CLEANUP AUDIT ═══
    let cleanupIssues: string[] = [];
    try {
      const token = await getAccessToken();
      const kartotekaId = await findFolder(token, "kartoteka_DID");
      if (kartotekaId) {
        const allFolders = await listFilesInFolder(token, kartotekaId);
        
        const TXT_MIME = "text/plain";
        const FOLDER_MIME = "application/vnd.google-apps.folder";
        const DOC_MIME = "application/vnd.google-apps.document";
        
        // Scan ALL subfolders for issues
        for (const folder of allFolders) {
          if (folder.mimeType !== FOLDER_MIME) continue;
          
          const files = await listFilesInFolder(token, folder.id);
          const docNames = new Map<string, number>();
          
          for (const file of files) {
            if (file.mimeType === FOLDER_MIME) continue;
            
            // Issue 1: .txt files that should be Google Docs
            if (file.mimeType === TXT_MIME || file.name.endsWith(".txt") || file.name.endsWith(".md")) {
              cleanupIssues.push(`📄 Nekonvertovaný soubor: "${file.name}" v ${folder.name} (měl by být Google Doc)`);
            }
            
            // Issue 2: Duplicate card names (same canonical name)
            const canonical = canonicalText(file.name);
            const count = (docNames.get(canonical) || 0) + 1;
            docNames.set(canonical, count);
            if (count === 2) {
              cleanupIssues.push(`🔄 Duplicitní karta: "${file.name}" v ${folder.name} (existuje ${count}x)`);
            }
            
            // Issue 3: Empty documents (try to read and check)
            if (file.mimeType === DOC_MIME && files.length < 30) { // Only check in small folders to avoid timeout
              try {
                const content = await readFileContent(token, file.id);
                if (content.trim().length < 10) {
                  cleanupIssues.push(`🗑️ Prázdný dokument: "${file.name}" v ${folder.name}`);
                }
              } catch { /* skip unreadable */ }
            }
          }
        }
        
        // Cap at 20 issues to keep email manageable
        if (cleanupIssues.length > 20) {
          const total = cleanupIssues.length;
          cleanupIssues = cleanupIssues.slice(0, 20);
          cleanupIssues.push(`... a dalších ${total - 20} problémů`);
        }
        
        console.log(`Drive cleanup audit found ${cleanupIssues.length} issues`);
      }
    } catch (e) {
      console.warn("Drive cleanup audit error (non-fatal):", e);
    }

    // ═══ UPDATE CYCLE RECORD ═══
    if (cycleId) {
      await supabaseAdmin.from("did_update_cycles").update({
        status: "completed",
        completed_at: new Date().toISOString(),
        report_summary: truncate(reportText, 10000),
        cards_updated: cardsUpdated,
      }).eq("id", cycleId);
    }

    // ═══ SEND EMAIL ═══
    try {
      const resendKey = Deno.env.get("RESEND_API_KEY");
      const hankaEmail = "mujosobniasistentnamiru@gmail.com";
      const kataEmail = Deno.env.get("KATA_EMAIL");
      const recipients = [hankaEmail, kataEmail].filter(Boolean) as string[];
      if (resendKey && recipients.length > 0) {
        const resend = new Resend(resendKey);
        const month = new Date().toLocaleDateString("cs-CZ", { month: "long", year: "numeric" });
        const cleanupSection = cleanupIssues.length > 0
          ? `<h3>📋 Návrh na úklid kartotéky (${cleanupIssues.length} problémů)</h3><ul>${cleanupIssues.map(i => `<li>${i}</li>`).join("")}</ul><p><small>Karel nic nesmazal — pouze navrhuje. Zkontrolujte a případně smažte ručně.</small></p>`
          : "";
        await resend.emails.send({
          from: "Karel <karel@hana-chlebcova.cz>",
          to: [kataEmail],
          subject: `📊 Měsíční report DID systému — ${month}`,
          html: `<h2>Měsíční report DID systému</h2>
<pre style="white-space: pre-wrap; font-family: sans-serif; font-size: 13px;">${reportText.slice(0, 8000)}</pre>
${cleanupSection}
<hr>
<p><small>Aktualizováno dokumentů: ${cardsUpdated.length}</small></p>
<p><small>Redistribuce: ${cardsUpdated.join(", ") || "žádné"}</small></p>`,
        });
      }
    } catch (e) {
      console.warn("Email send error:", e);
    }

    return new Response(JSON.stringify({
      success: true,
      cycleId,
      cardsUpdated,
      keyInsights: analysis.key_insights || [],
      statusChanges: analysis.status_changes || [],
      cleanupIssues: cleanupIssues.length > 0 ? cleanupIssues : undefined,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("Monthly cycle error:", e);
    if (cycleId) {
      await supabaseAdmin.from("did_update_cycles").update({ status: "failed" }).eq("id", cycleId).catch(() => {});
    }
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
