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

const PHASE_BUDGET_MS = 130000;
const GOOGLE_FETCH_TIMEOUT_MS = 12000;
const PERPLEXITY_TIMEOUT_MS = 12000;
const MIN_BUDGET_FOR_PERPLEXITY_MS = 22000;

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timeoutId: number | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms);
  });
  try { return await Promise.race([promise, timeoutPromise]); }
  finally { if (timeoutId) clearTimeout(timeoutId); }
}

async function fetchWithRetry(input: string, init: RequestInit, label: string, timeoutMs: number, attempts = 2) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await withTimeout(fetch(input, init), timeoutMs, `${label} (attempt ${attempt})`);
      if (response.ok || response.status < 500) return response;
      lastError = new Error(`${label} failed with status ${response.status}`);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`${label} failed`);
}

const hasBudget = (startedAt: number, reserveMs = 0) => Date.now() - startedAt < PHASE_BUDGET_MS - reserveMs;

// ═══ OAuth2 token helper ═══
async function getAccessToken(): Promise<string> {
  const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
  const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET");
  const refreshToken = Deno.env.get("GOOGLE_REFRESH_TOKEN");
  if (!clientId || !clientSecret || !refreshToken) throw new Error("Missing Google OAuth credentials");

  const res = await fetchWithRetry(
    "https://oauth2.googleapis.com/token",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" }),
    },
    "Google token",
    GOOGLE_FETCH_TIMEOUT_MS,
    3,
  );

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

// ═══ Helper: update cycle phase ═══
async function updatePhase(sb: any, cycleId: string, phase: string, detail: string, extra?: Record<string, any>) {
  await sb.from("did_update_cycles").update({
    phase, phase_detail: detail, started_at: new Date().toISOString(), ...extra,
  }).eq("id", cycleId);
  console.log(`[weekly] Phase: ${phase} – ${detail}`);
}

// ═══════════════════════════════════════════
// PHASE HANDLERS
// ═══════════════════════════════════════════

async function phaseKickoff(sb: any, userId: string, forceRun: boolean, isCronCall: boolean) {
  const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
  const MAMKA_EMAIL = "mujosobniasistentnamiru@gmail.com";

  // Auto-cleanup stuck cycles (>8 min without heartbeat)
  const staleRunningThreshold = new Date(Date.now() - 8 * 60 * 1000).toISOString();
  const { data: stuckCycles } = await sb.from("did_update_cycles")
    .select("id, cycle_type, started_at, phase")
    .eq("status", "running")
    .lt("started_at", staleRunningThreshold);

  if (stuckCycles && stuckCycles.length > 0) {
    for (const stuck of stuckCycles) {
      await sb.from("did_update_cycles").update({
        status: "failed",
        completed_at: new Date().toISOString(),
        phase: "failed",
        phase_detail: `Automaticky ukončeno ve fázi ${stuck.phase || "unknown"}`,
        report_summary: `Cyklus automaticky označen jako neúspěšný (bez heartbeat > 8 min). Spuštěn: ${stuck.started_at}`,
      }).eq("id", stuck.id);
    }
    console.log(`[weekly] Auto-cleanup: ${stuckCycles.length} stuck cycles marked as failed`);
    if (RESEND_API_KEY) {
      try {
        const resend = new Resend(RESEND_API_KEY);
        await resend.emails.send({
          from: "Karel <karel@hana-chlebcova.cz>", to: [MAMKA_EMAIL],
          subject: `⚠️ Karel – ${stuckCycles.length} zaseklý cyklus vyčištěn`,
          html: `<p>Karel automaticky vyčistil <strong>${stuckCycles.length}</strong> zaseklý/é cyklus/y.</p><p>Karel</p>`,
        });
      } catch {}
    }
  }

  // Prevent duplicate runs only for fresh heartbeats
  const duplicateGuardThreshold = new Date(Date.now() - 6 * 60 * 1000).toISOString();
  const { data: alreadyRunning } = await sb.from("did_update_cycles")
    .select("id, started_at, phase")
    .eq("cycle_type", "weekly").eq("status", "running")
    .gte("started_at", duplicateGuardThreshold)
    .order("started_at", { ascending: false }).limit(1).maybeSingle();

  if (alreadyRunning) {
    return { skipped: true, reason: "already_running", cycleId: alreadyRunning.id, phase: alreadyRunning.phase };
  }

  // Cooldown check (only for auto cron, not manual force)
  if (isCronCall && !forceRun) {
    const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
    const { data: recentCompleted } = await sb.from("did_update_cycles")
      .select("id, completed_at")
      .eq("cycle_type", "weekly").eq("status", "completed")
      .gte("completed_at", sixHoursAgo).limit(1).maybeSingle();
    if (recentCompleted) {
      return { skipped: true, reason: "already_completed_recently", cycleId: recentCompleted.id };
    }
  }

  // Create cycle record
  const { data: cycle } = await sb.from("did_update_cycles")
    .insert({ cycle_type: "weekly", status: "running", user_id: userId, phase: "created", phase_detail: "Cyklus vytvořen" })
    .select().single();

  return { cycleId: cycle.id, phase: "created" };
}

async function phaseGather(sb: any, cycleId: string, userId: string) {
  await updatePhase(sb, cycleId, "gathering", "Sbírám data z Drive a databáze...");

  const token = await getAccessToken();
  const dateStr = new Date().toISOString().slice(0, 10);

  let allCardsContent = "";
  let centrumDocsContent = "";
  let agreementsContent = "";
  let instructionContext = "";
  let systemMap = "";
  const cardNames: string[] = [];
  let centrumFolderId: string | null = null;
  let dohodaFolderId: string | null = null;
  let folderId: string | null = null;

  folderId = await findFolder(token, "kartoteka_DID") || await findFolder(token, "Kartoteka_DID") || await findFolder(token, "Kartotéka_DID");

  if (folderId) {
    const rootChildren = await listFilesInFolder(token, folderId);
    const rootFolders = rootChildren.filter(f => f.mimeType === DRIVE_FOLDER_MIME);
    const centerFolder = rootFolders.find(f => /^00/.test(f.name.trim()) || canonicalText(f.name).includes("centrum"));
    const activeFolder = rootFolders.find(f => /^01/.test(f.name.trim()) || canonicalText(f.name).includes("aktiv"));
    const archiveFolder = rootFolders.find(f => /^03/.test(f.name.trim()) || canonicalText(f.name).includes("archiv"));

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

    if (centerFolder) {
      centrumFolderId = centerFolder.id;
      const centerFiles = await listFilesInFolder(token, centerFolder.id);
      for (const file of centerFiles) {
        if (file.mimeType === DRIVE_FOLDER_MIME) {
          if (canonicalText(file.name).includes("dohod")) {
            dohodaFolderId = file.id;
            const dohodaFiles = await listFilesInFolder(token, file.id);
            for (const df of dohodaFiles) {
              try {
                const content = await readFileContent(token, df.id);
                agreementsContent += `\n=== DOHODA: ${df.name} ===\n${truncate(content, MAX_AGREEMENT_CHARS)}\n`;
              } catch {}
            }
          }
          continue;
        }
        try {
          const content = await readFileContent(token, file.id);
          const cn = canonicalText(file.name);
          if (cn.includes("instrukce")) instructionContext = truncate(content, MAX_INSTRUCTION_CHARS);
          else if (cn.includes("mapa") && cn.includes("vztah")) systemMap = truncate(content, MAX_SYSTEM_MAP_CHARS);
          centrumDocsContent += `\n=== CENTRUM: ${file.name} ===\n${truncate(content, MAX_CENTRUM_CHARS)}\n`;
        } catch {}
      }
    }
  }
  console.log(`[weekly] Loaded ${cardNames.length} cards`);

  // DB data
  const weekAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
  const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const [weekThreadsRes, monthThreadsRes, weekCyclesRes, researchRes] = await Promise.all([
    sb.from("did_threads").select("part_name, sub_mode, started_at, last_activity_at, messages, part_language").eq("sub_mode", "cast").gte("started_at", weekAgo),
    sb.from("did_threads").select("part_name, sub_mode, started_at, last_activity_at, messages").eq("sub_mode", "cast").gte("started_at", monthAgo),
    sb.from("did_update_cycles").select("cycle_type, completed_at, cards_updated").eq("status", "completed").gte("completed_at", weekAgo).order("completed_at", { ascending: true }),
    sb.from("research_threads").select("topic, messages, created_by, last_activity_at").eq("is_deleted", false).gte("last_activity_at", monthAgo),
  ]);

  const weekThreads = weekThreadsRes.data || [];
  const monthThreads = monthThreadsRes.data || [];
  const weekCycles = weekCyclesRes.data || [];
  const researchThreads = researchRes.data || [];

  // Build activity summaries
  const activityByPart = new Map<string, { weekMsgs: number; monthMsgs: number; lastSeen: string; modes: Set<string>; language: string }>();
  for (const t of monthThreads) {
    const rawName = String(t.part_name || "").trim();
    const cn = /^(dymi|dymytri|dymitri|dmytri)$/i.test(rawName) ? "DMYTRI" : rawName.split(/[\n,;|]+/)[0].trim();
    const hasUser = Array.isArray(t.messages) && t.messages.some((m: any) => m?.role === "user" && typeof m?.content === "string" && m.content.trim().length > 0);
    if (!cn || !hasUser || /(aktivni|aktivní|sleeping|spici|spící|warning)/i.test(cn)) continue;
    const existing = activityByPart.get(cn) || { weekMsgs: 0, monthMsgs: 0, lastSeen: "", modes: new Set(), language: "cs" };
    existing.monthMsgs += ((t.messages as any[]) || []).filter((m: any) => m?.role === "user").length;
    existing.modes.add(t.sub_mode);
    if (!existing.lastSeen || t.last_activity_at > existing.lastSeen) existing.lastSeen = t.last_activity_at;
    activityByPart.set(cn, existing);
  }
  for (const t of weekThreads) {
    const rawName = String(t.part_name || "").trim();
    const cn = /^(dymi|dymytri|dymitri|dmytri)$/i.test(rawName) ? "DMYTRI" : rawName.split(/[\n,;|]+/)[0].trim();
    const hasUser = Array.isArray(t.messages) && t.messages.some((m: any) => m?.role === "user" && typeof m?.content === "string" && m.content.trim().length > 0);
    if (!cn || !hasUser || /(aktivni|aktivní|sleeping|spici|spící|warning)/i.test(cn)) continue;
    const existing = activityByPart.get(cn) || { weekMsgs: 0, monthMsgs: 0, lastSeen: "", modes: new Set(), language: t.part_language || "cs" };
    existing.weekMsgs += ((t.messages as any[]) || []).filter((m: any) => m?.role === "user").length;
    existing.language = t.part_language || existing.language;
    activityByPart.set(cn, existing);
  }

  const activitySummary = Array.from(activityByPart.entries())
    .map(([name, d]) => `- ${name}: Týden=${d.weekMsgs} zpráv, Měsíc=${d.monthMsgs} zpráv, Jazyk: ${d.language}, Poslední: ${d.lastSeen}`)
    .join("\n");

  const dailyReportsSummary = (weekCycles).filter(c => c.cycle_type === "daily")
    .map(c => `[${c.completed_at}] Aktualizované karty: ${JSON.stringify(c.cards_updated)}`).join("\n---\n");

  const weekConversations = weekThreads.slice(0, 12).map(t => {
    const msgs = ((t.messages as any[]) || []).slice(-6);
    const isCast = t.sub_mode === "cast";
    return `=== ${t.part_name} (${t.sub_mode}, ${t.started_at}) ===\n${msgs.map((m: any) => `[${m.role === "user" ? (isCast ? "ČÁST" : "TERAPEUT") : "KAREL"}]: ${typeof m.content === "string" ? truncate(m.content, MAX_CONVERSATION_MESSAGE_CHARS) : "(multimodal)"}`).join("\n")}`;
  }).join("\n\n---\n\n");

  const researchSummary = researchThreads.slice(0, 8).map(rt => {
    const msgs = ((rt.messages as any[]) || []).slice(-4);
    return `Téma: ${rt.topic} (${rt.created_by})\n${msgs.map((m: any) => `[${m.role}]: ${typeof m.content === "string" ? truncate(m.content, MAX_RESEARCH_MESSAGE_CHARS) : ""}`).join("\n")}`;
  }).join("\n---\n");

  // Perplexity research
  let perplexityContext = "";
  const PERPLEXITY_API_KEY = Deno.env.get("PERPLEXITY_API_KEY");
  if (PERPLEXITY_API_KEY && allCardsContent.length > 100) {
    try {
      await updatePhase(sb, cycleId, "gathering", "Hledám nové výzkumy (Perplexity)...");
      const activeFragments = cardNames.filter(n => n.includes("AKTIVNÍ")).map(n => n.replace(" [AKTIVNÍ]", "")).join(", ");
      const talentKeywords: string[] = [];
      const talentRegex = /TALENT:\s*([^|]+)/gi;
      let m;
      while ((m = talentRegex.exec(allCardsContent)) !== null) talentKeywords.push(m[1].trim());
      const talentContext = talentKeywords.length > 0
        ? `\n8. Educational activities for DID alters with specific talents: ${talentKeywords.join(", ")}`
        : `\n8. Educational activities for DID alters with specific talents (music, physics, art, languages)`;

      const pRes = await withTimeout(fetch("https://api.perplexity.ai/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${PERPLEXITY_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "sonar-pro",
          messages: [
            { role: "system", content: "You are a clinical DID researcher. Return specific, actionable therapeutic methods, contraindications, novel approaches, and academic references." },
            { role: "user", content: `DID therapeutic approaches 2024-2025:\n1. Novel methods for child alters\n2. Inter-part communication\n3. Creative interventions\n4. Safe awakening of dormant alters\n5. Crisis prevention\n6. Integration strategies\n7. School/social adaptation${talentContext}\nActive parts: ${activeFragments}` },
          ],
          search_mode: "academic", search_recency_filter: "year",
        }),
      }), 30000, "Perplexity");

      if (pRes.ok) {
        const pData = await pRes.json();
        const text = pData.choices?.[0]?.message?.content || "";
        const citations: string[] = pData.citations || [];
        if (text) {
          perplexityContext = `\n\n═══ AKTUÁLNÍ VÝZKUM (Perplexity) ═══\n${text}`;
          if (citations.length > 0) perplexityContext += `\n\nCitace:\n${citations.map((c, i) => `[${i + 1}] ${c}`).join("\n")}`;
        }
      }
    } catch (e) { console.warn("[weekly] Perplexity failed:", e); }
  }

  // Save gathered context
  const context = {
    allCardsContent, centrumDocsContent, agreementsContent, instructionContext, systemMap,
    cardNames, centrumFolderId, dohodaFolderId, folderId,
    activitySummary, dailyReportsSummary, weekConversations, researchSummary, perplexityContext,
    dateStr, userId,
  };

  await sb.from("did_update_cycles").update({
    phase: "gathered", phase_detail: `Data sebrána: ${cardNames.length} karet`,
    context_data: context, started_at: new Date().toISOString(),
  }).eq("id", cycleId);

  return { phase: "gathered", cardsFound: cardNames.length };
}

async function phaseAnalyze(sb: any, cycleId: string) {
  await updatePhase(sb, cycleId, "analyzing", "AI analyzuje data (může trvat 1-2 minuty)...");

  const { data: cycle } = await sb.from("did_update_cycles").select("context_data").eq("id", cycleId).single();
  const ctx = cycle.context_data;
  const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
  if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY not configured");

  // Build the AI prompt (same as before, extracted from context)
  const systemPrompt = buildSystemPrompt(ctx.instructionContext);
  const userPrompt = buildUserPrompt(ctx);

  const analysisResponse = await withTimeout(fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "google/gemini-2.5-flash",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    }),
  }), 150000, "Weekly AI analysis");

  let analysisText = "";
  if (analysisResponse.ok) {
    const data = await analysisResponse.json();
    analysisText = data.choices?.[0]?.message?.content || "";
    console.log(`[weekly] AI analysis: ${analysisText.length} chars`);
  } else {
    const errText = (await analysisResponse.text()).slice(0, 500);
    console.error(`[weekly] AI error ${analysisResponse.status}: ${errText}`);
    throw new Error(`AI analysis failed: ${analysisResponse.status}`);
  }

  // Save analysis to context_data
  const updatedContext = { ...ctx, analysisText };
  await sb.from("did_update_cycles").update({
    phase: "analyzed", phase_detail: `Analýza dokončena: ${analysisText.length} znaků`,
    context_data: updatedContext, started_at: new Date().toISOString(),
  }).eq("id", cycleId);

  return { phase: "analyzed", analysisLength: analysisText.length };
}

async function phaseDistribute(sb: any, cycleId: string) {
  await updatePhase(sb, cycleId, "distributing", "Zapisuji na Drive a synchronizuji úkoly...");

  const { data: cycle } = await sb.from("did_update_cycles").select("context_data").eq("id", cycleId).single();
  const ctx = cycle.context_data;
  const { analysisText, folderId, centrumFolderId, dohodaFolderId, cardNames, userId, dateStr, agreementsContent } = ctx;
  const cardsUpdated: string[] = [];

  // ═══ Insert therapist tasks ═══
  const { data: existingTasks } = await sb.from("did_therapist_tasks").select("task, assigned_to").eq("user_id", userId);
  const existingTaskKeys = new Set((existingTasks || []).map((t: any) => `${t.task.trim().toLowerCase()}|${t.assigned_to}`));

  const insertTask = async (task: string, assignee: string, source: string, priority: string, origin: string) => {
    const key = `${task.trim().toLowerCase()}|${assignee}`;
    if (existingTaskKeys.has(key)) return false;
    existingTaskKeys.add(key);
    const { error } = await sb.from("did_therapist_tasks").insert({
      task: task.trim(), assigned_to: assignee, source_agreement: source.trim(),
      priority: priority.trim() || "normal", note: `${origin} ${dateStr}`,
      user_id: userId, status_hanka: "not_started", status_kata: "not_started",
    });
    if (error) { console.error("[weekly] Task insert error:", error); return false; }
    return true;
  };

  let totalInserted = 0;

  // Extract [UKOL] from AI
  if (analysisText) {
    const ukolySection = analysisText.match(/\[UKOLY\]([\s\S]*?)\[\/UKOLY\]/)?.[1]?.trim();
    if (ukolySection) {
      const ukolRegex = /\[UKOL\]\s*assignee=(\S+)\s*\|\s*task=([^|]+)\|\s*source=([^|]+)\|\s*priority=(\S+)\s*\[\/UKOL\]/g;
      for (const m of ukolySection.matchAll(ukolRegex)) {
        if (await insertTask(m[2], m[1], m[3], m[4], "Vytvořeno týdenním cyklem")) totalInserted++;
      }
    }
  }

  // Extract [DOHODA] blocks
  const agreementBlocks: Array<{title: string; parties: string; deadline: string; priority: string; content: string}> = [];
  if (analysisText) {
    const dohodaSection = analysisText.match(/\[DOHODY\]([\s\S]*?)\[\/DOHODY\]/)?.[1]?.trim();
    if (dohodaSection) {
      const dohodaRegex = /\[DOHODA\]\s*title=([^|]+)\|\s*parties=(\S+)\s*\|\s*deadline=([^|]+)\|\s*priority=(\S+)\s*\n([\s\S]*?)\[\/DOHODA\]/g;
      for (const m of dohodaSection.matchAll(dohodaRegex)) {
        agreementBlocks.push({ title: m[1].trim(), parties: m[2].trim(), deadline: m[3].trim(), priority: m[4].trim(), content: m[5].trim() });
        if (await insertTask(`DOHODA: ${m[1].trim()}`, m[2].trim(), `Terapeutická dohoda – ${m[1].trim()}`, m[4].trim(), "Dohoda z týdenního cyklu")) totalInserted++;
      }
    }
  }

  // Extract [UKOL] from Drive agreements
  if (agreementsContent) {
    const driveUkolRegex = /\[UKOL\]\s*assignee=(\S+)\s*\|\s*task=([^|]+)\|\s*source=([^|]+?)(?:\|\s*priority=(\S+))?\s*\[\/UKOL\]/g;
    for (const m of agreementsContent.matchAll(driveUkolRegex)) {
      if (await insertTask(m[2], m[1], m[3], m[4] || "normal", "Z dohody (Drive)")) totalInserted++;
    }
  }

  if (totalInserted > 0) {
    cardsUpdated.push(`${totalInserted} úkolů pro terapeutky`);
    console.log(`[weekly] ✅ Inserted ${totalInserted} therapist tasks`);
  }

  // ═══ Drive writes ═══
  if (folderId && analysisText) {
    const token = await getAccessToken();

    if (centrumFolderId) {
      // Strategic outlook
      const strategicSection = analysisText.match(/\[STRATEGICKY_VYHLED\]([\s\S]*?)\[\/STRATEGICKY_VYHLED\]/)?.[1]?.trim();
      if (strategicSection) {
        const centerFiles = await listFilesInFolder(token, centrumFolderId);
        let stratFile = centerFiles.find((f: any) => f.mimeType !== DRIVE_FOLDER_MIME && canonicalText(f.name).includes("strategick"));
        if (stratFile) {
          await updateFileById(token, stratFile.id, `STRATEGICKÝ VÝHLED – DID SYSTÉM\nAktualizace: ${dateStr} (týdenní cyklus)\nSprávce: Karel\n\n${strategicSection}`, stratFile.mimeType);
          cardsUpdated.push("06_Strategicky_Vyhled");
        } else {
          await createFileInFolder(token, "06_Strategicky_Vyhled", `STRATEGICKÝ VÝHLED – DID SYSTÉM\nAktualizace: ${dateStr}\nSprávce: Karel\n\n${strategicSection}`, centrumFolderId);
          cardsUpdated.push("06_Strategicky_Vyhled (vytvořen)");
        }

        // Sync to did_system_profile
        try {
          const extractGoals = (section: string, marker: string): string[] => {
            const match = section.match(new RegExp(`${marker}[\\s\\S]*?(?=SEKCE|$)`, 'i'));
            if (!match) return [];
            return match[0].split('\n').map(l => l.replace(/^[\s\-•▸►]+/, '').trim()).filter(l => l.length > 5 && !l.startsWith('SEKCE'));
          };
          const profileData: any = {
            goals_short_term: extractGoals(strategicSection, 'Krátkodob'),
            goals_mid_term: extractGoals(strategicSection, 'Středněd'),
            goals_long_term: extractGoals(strategicSection, 'Dlouhodob'),
            current_priorities: extractGoals(strategicSection, 'Priori'),
            risk_factors: extractGoals(strategicSection, 'Rizik'),
            karel_master_analysis: strategicSection.slice(0, 5000),
            last_drive_sync: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          };
          const cleanData = Object.fromEntries(Object.entries(profileData).filter(([, v]) => v !== undefined && (Array.isArray(v) ? v.length > 0 : true)));
          const { data: existing } = await sb.from("did_system_profile").select("id").eq("user_id", userId).maybeSingle();
          if (existing) await sb.from("did_system_profile").update(cleanData).eq("id", existing.id);
          else await sb.from("did_system_profile").insert({ user_id: userId, ...cleanData });
          console.log(`[weekly] ✅ did_system_profile synced`);
        } catch (e) { console.warn("[weekly] Profile sync error:", e); }

        // Append weekly report to strategic doc
        const reportContent = analysisText.match(/\[TYDENNI_REPORT\]([\s\S]*?)\[\/TYDENNI_REPORT\]/)?.[1]?.trim();
        if (reportContent && stratFile) {
          const existingContent = await readFileContent(token, stratFile.id);
          if (!existingContent.includes(reportContent.slice(0, 80))) {
            await updateFileById(token, stratFile.id, existingContent.trimEnd() + `\n\n═══ TÝDENNÍ REPORT ${dateStr} ═══\n${reportContent}`, stratFile.mimeType);
            cardsUpdated.push("06_Strategicky_Vyhled (report)");
          }
        }
      }

      // Write agreements to Drive
      if (agreementBlocks.length > 0) {
        try {
          let agreementsFolderId = dohodaFolderId;
          if (!agreementsFolderId) {
            const centerChildren = await listFilesInFolder(token, centrumFolderId);
            const existingFolder = centerChildren.find((f: any) => f.mimeType === DRIVE_FOLDER_MIME && canonicalText(f.name).includes("dohod"));
            if (existingFolder) agreementsFolderId = existingFolder.id;
            else {
              const folderRes = await fetch("https://www.googleapis.com/drive/v3/files?supportsAllDrives=true", {
                method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
                body: JSON.stringify({ name: "06_Terapeuticke_Dohody", parents: [centrumFolderId], mimeType: DRIVE_FOLDER_MIME }),
              });
              const folderData = await folderRes.json();
              agreementsFolderId = folderData.id;
            }
          }
          if (agreementsFolderId) {
            for (const ag of agreementBlocks) {
              const fileName = `Dohoda_${dateStr}_${ag.title.replace(/[^a-zA-ZáčďéěíňóřšťúůýžÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ0-9]/g, "_").slice(0, 40)}`;
              await createFileInFolder(token, fileName, `TERAPEUTICKÁ DOHODA\nVytvořena: ${dateStr}\nÚčastníci: ${ag.parties}\nTermín: ${ag.deadline}\n\n${ag.title}\n${"=".repeat(40)}\n\n${ag.content}`, agreementsFolderId);
              cardsUpdated.push(`Dohoda: ${ag.title}`);
            }
          }
        } catch (e) { console.warn("[weekly] Agreement write failed:", e); }
      }

      // CENTRUM updates (05, 04, 03, 00)
      const centrumBlockRegex = /\[CENTRUM:(.+?)\]([\s\S]*?)\[\/CENTRUM\]/g;
      const centerFiles = await listFilesInFolder(token, centrumFolderId);

      for (const match of analysisText.matchAll(centrumBlockRegex)) {
        const docName = match[1].trim();
        const newContent = match[2].trim();
        if (!newContent || newContent.length < 10) continue;
        try {
          const docCanonical = canonicalText(docName);
          if ((docCanonical.includes("operativn") && docCanonical.includes("plan")) || (docCanonical.includes("terapeutick") && docCanonical.includes("plan"))) {
            const planFile = centerFiles.find((f: any) => {
              const fc = canonicalText(f.name);
              return (fc.includes("operativn") && fc.includes("plan")) || (fc.includes("terapeutick") && fc.includes("plan"));
            });
            if (planFile) {
              await updateFileById(token, planFile.id, `OPERATIVNÍ PLÁN – DID SYSTÉM\nAktualizace: ${dateStr} (týdenní cyklus)\nSprávce: Karel\n\n${newContent}`, planFile.mimeType);
              cardsUpdated.push("05_Operativni_Plan");
            }
            continue;
          }
          if (docCanonical.includes("dashboard")) {
            const dashFile = centerFiles.find((f: any) => canonicalText(f.name).includes("dashboard"));
            if (dashFile) {
              await updateFileById(token, dashFile.id, `AKTUÁLNÍ DASHBOARD – DID SYSTÉM\nAktualizace: ${dateStr} (týdenní cyklus)\nSprávce: Karel\n\n${newContent}`, dashFile.mimeType);
              cardsUpdated.push("00_Dashboard");
            }
            continue;
          }
          const targetFile = centerFiles.find((f: any) => canonicalText(f.name).includes(docCanonical));
          if (targetFile) {
            const existing = await readFileContent(token, targetFile.id);
            if (!existing.includes(newContent.slice(0, 80))) {
              await updateFileById(token, targetFile.id, existing.trimEnd() + `\n\n═══ TÝDENNÍ AKTUALIZACE ${dateStr} ═══\n${newContent}`, targetFile.mimeType);
              cardsUpdated.push(`CENTRUM: ${docName}`);
            }
          }
        } catch (e) { console.error(`[weekly] CENTRUM update "${docName}" failed:`, e); }
      }
    }
  }

  // Save result
  await sb.from("did_update_cycles").update({
    phase: "distributed", phase_detail: `Distribuce dokončena: ${cardsUpdated.length} položek`,
    cards_updated: cardsUpdated, report_summary: (analysisText || "").slice(0, 2000),
    started_at: new Date().toISOString(),
  }).eq("id", cycleId);

  return { phase: "distributed", cardsUpdated };
}

async function phaseNotify(sb: any, cycleId: string) {
  await updatePhase(sb, cycleId, "notifying", "Odesílám e-maily a synchronizuji výzkum...");

  const { data: cycle } = await sb.from("did_update_cycles").select("context_data, cards_updated").eq("id", cycleId).single();
  const ctx = cycle.context_data;
  const { analysisText } = ctx;
  const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
  const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
  const MAMKA_EMAIL = "mujosobniasistentnamiru@gmail.com";
  const KATA_EMAIL = Deno.env.get("KATA_EMAIL") || "K.CC@seznam.cz";
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  // Research sync
  const researchPromise = (async () => {
    try {
      const resp = await withTimeout(fetch(`${supabaseUrl}/functions/v1/karel-research-weekly-sync`, {
        method: "POST", headers: { Authorization: `Bearer ${supabaseKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }), 90000, "Research sync");
      console.log(`[weekly] Research sync: ${resp.ok ? "ok" : resp.status}`);
    } catch (e) { console.warn("[weekly] Research sync failed:", e); }
  })();

  // Emails
  const emailPromise = (async () => {
    if (!RESEND_API_KEY || !analysisText || !LOVABLE_API_KEY) return;
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
              { role: "system", content: `Jsi Karel. Vytvoř STRUČNÝ TÝDENNÍ HTML email pro Haničku. Intimní, partnerský tón. Max 3000 znaků.\n<h2>Moje milá Haničko, tady je náš týdenní přehled</h2>\n- Celkový stav systému\n- Pro každou aktivní část: shrnutí, pokroky, rizika\n- Prioritní úkoly\nPodpis: "Jsem tady. Tvůj Karel"` },
              { role: "user", content: reportSection.slice(0, 6000) },
            ],
          }),
        }), 20000, "Hanka email"),
        withTimeout(fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
          method: "POST",
          headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "google/gemini-2.5-flash-lite",
            messages: [
              { role: "system", content: `Jsi Karel. Vytvoř STRUČNÝ TÝDENNÍ HTML email pro Káťu. Profesionální tón. Max 2000 znaků.\n<h2>Káťo, týdenní souhrn</h2>\n- Přehled týdne\n- Úkoly pro Káťu\n- Koordinace s Hankou\nPodpis: "Karel"` },
              { role: "user", content: reportSection.slice(0, 4000) },
            ],
          }),
        }), 20000, "Kata email"),
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

  await Promise.allSettled([researchPromise, emailPromise]);

  // Mark completed – clear context_data to save space
  await sb.from("did_update_cycles").update({
    status: "completed", phase: "completed", phase_detail: "Týdenní cyklus dokončen",
    completed_at: new Date().toISOString(), context_data: {},
  }).eq("id", cycleId);

  return { phase: "completed" };
}

// ═══ System prompt builder ═══
function buildSystemPrompt(instructionContext: string): string {
  return `Jsi Karel – hlavní stratég, supervizor a DEDUKTIVNÍ ANALYTIK DID systému. Provádíš TÝDENNÍ STRATEGICKOU ANALÝZU.

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
- Celková stabilita (1-10) + TREND (↑↗→↘↓) + PREDIKCE

B) DEDUKTIVNÍ ANALÝZA KAŽDÉ AKTIVNÍ ČÁSTI
Pro KAŽDOU aktivní část:
▸ Jméno: [stav + TREND + PROČ]
▸ Co se dělo + CO TO ZNAMENÁ (dedukce)
▸ Pokroky + PROČ to fungovalo
▸ Rizika: CO hrozí → PROČ → CO dělat → KDO → DOKDY
▸ Doporučené metody + odůvodnění
▸ Talenty: akční plán rozvoje
▸ Predikce: kam část směřuje

C) ANALÝZA SPÍCÍCH ČÁSTÍ + PREDIKCE PROBUZENÍ

D) PŘÍČINNÉ ŘETĚZCE A KŘÍŽOVÉ DEDUKCE
TRIGGER → PŘÍČINA → DŮSLEDEK → PREDIKCE → AKČNÍ PLÁN

E) STRATEGIE A SMĚŘOVÁNÍ – AKČNÍ INSTRUKCE

F) TALENTY – PERSONALIZOVANÝ EDUKAČNÍ PLÁN

G) ACCOUNTABILITY TERAPEUTŮ – ANALYTICKÉ HODNOCENÍ

═══ 2. STRATEGICKÝ VÝHLED ═══
Formát: [STRATEGICKY_VYHLED]...[/STRATEGICKY_VYHLED]

7 sekcí:
SEKCE 1 – VIZE A SMĚŘOVÁNÍ
SEKCE 2 – STŘEDNĚDOBÉ CÍLE (2-6 týdnů)
SEKCE 3 – DLOUHODOBÉ CÍLE
SEKCE 4 – STRATEGIE PRÁCE S ČÁSTMI
SEKCE 5 – ODLOŽENÁ TÉMATA
SEKCE 6 – ARCHIV SPLNĚNÝCH CÍLŮ
SEKCE 7 – KARLOVA STRATEGICKÁ REFLEXE

═══ 2b. ÚKOLY PRO TERAPEUTKY ═══
Formát: [UKOLY]...[/UKOLY]
[UKOL] assignee=hanka|kata|both | task=Popis | source=Kontext | priority=normal|high [/UKOL]

═══ 2c. TERAPEUTICKÉ DOHODY ═══
Formát: [DOHODY]...[/DOHODY]
[DOHODA] title=Název | parties=hanka|kata|both | deadline=YYYY-MM-DD | priority=normal|high
Obsah dohody.
[/DOHODA]

═══ 3. CENTRUM UPDATES ═══

[CENTRUM:05_Operativni_Plan] – KOMPLETNÍ PŘEPIS – 6 sekcí [/CENTRUM]
[CENTRUM:04_Mapa_Vztahu] – nové poznatky [/CENTRUM]
[CENTRUM:03_Geografie_Vnitrniho_Sveta] – nové prostorové info [/CENTRUM]
[CENTRUM:00_Aktualni_Dashboard] – PŘEPIS – 7 sekcí: stav, upozornění, souhrn týdne, watchlist, fokus, most, dedukce [/CENTRUM]

═══ PRAVIDLA ═══
- NIKDY nesmaž – doplňuj s datem
- Buď KONKRÉTNÍ – jména, data, čísla
- Každý záznam = DEDUKCE ne popis
- PŘÍČINNÉ ŘETĚZCE: Trigger → Příčina → Důsledek → Predikce → Akce
- KŘÍŽOVÉ DEDUKCE: propoj informace z RŮZNÝCH vláken/režimů

${instructionContext ? `\n═══ INSTRUKCE PRO KARLA ═══\n${instructionContext}` : ""}`;
}

function buildUserPrompt(ctx: any): string {
  return `AKTUÁLNÍ DATUM: ${ctx.dateStr}

═══ VŠECHNY KARTY ČÁSTÍ ═══
${ctx.allCardsContent || "Žádné karty nenalezeny"}

═══ CENTRUM DOKUMENTY ═══
${ctx.centrumDocsContent || "Žádné"}

═══ EXISTUJÍCÍ STRATEGICKÝ VÝHLED (06) ═══
${ctx.agreementsContent || "Žádný"}

═══ MAPA VZTAHŮ ═══
${ctx.systemMap || "Nedostupná"}

═══ AKTIVITA ZA TÝDEN ═══
${ctx.activitySummary || "Žádná aktivita"}

═══ KONVERZACE ZA TÝDEN ═══
${ctx.weekConversations || "Žádné konverzace"}

═══ DENNÍ REPORTY ═══
${ctx.dailyReportsSummary || "Žádné"}

═══ PROFESNÍ ZDROJE (Research) ═══
${ctx.researchSummary || "Žádné"}

${ctx.perplexityContext || ""}`;
}

// ═══════════════════════════════════════════
// MAIN HANDLER – Phase Router
// ═══════════════════════════════════════════

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const authHeader = req.headers.get("Authorization") || "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || "";

  let requestBody: Record<string, unknown> = {};
  try { requestBody = await req.json(); } catch { requestBody = {}; }

  const source = typeof requestBody.source === "string" ? requestBody.source.trim().toLowerCase() : "manual";
  const forceRun = requestBody.force === true;
  const phase = typeof requestBody.phase === "string" ? requestBody.phase : "";
  const cycleId = typeof requestBody.cycleId === "string" ? requestBody.cycleId : "";
  const isCronCall = source === "cron";
  const bearerToken = authHeader.startsWith("Bearer ") ? authHeader.replace("Bearer ", "") : "";
  const cronAllowedTokens = [serviceRoleKey, anonKey].filter(Boolean);
  let requesterUserId: string | null = null;

  if (isCronCall) {
    if (!bearerToken || !cronAllowedTokens.includes(bearerToken)) {
      return new Response(JSON.stringify({ error: "Unauthorized cron trigger" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    const pragueWeekday = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "Europe/Prague" }).format(new Date());
    if (pragueWeekday !== "Sun") {
      return new Response(JSON.stringify({ success: true, skipped: true, reason: "not_sunday", source }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
  } else {
    const authResult = await requireAuth(req);
    if (authResult instanceof Response) return authResult;
    requesterUserId = authResult.user?.id ?? null;
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const sb = createClient(supabaseUrl, supabaseKey);

    // Resolve userId
    let userId = requesterUserId;
    if (!userId) {
      const { data: anyUser } = await sb.from("did_threads").select("user_id").order("last_activity_at", { ascending: false }).limit(1).maybeSingle();
      userId = anyUser?.user_id ?? null;
    }
    if (!userId) throw new Error("No user found");

    // Route by phase
    let result: any;

    if (!phase || phase === "kickoff") {
      result = await phaseKickoff(sb, userId, forceRun, isCronCall);
      if (result.skipped) {
        return new Response(JSON.stringify({ success: true, ...result }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // For cron calls, run all phases sequentially in one call
      if (isCronCall && result.cycleId) {
        const cid = result.cycleId;
        await phaseGather(sb, cid, userId);
        await phaseAnalyze(sb, cid);
        await phaseDistribute(sb, cid);
        await phaseNotify(sb, cid);
        return new Response(JSON.stringify({ success: true, cycleId: cid, phase: "completed" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
    } else if (phase === "gather" && cycleId) {
      result = await phaseGather(sb, cycleId, userId);
    } else if (phase === "analyze" && cycleId) {
      result = await phaseAnalyze(sb, cycleId);
    } else if (phase === "distribute" && cycleId) {
      result = await phaseDistribute(sb, cycleId);
    } else if (phase === "notify" && cycleId) {
      result = await phaseNotify(sb, cycleId);
    } else {
      return new Response(JSON.stringify({ error: `Unknown phase: ${phase}` }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    return new Response(JSON.stringify({ success: true, ...result }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (error) {
    console.error("[weekly] Error:", error);

    // Mark cycle as failed
    if (cycleId || phase === "kickoff") {
      try {
        const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
        const failId = cycleId || "";
        if (failId) {
          await sb.from("did_update_cycles").update({
            status: "failed", completed_at: new Date().toISOString(),
            phase: "failed", phase_detail: `Selhalo ve fázi: ${phase || "kickoff"}`,
            report_summary: `Chyba: ${error instanceof Error ? error.message : "Unknown"}`.slice(0, 2000),
            context_data: {},
          }).eq("id", failId);
        }
      } catch {}
    }

    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
