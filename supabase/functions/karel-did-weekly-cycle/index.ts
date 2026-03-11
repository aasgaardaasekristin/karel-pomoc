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
  const publishableKey = Deno.env.get("SUPABASE_PUBLISHABLE_KEY") || "";
  let cycleId: string | null = null;

  // Allow cron/service calls with known keys, or calls with no auth (verify_jwt=false in config)
  const knownKeys = [serviceRoleKey, anonKey, publishableKey].filter(Boolean);
  const bearerToken = authHeader.replace("Bearer ", "");
  const isCronCall = !authHeader || knownKeys.includes(bearerToken);

  if (!isCronCall) {
    const authResult = await requireAuth(req);
    if (authResult instanceof Response) return authResult;
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

    // Get a valid user_id for DB inserts (service role calls don't have auth.uid())
    const { data: anyUser } = await sb.from("did_threads").select("user_id").limit(1).single();
    const userId = anyUser?.user_id;
    if (!userId) throw new Error("No user found in did_threads for cycle attribution");

    // Create weekly cycle record
    const { data: cycle } = await sb.from("did_update_cycles").insert({ cycle_type: "weekly", status: "running", user_id: userId }).select().single();
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
    folderId = await findFolder(token, "Kartoteka_DID") || await findFolder(token, "Kartotéka_DID") || await findFolder(token, "KARTOTEKA_DID");

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
            content: `Jsi Karel – hlavní stratég, supervizor a analytik DID systému. Provádíš TÝDENNÍ STRATEGICKOU ANALÝZU.

═══ TVŮJ ÚKOL ═══

Vytvoříš 3 výstupy:
1. [TYDENNI_REPORT] – Komplexní týdenní report
2. [DOHODY] – Aktualizace terapeutických dohod (06_Terapeuticke_Dohody)
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

G) KOORDINACE TERAPEUTŮ
▸ Co probrat na společném hovoru Hanka+Káťa
▸ Kde se terapeutické přístupy shodují/liší
▸ Návrhy na synchronizaci

═══ 2. TERAPEUTICKÉ DOHODY ═══
Formát: [DOHODY]...[/DOHODY]

Zanalyzuj VŠECHNY existující dohody:
- Které byly splněny? (změň status na "✅ Splněno")
- Které se plní? (aktualizuj % plnění)
- Které nefungují? (navrhni revizi nebo uzavření)
- Navrhni NOVÉ dohody na základě týdenní analýzy

Pro KAŽDOU novou/aktualizovanou dohodu:
[DOHODA: téma]
Status: Aktivní/Splněno/Revidováno
Kontext: proč vznikla
Cíl: konkrétní, měřitelný
Úkoly Hanka: ...
Úkoly Káťa: ...
Neřeší se: ...
Kritéria splnění: ...
Karlovy poznámky: ...
Plnění: X%
[/DOHODA]

═══ 2b. ÚKOLY PRO TERAPEUTKY ═══
Formát: [UKOLY]...[/UKOLY]

Pro každý úkol vytvoř řádek ve formátu:
[UKOL] assignee=hanka|kata|both | task=Popis úkolu | source=Název dohody nebo kontext | priority=normal|high [/UKOL]

Vytvoř konkrétní, splnitelné úkoly pro Hanku a Káťu na základě analýzy a dohod.


Formát:

[CENTRUM:05_Terapeuticky_Plan_Aktualni]
Kompletní přepis plánu – 8 sekcí (viz instrukce). Sekce 2 = aktivní dohody z 06.
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
    });

    let analysisText = "";
    if (analysisResponse.ok) {
      const data = await analysisResponse.json();
      analysisText = data.choices?.[0]?.message?.content || "";
      console.log(`[weekly] AI analysis: ${analysisText.length} chars`);
    } else {
      console.error(`[weekly] AI error ${analysisResponse.status}: ${(await analysisResponse.text()).slice(0, 500)}`);
    }

    // ═══ 5. PROCESS OUTPUTS – Update Drive ═══
    const cardsUpdated: string[] = [];

    if (folderId && analysisText) {
      // 5a. Save weekly report
      if (centrumFolderId) {
        const reportContent = analysisText.match(/\[TYDENNI_REPORT\]([\s\S]*?)\[\/TYDENNI_REPORT\]/)?.[1]?.trim();
        if (reportContent) {
          const reportFileName = `Tydenni_Report_${dateStr}`;
          await createFileInFolder(token, reportFileName, `TÝDENNÍ STRATEGICKÁ ANALÝZA\nDatum: ${dateStr}\nSprávce: Karel\n\n${reportContent}`, centrumFolderId);
          cardsUpdated.push("Tydenni_Report");
          console.log(`[weekly] ✅ Weekly report saved`);
        }
      }

      // 5b. Process therapeutic agreements (06_Terapeuticke_Dohody)
      const dohodaSection = analysisText.match(/\[DOHODY\]([\s\S]*?)\[\/DOHODY\]/)?.[1]?.trim();
      if (dohodaSection && centrumFolderId) {
        // Ensure 06_Terapeuticke_Dohody folder exists
        if (!dohodaFolderId) {
          const centerFiles = await listFilesInFolder(token, centrumFolderId);
          const existing = centerFiles.find(f => f.mimeType === DRIVE_FOLDER_MIME && canonicalText(f.name).includes("dohod"));
          if (existing) {
            dohodaFolderId = existing.id;
          } else {
            // Create the folder
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

        if (dohodaFolderId) {
          // Parse individual agreements
          const dohodaBlockRegex = /\[DOHODA:\s*(.+?)\]([\s\S]*?)\[\/DOHODA\]/g;
          const dohodaFiles = await listFilesInFolder(token, dohodaFolderId);

          for (const match of dohodaSection.matchAll(dohodaBlockRegex)) {
            const topic = match[1].trim();
            const content = match[2].trim();
            const safeFileName = `${dateStr}_${topic.replace(/[^a-zA-Zá-žÁ-Ž0-9\s]/g, "").replace(/\s+/g, "_").slice(0, 50)}`;

            // Check if agreement with similar topic exists
            const existingFile = dohodaFiles.find(f => {
              const fCanonical = canonicalText(f.name);
              const topicCanonical = canonicalText(topic);
              return fCanonical.includes(topicCanonical) || topicCanonical.includes(fCanonical.slice(-20));
            });

            if (existingFile) {
              // Update existing
              const existingContent = await readFileContent(token, existingFile.id);
              const updatedContent = existingContent.trimEnd() + `\n\n═══ TÝDENNÍ REVIZE ${dateStr} ═══\n${content}`;
              await updateFileById(token, existingFile.id, updatedContent, existingFile.mimeType);
              cardsUpdated.push(`Dohoda: ${topic} (aktualizace)`);
            } else {
              // Create new
              const fullContent = `TERAPEUTICKÁ DOHODA: ${topic}\nVytvořeno: ${dateStr}\nSprávce: Karel\n\n${content}`;
              await createFileInFolder(token, safeFileName, fullContent, dohodaFolderId);
              cardsUpdated.push(`Dohoda: ${topic} (nová)`);
            }
          }

          // Update/create 00_Prehled_Dohod index
          const indexContent = `PŘEHLED TERAPEUTICKÝCH DOHOD\nAktualizace: ${dateStr}\n\n${dohodaSection}`;
          const indexFile = dohodaFiles.find(f => canonicalText(f.name).includes("prehled"));
          if (indexFile) {
            await updateFileById(token, indexFile.id, indexContent, indexFile.mimeType);
          } else {
            await createFileInFolder(token, "00_Prehled_Dohod", indexContent, dohodaFolderId);
          }
          cardsUpdated.push("00_Prehled_Dohod");
          console.log(`[weekly] ✅ Agreements processed`);
        }
      }

      // 5b2. Extract and insert therapist tasks into DB
      const ukolySection = analysisText.match(/\[UKOLY\]([\s\S]*?)\[\/UKOLY\]/)?.[1]?.trim();
      if (ukolySection) {
        const ukolRegex = /\[UKOL\]\s*assignee=(\S+)\s*\|\s*task=([^|]+)\|\s*source=([^|]+)\|\s*priority=(\S+)\s*\[\/UKOL\]/g;
        let insertedTasks = 0;
        for (const m of ukolySection.matchAll(ukolRegex)) {
          const assignee = m[1].trim();
          const task = m[2].trim();
          const source = m[3].trim();
          const priority = m[4].trim();
          if (task) {
            await sb.from("did_therapist_tasks").insert({
              task,
              assigned_to: assignee,
              source_agreement: source,
              priority,
              note: `Vytvořeno týdenním cyklem ${dateStr}`,
              user_id: userId,
            });
            insertedTasks++;
          }
        }
        if (insertedTasks > 0) {
          cardsUpdated.push(`${insertedTasks} úkolů pro terapeutky`);
          console.log(`[weekly] ✅ Inserted ${insertedTasks} therapist tasks`);
        }
      }

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

    // ═══ 6. SEND WEEKLY EMAILS ═══
    if (RESEND_API_KEY && analysisText) {
      try {
        const resend = new Resend(RESEND_API_KEY);
        const reportSection = analysisText.match(/\[TYDENNI_REPORT\]([\s\S]*?)\[\/TYDENNI_REPORT\]/)?.[1]?.trim() || analysisText;

        // Generate Hanka's email
        let hankaHtml = "";
        try {
          const hRes = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
            method: "POST",
            headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              model: "google/gemini-2.5-flash-lite",
              messages: [
                { role: "system", content: `Jsi Karel. Vytvoř TÝDENNÍ HTML email pro Haničku. Intimní, partnerský tón.
Struktura:
<h2>Moje milá Haničko, tady je náš týdenní přehled</h2>
- Celkový stav systému (stabilita, pokroky)
- Pro každou aktivní část: shrnutí týdne, pokroky, rizika, plán na další týden
- Spící části: doporučení
- Kritická upozornění
- Nové metody a přístupy (z výzkumu)
- Talenty a potenciál částí
- Terapeutický plán – klíčové body
- Terapeutické dohody – stav plnění
- Koordinace s Káťou
Podpis: "Jsem tady. Tvůj Karel"
Používej barvy: zelená=pokrok, oranžová=pozor, červená=riziko.` },
                { role: "user", content: reportSection },
              ],
            }),
          });
          if (hRes.ok) {
            const d = await hRes.json();
            hankaHtml = (d.choices?.[0]?.message?.content || "").replace(/^```html?\n?/i, "").replace(/\n?```$/i, "");
          }
        } catch {}
        if (!hankaHtml) hankaHtml = `<pre style="font-family:sans-serif;white-space:pre-wrap;">${reportSection}</pre>`;

        // Generate Káťa's email
        let kataHtml = "";
        try {
          const kRes = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
            method: "POST",
            headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              model: "google/gemini-2.5-flash-lite",
              messages: [
                { role: "system", content: `Jsi Karel. Vytvoř TÝDENNÍ HTML email pro Káťu. Profesionální tón, tykání.
Struktura:
<h2>Káťo, týdenní souhrn</h2>
- Přehled týdne (části relevantní pro Káťu)
- Pokroky a rizika
- Úkoly pro Káťu z terapeutických dohod
- Nové metody k vyzkoušení
- Koordinace s Hankou
Podpis: "Karel"
Nepoužívej intimní tón. Pouze profesionální respekt.` },
                { role: "user", content: reportSection },
              ],
            }),
          });
          if (kRes.ok) {
            const d = await kRes.json();
            kataHtml = (d.choices?.[0]?.message?.content || "").replace(/^```html?\n?/i, "").replace(/\n?```$/i, "");
          }
        } catch {}
        if (!kataHtml) kataHtml = `<pre style="font-family:sans-serif;white-space:pre-wrap;">${reportSection}</pre>`;

        const dateCz = new Date().toLocaleDateString("cs-CZ");
        await resend.emails.send({ from: "Karel <karel@hana-chlebcova.cz>", to: [MAMKA_EMAIL], subject: `Karel – TÝDENNÍ report ${dateCz}`, html: hankaHtml });
        await resend.emails.send({ from: "Karel <karel@hana-chlebcova.cz>", to: [KATA_EMAIL], subject: `Karel – Týdenní report ${dateCz}`, html: kataHtml });
        console.log(`[weekly] ✅ Emails sent`);
      } catch (e) { console.error("[weekly] Email error:", e); }
    }

    // ═══ 7. TRIGGER RESEARCH WEEKLY SYNC ═══
    let researchSyncResult = null;
    try {
      const researchRes = await fetch(`${supabaseUrl}/functions/v1/karel-research-weekly-sync`, {
        method: "POST",
        headers: { Authorization: `Bearer ${supabaseKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (researchRes.ok) {
        researchSyncResult = await researchRes.json();
        console.log("[weekly] Research sync completed");
      }
    } catch (e) { console.error("[weekly] Research sync error:", e); }

    // ═══ 8. UPDATE CYCLE RECORD ═══
    if (cycle) {
      await sb.from("did_update_cycles").update({
        status: "completed",
        completed_at: new Date().toISOString(),
        report_summary: analysisText.slice(0, 2000),
        cards_updated: cardsUpdated,
      }).eq("id", cycle.id);
    }

    return new Response(JSON.stringify({
      success: true,
      cardsAnalyzed: cardNames.length,
      cardsUpdated,
      reportSent: !!RESEND_API_KEY,
      researchSync: researchSyncResult,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (error) {
    console.error("[weekly] Error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
