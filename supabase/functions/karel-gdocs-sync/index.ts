import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

/* ── Google OAuth token ── */
async function getAccessToken(): Promise<string> {
  const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
  const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET");
  const refreshToken = Deno.env.get("GOOGLE_REFRESH_TOKEN");
  if (!clientId || !clientSecret || !refreshToken) throw new Error("Missing Google OAuth credentials");

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(`Token error: ${JSON.stringify(data)}`);
  return data.access_token;
}

/* ── Drive helpers ── */
async function findFolder(token: string, name: string, parentId?: string): Promise<string | null> {
  let q = `name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  if (parentId) q += ` and '${parentId}' in parents`;
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id)&supportsAllDrives=true&includeItemsFromAllDrives=true`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const data = await res.json();
  return data.files?.[0]?.id || null;
}

async function createFolder(token: string, name: string, parentId?: string): Promise<string> {
  const metadata: Record<string, unknown> = { name, mimeType: "application/vnd.google-apps.folder" };
  if (parentId) metadata.parents = [parentId];
  const res = await fetch("https://www.googleapis.com/drive/v3/files?supportsAllDrives=true", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(metadata),
  });
  const data = await res.json();
  if (!data.id) throw new Error(`Failed to create folder ${name}: ${JSON.stringify(data)}`);
  return data.id;
}

async function ensureFolder(token: string, name: string, parentId?: string): Promise<string> {
  const existing = await findFolder(token, name, parentId);
  if (existing) return existing;
  return createFolder(token, name, parentId);
}

/* ── Check if a Doc exists (returns false on 404) ── */
async function docExists(token: string, docId: string): Promise<boolean> {
  const res = await fetch(
    `https://docs.googleapis.com/v1/documents/${docId}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  return res.ok;
}

/* ── Create a new Google Doc in a folder ── */
async function createDoc(token: string, title: string, folderId: string): Promise<{ id: string; url: string }> {
  // 1. Create doc
  const createRes = await fetch("https://docs.googleapis.com/v1/documents", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
  const docData = await createRes.json();
  if (!docData.documentId) throw new Error(`Failed to create doc: ${JSON.stringify(docData)}`);

  // 2. Move to folder
  await fetch(
    `https://www.googleapis.com/drive/v3/files/${docData.documentId}?addParents=${folderId}&supportsAllDrives=true`,
    { method: "PATCH", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } }
  );

  return {
    id: docData.documentId,
    url: `https://docs.google.com/document/d/${docData.documentId}/edit`,
  };
}

/* ── Get doc length (endIndex) ── */
async function getDocEndIndex(token: string, docId: string): Promise<number> {
  const res = await fetch(
    `https://docs.googleapis.com/v1/documents/${docId}?fields=body.content`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const data = await res.json();
  const content = data?.body?.content;
  if (!content || content.length === 0) return 1;
  return content[content.length - 1].endIndex - 1;
}

/* ── Write full doc content with native formatting ── */
async function writeDocContent(token: string, docId: string, sections: { heading: string; level: string; body: string }[]) {
  // 1. Clear existing content
  const endIdx = await getDocEndIndex(token, docId);
  const requests: any[] = [];

  if (endIdx > 1) {
    requests.push({
      deleteContentRange: {
        range: { startIndex: 1, endIndex: endIdx }
      }
    });
  }

  // 2. Build text and style ranges
  let fullText = "";
  const styleRanges: { start: number; end: number; style: string }[] = [];

  for (const section of sections) {
    const headingStart = fullText.length + 1; // +1 because doc starts at index 1
    fullText += section.heading + "\n";
    const headingEnd = fullText.length + 1;
    styleRanges.push({ start: headingStart, end: headingEnd - 1, style: section.level });

    if (section.body.trim()) {
      fullText += section.body + "\n\n";
    } else {
      fullText += "\n";
    }
  }

  // 3. Insert all text at once
  requests.push({
    insertText: { location: { index: 1 }, text: fullText }
  });

  // 4. Apply heading styles
  for (const range of styleRanges) {
    requests.push({
      updateParagraphStyle: {
        range: { startIndex: range.start, endIndex: range.end },
        paragraphStyle: { namedStyleType: range.style },
        fields: "namedStyleType",
      }
    });
  }

  // 5. Execute batch update
  const batchRes = await fetch(
    `https://docs.googleapis.com/v1/documents/${docId}:batchUpdate`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ requests }),
    }
  );

  if (!batchRes.ok) {
    const err = await batchRes.text();
    throw new Error(`Docs batchUpdate failed: ${err}`);
  }
}

/* ── Build document sections from client data ── */
function buildSections(client: any, sessions: any[], tasks: any[], analyses: any[]): { heading: string; level: string; body: string }[] {
  const sections: { heading: string; level: string; body: string }[] = [];
  const date = new Date().toISOString().slice(0, 10);

  // Title
  sections.push({
    heading: `KARTA KLIENTA: ${client.name}`,
    level: "HEADING_1",
    body: `Poslední aktualizace: ${date}`,
  });

  // Basic info
  const basicLines: string[] = [];
  if (client.age) basicLines.push(`Věk: ${client.age} let`);
  if (client.gender) basicLines.push(`Pohlaví: ${client.gender}`);
  if (client.diagnosis) basicLines.push(`Diagnóza: ${client.diagnosis}`);
  if (client.therapy_type) basicLines.push(`Typ terapie: ${client.therapy_type}`);
  if (client.referral_source) basicLines.push(`Zdroj doporučení: ${client.referral_source}`);
  if (client.key_history) basicLines.push(`Klíčová anamnéza: ${client.key_history}`);
  if (client.family_context) basicLines.push(`Rodinný kontext: ${client.family_context}`);

  sections.push({
    heading: "ZÁKLADNÍ INFORMACE",
    level: "HEADING_2",
    body: basicLines.join("\n") || "Dosud nevyplněno.",
  });

  // Therapy plan
  sections.push({
    heading: "TERAPEUTICKÝ PLÁN PROCESU",
    level: "HEADING_2",
    body: cleanMarkdown(client.therapy_plan) || "Dosud nevytvořen.",
  });

  // Sessions
  const sessionLines: string[] = [];
  const sortedSessions = [...sessions].sort((a, b) => (a.session_number || 0) - (b.session_number || 0));
  for (const s of sortedSessions) {
    sessionLines.push(`--- Sezení č. ${s.session_number ?? "?"} (${s.session_date}) ---`);
    if (s.report_key_theme) sessionLines.push(`Klíčové téma: ${s.report_key_theme}`);
    if (s.report_context) sessionLines.push(`Kontext: ${s.report_context}`);
    if (s.report_transference) sessionLines.push(`Přenos/protipřenos: ${s.report_transference}`);
    if (s.report_interventions_tried) sessionLines.push(`Intervence: ${s.report_interventions_tried}`);
    if (s.report_next_session_goal) sessionLines.push(`Cíl dalšího sezení: ${s.report_next_session_goal}`);
    if (s.report_missing_data) sessionLines.push(`Co ověřit: ${s.report_missing_data}`);
    if (s.report_therapist_emotions?.length > 0) sessionLines.push(`Emoce terapeuta: ${s.report_therapist_emotions.join(", ")}`);
    if (s.report_risks?.length > 0) sessionLines.push(`Rizika: ${s.report_risks.join(", ")}`);
    if (s.notes) sessionLines.push(`Poznámky: ${s.notes}`);
    sessionLines.push("");
  }

  sections.push({
    heading: "SEZENÍ",
    level: "HEADING_2",
    body: sessionLines.join("\n") || "Zatím žádná sezení.",
  });

  // Tasks
  const taskLines: string[] = [];
  for (const t of tasks) {
    const statusEmoji = t.status === "done" ? "✅" : t.status === "in_progress" ? "🔄" : "⬜";
    taskLines.push(`${statusEmoji} ${t.task} [${t.priority || "medium"}]${t.due_date ? ` (do ${t.due_date})` : ""}`);
    if (t.method) taskLines.push(`  Metoda: ${t.method}`);
    if (t.result) taskLines.push(`  Výsledek: ${t.result}`);
    if (t.answer) taskLines.push(`  Odpověď: ${t.answer}`);
  }

  sections.push({
    heading: "ÚKOLY A SLEDOVÁNÍ",
    level: "HEADING_2",
    body: taskLines.join("\n") || "Žádné úkoly.",
  });

  // Notes
  sections.push({
    heading: "POZNÁMKY TERAPEUTA",
    level: "HEADING_2",
    body: cleanMarkdown(client.notes) || "Žádné poznámky.",
  });

  // Analyses (latest)
  if (analyses.length > 0) {
    const latestAnalysis = analyses[0];
    let analysisText = "";
    try {
      const parsed = JSON.parse(latestAnalysis.content);
      if (parsed.clientProfile) analysisText += `Profil klienta:\n${parsed.clientProfile}\n\n`;
      if (parsed.diagnosticHypothesis?.primary) analysisText += `Diagnostická hypotéza: ${parsed.diagnosticHypothesis.primary}\n`;
      if (parsed.therapeuticProgress?.clientDynamics) analysisText += `Dynamika: ${parsed.therapeuticProgress.clientDynamics}\n`;
    } catch {
      analysisText = cleanMarkdown(latestAnalysis.content);
    }

    sections.push({
      heading: `ANALÝZA KARTY (v${latestAnalysis.version || 1}, ${new Date(latestAnalysis.created_at).toISOString().slice(0, 10)})`,
      level: "HEADING_2",
      body: analysisText || "Analýza není k dispozici.",
    });
  }

  return sections;
}

/* Strip markdown symbols for native doc formatting */
function cleanMarkdown(text: string | null | undefined): string {
  if (!text) return "";
  return text
    .replace(/#{1,6}\s*/g, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(/═{3,}/g, "")
    .replace(/─{3,}/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/* ── Main handler ── */
serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Auth
    const authHeader = req.headers.get("Authorization");
    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    let userId: string | null = null;
    if (authHeader && !authHeader.includes(Deno.env.get("SUPABASE_ANON_KEY")!)) {
      const userClient = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_ANON_KEY")!,
        { global: { headers: { Authorization: authHeader } } }
      );
      const { data: { user }, error: authErr } = await userClient.auth.getUser();
      if (authErr || !user) throw new Error("Unauthorized");
      userId = user.id;
    }

    // Parse body
    let body: any = {};
    try { body = await req.json(); } catch {}
    const { clientId } = body;

    const token = await getAccessToken();

    // Determine clients to sync
    let clientsToSync: any[] = [];

    if (clientId) {
      const { data: client, error } = await supabaseAdmin
        .from("clients")
        .select("*")
        .eq("id", clientId)
        .single();
      if (error || !client) throw new Error(`Client not found: ${clientId}`);
      clientsToSync = [client];
    } else {
      // Sync all clients for this user
      const query = supabaseAdmin.from("clients").select("*").order("name");
      if (userId) query.eq("user_id", userId);
      const { data, error } = await query;
      if (error) throw new Error(`Failed to fetch clients: ${error.message}`);
      clientsToSync = data || [];
    }

    const results: any[] = [];

    for (const client of clientsToSync) {
      try {
        // Fetch related data
        const [sessionsRes, tasksRes, analysesRes] = await Promise.all([
          supabaseAdmin.from("client_sessions").select("*").eq("client_id", client.id).order("session_number"),
          supabaseAdmin.from("client_tasks").select("*").eq("client_id", client.id).order("created_at"),
          supabaseAdmin.from("client_analyses").select("*").eq("client_id", client.id).order("created_at", { ascending: false }).limit(3),
        ]);

        const sessions = sessionsRes.data || [];
        const tasks = tasksRes.data || [];
        const analyses = analysesRes.data || [];

        // Ensure folder structure: ZALOHA / {clientId}
        const zalohaId = await ensureFolder(token, "ZALOHA");
        const clientFolderId = await ensureFolder(token, client.id, zalohaId);

        let docId = client.drive_doc_id;
        let docUrl = client.drive_doc_url;
        let needsDbUpdate = false;

        // Check if doc exists (handle 404 = deleted manually)
        if (docId) {
          const exists = await docExists(token, docId);
          if (!exists) {
            console.log(`[gdocs-sync] Doc ${docId} for ${client.name} returned 404, creating new one`);
            docId = null;
            docUrl = null;
            needsDbUpdate = true;
          }
        }

        // Create doc if needed
        if (!docId) {
          const doc = await createDoc(token, `Karta_${client.name}`, clientFolderId);
          docId = doc.id;
          docUrl = doc.url;
          needsDbUpdate = true;
        }

        // Always update DB with doc references
        if (needsDbUpdate) {
          await supabaseAdmin
            .from("clients")
            .update({ drive_doc_id: docId, drive_doc_url: docUrl })
            .eq("id", client.id);
        }

        // Build and write content
        const docSections = buildSections(client, sessions, tasks, analyses);
        await writeDocContent(token, docId, docSections);

        // Track sync timestamp
        const syncedAt = new Date().toISOString();
        await supabaseAdmin
          .from("clients")
          .update({ drive_last_synced_at: syncedAt })
          .eq("id", client.id);

        results.push({
          clientId: client.id,
          clientName: client.name,
          docId,
          docUrl,
          drive_last_synced_at: syncedAt,
          success: true,
        });

        console.log(`[gdocs-sync] Synced ${client.name} → ${docUrl}`);
      } catch (clientErr: any) {
        console.error(`[gdocs-sync] Error syncing ${client.name}:`, clientErr);
        results.push({
          clientId: client.id,
          clientName: client.name,
          success: false,
          error: clientErr.message,
        });
      }
    }

    const successCount = results.filter(r => r.success).length;
    const failCount = results.filter(r => !r.success).length;

    return new Response(JSON.stringify({
      success: failCount === 0,
      message: `Synchronizováno ${successCount} klient${successCount === 1 ? "" : "ů"} do Google Docs${failCount > 0 ? ` (${failCount} selhalo)` : ""}`,
      results,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (e: any) {
    console.error("[gdocs-sync] Error:", e);
    return new Response(JSON.stringify({ success: false, error: e.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
