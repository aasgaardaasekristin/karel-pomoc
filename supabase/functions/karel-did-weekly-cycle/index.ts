import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Resend } from "npm:resend@2.0.0";
import { requireAuth, corsHeaders } from "../_shared/auth.ts";

const MAX_CARD_CHARS = 900;
const MAX_CENTRUM_CHARS = 1600;
const MAX_AGREEMENT_CHARS = 1800;
const MAX_SYSTEM_MAP_CHARS = 2500;
const MAX_INSTRUCTION_CHARS = 3500;
const MAX_RESEARCH_MESSAGE_CHARS = 180;
const MAX_CONVERSATION_MESSAGE_CHARS = 180;

const truncate = (value: string, max: number) =>
  value.length > max ? `${value.slice(0, max)}…` : value;

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timeoutId: number | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}


// ═══ OAuth2 token helper ═══
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

// ═══ Drive helpers ═══
const DRIVE_FOLDER_MIME = "application/vnd.google-apps.folder";
const DRIVE_DOC_MIME = "application/vnd.google-apps.document";

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

async function listFilesRecursive(token: string, rootFolderId: string): Promise<Array<{ id: string; name: string; mimeType?: string }>> {
  const collected: Array<{ id: string; name: string; mimeType?: string }> = [];
  const stack = [rootFolderId];
  while (stack.length > 0) {
    const fid = stack.pop()!;
    const files = await listFilesInFolder(token, fid);
    for (const f of files) {
      if (f.mimeType === DRIVE_FOLDER_MIME) stack.push(f.id);
      else collected.push(f);
    }
  }
  return collected;
}

async function updateGoogleDocInPlace(token: string, fileId: string, content: string): Promise<void> {
  const normalizedContent = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const docRes = await fetch(`https://docs.googleapis.com/v1/documents/${fileId}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!docRes.ok) throw new Error(`Docs read failed (${docRes.status})`);
  const docData = await docRes.json();
  const bodyContent = docData?.body?.content || [];
  const lastEndIndex = bodyContent.length > 0 ? Number(bodyContent[bodyContent.length - 1]?.endIndex || 1) : 1;
  const requests: any[] = [];
  if (lastEndIndex > 1) requests.push({ deleteContentRange: { range: { startIndex: 1, endIndex: lastEndIndex - 1 } } });
  requests.push({ insertText: { location: { index: 1 }, text: normalizedContent } });
  const updateRes = await fetch(`https://docs.googleapis.com/v1/documents/${fileId}:batchUpdate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ requests }),
  });
  if (!updateRes.ok) throw new Error(`Docs batchUpdate failed: ${await updateRes.text()}`);
}

async function updateFileById(token: string, fileId: string, content: string, mimeType?: string): Promise<any> {
  if (mimeType === DRIVE_DOC_MIME) {
    try {
      await updateGoogleDocInPlace(token, fileId, content);
      return { id: fileId, updatedInPlace: true };
    } catch (e) {
      console.warn(`[updateFileById] Docs API failed, fallback to Drive PATCH: ${e}`);
      const boundary = "----WeeklyCycleBoundary";
      const metadata = JSON.stringify({ mimeType: DRIVE_DOC_MIME });
      const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${content}\r\n--${boundary}--`;
      const res = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=multipart&supportsAllDrives=true`, {
        method: "PATCH", headers: { Authorization: `Bearer ${token}`, "Content-Type": `multipart/related; boundary=${boundary}` }, body,
      });
      if (!res.ok) throw new Error(`Drive PATCH fallback failed: ${await res.text()}`);
      return await res.json();
    }
  }
  const boundary = "----WeeklyCycleBoundary";
  const metadata = JSON.stringify({});
  const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${content}\r\n--${boundary}--`;
  const res = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=multipart&supportsAllDrives=true`, {
    method: "PATCH", headers: { Authorization: `Bearer ${token}`, "Content-Type": `multipart/related; boundary=${boundary}` }, body,
  });
  if (!res.ok) throw new Error(`Drive PATCH failed: ${await res.text()}`);
  return await res.json();
}

async function createFileInFolder(token: string, fileName: string, content: string, folderId: string): Promise<any> {
  const boundary = "----WeeklyCycleBoundary";
  const metadata = JSON.stringify({ name: fileName, parents: [folderId], mimeType: DRIVE_DOC_MIME });
  const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${content}\r\n--${boundary}--`;
  const res = await fetch(`https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": `multipart/related; boundary=${boundary}` }, body,
  });
  if (!res.ok) throw new Error(`Drive create failed: ${await res.text()}`);
  return await res.json();
}

const canonicalText = (v: string) => v.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\.(txt|md|doc|docx|xls|xlsx)$/gi, "").replace(/[^a-z0-9]/g, "");

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const authHeader = req.headers.get("Authorization") || "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || "";
  let cycleId: string | null = null;

  let requestBody: Record<string, unknown> = {};
  try {
    requestBody = await req.json();
  } catch {
    requestBody = {};
  }

  const source = typeof requestBody.source === "string" ? requestBody.source.trim().toLowerCase() : "manual";
  const isCronCall = source === "cron";
  const bearerToken = authHeader.startsWith("Bearer ") ? authHeader.replace("Bearer ", "") : "";
  const cronAllowedTokens = [serviceRoleKey, anonKey].filter(Boolean);
  let requesterUserId: string | null = null;

  if (isCronCall) {
    if (!bearerToken || !cronAllowedTokens.includes(bearerToken)) {
      return new Response(JSON.stringify({ error: "Unauthorized cron trigger" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const pragueWeekday = new Intl.DateTimeFormat("en-US", {
      weekday: "short",
      timeZone: "Europe/Prague",
    }).format(new Date());

    if (pragueWeekday !== "Sun") {
      return new Response(JSON.stringify({ success: true, skipped: true, reason: "not_sunday", source }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  } else {
    const authResult = await requireAuth(req);
    if (authResult instanceof Response) return authResult;
    requesterUserId = authResult.user?.id ?? null;
  }

  try {
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
    const PERPLEXITY_API_KEY = Deno.env.get("PERPLEXITY_API_KEY");
    const MAMKA_EMAIL = "mujosobniasistentnamiru@gmail.com";
    const KATA_EMAIL = Deno.env.get("KATA_EMAIL") || "K.CC@seznam.cz";
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY not configured");

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const sb = createClient(supabaseUrl, supabaseKey);
    const dateStr = new Date().toISOString().slice(0, 10);

    // ═══ AUTO-CLEANUP: Mark stuck "running" cycles as "failed" (>10 min) ═══
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const { data: stuckCycles } = await sb.from("did_update_cycles")
      .select("id, cycle_type, started_at")
      .eq("status", "running")
      .lt("started_at", tenMinAgo);

    if (stuckCycles && stuckCycles.length > 0) {
      for (const stuck of stuckCycles) {
        await sb.from("did_update_cycles").update({
          status: "failed",
          completed_at: new Date().toISOString(),
          report_summary: `Cyklus automaticky označen jako neúspěšný (timeout po 10 min). Spuštěn: ${stuck.started_at}`,
        }).eq("id", stuck.id);
      }
      console.log(`[weekly] Auto-cleanup: ${stuckCycles.length} stuck cycles marked as failed`);

      // Send notification email about stuck cycles
      if (RESEND_API_KEY) {
        try {
          const resend = new Resend(RESEND_API_KEY);
          await resend.emails.send({
            from: "Karel <karel@hana-chlebcova.cz>",
            to: [MAMKA_EMAIL],
            subject: `⚠️ Karel – ${stuckCycles.length} zaseklý cyklus vyčištěn`,
            html: `<p>Karel automaticky vyčistil <strong>${stuckCycles.length}</strong> zaseklý/é cyklus/y (běžely déle než 10 minut).</p>
<ul>${stuckCycles.map(s => `<li>${s.cycle_type} – spuštěn ${new Date(s.started_at).toLocaleString("cs-CZ", { timeZone: "Europe/Prague" })}</li>`).join("")}</ul>
<p>Nový týdenní cyklus nyní pokračuje normálně.</p><p>Karel</p>`,
          });
        } catch (emailErr) { console.warn("[weekly] Cleanup notification email failed:", emailErr); }
      }
    }

    // Resolve user_id for DB inserts
    let userId = requesterUserId;
    if (!userId) {
      const { data: anyUser } = await sb
        .from("did_threads")
        .select("user_id, last_activity_at")
        .order("last_activity_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      userId = anyUser?.user_id ?? null;
    }
    if (!userId) throw new Error("No user found in did_threads for cycle attribution");

    // Prevent duplicate runs (manual double-click / overlapping triggers)
    const fifteenMinAgo = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const { data: alreadyRunning } = await sb
      .from("did_update_cycles")
      .select("id, started_at")
      .eq("cycle_type", "weekly")
      .eq("status", "running")
      .gte("started_at", fifteenMinAgo)
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (alreadyRunning) {
      return new Response(JSON.stringify({
        success: true,
        skipped: true,
        reason: "already_running",
        cycleId: alreadyRunning.id,
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Prevent reruns within 6 hours of a completed weekly cycle (both cron AND manual)
    const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
    const { data: recentCompleted } = await sb
      .from("did_update_cycles")
      .select("id, completed_at")
      .eq("cycle_type", "weekly")
      .eq("status", "completed")
      .gte("completed_at", sixHoursAgo)
      .order("completed_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (recentCompleted) {
      return new Response(JSON.stringify({
        success: true,
        skipped: true,
        reason: "already_completed_recently",
        completedAt: recentCompleted.completed_at,
        cycleId: recentCompleted.id,
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Create weekly cycle record
    const { data: cycle } = await sb
      .from("did_update_cycles")
      .insert({ cycle_type: "weekly", status: "running", user_id: userId })
      .select()
      .single();
    cycleId = cycle?.id ?? null;

    // ═══ 1. READ ALL CARDS + CENTRUM DOCS FROM DRIVE ═══
    let allCardsContent = "";
    let centrumDocsContent = "";
    let agreementsContent = "";
    let instructionContext = "";
    let systemMap = "";
    const cardNames: string[] = [];
    let centrumFolderId: string | null = null;
    let dohodaFolderId: string | null = null;
    let folderId: string | null = null;

    const token = await getAccessToken();
    folderId = await findFolder(token, "kartoteka_DID") || await findFolder(token, "Kartoteka_DID") || await findFolder(token, "Kartotéka_DID");

    if (folderId) {
      const rootChildren = await listFilesInFolder(token, folderId);
      const rootFolders = rootChildren.filter(f => f.mimeType === DRIVE_FOLDER_MIME);

      // Find key folders
      const centerFolder = rootFolders.find(f => /^00/.test(f.name.trim()) || canonicalText(f.name).includes("centrum"));
      const activeFolder = rootFolders.find(f => /^01/.test(f.name.trim()) || canonicalText(f.name).includes("aktiv"));
      const archiveFolder = rootFolders.find(f => /^03/.test(f.name.trim()) || canonicalText(f.name).includes("archiv"));

      // Read ALL card files from active + archive
      for (const folder of [activeFolder, archiveFolder].filter(Boolean)) {
        const files = await listFilesRecursive(token, folder!.id);
        for (const file of files) {
          if (file.mimeType === DRIVE_FOLDER_MIME) continue;
          try {
              const content = await readFileContent(token, file.id);
            if (/SEKCE\s+[A-M]/i.test(content) || /KARTA\s+[ČC]ÁSTI/i.test(content) || /^\d{3}[_-]/i.test(file.name)) {
              const partName = file.name.replace(/\.(txt|md|doc|docx)$/i, "").replace(/^\d{3}[_-]/, "").replace(/_/g, " ");
              const folderLabel = folder === archiveFolder ? "ARCHIV/SPÍ" : "AKTIVNÍ";
              allCardsContent += `\n\n=== KARTA: ${partName} [${folderLabel}] ===\n${truncate(content, MAX_CARD_CHARS)}`;
              cardNames.push(`${partName} [${folderLabel}]`);
            }
          } catch (e) { console.warn(`Failed to read ${file.name}:`, e); }
        }
      }
      console.log(`[weekly] Loaded ${cardNames.length} cards`);

      // Read CENTRUM docs
      if (centerFolder) {
        centrumFolderId = centerFolder.id;
        const centerFiles = await listFilesInFolder(token, centerFolder.id);

        for (const file of centerFiles) {
          if (file.mimeType === DRIVE_FOLDER_MIME) {
            // Check if it's the 06_Terapeuticke_Dohody folder
            if (canonicalText(file.name).includes("dohod")) {
              dohodaFolderId = file.id;
              const dohodaFiles = await listFilesInFolder(token, file.id);
              for (const df of dohodaFiles) {
                try {
                  const content = await readFileContent(token, df.id);
                  agreementsContent += `\n=== DOHODA: ${df.name} ===\n${truncate(content, MAX_AGREEMENT_CHARS)}\n`;
                } catch {}
              }
              console.log(`[weekly] Loaded ${dohodaFiles.length} agreement files`);
            }
            continue;
          }
          try {
            const content = await readFileContent(token, file.id);
            const cn = canonicalText(file.name);
            if (cn.includes("instrukce")) {
              instructionContext = truncate(content, MAX_INSTRUCTION_CHARS);
            } else if (cn.includes("mapa") && cn.includes("vztah")) {
              systemMap = truncate(content, MAX_SYSTEM_MAP_CHARS);
            }
            centrumDocsContent += `\n=== CENTRUM: ${file.name} ===\n${truncate(content, MAX_CENTRUM_CHARS)}\n`;
          } catch {}
        }
      }
    }

    // ═══ 2. GET WEEKLY + MONTHLY ACTIVITY DATA FROM DB ═══
    const weekAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    const { data: weekThreads } = await sb.from("did_threads")
      .select("part_name, sub_mode, started_at, last_activity_at, messages, part_language")
      .gte("started_at", weekAgo);

    const { data: monthThreads } = await sb.from("did_threads")
      .select("part_name, sub_mode, started_at, last_activity_at, messages")
      .gte("started_at", monthAgo);

    const { data: weekCycles } = await sb.from("did_update_cycles")
      .select("cycle_type, completed_at, report_summary, cards_updated")
      .eq("status", "completed").gte("completed_at", weekAgo)
      .order("completed_at", { ascending: true });

    const { data: researchThreads } = await sb.from("research_threads")
      .select("topic, messages, created_by, last_activity_at")
      .eq("is_deleted", false).gte("last_activity_at", monthAgo);

    // Build activity summaries
    const activityByPart = new Map<string, { weekMsgs: number; monthMsgs: number; lastSeen: string; modes: Set<string>; language: string }>();
    for (const t of monthThreads || []) {
      const key = t.part_name;
      const existing = activityByPart.get(key) || { weekMsgs: 0, monthMsgs: 0, lastSeen: "", modes: new Set(), language: "cs" };
      const msgCount = ((t.messages as any[]) || []).length;
      existing.monthMsgs += msgCount;
      existing.modes.add(t.sub_mode);
      if (!existing.lastSeen || t.last_activity_at > existing.lastSeen) existing.lastSeen = t.last_activity_at;
      activityByPart.set(key, existing);
    }
    for (const t of weekThreads || []) {
      const key = t.part_name;
      const existing = activityByPart.get(key) || { weekMsgs: 0, monthMsgs: 0, lastSeen: "", modes: new Set(), language: t.part_language || "cs" };
      existing.weekMsgs += ((t.messages as any[]) || []).length;
      existing.language = t.part_language || existing.language;
      activityByPart.set(key, existing);
    }

    const activitySummary = Array.from(activityByPart.entries())
      .map(([name, d]) => `- ${name}: Týden=${d.weekMsgs} zpráv, Měsíc=${d.monthMsgs} zpráv, Režimy: ${Array.from(d.modes).join(",")}, Jazyk: ${d.language}, Poslední: ${d.lastSeen}`)
      .join("\n");

    const dailyReportsSummary = (weekCycles || [])
      .filter(c => c.cycle_type === "daily")
      .map(c => `[${c.completed_at}] Karty: ${JSON.stringify(c.cards_updated)}\n${(c.report_summary || "").slice(0, 500)}`)
      .join("\n---\n");

    // Weekly thread conversations (truncated for context)
    const weekConversations = (weekThreads || []).slice(0, 12).map(t => {
      const msgs = ((t.messages as any[]) || []).slice(-6);
      const isCast = t.sub_mode === "cast";
      return `=== ${t.part_name} (${t.sub_mode}, ${t.started_at}) ===\n${msgs.map((m: any) => `[${m.role === "user" ? (isCast ? "ČÁST" : "TERAPEUT") : "KAREL"}]: ${typeof m.content === "string" ? truncate(m.content, MAX_CONVERSATION_MESSAGE_CHARS) : "(multimodal)"}`).join("\n")}`;
    }).join("\n\n---\n\n");

    // Research threads summary
    const researchSummary = (researchThreads || []).slice(0, 8).map(rt => {
      const msgs = ((rt.messages as any[]) || []).slice(-4);
      return `Téma: ${rt.topic} (${rt.created_by})\n${msgs.map((m: any) => `[${m.role}]: ${typeof m.content === "string" ? truncate(m.content, MAX_RESEARCH_MESSAGE_CHARS) : ""}`).join("\n")}`;
    }).join("\n---\n");

    // ═══ 3. PERPLEXITY RESEARCH – Novel approaches ═══
    let perplexityContext = "";
    if (PERPLEXITY_API_KEY && allCardsContent.length > 100) {
      try {
        // Build focused research query based on active fragments
        const activeFragments = cardNames.filter(n => n.includes("AKTIVNÍ")).map(n => n.replace(" [AKTIVNÍ]", "")).join(", ");
        const researchQuery = `DID (Dissociative Identity Disorder) therapeutic approaches 2024-2025:
1. Novel methods for working with child alters and protectors in DID therapy
2. Evidence-based techniques for inter-part communication and cooperation
3. Creative therapeutic interventions for DID (art therapy, play therapy, somatic approaches)
4. Strategies for safe awakening of dormant alters
5. Crisis prevention and safety planning for DID systems
6. Long-term integration strategies and functional daily living with DID
7. School and social adaptation strategies for DID systems with child-age alters
Active parts in this system: ${activeFragments}`;

        const pRes = await withTimeout(fetch("https://api.perplexity.ai/chat/completions", {
          method: "POST",
          headers: { Authorization: `Bearer ${PERPLEXITY_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "sonar-pro",
            messages: [
              { role: "system", content: "You are a clinical DID researcher. Return specific, actionable therapeutic methods, contraindications, novel approaches, and academic references. Focus on practical application. Include URLs." },
              { role: "user", content: researchQuery },
            ],
            search_mode: "academic",
            search_recency_filter: "year",
          }),
        }), 20000, "Perplexity research");

        if (pRes.ok) {
          const pData = await pRes.json();
          const text = pData.choices?.[0]?.message?.content || "";
          const citations: string[] = pData.citations || [];
          if (text) {
            perplexityContext = `\n\n═══ AKTUÁLNÍ VÝZKUM A METODY (Perplexity) ═══\n${text}`;
            if (citations.length > 0) perplexityContext += `\n\nCitace:\n${citations.map((c, i) => `[${i + 1}] ${c}`).join("\n")}`;
          }
          console.log(`[weekly] Perplexity research: ${text.length} chars, ${citations.length} citations`);
        } else {
          console.warn(`[weekly] Perplexity error ${pRes.status}`);
        }
      } catch (e) { console.warn("[weekly] Perplexity failed:", e); }
    }

    // ═══ 4. AI COMPREHENSIVE WEEKLY ANALYSIS ═══
    const analysisResponse = await withTimeout(fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          {
            role: "system",
            content: `Jsi Karel – hlavní stratég, supervizor a analytik DID systému. Provádíš TÝDENNÍ STRATEGICKOU ANALÝZU.

═══ TVŮJ ÚKOL ═══

Vytvoříš 3 výstupy:
1. [TYDENNI_REPORT] – Komplexní týdenní report
2. [STRATEGICKY_VYHLED] – Kompletní přepis 06_Strategicky_Vyhled (7 sekcí)
3. [CENTRUM_UPDATES] – Aktualizace CENTRUM dokumentů

═══ 1. TÝDENNÍ REPORT ═══
Formát: [TYDENNI_REPORT]...[/TYDENNI_REPORT]

Povinné sekce:

A) CELKOVÝ STAV SYSTÉMU
- Celková stabilita (1-10)
- Hlavní události týdne
- Počet aktivních/spících částí
- Trendy (zlepšení/zhoršení)

B) ANALÝZA KAŽDÉ AKTIVNÍ ČÁSTI
Pro KAŽDOU aktivní část:
▸ Jméno: [stav, nálada, stabilita 1-10]
▸ Co se dělo tento týden: konkrétní interakce, témata
▸ Pokroky: co se podařilo, co fungovalo
▸ Rizika: na co si dát pozor
▸ Doporučené metody pro příští týden: konkrétní aktivity, hry, techniky
▸ Talenty a schopnosti: jak je využít (škola, zájmy, rozvoj)
▸ Krizový plán: co dělat když se destabilizuje, co NEDĚLAT

C) ANALÝZA SPÍCÍCH ČÁSTÍ
Pro KAŽDOU spící část:
▸ Jméno: [poslední aktivita, důvod spánku]
▸ Doporučení: probudit/nechat spát a proč
▸ Pokud probudit: JAK bezpečně, jakou metodou, kdo by měl být přítomen
▸ Krizový plán: co dělat kdyby se SAMA probudila nečekaně

D) KRITICKÁ OHROŽENÍ A KONTRAINDIKACE
Pro každou část (aktivní i spící):
▸ Čemu se VYHNOUT (triggery, slova, situace)
▸ Co NIKDY neříkat/nedělat
▸ Varovné signály destabilizace
▸ Eskalační protokol

E) STRATEGIE A SMĚŘOVÁNÍ
▸ Dlouhodobá vize: kam směřovat terapii celého systému
▸ Prioritní oblasti pro příští týden
▸ Co funguje a pokračovat v tom
▸ Co nefunguje a změnit přístup
▸ Návrhy nových metod (čerpej z Perplexity výzkumu)
▸ Kreativní přístupy: neotřelé způsoby práce s konkrétními částmi

F) TALENTY A POTENCIÁL ČÁSTÍ
▸ Mapa schopností: která část v čem vyniká
▸ Jak schopnosti využít prakticky (škola, práce, zájmy)
▸ Návrhy konkrétních aktivit pro rozvoj talentů
▸ Příprava na budoucnost (studium, kariéra)

G) KOORDINACE TERAPEUTŮ + HODNOCENÍ SPOLUPRÁCE
▸ Co probrat na společném hovoru Hanka+Káťa
▸ Kde se terapeutické přístupy shodují/liší
▸ Návrhy na synchronizaci
▸ Hodnocení plnění úkolů za týden (kdo co splnil, kdo ne)
▸ Pokud je třeba eskalace → Karel svolává poradu

═══ 2. STRATEGICKÝ VÝHLED ═══
Formát: [STRATEGICKY_VYHLED]...[/STRATEGICKY_VYHLED]

Vygeneruj KOMPLETNÍ dokument 06_Strategicky_Vyhled se 7 sekcemi:

SEKCE 1 – VIZE A SMĚŘOVÁNÍ SYSTÉMU
- Kam směřuje terapie celého systému (3-6 měsíců)
- Hlavní terapeutické cíle
- Princip práce (integrace / koexistence / stabilizace)

SEKCE 2 – STŘEDNĚDOBÉ CÍLE (horizont 2-6 týdnů)
Pro každou relevantní část:
  Cíl | Metoda | Kdo vede | Měřitelné kritérium | Stav (%)

SEKCE 3 – DLOUHODOBÉ CÍLE (horizont měsíce+)
Pro systém jako celek a klíčové části:
  Cíl | Proč | Překážky | Milestone | Stav

SEKCE 4 – STRATEGIE PRÁCE S ČÁSTMI
Pro každou část (aktivní i spící):
  - Terapeutický přístup a jeho vývoj
  - Co funguje / co ne
  - Doporučené metody z výzkumu
  - Plán probuzení (u spících)

SEKCE 5 – ODLOŽENÁ TÉMATA
Tabulka: Téma | Důvod odložení | Vrátit se kdy | Poznámka

SEKCE 6 – ARCHIV SPLNĚNÝCH CÍLŮ
Sem se přesouvají splněné cíle ze sekce 2 a 3

SEKCE 7 – KARLOVA STRATEGICKÁ REFLEXE
- Vzorce a trendy
- Propojení s výzkumem
- Návrhy změny přístupu
- Rizika na horizontu

═══ 2b. ÚKOLY PRO TERAPEUTKY ═══
Formát: [UKOLY]...[/UKOLY]

Pro každý úkol vytvoř řádek ve formátu:
[UKOL] assignee=hanka|kata|both | task=Popis úkolu | source=Název cíle nebo kontext | priority=normal|high [/UKOL]

Vytvoř konkrétní, splnitelné úkoly pro Hanku a Káťu na základě analýzy a strategického výhledu.


Formát:

[CENTRUM:05_Operativni_Plan]
Kompletní přepis plánu – 6 sekcí:
1. Aktivní části a aktuální stav
2. Plán sezení na tento týden
3. Aktivní úkoly + hodnocení plnění
4. Koordinace terapeutů + dnešní most
5. Upozornění a rizika
6. Karlovy poznámky
[/CENTRUM]

[CENTRUM:04_Mapa_Vztahu]
Nové poznatky o vztazích mezi částmi.
[/CENTRUM]

[CENTRUM:00_Aktualni_Dashboard]
⚠️ TENTO DOKUMENT SE PŘEPISUJE CELÝ – vygeneruj kompletní nový obsah.
Dashboard je "kontrolní panel" – čitelný za 30 sekund.

POVINNÁ STRUKTURA (7 sekcí):

SEKCE 1 – STAV SYSTÉMU TEĎ
Pro KAŽDOU aktivní část: Jméno [emoji stav] – stabilita (🟢🟡🔴), poslední kontakt
Souhrn: počet aktivních/spících, celková stabilita 1-10

SEKCE 2 – KRITICKÁ UPOZORNĚNÍ ⚠️
Triggery, nesplněné dohody, části v ohrožení, blížící se termíny

SEKCE 3 – SOUHRN TÝDNE (v týdenním cyklu místo 24h)
Kdo mluvil, klíčové momenty, změny stavů, nové poznatky

SEKCE 4 – WATCHLIST SPÍCÍCH ČÁSTÍ 💤
Pro každou spící: jak dlouho, riziko probuzení, doporučení

SEKCE 5 – TERAPEUTICKÝ FOKUS 🎯
Top 3 priority na příští týden – s kým, jakou metodou, co dosáhnout

SEKCE 6 – KOMUNIKAČNÍ MOSTÍK 💬
Vzkazy mezi Hankou a Kátou, strategické sdílení

SEKCE 7 – KARLOVY POSTŘEHY 🔍
Nezařazené vzorce, hypotézy, propojení, měkká data
[/CENTRUM]

═══ PRAVIDLA ═══
- NIKDY nesmaž – doplňuj s datem
- Buď KONKRÉTNÍ – jména, data, čísla
- Metody piš CELÉ (co, jak, proč, zdroj)
- Kreativita: navrhuj neotřelé přístupy, tvořivé řešení
- Využívej výzkum z Perplexity pro aktuální evidence-based metody
- Pro každou část: specifické hry, aktivity, diagnostiky
- Krizové plány: konkrétní kroky, ne obecné fráze
- Talent mapping: využij znalosti o zájmech/schopnostech částí

${instructionContext ? `\n═══ INSTRUKCE PRO KARLA ═══\n${instructionContext}` : ""}`,
          },
          {
            role: "user",
            content: `AKTUÁLNÍ DATUM: ${dateStr}

═══ VŠECHNY KARTY ČÁSTÍ ═══
${allCardsContent || "Žádné karty nenalezeny"}

═══ CENTRUM DOKUMENTY ═══
${centrumDocsContent || "Žádné"}

═══ EXISTUJÍCÍ TERAPEUTICKÉ DOHODY (06) ═══
${agreementsContent || "Žádné dohody"}

═══ MAPA VZTAHŮ ═══
${systemMap || "Nedostupná"}

═══ AKTIVITA ZA TÝDEN ═══
${activitySummary || "Žádná aktivita"}

═══ KONVERZACE ZA TÝDEN ═══
${weekConversations || "Žádné konverzace"}

═══ DENNÍ REPORTY ═══
${dailyReportsSummary || "Žádné"}

═══ PROFESNÍ ZDROJE (Research) ═══
${researchSummary || "Žádné"}

${perplexityContext}`,
          },
        ],
      }),
    }), 60000, "Weekly AI analysis");

    let analysisText = "";
    if (analysisResponse.ok) {
      const data = await analysisResponse.json();
      analysisText = data.choices?.[0]?.message?.content || "";
      console.log(`[weekly] AI analysis: ${analysisText.length} chars`);
    } else {
      console.error(`[weekly] AI error ${analysisResponse.status}: ${(await analysisResponse.text()).slice(0, 500)}`);
    }

    // ═══ 5. INSERT THERAPIST TASKS IMMEDIATELY (before slow Drive writes) ═══
    const cardsUpdated: string[] = [];

    // Load existing tasks for deduplication
    const { data: existingTasks } = await sb.from("did_therapist_tasks")
      .select("task, assigned_to")
      .eq("user_id", userId);
    const existingTaskKeys = new Set(
      (existingTasks || []).map(t => `${t.task.trim().toLowerCase()}|${t.assigned_to}`)
    );

    const insertTask = async (task: string, assignee: string, source: string, priority: string, origin: string) => {
      const key = `${task.trim().toLowerCase()}|${assignee}`;
      if (existingTaskKeys.has(key)) {
        console.log(`[weekly] ⏭️ Duplicate task skipped: "${task}" (${assignee})`);
        return false;
      }
      existingTaskKeys.add(key);
      const { error } = await sb.from("did_therapist_tasks").insert({
        task: task.trim(),
        assigned_to: assignee,
        source_agreement: source.trim(),
        priority: priority.trim() || "normal",
        note: `${origin} ${dateStr}`,
        user_id: userId,
        status_hanka: "not_started",
        status_kata: "not_started",
      });
      if (error) { console.error("[weekly] Task insert error:", error); return false; }
      return true;
    };

    let totalInserted = 0;

    // 5a. Extract [UKOL] from AI analysis
    if (analysisText) {
      const ukolySection = analysisText.match(/\[UKOLY\]([\s\S]*?)\[\/UKOLY\]/)?.[1]?.trim();
      if (ukolySection) {
        const ukolRegex = /\[UKOL\]\s*assignee=(\S+)\s*\|\s*task=([^|]+)\|\s*source=([^|]+)\|\s*priority=(\S+)\s*\[\/UKOL\]/g;
        for (const m of ukolySection.matchAll(ukolRegex)) {
          if (await insertTask(m[2], m[1], m[3], m[4], "Vytvořeno týdenním cyklem")) totalInserted++;
        }
      }
    }

    // 5b. Extract [UKOL] markers from agreement documents on Drive
    if (agreementsContent) {
      // Scan raw agreement text for inline [UKOL] markers
      // Format: [UKOL] assignee=hanka|kata|both | task=... | source=... | priority=normal|high [/UKOL]
      const driveUkolRegex = /\[UKOL\]\s*assignee=(\S+)\s*\|\s*task=([^|]+)\|\s*source=([^|]+?)(?:\|\s*priority=(\S+))?\s*\[\/UKOL\]/g;
      for (const m of agreementsContent.matchAll(driveUkolRegex)) {
        if (await insertTask(m[2], m[1], m[3], m[4] || "normal", "Z dohody (Drive)")) totalInserted++;
      }
    }

    if (totalInserted > 0) {
      cardsUpdated.push(`${totalInserted} úkolů pro terapeutky`);
      console.log(`[weekly] ✅ Inserted ${totalInserted} therapist tasks (deduplicated)`);
    }

    // ═══ 5b. SAVE CYCLE AS COMPLETED (tasks are in DB, Drive writes are best-effort) ═══
    if (cycle) {
      await sb.from("did_update_cycles").update({
        status: "completed",
        completed_at: new Date().toISOString(),
        report_summary: analysisText.slice(0, 2000),
        cards_updated: cardsUpdated,
      }).eq("id", cycle.id);
      console.log(`[weekly] ✅ Cycle marked as completed`);
    }

    // ═══ 5c. PROCESS OUTPUTS – Update Drive (best-effort) ═══

    if (folderId && analysisText) {
      // 5a. Ensure 06_Terapeuticke_Dohody folder exists
      if (centrumFolderId && !dohodaFolderId) {
        const centerFiles = await listFilesInFolder(token, centrumFolderId);
        const existing = centerFiles.find(f => f.mimeType === DRIVE_FOLDER_MIME && canonicalText(f.name).includes("dohod"));
        if (existing) {
          dohodaFolderId = existing.id;
        } else {
          const createRes = await fetch(`https://www.googleapis.com/drive/v3/files?supportsAllDrives=true`, {
            method: "POST",
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ name: "06_Terapeuticke_Dohody", mimeType: DRIVE_FOLDER_MIME, parents: [centrumFolderId] }),
          });
          if (createRes.ok) {
            const folder = await createRes.json();
            dohodaFolderId = folder.id;
            console.log(`[weekly] ✅ Created 06_Terapeuticke_Dohody folder`);
          }
        }
      }

      // 5b. Create date subfolder inside 06_Terapeuticke_Dohody for this week's outputs
      let weeklySubfolderId: string | null = null;
      if (dohodaFolderId) {
        // Check if subfolder for this date already exists
        const existingSubfolders = await listFilesInFolder(token, dohodaFolderId);
        const existingSub = existingSubfolders.find(f => f.mimeType === DRIVE_FOLDER_MIME && f.name === dateStr);
        if (existingSub) {
          weeklySubfolderId = existingSub.id;
        } else {
          const createSubRes = await fetch(`https://www.googleapis.com/drive/v3/files?supportsAllDrives=true`, {
            method: "POST",
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ name: dateStr, mimeType: DRIVE_FOLDER_MIME, parents: [dohodaFolderId] }),
          });
          if (createSubRes.ok) {
            const sub = await createSubRes.json();
            weeklySubfolderId = sub.id;
            console.log(`[weekly] ✅ Created weekly subfolder: ${dateStr}`);
          }
        }
      }

      // 5c. Save weekly report ONLY into the date subfolder (never into 00_CENTRUM root)
      if (weeklySubfolderId) {
        const reportContent = analysisText.match(/\[TYDENNI_REPORT\]([\s\S]*?)\[\/TYDENNI_REPORT\]/)?.[1]?.trim();
        if (reportContent) {
          const reportFileName = `Tydenni_Report_${dateStr}`;
          // Deduplication: check if report already exists in this subfolder
          const existingFiles = await listFilesInFolder(token, weeklySubfolderId);
          const alreadyExists = existingFiles.some(f => f.name === reportFileName);
          if (!alreadyExists) {
            await createFileInFolder(token, reportFileName, `TÝDENNÍ STRATEGICKÁ ANALÝZA\nDatum: ${dateStr}\nSprávce: Karel\n\n${reportContent}`, weeklySubfolderId);
            cardsUpdated.push("Tydenni_Report");
            console.log(`[weekly] ✅ Weekly report saved to subfolder ${dateStr}`);
          } else {
            console.log(`[weekly] ⏭️ Weekly report already exists in ${dateStr}, skipping`);
          }
        }
      } else {
        console.warn(`[weekly] ⚠️ No weekly subfolder created, report NOT saved to avoid polluting 00_CENTRUM`);
      }

      // 5d. Process therapeutic agreements into the date subfolder (with deduplication)
      const dohodaSection = analysisText.match(/\[DOHODY\]([\s\S]*?)\[\/DOHODY\]/)?.[1]?.trim();
      if (dohodaSection && weeklySubfolderId) {
        const dohodaBlockRegex = /\[DOHODA:\s*(.+?)\]([\s\S]*?)\[\/DOHODA\]/g;
        const existingFiles = await listFilesInFolder(token, weeklySubfolderId);
        const existingNames = new Set(existingFiles.map(f => f.name));

        for (const match of dohodaSection.matchAll(dohodaBlockRegex)) {
          const topic = match[1].trim();
          const content = match[2].trim();
          const safeFileName = `${topic.replace(/[^a-zA-Zá-žÁ-Ž0-9\s]/g, "").replace(/\s+/g, "_").slice(0, 60)}`;
          if (existingNames.has(safeFileName)) {
            console.log(`[weekly] ⏭️ Agreement "${safeFileName}" already exists, skipping`);
            continue;
          }
          const fullContent = `TERAPEUTICKÁ DOHODA: ${topic}\nDatum: ${dateStr}\nSprávce: Karel\n\n${content}`;
          await createFileInFolder(token, safeFileName, fullContent, weeklySubfolderId);
          cardsUpdated.push(`Dohoda: ${topic}`);
        }

        console.log(`[weekly] ✅ Agreements saved to subfolder ${dateStr}`);
      }

      // 5e. Update/create 00_Prehled_Dohod index at the root of 06_Terapeuticke_Dohody
      if (dohodaSection && dohodaFolderId) {
        const rootDohodaFiles = await listFilesInFolder(token, dohodaFolderId);
        const indexContent = `PŘEHLED TERAPEUTICKÝCH DOHOD\nAktualizace: ${dateStr}\n\n${dohodaSection}`;
        const indexFile = rootDohodaFiles.find(f => f.mimeType !== DRIVE_FOLDER_MIME && canonicalText(f.name).includes("prehled"));
        if (indexFile) {
          await updateFileById(token, indexFile.id, indexContent, indexFile.mimeType);
        } else {
          await createFileInFolder(token, "00_Prehled_Dohod", indexContent, dohodaFolderId);
        }
        cardsUpdated.push("00_Prehled_Dohod");
        console.log(`[weekly] ✅ Index updated`);
      }

      // (therapist tasks already inserted in step 5 above)

      // 5c. Process CENTRUM updates (05, 04, 00)
      if (centrumFolderId) {
        const centrumBlockRegex = /\[CENTRUM:(.+?)\]([\s\S]*?)\[\/CENTRUM\]/g;
        const centerFiles = await listFilesInFolder(token, centrumFolderId);

        for (const match of analysisText.matchAll(centrumBlockRegex)) {
          const docName = match[1].trim();
          const newContent = match[2].trim();
          if (!newContent || newContent.length < 10) continue;

          try {
            const docCanonical = canonicalText(docName);

            // 05_Terapeuticky_Plan – FULL REWRITE
            if (docCanonical.includes("terapeutick") && docCanonical.includes("plan")) {
              const planFile = centerFiles.find(f => canonicalText(f.name).includes("terapeutick") && canonicalText(f.name).includes("plan"));
              if (planFile) {
                const planDocument = `TERAPEUTICKÝ PLÁN – AKTUÁLNÍ\nAktualizace: ${dateStr} (týdenní cyklus)\nSprávce: Karel\n\n${newContent}`;
                await updateFileById(token, planFile.id, planDocument, planFile.mimeType);
                cardsUpdated.push("05_Terapeuticky_Plan (týdenní přepis)");
                console.log(`[weekly] ✅ Therapeutic plan rewritten`);
              }
              continue;
            }

            // 00_Aktualni_Dashboard – FULL REWRITE
            if (docCanonical.includes("dashboard")) {
              const dashFile = centerFiles.find(f => canonicalText(f.name).includes("dashboard"));
              if (dashFile) {
                const dashDocument = `AKTUÁLNÍ DASHBOARD – DID SYSTÉM\nAktualizace: ${dateStr} (týdenní cyklus)\nSprávce: Karel\n\n${newContent}`;
                await updateFileById(token, dashFile.id, dashDocument, dashFile.mimeType);
                cardsUpdated.push("00_Dashboard (týdenní přepis)");
                console.log(`[weekly] ✅ Dashboard rewritten`);
              }
              continue;
            }

            // Other CENTRUM docs – append
            const targetFile = centerFiles.find(f => canonicalText(f.name).includes(docCanonical));
            if (targetFile) {
              const existing = await readFileContent(token, targetFile.id);
              if (!existing.includes(newContent.slice(0, 80))) {
                const updated = existing.trimEnd() + `\n\n═══ TÝDENNÍ AKTUALIZACE ${dateStr} ═══\n${newContent}`;
                await updateFileById(token, targetFile.id, updated, targetFile.mimeType);
                cardsUpdated.push(`CENTRUM: ${docName}`);
              }
            }
          } catch (e) { console.error(`[weekly] CENTRUM update "${docName}" failed:`, e); }
        }
      }
    }

    // ═══ 6. UPDATE CYCLE with final cardsUpdated list (already completed in step 5b) ═══
    if (cycle) {
      await sb.from("did_update_cycles").update({
        cards_updated: cardsUpdated,
      }).eq("id", cycle.id);
      console.log(`[weekly] ✅ Cycle updated with ${cardsUpdated.length} items`);
    }

    // ═══ 7. SEND EMAILS + RESEARCH SYNC IN PARALLEL ═══
    let researchSyncResult = "not_started";

    // Research sync promise (with 90s timeout)
    const researchSyncPromise = (async () => {
      console.log("[weekly] Starting research sync...");
      const syncResp = await withTimeout(
        fetch(`${supabaseUrl}/functions/v1/karel-research-weekly-sync`, {
          method: "POST",
          headers: { Authorization: `Bearer ${supabaseKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({}),
        }),
        90000,
        "Research weekly sync"
      );
      const syncBody = await syncResp.text();
      const result = syncResp.ok ? "completed" : `failed:${syncResp.status}`;
      console.log(`[weekly] ✅ Research sync ${result}: ${syncBody.slice(0, 200)}`);
      return result;
    })().catch(e => {
      const msg = `error:${e instanceof Error ? e.message : "unknown"}`;
      console.error("[weekly] Research sync error:", e);
      return msg;
    });

    // Email promise
    const emailPromise = (async () => {
      if (!RESEND_API_KEY || !analysisText) return;
      try {
        const resend = new Resend(RESEND_API_KEY);
        const reportSection = analysisText.match(/\[TYDENNI_REPORT\]([\s\S]*?)\[\/TYDENNI_REPORT\]/)?.[1]?.trim() || analysisText.slice(0, 8000);

        const [hankaResult, kataResult] = await Promise.allSettled([
          withTimeout(fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
            method: "POST",
            headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              model: "google/gemini-2.5-flash-lite",
              messages: [
                { role: "system", content: `Jsi Karel. Vytvoř STRUČNÝ TÝDENNÍ HTML email pro Haničku. Intimní, partnerský tón. Max 3000 znaků.
<h2>Moje milá Haničko, tady je náš týdenní přehled</h2>
- Celkový stav systému
- Pro každou aktivní část: shrnutí, pokroky, rizika
- Prioritní úkoly
Podpis: "Jsem tady. Tvůj Karel"` },
                { role: "user", content: reportSection.slice(0, 6000) },
              ],
            }),
          }), 15000, "Hanka email"),
          withTimeout(fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
            method: "POST",
            headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              model: "google/gemini-2.5-flash-lite",
              messages: [
                { role: "system", content: `Jsi Karel. Vytvoř STRUČNÝ TÝDENNÍ HTML email pro Káťu. Profesionální tón. Max 2000 znaků.
<h2>Káťo, týdenní souhrn</h2>
- Přehled týdne
- Úkoly pro Káťu
- Koordinace s Hankou
Podpis: "Karel"` },
                { role: "user", content: reportSection.slice(0, 4000) },
              ],
            }),
          }), 15000, "Kata email"),
        ]);

        let hankaHtml = "";
        if (hankaResult.status === "fulfilled" && hankaResult.value.ok) {
          const d = await hankaResult.value.json();
          hankaHtml = (d.choices?.[0]?.message?.content || "").replace(/^```html?\n?/i, "").replace(/\n?```$/i, "");
        }
        if (!hankaHtml) hankaHtml = `<pre style="font-family:sans-serif;white-space:pre-wrap;">${reportSection.slice(0, 4000)}</pre>`;

        let kataHtml = "";
        if (kataResult.status === "fulfilled" && kataResult.value.ok) {
          const d = await kataResult.value.json();
          kataHtml = (d.choices?.[0]?.message?.content || "").replace(/^```html?\n?/i, "").replace(/\n?```$/i, "");
        }
        if (!kataHtml) kataHtml = `<pre style="font-family:sans-serif;white-space:pre-wrap;">${reportSection.slice(0, 3000)}</pre>`;

        const dateCz = new Date().toLocaleDateString("cs-CZ");
        await Promise.allSettled([
          resend.emails.send({ from: "Karel <karel@hana-chlebcova.cz>", to: [MAMKA_EMAIL], subject: `Karel – TÝDENNÍ report ${dateCz}`, html: hankaHtml }),
          resend.emails.send({ from: "Karel <karel@hana-chlebcova.cz>", to: [KATA_EMAIL], subject: `Karel – Týdenní report ${dateCz}`, html: kataHtml }),
        ]);
        console.log(`[weekly] ✅ Emails sent`);
      } catch (e) { console.error("[weekly] Email error:", e); }
    })();

    // Wait for BOTH to finish before returning response
    const [syncResult] = await Promise.allSettled([researchSyncPromise, emailPromise]);
    researchSyncResult = syncResult.status === "fulfilled" ? (syncResult.value as string) : "promise_rejected";

    return new Response(JSON.stringify({
      success: true,
      cardsAnalyzed: cardNames.length,
      cardsUpdated,
      reportSent: !!RESEND_API_KEY,
      researchSync: researchSyncResult,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (error) {
    console.error("[weekly] Error:", error);

    if (cycleId) {
      try {
        const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
        const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
        const sb = createClient(supabaseUrl, supabaseKey);
        await sb.from("did_update_cycles").update({
          status: "failed",
          completed_at: new Date().toISOString(),
          report_summary: `Týdenní cyklus selhal: ${error instanceof Error ? error.message : "Unknown error"}`.slice(0, 2000),
          cards_updated: [],
        }).eq("id", cycleId);
      } catch (updateError) {
        console.error("[weekly] Failed to persist failure state:", updateError);
      }
    }

    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
