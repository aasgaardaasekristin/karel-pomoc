import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const DRIVE_FOLDER_MIME = "application/vnd.google-apps.folder";

// ── Google OAuth ──
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
const stripDiacritics = (v: string) => v.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
const canonicalText = (v: string) => stripDiacritics(v || "").toLowerCase().replace(/[^a-z0-9]/g, "");

type DriveFile = { id: string; name: string; mimeType?: string };

async function listFilesInFolder(token: string, folderId: string): Promise<DriveFile[]> {
  const q = `'${folderId}' in parents and trashed=false`;
  const all: DriveFile[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({
      q, fields: "nextPageToken,files(id,name,mimeType)", pageSize: "200",
      supportsAllDrives: "true", includeItemsFromAllDrives: "true",
    });
    if (pageToken) params.set("pageToken", pageToken);
    const res = await fetch(`https://www.googleapis.com/drive/v3/files?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    all.push(...(data.files || []));
    pageToken = data.nextPageToken || undefined;
  } while (pageToken);
  return all;
}

async function resolveKartotekaRoot(token: string): Promise<string | null> {
  const q = `name='KARTOTEKA_DID' and mimeType='${DRIVE_FOLDER_MIME}' and trashed=false`;
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

async function findPlanFolder(token: string, rootId: string): Promise<string | null> {
  const files = await listFilesInFolder(token, rootId);
  // Look for 00_CENTRUM first, then 05_PLAN inside it
  const centrum = files.find(f => f.mimeType === DRIVE_FOLDER_MIME && canonicalText(f.name).includes("00centrum"));
  if (centrum) {
    const centrumFiles = await listFilesInFolder(token, centrum.id);
    const planFolder = centrumFiles.find(f => f.mimeType === DRIVE_FOLDER_MIME && canonicalText(f.name).includes("05plan"));
    if (planFolder) return planFolder.id;
  }
  // Fallback: direct search
  const direct = files.find(f => f.mimeType === DRIVE_FOLDER_MIME && canonicalText(f.name).includes("05plan"));
  return direct?.id || null;
}

async function find05AFile(token: string, folderId: string): Promise<string | null> {
  const files = await listFilesInFolder(token, folderId);
  const f = files.find(f => canonicalText(f.name).includes("operativni"));
  return f?.id || null;
}

async function find05BFile(token: string, folderId: string): Promise<string | null> {
  const files = await listFilesInFolder(token, folderId);
  const f = files.find(f => canonicalText(f.name).includes("strategick"));
  return f?.id || null;
}

// ── Google Docs write (clear + insert) ──
async function writeToGoogleDoc(token: string, fileId: string, content: string): Promise<void> {
  const docRes = await fetch(`https://docs.googleapis.com/v1/documents/${fileId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const doc = await docRes.json();
  const endIndex = doc.body?.content?.slice(-1)?.[0]?.endIndex || 1;

  if (endIndex > 2) {
    await fetch(`https://docs.googleapis.com/v1/documents/${fileId}:batchUpdate`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        requests: [{ deleteContentRange: { range: { startIndex: 1, endIndex: endIndex - 1 } } }],
      }),
    });
  }

  await fetch(`https://docs.googleapis.com/v1/documents/${fileId}:batchUpdate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      requests: [{ insertText: { location: { index: 1 }, text: content } }],
    }),
  });
}

// ── Plan item types ──
interface PlanItem {
  id: string;
  plan_type: string;
  section: string;
  subject_type?: string;
  subject_id?: string;
  content: string;
  priority?: string;
  action_required?: string;
  assigned_to?: string;
  due_date?: string;
  status?: string;
  review_at?: string;
  expires_at?: string;
  activation_conditions?: string;
  promotion_criteria?: string;
}

// ── Build 05A document ──
function build05A(items: PlanItem[]): string {
  const sections = {
    critical_72h: items.filter(i => i.section === "critical_72h" || i.section === "crisis_watch"),
    active_parts: items.filter(i => i.section === "active_parts"),
    pending_sessions: items.filter(i => i.section === "pending_sessions"),
    open_questions: items.filter(i => i.section === "open_questions"),
    team_capacity: items.filter(i => i.section === "team_capacity"),
    crisis_watch: items.filter(i => i.section === "crisis_watch"),
  };

  let doc = `# 05A – OPERATIVNÍ PLÁN (0-14 DNÍ)\nPoslední aktualizace: ${new Date().toISOString()}\n\n`;

  doc += "## 1. KRITICKÝ KONTEXT PŘÍŠTÍCH 72 HODIN\n\n";
  for (const item of sections.critical_72h) {
    doc += `### ${item.subject_id || "Systém"} [${(item.priority || "normal").toUpperCase()}]\n`;
    doc += `${item.content}\n`;
    if (item.action_required) doc += `**Akce:** ${item.action_required}\n`;
    if (item.assigned_to) doc += `**Zodpovídá:** ${item.assigned_to}\n`;
    if (item.due_date) doc += `**Deadline:** ${item.due_date}\n`;
    doc += `**Revize:** ${item.review_at?.slice(0, 10) || "N/A"}\n`;
    doc += `**Stav:** ${item.status}\n\n`;
  }

  doc += "## 2. AKTIVNÍ ČÁSTI A OPERATIVNÍ PRIORITY\n\n";
  for (const item of sections.active_parts) {
    doc += `### ${item.subject_id}\n`;
    doc += `- **Proč je v 05A:** ${item.content}\n`;
    if (item.action_required) doc += `- **Co se má udělat:** ${item.action_required}\n`;
    if (item.assigned_to) doc += `- **Kdo:** ${item.assigned_to}\n`;
    if (item.due_date) doc += `- **Dokdy:** ${item.due_date}\n`;
    doc += "\n";
  }

  doc += "## 3. ROZPRACOVANÁ / NAVAZUJÍCÍ SEZENÍ\n\n";
  for (const item of sections.pending_sessions) {
    doc += `- ${item.subject_id}: ${item.content}\n`;
  }
  doc += "\n";

  doc += "## 4. OTEVŘENÉ OTÁZKY A CHYBĚJÍCÍ DATA\n\n";
  for (const item of sections.open_questions) {
    doc += `- ${item.content}`;
    if (item.assigned_to) doc += ` → čeká na: ${item.assigned_to}`;
    doc += "\n";
  }
  doc += "\n";

  doc += "## 5. OMEZENÍ A KAPACITY TÝMU\n\n";
  for (const item of sections.team_capacity) {
    doc += `- ${item.content}\n`;
  }
  doc += "\n";

  doc += "## 6. KRIZOVÉ / ZVÝŠENĚ SLEDOVANÉ POLOŽKY\n\n";
  for (const item of sections.crisis_watch) {
    doc += `🔴 **${item.subject_id}**: ${item.content}\n`;
    if (item.action_required) doc += `   Akce: ${item.action_required}\n`;
    doc += `   Revize: ${item.review_at?.slice(0, 10) || "N/A"}\n\n`;
  }

  if (items.length === 0) {
    doc += "_Žádné aktivní operativní položky._\n";
  }

  return doc;
}

// ── Build 05B document ──
function build05B(items: PlanItem[]): string {
  const sections = {
    therapy_lines: items.filter(i => i.section === "therapy_lines"),
    parts_readiness: items.filter(i => i.section === "parts_readiness"),
    candidate_interventions: items.filter(i => i.section === "candidate_interventions"),
    blockers: items.filter(i => i.section === "blockers"),
    team_trends: items.filter(i => i.section === "team_trends"),
    promotion_criteria: items.filter(i => i.section === "promotion_criteria"),
  };

  let doc = `# 05B – STRATEGICKÝ VÝHLED (15-60 DNÍ)\nPoslední aktualizace: ${new Date().toISOString()}\n\n`;

  doc += "## 1. HLAVNÍ STŘEDNĚDOBÉ LINIE PRÁCE\n\n";
  for (const item of sections.therapy_lines) {
    doc += `### ${item.subject_id || "Systém"} [${(item.priority || "normal").toUpperCase()}]\n`;
    doc += `${item.content}\n`;
    if (item.action_required) doc += `**Plán:** ${item.action_required}\n`;
    if (item.activation_conditions) doc += `**Podmínky aktivace:** ${item.activation_conditions}\n`;
    if (item.promotion_criteria) doc += `**Kritéria povýšení do 05A:** ${item.promotion_criteria}\n`;
    doc += `**Revize:** ${item.review_at?.slice(0, 10) || "N/A"}\n\n`;
  }

  doc += "## 2. ČÁSTI DOPORUČENÉ K PRÁCI (15-60 DNÍ)\n\n";
  doc += "### A. Aktivní / dostupné\n";
  for (const item of sections.parts_readiness.filter(i => i.content?.includes("[AKTIVNÍ]"))) {
    doc += `- ${item.subject_id}: ${item.content}\n`;
  }
  doc += "\n### B. Podmíněně dostupné\n";
  for (const item of sections.parts_readiness.filter(i => i.content?.includes("[PODMÍNĚNÁ]"))) {
    doc += `- ${item.subject_id}: ${item.content}\n`;
    if (item.activation_conditions) doc += `  Podmínky: ${item.activation_conditions}\n`;
  }
  doc += "\n### C. Zatím neplánovat aktivaci\n";
  for (const item of sections.parts_readiness.filter(i => i.content?.includes("[NEAKTIVOVAT]"))) {
    doc += `- ${item.subject_id}: ${item.content}\n`;
  }
  doc += "\n";

  doc += "## 3. KANDIDÁTNÍ INTERVENCE Z KARET\n\n";
  for (const item of sections.candidate_interventions) {
    doc += `- ${item.subject_id}: ${item.content}\n`;
  }
  doc += "\n";

  doc += "## 4. BLOKÁTORY A READINESS PODMÍNKY\n\n";
  for (const item of sections.blockers) {
    doc += `- ${item.content}\n`;
  }
  doc += "\n";

  doc += "## 5. TRENDY V PRÁCI TÝMU\n\n";
  for (const item of sections.team_trends) {
    doc += `- ${item.content}\n`;
  }
  doc += "\n";

  doc += "## 6. KRITÉRIA PRO POVÝŠENÍ Z 05B DO 05A\n\n";
  for (const item of sections.promotion_criteria) {
    doc += `- ${item.subject_id}: ${item.promotion_criteria || item.content}\n`;
  }

  if (items.length === 0) {
    doc += "_Žádné aktivní strategické položky._\n";
  }

  return doc;
}

// ══════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const sb = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    let trigger = "manual";
    try {
      const body = await req.json();
      trigger = body?.trigger || "manual";
    } catch { /* empty body is fine */ }

    console.log(`[post-intervention-sync] Started. Trigger: ${trigger}`);

    // ── 1. Load unsynced implications ──
    const { data: unsyncedImpl } = await sb
      .from("did_implications")
      .select("*")
      .eq("synced", false)
      .order("created_at", { ascending: true });

    console.log(`[post-intervention-sync] Unsynced implications: ${unsyncedImpl?.length || 0}`);

    // ── 2. Load active plan_items for 05A ──
    const { data: items05A } = await sb
      .from("did_plan_items")
      .select("*")
      .eq("plan_type", "05A")
      .eq("status", "active")
      .order("created_at", { ascending: false });

    // ── 3. Load active plan_items for 05B ──
    const { data: items05B } = await sb
      .from("did_plan_items")
      .select("*")
      .eq("plan_type", "05B")
      .eq("status", "active")
      .order("created_at", { ascending: false });

    console.log(`[post-intervention-sync] Plan items: 05A=${items05A?.length || 0}, 05B=${items05B?.length || 0}`);

    // ── 4. Build documents ──
    const doc05A = build05A((items05A || []) as PlanItem[]);
    const doc05B = build05B((items05B || []) as PlanItem[]);

    // ── 5. Find Drive files ──
    let driveWritten = false;
    try {
      const token = await getAccessToken();
      const rootId = await resolveKartotekaRoot(token);
      if (!rootId) throw new Error("KARTOTEKA_DID root not found");

      const planFolderId = await findPlanFolder(token, rootId);
      if (!planFolderId) throw new Error("05_PLAN folder not found");

      const file05AId = await find05AFile(token, planFolderId);
      const file05BId = await find05BFile(token, planFolderId);

      console.log(`[post-intervention-sync] Drive files: 05A=${file05AId}, 05B=${file05BId}`);

      // ── 6. Write to Drive ──
      if (file05AId) {
        await writeToGoogleDoc(token, file05AId, doc05A);
        console.log("[post-intervention-sync] 05A written to Drive");
      }
      if (file05BId) {
        await writeToGoogleDoc(token, file05BId, doc05B);
        console.log("[post-intervention-sync] 05B written to Drive");
      }
      driveWritten = true;
    } catch (driveErr) {
      console.error("[post-intervention-sync] Drive write failed (non-fatal):", driveErr);
    }

    // ── 7. Mark implications as synced ──
    let syncedCount = 0;
    for (const impl of (unsyncedImpl || [])) {
      await sb.from("did_implications")
        .update({ synced: true, synced_at: new Date().toISOString() })
        .eq("id", impl.id);

      await sb.from("did_doc_sync_log").insert({
        source_type: "implication",
        source_id: impl.id,
        target_document: (impl.destinations || []).join(", "),
        content_written: (impl.implication_text || "").slice(0, 500),
        success: driveWritten,
      });
      syncedCount++;
    }

    // ── 8. Expire old plan_items ──
    const now = new Date().toISOString();
    const { data: expired } = await sb
      .from("did_plan_items")
      .update({ status: "expired" })
      .eq("status", "active")
      .lt("expires_at", now)
      .select("id");

    const expiredCount = expired?.length || 0;
    console.log(`[post-intervention-sync] Expired items: ${expiredCount}`);

    console.log(`[post-intervention-sync] Done. Synced: ${syncedCount}, 05A: ${items05A?.length || 0}, 05B: ${items05B?.length || 0}`);

    return new Response(JSON.stringify({
      trigger,
      synced_implications: syncedCount,
      items_05A: items05A?.length || 0,
      items_05B: items05B?.length || 0,
      expired: expiredCount,
      drive_written: driveWritten,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("[post-intervention-sync] Error:", error);
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
