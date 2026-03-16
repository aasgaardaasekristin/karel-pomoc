/// <reference types="https://esm.sh/@supabase/functions-js/src/edge-runtime.d.ts" />
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/auth.ts";

/**
 * Karel Memory Mirror – Masivní analytický engine
 * 
 * Při spuštění:
 * 1) Zjistí čas posledního zrcadlení → scope = vše od té doby
 * 2) Naskenuje VŠECHNA vlákna/konverzace ze VŠECH režimů v tom rozsahu
 * 3) Načte VŠECHNY dokumenty ze VŠECH 3 Drive složek (PAMET_KAREL, KARTOTEKA_DID, ZALOHA)
 * 4) AI Pass 1 (Gemini 2.5 Pro): Extrakce surových faktů, jmen, událostí, emocí
 * 5) AI Pass 2 (Gemini 2.5 Pro): Hloubková syntéza – cross-reference s Drive, inferování
 *    skrytých emocí, navrhování úkolů, doporučení sezení
 * 6) Zápis do DB (entity, vzorce, strategie, úkoly)
 * 7) Zápis na Drive (PAMET_KAREL, KARTOTEKA_DID, ZALOHA)
 *
 * DEDUP: KHASH, concurrency lock, DB upsert
 */

// ── Content hash (FNV-1a 32bit) ──
function contentHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

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

async function findDoc(token: string, pattern: string, parentId: string): Promise<{ id: string; name: string } | null> {
  const q = `name contains '${pattern}' and '${parentId}' in parents and trashed=false`;
  const params = new URLSearchParams({ q, fields: "files(id,name)", pageSize: "10", supportsAllDrives: "true", includeItemsFromAllDrives: "true" });
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  return data.files?.[0] || null;
}

async function readDoc(token: string, fileId: string): Promise<string> {
  let res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/plain`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, { headers: { Authorization: `Bearer ${token}` } });
  }
  if (!res.ok) return "";
  return await res.text();
}

async function updateDoc(token: string, docId: string, content: string): Promise<void> {
  const boundary = "===redistribute_boundary===";
  const body = [
    `--${boundary}`, "Content-Type: application/json; charset=UTF-8", "", JSON.stringify({}),
    `--${boundary}`, "Content-Type: text/plain; charset=UTF-8", "", content, `--${boundary}--`,
  ].join("\r\n");
  const res = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${docId}?uploadType=multipart&supportsAllDrives=true`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": `multipart/related; boundary=${boundary}` },
    body,
  });
  if (!res.ok) throw new Error(`Failed to update doc ${docId}: ${await res.text()}`);
}

async function listAllFilesRecursive(token: string, folderId: string, prefix = ""): Promise<Array<{ id: string; name: string; path: string; isFolder: boolean }>> {
  const q = `'${folderId}' in parents and trashed=false`;
  const params = new URLSearchParams({ q, fields: "files(id,name,mimeType)", pageSize: "200", supportsAllDrives: "true", includeItemsFromAllDrives: "true" });
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  const files = data.files || [];
  const result: Array<{ id: string; name: string; path: string; isFolder: boolean }> = [];
  
  for (const f of files) {
    const isFolder = f.mimeType === "application/vnd.google-apps.folder";
    const path = prefix ? `${prefix}/${f.name}` : f.name;
    result.push({ id: f.id, name: f.name, path, isFolder });
    if (isFolder) {
      const children = await listAllFilesRecursive(token, f.id, path);
      result.push(...children);
    }
  }
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

// ── AI call helper ──
async function callAI(apiKey: string, systemPrompt: string, userPrompt: string, model = "google/gemini-2.5-pro"): Promise<string> {
  const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.15,
    }),
  });
  if (!res.ok) throw new Error(`AI error ${res.status}: ${await res.text().catch(() => "")}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content || "";
}

function extractJSON(text: string): any {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch { return null; }
}

// ── Main ──
Deno.serve(async (req) => {
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
    // ═══ CONCURRENCY LOCK ═══
    const LOCK_MINUTES = 5;
    const { data: lockRow } = await sb.from("karel_memory_logs").insert({
      user_id: userId, log_type: "redistribute_lock", summary: "Lock acquired",
    }).select("id, created_at").single();
    const lockId = lockRow?.id;

    const lockCutoff = new Date(Date.now() - LOCK_MINUTES * 60 * 1000).toISOString();
    const { data: allLocks } = await sb.from("karel_memory_logs")
      .select("id, created_at")
      .eq("user_id", userId).eq("log_type", "redistribute_lock")
      .gte("created_at", lockCutoff).order("created_at", { ascending: true });

    const olderLock = allLocks?.find(l => l.id !== lockId && l.created_at <= (lockRow?.created_at || ""));
    if (olderLock) {
      await sb.from("karel_memory_logs").delete().eq("id", lockId);
      return new Response(JSON.stringify({ status: "skipped", reason: "Redistribuce již probíhá." }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    console.log("[mirror] ═══ START for user:", userId);
    const startTime = Date.now();

    // ═══ PHASE 0: Determine time scope — since last successful mirror ═══
    const { data: lastMirror } = await sb.from("karel_memory_logs")
      .select("created_at")
      .eq("user_id", userId).eq("log_type", "redistribute")
      .order("created_at", { ascending: false }).limit(1);
    
    const lastMirrorTime = lastMirror?.[0]?.created_at || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    console.log(`[mirror] Scope: since ${lastMirrorTime}`);

    // ═══ PHASE 1: Massive data collection from ALL modes ═══
    const [hanaRes, didThreadsRes, didConvsRes, researchRes, episodesRes, entitiesRes, patternsRes, relationsRes, strategiesRes, tasksRes, registryRes] = await Promise.all([
      sb.from("karel_hana_conversations").select("id, messages, last_activity_at, current_domain, current_hana_state").eq("user_id", userId).gte("last_activity_at", lastMirrorTime).order("last_activity_at", { ascending: false }).limit(50),
      sb.from("did_threads").select("id, part_name, messages, last_activity_at, sub_mode, part_language").eq("user_id", userId).gte("last_activity_at", lastMirrorTime).order("last_activity_at", { ascending: false }).limit(50),
      sb.from("did_conversations").select("id, label, messages, sub_mode, preview, did_initial_context, saved_at").eq("user_id", userId).gte("saved_at", lastMirrorTime).order("saved_at", { ascending: false }).limit(50),
      sb.from("research_threads").select("id, topic, messages, last_activity_at").eq("user_id", userId).eq("is_deleted", false).gte("last_activity_at", lastMirrorTime).limit(20),
      sb.from("karel_episodes").select("*").eq("user_id", userId).eq("is_archived", false).order("timestamp_start", { ascending: false }).limit(300),
      sb.from("karel_semantic_entities").select("*").eq("user_id", userId),
      sb.from("karel_semantic_patterns").select("*").eq("user_id", userId),
      sb.from("karel_semantic_relations").select("*").eq("user_id", userId),
      sb.from("karel_strategies").select("*").eq("user_id", userId),
      sb.from("did_therapist_tasks").select("*").eq("user_id", userId).in("status", ["pending", "in_progress"]),
      sb.from("did_part_registry").select("*").eq("user_id", userId),
    ]);

    const hanaConvs = hanaRes.data || [];
    const didThreads = didThreadsRes.data || [];
    const didConvs = didConvsRes.data || [];
    const researchThreads = researchRes.data || [];
    const episodes = episodesRes.data || [];
    const entities = entitiesRes.data || [];
    const patterns = patternsRes.data || [];
    const relations = relationsRes.data || [];
    const strategies = strategiesRes.data || [];
    const activeTasks = tasksRes.data || [];
    const registry = registryRes.data || [];
    const knownPartNames = registry.map((p: any) => p.part_name || p.display_name);

    // Build thread digests — smart truncation to stay within AI context limits
    // Edge functions have ~60s timeout, so we cap total data to ~40K chars
    const MAX_PER_MSG = 800;
    const MAX_PER_THREAD = 6000;
    const MAX_TOTAL_THREADS = 40000;

    function buildFullDigest(msgs: any[]): string {
      if (!Array.isArray(msgs) || msgs.length < 1) return "";
      let total = 0;
      const lines: string[] = [];
      for (const m of msgs) {
        if (total >= MAX_PER_THREAD) break;
        const content = typeof m.content === "string" ? m.content.slice(0, MAX_PER_MSG) : "[media]";
        const line = `${m.role}: ${content}`;
        lines.push(line);
        total += line.length;
      }
      return lines.join("\n");
    }

    const threadDigests: string[] = [];
    let totalThreadChars = 0;

    for (const conv of hanaConvs) {
      if (totalThreadChars >= MAX_TOTAL_THREADS) break;
      const msgs = Array.isArray(conv.messages) ? conv.messages : [];
      if (msgs.length < 1) continue;
      const digest = `[HANA | ${conv.last_activity_at?.slice(0, 16)} | ${conv.current_domain} | stav:${conv.current_hana_state} | ${msgs.length} zpráv]\n${buildFullDigest(msgs)}`;
      threadDigests.push(digest);
      totalThreadChars += digest.length;
    }
    for (const t of didThreads) {
      if (totalThreadChars >= MAX_TOTAL_THREADS) break;
      const msgs = Array.isArray(t.messages) ? t.messages : [];
      if (msgs.length < 1) continue;
      const digest = `[DID_VLÁKNO | část:${t.part_name} | mód:${t.sub_mode} | jazyk:${t.part_language} | ${t.last_activity_at?.slice(0, 16)} | ${msgs.length} zpráv]\n${buildFullDigest(msgs)}`;
      threadDigests.push(digest);
      totalThreadChars += digest.length;
    }
    for (const c of didConvs) {
      if (totalThreadChars >= MAX_TOTAL_THREADS) break;
      const msgs = Array.isArray(c.messages) ? c.messages : [];
      if (msgs.length < 1) continue;
      const digest = `[DID_KONV | ${c.label} | mód:${c.sub_mode} | ${msgs.length} zpráv]\n${buildFullDigest(msgs)}`;
      threadDigests.push(digest);
      totalThreadChars += digest.length;
    }
    for (const r of researchThreads) {
      if (totalThreadChars >= MAX_TOTAL_THREADS) break;
      const msgs = Array.isArray(r.messages) ? r.messages : [];
      if (msgs.length < 1) continue;
      const digest = `[RESEARCH | ${r.topic} | ${msgs.length} zpráv]\n${buildFullDigest(msgs)}`;
      threadDigests.push(digest);
      totalThreadChars += digest.length;
    }

    console.log(`[mirror] Phase 1: ${threadDigests.length} threads, ${totalThreadChars} chars`);

    if (threadDigests.length === 0) {
      if (lockId) await sb.from("karel_memory_logs").update({ summary: "No new data" }).eq("id", lockId);
      return new Response(JSON.stringify({ status: "ok", summary: "Žádná nová data od posledního zrcadlení." }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ═══ PHASE 2: Deep Drive read — ALL documents from ALL folders ═══
    console.log("[mirror] Phase 2: Reading ALL Drive documents...");
    const driveContents: Record<string, string> = {};
    let driveDocsRead = 0;

    try {
      const token = await getAccessToken();

      // Read all three root folders recursively
      const folderSearches = await Promise.all([
        findFolderFuzzy(token, ["PAMET_KAREL"]),
        findFolderFuzzy(token, ["kartoteka_DID", "Kartoteka_DID", "KARTOTEKA_DID"]),
        findFolderFuzzy(token, ["ZALOHA", "Zaloha"]),
      ]);
      const [pametId, kartotekaId, zalohaId] = folderSearches;

      const readFolderDocs = async (folderId: string | null, label: string) => {
        if (!folderId) return;
        const allFiles = await listAllFilesRecursive(token, folderId, label);
        const docFiles = allFiles.filter(f => !f.isFolder);
        // Read up to 30 docs to stay within time limits
        const toRead = docFiles.slice(0, 30);
        for (const doc of toRead) {
          try {
            const content = await readDoc(token, doc.id);
            if (content && content.length > 10) {
              driveContents[doc.path] = content.slice(0, 4000); // cap per doc
              driveDocsRead++;
            }
          } catch (e) {
            console.warn(`[mirror] Could not read ${doc.path}: ${e}`);
          }
        }
      };

      // Read all 3 folders in sequence (to avoid rate limits)
      await readFolderDocs(pametId, "PAMET_KAREL");
      await readFolderDocs(kartotekaId, "KARTOTEKA_DID");
      await readFolderDocs(zalohaId, "ZALOHA");

      console.log(`[mirror] Phase 2: Read ${driveDocsRead} Drive documents`);
    } catch (driveReadErr) {
      console.error("[mirror] Drive read error (continuing with DB data):", driveReadErr);
    }

    // Build Drive digest for AI (compact)
    const driveDigest = Object.entries(driveContents)
      .map(([path, content]) => `[DRIVE:${path}]\n${content.slice(0, 2000)}`)
      .join("\n═══════\n");

    // ═══ PHASE 3: AI Pass 1 — Deep extraction of raw facts ═══
    console.log("[mirror] Phase 3: AI Pass 1 — extraction...");

    const pass1System = `Jsi Karel – hloubkový analytický engine. Tvým úkolem je přečíst KOMPLETNĚ VŠECHNA vlákna konverzací a extrahovat VEŠKERÉ informace, i ty skryté "mezi řádky".

PRAVIDLA HLOUBKOVÉ ANALÝZY:
1. Nečti povrchně. Každá věta může obsahovat klíčovou informaci.
2. Pokud někdo říká "vypadal divně" nebo "nechtěl mluvit", analyzuj CO to znamená (strach? stud? únava? odpor?)
3. Pokud terapeutka (Hana/Káťa) popisuje chování části, extrahuj emoční stav, triggery, potřeby
4. Pokud část mluví přímo (cast mode), analyzuj jazyk, tón, skryté obavy
5. Hledej SOUVISLOSTI: zmínka o jedné části v jednom vlákně může vysvětlit chování jiné části v jiném vlákně
6. NIKDY nepřehlížej jména – každé jméno/přezdívka je potenciální nová část DID systému
7. Extrahuj informace o Haně a Káťe samotných – jejich nálada, stres, potřeby, úspěchy`;

    const pass1Prompt = `STÁVAJÍCÍ REGISTR ČÁSTÍ: ${knownPartNames.join(", ") || "prázdný"}
STÁVAJÍCÍ ENTITY: ${entities.map((e: any) => `${e.id}:${e.jmeno}(${e.typ})`).join(", ") || "žádné"}
AKTIVNÍ ÚKOLY: ${activeTasks.map((t: any) => `[${t.assigned_to}] ${t.task} (${t.status})`).join("; ") || "žádné"}

═══ VLÁKNA K ANALÝZE (od ${lastMirrorTime.slice(0, 16)}) ═══
${threadDigests.join("\n═══════════════\n")}

Analyzuj HLOUBKOVĚ a vrať JSON:
{
  "raw_facts": [
    {"subject": "jméno osoby/části", "fact": "co jsme se dozvěděli", "source_type": "HANA|DID|RESEARCH", "confidence": 0.9, "hidden": false, "inferred_emotion": "strach|radost|stud|...|null"}
  ],
  "all_names_mentioned": ["KAŽDÉ jméno zmíněné kdekoliv"],
  "new_parts_detected": [
    {"name": "jméno", "evidence": "odkud víme že existuje", "status_guess": "Aktivní|Spící"}
  ],
  "therapist_observations": {
    "hanka": {"mood": "...", "stress_level": "low|medium|high", "needs": ["..."], "achievements": ["..."]},
    "kata": {"mood": "...", "stress_level": "low|medium|high", "needs": ["..."], "achievements": ["..."]}
  },
  "cross_references": [
    {"parts_involved": ["A", "B"], "pattern": "popis souvislosti mezi nimi"}
  ],
  "urgent_signals": ["cokoliv co vyžaduje okamžitou pozornost"],
  "summary": "celkové shrnutí dne"
}`;

    const pass1Raw = await callAI(LOVABLE_API_KEY!, pass1System, pass1Prompt);
    const pass1Data = extractJSON(pass1Raw) || { raw_facts: [], all_names_mentioned: [], new_parts_detected: [], therapist_observations: {}, cross_references: [], urgent_signals: [] };
    
    console.log(`[mirror] Pass 1: ${pass1Data.raw_facts?.length || 0} facts, ${pass1Data.all_names_mentioned?.length || 0} names, ${pass1Data.new_parts_detected?.length || 0} new parts, ${pass1Data.urgent_signals?.length || 0} urgent`);

    // ═══ PHASE 4: AI Pass 2 — Deep synthesis with Drive context ═══
    console.log("[mirror] Phase 4: AI Pass 2 — synthesis with Drive docs...");

    const pass2System = `Jsi Karel – strategický analytik DID systému. Máš k dispozici:
1. Surové fakty extrahované z dnešních konverzací
2. KOMPLETNÍ obsah všech dokumentů na Google Drive

Tvým úkolem je SYNTÉZA: spojit nové poznatky s existujícími záznamy, najít hlubší vzorce, inferovat skryté souvislosti a navrhnout konkrétní akce.

PRAVIDLA:
- Čti CELÝ obsah Drive dokumentů – ne jen nadpisy, ale i malé poznámky a detaily
- Pokud nový fakt doplňuje existující záznam na Drive, navrhni kam přesně ho zapsat
- Pokud detekuješ rozpor (něco nového vs. starý záznam), upozorni
- Pro KAŽDOU novou část vytvoř kompletní kartu s 13 sekcemi (A-M)
- Navrhuj KONKRÉTNÍ úkoly pro Hanku a/nebo Káťu – ne abstraktní, ale akční
- Pokud část vykazuje strach/stud/úzkost (i skrytě), navrhni specifickou terapeutickou intervenci
- Aktualizuj motivační profily terapeutek na základě pozorování`;

    const pass2Prompt = `═══ SUROVÉ FAKTY Z DNEŠNÍCH KONVERZACÍ ═══
${JSON.stringify(pass1Data, null, 1)}

═══ EXISTUJÍCÍ REGISTRY A DB ═══
Části: ${registry.map((p: any) => `${p.part_name}(${p.status}, cluster:${p.cluster||'?'}, last:${p.last_seen_at?.slice(0,10)||'?'})`).join(", ")}
Entity: ${entities.map((e: any) => `${e.jmeno}(${e.typ}): ${e.stabilni_vlastnosti?.join(',')}`).join("; ")}
Vzorce: ${patterns.map((p: any) => `${p.id}: ${p.description?.slice(0,60)}`).join("; ")}

═══ OBSAH DRIVE DOKUMENTŮ (${driveDocsRead} souborů) ═══
${driveDigest.slice(0, 80000)}

Proveď HLOUBKOVOU SYNTÉZU a vrať JSON:
{
  "pamet_karel": {
    "entity_updates": [{"id": "...", "jmeno": "...", "typ": "clovek|cast_did|klient", "role_vuci_hance": "...", "new_properties": ["..."], "new_notes": "..."}],
    "pattern_updates": [{"id": "...", "description": "...", "domain": "HANA|DID|PRACE", "tags": ["..."], "confidence_delta": 0.1}],
    "relation_updates": [{"subject_id": "...", "relation": "...", "object_id": "...", "description": "..."}],
    "strategy_updates": [{"id": "...", "description": "...", "domain": "...", "hana_state": "...", "effectiveness_delta": 0.1, "new_guidelines": ["..."]}]
  },
  "kartoteka_did": {
    "part_updates": {"existing_part_name": "text k doplnění do karty – Karel musí specifikovat DO KTERÉ SEKCE (A-M)"},
    "new_parts": [
      {
        "name": "jméno",
        "sections": {"A": "...", "B": "...", "C": "...", "D": "...", "E": "...", "F": "...", "G": "...", "H": "...", "I": "...", "J": "...", "K": "...", "L": "...", "M": "..."},
        "status": "Spící|Aktivní",
        "cluster": "...",
        "inferred_data": "co Karel vyčetl mezi řádky – strachy, stud, skryté potřeby"
      }
    ]
  },
  "zaloha": {
    "client_updates": {"client_name": "nové poznatky"}
  },
  "new_tasks": [
    {"task": "konkrétní úkol", "assigned_to": "hanka|kata|both", "priority": "high|normal|low", "category": "session|observation|coordination|intervention", "reasoning": "proč tento úkol"}
  ],
  "centrum_updates": {
    "dashboard_notes": "nové poznatky pro 00_Dashboard",
    "geography_notes": "nové poznatky pro 03_Geografie vnitřního světa",
    "relationships_notes": "nové poznatky pro 04_Mapa_Vztahu",
    "operative_plan_notes": "nové poznatky pro 05_Operativni_Plan"
  },
  "motivation_updates": {
    "hanka": {"praise": "co pochválit", "concern": "na co upozornit", "tip": "personalizovaný tip"},
    "kata": {"praise": "co pochválit", "concern": "na co upozornit", "tip": "personalizovaný tip"}
  },
  "synthesis_summary": "Karlova celková reflexe – co dnes systém prožil, jaké jsou trendy, co ho znepokojuje, co ho těší"
}`;

    const pass2Raw = await callAI(LOVABLE_API_KEY!, pass2System, pass2Prompt);
    const extractedInfo = extractJSON(pass2Raw) || { pamet_karel: {}, kartoteka_did: {}, zaloha: {}, new_tasks: [], centrum_updates: {}, motivation_updates: {} };

    const newParts = extractedInfo.kartoteka_did?.new_parts || [];
    const partUpdates = Object.keys(extractedInfo.kartoteka_did?.part_updates || {});
    const newTasks = extractedInfo.new_tasks || [];
    console.log(`[mirror] Pass 2: ${newParts.length} new parts, ${partUpdates.length} part updates, ${newTasks.length} new tasks`);

    // ═══ PHASE 5: Apply DB updates ═══
    const dbUpdates: string[] = [];

    // Entity updates
    if (extractedInfo.pamet_karel?.entity_updates?.length) {
      for (const eu of extractedInfo.pamet_karel.entity_updates) {
        const existing = entities.find((e: any) => e.id === eu.id || e.jmeno === eu.jmeno);
        if (existing) {
          const newProps = [...new Set([...(existing.stabilni_vlastnosti || []), ...(eu.new_properties || [])])];
          const newNotes = existing.notes ? `${existing.notes}\n${eu.new_notes || ""}` : (eu.new_notes || "");
          await sb.from("karel_semantic_entities").update({
            stabilni_vlastnosti: newProps, notes: newNotes.slice(0, 5000),
            role_vuci_hance: eu.role_vuci_hance || existing.role_vuci_hance,
            updated_at: new Date().toISOString(),
          }).eq("id", existing.id).eq("user_id", userId);
          dbUpdates.push(`entity_update:${existing.jmeno}`);
        } else if (eu.jmeno) {
          await sb.from("karel_semantic_entities").insert({
            id: eu.id || eu.jmeno.toLowerCase().replace(/\s/g, "_"),
            user_id: userId, jmeno: eu.jmeno, typ: eu.typ || "clovek",
            role_vuci_hance: eu.role_vuci_hance || "",
            stabilni_vlastnosti: eu.new_properties || [],
            notes: eu.new_notes || "",
          });
          dbUpdates.push(`entity_new:${eu.jmeno}`);
        }
      }
    }

    // Pattern updates
    for (const pu of (extractedInfo.pamet_karel?.pattern_updates || [])) {
      const existing = patterns.find((p: any) => p.id === pu.id);
      if (existing) {
        await sb.from("karel_semantic_patterns").update({
          description: pu.description || existing.description,
          confidence: Math.min(1, Math.max(0, (existing.confidence || 0.5) + (pu.confidence_delta || 0))),
          tags: [...new Set([...(existing.tags || []), ...(pu.tags || [])])],
          updated_at: new Date().toISOString(),
        }).eq("id", existing.id).eq("user_id", userId);
        dbUpdates.push(`pattern_update:${pu.id}`);
      } else if (pu.description) {
        await sb.from("karel_semantic_patterns").insert({
          id: pu.id || `pat_${Date.now()}`, user_id: userId,
          description: pu.description, domain: pu.domain || "HANA",
          tags: pu.tags || [], confidence: 0.5,
        });
        dbUpdates.push(`pattern_new:${pu.id}`);
      }
    }

    // Strategy & relation updates
    for (const su of (extractedInfo.pamet_karel?.strategy_updates || [])) {
      const existing = strategies.find((s: any) => s.id === su.id);
      if (existing) {
        await sb.from("karel_strategies").update({
          effectiveness_score: Math.min(1, Math.max(0, (existing.effectiveness_score || 0.5) + (su.effectiveness_delta || 0))),
          guidelines: [...new Set([...(existing.guidelines || []), ...(su.new_guidelines || [])])],
          updated_at: new Date().toISOString(),
        }).eq("id", existing.id).eq("user_id", userId);
        dbUpdates.push(`strategy_update:${su.id}`);
      } else if (su.description) {
        await sb.from("karel_strategies").insert({
          id: su.id || `str_${Date.now()}`, user_id: userId,
          description: su.description, domain: su.domain || "HANA",
          hana_state: su.hana_state || "", guidelines: su.new_guidelines || [],
          effectiveness_score: 0.5,
        });
        dbUpdates.push(`strategy_new:${su.id}`);
      }
    }

    for (const ru of (extractedInfo.pamet_karel?.relation_updates || [])) {
      const existing = relations.find((r: any) => r.subject_id === ru.subject_id && r.object_id === ru.object_id && r.relation === ru.relation);
      if (!existing && ru.subject_id && ru.object_id) {
        await sb.from("karel_semantic_relations").insert({
          user_id: userId, subject_id: ru.subject_id, relation: ru.relation,
          object_id: ru.object_id, description: ru.description || "",
        });
        dbUpdates.push(`relation_new:${ru.subject_id}->${ru.object_id}`);
      }
    }

    // NEW: Create therapist tasks from AI recommendations
    if (newTasks.length > 0) {
      for (const task of newTasks) {
        if (!task.task) continue;
        // Dedup: check if similar task already exists
        const existingTask = activeTasks.find((t: any) => t.task.toLowerCase().includes(task.task.toLowerCase().slice(0, 30)));
        if (existingTask) {
          dbUpdates.push(`task_dedup:${task.task.slice(0, 40)}`);
          continue;
        }
        await sb.from("did_therapist_tasks").insert({
          user_id: userId,
          task: task.task,
          assigned_to: task.assigned_to || "both",
          priority: task.priority || "normal",
          category: task.category || "general",
          note: task.reasoning || "",
          source_agreement: "mirror_auto",
        });
        dbUpdates.push(`task_new:${task.task.slice(0, 40)}`);
      }
    }

    // ═══ PHASE 6: Drive redistribution ═══
    const driveUpdates: string[] = [];
    try {
      const token = await getAccessToken();

      // PAMET_KAREL: update semantic files
      const pametId = await findFolderFuzzy(token, ["PAMET_KAREL"]);
      if (pametId) {
        const semanticId = await findFolder(token, "PAMET_KAREL_SEMANTIC", pametId);
        const proceduralId = await findFolder(token, "PAMET_KAREL_PROCEDURAL", pametId);
        const episodesId = await findFolder(token, "PAMET_KAREL_EPISODES", pametId);

        const [freshEntities, freshPatterns, freshRelations, freshStrategies] = await Promise.all([
          sb.from("karel_semantic_entities").select("*").eq("user_id", userId),
          sb.from("karel_semantic_patterns").select("*").eq("user_id", userId),
          sb.from("karel_semantic_relations").select("*").eq("user_id", userId),
          sb.from("karel_strategies").select("*").eq("user_id", userId),
        ]);

        const driveWrites: Promise<void>[] = [];
        if (semanticId) {
          const [entityDoc, vzorceDoc, vztahyDoc] = await Promise.all([
            findDoc(token, "osoby", semanticId), findDoc(token, "vzorce", semanticId), findDoc(token, "vztahy", semanticId),
          ]);
          if (entityDoc) { driveWrites.push(updateDoc(token, entityDoc.id, formatEntities(freshEntities.data || []))); driveUpdates.push("SEMANTIC/osoby"); }
          if (vzorceDoc) { driveWrites.push(updateDoc(token, vzorceDoc.id, formatPatterns(freshPatterns.data || []))); driveUpdates.push("SEMANTIC/vzorce"); }
          if (vztahyDoc) { driveWrites.push(updateDoc(token, vztahyDoc.id, formatRelations(freshRelations.data || []))); driveUpdates.push("SEMANTIC/vztahy"); }
        }
        if (proceduralId) {
          const stratDoc = await findDoc(token, "strategi", proceduralId);
          if (stratDoc) { driveWrites.push(updateDoc(token, stratDoc.id, formatStrategies(freshStrategies.data || []))); driveUpdates.push("PROCEDURAL/strategie"); }
        }
        if (episodesId) {
          const files = await listAllFilesRecursive(token, episodesId, "");
          const epDoc = files.find(f => !f.isFolder);
          if (epDoc) { driveWrites.push(updateDoc(token, epDoc.id, formatEpisodes(episodes.slice(0, 100)))); driveUpdates.push("EPISODES/index"); }
        }
        await Promise.all(driveWrites);
      }

      // KARTOTEKA_DID: append to existing cards (KHASH dedup)
      if (partUpdates.length > 0) {
        const kartotekaId = await findFolderFuzzy(token, ["kartoteka_DID", "Kartoteka_DID", "KARTOTEKA_DID"]);
        if (kartotekaId) {
          for (const [partName, content] of Object.entries(extractedInfo.kartoteka_did.part_updates)) {
            if (!content || typeof content !== "string") continue;
            const hash = contentHash(content);
            const searchQ = `name contains '${partName}' and trashed=false and mimeType!='application/vnd.google-apps.folder'`;
            const params = new URLSearchParams({ q: searchQ, fields: "files(id,name)", pageSize: "5", supportsAllDrives: "true", includeItemsFromAllDrives: "true" });
            const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, { headers: { Authorization: `Bearer ${token}` } });
            const data = await res.json();
            const partDoc = data.files?.[0];
            if (partDoc) {
              const existing = await readDoc(token, partDoc.id);
              if (existing.includes(`[KHASH:${hash}]`)) {
                driveUpdates.push(`KARTOTEKA/${partName} (dedup)`);
                continue;
              }
              await updateDoc(token, partDoc.id, `${existing}\n\n═══ Karel – zrcadlení (${new Date().toISOString().slice(0, 10)}) [KHASH:${hash}] ═══\n${content}`);
              driveUpdates.push(`KARTOTEKA/${partName}`);
            }
          }
        }
      }

      // KARTOTEKA_DID: Create NEW parts via drive-write
      if (newParts.length > 0) {
        console.log(`[mirror] Creating ${newParts.length} new parts`);
        const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
        const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
        for (const part of newParts) {
          if (!part.name || !part.sections) continue;
          try {
            const writeRes = await fetch(`${supabaseUrl}/functions/v1/karel-did-drive-write`, {
              method: "POST",
              headers: { "Content-Type": "application/json", Authorization: `Bearer ${serviceRoleKey}` },
              body: JSON.stringify({ mode: "update-card-sections", partName: part.name, sections: part.sections }),
            });
            const writeResult = await writeRes.json();
            if (writeRes.ok && writeResult.success) {
              driveUpdates.push(`KARTOTEKA/NEW:${part.name}`);
              await sb.from("did_part_registry").upsert({
                user_id: userId, part_name: part.name, display_name: part.name,
                status: part.status === "Aktivní" ? "active" : "sleeping",
                cluster: part.cluster || null,
                notes: `Auto-mirror ${new Date().toISOString().slice(0, 10)}. ${part.inferred_data || ""}`.slice(0, 500),
                role_in_system: part.sections?.A?.slice(0, 200) || null,
              }, { onConflict: "user_id,part_name", ignoreDuplicates: true });
              dbUpdates.push(`registry_new:${part.name}`);
            } else {
              driveUpdates.push(`KARTOTEKA/NEW:${part.name} (ERR:${writeResult.error})`);
            }
          } catch (e) {
            driveUpdates.push(`KARTOTEKA/NEW:${part.name} (ERR:${e instanceof Error ? e.message : 'unknown'})`);
          }
        }
      }

      // KARTOTEKA_DID/00_CENTRUM: Update Dashboard, Geography, Relationships
      if (extractedInfo.centrum_updates) {
        const kartotekaId = await findFolderFuzzy(token, ["kartoteka_DID", "Kartoteka_DID", "KARTOTEKA_DID"]);
        if (kartotekaId) {
          const centrumId = await findFolder(token, "00_CENTRUM", kartotekaId);
          if (centrumId) {
            const cu = extractedInfo.centrum_updates;
            const centrumWrites: Array<{ pattern: string; content: string; label: string }> = [];
            if (cu.dashboard_notes) centrumWrites.push({ pattern: "Dashboard", content: cu.dashboard_notes, label: "Dashboard" });
            if (cu.geography_notes) centrumWrites.push({ pattern: "Geografie", content: cu.geography_notes, label: "Geografie" });
            if (cu.relationships_notes) centrumWrites.push({ pattern: "Vztah", content: cu.relationships_notes, label: "Mapa_Vztahu" });
            if (cu.operative_plan_notes) centrumWrites.push({ pattern: "Operativn", content: cu.operative_plan_notes, label: "Operativni_Plan" });

            for (const { pattern, content, label } of centrumWrites) {
              const hash = contentHash(content);
              const doc = await findDoc(token, pattern, centrumId);
              if (doc) {
                const existing = await readDoc(token, doc.id);
                if (!existing.includes(`[KHASH:${hash}]`)) {
                  await updateDoc(token, doc.id, `${existing}\n\n═══ Karel – zrcadlení (${new Date().toISOString().slice(0, 10)}) [KHASH:${hash}] ═══\n${content}`);
                  driveUpdates.push(`CENTRUM/${label}`);
                }
              }
            }
          }
        }
      }

      // ZALOHA: append to client files
      if (extractedInfo.zaloha?.client_updates) {
        const zalohaId = await findFolderFuzzy(token, ["ZALOHA", "Zaloha"]);
        if (zalohaId) {
          for (const [clientName, content] of Object.entries(extractedInfo.zaloha.client_updates)) {
            if (!content || typeof content !== "string") continue;
            const hash = contentHash(content);
            const clientDoc = await findDoc(token, clientName, zalohaId);
            if (clientDoc) {
              const existing = await readDoc(token, clientDoc.id);
              if (!existing.includes(`[KHASH:${hash}]`)) {
                await updateDoc(token, clientDoc.id, `${existing}\n\n═══ Karel – zrcadlení (${new Date().toISOString().slice(0, 10)}) [KHASH:${hash}] ═══\n${content}`);
                driveUpdates.push(`ZALOHA/${clientName}`);
              }
            }
          }
        }
      }
    } catch (driveErr) {
      console.error("[mirror] Drive write error:", driveErr);
      driveUpdates.push(`ERROR: ${driveErr instanceof Error ? driveErr.message : "unknown"}`);
    }

    // ═══ PHASE 7: Release lock & Log ═══
    const totalTime = Date.now() - startTime;
    if (lockId) await sb.from("karel_memory_logs").update({ summary: `Lock released ${totalTime}ms` }).eq("id", lockId);

    const synthesisSum = extractedInfo.synthesis_summary || extractedInfo.summary || `Mirror: ${dbUpdates.length} DB, ${driveUpdates.length} Drive`;

    await sb.from("karel_memory_logs").insert({
      user_id: userId, log_type: "redistribute",
      summary: synthesisSum,
      episodes_created: 0,
      semantic_updates: dbUpdates.filter((u: string) => u.startsWith("entity") || u.startsWith("pattern") || u.startsWith("relation")).length,
      strategy_updates: dbUpdates.filter((u: string) => u.startsWith("strategy")).length,
      details: {
        totalMs: totalTime, scope: lastMirrorTime,
        threadsScanned: threadDigests.length, driveDocsRead,
        pass1_facts: pass1Data.raw_facts?.length || 0,
        pass1_names: pass1Data.all_names_mentioned?.length || 0,
        pass1_urgent: pass1Data.urgent_signals || [],
        newPartsCreated: newParts.length,
        newTasksCreated: newTasks.length,
        dbUpdates, driveUpdates,
      },
    });

    console.log(`[mirror] ═══ DONE in ${totalTime}ms. Threads:${threadDigests.length} DriveDocs:${driveDocsRead} DB:${dbUpdates.length} Drive:${driveUpdates.length} Tasks:${newTasks.length}`);

    return new Response(JSON.stringify({
      status: "ok",
      summary: synthesisSum,
      counts: {
        threadsScanned: threadDigests.length,
        driveDocsRead,
        dbUpdates: dbUpdates.length,
        driveUpdates: driveUpdates.length,
        newParts: newParts.length,
        newTasks: newTasks.length,
        factsExtracted: pass1Data.raw_facts?.length || 0,
        urgentSignals: pass1Data.urgent_signals?.length || 0,
      },
      urgentSignals: pass1Data.urgent_signals || [],
      therapistObservations: pass1Data.therapist_observations || {},
      motivationUpdates: extractedInfo.motivation_updates || {},
      dbUpdates, driveUpdates,
      totalMs: totalTime,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (error) {
    console.error("[mirror] Error:", error);
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

// ── Formatters ──
function formatEntities(entities: any[]): string {
  const lines = ["SÉMANTICKÉ ENTITY KARLA", `Aktualizováno: ${new Date().toISOString()}`, `Počet: ${entities.length}`, ""];
  for (const e of entities) {
    lines.push(`${e.jmeno} (${e.typ})`);
    lines.push(`Role vůči Hance: ${e.role_vuci_hance || "–"}`);
    if (e.stabilni_vlastnosti?.length) lines.push(`Vlastnosti: ${e.stabilni_vlastnosti.join(", ")}`);
    if (e.notes) lines.push(`Poznámky: ${e.notes}`);
    lines.push("");
  }
  return lines.join("\n");
}

function formatPatterns(patterns: any[]): string {
  const lines = ["VZORCE CHOVÁNÍ", `Aktualizováno: ${new Date().toISOString()}`, `Počet: ${patterns.length}`, ""];
  for (const p of patterns) {
    lines.push(`${p.id}`);
    lines.push(`Popis: ${p.description}`);
    lines.push(`Doména: ${p.domain} | Confidence: ${p.confidence}`);
    if (p.tags?.length) lines.push(`Tagy: ${p.tags.join(", ")}`);
    lines.push("");
  }
  return lines.join("\n");
}

function formatRelations(relations: any[]): string {
  const lines = ["SÉMANTICKÉ VZTAHY", `Aktualizováno: ${new Date().toISOString()}`, `Počet: ${relations.length}`, ""];
  for (const r of relations) {
    lines.push(`${r.subject_id} → [${r.relation}] → ${r.object_id} (confidence: ${r.confidence})`);
    if (r.description) lines.push(`  Popis: ${r.description}`);
  }
  return lines.join("\n");
}

function formatStrategies(strategies: any[]): string {
  const lines = ["STRATEGIE INTERAKCE", `Aktualizováno: ${new Date().toISOString()}`, `Počet: ${strategies.length}`, ""];
  for (const s of strategies) {
    lines.push(`${s.id}`);
    lines.push(`Popis: ${s.description}`);
    lines.push(`Doména: ${s.domain} | Stav: ${s.hana_state} | Efektivita: ${s.effectiveness_score}`);
    if (s.guidelines?.length) for (const g of s.guidelines) lines.push(`  - ${g}`);
    lines.push("");
  }
  return lines.join("\n");
}

function formatEpisodes(episodes: any[]): string {
  const lines = ["EPIZODICKÁ PAMĚŤ", `Aktualizováno: ${new Date().toISOString()}`, `Počet: ${episodes.length}`, ""];
  for (const ep of episodes) {
    lines.push(`[${ep.timestamp_start}] ${ep.summary_karel}`);
    lines.push(`Doména: ${ep.domain} | Stav: ${ep.hana_state} | Intenzita: ${ep.emotional_intensity}`);
    if (ep.tags?.length) lines.push(`Tagy: ${ep.tags.join(", ")}`);
    lines.push("");
  }
  return lines.join("\n");
}
