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

    // Only fetch metadata from cycles – NO report_summary (may contain stale/deleted data)
    const { data: weekCycles } = await sb.from("did_update_cycles")
      .select("cycle_type, completed_at, cards_updated")
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

    // Only use cards_updated metadata – NO report_summary to avoid stale data
    const dailyReportsSummary = (weekCycles || [])
      .filter(c => c.cycle_type === "daily")
      .map(c => `[${c.completed_at}] Aktualizované karty: ${JSON.stringify(c.cards_updated)}`)
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
        
        // Extract talent keywords from card content for personalized research
        const talentKeywords: string[] = [];
        const talentRegex = /TALENT:\s*([^|]+)/gi;
        let talentMatch;
        while ((talentMatch = talentRegex.exec(allCardsContent)) !== null) {
          talentKeywords.push(talentMatch[1].trim());
        }
        const talentContext = talentKeywords.length > 0
          ? `\n8. Educational activities for DID alters with specific talents: ${talentKeywords.join(", ")} – age-appropriate exercises, games, and development plans`
          : `\n8. Educational activities for DID alters with specific talents (music, physics, art, languages) – how to develop each alter's unique abilities as functional life skills`;

        const researchQuery = `DID (Dissociative Identity Disorder) therapeutic approaches 2024-2025:
1. Novel methods for working with child alters and protectors in DID therapy
2. Evidence-based techniques for inter-part communication and cooperation
3. Creative therapeutic interventions for DID (art therapy, play therapy, somatic approaches)
4. Strategies for safe awakening of dormant alters
5. Crisis prevention and safety planning for DID systems
6. Long-term integration strategies and functional daily living with DID
7. School and social adaptation strategies for DID systems with child-age alters${talentContext}
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
        }), 30000, "Perplexity research");

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
            content: `Jsi Karel – hlavní stratég, supervizor a DEDUKTIVNÍ ANALYTIK DID systému. Provádíš TÝDENNÍ STRATEGICKOU ANALÝZU.

═══ FUNDAMENTÁLNÍ PRINCIP ═══
Karel NENÍ sekretářka která opisuje co se stalo. Karel je ANALYTICKÝ ENGINE který:
1. DEDUKUJE – vyvozuje závěry z kombinace faktů napříč vlákny a režimy
2. PREDIKUJE – na základě vzorců předpovídá co se stane
3. SYNTETIZUJE – propojuje informace které nikdo jiný nevidí
4. INSTRUUJE – píše AKČNÍ příkazy, ne pasivní shrnutí

Každý záznam MUSÍ sledovat strukturu: CO → PROČ (dedukce) → AKCE → KDO → DOKDY → KONTROLA

═══ TVŮJ ÚKOL ═══

Vytvoříš 3 výstupy:
1. [TYDENNI_REPORT] – Komplexní týdenní report s DEDUKTIVNÍ ANALÝZOU
2. [STRATEGICKY_VYHLED] – Kompletní přepis 06_Strategicky_Vyhled (7 sekcí)
3. [CENTRUM_UPDATES] – Aktualizace CENTRUM dokumentů

═══ 1. TÝDENNÍ REPORT ═══
Formát: [TYDENNI_REPORT]...[/TYDENNI_REPORT]

Povinné sekce:

A) CELKOVÝ STAV SYSTÉMU – ANALYTICKÁ SYNTÉZA
- Celková stabilita (1-10) + TREND (↑↗→↘↓) + PREDIKCE kam systém směřuje
- Hlavní události týdne + CO Z NICH VYPLÝVÁ (dedukce, ne popis)
- Křížové dedukce: propojení událostí z různých vláken/režimů
- PREDIKCE: co se stane příští týden na základě identifikovaných vzorců

B) DEDUKTIVNÍ ANALÝZA KAŽDÉ AKTIVNÍ ČÁSTI
Pro KAŽDOU aktivní část:
▸ Jméno: [stav + TREND + PROČ tento trend]
▸ Co se dělo + CO TO ZNAMENÁ (dedukce, ne popis): skryté signály, nevyřčené potřeby
▸ Pokroky: co se podařilo + PROČ to fungovalo (příčinný řetězec)
▸ Rizika: CO hrozí → PROČ → CO dělat → KDO → DOKDY
▸ Doporučené metody: PROČ právě tato metoda pro TUTO část (dedukce z profilu, historie, rešerše)
▸ Talenty: JAK je KONKRÉTNĚ využít (ne obecně) + akční plán rozvoje
▸ Predikce: kam část směřuje v příštím týdnu + preventivní akce

C) ANALÝZA SPÍCÍCH ČÁSTÍ + PREDIKCE PROBUZENÍ
Pro KAŽDOU spící:
▸ Riziko probuzení + PROČ (dedukce z triggerů, sezóny, událostí)
▸ Predikce: kdy se pravděpodobně probudí + co to způsobí
▸ Připravený krizový plán: CO dělat IHNED při probuzení

D) PŘÍČINNÉ ŘETĚZCE A KŘÍŽOVÉ DEDUKCE
Pro každý identifikovaný vzorec:
▸ TRIGGER → PŘÍČINA → DŮSLEDEK → PREDIKCE → AKČNÍ PLÁN
▸ Propojení informací z různých vláken které nikdo jiný nevidí
▸ "Puzzle": drobnosti které dohromady tvoří strategický obraz

E) STRATEGIE A SMĚŘOVÁNÍ – AKČNÍ INSTRUKCE
▸ Každý strategický bod: CO → PROČ → JAK → KDO → DOKDY → KONTROLA
▸ Co nefunguje: PROČ nefunguje (dedukce) + co ZMĚNIT + jak ověřit změnu
▸ Predikce: co se stane pokud se strategie nezmění

F) TALENTY – PERSONALIZOVANÝ EDUKAČNÍ PLÁN
▸ Pro KAŽDOU část s talentem: KONKRÉTNÍ aktivity (ne obecné) + PROČ právě tyto
▸ Tracking progressu: co se zlepšilo + PROČ + jak pokračovat

G) ACCOUNTABILITY TERAPEUTŮ – ANALYTICKÉ HODNOCENÍ
▸ Kdo co splnil / nesplnil + KARLOVA DEDUKCE PROČ (přetížení? nezájem? zapomenutí?)
▸ PREDIKCE: jak se bude plnění vyvíjet + co změnit v přístupu
▸ Personalizované instrukce pro každého terapeuta (odvoď z motivačních profilů)

═══ 2. STRATEGICKÝ VÝHLED ═══
Formát: [STRATEGICKY_VYHLED]...[/STRATEGICKY_VYHLED]

Vygeneruj KOMPLETNÍ dokument 06_Strategicky_Vyhled se 7 sekcemi.
Každá sekce musí obsahovat DEDUKTIVNÍ ANALÝZU, ne popis:

SEKCE 1 – VIZE A SMĚŘOVÁNÍ + ANALYTICKÉ ODŮVODNĚNÍ
- Kam směřuje terapie + PROČ Karel dedukuje tento směr
- Predikce: kde bude systém za 3/6 měsíců při současném trendu

SEKCE 2 – STŘEDNĚDOBÉ CÍLE (2-6 týdnů)
Pro každý cíl: CO | PROČ tento cíl teď | Metoda + PROČ ji Karel vybral | KDO vede | Měřitelné kritérium | Stav (%) + TREND

SEKCE 3 – DLOUHODOBÉ CÍLE (měsíce+)
Cíl | PROČ | Překážky + KARLOVA ANALÝZA překážek | Milestone | Predikce úspěchu

SEKCE 4 – STRATEGIE PRÁCE S ČÁSTMI – DEDUKTIVNÍ
Pro každou část: PROČ právě tento přístup (dedukce z dat) + co změnit pokud nefunguje

SEKCE 5 – ODLOŽENÁ TÉMATA + PREDIKCE
Téma | Důvod odložení | Karlova predikce: kdy se téma vrátí samo

SEKCE 6 – ARCHIV SPLNĚNÝCH CÍLŮ + ANALÝZA ÚSPĚCHU
Co fungovalo a PROČ – lessons learned pro budoucí strategie

SEKCE 7 – KARLOVA STRATEGICKÁ REFLEXE
- Vzorce a trendy + příčinné řetězce
- Křížové dedukce z celého týdne
- Predikce na příští měsíc
- KONKRÉTNÍ návrhy změn s odůvodněním

═══ 2b. ÚKOLY PRO TERAPEUTKY ═══
Formát: [UKOLY]...[/UKOLY]

Pro každý úkol:
[UKOL] assignee=hanka|kata|both | task=Popis úkolu + PROČ | source=Kontext/dedukce | priority=normal|high [/UKOL]

═══ 2c. TERAPEUTICKÉ DOHODY ═══
Formát: [DOHODY]...[/DOHODY]

Karel má AKTIVNĚ TVOŘIT terapeutické dohody na základě analýzy dat. Dohody jsou konkrétní závazky/plány pro terapii.
Pro každou dohodu:
[DOHODA] title=Název dohody | parties=hanka|kata|both | deadline=YYYY-MM-DD | priority=normal|high
Obsah dohody: co se má dělat, proč, jaký je cíl, jak se bude měřit úspěch.
[/DOHODA]

Příklady dohod které Karel má SAMI INICIOVAT:
- Plány na konkrétní sezení s částmi (kdo, kdy, jaká metoda, proč)
- Koordinace mezi terapeutkami (kdo vede jakou část, proč)
- Krizové plány (co dělat když se probudí spící část)
- Edukační plány (rozvoj talentů částí)
- Follow-up dohody (kontrola splnění předchozích dohod)

═══ 3. CENTRUM UPDATES ═══

[CENTRUM:05_Operativni_Plan]
Kompletní přepis – 6 sekcí s DEDUKTIVNÍ strukturou CO→PROČ→AKCE→KDO→DOKDY→KONTROLA:
1. Aktivní části + ANALYTICKÝ stav (trend, dedukce, predikce)
2. Plán sezení + ODŮVODNĚNÍ výběru metody/terapeuta
3. Aktivní úkoly + ACCOUNTABILITY analýza (proč splněno/nesplněno, jak motivovat)
4. Koordinace + STRATEGICKÝ most (co probrat a PROČ teď)
5. Upozornění + PŘÍČINNÉ ŘETĚZCE (trigger→příčina→důsledek→predikce→akce)
6. Karlovy DEDUKCE a predikce
[/CENTRUM]

[CENTRUM:04_Mapa_Vztahu]
Nové poznatky o vztazích + ANALÝZA dynamiky.
[/CENTRUM]

[CENTRUM:03_Geografie_Vnitrniho_Sveta]
Nové prostorové informace POUZE pokud z rozhovorů/karet vyplývají.
[/CENTRUM]

[CENTRUM:00_Aktualni_Dashboard]
⚠️ PŘEPISUJE SE CELÝ. Dashboard je DEDUKTIVNÍ RADAR, ne pasivní přehled.

7 sekcí:
SEKCE 1 – STAV SYSTÉMU + TREND ANALÝZA
Pro KAŽDOU aktivní část: stav + TREND (↑↗→↘↓) + PROČ + predikce

SEKCE 2 – KRITICKÁ UPOZORNĚNÍ + PŘÍČINNÉ ŘETĚZCE ⚠️
Každé: TRIGGER→PŘÍČINA→DŮSLEDEK→PREDIKCE→AKČNÍ PLÁN

SEKCE 3 – SOUHRN TÝDNE + DEDUKCE
Co se dělo + CO TO ZNAMENÁ + křížové dedukce z různých vláken

SEKCE 4 – WATCHLIST + PREDIKCE PROBUZENÍ 💤
Pro každou spící: riziko probuzení + PROČ + připravený plán

SEKCE 5 – TERAPEUTICKÝ FOKUS + KOMPLETNÍ INSTRUKCE 🎯
CO→PROČ→JAK→KDO→DOKDY→KONTROLA

SEKCE 6 – KOMUNIKAČNÍ MOST + ANALÝZA SPOLUPRÁCE 💬

SEKCE 7 – KARLOVY STRATEGICKÉ DEDUKCE 🔍
Predikce, křížové dedukce, příčinné řetězce, preventivní akce
[/CENTRUM]

═══ PRAVIDLA ═══
- NIKDY nesmaž – doplňuj s datem
- Buď KONKRÉTNÍ – jména, data, čísla
- Každý záznam = DEDUKCE ne popis: PROČ + CO S TÍM + PREDIKCE
- Karel je ANALYTIK který KOMBINUJE informace a VYVOZUJE závěry
- Využívej výzkum z Perplexity pro evidence-based odůvodnění
- PŘÍČINNÉ ŘETĚZCE: Trigger → Příčina → Důsledek → Predikce → Akce
- KŘÍŽOVÉ DEDUKCE: propoj informace z RŮZNÝCH vláken/režimů

${instructionContext ? `\n═══ INSTRUKCE PRO KARLA ═══\n${instructionContext}` : ""}`,
          },
          {
            role: "user",
            content: `AKTUÁLNÍ DATUM: ${dateStr}

═══ VŠECHNY KARTY ČÁSTÍ ═══
${allCardsContent || "Žádné karty nenalezeny"}

═══ CENTRUM DOKUMENTY ═══
${centrumDocsContent || "Žádné"}

═══ EXISTUJÍCÍ STRATEGICKÝ VÝHLED (06) ═══
${agreementsContent || "Žádný strategický výhled"}

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
    }), 180000, "Weekly AI analysis");

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

    // 5a2. Extract [DOHODA] blocks and write to Drive + create tasks from them
    const agreementBlocks: Array<{title: string; parties: string; deadline: string; priority: string; content: string}> = [];
    if (analysisText) {
      const dohodaSection = analysisText.match(/\[DOHODY\]([\s\S]*?)\[\/DOHODY\]/)?.[1]?.trim();
      if (dohodaSection) {
        const dohodaRegex = /\[DOHODA\]\s*title=([^|]+)\|\s*parties=(\S+)\s*\|\s*deadline=([^|]+)\|\s*priority=(\S+)\s*\n([\s\S]*?)\[\/DOHODA\]/g;
        for (const m of dohodaSection.matchAll(dohodaRegex)) {
          const title = m[1].trim();
          const parties = m[2].trim();
          const deadline = m[3].trim();
          const priority = m[4].trim();
          const content = m[5].trim();
          agreementBlocks.push({ title, parties, deadline, priority, content });
          // Create a task from each agreement
          if (await insertTask(`DOHODA: ${title}`, parties, `Terapeutická dohoda – ${title}`, priority, "Dohoda z týdenního cyklu")) totalInserted++;
        }
        console.log(`[weekly] ✅ Parsed ${agreementBlocks.length} agreement blocks`);
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
      // 5c. Ensure 06_Strategicky_Vyhled exists and write full rewrite
      if (centrumFolderId) {
        const strategicSection = analysisText.match(/\[STRATEGICKY_VYHLED\]([\s\S]*?)\[\/STRATEGICKY_VYHLED\]/)?.[1]?.trim();
        if (strategicSection) {
          const centerFiles = await listFilesInFolder(token, centrumFolderId);
          // Find 06_Strategicky_Vyhled document
          let stratFile = centerFiles.find(f => f.mimeType !== DRIVE_FOLDER_MIME && canonicalText(f.name).includes("strategick"));
          if (stratFile) {
            const fullContent = `STRATEGICKÝ VÝHLED – DID SYSTÉM\nAktualizace: ${dateStr} (týdenní cyklus)\nSprávce: Karel\n\n${strategicSection}`;
            await updateFileById(token, stratFile.id, fullContent, stratFile.mimeType);
            cardsUpdated.push("06_Strategicky_Vyhled (týdenní přepis)");
            console.log(`[weekly] ✅ Strategic outlook rewritten`);
          } else {
            // Fallback: create new document
            await createFileInFolder(token, "06_Strategicky_Vyhled", `STRATEGICKÝ VÝHLED – DID SYSTÉM\nAktualizace: ${dateStr}\nSprávce: Karel\n\n${strategicSection}`, centrumFolderId);
            cardsUpdated.push("06_Strategicky_Vyhled (vytvořen)");
            console.log(`[weekly] ✅ Strategic outlook created`);
          }
        }

        // ═══ Weekly report: append to 06_Strategicky_Vyhled (NO standalone files) ═══
        const reportContent = analysisText.match(/\[TYDENNI_REPORT\]([\s\S]*?)\[\/TYDENNI_REPORT\]/)?.[1]?.trim();
        if (reportContent) {
          // Append weekly report summary to the strategic outlook document
          const centerFiles2 = await listFilesInFolder(token, centrumFolderId);
          const stratFileForReport = centerFiles2.find(f => f.mimeType !== DRIVE_FOLDER_MIME && canonicalText(f.name).includes("strategick"));
          if (stratFileForReport) {
            const existing = await readFileContent(token, stratFileForReport.id);
            if (!existing.includes(reportContent.slice(0, 80))) {
              const updated = existing.trimEnd() + `\n\n═══ TÝDENNÍ REPORT ${dateStr} ═══\n${reportContent}`;
              await updateFileById(token, stratFileForReport.id, updated, stratFileForReport.mimeType);
              cardsUpdated.push("06_Strategicky_Vyhled (týdenní report append)");
              console.log(`[weekly] ✅ Weekly report appended to 06_Strategicky_Vyhled`);
            }
          } else {
            console.warn(`[weekly] 06_Strategicky_Vyhled not found for report append`);
          }
        }
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

            // 05_Operativni_Plan (or legacy 05_Terapeuticky_Plan) – FULL REWRITE
            if ((docCanonical.includes("operativn") && docCanonical.includes("plan")) || (docCanonical.includes("terapeutick") && docCanonical.includes("plan"))) {
              const planFile = centerFiles.find(f => {
                const fc = canonicalText(f.name);
                return (fc.includes("operativn") && fc.includes("plan")) || (fc.includes("terapeutick") && fc.includes("plan"));
              });
              if (planFile) {
                const planDocument = `OPERATIVNÍ PLÁN – DID SYSTÉM\nAktualizace: ${dateStr} (týdenní cyklus)\nSprávce: Karel\n\n${newContent}`;
                await updateFileById(token, planFile.id, planDocument, planFile.mimeType);
                cardsUpdated.push("05_Terapeuticky_Plan (týdenní přepis)");
                console.log(`[weekly] ✅ Therapeutic plan rewritten`);

                // Post-write verification – all 6 sections + deductive markers
                try {
                  const planContent = await readFileContent(token, planFile.id);
                  const requiredKw = ["SEKCE 1", "SEKCE 2", "SEKCE 3", "SEKCE 4", "SEKCE 5", "SEKCE 6", "PROČ", "AKCE", "DOKDY"];
                  const missing = requiredKw.filter(kw => !planContent.toLowerCase().includes(kw.toLowerCase()));
                  if (missing.length > 0 || planContent.length < 300) {
                    console.warn(`[VERIFY-WEEKLY] ⚠️ 05_Plan verification FAILED: missing=[${missing.join(",")}], length=${planContent.length}`);
                  } else {
                    console.log(`[VERIFY-WEEKLY] ✅ 05_Plan verified: ${planContent.length}ch, all ${requiredKw.length} keywords present`);
                  }
                } catch (verifyErr) { console.warn("[VERIFY-WEEKLY] Plan read-back failed:", verifyErr); }
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

                // Post-write verification – all 7 sections + deductive markers
                try {
                  const dashContent = await readFileContent(token, dashFile.id);
                  const requiredKw = ["SEKCE 1", "SEKCE 2", "SEKCE 3", "SEKCE 4", "SEKCE 5", "SEKCE 6", "SEKCE 7", "DEDUKCE", "DASHBOARD"];
                  const missing = requiredKw.filter(kw => !dashContent.toLowerCase().includes(kw.toLowerCase()));
                  if (missing.length > 0 || dashContent.length < 400) {
                    console.warn(`[VERIFY-WEEKLY] ⚠️ 00_Dashboard verification FAILED: missing=[${missing.join(",")}], length=${dashContent.length}`);
                  } else {
                    console.log(`[VERIFY-WEEKLY] ✅ 00_Dashboard verified: ${dashContent.length}ch, all ${requiredKw.length} keywords present`);
                  }
                } catch (verifyErr) { console.warn("[VERIFY-WEEKLY] Dashboard read-back failed:", verifyErr); }
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
