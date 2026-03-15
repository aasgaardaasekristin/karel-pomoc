import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { corsHeaders } from "../_shared/auth.ts";

/**
 * Karel DID Context Prime – Dynamická situační cache pro DID režim
 * 
 * Buduje plastickou kontextovou cache skenováním:
 * 1. Google Drive (KARTOTEKA_DID: 00_CENTRUM + karta části, PAMET_KAREL/DID/)
 * 2. DB tabulky (did_threads, did_conversations, karel_hana_conversations, karel_episodes, semantika, strategie, úkoly)
 * 3. Internet (Perplexity – DID-specifické novinky)
 * 
 * Výstup: { contextBrief, partCard?, systemState }
 * Spouštěno: automaticky při otevření DID vlákna + manuálně z dashboardu.
 */

// ── OAuth2 ──
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

// ── Drive helpers ──
async function findFolder(token: string, name: string, parentId?: string): Promise<string | null> {
  let q = `name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  if (parentId) q += ` and '${parentId}' in parents`;
  const params = new URLSearchParams({ q, fields: "files(id)", pageSize: "5", supportsAllDrives: "true", includeItemsFromAllDrives: "true" });
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  return data.files?.[0]?.id || null;
}

async function findFolderFuzzy(token: string, names: string[]): Promise<string | null> {
  for (const name of names) {
    const id = await findFolder(token, name);
    if (id) return id;
  }
  return null;
}

async function listDocsInFolder(token: string, folderId: string, limit = 20): Promise<Array<{ id: string; name: string }>> {
  const q = `'${folderId}' in parents and trashed=false and mimeType!='application/vnd.google-apps.folder'`;
  const params = new URLSearchParams({ q, fields: "files(id,name)", pageSize: String(limit), supportsAllDrives: "true", includeItemsFromAllDrives: "true" });
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  return data.files || [];
}

async function readDoc(token: string, fileId: string, maxChars = 4000): Promise<string> {
  let res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/plain`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, { headers: { Authorization: `Bearer ${token}` } });
  }
  if (!res.ok) return "[nečitelné]";
  const text = await res.text();
  return text.slice(0, maxChars);
}

async function readFolderDocs(token: string, folderId: string, maxDocs = 10, maxChars = 3000): Promise<Record<string, string>> {
  const docs = await listDocsInFolder(token, folderId, maxDocs);
  const result: Record<string, string> = {};
  await Promise.all(docs.map(async (doc) => {
    try { result[doc.name] = await readDoc(token, doc.id, maxChars); } catch { result[doc.name] = "[chyba]"; }
  }));
  return result;
}

async function findPartCard(token: string, kartotekaId: string, partName: string): Promise<string | null> {
  // Search in 01_AKTIVNI_FRAGMENTY and 03_ARCHIV_SPICICH
  const folderNames = ["01_AKTIVNI_FRAGMENTY", "03_ARCHIV_SPICICH"];
  const canonical = partName.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

  for (const folderName of folderNames) {
    const folderId = await findFolder(token, folderName, kartotekaId);
    if (!folderId) continue;

    // Search subfolders (clusters/lines)
    const subFolders = await listSubfolders(token, folderId);
    const allFolders = [folderId, ...subFolders.map(f => f.id)];

    for (const fId of allFolders) {
      const docs = await listDocsInFolder(token, fId, 50);
      const match = docs.find(d => {
        const docCanonical = d.name.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
        return docCanonical.includes(canonical) || canonical.includes(docCanonical.replace(/^did_\d+_/, "").replace(/\.\w+$/, ""));
      });
      if (match) {
        return await readDoc(token, match.id, 6000);
      }
    }
  }
  return null;
}

async function listSubfolders(token: string, parentId: string): Promise<Array<{ id: string; name: string }>> {
  const q = `'${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const params = new URLSearchParams({ q, fields: "files(id,name)", pageSize: "30", supportsAllDrives: "true", includeItemsFromAllDrives: "true" });
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  return data.files || [];
}

async function createFolder(token: string, name: string, parentId: string): Promise<string> {
  const res = await fetch("https://www.googleapis.com/drive/v3/files?supportsAllDrives=true", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name,
      mimeType: "application/vnd.google-apps.folder",
      parents: [parentId],
    }),
  });
  const data = await res.json();
  if (!data?.id) throw new Error(`Failed to create folder ${name}: ${JSON.stringify(data)}`);
  return data.id;
}

async function findOrCreateFolder(token: string, name: string, parentId: string): Promise<string> {
  const existing = await findFolder(token, name, parentId);
  if (existing) return existing;
  return await createFolder(token, name, parentId);
}

function escapeDriveQueryValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

async function findDocByExactName(token: string, parentId: string, fileName: string): Promise<{ id: string; name: string } | null> {
  const escapedName = escapeDriveQueryValue(fileName);
  const q = `name='${escapedName}' and '${parentId}' in parents and trashed=false and mimeType!='application/vnd.google-apps.folder'`;
  const params = new URLSearchParams({
    q,
    fields: "files(id,name)",
    pageSize: "5",
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
  });

  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  return data.files?.[0] || null;
}

async function upsertTextDoc(token: string, parentId: string, fileName: string, content: string): Promise<void> {
  const existing = await findDocByExactName(token, parentId, fileName);
  const boundary = "----DidPrimeBoundary";
  const metadata = existing
    ? { name: fileName }
    : { name: fileName, parents: [parentId], mimeType: "text/plain" };

  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${content}\r\n` +
    `--${boundary}--`;

  const url = existing
    ? `https://www.googleapis.com/upload/drive/v3/files/${existing.id}?uploadType=multipart&supportsAllDrives=true`
    : "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true";

  const res = await fetch(url, {
    method: existing ? "PATCH" : "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": `multipart/related; boundary=${boundary}`,
    },
    body,
  });

  if (!res.ok) {
    throw new Error(`Failed to upsert ${fileName}: ${await res.text()}`);
  }
}

function extractUserTexts(messages: unknown): string[] {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter((m: any) => m?.role === "user")
    .map((m: any) => {
      if (typeof m?.content === "string") return m.content;
      if (Array.isArray(m?.content)) {
        return m.content
          .map((p: any) => (typeof p?.text === "string" ? p.text : ""))
          .filter(Boolean)
          .join(" ");
      }
      return "";
    })
    .map((text: string) => text.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function pickCentrumDoc(centrumDocs: Record<string, string>, regex: RegExp): string {
  const found = Object.entries(centrumDocs).find(([name]) => regex.test(name));
  return found?.[1] || "";
}

function formatTherapistShadowLog(now: Date, didThreads: any[], didConversations: any[], hanaConversations: any[]): string {
  const cutoff = now.getTime() - 24 * 60 * 60 * 1000;
  const lines: string[] = [
    `24h zápis vláken (vygenerováno ${now.toISOString()})`,
    "",
    "DID vlákna (uživatelské zprávy):",
  ];

  const mapSubModeLabel = (subMode: string, partName?: string) => {
    if (subMode === "mamka") return "Hanička";
    if (subMode === "kata") return "Káťa";
    if (subMode === "cast") return partName || "část";
    return subMode || "neurčeno";
  };

  for (const t of didThreads || []) {
    const ts = t?.last_activity_at ? new Date(t.last_activity_at).getTime() : 0;
    if (!ts || ts < cutoff) continue;
    const speaker = mapSubModeLabel(t.sub_mode, t.part_name);
    const userTexts = extractUserTexts(t.messages).slice(-6);
    if (userTexts.length === 0) continue;
    lines.push(`- [${t.last_activity_at}] ${speaker}`);
    for (const text of userTexts) lines.push(`  • ${text.slice(0, 320)}`);
  }

  lines.push("", "Uložené DID konverzace (uživatelské zprávy):");
  for (const c of didConversations || []) {
    const tsRaw = c?.updated_at || c?.saved_at;
    const ts = tsRaw ? new Date(tsRaw).getTime() : 0;
    if (!ts || ts < cutoff) continue;
    const speaker = mapSubModeLabel(c.sub_mode, c.label);
    const userTexts = extractUserTexts(c.messages).slice(-4);
    if (userTexts.length === 0) continue;
    lines.push(`- [${tsRaw}] ${speaker}`);
    for (const text of userTexts) lines.push(`  • ${text.slice(0, 320)}`);
  }

  lines.push("", "Hana DID konverzace (uživatelské zprávy):");
  for (const h of hanaConversations || []) {
    const ts = h?.last_activity_at ? new Date(h.last_activity_at).getTime() : 0;
    if (!ts || ts < cutoff) continue;
    const userTexts = extractUserTexts(h.messages).slice(-4);
    if (userTexts.length === 0) continue;
    lines.push(`- [${h.last_activity_at}] Hanička`);
    for (const text of userTexts) lines.push(`  • ${text.slice(0, 320)}`);
  }

  if (lines.length <= 6) {
    lines.push("- Za posledních 24 hodin nebyly zachyceny nové uživatelské zprávy.");
  }

  return lines.join("\n");
}

async function syncDidTherapistShadowMemory(params: {
  token: string;
  now: Date;
  systemState: string;
  driveData: Record<string, Record<string, string>>;
  didThreads: any[];
  didConversations: any[];
  hanaConversations: any[];
}): Promise<{ updated: boolean; filesUpdated: number }> {
  const { token, now, systemState, driveData, didThreads, didConversations, hanaConversations } = params;

  const pametId = await findFolder(token, "PAMET_KAREL");
  if (!pametId) {
    throw new Error("PAMET_KAREL folder not found");
  }

  const didRootId = await findOrCreateFolder(token, "DID", pametId);
  const hankaRoot = await findOrCreateFolder(token, "HANKA", didRootId);
  const kataRoot = await findOrCreateFolder(token, "KATA", didRootId);

  const centrum = driveData["CENTRUM"] || {};
  const dashboardText = pickCentrumDoc(centrum, /dashboard|aktualni/i);
  const operativniText = pickCentrumDoc(centrum, /operativni|plan/i);
  const strategickyText = pickCentrumDoc(centrum, /strateg/i);
  const instructionsText = pickCentrumDoc(centrum, /instrukce/i);
  const threadsLog = formatTherapistShadowLog(now, didThreads, didConversations, hanaConversations);

  const syncForTherapist = async (therapistFolderId: string, therapistLabel: string) => {
    const centrumCopyFolder = await findOrCreateFolder(token, "00_CENTRUM_KOPIE", therapistFolderId);
    const logsFolder = await findOrCreateFolder(token, "01_VLAKNA_24H", therapistFolderId);

    await upsertTextDoc(token, centrumCopyFolder, "00_Aktualni_Dashboard.txt", dashboardText || "Dashboard zatím nebyl načten.");
    await upsertTextDoc(token, centrumCopyFolder, "05_Operativni_Plan.txt", operativniText || "Operativní plán zatím nebyl načten.");
    await upsertTextDoc(token, centrumCopyFolder, "06_Strategicky_Vyhled.txt", strategickyText || "Strategický výhled zatím nebyl načten.");
    await upsertTextDoc(token, centrumCopyFolder, "02_Instrukce_Pro_Aplikaci_Karel_2.txt", instructionsText || "Instrukce zatím nebyly načteny.");

    const header = [
      `DID stínová paměť pro ${therapistLabel}`,
      `Aktualizováno: ${now.toISOString()}`,
      `Stav systému: ${systemState}`,
      "",
    ].join("\n");

    await upsertTextDoc(token, logsFolder, "24h_vlakna.txt", `${header}${threadsLog}`);
    await upsertTextDoc(token, therapistFolderId, "README.txt", `${header}Tato složka je automaticky aktualizovaná při ručním „Osvěž paměť“ v DID režimu.`);
  };

  await Promise.all([
    syncForTherapist(hankaRoot, "Haničku"),
    syncForTherapist(kataRoot, "Káťu"),
  ]);

  return { updated: true, filesUpdated: 12 };
}

// ── Auth ──
function isCronOrService(req: Request): boolean {
  const authHeader = req.headers.get("Authorization") || "";
  const ua = req.headers.get("User-Agent") || "";
  if (authHeader.includes(Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "__never__")) return true;
  if (ua.startsWith("pg_net/") || ua.startsWith("Supabase Edge Functions")) return true;
  return false;
}

// ── Main ──
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
  if (!LOVABLE_API_KEY) return new Response(JSON.stringify({ error: "Missing LOVABLE_API_KEY" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  let userId: string;
  let requestBody: any = {};

  if (isCronOrService(req)) {
    try { requestBody = await req.json(); } catch {}
    if (requestBody.userId) { userId = requestBody.userId; }
    else {
      const { data } = await sb.from("karel_episodes").select("user_id").limit(1);
      userId = data?.[0]?.user_id;
      if (!userId) return new Response(JSON.stringify({ status: "no_users" }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
  } else {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    const userClient = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: authHeader } } });
    const { data: { user }, error } = await userClient.auth.getUser();
    if (error || !user) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    userId = user.id;
    try { requestBody = await req.json(); } catch {}
  }

  try {
    const { partName, subMode, forceRefresh } = requestBody;
    console.log(`[did-context-prime] Starting for user: ${userId}, part: ${partName || "none"}, subMode: ${subMode || "none"}`);
    const startTime = Date.now();
    const now = new Date();
    const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();

    // ═══ PHASE 1: Parallel data harvest ═══
    const dbPromises = {
      didThreads: sb.from("did_threads").select("id, part_name, messages, last_activity_at, sub_mode").eq("user_id", userId).order("last_activity_at", { ascending: false }).limit(20),
      didConversations: sb.from("did_conversations").select("id, label, preview, sub_mode, saved_at, updated_at, did_initial_context, messages").eq("user_id", userId).order("saved_at", { ascending: false }).limit(20),
      hanaConversations: sb.from("karel_hana_conversations").select("id, messages, last_activity_at, current_domain").eq("user_id", userId).eq("current_domain", "DID").order("last_activity_at", { ascending: false }).limit(10),
      didEpisodes: sb.from("karel_episodes").select("*").eq("user_id", userId).eq("is_archived", false).eq("domain", "DID").gte("timestamp_start", fourteenDaysAgo).order("timestamp_start", { ascending: false }).limit(30),
      olderEpisodes: sb.from("karel_episodes").select("domain, hana_state, summary_user, summary_karel, tags, timestamp_start").eq("user_id", userId).eq("is_archived", false).eq("domain", "DID").lt("timestamp_start", fourteenDaysAgo).gte("timestamp_start", thirtyDaysAgo).order("timestamp_start", { ascending: false }).limit(15),
      entities: sb.from("karel_semantic_entities").select("*").eq("user_id", userId),
      patterns: sb.from("karel_semantic_patterns").select("*").eq("user_id", userId).eq("domain", "DID").order("confidence", { ascending: false }).limit(15),
      relations: sb.from("karel_semantic_relations").select("*").eq("user_id", userId),
      strategies: sb.from("karel_strategies").select("*").eq("user_id", userId).eq("domain", "DID").order("effectiveness_score", { ascending: false }).limit(10),
      therapistTasks: sb.from("did_therapist_tasks").select("task, status, priority, assigned_to, due_date, category, escalation_level, status_hanka, status_kata").eq("user_id", userId).neq("status", "done").order("created_at", { ascending: false }).limit(20),
      motivationProfiles: sb.from("did_motivation_profiles").select("*").eq("user_id", userId),
      kartotekaHealth: sb.from("did_kartoteka_health").select("part_name, health_score, missing_sections, stale_sections, last_checked").eq("user_id", userId).order("last_checked", { ascending: false }).limit(30),
    };

    // Drive reads (parallel with DB)
    let driveData: Record<string, Record<string, string>> = {};
    let partCardContent: string | null = null;
    let driveError: string | null = null;

    const drivePromise = (async () => {
      try {
        const token = await getAccessToken();
        const kartotekaId = await findFolderFuzzy(token, ["kartoteka_DID", "Kartoteka_DID", "Kartotéka_DID", "KARTOTEKA_DID"]);

        if (!kartotekaId) {
          driveError = "Kartoteka_DID not found";
          return;
        }

        const reads: Promise<void>[] = [];

        // 00_CENTRUM
        const centrumId = await findFolder(token, "00_CENTRUM", kartotekaId);
        if (centrumId) {
          reads.push(readFolderDocs(token, centrumId, 8, 3000).then(d => { driveData["CENTRUM"] = d; }));
        }

        // PAMET_KAREL/DID/ if exists
        const pametId = await findFolder(token, "PAMET_KAREL");
        if (pametId) {
          const didPametId = await findFolder(token, "DID", pametId);
          if (didPametId) {
            reads.push(readFolderDocs(token, didPametId, 5, 4000).then(d => { driveData["PAMET_DID"] = d; }));
          }
          // Also read semantic memory
          const semanticId = await findFolder(token, "PAMET_KAREL_SEMANTIC", pametId);
          if (semanticId) {
            reads.push(readFolderDocs(token, semanticId, 3, 2000).then(d => { driveData["PAMET_SEMANTIC"] = d; }));
          }
        }

        // Part-specific card if partName provided
        if (partName) {
          reads.push(findPartCard(token, kartotekaId, partName).then(card => { partCardContent = card; }));
        }

        await Promise.all(reads);
      } catch (e) {
        driveError = e instanceof Error ? e.message : "Drive read failed";
        console.error("[did-context-prime] Drive error:", driveError);
      }
    })();

    // Perplexity news (parallel)
    let newsDigest = "";
    const perplexityKey = Deno.env.get("PERPLEXITY_API_KEY");
    const newsPromise = (async () => {
      if (!perplexityKey) return;
      try {
        // 1. DID-specific clinical news
        const didNewsPromise = fetch("https://api.perplexity.ai/chat/completions", {
          method: "POST",
          headers: { Authorization: `Bearer ${perplexityKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "sonar",
            messages: [
              { role: "system", content: "Shrň 3-5 nejdůležitějších novinek z oblasti DID (disociativní porucha identity), traumaterapie, práce s dětskými částmi, IFS, EMDR. Stručně, v češtině, max 200 slov." },
              { role: "user", content: `Datum: ${now.toISOString().slice(0, 10)}. Novinky relevantní pro terapeutický tým pracující s DID systémem u dětí.` },
            ],
          }),
        });

        // 2. World events + broader context (wars, disasters, social events)
        const worldNewsPromise = fetch("https://api.perplexity.ai/chat/completions", {
          method: "POST",
          headers: { Authorization: `Bearer ${perplexityKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "sonar",
            messages: [
              { role: "system", content: `Jsi analytik aktuálního dění. Shrň 5-8 nejdůležitějších událostí ve světě a v Česku za posledních 24 hodin. Zaměř se na:
1. Geopolitické události (války, konflikty, napětí – Ukrajina/Rusko, Blízký východ, apod.)
2. České zprávy (politika, společnost, počasí, události)
3. Věda a technologie (průlomy, zajímavé články)
4. Společenské události (kultura, sport, vzdělávání)
Piš stručně, v češtině, max 300 slov. U každé události přidej jednu větu o možném vlivu na náladu citlivých osob (dětí, traumatizovaných).` },
              { role: "user", content: `Datum: ${now.toISOString().slice(0, 10)}. Přehled světa pro situační povědomí.` },
            ],
          }),
        });

        const [didRes, worldRes] = await Promise.all([didNewsPromise, worldNewsPromise]);
        
        let didNews = "";
        let worldNews = "";
        if (didRes.ok) { const d = await didRes.json(); didNews = d.choices?.[0]?.message?.content || ""; }
        if (worldRes.ok) { const d = await worldRes.json(); worldNews = d.choices?.[0]?.message?.content || ""; }
        
        newsDigest = "";
        if (didNews) newsDigest += `═══ ODBORNÉ NOVINKY (DID/Trauma) ═══\n${didNews}\n\n`;
        if (worldNews) newsDigest += `═══ SVĚT DNES ═══\n${worldNews}`;
      } catch (e) { console.warn("[did-context-prime] Perplexity error:", e); }
    })();

    // Wait for all
    const dbResults: Record<string, any> = {};
    const dbEntries = Object.entries(dbPromises);
    const dbResponses = await Promise.all(dbEntries.map(([, promise]) => promise));
    dbEntries.forEach(([key], i) => { dbResults[key] = dbResponses[i].data || []; });
    await Promise.all([drivePromise, newsPromise]);

    const harvestTime = Date.now() - startTime;
    console.log(`[did-context-prime] Harvest done in ${harvestTime}ms`);

    // ═══ PHASE 2: Build digests ═══
    const didThreads = dbResults.didThreads || [];
    const didConversations = dbResults.didConversations || [];
    const hanaConversations = dbResults.hanaConversations || [];
    const didEpisodes = dbResults.didEpisodes || [];
    const olderEpisodes = dbResults.olderEpisodes || [];
    const entities = dbResults.entities || [];
    const patterns = dbResults.patterns || [];
    const relations = dbResults.relations || [];
    const strategies = dbResults.strategies || [];
    const therapistTasks = dbResults.therapistTasks || [];
    const motivationProfiles = dbResults.motivationProfiles || [];
    const kartotekaHealth = dbResults.kartotekaHealth || [];

    const didThreadDigest = didThreads.map((t: any) => {
      const msgs = Array.isArray(t.messages) ? t.messages : [];
      const lastMsgs = msgs.slice(-4).map((m: any) => `${m.role}: ${typeof m.content === 'string' ? m.content.slice(0, 150) : '[media]'}`).join("\n");
      return `[${t.part_name} | ${t.sub_mode} | ${t.last_activity_at?.slice(0, 10)}]\n${lastMsgs}`;
    }).join("\n---\n");

    const hanaDidDigest = hanaConversations.map((c: any) => {
      const msgs = Array.isArray(c.messages) ? c.messages : [];
      const lastMsgs = msgs.slice(-4).map((m: any) => `${m.role}: ${typeof m.content === 'string' ? m.content.slice(0, 120) : '[media]'}`).join("\n");
      return `[Hana→DID | ${c.last_activity_at?.slice(0, 10)}]\n${lastMsgs}`;
    }).join("\n---\n");

    const episodesDigest = didEpisodes.slice(0, 15).map((ep: any) =>
      `[${ep.timestamp_start?.slice(0, 10)}] ${ep.hana_state} | ${ep.summary_user} | Karel: ${ep.summary_karel?.slice(0, 100)} | Tags: ${ep.tags?.join(",")}`
    ).join("\n");

    const olderEpisodesDigest = olderEpisodes.map((ep: any) =>
      `[${ep.timestamp_start?.slice(0, 10)}] ${ep.summary_user?.slice(0, 80)}`
    ).join("\n");

    const driveDigestParts: string[] = [];
    for (const [folder, docs] of Object.entries(driveData)) {
      driveDigestParts.push(`═══ ${folder} ═══`);
      for (const [name, content] of Object.entries(docs)) {
        driveDigestParts.push(`--- ${name} ---\n${content.slice(0, 2500)}`);
      }
    }
    const driveDigest = driveDigestParts.join("\n");

    const tasksDigest = therapistTasks.map((t: any) => {
      const esc = (t.escalation_level || 0) >= 1 ? ` ⚠️L${t.escalation_level}` : "";
      return `[${t.priority}${esc}] ${t.task} → ${t.assigned_to} (H:${t.status_hanka} K:${t.status_kata}${t.due_date ? `, do:${t.due_date}` : ""})`;
    }).join("\n");

    const healthDigest = kartotekaHealth.slice(0, 15).map((h: any) =>
      `${h.part_name}: ${h.health_score}% | chybí: ${h.missing_sections?.join(",") || "-"} | zastaralé: ${h.stale_sections?.join(",") || "-"}`
    ).join("\n");

    const motivationDigest = motivationProfiles.map((p: any) => {
      const ratio = p.tasks_completed / Math.max(1, p.tasks_completed + p.tasks_missed);
      return `${p.therapist}: splněno ${p.tasks_completed}/${p.tasks_completed + p.tasks_missed} (${Math.round(ratio * 100)}%), série ${p.streak_current}, styl: ${p.preferred_style}`;
    }).join("\n");

    // Derive system state
    const activePartsLast24h = new Set(
      didThreads
        .filter((t: any) => {
          const diff = now.getTime() - new Date(t.last_activity_at).getTime();
          return diff < 24 * 60 * 60 * 1000 && t.sub_mode === "cast";
        })
        .map((t: any) => t.part_name)
    );

    const systemState = activePartsLast24h.size === 0 ? "KLIDNÝ" :
      activePartsLast24h.size <= 2 ? "AKTIVNÍ" :
      activePartsLast24h.size <= 5 ? "ZVÝŠENÁ_AKTIVITA" : "VYSOKÁ_AKTIVITA";

    // ═══ PHASE 3: AI Synthesis ═══
    const synthesisPrompt = `Jsi analytický modul kognitivního agenta Karla pro DID režim. Vytvoř KONTEXTOVOU CACHE pro nadcházející interakci.

INSTRUKCE:
- Syntetizuj VŠECHNA data do strukturovaného DID briefu
- Identifikuj aktuální stav DID systému – kdo je aktivní, jaká je dynamika
- Detekuj otevřené klinické otázky a rizika
- Zahrň kontext z kartotéky (00_CENTRUM) a případně karty konkrétní části
- Zahrň cross-mode data (Hana konverzace s DID doménou)
- Časový gradient: nedávné = detailní, starší = shrnuté
- NIKDY nevymýšlej – pouze syntetizuj z dodaných dat
- Piš česky

STRUKTURA VÝSTUPU:
═══ DID SITUAČNÍ CACHE ═══
📍 Generováno: [datum]
📍 Stav systému: ${systemState}
📍 Aktivní části (24h): ${[...activePartsLast24h].join(", ") || "žádné"}
📍 Sub-režim: ${subMode || "neurčen"}
${partName ? `📍 Aktuální část: ${partName}` : ""}

═══ AKTUÁLNÍ DYNAMIKA SYSTÉMU ═══
[shrnutí z DID vláken – kdo mluví, jaká témata, jaké emoce]

${partName ? `═══ KARTA ČÁSTI: ${partName} ═══\n[klíčové info z karty – sekce A,B,C,D,F,J]` : ""}

═══ CROSS-MODE ZMÍNKY ═══
[relevantní zmínky o DID částech z Hana konverzací]

═══ OTEVŘENÉ KLINICKÉ OTÁZKY ═══
[rizika, nesplněné úkoly, zastaralé karty]

═══ ÚKOLY TERAPEUTEK ═══
[nesplněné úkoly a motivační profily]

═══ ZDRAVÍ KARTOTÉKY ═══
[stav karet, chybějící sekce]

═══ DID VZORCE A STRATEGIE ═══
[relevantní vzorce a co funguje]

═══ NOVINKY ═══
[relevantní pokud dostupné]

DATA:

═══ DID VLÁKNA ═══
${didThreadDigest || "(žádná)"}

═══ HANA KONVERZACE (DID doména) ═══
${hanaDidDigest || "(žádné)"}

═══ DID EPIZODY (14 dní) ═══
${episodesDigest || "(žádné)"}

═══ STARŠÍ DID EPIZODY (14-30 dní) ═══
${olderEpisodesDigest || "(žádné)"}

═══ ENTITY ═══
${entities.map((e: any) => `${e.jmeno} (${e.typ}): ${e.role_vuci_hance} | ${e.stabilni_vlastnosti?.join(", ")}`).join("\n") || "(žádné)"}

═══ VZTAHY ═══
${relations.map((r: any) => `${r.subject_id} → ${r.relation} → ${r.object_id}: ${r.description}`).join("\n") || "(žádné)"}

═══ VZORCE ═══
${patterns.map((p: any) => `${p.description} (conf: ${p.confidence})`).join("\n") || "(žádné)"}

═══ STRATEGIE ═══
${strategies.map((s: any) => `[${s.hana_state}] ${s.description} (eff: ${s.effectiveness_score})`).join("\n") || "(žádné)"}

═══ ÚKOLY ═══
${tasksDigest || "(žádné)"}

═══ MOTIVAČNÍ PROFILY ═══
${motivationDigest || "(žádné)"}

═══ ZDRAVÍ KARET ═══
${healthDigest || "(žádné)"}

═══ DRIVE DOKUMENTY ═══
${driveDigest || "(nedostupné)"}

${partCardContent ? `═══ KARTA ČÁSTI: ${partName} ═══\n${partCardContent}` : ""}

═══ DID KONVERZACE (uložené) ═══
${didConversations.slice(0, 10).map((c: any) => `[${c.sub_mode}] ${c.label}: ${c.preview?.slice(0, 100)}`).join("\n") || "(žádné)"}

═══ NOVINKY ═══
${newsDigest || "(nedostupné)"}`;

    const aiResponse = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          { role: "system", content: "Jsi analytický modul pro DID terapeutický systém. Vytvářej přesné, datově podložené kontextové briefy. Nikdy nevymýšlej. Buď stručný ale kompletní. Piš česky." },
          { role: "user", content: synthesisPrompt },
        ],
        temperature: 0.15,
      }),
    });

    let contextBrief: string;
    if (!aiResponse.ok) {
      console.error("[did-context-prime] AI synthesis failed:", aiResponse.status);
      contextBrief = `═══ DID SITUAČNÍ CACHE (raw) ═══\n📍 ${now.toISOString()}\n📍 Stav: ${systemState}\n📍 Aktivní: ${[...activePartsLast24h].join(", ") || "žádné"}\n\n${driveDigest.slice(0, 3000)}\n\n${episodesDigest.slice(0, 2000)}`;
    } else {
      const aiData = await aiResponse.json();
      contextBrief = aiData.choices?.[0]?.message?.content || "";
    }

    const totalTime = Date.now() - startTime;
    console.log(`[did-context-prime] Done in ${totalTime}ms. Brief: ${contextBrief.length} chars`);

    // Log
    await sb.from("karel_memory_logs").insert({
      user_id: userId,
      log_type: "did_context_prime",
      summary: `DID cache: ${didThreads.length} threads, ${didEpisodes.length} episodes, ${Object.keys(driveData).length} Drive folders, part: ${partName || "none"}`,
      details: {
        harvestMs: harvestTime,
        totalMs: totalTime,
        briefLength: contextBrief.length,
        partName,
        subMode,
        systemState,
        activePartsLast24h: [...activePartsLast24h],
        driveError,
      },
    });

    return new Response(JSON.stringify({
      contextBrief,
      partCard: partCardContent,
      systemState,
      activePartsLast24h: [...activePartsLast24h],
      generatedAt: now.toISOString(),
      stats: {
        didThreads: didThreads.length,
        didEpisodes: didEpisodes.length,
        entities: entities.length,
        patterns: patterns.length,
        strategies: strategies.length,
        driveFolders: Object.keys(driveData).length,
        driveError,
        harvestMs: harvestTime,
        totalMs: totalTime,
        newsAvailable: newsDigest.length > 0,
      },
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (error) {
    console.error("[did-context-prime] Error:", error);
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
