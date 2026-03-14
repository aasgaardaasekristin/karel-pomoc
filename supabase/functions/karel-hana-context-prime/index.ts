import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { corsHeaders } from "../_shared/auth.ts";

/**
 * Karel Context Prime – Dynamická 3D mezipaměť
 * 
 * Buduje plastickou kontextovou cache skenováním VŠECH zdrojů:
 * 1. Google Drive (PAMET_KAREL, KARTOTEKA_DID, ZALOHA)
 * 2. DB tabulky (epizody, entity, vzorce, strategie, vlákna všech režimů)
 * 3. Internet (novinky přes Perplexity)
 * 
 * Výstup: strukturovaný context brief pro injekci do system promptu.
 * Spouštěno: automaticky při startu nového vlákna + denně v 6:00 + manuálně.
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
  // Try Google Doc export first
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
  const reads = docs.map(async (doc) => {
    try {
      result[doc.name] = await readDoc(token, doc.id, maxChars);
    } catch { result[doc.name] = "[chyba]"; }
  });
  await Promise.all(reads);
  return result;
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
  if (isCronOrService(req)) {
    let body: any = {};
    try { body = await req.json(); } catch {}
    if (body.userId) { userId = body.userId; }
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
  }

  try {
    console.log("[context-prime] Starting for user:", userId);
    const startTime = Date.now();

    // ═══ PHASE 0: Gradual Forgetting – archive episodes > 90 days ═══
    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    let archiveStats = { archived: 0, summaryCreated: false };

    const { data: staleEpisodes } = await sb
      .from("karel_episodes")
      .select("id, domain, hana_state, summary_user, summary_karel, tags, emotional_intensity, timestamp_start")
      .eq("user_id", userId)
      .eq("is_archived", false)
      .lt("timestamp_start", ninetyDaysAgo)
      .order("timestamp_start", { ascending: true })
      .limit(100);

    if (staleEpisodes && staleEpisodes.length > 0) {
      console.log(`[context-prime] Archiving ${staleEpisodes.length} episodes older than 90 days`);

      // Compress stale episodes into a summary via AI
      const staleDigest = staleEpisodes.map((ep: any) =>
        `[${ep.timestamp_start?.slice(0, 10)}] ${ep.domain}/${ep.hana_state} | ${ep.summary_user} | Karel: ${ep.summary_karel?.slice(0, 80)} | Tags: ${ep.tags?.join(",") || "-"} | EI: ${ep.emotional_intensity}`
      ).join("\n");

      const compressRes = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "google/gemini-2.5-flash-lite",
          messages: [
            { role: "system", content: "Jsi archivační modul kognitivního agenta. Tvým úkolem je komprimovat staré epizody do stručného shrnutí, které zachová všechny klíčové informace – vzorce, významné události, emoční dynamiku, důležité osoby a rozhodnutí. Piš česky, strukturovaně. Max 800 slov." },
            { role: "user", content: `Komprimuj těchto ${staleEpisodes.length} epizod z období ${staleEpisodes[0].timestamp_start?.slice(0, 10)} až ${staleEpisodes[staleEpisodes.length - 1].timestamp_start?.slice(0, 10)} do jednoho archivního shrnutí:\n\n${staleDigest}` },
          ],
          temperature: 0.1,
        }),
      });

      if (compressRes.ok) {
        const compressData = await compressRes.json();
        const archiveSummary = compressData.choices?.[0]?.message?.content || "";

        if (archiveSummary.length > 50) {
          // Insert archive summary as a special episode
          const periodStart = staleEpisodes[0].timestamp_start;
          const periodEnd = staleEpisodes[staleEpisodes.length - 1].timestamp_start;

          await sb.from("karel_episodes").insert({
            user_id: userId,
            domain: "ARCHIVE",
            hana_state: "ARCHIVE_SUMMARY",
            summary_user: `Archivní shrnutí ${staleEpisodes.length} epizod z ${periodStart?.slice(0, 10)} – ${periodEnd?.slice(0, 10)}`,
            summary_karel: archiveSummary,
            tags: ["archive", "compressed", `count:${staleEpisodes.length}`],
            emotional_intensity: 0,
            timestamp_start: periodStart,
            timestamp_end: periodEnd,
            is_archived: false, // Keep the summary visible
            reasoning_notes: `Auto-archived by context-prime. Original episode IDs: ${staleEpisodes.map((e: any) => e.id).join(",")}`,
          });
          archiveStats.summaryCreated = true;

          // Mark originals as archived
          const staleIds = staleEpisodes.map((e: any) => e.id);
          await sb.from("karel_episodes").update({ is_archived: true }).in("id", staleIds);
          archiveStats.archived = staleIds.length;

          console.log(`[context-prime] Archived ${staleIds.length} episodes, created summary (${archiveSummary.length} chars)`);
        }
      } else {
        console.warn("[context-prime] Archive compression failed:", compressRes.status);
      }
    }

    // ═══ PHASE 1: Parallel data harvest ═══
    const now = new Date();
    const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();

    // DB queries (all parallel)
    const dbPromises = {
      recentEpisodes: sb.from("karel_episodes").select("*").eq("user_id", userId).eq("is_archived", false).gte("timestamp_start", fourteenDaysAgo).order("timestamp_start", { ascending: false }).limit(50),
      olderEpisodes: sb.from("karel_episodes").select("domain, hana_state, summary_user, summary_karel, tags, emotional_intensity, timestamp_start").eq("user_id", userId).eq("is_archived", false).lt("timestamp_start", fourteenDaysAgo).gte("timestamp_start", thirtyDaysAgo).order("timestamp_start", { ascending: false }).limit(30),
      archiveSummaries: sb.from("karel_episodes").select("summary_karel, timestamp_start, timestamp_end, tags").eq("user_id", userId).eq("domain", "ARCHIVE").eq("is_archived", false).order("timestamp_start", { ascending: false }).limit(5),
      entities: sb.from("karel_semantic_entities").select("*").eq("user_id", userId),
      patterns: sb.from("karel_semantic_patterns").select("*").eq("user_id", userId).order("confidence", { ascending: false }).limit(20),
      relations: sb.from("karel_semantic_relations").select("*").eq("user_id", userId),
      strategies: sb.from("karel_strategies").select("*").eq("user_id", userId).order("effectiveness_score", { ascending: false }).limit(15),
      hanaThreads: sb.from("karel_hana_conversations").select("id, messages, last_activity_at, current_domain, current_hana_state").eq("user_id", userId).order("last_activity_at", { ascending: false }).limit(5),
      didThreads: sb.from("did_threads").select("id, part_name, messages, last_activity_at, sub_mode").eq("user_id", userId).order("last_activity_at", { ascending: false }).limit(10),
      didConversations: sb.from("did_conversations").select("id, label, preview, sub_mode, saved_at").eq("user_id", userId).order("saved_at", { ascending: false }).limit(10),
      researchThreads: sb.from("research_threads").select("id, topic, messages, last_activity_at").eq("user_id", userId).eq("is_deleted", false).order("last_activity_at", { ascending: false }).limit(5),
      clientSessions: sb.from("client_sessions").select("id, client_id, session_date, report_key_theme, ai_analysis").eq("user_id", userId).order("session_date", { ascending: false }).limit(10),
      therapistTasks: sb.from("did_therapist_tasks").select("task, status, priority, assigned_to, due_date").eq("user_id", userId).neq("status", "done").order("created_at", { ascending: false }).limit(15),
    };

    // Drive reads (parallel with DB)
    let driveData: Record<string, Record<string, string>> = {};
    let driveError: string | null = null;
    const drivePromise = (async () => {
      try {
        const token = await getAccessToken();

        // Find key folders
        const [pametId, kartotekaId, zalohaId] = await Promise.all([
          findFolder(token, "PAMET_KAREL"),
          findFolderFuzzy(token, ["kartoteka_DID", "Kartoteka_DID", "Kartotéka_DID", "KARTOTEKA_DID"]),
          findFolderFuzzy(token, ["ZALOHA", "Zaloha", "zaloha"]),
        ]);

        const reads: Promise<void>[] = [];

        // PAMET_KAREL: read semantic files
        if (pametId) {
          const semanticId = await findFolder(token, "PAMET_KAREL_SEMANTIC", pametId);
          if (semanticId) {
            reads.push(readFolderDocs(token, semanticId, 5, 4000).then(d => { driveData["PAMET_SEMANTIC"] = d; }));
          }
          const proceduralId = await findFolder(token, "PAMET_KAREL_PROCEDURAL", pametId);
          if (proceduralId) {
            reads.push(readFolderDocs(token, proceduralId, 3, 3000).then(d => { driveData["PAMET_PROCEDURAL"] = d; }));
          }
        }

        // KARTOTEKA_DID: read 00_CENTRUM
        if (kartotekaId) {
          const centrumId = await findFolder(token, "00_CENTRUM", kartotekaId);
          if (centrumId) {
            reads.push(readFolderDocs(token, centrumId, 8, 3000).then(d => { driveData["KARTOTEKA_CENTRUM"] = d; }));
          }
        }

        // ZALOHA: read client summary files (top-level)
        if (zalohaId) {
          reads.push(readFolderDocs(token, zalohaId, 10, 2000).then(d => { driveData["ZALOHA"] = d; }));
        }

        await Promise.all(reads);
      } catch (e) {
        driveError = e instanceof Error ? e.message : "Drive read failed";
        console.error("[context-prime] Drive error:", driveError);
      }
    })();

    // Perplexity news (parallel with everything else)
    let newsDigest = "";
    const perplexityKey = Deno.env.get("PERPLEXITY_API_KEY");
    const newsPromise = (async () => {
      if (!perplexityKey) return;
      try {
        const res = await fetch("https://api.perplexity.ai/chat/completions", {
          method: "POST",
          headers: { Authorization: `Bearer ${perplexityKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "sonar",
            messages: [
              { role: "system", content: "Shrň 5-7 nejdůležitějších novinek z oblasti psychoterapie, psychologie, DID, PTSD, legislativy v ČR týkající se terapeutické praxe. Stručně, v češtině, max 500 slov." },
              { role: "user", content: `Dnešní datum: ${now.toISOString().slice(0, 10)}. Jaké jsou aktuální novinky relevantní pro českou psychoterapeutku pracující s DID, traumatem a klienty?` },
            ],
          }),
        });
        if (res.ok) {
          const data = await res.json();
          newsDigest = data.choices?.[0]?.message?.content || "";
        }
      } catch (e) {
        console.warn("[context-prime] Perplexity error:", e);
      }
    })();

    // Wait for all harvesting
    const dbResults: Record<string, any> = {};
    const dbEntries = Object.entries(dbPromises);
    const dbResponses = await Promise.all(dbEntries.map(([, promise]) => promise));
    dbEntries.forEach(([key], i) => { dbResults[key] = dbResponses[i].data || []; });
    await Promise.all([drivePromise, newsPromise]);

    const harvestTime = Date.now() - startTime;
    console.log(`[context-prime] Harvest done in ${harvestTime}ms. DB keys: ${Object.keys(dbResults).length}, Drive folders: ${Object.keys(driveData).length}${archiveStats.archived > 0 ? `, archived: ${archiveStats.archived}` : ""}`);

    // ═══ PHASE 2: Build raw context for AI synthesis ═══
    const recentEpisodes = dbResults.recentEpisodes || [];
    const olderEpisodes = dbResults.olderEpisodes || [];
    const entities = dbResults.entities || [];
    const patterns = dbResults.patterns || [];
    const relations = dbResults.relations || [];
    const strategies = dbResults.strategies || [];
    const hanaThreads = dbResults.hanaThreads || [];
    const didThreads = dbResults.didThreads || [];
    const didConversations = dbResults.didConversations || [];
    const researchThreads = dbResults.researchThreads || [];
    const clientSessions = dbResults.clientSessions || [];
    const therapistTasks = dbResults.therapistTasks || [];

    // Extract last messages from recent hana threads
    const hanaThreadDigest = hanaThreads.map((t: any) => {
      const msgs = Array.isArray(t.messages) ? t.messages : [];
      const lastMsgs = msgs.slice(-6).map((m: any) => `${m.role}: ${typeof m.content === 'string' ? m.content.slice(0, 200) : '[media]'}`).join("\n");
      return `[Vlákno ${t.id.slice(0, 8)} | ${t.last_activity_at?.slice(0, 10)} | ${t.current_domain}/${t.current_hana_state}]\n${lastMsgs}`;
    }).join("\n---\n");

    // DID thread digest
    const didThreadDigest = didThreads.map((t: any) => {
      const msgs = Array.isArray(t.messages) ? t.messages : [];
      const lastMsgs = msgs.slice(-4).map((m: any) => `${m.role}: ${typeof m.content === 'string' ? m.content.slice(0, 150) : '[media]'}`).join("\n");
      return `[${t.part_name} | ${t.sub_mode} | ${t.last_activity_at?.slice(0, 10)}]\n${lastMsgs}`;
    }).join("\n---\n");

    // Episodes digest (temporal gradient: recent = full, older = compressed)
    const recentEpisodesDigest = recentEpisodes.slice(0, 20).map((ep: any) =>
      `[${ep.timestamp_start?.slice(0, 10)}] ${ep.domain}/${ep.hana_state} | ${ep.summary_user} | Karel: ${ep.summary_karel?.slice(0, 100)} | Tags: ${ep.tags?.join(",")}`
    ).join("\n");

    const olderEpisodesDigest = olderEpisodes.map((ep: any) =>
      `[${ep.timestamp_start?.slice(0, 10)}] ${ep.domain} | ${ep.summary_user?.slice(0, 80)}`
    ).join("\n");

    // Drive digest
    const driveDigestParts: string[] = [];
    for (const [folder, docs] of Object.entries(driveData)) {
      driveDigestParts.push(`═══ ${folder} ═══`);
      for (const [name, content] of Object.entries(docs)) {
        driveDigestParts.push(`--- ${name} ---\n${content.slice(0, 2000)}`);
      }
    }
    const driveDigest = driveDigestParts.join("\n");

    // Tasks digest
    const tasksDigest = therapistTasks.map((t: any) => `[${t.priority}] ${t.task} → ${t.assigned_to} (${t.status}${t.due_date ? `, do: ${t.due_date}` : ""})`).join("\n");

    // Research digest
    const researchDigest = researchThreads.map((t: any) => `[${t.topic}] ${t.last_activity_at?.slice(0, 10)}`).join("\n");

    // Client sessions digest
    const sessionsDigest = clientSessions.map((s: any) => `[${s.session_date}] ${s.report_key_theme || "bez tématu"}`).join("\n");

    // ═══ PHASE 3: AI Synthesis ═══
    const synthesisPrompt = `Jsi analytický modul kognitivního agenta Karla. Tvým úkolem je vytvořit KONTEXTOVOU CACHE – plastickou, dynamickou mezipaměť pro nadcházející interakci s Hankou.

INSTRUKCE:
- Analyzuj VŠECHNA data níže a syntetizuj je do strukturovaného briefu
- Identifikuj Hančin AKTUÁLNÍ stav, náladu, dominantní témata
- Detekuj co řeší, co ji trápí, co se daří
- Uveď relevantní kontext z Drive (kartotéka, klienti, kluci)
- Zahrň vzorce chování a doporučené strategie
- Časový gradient: nedávné = detailní, starší = shrnuté, dávné = jen vzorce
- NIKDY nevymýšlej informace – pouze syntetizuj z dodaných dat
- Piš česky

STRUKTURA VÝSTUPU (dodržuj přesně):
═══ KARLOVA KONTEXTOVÁ CACHE ═══
📍 Generováno: [datum]
📍 Hančin stav: [detekovaný emoční stav a intenzita]
📍 Dominantní témata: [3-5 aktuálních témat]
📍 Režim pozornosti: [co sledovat, na co být citlivý]

═══ CO HANKA AKTUÁLNĚ ŘEŠÍ ═══
[shrnutí z posledních vláken a epizod]

═══ KLUCI (DID SYSTÉM) ═══
[aktuální stav z DID vláken a kartotéky]

═══ PRÁCE (KLIENTI) ═══
[aktuální z posledních sezení a úkolů]

═══ OSOBNÍ ROVINA ═══
[emoční vzorce, nálada, potřeby]

═══ AKTIVNÍ ÚKOLY ═══
[otevřené terapeutické úkoly]

═══ VZORCE A STRATEGIE ═══
[relevantní vzorce chování + doporučené strategie pro aktuální kontext]

═══ NOVINKY ZE SVĚTA ═══
[relevantní zprávy pokud dostupné]

═══ TEMPORÁLNÍ GRADIENT ═══
[nedávné detaily → starší shrnutí → dlouhodobé vzorce]

DATA PRO ANALÝZU:

═══ NEDÁVNÉ EPIZODY (14 dní) ═══
${recentEpisodesDigest || "(žádné)"}

═══ STARŠÍ EPIZODY (14-30 dní) ═══
${olderEpisodesDigest || "(žádné)"}

═══ ENTITY (osoby, části) ═══
${entities.map((e: any) => `${e.jmeno} (${e.typ}): ${e.role_vuci_hance} | ${e.stabilni_vlastnosti?.join(", ")}`).join("\n") || "(žádné)"}

═══ VZTAHY ═══
${relations.map((r: any) => `${r.subject_id} → ${r.relation} → ${r.object_id}: ${r.description}`).join("\n") || "(žádné)"}

═══ VZORCE ═══
${patterns.map((p: any) => `[${p.domain}] ${p.description} (conf: ${p.confidence})`).join("\n") || "(žádné)"}

═══ STRATEGIE ═══
${strategies.map((s: any) => `[${s.domain}/${s.hana_state}] ${s.description} (eff: ${s.effectiveness_score})`).join("\n") || "(žádné)"}

═══ HANA VLÁKNA (poslední zprávy) ═══
${hanaThreadDigest || "(žádná)"}

═══ DID VLÁKNA ═══
${didThreadDigest || "(žádná)"}

═══ DID KONVERZACE (uložené) ═══
${didConversations.map((c: any) => `[${c.sub_mode}] ${c.label}: ${c.preview?.slice(0, 100)}`).join("\n") || "(žádné)"}

═══ VÝZKUM ═══
${researchDigest || "(žádný)"}

═══ KLIENTSKÁ SEZENÍ ═══
${sessionsDigest || "(žádná)"}

═══ ÚKOLY ═══
${tasksDigest || "(žádné)"}

═══ DRIVE DOKUMENTY ═══
${driveDigest || "(nedostupné)"}

═══ NOVINKY ═══
${newsDigest || "(nedostupné)"}`;

    const aiResponse = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          { role: "system", content: "Jsi analytický modul. Vytvářej přesné, datově podložené kontextové briefy. Nikdy nevymýšlej. Buď stručný ale kompletní." },
          { role: "user", content: synthesisPrompt },
        ],
        temperature: 0.15,
      }),
    });

    if (!aiResponse.ok) {
      console.error("[context-prime] AI synthesis failed:", aiResponse.status);
      // Fallback: return raw data without AI synthesis
      const fallbackCache = `═══ KARLOVA KONTEXTOVÁ CACHE (raw) ═══
📍 Generováno: ${now.toISOString()}
📍 Data: ${recentEpisodes.length} epizod, ${entities.length} entit, ${patterns.length} vzorců
📍 Drive: ${Object.keys(driveData).length} složek načteno

NEDÁVNÉ EPIZODY:
${recentEpisodesDigest.slice(0, 2000)}

ENTITY:
${entities.map((e: any) => `${e.jmeno} (${e.typ}): ${e.role_vuci_hance}`).join("\n")}

VZORCE:
${patterns.map((p: any) => `[${p.domain}] ${p.description}`).join("\n")}`;

      return new Response(JSON.stringify({
        contextBrief: fallbackCache,
        generatedAt: now.toISOString(),
        stats: { episodes: recentEpisodes.length, entities: entities.length, driveError, harvestMs: harvestTime },
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const aiData = await aiResponse.json();
    const contextBrief = aiData.choices?.[0]?.message?.content || "";

    const totalTime = Date.now() - startTime;
    console.log(`[context-prime] Done in ${totalTime}ms. Brief length: ${contextBrief.length}`);

    // Log the context prime event
    await sb.from("karel_memory_logs").insert({
      user_id: userId,
      log_type: "context_prime",
      summary: `Context cache built: ${recentEpisodes.length} episodes, ${entities.length} entities, ${Object.keys(driveData).length} Drive folders`,
      details: {
        harvestMs: harvestTime,
        totalMs: totalTime,
        briefLength: contextBrief.length,
        driveError,
        dataStats: {
          recentEpisodes: recentEpisodes.length,
          olderEpisodes: olderEpisodes.length,
          entities: entities.length,
          patterns: patterns.length,
          strategies: strategies.length,
          hanaThreads: hanaThreads.length,
          didThreads: didThreads.length,
          news: newsDigest.length > 0,
        },
      },
    });

    return new Response(JSON.stringify({
      contextBrief,
      generatedAt: now.toISOString(),
      stats: {
        episodes: recentEpisodes.length + olderEpisodes.length,
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
    console.error("[context-prime] Error:", error);
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
