import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/auth.ts";
import { findKartotekaRoot, normalize } from "../_shared/driveRegistry.ts";
import { appendPantryB } from "../_shared/pantryB.ts";

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

// ── Pre-loaded card index for O(1) lookups ──
interface CardIndex {
  byIdPrefix: Map<string, { id: string; name: string }>; // "004" → file
  byNameNorm: Map<string, { id: string; name: string }>; // "ARTHUR" → file
}

async function buildCardIndex(token: string, kartotekaId: string): Promise<CardIndex> {
  const index: CardIndex = { byIdPrefix: new Map(), byNameNorm: new Map() };

  for (const folderName of ["01_AKTIVNI_FRAGMENTY", "03_ARCHIV_SPICICH"]) {
    const folderId = await findSubfolder(token, kartotekaId, folderName);
    if (!folderId) continue;

    const files = await listFiles(token, folderId);
    for (const f of files) {
      if (f.mimeType === "application/vnd.google-apps.folder") continue;
      // Extract ID prefix (e.g. "004" from "004_ARTHUR")
      const idMatch = f.name.match(/^(\d{1,3})_/);
      if (idMatch) {
        const paddedId = idMatch[1].padStart(3, "0");
        if (!index.byIdPrefix.has(paddedId)) {
          index.byIdPrefix.set(paddedId, { id: f.id, name: f.name });
        }
      }
      // Name-based index
      const nameAfterPrefix = f.name.replace(/^\d{1,3}_/, "");
      const norm = cardNameNorm(nameAfterPrefix);
      if (norm.length >= 2 && !index.byNameNorm.has(norm)) {
        index.byNameNorm.set(norm, { id: f.id, name: f.name });
      }
    }
  }

  console.log(`[buildCardIndex] Indexed ${index.byIdPrefix.size} by ID, ${index.byNameNorm.size} by name`);
  return index;
}

function findPartCardFromIndex(
  cardIndex: CardIndex,
  partName: string,
  registryEntries: Array<{ id: string; primaryName: string; normalizedName: string }>,
): string | null {
  const partNorm = normalize(partName);
  const entry = registryEntries.find(e => e.normalizedName === partNorm);
  const partId = entry?.id;

  // 1. ID-based lookup
  if (partId && cardIndex.byIdPrefix.has(partId)) {
    const card = cardIndex.byIdPrefix.get(partId)!;
    console.log(`[findPartCard] ✅ ID match: ${partId} → ${card.name}`);
    return card.id;
  }

  // 2. Name-based fallback
  const nameNorm = cardNameNorm(partName);
  if (nameNorm.length >= 3) {
    // Exact match
    if (cardIndex.byNameNorm.has(nameNorm)) {
      const card = cardIndex.byNameNorm.get(nameNorm)!;
      console.log(`[findPartCard] ✅ Name match: ${nameNorm} → ${card.name}`);
      return card.id;
    }
    // Substring match
    for (const [key, card] of cardIndex.byNameNorm) {
      if (key.includes(nameNorm) || nameNorm.includes(key)) {
        console.log(`[findPartCard] ✅ Fuzzy match: ${nameNorm} ~ ${key} → ${card.name}`);
        return card.id;
      }
    }
  }

  return null;
}

// ── Google Docs: append plain text at end (lightweight, no doc body read) ──
async function appendTextToDoc(token: string, docId: string, text: string): Promise<void> {
  // Use endOfSegmentLocation to insert at end without reading doc first
  const requests = [
    {
      insertText: {
        endOfSegmentLocation: { segmentId: "" },
        text: "\n" + text + "\n",
      },
    },
  ];
  const res = await fetch(`https://docs.googleapis.com/v1/documents/${docId}:batchUpdate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ requests }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Docs append failed: ${res.status} ${errText}`);
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
    // 4. DRIVE: UPDATE PART CARDS (pre-indexed, no per-part API calls)
    // ══════════════════════════════════════════════════════════
    const kartotekaId = await findKartotekaRoot(token);
    if (kartotekaId) {
      // Load registry from DB (lightweight, no xlsx import) + build card index
      const { data: regRows } = await sb.from("did_part_registry").select("part_name, display_name, drive_folder_label").eq("user_id", userId);
      const registryEntries = (regRows || []).map(r => {
        const label = r.drive_folder_label || r.display_name || r.part_name;
        const idMatch = label.match(/^(\d{1,3})_/);
        return {
          id: idMatch ? idMatch[1].padStart(3, "0") : "",
          primaryName: r.part_name,
          normalizedName: normalize(r.part_name),
        };
      });
      const cardIndex = await buildCardIndex(token, kartotekaId);
      console.log(`[apply-analysis] Registry: ${registryEntries.length} entries, Card index: ${cardIndex.byIdPrefix.size} cards`);

      // Only update cards with meaningful new info; cap at 10 per run to avoid memory limits
      const partsWithContent = analysis.parts.filter((p: any) => {
        if (!p.name) return false;
        const hasContent = p.recent_emotions || (p.needs?.length > 0) || p.risk_level === "medium" || p.risk_level === "high";
        const hasRec = p.session_recommendation?.needed;
        return hasContent || hasRec;
      });
      partsWithContent.sort((a: any, b: any) => {
        const riskOrder: Record<string, number> = { high: 0, medium: 1, low: 2 };
        return (riskOrder[a.risk_level] ?? 2) - (riskOrder[b.risk_level] ?? 2);
      });
      const partsToUpdate = partsWithContent.slice(0, 10);
      console.log(`[apply-analysis] Will update ${partsToUpdate.length}/${analysis.parts.length} cards (filtered+capped@10)`);

      for (const part of partsToUpdate) {
        try {
          const cardDocId = findPartCardFromIndex(cardIndex, part.name, registryEntries);
          if (!cardDocId) {
            results.parts_skipped.push(part.name);
            continue;
          }

          const blockText = `\n=== [${analysisDate}] Denní aktualizace stavu ===\n` + formatPartBlock(analysisDate, part);
          await appendTextToDoc(token, cardDocId, blockText);
          results.parts_updated++;
          console.log(`[apply-analysis] ✅ Card updated: ${part.name}`);
        } catch (e) {
          results.parts_skipped.push(part.name);
          console.error(`[apply-analysis] ❌ Card update failed for ${part.name}:`, e);
        }
      }
      // Log parts not updated (no meaningful content)
      const skippedNoContent = analysis.parts
        .filter((p: any) => p.name && !partsToUpdate.includes(p))
        .map((p: any) => p.name);
      if (skippedNoContent.length > 0) {
        console.log(`[apply-analysis] ℹ️ Skipped (no new data): ${skippedNoContent.join(", ")}`);
      }
    } else {
      console.warn(`[apply-analysis] ⚠️ Kartoteka root not found`);
    }

    // ══════════════════════════════════════════════════════════
    // 5. DB: CREATE TASKS + SESSION PLANS FROM session_recommendation
    // ══════════════════════════════════════════════════════════

    // HARD RULES: only create tasks/plans for parts that are ACTIVE and have needed=true
    const BANNED_PART_NAMES = new Set([
      "LOCIK", "BENDIK_BONDEVIK", "BENDIK", "CLARK", "KLARK",
      "ADAM", "EINAR", "BELO", "BÉLO", "GERHARDT",
    ]);

    // PRIVACY: task text must never contain these patterns
    const PRIVATE_PATTERNS = [
      /vinou/i, /intimní/i, /soukrom/i, /osobní terapie/i,
      /countertransference/i, /emoční vazb/i, /sedmikrásk/i,
    ];

    const isTaskTextClean = (text: string) => !PRIVATE_PATTERNS.some(p => p.test(text));

    // SELF-TASK FILTER: Karel must not assign self-tasks to therapists
    const SELF_TASK_PATTERNS = [
      /^zapsat /i, /^zalogovat/i, /^aktualizovat kartu/i,
      /do sekce .* karty/i, /do karty jako/i,
    ];
    const isNotSelfTask = (text: string) => !SELF_TASK_PATTERNS.some(p => p.test(text));

    for (const part of analysis.parts) {
      if (!part.session_recommendation?.needed) continue;
      if (part.status !== "active") {
        console.log(`[apply-analysis] ⏭️ Skipping task for sleeping part: ${part.name}`);
        continue;
      }

      const nameUpper = (part.name || "").toUpperCase().replace(/\s+/g, "_").trim();
      if (BANNED_PART_NAMES.has(nameUpper)) {
        console.log(`[apply-analysis] ⏭️ Skipping banned part: ${part.name}`);
        continue;
      }

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

      const goalsText = (rec.goals || []).slice(0, 2).join(", ") || "dle analýzy";
      const taskText = `Sezení s ${part.name}: ${goalsText}`;

      // Privacy + self-task check
      if (!isTaskTextClean(taskText) || !isNotSelfTask(taskText)) {
        console.log(`[apply-analysis] ⏭️ Skipping private/self task: ${taskText}`);
        continue;
      }

      // Deduplicate: check if task for this part already exists today
      const { data: existingTasks } = await sb
        .from("did_therapist_tasks")
        .select("id")
        .eq("user_id", userId)
        .eq("category", "session_recommendation")
        .ilike("task", `%${part.name}%`)
        .gte("created_at", `${today}T00:00:00`)
        .neq("status", "archived")
        .limit(1);

      if (existingTasks && existingTasks.length > 0) {
        results.tasks_skipped++;
        continue;
      }

      // Create task in did_therapist_tasks
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

      // Also create session plan in did_daily_session_plans (for "Příprava na sezení")
      const { data: existingPlans } = await sb
        .from("did_daily_session_plans")
        .select("id")
        .eq("user_id", userId)
        .eq("selected_part", part.name)
        .eq("plan_date", today)
        .neq("status", "cancelled")
        .limit(1);

      if (!existingPlans || existingPlans.length === 0) {
        const planMarkdown = [
          `# Plán sezení: ${part.name}`,
          `**Datum:** ${analysisDate}`,
          `**Vede:** ${rec.who_leads || "dle dohody"}`,
          `**Priorita:** ${rec.priority || "medium"}`,
          `**Riziko:** ${part.risk_level || "low"}`,
          ``,
          `## Cíle sezení`,
          ...(rec.goals || []).map((g: string) => `- ${g}`),
          ``,
          `## Potřeby části`,
          ...(part.needs || []).map((n: string) => `- ${n}`),
          ``,
          `## Emoční stav`,
          part.recent_emotions || "Nespecifikováno",
        ].join("\n");

        const { error: planError } = await sb.from("did_daily_session_plans").insert({
          user_id: userId,
          selected_part: part.name,
          plan_date: today,
          therapist: assignee === "both" ? "Hanka" : (assignee === "hanka" ? "Hanka" : "Káťa"),
          session_lead: assignee === "both" ? "obe" : assignee,
          plan_markdown: planMarkdown,
          plan_html: `<div>${planMarkdown.replace(/\n/g, "<br>")}</div>`,
          urgency_score: rec.priority === "today" ? 8 : rec.priority === "soon" ? 5 : 3,
          urgency_breakdown: { risk: part.risk_level, needs: part.needs, goals: rec.goals },
          part_tier: part.status === "active" ? "aktivní" : "spící",
          status: "pending",
          generated_by: "karel-did-apply-analysis",
        });

        if (planError) {
          console.error(`[apply-analysis] ❌ Session plan insert failed for ${part.name}:`, planError);
        } else {
          console.log(`[apply-analysis] ✅ Session plan created for ${part.name}`);
        }
      }
    }

    // ══════════════════════════════════════════════════════════
    // 6. PANTRY B: zápis dnešních klinických implikací pro briefing reader
    // ══════════════════════════════════════════════════════════
    // Bez tohoto kroku zítřejší ranní briefing nevidí, co dnes z analýzy
    // vyplynulo: rizikové části, externí stresory (lék/styk/soud), doporučená
    // sezení. Tundrupek/Derin a Arthur/Říha typové signály se sem propíšou
    // jako followup_need / risk záznamy a briefing je zítra ráno přečte.
    try {
      const pantryRows: Array<{ kind: string; summary: string; part: string; detail: any }> = [];

      for (const part of analysis.parts || []) {
        if (!part?.name) continue;
        const isHighRisk = part.risk_level === "high" || part.risk_level === "medium";
        const recNeeded = part.session_recommendation?.needed === true;
        const hasEmotion = part.recent_emotions && String(part.recent_emotions).trim().length > 0;

        if (recNeeded) {
          const goals = (part.session_recommendation?.goals || []).slice(0, 3).join(", ");
          pantryRows.push({
            kind: "followup_need",
            summary: `Doporučené sezení s ${part.name}${
              goals ? ` — ${goals}` : ""
            } (priorita ${part.session_recommendation?.priority || "?"}, vede ${part.session_recommendation?.who_leads || "dle dohody"})`,
            part: part.name,
            detail: {
              risk_level: part.risk_level,
              needs: part.needs ?? [],
              session_recommendation: part.session_recommendation,
              recent_emotions: part.recent_emotions ?? null,
            },
          });
        } else if (isHighRisk && hasEmotion) {
          pantryRows.push({
            kind: "risk",
            summary: `${part.name}: ${part.recent_emotions} (riziko ${part.risk_level})`,
            part: part.name,
            detail: {
              risk_level: part.risk_level,
              needs: part.needs ?? [],
              recent_emotions: part.recent_emotions,
              relationship_to_therapists: part.relationship_to_therapists ?? null,
            },
          });
        }
      }

      // Therapist-level externí kontext (lék, soud, styk, …) jako plan_change
      for (const who of ["Hanka", "Kata"] as const) {
        const sit = (analysis.therapists?.[who]?.situational ?? null) as any;
        if (!sit) continue;
        const stressors = Array.isArray(sit.current_stressors) ? sit.current_stressors : [];
        if (stressors.length === 0 && !sit.notes) continue;
        pantryRows.push({
          kind: "plan_change",
          summary: `${who === "Hanka" ? "Hanička" : "Káťa"} — situační vstup (${analysisDate}): ${
            stressors.slice(0, 3).join(", ") || (sit.notes || "").slice(0, 180)
          }`,
          part: "",
          detail: { therapist: who.toLowerCase(), situational: sit },
        });
      }

      let pantryWritten = 0;
      for (const r of pantryRows.slice(0, 25)) {
        const ok = await appendPantryB(sb, {
          user_id: userId,
          entry_kind: r.kind as any,
          source_kind: "therapy_session",
          source_ref: `apply-analysis:${analysisDate}:${r.part || "global"}`,
          summary: r.summary,
          detail: { ...r.detail, source_date: analysisDate },
          intended_destinations: r.kind === "risk"
            ? ["briefing_input", "did_pending_questions"]
            : r.kind === "followup_need"
              ? ["briefing_input", "did_therapist_tasks"]
              : ["briefing_input"],
          related_part_name: r.part || undefined,
          related_therapist: r.detail?.therapist === "hanka" ? "hanka"
            : r.detail?.therapist === "kata" ? "kata" : undefined,
        });
        if (ok) pantryWritten++;
      }
      (results as any).pantry_b_written = pantryWritten;
      console.log(`[apply-analysis] Pantry B: ${pantryWritten}/${pantryRows.length} entries written`);
    } catch (pErr) {
      console.warn("[apply-analysis] Pantry B append failed (non-fatal):", pErr);
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
