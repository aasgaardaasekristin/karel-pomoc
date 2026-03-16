/// <reference types="https://esm.sh/@supabase/functions-js/src/edge-runtime.d.ts" />
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/auth.ts";

/**
 * Karel Memory Redistribute – Inteligentní zrcadlení do Drive
 * 
 * Skenuje VŠECHNA vlákna ze všech režimů, extrahuje nosné informace
 * a redistribuuje je do správných složek na Drive:
 * - PAMET_KAREL (entity, vzorce, strategie)
 * - KARTOTEKA_DID (karty částí)
 * - ZALOHA (klienti)
 * 
 * Zároveň aktualizuje DB paměťové tabulky.
 * 
 * DEDUP GUARDS:
 * 1. Content hash markers [KHASH:xxxx] v Drive dokumentech – skip pokud hash existuje
 * 2. Concurrency lock přes karel_memory_logs – jen 1 redistribute najednou
 * 3. DB upsert s deduplikací entit/vzorců na základě ID/jména
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

async function listDocsInFolder(token: string, folderId: string): Promise<Array<{ id: string; name: string }>> {
  const q = `'${folderId}' in parents and trashed=false and mimeType!='application/vnd.google-apps.folder'`;
  const params = new URLSearchParams({ q, fields: "files(id,name)", pageSize: "50", supportsAllDrives: "true", includeItemsFromAllDrives: "true" });
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  return data.files || [];
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
    // ═══ CONCURRENCY LOCK: insert-first-then-check (atomic) ═══
    // Insert lock FIRST, then check if another lock already exists.
    // This eliminates the race condition where two requests both see "no lock" simultaneously.
    const LOCK_MINUTES = 3;
    const { data: lockRow } = await sb.from("karel_memory_logs").insert({
      user_id: userId,
      log_type: "redistribute_lock",
      summary: "Lock acquired",
    }).select("id, created_at").single();
    const lockId = lockRow?.id;

    // Now check: are there OTHER locks within the window?
    const lockCutoff = new Date(Date.now() - LOCK_MINUTES * 60 * 1000).toISOString();
    const { data: allLocks } = await sb.from("karel_memory_logs")
      .select("id, created_at")
      .eq("user_id", userId)
      .eq("log_type", "redistribute_lock")
      .gte("created_at", lockCutoff)
      .order("created_at", { ascending: true });

    // If there's an older lock that isn't ours, we're the duplicate – bail out
    const olderLock = allLocks?.find(l => l.id !== lockId && l.created_at <= (lockRow?.created_at || ""));
    if (olderLock) {
      console.log("[redistribute] Skipping – another redistribute owns the lock (id:", olderLock.id, ")");
      // Clean up our lock attempt
      await sb.from("karel_memory_logs").delete().eq("id", lockId);
      return new Response(JSON.stringify({
        status: "skipped",
        reason: "Redistribuce již probíhá. Zkus to za chvíli.",
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    console.log("[redistribute] Starting for user:", userId);
    const startTime = Date.now();

    // ═══ PHASE 1: Load ALL threads from ALL modes ═══
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const [hanaRes, didThreadsRes, didConvsRes, researchRes, episodesRes, entitiesRes, patternsRes, relationsRes, strategiesRes] = await Promise.all([
      sb.from("karel_hana_conversations").select("id, messages, last_activity_at, current_domain").eq("user_id", userId).gte("last_activity_at", sevenDaysAgo).order("last_activity_at", { ascending: false }).limit(20),
      sb.from("did_threads").select("id, part_name, messages, last_activity_at, sub_mode").eq("user_id", userId).gte("last_activity_at", sevenDaysAgo).order("last_activity_at", { ascending: false }).limit(20),
      sb.from("did_conversations").select("id, label, messages, sub_mode, preview").eq("user_id", userId).gte("saved_at", sevenDaysAgo).order("saved_at", { ascending: false }).limit(20),
      sb.from("research_threads").select("id, topic, messages, last_activity_at").eq("user_id", userId).eq("is_deleted", false).gte("last_activity_at", sevenDaysAgo).limit(10),
      sb.from("karel_episodes").select("*").eq("user_id", userId).eq("is_archived", false).order("timestamp_start", { ascending: false }).limit(200),
      sb.from("karel_semantic_entities").select("*").eq("user_id", userId),
      sb.from("karel_semantic_patterns").select("*").eq("user_id", userId),
      sb.from("karel_semantic_relations").select("*").eq("user_id", userId),
      sb.from("karel_strategies").select("*").eq("user_id", userId),
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

    // Build thread digest for AI analysis
    const allThreadsDigest: string[] = [];

    for (const conv of hanaConvs) {
      const msgs = Array.isArray(conv.messages) ? conv.messages : [];
      if (msgs.length < 2) continue;
      const excerpt = msgs.slice(-10).map((m: any) => `${m.role}: ${typeof m.content === 'string' ? m.content.slice(0, 300) : '[media]'}`).join("\n");
      allThreadsDigest.push(`[HANA | ${conv.last_activity_at?.slice(0, 10)} | ${conv.current_domain}]\n${excerpt}`);
    }

    for (const t of didThreads) {
      const msgs = Array.isArray(t.messages) ? t.messages : [];
      if (msgs.length < 2) continue;
      const excerpt = msgs.slice(-8).map((m: any) => `${m.role}: ${typeof m.content === 'string' ? m.content.slice(0, 250) : '[media]'}`).join("\n");
      allThreadsDigest.push(`[DID | ${t.part_name} | ${t.sub_mode} | ${t.last_activity_at?.slice(0, 10)}]\n${excerpt}`);
    }

    for (const c of didConvs) {
      const msgs = Array.isArray(c.messages) ? c.messages : [];
      if (msgs.length < 2) continue;
      const excerpt = msgs.slice(-6).map((m: any) => `${m.role}: ${typeof m.content === 'string' ? m.content.slice(0, 200) : '[media]'}`).join("\n");
      allThreadsDigest.push(`[DID_CONV | ${c.label} | ${c.sub_mode}]\n${excerpt}`);
    }

    for (const r of researchThreads) {
      const msgs = Array.isArray(r.messages) ? r.messages : [];
      if (msgs.length < 2) continue;
      const excerpt = msgs.slice(-4).map((m: any) => `${m.role}: ${typeof m.content === 'string' ? m.content.slice(0, 200) : '[media]'}`).join("\n");
      allThreadsDigest.push(`[RESEARCH | ${r.topic}]\n${excerpt}`);
    }

    if (allThreadsDigest.length === 0) {
      // Nothing to redistribute — still update PAMET_KAREL with current DB state
      console.log("[redistribute] No recent threads, updating PAMET_KAREL with current DB state");
    }

    // ═══ PHASE 2: AI Extraction & Classification ═══
    let extractedInfo: any = { pamet_karel: {}, kartoteka_did: {}, zaloha: {}, new_entities: [], new_patterns: [], new_strategies: [] };

    // Load DID part registry for cross-referencing
    const { data: registryParts } = await sb.from("did_part_registry").select("part_name, display_name, status").eq("user_id", userId);
    const knownPartNames = (registryParts || []).map((p: any) => p.part_name || p.display_name);

    if (allThreadsDigest.length > 0) {
      const extractionPrompt = `Jsi analytický modul Karla. Analyzuj VŠECHNA vlákna konverzací a extrahuj nosné informace pro redistribuci do perzistentních složek.

PRAVIDLA:
- Extrahuj POUZE skutečně nosné, nové informace (ne small-talk, ne opakování známého)
- Klasifikuj každou informaci do správné cílové složky
- Identifikuj nové entity, vzorce a strategie
- NIKDY nevymýšlej informace
- KRITICKÉ: Pokud Hana/uživatelka žádá o zapsání NOVÝCH částí/fragmentů, které ještě nemají kartu, MUSÍŠ je extrahovat do "new_parts"!

CÍLOVÉ SLOŽKY:
1. PAMET_KAREL → osobní paměť Karla (entity, vztahy, vzorce, strategie interakce s Hankou)
2. KARTOTEKA_DID → karty částí DID systému (nové poznatky o konkrétních částech)
3. ZALOHA → pracovní klienti (nové poznatky z klinické práce)

STÁVAJÍCÍ ENTITY: ${entities.map((e: any) => `${e.id}:${e.jmeno}`).join(", ") || "žádné"}
STÁVAJÍCÍ VZORCE: ${patterns.map((p: any) => p.id).join(", ") || "žádné"}
EXISTUJÍCÍ ČÁSTI V KARTOTÉCE: ${knownPartNames.join(", ") || "žádné"}

VLÁKNA K ANALÝZE:
${allThreadsDigest.join("\n═══════\n")}

Vrať POUZE validní JSON:
{
  "pamet_karel": {
    "entity_updates": [{"id": "existing_or_new_id", "jmeno": "...", "typ": "clovek|cast_did|klient", "role_vuci_hance": "...", "new_properties": ["..."], "new_notes": "..."}],
    "pattern_updates": [{"id": "existing_or_new_id", "description": "...", "domain": "HANA|DID|PRACE", "tags": ["..."], "confidence_delta": 0.1}],
    "relation_updates": [{"subject_id": "...", "relation": "...", "object_id": "...", "description": "..."}],
    "strategy_updates": [{"id": "existing_or_new_id", "description": "...", "domain": "...", "hana_state": "...", "effectiveness_delta": 0.1, "new_guidelines": ["..."]}]
  },
  "kartoteka_did": {
    "part_updates": {"existing_part_name": "text to append to their card"},
    "new_parts": [
      {
        "name": "jméno nové části/fragmentu",
        "sections": {
          "A": "Kdo jsem – popis identity, věk, role v systému",
          "B": "Charakter a psychologický profil",
          "C": "Potřeby, strachy, konflikty",
          "D": "Terapeutická doporučení",
          "E": "Chronologický log – co je známo z historie",
          "F": "Poznámky pro Karla",
          "H": "Dlouhodobé cíle"
        },
        "status": "Spící|Aktivní",
        "cluster": "název klastru pokud znám"
      }
    ]
  },
  "zaloha": {
    "client_updates": {"client_name_or_id": "text to append"}
  },
  "summary": "jednověté shrnutí co bylo nalezeno a redistribuováno"
}

DŮLEŽITÉ PRO new_parts:
- Zahrň POUZE části, které NEJSOU v seznamu "EXISTUJÍCÍ ČÁSTI V KARTOTÉCE"
- Pro každou novou část extrahuj VŠECHNY dostupné informace z vláken do příslušných sekcí A-M
- Pokud uživatelka zmínila historii části, vlož ji do sekce E
- Pokud zmínila charakter/vlastnosti, vlož do sekce B
- Pokud zmínila potřeby/strachy, vlož do sekce C
- Vyplň co nejvíce sekcí na základě dostupných informací`;

      const aiRes = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "google/gemini-2.5-flash",
          messages: [
            { role: "system", content: "Jsi analytický engine. Extrahuj a klasifikuj informace. Vrať pouze validní JSON." },
            { role: "user", content: extractionPrompt },
          ],
          temperature: 0.1,
        }),
      });

      if (aiRes.ok) {
        const aiData = await aiRes.json();
        const content = aiData.choices?.[0]?.message?.content || "";
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          try { extractedInfo = JSON.parse(jsonMatch[0]); } catch (e) { console.error("[redistribute] JSON parse error:", e); }
        }
      }
    }

    // ═══ PHASE 3: Apply DB updates ═══
    const dbUpdates: string[] = [];

    // Entity updates
    if (extractedInfo.pamet_karel?.entity_updates?.length) {
      for (const eu of extractedInfo.pamet_karel.entity_updates) {
        const existing = entities.find((e: any) => e.id === eu.id || e.jmeno === eu.jmeno);
        if (existing) {
          const newProps = [...new Set([...(existing.stabilni_vlastnosti || []), ...(eu.new_properties || [])])];
          const newNotes = existing.notes ? `${existing.notes}\n${eu.new_notes || ""}` : (eu.new_notes || "");
          await sb.from("karel_semantic_entities").update({
            stabilni_vlastnosti: newProps,
            notes: newNotes.slice(0, 5000),
            role_vuci_hance: eu.role_vuci_hance || existing.role_vuci_hance,
            updated_at: new Date().toISOString(),
          }).eq("id", existing.id).eq("user_id", userId);
          dbUpdates.push(`entity_update:${existing.jmeno}`);
        } else if (eu.jmeno) {
          await sb.from("karel_semantic_entities").insert({
            id: eu.id || eu.jmeno.toLowerCase().replace(/\s/g, "_"),
            user_id: userId,
            jmeno: eu.jmeno,
            typ: eu.typ || "clovek",
            role_vuci_hance: eu.role_vuci_hance || "",
            stabilni_vlastnosti: eu.new_properties || [],
            notes: eu.new_notes || "",
          });
          dbUpdates.push(`entity_new:${eu.jmeno}`);
        }
      }
    }

    // Pattern updates
    if (extractedInfo.pamet_karel?.pattern_updates?.length) {
      for (const pu of extractedInfo.pamet_karel.pattern_updates) {
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
            id: pu.id || `pat_${Date.now()}`,
            user_id: userId,
            description: pu.description,
            domain: pu.domain || "HANA",
            tags: pu.tags || [],
            confidence: 0.5,
          });
          dbUpdates.push(`pattern_new:${pu.id}`);
        }
      }
    }

    // Strategy updates
    if (extractedInfo.pamet_karel?.strategy_updates?.length) {
      for (const su of extractedInfo.pamet_karel.strategy_updates) {
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
            id: su.id || `str_${Date.now()}`,
            user_id: userId,
            description: su.description,
            domain: su.domain || "HANA",
            hana_state: su.hana_state || "",
            guidelines: su.new_guidelines || [],
            effectiveness_score: 0.5,
          });
          dbUpdates.push(`strategy_new:${su.id}`);
        }
      }
    }

    // Relation updates
    if (extractedInfo.pamet_karel?.relation_updates?.length) {
      for (const ru of extractedInfo.pamet_karel.relation_updates) {
        const existing = relations.find((r: any) => r.subject_id === ru.subject_id && r.object_id === ru.object_id && r.relation === ru.relation);
        if (!existing && ru.subject_id && ru.object_id) {
          await sb.from("karel_semantic_relations").insert({
            user_id: userId,
            subject_id: ru.subject_id,
            relation: ru.relation,
            object_id: ru.object_id,
            description: ru.description || "",
          });
          dbUpdates.push(`relation_new:${ru.subject_id}->${ru.object_id}`);
        }
      }
    }

    // ═══ PHASE 4: Drive redistribution ═══
    const driveUpdates: string[] = [];
    try {
      const token = await getAccessToken();

      // PAMET_KAREL: update semantic files with fresh DB data
      const pametId = await findFolder(token, "PAMET_KAREL");
      if (pametId) {
        const semanticId = await findFolder(token, "PAMET_KAREL_SEMANTIC", pametId);
        const proceduralId = await findFolder(token, "PAMET_KAREL_PROCEDURAL", pametId);
        const episodesId = await findFolder(token, "PAMET_KAREL_EPISODES", pametId);

        // Re-read updated entities/patterns/etc
        const [freshEntities, freshPatterns, freshRelations, freshStrategies] = await Promise.all([
          sb.from("karel_semantic_entities").select("*").eq("user_id", userId),
          sb.from("karel_semantic_patterns").select("*").eq("user_id", userId),
          sb.from("karel_semantic_relations").select("*").eq("user_id", userId),
          sb.from("karel_strategies").select("*").eq("user_id", userId),
        ]);

        const driveWrites: Promise<void>[] = [];

        if (semanticId) {
          const entityDoc = await findDoc(token, "osoby", semanticId);
          const vzorceDoc = await findDoc(token, "vzorce", semanticId);
          const vztahyDoc = await findDoc(token, "vztahy", semanticId);
          if (entityDoc) { driveWrites.push(updateDoc(token, entityDoc.id, formatEntities(freshEntities.data || []))); driveUpdates.push("SEMANTIC/osoby"); }
          if (vzorceDoc) { driveWrites.push(updateDoc(token, vzorceDoc.id, formatPatterns(freshPatterns.data || []))); driveUpdates.push("SEMANTIC/vzorce"); }
          if (vztahyDoc) { driveWrites.push(updateDoc(token, vztahyDoc.id, formatRelations(freshRelations.data || []))); driveUpdates.push("SEMANTIC/vztahy"); }
        }
        if (proceduralId) {
          const stratDoc = await findDoc(token, "strategi", proceduralId);
          if (stratDoc) { driveWrites.push(updateDoc(token, stratDoc.id, formatStrategies(freshStrategies.data || []))); driveUpdates.push("PROCEDURAL/strategie"); }
        }
        if (episodesId) {
          const epDoc = await findDoc(token, "", episodesId); // any doc
          if (!epDoc) {
            const files = await listDocsInFolder(token, episodesId);
            if (files[0]) {
              driveWrites.push(updateDoc(token, files[0].id, formatEpisodes(episodes.slice(0, 100))));
              driveUpdates.push("EPISODES/index");
            }
          } else {
            driveWrites.push(updateDoc(token, epDoc.id, formatEpisodes(episodes.slice(0, 100))));
            driveUpdates.push("EPISODES/index");
          }
        }

        await Promise.all(driveWrites);
      }

      // KARTOTEKA_DID: append to part cards (with hash dedup)
      if (extractedInfo.kartoteka_did?.part_updates && Object.keys(extractedInfo.kartoteka_did.part_updates).length > 0) {
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
              // DEDUP: check if this hash already exists in the document
              if (existing.includes(`[KHASH:${hash}]`)) {
                console.log(`[redistribute] DEDUP: skipping ${partName} – hash ${hash} already present`);
                driveUpdates.push(`KARTOTEKA/${partName} (dedup-skip)`);
                continue;
              }
              const updated = `${existing}\n\n═══ Karel – automatická redistribuce (${new Date().toISOString().slice(0, 10)}) [KHASH:${hash}] ═══\n${content}`;
              await updateDoc(token, partDoc.id, updated);
              driveUpdates.push(`KARTOTEKA/${partName}`);
            }
          }
        }
      }

      // ZALOHA: append to client files (with hash dedup)
      if (extractedInfo.zaloha?.client_updates && Object.keys(extractedInfo.zaloha.client_updates).length > 0) {
        const zalohaId = await findFolderFuzzy(token, ["ZALOHA", "Zaloha"]);
        if (zalohaId) {
          for (const [clientName, content] of Object.entries(extractedInfo.zaloha.client_updates)) {
            if (!content || typeof content !== "string") continue;
            const hash = contentHash(content);
            const clientDoc = await findDoc(token, clientName, zalohaId);
            if (clientDoc) {
              const existing = await readDoc(token, clientDoc.id);
              // DEDUP: check if this hash already exists in the document
              if (existing.includes(`[KHASH:${hash}]`)) {
                console.log(`[redistribute] DEDUP: skipping ${clientName} – hash ${hash} already present`);
                driveUpdates.push(`ZALOHA/${clientName} (dedup-skip)`);
                continue;
              }
              const updated = `${existing}\n\n═══ Karel – redistribuce (${new Date().toISOString().slice(0, 10)}) [KHASH:${hash}] ═══\n${content}`;
              await updateDoc(token, clientDoc.id, updated);
              driveUpdates.push(`ZALOHA/${clientName}`);
            }
          }
        }
      }
    } catch (driveErr) {
      console.error("[redistribute] Drive error:", driveErr);
      driveUpdates.push(`ERROR: ${driveErr instanceof Error ? driveErr.message : "unknown"}`);
    }

    // ═══ PHASE 5: Release lock & Log ═══
    const totalTime = Date.now() - startTime;
    const dedupSkips = driveUpdates.filter(u => u.includes("dedup-skip")).length;

    // Release concurrency lock
    if (lockId) {
      await sb.from("karel_memory_logs").update({ summary: `Lock released after ${totalTime}ms` }).eq("id", lockId);
    }

    await sb.from("karel_memory_logs").insert({
      user_id: userId,
      log_type: "redistribute",
      summary: extractedInfo.summary || `Redistribuce: ${dbUpdates.length} DB, ${driveUpdates.length} Drive, ${dedupSkips} dedup-skip`,
      episodes_created: 0,
      semantic_updates: dbUpdates.filter((u: string) => u.startsWith("entity") || u.startsWith("pattern") || u.startsWith("relation")).length,
      strategy_updates: dbUpdates.filter((u: string) => u.startsWith("strategy")).length,
      details: {
        totalMs: totalTime,
        threadsScanned: hanaConvs.length + didThreads.length + didConvs.length + researchThreads.length,
        dbUpdates,
        driveUpdates,
        dedupSkips,
      },
    });

    console.log(`[redistribute] Done in ${totalTime}ms. DB: ${dbUpdates.length}, Drive: ${driveUpdates.length}, Dedup skips: ${dedupSkips}`);

    return new Response(JSON.stringify({
      status: "ok",
      summary: extractedInfo.summary || "Redistribuce dokončena",
      counts: {
        threadsScanned: hanaConvs.length + didThreads.length + didConvs.length + researchThreads.length,
        dbUpdates: dbUpdates.length,
        driveUpdates: driveUpdates.length,
        dedupSkips,
        entities: (entitiesRes.data || []).length,
        patterns: (patternsRes.data || []).length,
      },
      dbUpdates,
      driveUpdates,
      totalMs: totalTime,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (error) {
    console.error("[redistribute] Error:", error);
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
