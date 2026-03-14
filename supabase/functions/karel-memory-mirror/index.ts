import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
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

// ── Drive helpers ──
const FOLDER_MIME = "application/vnd.google-apps.folder";
const DOC_MIME = "application/vnd.google-apps.document";

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

async function createFolder(token: string, name: string, parentId?: string): Promise<string> {
  const metadata: Record<string, unknown> = { name, mimeType: FOLDER_MIME };
  if (parentId) metadata.parents = [parentId];
  const res = await fetch("https://www.googleapis.com/drive/v3/files?supportsAllDrives=true", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(metadata),
  });
  const data = await res.json();
  if (!data.id) throw new Error(`Failed to create folder: ${JSON.stringify(data)}`);
  return data.id;
}

async function findDoc(token: string, name: string, parentId: string): Promise<string | null> {
  const q = `name='${name}' and '${parentId}' in parents and trashed=false`;
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

async function upsertDoc(token: string, name: string, folderId: string, content: string): Promise<string> {
  const existingId = await findDoc(token, name, folderId);

  if (existingId) {
    // Full overwrite of existing doc
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

    await fetch(
      `https://www.googleapis.com/upload/drive/v3/files/${existingId}?uploadType=multipart&supportsAllDrives=true`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": `multipart/related; boundary=${boundary}`,
        },
        body,
      }
    );
    return existingId;
  } else {
    // Create new Google Doc
    const boundary = "===memory_mirror_boundary===";
    const metadata = JSON.stringify({ name, mimeType: DOC_MIME, parents: [folderId] });
    const body = [
      `--${boundary}`,
      "Content-Type: application/json; charset=UTF-8",
      "",
      metadata,
      `--${boundary}`,
      "Content-Type: text/plain; charset=UTF-8",
      "",
      content,
      `--${boundary}--`,
    ].join("\r\n");

    const res = await fetch(
      `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": `multipart/related; boundary=${boundary}`,
        },
        body,
      }
    );
    const data = await res.json();
    if (!data.id) throw new Error(`Failed to create doc: ${JSON.stringify(data)}`);
    return data.id;
  }
}

// ── Formatters ──
function formatEntities(entities: any[]): string {
  const lines = ["# SÉMANTICKÉ ENTITY KARLA", `Aktualizováno: ${new Date().toISOString()}`, `Počet: ${entities.length}`, ""];
  for (const e of entities) {
    lines.push(`## ${e.jmeno} (${e.typ})`);
    lines.push(`Role vůči Hance: ${e.role_vuci_hance || "–"}`);
    if (e.stabilni_vlastnosti?.length) lines.push(`Vlastnosti: ${e.stabilni_vlastnosti.join(", ")}`);
    if (e.notes) lines.push(`Poznámky: ${e.notes}`);
    lines.push(`Epizody: ${e.evidence_episodes?.length || 0}`);
    lines.push("");
  }
  return lines.join("\n");
}

function formatPatterns(patterns: any[]): string {
  const lines = ["# VZORCE CHOVÁNÍ", `Aktualizováno: ${new Date().toISOString()}`, `Počet: ${patterns.length}`, ""];
  for (const p of patterns) {
    lines.push(`## ${p.id}`);
    lines.push(`Popis: ${p.description}`);
    lines.push(`Doména: ${p.domain} | Confidence: ${p.confidence}`);
    if (p.tags?.length) lines.push(`Tagy: ${p.tags.join(", ")}`);
    lines.push(`Epizody: ${p.evidence_episodes?.length || 0}`);
    lines.push("");
  }
  return lines.join("\n");
}

function formatRelations(relations: any[]): string {
  const lines = ["# SÉMANTICKÉ VZTAHY", `Aktualizováno: ${new Date().toISOString()}`, `Počet: ${relations.length}`, ""];
  for (const r of relations) {
    lines.push(`- ${r.subject_id} → [${r.relation}] → ${r.object_id} (confidence: ${r.confidence})`);
    if (r.description) lines.push(`  Popis: ${r.description}`);
  }
  return lines.join("\n");
}

function formatStrategies(strategies: any[]): string {
  const lines = ["# STRATEGIE INTERAKCE", `Aktualizováno: ${new Date().toISOString()}`, `Počet: ${strategies.length}`, ""];
  for (const s of strategies) {
    lines.push(`## ${s.id}`);
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

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const authResult = await requireAuth(req);
    if (authResult instanceof Response) return authResult;
    const userId = authResult.user.id;

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const sb = createClient(supabaseUrl, serviceKey);

    // Fetch all memory data
    const [entitiesRes, patternsRes, relationsRes, strategiesRes] = await Promise.all([
      sb.from("karel_semantic_entities").select("*").eq("user_id", userId),
      sb.from("karel_semantic_patterns").select("*").eq("user_id", userId),
      sb.from("karel_semantic_relations").select("*").eq("user_id", userId),
      sb.from("karel_strategies").select("*").eq("user_id", userId),
    ]);

    const entities = entitiesRes.data || [];
    const patterns = patternsRes.data || [];
    const relations = relationsRes.data || [];
    const strategies = strategiesRes.data || [];

    console.log(`[mirror] Data loaded: ${entities.length} entities, ${patterns.length} patterns, ${relations.length} relations, ${strategies.length} strategies`);

    // Get Drive token
    const token = await getAccessToken();

    // Find or create PAMET_KAREL folder
    let memFolderId = await findFolder(token, "PAMET_KAREL");
    if (!memFolderId) {
      memFolderId = await createFolder(token, "PAMET_KAREL");
      console.log(`[mirror] Created PAMET_KAREL folder: ${memFolderId}`);
    }

    // Upsert all 4 documents in parallel
    const results = await Promise.all([
      upsertDoc(token, "01_Entity", memFolderId, formatEntities(entities)),
      upsertDoc(token, "02_Vzorce", memFolderId, formatPatterns(patterns)),
      upsertDoc(token, "03_Vztahy", memFolderId, formatRelations(relations)),
      upsertDoc(token, "04_Strategie", memFolderId, formatStrategies(strategies)),
    ]);

    console.log(`[mirror] All 4 docs upserted: ${results.join(", ")}`);

    return new Response(JSON.stringify({
      status: "ok",
      folder_id: memFolderId,
      docs: {
        entities: results[0],
        patterns: results[1],
        relations: results[2],
        strategies: results[3],
      },
      counts: {
        entities: entities.length,
        patterns: patterns.length,
        relations: relations.length,
        strategies: strategies.length,
      },
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (error) {
    console.error("[mirror] Error:", error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
