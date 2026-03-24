import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/auth.ts";
import { findKartotekaRoot, normalize } from "../_shared/driveRegistry.ts";

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

async function searchFiles(token: string, query: string): Promise<Array<{ id: string; name: string; mimeType: string }>> {
  const params = new URLSearchParams({ q: query, fields: "files(id,name,mimeType)", pageSize: "50", supportsAllDrives: "true", includeItemsFromAllDrives: "true" });
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  return data.files || [];
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

  // Build all text first, then apply styles in reverse
  const styleOps: Array<{ start: number; end: number; style: string }> = [];

  for (const block of blocks) {
    const textToInsert = block.text.endsWith("\n") ? block.text : block.text + "\n";
    requests.push({
      insertText: { location: { index: insertAt }, text: textToInsert },
    });
    if (block.style) {
      styleOps.push({ start: insertAt, end: insertAt + textToInsert.length - 1, style: block.style });
    }
    insertAt += textToInsert.length;
  }

  // Apply paragraph styles
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

// ── Find PAMET_KAREL folder structure ──
async function findPametKarelFolder(token: string): Promise<string | null> {
  // Search for PAMET_KAREL folder anywhere
  const q = `mimeType='application/vnd.google-apps.folder' and trashed=false and (name contains 'PAMET_KAREL' or name contains 'PAMET' or name contains 'pamet_karel')`;
  const files = await searchFiles(token, q);
  const strip = (s: string) => normalize(s);
  const match = files.find(f => {
    const n = strip(f.name);
    return n.includes("pamet") && n.includes("karel");
  });
  return match?.id || null;
}

// ── Find therapist profile doc in PAMET_KAREL ──
async function findTherapistDoc(token: string, pametFolderId: string, therapistName: string): Promise<string | null> {
  // Look recursively: PAMET_KAREL/DID/Hanka or PAMET_KAREL/Hanka etc.
  const allFiles = await listFiles(token, pametFolderId);
  const nameLower = normalize(therapistName);

  // Direct file match
  for (const f of allFiles) {
    if (f.mimeType === "application/vnd.google-apps.folder") continue;
    if (normalize(f.name).includes(nameLower)) return f.id;
  }

  // Check subfolders (DID, etc.)
  for (const f of allFiles) {
    if (f.mimeType !== "application/vnd.google-apps.folder") continue;
    const subFiles = await listFiles(token, f.id);
    for (const sf of subFiles) {
      if (sf.mimeType === "application/vnd.google-apps.folder") continue;
      if (normalize(sf.name).includes(nameLower)) return sf.id;
    }
  }

  return null;
}

// ── Find part card on Drive ──
async function findPartCard(token: string, kartotekaId: string, partName: string): Promise<string | null> {
  const partNorm = normalize(partName);

  // List all folders in kartoteka root
  const rootFiles = await listFiles(token, kartotekaId);

  for (const folder of rootFiles) {
    if (folder.mimeType !== "application/vnd.google-apps.folder") continue;
    const folderNorm = normalize(folder.name);
    // Skip 00_CENTRUM, 08_MESICNI_REPORTY etc.
    if (folderNorm.startsWith("00") || folderNorm.includes("centrum") || folderNorm.includes("mesicni") || folderNorm.includes("reporty")) continue;

    // Check if folder name contains part name
    if (folderNorm.includes(partNorm)) {
      // Find main card doc inside
      const folderFiles = await listFiles(token, folder.id);
      // Look for files like "DID_XXX_NAME" or "Karta" or the main doc
      const cardDoc = folderFiles.find(f => {
        if (f.mimeType === "application/vnd.google-apps.folder") return false;
        const fn = normalize(f.name);
        return fn.includes(partNorm) || fn.includes("karta") || fn.includes("profil");
      });
      if (cardDoc) return cardDoc.id;
      // If no specific card found, return first non-folder file
      const firstDoc = folderFiles.find(f => f.mimeType !== "application/vnd.google-apps.folder");
      if (firstDoc) return firstDoc.id;
    }
  }

  return null;
}

// ── Format therapist update block ──
function formatTherapistBlock(date: string, situational: any): string {
  const lines: string[] = [];
  lines.push(`Datum: ${date}`);
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
  lines.push(`Datum: ${date}`);
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

    // ══════════════════════════════════════════════════════════
    // 2. DRIVE: UPDATE PAMET_KAREL (THERAPIST PROFILES)
    // ══════════════════════════════════════════════════════════
    const token = await getAccessToken();
    const results = { pamet_hanka: false, pamet_kata: false, parts_updated: 0, parts_skipped: [] as string[], tasks_created: 0, tasks_skipped: 0 };

    const pametFolderId = await findPametKarelFolder(token);
    if (pametFolderId) {
      // ── Hanka ──
      if (analysis.therapists.Hanka?.situational) {
        const hankaDocId = await findTherapistDoc(token, pametFolderId, "Hanka");
        if (hankaDocId) {
          try {
            const blockText = formatTherapistBlock(analysisDate, analysis.therapists.Hanka.situational);
            await appendToDoc(token, hankaDocId, [
              { text: `\n[${analysisDate}] Denní situační update\n`, style: "HEADING_3" },
              { text: blockText + "\n" },
            ]);
            results.pamet_hanka = true;
            console.log(`[apply-analysis] ✅ PAMET_KAREL/Hanka updated`);
          } catch (e) {
            console.error(`[apply-analysis] ❌ Hanka doc update failed:`, e);
          }
        } else {
          console.warn(`[apply-analysis] ⚠️ Hanka doc not found in PAMET_KAREL`);
        }
      }

      // ── Káťa ──
      if (analysis.therapists.Kata?.situational) {
        const kataDocId = await findTherapistDoc(token, pametFolderId, "Kata");
        if (kataDocId) {
          try {
            const blockText = formatTherapistBlock(analysisDate, analysis.therapists.Kata.situational);
            await appendToDoc(token, kataDocId, [
              { text: `\n[${analysisDate}] Denní situační update\n`, style: "HEADING_3" },
              { text: blockText + "\n" },
            ]);
            results.pamet_kata = true;
            console.log(`[apply-analysis] ✅ PAMET_KAREL/Kata updated`);
          } catch (e) {
            console.error(`[apply-analysis] ❌ Kata doc update failed:`, e);
          }
        } else {
          console.warn(`[apply-analysis] ⚠️ Kata doc not found in PAMET_KAREL`);
        }
      }
    } else {
      console.warn(`[apply-analysis] ⚠️ PAMET_KAREL folder not found`);
    }

    // ══════════════════════════════════════════════════════════
    // 3. DRIVE: UPDATE PART CARDS
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
    // 4. DB: CREATE TASKS FROM session_recommendation
    // ══════════════════════════════════════════════════════════
    for (const part of analysis.parts) {
      if (!part.session_recommendation?.needed) continue;

      const rec = part.session_recommendation;
      const assignedTo = (rec.who_leads || "").toLowerCase();
      // Map who_leads to valid assignee
      let assignee = "both";
      if (assignedTo.includes("hanka")) assignee = "hanka";
      else if (assignedTo.includes("kat") || assignedTo.includes("kát")) assignee = "kata";

      // Map priority
      let priority = "medium";
      if (rec.priority === "today") priority = "high";
      else if (rec.priority === "later") priority = "low";

      // Calculate due_date
      let dueDate = today;
      if (rec.priority === "soon") {
        const d = new Date();
        d.setDate(d.getDate() + 2);
        dueDate = d.toISOString().slice(0, 10);
      } else if (rec.priority === "later") {
        const d = new Date();
        d.setDate(d.getDate() + 7);
        dueDate = d.toISOString().slice(0, 10);
      }

      const taskText = `Sezení s ${part.name}: ${(rec.goals || []).slice(0, 2).join(", ") || "dle analýzy"}`;

      // ── Deduplicate: check if similar task exists for same part + assignee + date ──
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
        console.log(`[apply-analysis] ⏭️ Task already exists for ${part.name} → ${assignee}`);
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

    console.log(`[apply-analysis] ✅ Done: pamet_h=${results.pamet_hanka}, pamet_k=${results.pamet_kata}, parts=${results.parts_updated}, tasks=${results.tasks_created}, skipped_parts=${results.parts_skipped.length}, skipped_tasks=${results.tasks_skipped}`);

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
