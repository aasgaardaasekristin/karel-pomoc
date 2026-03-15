import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { corsHeaders } from "../_shared/auth.ts";

/**
 * Karel DID Memory Bootstrap
 * 
 * Jednorázové nasátí celé kartotéky z Google Drive do:
 * 1. did_part_registry (metadata částí)
 * 2. karel_semantic_entities (DID entity)
 * 
 * Fáze:
 * - "scan": Načte strukturu složek, vrátí seznam částí k zpracování
 * - "process_one": Zpracuje jednu kartu části — parse sekcí, upsert do registry + entities
 */

// ── OAuth2 ──
async function getAccessToken(): Promise<string> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: Deno.env.get("GOOGLE_CLIENT_ID")!,
      client_secret: Deno.env.get("GOOGLE_CLIENT_SECRET")!,
      refresh_token: Deno.env.get("GOOGLE_REFRESH_TOKEN")!,
      grant_type: "refresh_token",
    }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(`Token error: ${JSON.stringify(data)}`);
  return data.access_token;
}

// ── Drive helpers ──
async function findFolders(token: string, name: string, parentId?: string) {
  let q = `name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  if (parentId) q += ` and '${parentId}' in parents`;
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)&pageSize=20&supportsAllDrives=true&includeItemsFromAllDrives=true`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  return (await res.json()).files || [];
}

async function resolveKartotekaRoot(token: string): Promise<string | null> {
  for (const name of ["kartoteka_DID", "Kartoteka_DID", "Kartotéka_DID", "KARTOTEKA_DID"]) {
    const candidates = await findFolders(token, name);
    for (const c of candidates) {
      const centrum = await findFolders(token, "00_CENTRUM", c.id);
      if (centrum.length > 0) return c.id;
    }
    if (candidates[0]?.id) return candidates[0].id;
  }
  return null;
}

async function listFilesInFolder(token: string, folderId: string) {
  const q = `'${folderId}' in parents and trashed=false`;
  const allFiles: Array<{ id: string; name: string; mimeType?: string }> = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({ q, fields: "nextPageToken,files(id,name,mimeType)", pageSize: "200" });
    if (pageToken) params.set("pageToken", pageToken);
    const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json();
    allFiles.push(...(data.files || []));
    pageToken = data.nextPageToken;
  } while (pageToken);
  return allFiles;
}

async function readFileContent(token: string, fileId: string, mimeType?: string): Promise<string> {
  const isSheet = mimeType === "application/vnd.google-apps.spreadsheet";
  const isWorkspace = mimeType?.startsWith("application/vnd.google-apps.");

  if (isSheet) {
    const r = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/csv`, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error(`Export sheet fail: ${r.status}`);
    return r.text();
  }
  if (isWorkspace) {
    const r = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/plain`, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error(`Export doc fail: ${r.status}`);
    return r.text();
  }
  const r = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) {
    const fallback = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/plain`, { headers: { Authorization: `Bearer ${token}` } });
    if (!fallback.ok) throw new Error(`Read fail: ${fallback.status}`);
    return fallback.text();
  }
  return r.text();
}

// ── Card section parser ──
interface ParsedCard {
  partName: string;
  folderLabel: string;
  age?: string;
  status: string;
  cluster?: string;
  role?: string;
  language?: string;
  triggers: string[];
  strengths: string[];
  rawContent: string;
}

function parseCardContent(content: string, fileName: string, folderLabel: string): ParsedCard {
  // Extract part name from various naming patterns:
  // "028_ARTUR" → "Artur"
  // "Karta - Johann Ryba" → "Johann Ryba"
  // "DID_003_Karta_části_Tundrupek" → "Tundrupek"
  let partName = fileName;
  
  // Remove file extension
  partName = partName.replace(/\.(txt|md|doc|docx)$/i, "");
  
  // Pattern: "Karta - Name" or "Karta -Name"
  const kartaDashMatch = partName.match(/[Kk]arta\s*[-–—]\s*(.+)/);
  if (kartaDashMatch) {
    partName = kartaDashMatch[1].trim();
  }
  // Pattern: "DID_NNN_Karta_části_Name"
  else if (/DID_\d+_Karta/i.test(partName)) {
    partName = partName.replace(/^DID_\d+_Karta_[čc]ásti_?/i, "").replace(/_/g, " ").trim();
  }
  // Pattern: "028_ARTUR" (numbered folder)
  else {
    partName = partName.replace(/^\d+_?/, "");
  }
  
  // Capitalize first letter
  if (partName.length > 0) {
    partName = partName.charAt(0).toUpperCase() + partName.slice(1);
  }

  const card: ParsedCard = {
    partName,
    folderLabel,
    status: folderLabel.includes("ARCHIV") ? "archived" : folderLabel.includes("SPI") ? "sleeping" : "active",
    triggers: [],
    strengths: [],
    rawContent: content,
  };

  // Parse sections using regex
  const sectionB = content.match(/(?:^|\n)\s*B[.:)\s].*?(?:věk|age|stáří)[^\n]*[\s:]+(\d+[^\n]*)/i);
  if (sectionB) card.age = sectionB[1].trim();

  const sectionC = content.match(/(?:^|\n)\s*C[.:)\s].*?(?:klastr|cluster)[^\n]*[\s:]+([^\n]+)/i);
  if (sectionC) card.cluster = sectionC[1].trim();

  const sectionD = content.match(/(?:^|\n)\s*D[.:)\s].*?(?:role|funkce)[^\n]*[\s:]+([^\n]+)/i);
  if (sectionD) card.role = sectionD[1].trim();

  // Language detection
  const langMatch = content.match(/(?:jazyk|language)[^\n]*[\s:]+([^\n]+)/i);
  if (langMatch) {
    const lang = langMatch[1].trim().toLowerCase();
    card.language = lang.includes("en") ? "en" : lang.includes("de") ? "de" : "cs";
  }

  // Triggers (section G or anywhere)
  const triggerMatch = content.match(/(?:trigger|spouštěč)[^\n]*[\s:]+([^\n]+(?:\n(?!\s*[A-Z][.:)])[ \t]+[^\n]+)*)/i);
  if (triggerMatch) {
    card.triggers = triggerMatch[1].split(/[,;\n]/).map(t => t.trim()).filter(Boolean).slice(0, 10);
  }

  // Strengths (section H or TALENT lines)
  const talentLines = content.match(/TALENT\|[^\n]+/g);
  if (talentLines) {
    card.strengths = talentLines.map(l => {
      const parts = l.split("|");
      return parts[2]?.trim() || parts[0]?.trim() || "";
    }).filter(Boolean);
  }
  const strengthMatch = content.match(/(?:silné stránky|strengths|schopnosti)[^\n]*[\s:]+([^\n]+(?:\n(?!\s*[A-Z][.:)])[ \t]+[^\n]+)*)/i);
  if (strengthMatch && card.strengths.length === 0) {
    card.strengths = strengthMatch[1].split(/[,;\n]/).map(t => t.trim()).filter(Boolean).slice(0, 10);
  }

  return card;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  // Auth
  const authHeader = req.headers.get("Authorization") || "";
  const userClient = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } } }
  );
  const { data: { user }, error: authErr } = await userClient.auth.getUser();
  if (authErr || !user) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  let body: any = {};
  try { body = await req.json(); } catch { /* ok */ }

  const phase = body.phase || "scan";

  try {
    const token = await getAccessToken();
    const rootId = await resolveKartotekaRoot(token);
    if (!rootId) {
      return new Response(JSON.stringify({ error: "kartoteka_DID not found on Drive" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (phase === "scan") {
      // Scan all part folders and return list of cards to process
      const partFolders = ["01_AKTIVNI_FRAGMENTY", "02_SPICI", "03_ARCHIV"];
      const allCards: Array<{ fileId: string; fileName: string; folderLabel: string; mimeType?: string }> = [];

      for (const folderName of partFolders) {
        const folderId = await findFolders(token, folderName, rootId).then(f => f[0]?.id);
        if (!folderId) { console.log(`[bootstrap] Folder ${folderName} not found, skipping`); continue; }

        const items = await listFilesInFolder(token, folderId);
        const subfolders = items.filter(f => f.mimeType === "application/vnd.google-apps.folder");
        const directFiles = items.filter(f => f.mimeType !== "application/vnd.google-apps.folder");

        // Strategy A: Subfolders per part (e.g., "028_ARTUR/Karta_Artur.doc")
        console.log(`[bootstrap] ${folderName}: ${subfolders.length} subfolders, ${directFiles.length} direct files`);
        for (const subfolder of subfolders) {
          const files = await listFilesInFolder(token, subfolder.id);
          console.log(`[bootstrap] Subfolder ${subfolder.name} (mime: ${subfolder.mimeType}): ${files.length} files: ${files.map(f => f.name).join(', ')}`);
          const cardFile = files.find(f =>
            f.mimeType !== "application/vnd.google-apps.folder" &&
            (f.name.toLowerCase().includes("karta") || f.name.toLowerCase().includes(subfolder.name.toLowerCase().replace(/^\d+_?/, "")))
          ) || files.find(f => f.mimeType !== "application/vnd.google-apps.folder");

          if (cardFile) {
            allCards.push({
              fileId: cardFile.id,
              fileName: subfolder.name,
              folderLabel: folderName,
              mimeType: cardFile.mimeType,
            });
          }
        }

        // Strategy B: Flat files directly in folder
        for (const file of directFiles) {
          const nameLower = file.name.toLowerCase();
          // Skip templates
          if (nameLower.includes("sablon") || nameLower.includes("template")) continue;
          // Match "Karta" naming, OR numbered part files like "004_ARTHUR", "003_TUNDRUPEK"
          const isCardByName = nameLower.includes("karta");
          const isNumberedPart = /^\d+[_\-]/.test(file.name);
          if (isCardByName || isNumberedPart) {
            allCards.push({
              fileId: file.id,
              fileName: file.name,
              folderLabel: folderName,
              mimeType: file.mimeType,
            });
          }
        }
      }

      // Also scan root for direct card files (fallback for non-standard structures)
      const rootItems = await listFilesInFolder(token, rootId);
      for (const file of rootItems) {
        if (file.mimeType === "application/vnd.google-apps.folder") continue;
        const nameLower = file.name.toLowerCase();
        if (nameLower.includes("sablon") || nameLower.includes("template")) continue;
        if (nameLower.includes("karta") && nameLower.includes("did")) {
          // Avoid duplicates
          if (!allCards.some(c => c.fileId === file.id)) {
            allCards.push({
              fileId: file.id,
              fileName: file.name,
              folderLabel: "ROOT",
              mimeType: file.mimeType,
            });
          }
        }
      }

      console.log(`[bootstrap] Scan complete: ${allCards.length} cards found`);

      return new Response(JSON.stringify({ cards: allCards, total: allCards.length }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (phase === "process_one") {
      const { fileId, fileName, folderLabel, mimeType } = body;
      if (!fileId || !fileName) {
        return new Response(JSON.stringify({ error: "Missing fileId or fileName" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Read card content
      const content = await readFileContent(token, fileId, mimeType);
      const card = parseCardContent(content, fileName, folderLabel);

      console.log(`[bootstrap] Processing: ${card.partName} (${card.status}, folder: ${folderLabel})`);

      // Upsert into did_part_registry
      const { error: regErr } = await sb.from("did_part_registry").upsert({
        user_id: user.id,
        part_name: card.partName.toLowerCase(),
        display_name: card.partName,
        status: card.status,
        cluster: card.cluster || "",
        role_in_system: card.role || "",
        age_estimate: card.age || "",
        language: card.language || "cs",
        known_triggers: card.triggers,
        known_strengths: card.strengths,
        drive_folder_label: card.folderLabel,
        updated_at: new Date().toISOString(),
      }, { onConflict: "user_id,part_name" });

      if (regErr) console.error(`[bootstrap] Registry upsert error for ${card.partName}:`, regErr);

      // Upsert semantic entity
      const entityId = `did_cast_${card.partName.toLowerCase().replace(/\s+/g, "_")}`;
      const { error: entErr } = await sb.from("karel_semantic_entities").upsert({
        id: entityId,
        user_id: user.id,
        jmeno: card.partName,
        typ: "did_cast",
        role_vuci_hance: card.role || `Část DID systému (${card.status})`,
        stabilni_vlastnosti: [
          ...(card.age ? [`Věk: ${card.age}`] : []),
          ...(card.cluster ? [`Klastr: ${card.cluster}`] : []),
          ...(card.language ? [`Jazyk: ${card.language}`] : []),
          ...card.strengths.slice(0, 5),
        ],
        notes: `Status: ${card.status}. Folder: ${card.folderLabel}. Bootstrap ${new Date().toISOString()}.`,
        updated_at: new Date().toISOString(),
      }, { onConflict: "id" });

      if (entErr) console.error(`[bootstrap] Entity upsert error for ${card.partName}:`, entErr);

      // Generate episode + relations from card content using AI
      let episodeOk = false;
      let relationsOk = false;
      let relationsCount = 0;
      const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
      if (LOVABLE_API_KEY && card.rawContent.length > 50) {
        try {
          const aiResp = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${LOVABLE_API_KEY}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model: "google/gemini-2.5-flash",
              messages: [
                {
                  role: "system",
                  content: `Jsi Karel, supervizní AI pro DID systém. Z obsahu karty části vygeneruj:
1) Strukturovanou epizodu
2) Sémantické vztahy k jiným částem/osobám zmíněným v kartě

Odpověz POUZE jako JSON objekt (bez markdown):
{
  "episode": {
    "summary_karel": "stručné shrnutí klíčových informací o části (2-3 věty)",
    "summary_user": "co je důležité vědět pro terapeuty (2-3 věty)",
    "derived_facts": ["fakt1", "fakt2", ...max 5],
    "tags": ["tag1", "tag2", ...max 5],
    "emotional_intensity": číslo 1-5,
    "participants": ["jméno části"],
    "hana_state": "EMO_KLIDNA nebo EMO_AKTIVNI nebo EMO_KRIZE"
  },
  "relations": [
    {
      "target_name": "jméno druhé části/osoby",
      "relation": "typ vztahu (chrání, bojí_se, spolupracuje_s, konflikt_s, ochranitel, trigger, sourozenci, sdílí_klastr, ...)",
      "description": "krátký popis vztahu (1 věta)",
      "confidence": číslo 0.3-1.0
    }
  ]
}
Pokud karta nezmiňuje žádné vztahy, vrať prázdné pole relations.`
                },
                {
                  role: "user",
                  content: `Karta části "${card.partName}" (status: ${card.status}, klastr: ${card.cluster || "neuvedeno"}):\n\n${card.rawContent.slice(0, 8000)}`
                }
              ],
            }),
          });

          if (aiResp.ok) {
            const aiData = await aiResp.json();
            let rawContent = aiData.choices?.[0]?.message?.content || "";
            rawContent = rawContent.replace(/^```json?\s*/i, "").replace(/\s*```$/i, "").trim();
            
            const parsed = JSON.parse(rawContent);
            const episode = parsed.episode || parsed;
            const relations = parsed.relations || [];

            // Insert episode
            const { error: epErr } = await sb.from("karel_episodes").insert({
              user_id: user.id,
              domain: "DID",
              participants: episode.participants || [card.partName],
              hana_state: episode.hana_state || "EMO_KLIDNA",
              summary_karel: episode.summary_karel || `Bootstrap karta: ${card.partName}`,
              summary_user: episode.summary_user || "",
              derived_facts: episode.derived_facts || [],
              tags: [...(episode.tags || []), "bootstrap", "karta"],
              emotional_intensity: episode.emotional_intensity || 3,
              outcome: `Bootstrap import z kartotéky (${card.status})`,
              reasoning_notes: `Automaticky generováno z karty ${card.partName} při bootstrapu.`,
              source_conversation_id: `bootstrap_${card.partName.toLowerCase()}`,
              actions_taken: ["bootstrap_card_import"],
            });
            if (epErr) console.error(`[bootstrap] Episode insert error for ${card.partName}:`, epErr);
            else episodeOk = true;

            // Insert relations
            if (Array.isArray(relations) && relations.length > 0) {
              const subjectId = `did_cast_${card.partName.toLowerCase().replace(/\s+/g, "_")}`;
              let relOkCount = 0;
              for (const rel of relations.slice(0, 10)) {
                if (!rel.target_name || !rel.relation) continue;
                const objectId = `did_cast_${rel.target_name.toLowerCase().replace(/\s+/g, "_")}`;
                // Check for existing relation to avoid duplicates
                const { data: existing } = await sb.from("karel_semantic_relations")
                  .select("id")
                  .eq("user_id", user.id)
                  .eq("subject_id", subjectId)
                  .eq("relation", rel.relation)
                  .eq("object_id", objectId)
                  .limit(1);
                if (existing && existing.length > 0) {
                  // Update existing
                  const { error: relErr } = await sb.from("karel_semantic_relations")
                    .update({ description: rel.description || "", confidence: Math.min(1, Math.max(0.1, rel.confidence || 0.5)), updated_at: new Date().toISOString() })
                    .eq("id", existing[0].id);
                  if (!relErr) relOkCount++;
                } else {
                  const { error: relErr } = await sb.from("karel_semantic_relations").insert({
                    user_id: user.id,
                    subject_id: subjectId,
                    relation: rel.relation,
                    object_id: objectId,
                    description: rel.description || "",
                    confidence: Math.min(1, Math.max(0.1, rel.confidence || 0.5)),
                  });
                  if (relErr) console.error(`[bootstrap] Relation error ${card.partName}->${rel.target_name}:`, relErr);
                  else relOkCount++;
                }
              }
              relationsCount = relOkCount;
              relationsOk = relOkCount > 0;
              console.log(`[bootstrap] ${card.partName}: ${relOkCount} relations created`);
            }
          } else {
            console.error(`[bootstrap] AI error for ${card.partName}: ${aiResp.status}`);
          }
        } catch (aiErr) {
          console.error(`[bootstrap] AI generation error for ${card.partName}:`, aiErr);
        }
      }

      return new Response(JSON.stringify({
        partName: card.partName,
        status: card.status,
        registryOk: !regErr,
        entityOk: !entErr,
        episodeOk,
        relationsOk,
        relationsCount,
        metadata: {
          age: card.age,
          cluster: card.cluster,
          role: card.role,
          language: card.language,
          triggersCount: card.triggers.length,
          strengthsCount: card.strengths.length,
        },
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ error: `Unknown phase: ${phase}` }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (error) {
    console.error("[did-bootstrap] Error:", error);
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
