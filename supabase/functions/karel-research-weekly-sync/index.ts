import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requireAuth, corsHeaders } from "../_shared/auth.ts";

// OAuth2 token helper
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

const DRIVE_FOLDER_MIME = "application/vnd.google-apps.folder";
const DRIVE_DOC_MIME = "application/vnd.google-apps.document";

const stripDiacritics = (value: string) =>
  value.normalize("NFD").replace(/[\u0300-\u036f]/g, "");

const canonicalText = (value: string) =>
  stripDiacritics(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

async function findFolder(token: string, name: string, parentId?: string): Promise<string | null> {
  let q = `name='${name}' and mimeType='${DRIVE_FOLDER_MIME}' and trashed=false`;
  if (parentId) q += ` and '${parentId}' in parents`;
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id)&supportsAllDrives=true&includeItemsFromAllDrives=true`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  return data.files?.[0]?.id || null;
}

async function findOrCreateFolder(token: string, name: string, parentId: string): Promise<string | null> {
  const existing = await findFolder(token, name, parentId);
  if (existing) return existing;
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?supportsAllDrives=true`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name, mimeType: DRIVE_FOLDER_MIME, parents: [parentId] }),
  });
  if (!res.ok) { console.error(`Failed to create folder ${name}: ${res.status}`); return null; }
  const folder = await res.json();
  return folder.id;
}

async function listFilesInFolder(token: string, folderId: string): Promise<Array<{ id: string; name: string; mimeType?: string }>> {
  const q = `'${folderId}' in parents and trashed=false`;
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType)&pageSize=200&supportsAllDrives=true&includeItemsFromAllDrives=true`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  return data.files || [];
}

async function readGoogleDoc(token: string, fileId: string): Promise<string> {
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/plain`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Cannot read doc ${fileId}: ${res.status}`);
  return await res.text();
}

async function updateGoogleDocInPlace(token: string, fileId: string, content: string): Promise<void> {
  const docRes = await fetch(`https://docs.googleapis.com/v1/documents/${fileId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!docRes.ok) throw new Error(`Cannot read doc structure: ${docRes.status}`);
  const doc = await docRes.json();
  const endIndex = doc.body?.content?.slice(-1)?.[0]?.endIndex || 1;

  const requests: any[] = [];
  if (endIndex > 1) {
    requests.push({ deleteContentRange: { range: { startIndex: 1, endIndex: endIndex - 1 } } });
  }
  requests.push({ insertText: { location: { index: 1 }, text: content } });

  const updateRes = await fetch(`https://docs.googleapis.com/v1/documents/${fileId}:batchUpdate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ requests }),
  });
  if (!updateRes.ok) {
    const errText = await updateRes.text();
    console.error("Docs API in-place update error:", errText);
    throw new Error(`Failed to update doc in place: ${updateRes.status}`);
  }
}

async function appendToGoogleDoc(token: string, fileId: string, textToAppend: string): Promise<void> {
  const docRes = await fetch(`https://docs.googleapis.com/v1/documents/${fileId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!docRes.ok) throw new Error(`Cannot read doc structure: ${docRes.status}`);
  const doc = await docRes.json();
  const endIndex = doc.body?.content?.slice(-1)?.[0]?.endIndex || 1;

  const requests = [
    { insertText: { location: { index: endIndex - 1 }, text: "\n\n" + textToAppend } },
  ];

  const updateRes = await fetch(`https://docs.googleapis.com/v1/documents/${fileId}:batchUpdate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ requests }),
  });
  if (!updateRes.ok) {
    const errText = await updateRes.text();
    console.error("Docs API append error:", errText);
    throw new Error(`Failed to append to doc: ${updateRes.status}`);
  }
}

async function createDocInFolder(token: string, fileName: string, folderId: string): Promise<{ id: string }> {
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?supportsAllDrives=true`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: fileName, parents: [folderId], mimeType: DRIVE_DOC_MIME }),
  });
  if (!res.ok) throw new Error(`Drive create failed: ${res.status}`);
  return await res.json();
}

async function createFileInFolder(token: string, fileName: string, content: string, folderId: string): Promise<any> {
  const boundary = "----ResearchSyncBoundary";
  const metadata = JSON.stringify({ name: fileName, parents: [folderId], mimeType: DRIVE_DOC_MIME });
  const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${content}\r\n--${boundary}--`;
  const res = await fetch(`https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": `multipart/related; boundary=${boundary}` },
    body,
  });
  if (!res.ok) throw new Error(`Drive create failed: ${res.status}`);
  return await res.json();
}

// ═══ RICH FORMATTING: Write handbook as formatted Google Doc via Docs API batchUpdate ═══
async function writeFormattedHandbook(token: string, fileId: string, handbook: any): Promise<void> {
  const dateStr = new Date().toISOString().slice(0, 10);
  const activities = handbook.activities || [];

  // Build content as plain text first, then apply formatting
  const lines: string[] = [];
  lines.push(`TERAPEUTICKÁ PŘÍRUČKA`);
  lines.push("");
  lines.push(`Téma: ${handbook.topic || "konzultace"}`);
  lines.push(`Připravil/a: ${handbook.createdBy || "neznámé"}`);
  lines.push(`Datum: ${dateStr}`);
  lines.push(`Vygenerováno aplikací Karel`);
  lines.push("");

  if (handbook.summary) {
    lines.push("SHRNUTÍ");
    lines.push(handbook.summary);
    lines.push("");
  }

  for (let i = 0; i < activities.length; i++) {
    const a = activities[i];
    lines.push(`METODA ${i + 1}: ${a.name || "Bez názvu"}`);
    lines.push("");

    // Build table-like key-value block
    const kvPairs: [string, string][] = [];
    if (a.target_group) kvPairs.push(["Cílová skupina", a.target_group]);
    if (a.goal) kvPairs.push(["Účel / Cíl", a.goal]);
    if (a.principle) kvPairs.push(["Psychologický princip", a.principle]);
    if (a.difficulty) kvPairs.push(["Obtížnost", a.difficulty]);
    if (a.duration) kvPairs.push(["Délka", a.duration]);

    for (const [label, value] of kvPairs) {
      lines.push(`${label}: ${value}`);
    }
    if (kvPairs.length > 0) lines.push("");

    if (a.materials && a.materials.length > 0) {
      lines.push("Pomůcky");
      for (const m of a.materials) lines.push(`  ${m}`);
      lines.push("");
    }

    if (a.introduction) {
      lines.push("Jak uvést");
      lines.push(a.introduction);
      lines.push("");
    }

    if (a.steps && a.steps.length > 0) {
      lines.push("Postup krok za krokem");
      for (let si = 0; si < a.steps.length; si++) {
        lines.push(`${si + 1}. ${a.steps[si]}`);
      }
      lines.push("");
    }

    if (a.expected_course) {
      lines.push("Očekávaný průběh");
      lines.push(a.expected_course);
      lines.push("");
    }

    if (a.expected_outcome) {
      lines.push("Očekávaný výsledek");
      lines.push(a.expected_outcome);
      lines.push("");
    }

    if (a.diagnostic_watch && a.diagnostic_watch.length > 0) {
      lines.push("Diagnostická pozorování");
      for (const d of a.diagnostic_watch) lines.push(`  ${d}`);
      lines.push("");
    }

    if (a.warnings && a.warnings.length > 0) {
      lines.push("Upozornění");
      for (const w of a.warnings) lines.push(`  ${w}`);
      lines.push("");
    }
  }

  if (handbook.general_tips && handbook.general_tips.length > 0) {
    lines.push("OBECNÉ TIPY PRO PRAXI");
    for (const tip of handbook.general_tips) lines.push(`  ${tip}`);
    lines.push("");
  }

  if (handbook.sources && handbook.sources.length > 0) {
    lines.push("ZDROJE");
    for (const src of handbook.sources) {
      let line = `${src.title || "Bez názvu"}`;
      if (src.url) line += ` (${src.url})`;
      if (src.description) line += ` – ${src.description}`;
      lines.push(`  ${line}`);
    }
    lines.push("");
  }

  if (handbook.karel_notes) {
    lines.push("KARLOVY POZNÁMKY");
    lines.push(handbook.karel_notes);
    lines.push("");
  }

  const fullText = lines.join("\n");

  // Step 1: Insert all text
  const insertRequests: any[] = [
    { insertText: { location: { index: 1 }, text: fullText } },
  ];

  const insertRes = await fetch(`https://docs.googleapis.com/v1/documents/${fileId}:batchUpdate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ requests: insertRequests }),
  });
  if (!insertRes.ok) throw new Error(`Insert failed: ${insertRes.status}: ${await insertRes.text()}`);

  // Step 2: Apply formatting
  const formatRequests: any[] = [];
  let charIndex = 1;

  const HEADING1_PATTERNS = [/^TERAPEUTICKÁ PŘÍRUČKA$/];
  const HEADING2_PATTERNS = [/^SHRNUTÍ$/, /^METODA \d+:/, /^OBECNÉ TIPY PRO PRAXI$/, /^ZDROJE$/, /^KARLOVY POZNÁMKY$/];
  const HEADING3_PATTERNS = [/^Pomůcky$/, /^Jak uvést$/, /^Postup krok za krokem$/, /^Očekávaný průběh$/, /^Očekávaný výsledek$/, /^Diagnostická pozorování$/, /^Upozornění$/];
  const BOLD_LABELS = ["Cílová skupina:", "Účel / Cíl:", "Psychologický princip:", "Obtížnost:", "Délka:", "Téma:", "Připravil/a:", "Datum:", "Vygenerováno"];

  // Read back authoritative doc length
  let segmentEndIndex = fullText.length + 1;
  try {
    const refreshRes = await fetch(`https://docs.googleapis.com/v1/documents/${fileId}`, { headers: { Authorization: `Bearer ${token}` } });
    if (refreshRes.ok) {
      const refreshDoc = await refreshRes.json();
      const body = refreshDoc?.body?.content || [];
      segmentEndIndex = body.length > 0 ? Number(body[body.length - 1]?.endIndex || segmentEndIndex) : segmentEndIndex;
    }
  } catch {}

  const clampRange = (start: number, end: number) => {
    const safeStart = Math.max(1, Math.min(start, segmentEndIndex - 1));
    const safeEnd = Math.max(safeStart + 1, Math.min(end, segmentEndIndex));
    if (safeStart >= segmentEndIndex || safeEnd <= safeStart) return null;
    return { startIndex: safeStart, endIndex: safeEnd };
  };

  for (const line of lines) {
    const lineLen = line.length;
    if (lineLen > 0) {
      const trimmed = line.trim();

      // HEADING 1
      if (HEADING1_PATTERNS.some(p => p.test(trimmed))) {
        const range = clampRange(charIndex, charIndex + lineLen);
        if (range) formatRequests.push({ updateParagraphStyle: { range, paragraphStyle: { namedStyleType: "HEADING_1" }, fields: "namedStyleType" } });
      }
      // HEADING 2
      else if (HEADING2_PATTERNS.some(p => p.test(trimmed))) {
        const range = clampRange(charIndex, charIndex + lineLen);
        if (range) formatRequests.push({ updateParagraphStyle: { range, paragraphStyle: { namedStyleType: "HEADING_2" }, fields: "namedStyleType" } });
      }
      // HEADING 3
      else if (HEADING3_PATTERNS.some(p => p.test(trimmed))) {
        const range = clampRange(charIndex, charIndex + lineLen);
        if (range) formatRequests.push({ updateParagraphStyle: { range, paragraphStyle: { namedStyleType: "HEADING_3" }, fields: "namedStyleType" } });
      }

      // Bold labels
      for (const label of BOLD_LABELS) {
        if (trimmed.startsWith(label)) {
          const leadingSpaces = line.length - line.trimStart().length;
          const boldStart = charIndex + leadingSpaces;
          const boldEnd = boldStart + label.length;
          const range = clampRange(boldStart, boldEnd);
          if (range) formatRequests.push({ updateTextStyle: { range, textStyle: { bold: true }, fields: "bold" } });
          break;
        }
      }

      // Numbered steps – bold the number
      const stepMatch = trimmed.match(/^(\d+\.)\s/);
      if (stepMatch) {
        const leadingSpaces = line.length - line.trimStart().length;
        const boldStart = charIndex + leadingSpaces;
        const boldEnd = boldStart + stepMatch[1].length;
        const range = clampRange(boldStart, boldEnd);
        if (range) formatRequests.push({ updateTextStyle: { range, textStyle: { bold: true }, fields: "bold" } });
      }
    }
    charIndex += lineLen + 1; // +1 for \n
  }

  // Apply formatting in chunks
  if (formatRequests.length > 0) {
    const CHUNK = 500;
    for (let i = 0; i < formatRequests.length; i += CHUNK) {
      const chunk = formatRequests.slice(i, i + CHUNK);
      const fmtRes = await fetch(`https://docs.googleapis.com/v1/documents/${fileId}:batchUpdate`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ requests: chunk }),
      });
      if (!fmtRes.ok) {
        console.warn(`[sync] Formatting chunk failed (non-fatal): ${await fmtRes.text()}`);
      }
    }
  }

  // Step 3: Insert table for key-value pairs of each activity
  // Tables need a second pass since they change indices
  try {
    for (let i = 0; i < activities.length; i++) {
      const a = activities[i];
      const kvPairs: [string, string][] = [];
      if (a.target_group) kvPairs.push(["Cílová skupina", a.target_group]);
      if (a.goal) kvPairs.push(["Účel / Cíl", a.goal]);
      if (a.principle) kvPairs.push(["Psychologický princip", a.principle]);
      if (a.difficulty) kvPairs.push(["Obtížnost", a.difficulty]);
      if (a.duration) kvPairs.push(["Délka", a.duration]);

      if (kvPairs.length === 0) continue;

      // Find the position of the first KV pair in the doc to know where the table should go
      // For simplicity, tables are already represented as "Label: Value" lines
      // The Docs API table insertion is complex and changes indices; skip for reliability
      // The bold labels + heading formatting already provides excellent readability
    }
  } catch (tableErr) {
    console.warn(`[sync] Table formatting error (non-fatal):`, tableErr);
  }
}

// ═══ DEDUPLICATION: Fuzzy match topic against existing filenames ═══
function isTopicDuplicate(topicName: string, existingFiles: Array<{ name: string }>): boolean {
  const topicCanonical = canonicalText(topicName);
  if (!topicCanonical) return false;

  for (const f of existingFiles) {
    const fileCanonical = canonicalText(f.name);

    // Exact canonical match
    if (fileCanonical === topicCanonical) return true;

    // Topic is contained in filename or vice versa (covers "Terapeuticka_prirucka_TOPIC" pattern)
    if (topicCanonical.length > 8 && fileCanonical.includes(topicCanonical)) return true;
    if (fileCanonical.length > 8 && topicCanonical.includes(fileCanonical)) return true;

    // Strip "terapeutickaprirucka" prefix and compare
    const strippedFile = fileCanonical.replace(/^terapeuticka_?prirucka_?/i, "").replace(/^terapeutickaprirucka/, "");
    if (strippedFile.length > 6 && (strippedFile === topicCanonical || topicCanonical.includes(strippedFile) || strippedFile.includes(topicCanonical))) return true;
  }

  return false;
}

function canonicalSourceName(fileName: string): string {
  return canonicalText((fileName || "").trim().replace(/\.[a-z0-9]{2,8}$/i, ""));
}

function extractListedSourceCanonicals(text: string): Set<string> {
  const listed = new Set<string>();

  for (const rawLine of (text || "").split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;

    // Match ZDROJ_XX_YYYY-MM-DD: header with Téma on same or next line
    const zdrojMatch = line.match(/^ZDROJ_\d+_\d{4}-\d{2}-\d{2}:/i);
    if (zdrojMatch) continue; // The topic is on the Téma: line

    // Match Téma: line (primary dedup key)
    if (line.startsWith("Téma:")) {
      const topic = line.replace(/^Téma:\s*/i, "").trim();
      const canonical = canonicalSourceName(topic);
      if (canonical) listed.add(canonical);
      continue;
    }

    // Legacy formats for backward compat
    if (line.startsWith("Název zdroje:")) {
      const name = line.replace(/^Název zdroje:\s*/i, "").trim();
      const canonical = canonicalSourceName(name);
      if (canonical) listed.add(canonical);
      continue;
    }

    const datedMatch = line.match(/^\[(\d{4}-\d{2}-\d{2})\]\s+(.+)$/);
    if (datedMatch?.[2]) {
      const canonical = canonicalSourceName(datedMatch[2]);
      if (canonical) listed.add(canonical);
    }
  }

  return listed;
}

function countExistingSources(text: string): number {
  return (text.match(/^ZDROJ_\d+/gm) || []).length;
}

function cleanupReconFromPrehled(content: string): { cleaned: string; changed: boolean } {
  const original = content || "";
  let cleaned = original;

  // Remove last trailing reconciliation run block (from AKTUALIZACE to end)
  // only when it contains "Reconcilováno chybějících záznamů"
  const reconcileIndex = cleaned.lastIndexOf("Reconcilováno chybějících záznamů:");
  if (reconcileIndex >= 0) {
    const beforeRecon = cleaned.slice(0, reconcileIndex);
    const updateStart = beforeRecon.lastIndexOf("AKTUALIZACE ");
    if (updateStart >= 0) {
      cleaned = cleaned.slice(0, updateStart).trimEnd();
    }
  }

  // Safety cleanup for any orphaned reconciliation lines
  const filteredLines = cleaned
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return true;
      if (trimmed.includes("Doplněno automatickou reconciliací")) return false;
      if (/^Reconcilováno chybějících záznamů:/i.test(trimmed)) return false;
      return true;
    });

  cleaned = filteredLines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();

  return { cleaned, changed: cleaned !== original };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const authHeader = req.headers.get("Authorization") || "";
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || "";
  const isCronCall = authHeader === `Bearer ${serviceRoleKey}` || authHeader === `Bearer ${anonKey}`;

  if (!isCronCall) {
    const authResult = await requireAuth(req);
    if (authResult instanceof Response) return authResult;
  }

  try {
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    const PERPLEXITY_API_KEY = Deno.env.get("PERPLEXITY_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY not configured");

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const sb = createClient(supabaseUrl, supabaseKey);

    // 1. GET ALL UNPROCESSED RESEARCH THREADS
    const { data: threads, error: threadsError } = await sb
      .from("research_threads")
      .select("*")
      .eq("is_deleted", false)
      .eq("is_processed", false);

    if (threadsError) throw new Error(`DB error: ${threadsError.message}`);
    
    const activeThreads = threads || [];
    console.log(`Found ${activeThreads.length} unprocessed research threads`);

    // 2. FIND 07_KNIHOVNA FOLDER
    const token = await getAccessToken();
    const kartotekaId = await findFolder(token, "kartoteka_DID") || await findFolder(token, "Kartoteka_DID") || await findFolder(token, "Kartotéka_DID");
    if (!kartotekaId) throw new Error("kartoteka_DID folder not found");

    const centrumId = await findFolder(token, "00_CENTRUM", kartotekaId);
    if (!centrumId) throw new Error("00_CENTRUM folder not found");

    let knihovnaFolderId = await findFolder(token, "07_Knihovna", centrumId);
    if (!knihovnaFolderId) {
      knihovnaFolderId = await findOrCreateFolder(token, "07_Knihovna", centrumId);
    }
    if (!knihovnaFolderId) throw new Error("Could not find/create 07_Knihovna");

    // 3. FIND EXISTING 00_Prehled DOC (case-insensitive, never create a new one)
    const knihovnaFiles = await listFilesInFolder(token, knihovnaFolderId);
    let prehledFile = knihovnaFiles.find(f => canonicalText(f.name).startsWith("00prehled"));
    if (!prehledFile) {
      console.warn("[sync] 00_Prehled not found in 07_Knihovna – cannot update index. Continuing without it.");
    } else {
      console.log(`[sync] Found 00_Prehled: "${prehledFile.name}" (${prehledFile.id})`);
    }

    // 4. FOR EACH THREAD: GENERATE HANDBOOK + SAVE AS FORMATTED DOC
    const savedHandbooks: string[] = [];
    const skippedDuplicates: string[] = [];
    const prehledEntries: Array<{ fileName: string; author: string; summary: string; detailedDesc: string; karelNotes: string }> = [];
    const processedThreadIds: string[] = [];
    const dateStr = new Date().toISOString().slice(0, 10);
    let prehledChanged = false;

    for (const thread of activeThreads) {
      const msgs = (thread.messages || []) as { role: string; content: string }[];
      if (msgs.length < 2) {
        console.log(`[sync] Skipping thread "${thread.topic}" – too few messages`);
        continue;
      }

      const normalizedCreatedBy = thread.created_by === "Káťa" ? "Káťa" : (thread.created_by || "Hana");
      const osobniOsloveni = normalizedCreatedBy === "Káťa" ? "Káťo" : "Haničko";

      // 4a. Generate handbook via AI
      let handbook: any = null;
      try {
        // Perplexity enrichment
        let perplexityEnrichment = "";
        if (PERPLEXITY_API_KEY) {
          try {
            const pxRes = await fetch("https://api.perplexity.ai/chat/completions", {
              method: "POST",
              headers: { Authorization: `Bearer ${PERPLEXITY_API_KEY}`, "Content-Type": "application/json" },
              body: JSON.stringify({
                model: "sonar-pro",
                messages: [
                  { role: "system", content: "Jsi výzkumný asistent zaměřený na psychoterapii. Hledej odborné články relevantní k zadanému tématu. Odpověz česky." },
                  { role: "user", content: `Najdi odborné zdroje k tématu: "${thread.topic}". Zaměř se na konkrétní terapeutické techniky a evidence-based přístupy.` },
                ],
                search_mode: "academic",
              }),
            });
            if (pxRes.ok) {
              const pxData = await pxRes.json();
              perplexityEnrichment = pxData.choices?.[0]?.message?.content || "";
              const citations = pxData.citations || [];
              if (citations.length > 0) {
                perplexityEnrichment += "\n\nZdroje:\n" + citations.map((c: string, i: number) => `[${i + 1}] ${c}`).join("\n");
              }
            }
          } catch (e) { console.warn(`[sync] Perplexity enrichment failed for "${thread.topic}":`, e); }
        }

        const conversationText = msgs
          .map((m) => `${m.role === "user" ? normalizedCreatedBy : "Karel"}: ${typeof m.content === "string" ? m.content : "(multimodal)"}`)
          .join("\n\n");

        const synthesisPrompt = `Jsi Karel, supervizní AI asistent. Na základě rozhovoru s terapeutem/kou (${normalizedCreatedBy}) vytvoř STRUKTUROVANOU PŘÍRUČKU.

PRAVIDLO OSLOVENÍ: Příručka je pro ${normalizedCreatedBy}. Oslovuj "${osobniOsloveni}". Nepředstavuj se jako "tady Karel".

ROZHOVOR:
${conversationText}

${perplexityEnrichment ? `DOPLŇUJÍCÍ ODBORNÉ INFORMACE:\n${perplexityEnrichment}` : ""}

Vytvoř příručku v JSON formátu:
{
  "topic": "stručný název tématu (maximálně 80 znaků, bez data, jen tematický popis)",
  "createdBy": "${normalizedCreatedBy}",
  "summary": "shrnutí v 3-5 větách",
  "activities": [
    {
      "name": "NÁZEV metody",
      "target_group": "pro koho",
      "goal": "účel",
      "principle": "psychologický princip",
      "materials": ["seznam pomůcek"],
      "introduction": "jak uvést",
      "steps": ["krok 1", "krok 2"],
      "expected_course": "očekávaný průběh",
      "expected_outcome": "očekávaný výsledek",
      "diagnostic_watch": ["na co pozor"],
      "warnings": ["bezpečnostní poznámky"],
      "difficulty": "snadné|střední|pokročilé",
      "duration": "délka"
    }
  ],
  "general_tips": ["tipy"],
  "sources": [{"title": "název", "url": "URL", "description": "popis"}],
  "karel_notes": "Karlovy poznámky pro ${osobniOsloveni}"
}

PRAVIDLA:
- Každá aktivita = kompletní návod
- Piš česky
- NEVYMÝŠLEJ citace – používej jen zdroje z rozhovoru a rešerše
- NEPOUŽÍVEJ hvězdičky (**), vlnovky (~~), ani jiné markdown prvky v textu
- Text musí být čistý, bez dekorativních symbolů`;

        const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
          method: "POST",
          headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "google/gemini-2.5-flash",
            messages: [
              { role: "system", content: "Jsi klinický supervizní asistent. Odpovídej VŽDY validním JSON. NIKDY nepoužívej markdown prvky (**, ~~, #) v hodnotách." },
              { role: "user", content: synthesisPrompt },
            ],
            response_format: { type: "json_object" },
          }),
        });

        if (response.ok) {
          const data = await response.json();
          const content = data.choices?.[0]?.message?.content || "{}";
          try {
            handbook = JSON.parse(content);
          } catch {
            handbook = { topic: thread.topic, summary: content, activities: [], general_tips: [], sources: [], karel_notes: "" };
          }
        } else {
          console.error(`[sync] AI synthesis failed for "${thread.topic}": ${response.status}`);
        }
      } catch (e) {
        console.error(`[sync] Handbook generation failed for "${thread.topic}":`, e);
      }

      if (!handbook) continue;

      // 4b. Create descriptive filename from topic (clean, no markdown artifacts)
      const topicName = (handbook.topic || thread.topic || "Bez_tematu")
        .replace(/\*\*/g, "")
        .replace(/~~/g, "")
        .replace(/[#*~`]/g, "")
        .replace(/[^a-zA-Zá-žÁ-Ž0-9\s()–\-,]/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 80);

      // 4c. DEDUPLICATION: Check fuzzy match against ALL existing files in 07_Knihovna
      // Refresh file list to catch docs created earlier in this run
      const currentKnihovnaFiles = await listFilesInFolder(token, knihovnaFolderId);
      if (isTopicDuplicate(topicName, currentKnihovnaFiles)) {
        console.log(`[sync] Duplicate detected: "${topicName}" – skipping`);
        skippedDuplicates.push(topicName);
        processedThreadIds.push(thread.id);
        continue;
      }

      // 4d. Create empty Google Doc, then write formatted content via Docs API
      try {
        const newDoc = await createDocInFolder(token, topicName, knihovnaFolderId);
        await writeFormattedHandbook(token, newDoc.id, handbook);
        savedHandbooks.push(topicName);
        processedThreadIds.push(thread.id);
        console.log(`[sync] Saved formatted handbook: "${topicName}"`);
      } catch (e) {
        console.error(`[sync] Failed to save "${topicName}":`, e);
        continue;
      }

      // 4e. Build prehled entry - find the actual saved filename (Google Doc name)
      // We need to list files again to get exact name with any extension
      const latestFiles = await listFilesInFolder(token, knihovnaFolderId);
      const savedFile = latestFiles.find(f => canonicalText(f.name) === canonicalText(topicName));
      const exactFileName = savedFile ? savedFile.name : topicName;

      prehledEntries.push({
        fileName: exactFileName,
        author: normalizedCreatedBy,
        summary: (handbook.summary || "").slice(0, 300),
        detailedDesc: (handbook.activities || []).map((a: any) => a.name).join(", ").slice(0, 300) || handbook.summary || "",
        karelNotes: (handbook.karel_notes || "").slice(0, 500),
      });
    }

    // 5. CLEAN + UPDATE 00_Prehled (no duplicate reconciliation records)
    if (prehledFile) {
      try {
        let prehledContent = "";
        try {
          prehledContent = await readGoogleDoc(token, prehledFile.id);
        } catch (e) {
          console.warn("[sync] Could not read 00_Prehled for reconciliation:", e);
        }

        // 5a. Cleanup duplicate reconciliation block from previous runs
        const { cleaned, changed } = cleanupReconFromPrehled(prehledContent);
        if (changed) {
          await updateGoogleDocInPlace(token, prehledFile.id, cleaned);
          prehledContent = cleaned;
          prehledChanged = true;
          console.log("[sync] Removed stale reconciliation duplicates from 00_Prehled");
        }

        const allKnihovnaFiles = await listFilesInFolder(token, knihovnaFolderId);
        const prehledCanonical = canonicalText(prehledContent);
        const listedSourceCanonicals = extractListedSourceCanonicals(prehledContent);

        // Collect entries to append in this run
        const entriesToAdd: Array<{ fileName: string; author: string; summary: string }> = [];

        // Add new handbook entries
        for (const entry of prehledEntries) {
          const entryCanonical = canonicalSourceName(entry.fileName);
          if (!entryCanonical) continue;
          if (listedSourceCanonicals.has(entryCanonical)) continue;
          entriesToAdd.push(entry);
          listedSourceCanonicals.add(entryCanonical);
        }

        // Reconcile ALL files in 07_Knihovna (any extension), except 00_Prehled itself
        for (const file of allKnihovnaFiles) {
          if (canonicalText(file.name).startsWith("00prehled")) continue;
          if (file.mimeType === DRIVE_FOLDER_MIME) continue;

          const fileCanonical = canonicalSourceName(file.name);
          if (!fileCanonical || fileCanonical.length < 6) continue;

          // Strict canonical set check + fallback fuzzy check against full document text
          if (listedSourceCanonicals.has(fileCanonical)) continue;
          const fuzzyPrefix = fileCanonical.slice(0, Math.max(8, Math.floor(fileCanonical.length * 0.6)));
          if (prehledCanonical.includes(fileCanonical) || prehledCanonical.includes(fuzzyPrefix)) {
            listedSourceCanonicals.add(fileCanonical);
            continue;
          }

          console.log(`[sync] Reconciling missing file: "${file.name}"`);

          // Read the actual document content and generate a real summary
          let fileSummary = "";
          let fileKarelNotes = "";
          try {
            if (file.mimeType === DRIVE_DOC_MIME) {
              const docContent = await readGoogleDoc(token, file.id);
              if (docContent && docContent.length > 50) {
                // Use AI to generate a concise summary
                const summaryRes = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
                  method: "POST",
                  headers: { Authorization: `Bearer ${LOVABLE_API_KEY}`, "Content-Type": "application/json" },
                  body: JSON.stringify({
                    model: "google/gemini-2.5-flash-lite",
                    messages: [
                      { role: "system", content: "Jsi stručný odborný asistent. Odpověz POUZE JSON objektem." },
                      { role: "user", content: `Na základě tohoto textu vytvoř stručné shrnutí (2-3 věty, co to je a k čemu to slouží) a Karlovy připomínky (1-2 věty, odborná rada). NEPOUŽÍVEJ markdown. Odpověz JSON: {"summary": "...", "karelNotes": "..."}\n\nTEXT:\n${docContent.slice(0, 3000)}` },
                    ],
                    response_format: { type: "json_object" },
                  }),
                });
                if (summaryRes.ok) {
                  const summaryData = await summaryRes.json();
                  try {
                    const parsed = JSON.parse(summaryData.choices?.[0]?.message?.content || "{}");
                    fileSummary = parsed.summary || "";
                    fileKarelNotes = parsed.karelNotes || "";
                  } catch {}
                }
              }
            }
          } catch (e) {
            console.warn(`[sync] Could not summarize "${file.name}":`, e);
          }

          entriesToAdd.push({
            fileName: file.name,
            author: "neuvedeno",
            summary: fileSummary || "Zdroj uložený v 07_Knihovna.",
            detailedDesc: "",
            karelNotes: fileKarelNotes || "",
          });
          listedSourceCanonicals.add(fileCanonical);
        }

        // 5b. Append new entries in required architecture (no weekly headers)
        if (entriesToAdd.length > 0) {
          const existingSourceCount = countExistingSources(prehledContent);
          const formattedEntries = entriesToAdd.map((e, i) => {
            const sourceNum = existingSourceCount + i + 1;
            const numStr = String(sourceNum).padStart(2, "0");
            const authorLabel = e.author === "Káťa" ? "Vyhledala Káťa" : (e.author === "neuvedeno" ? "Neuvedeno" : "Vyhledala Hana");
            return [
              `ZDROJ_${numStr}_${dateStr}:`,
              `Téma: ${e.fileName.replace(/\.\w{2,5}$/, "")}`,
              `Záznam: ${authorLabel}. ${e.summary}`,
              `Podrobný popis: ${e.detailedDesc || "Viz příručka v 07_Knihovna."}`,
              `Karlovy připomínky a úkoly: ${e.karelNotes || "Bude doplněno při další aktualizaci."}`,
              `Zkušenosti terapeutů: [ ]`,
              `Karlova dodatečná reakce: [ ]`,
            ].join("\n");
          }).join("\n\n---\n\n");

          await appendToGoogleDoc(token, prehledFile.id, formattedEntries);
          prehledChanged = true;
          console.log(`[sync] 00_Prehled updated with ${entriesToAdd.length} new entries`);
        } else {
          console.log("[sync] No new entries for 00_Prehled");
        }
      } catch (e) {
        console.error("[sync] Failed to update 00_Prehled:", e);
      }
    }

    // 6. MARK ONLY SUCCESSFULLY HANDLED THREADS AS PROCESSED
    if (processedThreadIds.length > 0) {
      await sb
        .from("research_threads")
        .update({ is_processed: true, processed_at: new Date().toISOString() })
        .in("id", processedThreadIds);
    }

    return new Response(JSON.stringify({
      success: true,
      threadsProcessed: processedThreadIds.length,
      handbooksSaved: savedHandbooks,
      skippedDuplicates,
      prehledUpdated: prehledChanged,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Research weekly sync error:", error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
