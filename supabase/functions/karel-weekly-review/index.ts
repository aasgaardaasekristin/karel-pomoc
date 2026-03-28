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
  const centrum = files.find(f => f.mimeType === DRIVE_FOLDER_MIME && canonicalText(f.name).includes("00centrum"));
  if (centrum) {
    const centrumFiles = await listFilesInFolder(token, centrum.id);
    const planFolder = centrumFiles.find(f => f.mimeType === DRIVE_FOLDER_MIME && canonicalText(f.name).includes("05plan"));
    if (planFolder) return planFolder.id;
  }
  const direct = files.find(f => f.mimeType === DRIVE_FOLDER_MIME && canonicalText(f.name).includes("05plan"));
  return direct?.id || null;
}

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

// ── Weekly report builder ──
function buildWeeklyReport(data: {
  weekObs: any[];
  weekClaims: any[];
  weekPlans: any[];
  weekQuestions: any[];
  activeParts: string[];
  observedParts: string[];
  silentParts: string[];
  oldHypotheses: any[];
  staleItems: any[];
}): string {
  const now = new Date().toISOString().slice(0, 10);
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  let doc = `# TÝDENNÍ REVIEW KARLA\n`;
  doc += `Období: ${weekAgo} – ${now}\n\n`;

  // 1. Přehled aktivity
  doc += `## 1. PŘEHLED AKTIVITY\n\n`;
  doc += `- Observations vytvořeno: ${data.weekObs.length}\n`;
  doc += `- Profile claims aktualizováno: ${data.weekClaims.length}\n`;
  doc += `- Plan items změněno: ${data.weekPlans.length}\n`;
  doc += `- Otázky položeno: ${data.weekQuestions.length}\n`;
  doc += `- Aktivní části: ${data.activeParts.join(", ") || "žádné"}\n`;
  doc += `- Pozorované části: ${data.observedParts.join(", ") || "žádné"}\n\n`;

  // 2. Slepá místa
  doc += `## 2. SLEPÁ MÍSTA\n\n`;
  if (data.silentParts.length > 0) {
    doc += `⚠️ Části s aktivitou ale BEZ observations:\n`;
    for (const p of data.silentParts) doc += `- ${p}\n`;
    doc += `\n→ Karel z těchto vláken nic neextrahoval. Ověřit proč.\n\n`;
  } else {
    doc += `✅ Všechny aktivní části mají observations.\n\n`;
  }

  // 3. Nepotvrzené hypotézy
  doc += `## 3. NEPOTVRZENÉ HYPOTÉZY (>7 dní)\n\n`;
  if (data.oldHypotheses.length > 0) {
    for (const h of data.oldHypotheses.slice(0, 10)) {
      doc += `- ${h.part_name}/${h.card_section}: ${h.claim_text}\n`;
      doc += `  _Vytvořeno: ${h.created_at?.slice(0, 10)}, potvrzení: ${h.confirmation_count}_\n`;
    }
    doc += `\n→ Zvážit cílené ověření v nadcházejících sezeních.\n\n`;
  } else {
    doc += `✅ Žádné staré nepotvrzené hypotézy.\n\n`;
  }

  // 4. Stagnující položky
  doc += `## 4. STAGNUJÍCÍ PLAN ITEMS\n\n`;
  if (data.staleItems.length > 0) {
    for (const item of data.staleItems.slice(0, 10)) {
      doc += `- [${item.plan_type}/${item.section}] ${item.subject_id}: ${item.content?.slice(0, 100)}\n`;
      doc += `  _Review měl proběhnout: ${item.review_at?.slice(0, 10)}_\n`;
    }
    doc += `\n→ Aktualizovat nebo uzavřít.\n\n`;
  } else {
    doc += `✅ Žádné stagnující položky.\n\n`;
  }

  // 5. Otevřené otázky
  doc += `## 5. OTEVŘENÉ OTÁZKY TOHOTO TÝDNE\n\n`;
  const openQ = data.weekQuestions.filter((q: any) => q.status === "open");
  if (openQ.length > 0) {
    for (const q of openQ.slice(0, 10)) {
      doc += `- [${q.subject_id || "systém"}] ${q.question}\n`;
    }
  } else {
    doc += `✅ Žádné nové otevřené otázky.\n`;
  }

  // 6. Doporučení
  doc += `\n## 6. DOPORUČENÍ PRO PŘÍŠTÍ TÝDEN\n\n`;
  if (data.silentParts.length > 0) {
    doc += `1. Zaměřit pozornost na: ${data.silentParts.join(", ")}\n`;
  }
  if (data.oldHypotheses.length > 0) {
    doc += `2. Ověřit ${data.oldHypotheses.length} nepotvrzených hypotéz\n`;
  }
  if (data.staleItems.length > 0) {
    doc += `3. Revidovat ${data.staleItems.length} stagnujících položek\n`;
  }
  if (data.silentParts.length === 0 && data.oldHypotheses.length === 0 && data.staleItems.length === 0) {
    doc += `✅ Žádné urgentní akce. Pokračovat v nastaveném režimu.\n`;
  }

  return doc;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const sb = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    console.log("[weekly-review] Started");

    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    // ── 1. Statistiky týdne ──
    const { data: weekObs } = await sb.from("did_observations")
      .select("id, subject_type, subject_id, evidence_level, time_horizon")
      .gte("created_at", weekAgo);

    const { data: weekClaims } = await sb.from("did_profile_claims")
      .select("id, part_name, claim_type, status")
      .gte("updated_at", weekAgo);

    const { data: weekPlans } = await sb.from("did_plan_items")
      .select("id, plan_type, status, section")
      .gte("updated_at", weekAgo);

    const { data: weekQuestions } = await sb.from("did_pending_questions")
      .select("id, status, subject_id, question")
      .gte("created_at", weekAgo);

    // ── 2. Identifikuj "tiché" části ──
    const { data: allParts } = await sb.from("did_threads")
      .select("part_name")
      .gte("last_activity_at", weekAgo);

    const activeParts = [...new Set((allParts || []).map((t: any) => t.part_name).filter(Boolean))];

    const observedParts = [...new Set(
      (weekObs || []).filter((o: any) => o.subject_type === "part").map((o: any) => o.subject_id)
    )];

    const silentParts = activeParts.filter((p: string) => !observedParts.includes(p));

    // ── 3. Nepotvrzené hypotézy ──
    const { data: oldHypotheses } = await sb.from("did_profile_claims")
      .select("*")
      .eq("claim_type", "hypothesis")
      .eq("status", "active")
      .eq("confirmation_count", 1)
      .lt("created_at", weekAgo);

    // ── 4. Stagnující plan_items ──
    const { data: staleItems } = await sb.from("did_plan_items")
      .select("*")
      .eq("status", "active")
      .lt("review_at", new Date().toISOString());

    // ── 5. Sestav report ──
    const report = buildWeeklyReport({
      weekObs: weekObs || [],
      weekClaims: weekClaims || [],
      weekPlans: weekPlans || [],
      weekQuestions: weekQuestions || [],
      activeParts,
      observedParts,
      silentParts,
      oldHypotheses: oldHypotheses || [],
      staleItems: staleItems || [],
    });

    // ── 6. Zapiš report na Drive ──
    try {
      const token = await getAccessToken();
      const rootId = await resolveKartotekaRoot(token);
      if (rootId) {
        const planFolderId = await findPlanFolder(token, rootId);
        if (planFolderId) {
          const files = await listFilesInFolder(token, planFolderId);
          const weeklyFile = files.find(f =>
            canonicalText(f.name).includes("tydenni") || canonicalText(f.name).includes("weekly")
          );

          if (weeklyFile) {
            await writeToGoogleDoc(token, weeklyFile.id, report);
            console.log("[weekly-review] Updated existing weekly review file");
          } else {
            const createRes = await fetch("https://www.googleapis.com/drive/v3/files", {
              method: "POST",
              headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                name: "06_Tydenni_Review",
                mimeType: "application/vnd.google-apps.document",
                parents: [planFolderId],
              }),
            });
            const newFile = await createRes.json();
            if (newFile.id) {
              await writeToGoogleDoc(token, newFile.id, report);
              console.log("[weekly-review] Created new weekly review file");
            }
          }
        }
      }
    } catch (driveErr) {
      console.warn("[weekly-review] Drive write error:", driveErr);
    }

    // ── 7. Vyčisti staré hypotézy (>30 dní, 1 potvrzení) ──
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const { data: expiredHypo } = await sb.from("did_profile_claims")
      .update({ status: "expired" })
      .eq("claim_type", "hypothesis")
      .eq("status", "active")
      .eq("confirmation_count", 1)
      .lt("created_at", thirtyDaysAgo)
      .select("id");

    if (expiredHypo?.length) {
      console.log(`[weekly-review] Expired ${expiredHypo.length} old hypotheses`);
    }

    // ── 8. Archivuj staré observations (>90 dní) ──
    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    const { data: archivedObs } = await sb.from("did_observations")
      .update({ status: "archived" })
      .eq("status", "active")
      .lt("created_at", ninetyDaysAgo)
      .select("id");

    if (archivedObs?.length) {
      console.log(`[weekly-review] Archived ${archivedObs.length} old observations`);
    }

    console.log("[weekly-review] Done");

    return new Response(JSON.stringify({
      observations_this_week: weekObs?.length || 0,
      claims_updated: weekClaims?.length || 0,
      active_parts: activeParts.length,
      silent_parts: silentParts,
      old_hypotheses: oldHypotheses?.length || 0,
      stale_items: staleItems?.length || 0,
      expired_hypotheses: expiredHypo?.length || 0,
      archived_observations: archivedObs?.length || 0,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("[weekly-review] Error:", e);
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : "Unknown" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
