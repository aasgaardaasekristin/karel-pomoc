/// <reference types="https://esm.sh/@supabase/functions-js/src/edge-runtime.d.ts" />
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireAuth, corsHeaders } from "../_shared/auth.ts";

// ── OAuth2 token helper ──
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

// ── Drive helpers (READ-ONLY structure, never create) ──
const FOLDER_MIME = "application/vnd.google-apps.folder";

async function findFolder(token: string, name: string, parentId?: string): Promise<string | null> {
  let q = `name='${name}' and mimeType='${FOLDER_MIME}' and trashed=false`;
  if (parentId) q += ` and '${parentId}' in parents`;
  const params = new URLSearchParams({
    q, fields: "files(id)", pageSize: "5",
    supportsAllDrives: "true", includeItemsFromAllDrives: "true",
  });
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  return data.files?.[0]?.id || null;
}

async function findDoc(token: string, name: string, parentId: string): Promise<string | null> {
  const q = `name contains '${name}' and '${parentId}' in parents and trashed=false`;
  const params = new URLSearchParams({
    q, fields: "files(id,name)", pageSize: "10",
    supportsAllDrives: "true", includeItemsFromAllDrives: "true",
  });
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  console.log(`[mirror] findDoc('${name}', parent=${parentId}): found ${JSON.stringify(data.files?.map((f: any) => f.name))}`);
  return data.files?.[0]?.id || null;
}

async function updateDoc(token: string, docId: string, content: string): Promise<void> {
  const boundary = "===memory_mirror_boundary===";
  const body = [
    `--${boundary}`,
    "Content-Type: application/json; charset=UTF-8",
    "",
    JSON.stringify({}),
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "",
    content,
    `--${boundary}--`,
  ].join("\r\n");

  const res = await fetch(
    `https://www.googleapis.com/upload/drive/v3/files/${docId}?uploadType=multipart&supportsAllDrives=true`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body,
    }
  );
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Failed to update doc ${docId}: ${err}`);
  }
}

// ── Formatters ──
function formatEntities(entities: any[]): string {
  const lines = ["SÉMANTICKÉ ENTITY KARLA", `Aktualizováno: ${new Date().toISOString()}`, `Počet: ${entities.length}`, ""];
  for (const e of entities) {
    lines.push(`${e.jmeno} (${e.typ})`);
    lines.push(`Role vůči Hance: ${e.role_vuci_hance || "–"}`);
    if (e.stabilni_vlastnosti?.length) lines.push(`Vlastnosti: ${e.stabilni_vlastnosti.join(", ")}`);
    if (e.notes) lines.push(`Poznámky: ${e.notes}`);
    lines.push(`Epizody: ${e.evidence_episodes?.length || 0}`);
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
    lines.push(`Epizody: ${p.evidence_episodes?.length || 0}`);
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
    lines.push(`Doména: ${s.domain} | Stav Hany: ${s.hana_state} | Efektivita: ${s.effectiveness_score}`);
    if (s.guidelines?.length) {
      lines.push("Pokyny:");
      for (const g of s.guidelines) lines.push(`  - ${g}`);
    }
    if (s.example_phrases?.length) {
      lines.push("Příkladové fráze:");
      for (const p of s.example_phrases) lines.push(`  - "${p}"`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function formatEpisodes(episodes: any[]): string {
  const lines = ["EPIZODICKÁ PAMĚŤ", `Aktualizováno: ${new Date().toISOString()}`, `Počet: ${episodes.length}`, ""];
  for (const ep of episodes) {
    lines.push(`[${ep.timestamp_start}] ${ep.summary_karel}`);
    lines.push(`Doména: ${ep.domain} | Stav: ${ep.hana_state} | Intenzita: ${ep.emotional_intensity}`);
    if (ep.participants?.length) lines.push(`Účastníci: ${ep.participants.join(", ")}`);
    if (ep.derived_facts?.length) lines.push(`Fakta: ${ep.derived_facts.join("; ")}`);
    if (ep.tags?.length) lines.push(`Tagy: ${ep.tags.join(", ")}`);
    lines.push("");
  }
  return lines.join("\n");
}

function formatLogs(logs: any[]): string {
  const lines = ["PAMĚŤOVÉ LOGY", `Aktualizováno: ${new Date().toISOString()}`, `Počet: ${logs.length}`, ""];
  for (const l of logs) {
    lines.push(`[${l.created_at}] ${l.log_type}: ${l.summary}`);
    lines.push(`Epizody: ${l.episodes_created} | Sémantika: ${l.semantic_updates} | Strategie: ${l.strategy_updates}`);
    if (l.errors?.length) lines.push(`Chyby: ${l.errors.join("; ")}`);
    lines.push("");
  }
  return lines.join("\n");
}

// ── Document-to-folder mapping ──
// Root docs in PAMET_KAREL:
//   01_Entity, 02_Vzorce, 03_Vztahy, 04_Strategie
// Subfolder docs (summary index in each):
//   PAMET_KAREL_SEMANTIC → contains semantic detail
//   PAMET_KAREL_PROCEDURAL → contains strategies detail
//   PAMET_KAREL_EPISODES → contains episodes
//   PAMET_KAREL_LOGS → contains logs

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const sb = createClient(supabaseUrl, serviceKey);

    // Support both authenticated user and service-role (cron) calls
    let userId: string;
    const authHeader = req.headers.get("Authorization") || "";
    if (authHeader.includes(serviceKey)) {
      // Service role call (from cron/consolidation) – get first user with episodes
      const { data: users } = await sb.from("karel_episodes").select("user_id").limit(1);
      userId = users?.[0]?.user_id;
      if (!userId) {
        return new Response(JSON.stringify({ status: "no_users" }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    } else {
      const authResult = await requireAuth(req);
      if (authResult instanceof Response) return authResult;
      userId = authResult.user.id;
    }

    // Fetch all memory data in parallel
    const [entitiesRes, patternsRes, relationsRes, strategiesRes, episodesRes, logsRes] = await Promise.all([
      sb.from("karel_semantic_entities").select("*").eq("user_id", userId),
      sb.from("karel_semantic_patterns").select("*").eq("user_id", userId),
      sb.from("karel_semantic_relations").select("*").eq("user_id", userId),
      sb.from("karel_strategies").select("*").eq("user_id", userId),
      sb.from("karel_episodes").select("*").eq("user_id", userId).order("timestamp_start", { ascending: false }).limit(200),
      sb.from("karel_memory_logs").select("*").eq("user_id", userId).order("created_at", { ascending: false }).limit(50),
    ]);

    const entities = entitiesRes.data || [];
    const patterns = patternsRes.data || [];
    const relations = relationsRes.data || [];
    const strategies = strategiesRes.data || [];
    const episodes = episodesRes.data || [];
    const logs = logsRes.data || [];

    console.log(`[mirror] Data: ${entities.length} entities, ${patterns.length} patterns, ${relations.length} relations, ${strategies.length} strategies, ${episodes.length} episodes, ${logs.length} logs`);

    const token = await getAccessToken();

    // 1. Find root folder PAMET_KAREL (NEVER create)
    const rootId = await findFolder(token, "PAMET_KAREL");
    if (!rootId) {
      throw new Error("Složka PAMET_KAREL nebyla nalezena na Drive. Vytvořte ji prosím ručně.");
    }

    // 2. Find all subfolders (NEVER create)
    const [semanticFolderId, proceduralFolderId, episodesFolderId, logsFolderId] = await Promise.all([
      findFolder(token, "PAMET_KAREL_SEMANTIC", rootId),
      findFolder(token, "PAMET_KAREL_PROCEDURAL", rootId),
      findFolder(token, "PAMET_KAREL_EPISODES", rootId),
      findFolder(token, "PAMET_KAREL_LOGS", rootId),
    ]);

    const missingFolders: string[] = [];
    if (!semanticFolderId) missingFolders.push("PAMET_KAREL_SEMANTIC");
    if (!proceduralFolderId) missingFolders.push("PAMET_KAREL_PROCEDURAL");
    if (!episodesFolderId) missingFolders.push("PAMET_KAREL_EPISODES");
    if (!logsFolderId) missingFolders.push("PAMET_KAREL_LOGS");
    if (missingFolders.length) {
      throw new Error(`Chybějící podsložky v PAMET_KAREL: ${missingFolders.join(", ")}. Vytvořte je prosím ručně.`);
    }

    // 3. Find all existing docs (NEVER create)
    // DEBUG: List all files in root folder
    const listParams = new URLSearchParams({
      q: `'${rootId}' in parents and trashed=false`,
      fields: "files(id,name,mimeType)",
      pageSize: "50",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
    });
    const listRes = await fetch(`https://www.googleapis.com/drive/v3/files?${listParams}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const listData = await listRes.json();
    console.log(`[mirror] All files in PAMET_KAREL:`, JSON.stringify(listData.files));

    const [entityDocId, vzorceDocId, vztahyDocId, strategieDocId] = await Promise.all([
      findDoc(token, "01_Entity", rootId),
      findDoc(token, "02_Vzorce", rootId),
      findDoc(token, "03_Vztahy", rootId),
      findDoc(token, "04_Strategie", rootId),
    ]);

    const missingDocs: string[] = [];
    if (!entityDocId) missingDocs.push("01_Entity");
    if (!vzorceDocId) missingDocs.push("02_Vzorce");
    if (!vztahyDocId) missingDocs.push("03_Vztahy");
    if (!strategieDocId) missingDocs.push("04_Strategie");
    if (missingDocs.length) {
      throw new Error(`Chybějící dokumenty v PAMET_KAREL: ${missingDocs.join(", ")}. Vytvořte je prosím ručně.`);
    }

    // Also find docs in subfolders for detailed data
    // Look for any existing doc in each subfolder to update
    const [semanticDocId, proceduralDocId, episodesDocId, logsDocId] = await Promise.all([
      findFirstDoc(token, semanticFolderId!),
      findFirstDoc(token, proceduralFolderId!),
      findFirstDoc(token, episodesFolderId!),
      findFirstDoc(token, logsFolderId!),
    ]);

    // 4. Update all existing docs in parallel
    const updates: Promise<void>[] = [
      updateDoc(token, entityDocId!, formatEntities(entities)),
      updateDoc(token, vzorceDocId!, formatPatterns(patterns)),
      updateDoc(token, vztahyDocId!, formatRelations(relations)),
      updateDoc(token, strategieDocId!, formatStrategies(strategies)),
    ];

    // Update subfolder docs if they exist
    const subfolderResults: Record<string, string> = {};
    if (semanticDocId) {
      updates.push(updateDoc(token, semanticDocId, [formatEntities(entities), "\n---\n", formatPatterns(patterns), "\n---\n", formatRelations(relations)].join("\n")));
      subfolderResults.semantic = semanticDocId;
    }
    if (proceduralDocId) {
      updates.push(updateDoc(token, proceduralDocId, formatStrategies(strategies)));
      subfolderResults.procedural = proceduralDocId;
    }
    if (episodesDocId) {
      updates.push(updateDoc(token, episodesDocId, formatEpisodes(episodes)));
      subfolderResults.episodes = episodesDocId;
    }
    if (logsDocId) {
      updates.push(updateDoc(token, logsDocId, formatLogs(logs)));
      subfolderResults.logs = logsDocId;
    }

    await Promise.all(updates);

    console.log(`[mirror] Updated ${updates.length} docs in PAMET_KAREL`);

    return new Response(JSON.stringify({
      status: "ok",
      folder_id: rootId,
      root_docs: { entities: entityDocId, patterns: vzorceDocId, relations: vztahyDocId, strategies: strategieDocId },
      subfolder_docs: subfolderResults,
      counts: { entities: entities.length, patterns: patterns.length, relations: relations.length, strategies: strategies.length, episodes: episodes.length, logs: logs.length },
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (error) {
    console.error("[mirror] Error:", error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

// Find first Google Doc in a folder (for subfolder index docs)
async function findFirstDoc(token: string, folderId: string): Promise<string | null> {
  const q = `'${folderId}' in parents and mimeType='application/vnd.google-apps.document' and trashed=false`;
  const params = new URLSearchParams({
    q, fields: "files(id,name)", pageSize: "1",
    supportsAllDrives: "true", includeItemsFromAllDrives: "true",
  });
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  if (data.files?.[0]) {
    console.log(`[mirror] Found doc in subfolder: ${data.files[0].name} (${data.files[0].id})`);
  }
  return data.files?.[0]?.id || null;
}
