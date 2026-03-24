import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/auth.ts";
import { findKartotekaRoot, normalize, loadDriveRegistryEntries } from "../_shared/driveRegistry.ts";

// ── OAuth2 token ──
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
async function listFiles(token: string, folderId: string): Promise<Array<{ id: string; name: string; mimeType: string }>> {
  const q = `'${folderId}' in parents and trashed=false`;
  const params = new URLSearchParams({ q, fields: "files(id,name,mimeType)", pageSize: "200", supportsAllDrives: "true", includeItemsFromAllDrives: "true" });
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  return data.files || [];
}

// ── Find subfolder by exact name (case-insensitive) ──
async function findSubfolder(token: string, parentId: string, name: string): Promise<string | null> {
  const files = await listFiles(token, parentId);
  const nameLower = name.toLowerCase();
  const match = files.find(f =>
    f.mimeType === "application/vnd.google-apps.folder" &&
    f.name.toLowerCase() === nameLower
  );
  return match?.id || null;
}

// ── Find file by exact name in folder ──
async function findFileInFolder(token: string, folderId: string, fileName: string): Promise<string | null> {
  const files = await listFiles(token, folderId);
  const nameLower = fileName.toLowerCase();
  const match = files.find(f =>
    f.mimeType !== "application/vnd.google-apps.folder" &&
    f.name.toLowerCase() === nameLower
  );
  return match?.id || null;
}

// ── Read plain text file from Drive ──
async function readDriveFile(token: string, fileId: string): Promise<string> {
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) throw new Error(`Cannot read file ${fileId}: ${res.status}`);
  return await res.text();
}

// ── Append text to a plain text file on Drive ──
async function appendToTextFile(token: string, fileId: string, newContent: string): Promise<void> {
  const existing = await readDriveFile(token, fileId);
  const updated = existing + "\n" + newContent;
  const res = await fetch(
    `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media&supportsAllDrives=true`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "text/plain; charset=utf-8",
      },
      body: updated,
    }
  );
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Drive file update failed: ${res.status} ${errText}`);
  }
}

// ── Navigate PAMET_KAREL/DID/HANKA|KATA → SITUACNI_ANALYZA.txt ──
async function findSituacniAnalyza(
  token: string,
  therapistFolder: string // "HANKA" or "KATA"
): Promise<{ fileId: string; path: string } | null> {
  // Step 1: Find PAMET_KAREL
  const rootFiles = await listFiles(token, "root");
  const pametFolder = rootFiles.find(f =>
    f.mimeType === "application/vnd.google-apps.folder" &&
    f.name.toUpperCase() === "PAMET_KAREL"
  );
  if (!pametFolder) {
    // Fallback: search entire drive for exact name
    const q = `mimeType='application/vnd.google-apps.folder' and name='PAMET_KAREL' and trashed=false`;
    const params = new URLSearchParams({ q, fields: "files(id,name)", pageSize: "5", supportsAllDrives: "true", includeItemsFromAllDrives: "true" });
    const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json();
    if (!data.files?.length) {
      console.warn(`[apply-analysis] PAMET_KAREL folder not found anywhere`);
      return null;
    }
    var pametId = data.files[0].id;
  } else {
    var pametId = pametFolder.id;
  }
  console.log(`[apply-analysis] Found PAMET_KAREL: ${pametId}`);

  // Step 2: Find DID subfolder
  const didId = await findSubfolder(token, pametId, "DID");
  if (!didId) {
    console.warn(`[apply-analysis] PAMET_KAREL/DID subfolder not found`);
    return null;
  }

  // Step 3: Find HANKA or KATA subfolder
  const therapistId = await findSubfolder(token, didId, therapistFolder);
  if (!therapistId) {
    console.warn(`[apply-analysis] PAMET_KAREL/DID/${therapistFolder} subfolder not found`);
    return null;
  }

  // Step 4: Find SITUACNI_ANALYZA.txt
  const fileId = await findFileInFolder(token, therapistId, "SITUACNI_ANALYZA.txt");
  if (!fileId) {
    console.warn(`[apply-analysis] SITUACNI_ANALYZA.txt not found in PAMET_KAREL/DID/${therapistFolder}`);
    return null;
  }

  const path = `PAMET_KAREL/DID/${therapistFolder}/SITUACNI_ANALYZA.txt`;
  console.log(`[apply-analysis] Found ${path}: ${fileId}`);
  return { fileId, path };
}

// ── Normalize name for card matching: strip diacritics, uppercase, spaces→_ ──
function cardNameNorm(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/\s+/g, "_").replace(/[^A-Z0-9_]/g, "");
}

// ── Find part card on Drive using ID or name ──
// Cards live as documents DIRECTLY inside 01_AKTIVNI_FRAGMENTY or 03_ARCHIV_SPICICH
// File naming: XXX_JMENO (e.g. 004_ARTHUR)
async function findPartCard(
  token: string,
  kartotekaId: string,
  partName: string,
  partStatus: string,
  registryEntries: Array<{ id: string; primaryName: string; normalizedName: string }>,
): Promise<string | null> {
  // 1. Resolve registry ID for this part
  const partNorm = normalize(partName);
  const registryEntry = registryEntries.find(e =>
    e.normalizedName === partNorm || normalize(e.primaryName) === partNorm
  );
  const partId = registryEntry?.id; // e.g. "004"

  // 2. Determine which folder to search first based on status
  const isActive = !partStatus || partStatus === "active" || partStatus === "aktivní" || partStatus === "aktivni";
  const primaryFolder = isActive ? "01_AKTIVNI_FRAGMENTY" : "03_ARCHIV_SPICICH";
  const fallbackFolder = isActive ? "03_ARCHIV_SPICICH" : "01_AKTIVNI_FRAGMENTY";

  for (const folderName of [primaryFolder, fallbackFolder]) {
    const folderId = await findSubfolder(token, kartotekaId, folderName);
    if (!folderId) continue;

    const files = await listFiles(token, folderId);
    const docs = files.filter(f => f.mimeType !== "application/vnd.google-apps.folder");

    // 2a. Try ID-based match: file name starts with "004_"
    if (partId) {
      const idMatch = docs.find(f => f.name.startsWith(`${partId}_`));
      if (idMatch) {
        console.log(`[findPartCard] ✅ ID match: ${partId}_ → ${idMatch.name} (${idMatch.id})`);
        return idMatch.id;
      }
    }

    // 2b. Fallback: name-based match
    const nameNorm = cardNameNorm(partName);
    if (nameNorm.length >= 3) {
      const nameMatch = docs.find(f => {
        // Strip the ID prefix (e.g. "004_") and compare
        const fNameNorm = cardNameNorm(f.name.replace(/^\d{1,3}_/, ""));
        return fNameNorm === nameNorm || fNameNorm.includes(nameNorm) || nameNorm.includes(fNameNorm);
      });
      if (nameMatch) {
        console.log(`[findPartCard] ✅ Name match: ${nameNorm} → ${nameMatch.name} (${nameMatch.id})`);
        return nameMatch.id;
      }
    }
  }

  return null;
}

// ── Google Docs: get document length ──
async function getDocEndIndex(token: string, docId: string): Promise<number> {
  const res = await fetch(`https://docs.googleapis.com/v1/documents/${docId}?fields=body.content`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Cannot read doc ${docId}: ${res.status}`);
  const doc = await res.json();
  const content = doc.body?.content || [];
  const last = content[content.length - 1];
  return last?.endIndex || 1;
}

// ── Google Docs: append text with optional heading ──
async function appendToDoc(token: string, docId: string, blocks: Array<{ text: string; style?: string }>): Promise<void> {
  const endIndex = await getDocEndIndex(token, docId);
  const requests: any[] = [];
  let insertAt = endIndex - 1;
  const styleOps: Array<{ start: number; end: number; style: string }> = [];

  for (const block of blocks) {
    const textToInsert = block.text.endsWith("\n") ? block.text : block.text + "\n";
    requests.push({ insertText: { location: { index: insertAt }, text: textToInsert } });
    if (block.style) {
      styleOps.push({ start: insertAt, end: insertAt + textToInsert.length - 1, style: block.style });
    }
    insertAt += textToInsert.length;
  }

  for (const op of styleOps) {
    requests.push({
      updateParagraphStyle: {
        range: { startIndex: op.start, endIndex: op.end },
        paragraphStyle: { namedStyleType: op.style },
        fields: "namedStyleType",
      },
    });
  }

  if (requests.length === 0) return;
  const res = await fetch(`https://docs.googleapis.com/v1/documents/${docId}:batchUpdate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ requests }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Docs batchUpdate failed: ${res.status} ${errText}`);
  }
}

// ── Format therapist situational block (plain text, no markdown) ──
function formatTherapistBlock(date: string, situational: any): string {
  const lines: string[] = [];
  lines.push(`[${date}] Denní situační update`);
  if (situational.energy) lines.push(`Energie: ${situational.energy}`);
  if (situational.health) lines.push(`Zdraví: ${situational.health}`);
  if (situational.current_stressors?.length) {
    lines.push(`Aktuální stresory: ${situational.current_stressors.join(", ")}`);
  }
  if (situational.notes) lines.push(`Poznámky: ${situational.notes}`);
  return lines.join("\n");
}

// ── Format part update block ──
function formatPartBlock(date: string, part: any): string {
  const lines: string[] = [];
  lines.push(`[${date}] Denní aktualizace stavu`);
  lines.push(`Status: ${part.status}`);
  if (part.recent_emotions) lines.push(`Emoční stav: ${part.recent_emotions}`);
  if (part.needs?.length) lines.push(`Potřeby: ${part.needs.join(", ")}`);
  lines.push(`Riziko: ${part.risk_level || "low"}`);
  if (part.relationship_to_therapists) {
    const rel = part.relationship_to_therapists;
    if (rel.Hanka) lines.push(`Vztah k Hance: ${rel.Hanka}`);
    if (rel.Kata) lines.push(`Vztah ke Kátě: ${rel.Kata}`);
  }
  if (part.session_recommendation?.needed) {
    const rec = part.session_recommendation;
    lines.push(`Doporučení sezení: ${rec.who_leads}, priorita ${rec.priority}`);
    if (rec.goals?.length) lines.push(`Cíle: ${rec.goals.join(", ")}`);
  }
  return lines.join("\n");
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    // ── Resolve user_id ──
    let userId: string | null = null;
    const authHeader = req.headers.get("Authorization");
    if (authHeader?.startsWith("Bearer ")) {
      const userClient = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
        global: { headers: { Authorization: authHeader } },
      });
      const { data: { user } } = await userClient.auth.getUser();
      userId = user?.id || null;
    }
    if (!userId) {
      const { data: fallback } = await sb.from("did_part_registry").select("user_id").limit(1).single();
      userId = fallback?.user_id || null;
    }
    if (!userId) {
      return new Response(JSON.stringify({ error: "No user found" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ══════════════════════════════════════════════════════════
    // 1. LOAD analysis_json FROM did_daily_context
    // ══════════════════════════════════════════════════════════
    const today = new Date().toISOString().slice(0, 10);
    const { data: dailyCtx, error: ctxError } = await sb
      .from("did_daily_context")
      .select("context_date, context_json, analysis_json")
      .eq("user_id", userId)
      .order("context_date", { ascending: false })
      .limit(1)
      .single();

    if (ctxError || !dailyCtx) {
      return new Response(JSON.stringify({ error: "did_daily_context not found" }), { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const analysis = dailyCtx.analysis_json as any;
    if (!analysis || !analysis.therapists || !analysis.parts) {
      return new Response(JSON.stringify({ error: "analysis_json missing or incomplete" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const analysisDate = analysis.date || dailyCtx.context_date || today;
    console.log(`[apply-analysis] Starting for user=${userId}, date=${analysisDate}, parts=${analysis.parts?.length}`);

    const token = await getAccessToken();
    const results = {
      pamet_hanka: false,
      pamet_kata: false,
      parts_updated: 0,
      parts_skipped: [] as string[],
      tasks_created: 0,
      tasks_skipped: 0,
    };

    // ══════════════════════════════════════════════════════════
    // 2. PAMET_KAREL: HANKA → SITUACNI_ANALYZA.txt
    // ══════════════════════════════════════════════════════════
    if (analysis.therapists.Hanka?.situational) {
      const hankaFile = await findSituacniAnalyza(token, "HANKA");
      if (hankaFile) {
        try {
          const block = formatTherapistBlock(analysisDate, analysis.therapists.Hanka.situational);
          await appendToTextFile(token, hankaFile.fileId, "\n" + block + "\n");
          results.pamet_hanka = true;
          console.log(`[apply-analysis] ✅ ${hankaFile.path} updated`);
        } catch (e) {
          console.error(`[apply-analysis] ❌ Hanka SITUACNI_ANALYZA update failed:`, e);
        }
      }
    }

    // ══════════════════════════════════════════════════════════
    // 3. PAMET_KAREL: KATA → SITUACNI_ANALYZA.txt
    // ══════════════════════════════════════════════════════════
    if (analysis.therapists.Kata?.situational) {
      const kataFile = await findSituacniAnalyza(token, "KATA");
      if (kataFile) {
        try {
          const block = formatTherapistBlock(analysisDate, analysis.therapists.Kata.situational);
          await appendToTextFile(token, kataFile.fileId, "\n" + block + "\n");
          results.pamet_kata = true;
          console.log(`[apply-analysis] ✅ ${kataFile.path} updated`);
        } catch (e) {
          console.error(`[apply-analysis] ❌ Kata SITUACNI_ANALYZA update failed:`, e);
        }
      }
    }

    // ══════════════════════════════════════════════════════════
    // 4. DRIVE: UPDATE PART CARDS (Google Docs in kartoteka)
    // ══════════════════════════════════════════════════════════
    const kartotekaId = await findKartotekaRoot(token);
    if (kartotekaId) {
      for (const part of analysis.parts) {
        if (!part.name) continue;
        try {
          const cardDocId = await findPartCard(token, kartotekaId, part.name);
          if (!cardDocId) {
            results.parts_skipped.push(part.name);
            console.warn(`[apply-analysis] ⚠️ Card not found for part: ${part.name}`);
            continue;
          }

          const blockText = formatPartBlock(analysisDate, part);
          await appendToDoc(token, cardDocId, [
            { text: `\n[${analysisDate}] Denní aktualizace stavu\n`, style: "HEADING_3" },
            { text: blockText + "\n" },
          ]);
          results.parts_updated++;
          console.log(`[apply-analysis] ✅ Card updated: ${part.name}`);
        } catch (e) {
          results.parts_skipped.push(part.name);
          console.error(`[apply-analysis] ❌ Card update failed for ${part.name}:`, e);
        }
      }
    } else {
      console.warn(`[apply-analysis] ⚠️ Kartoteka root not found`);
    }

    // ══════════════════════════════════════════════════════════
    // 5. DB: CREATE TASKS FROM session_recommendation
    // ══════════════════════════════════════════════════════════
    for (const part of analysis.parts) {
      if (!part.session_recommendation?.needed) continue;

      const rec = part.session_recommendation;
      const assignedTo = (rec.who_leads || "").toLowerCase();
      let assignee = "both";
      if (assignedTo.includes("hanka")) assignee = "hanka";
      else if (assignedTo.includes("kat") || assignedTo.includes("kát")) assignee = "kata";

      let priority = "medium";
      if (rec.priority === "today") priority = "high";
      else if (rec.priority === "later") priority = "low";

      let dueDate = today;
      if (rec.priority === "soon") {
        const d = new Date(); d.setDate(d.getDate() + 2);
        dueDate = d.toISOString().slice(0, 10);
      } else if (rec.priority === "later") {
        const d = new Date(); d.setDate(d.getDate() + 7);
        dueDate = d.toISOString().slice(0, 10);
      }

      const taskText = `Sezení s ${part.name}: ${(rec.goals || []).slice(0, 2).join(", ") || "dle analýzy"}`;

      // Deduplicate
      const { data: existingTasks } = await sb
        .from("did_therapist_tasks")
        .select("id")
        .eq("user_id", userId)
        .eq("assigned_to", assignee)
        .eq("category", "session_recommendation")
        .ilike("task", `%${part.name}%`)
        .gte("created_at", `${today}T00:00:00`)
        .limit(1);

      if (existingTasks && existingTasks.length > 0) {
        results.tasks_skipped++;
        continue;
      }

      const { error: taskError } = await sb.from("did_therapist_tasks").insert({
        user_id: userId,
        task: taskText,
        assigned_to: assignee,
        priority,
        due_date: dueDate,
        category: "session_recommendation",
        status: "not_started",
        status_hanka: "pending",
        status_kata: "pending",
        detail_instruction: `Automatický úkol z denní analýzy ${analysisDate}.\nČást: ${part.name}\nRiziko: ${part.risk_level || "low"}\nPotřeby: ${(part.needs || []).join(", ")}\nCíle: ${(rec.goals || []).join(", ")}`,
      });

      if (taskError) {
        console.error(`[apply-analysis] ❌ Task insert failed for ${part.name}:`, taskError);
      } else {
        results.tasks_created++;
        console.log(`[apply-analysis] ✅ Task created: ${taskText} → ${assignee}`);
      }
    }

    console.log(`[apply-analysis] ✅ Done: pamet_h=${results.pamet_hanka}, pamet_k=${results.pamet_kata}, parts=${results.parts_updated}, tasks=${results.tasks_created}`);

    return new Response(JSON.stringify({
      success: true,
      date: analysisDate,
      results,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (error) {
    console.error("[apply-analysis] Error:", error);
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
