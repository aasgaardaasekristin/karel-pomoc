/**
 * karel-drive-queue-processor v1
 *
 * Zpracovává frontu `did_pending_drive_writes`.
 * V1 podporuje pouze bezpečné cíle a append zápisy.
 *
 * Bezpečné cíle:
 *   - KARTA_{JMENO}         → append do karty části v kartotece
 *   - PAMET_KAREL/HANKA/SITUACNI_ANALYZA
 *   - PAMET_KAREL/KATA/SITUACNI_ANALYZA
 *   - PAMET_KAREL/KONTEXTY/KDO_JE_KDO
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  getAccessToken,
  resolveKartotekaRoot,
  findFolder,
  listFiles,
  findCardFileInFolder,
  appendToDoc,
  appendToFile,
  FOLDER_MIME,
  GDOC_MIME,
} from "../_shared/driveHelpers.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

// ── Allowed targets whitelist ──
const ALLOWED_TARGETS = [
  /^KARTA_.+$/,
  /^PAMET_KAREL\/DID\/HANKA\/SITUACNI_ANALYZA$/,
  /^PAMET_KAREL\/DID\/KATA\/SITUACNI_ANALYZA$/,
  /^PAMET_KAREL\/DID\/KONTEXTY\/KDO_JE_KDO$/,
  /^PAMET_KAREL\/DID\/HANKA\/PROFIL_OSOBNOSTI$/,
  /^PAMET_KAREL\/DID\/KATA\/PROFIL_OSOBNOSTI$/,
  /^KARTOTEKA_DID\/00_CENTRUM\/05A_OPERATIVNI_PLAN$/,
];

function isAllowedTarget(target: string): boolean {
  return ALLOWED_TARGETS.some((rx) => rx.test(target));
}

// ── Resolve PAMET_KAREL root (separate Drive root, NOT inside kartoteka) ──
async function resolvePametKarelRoot(token: string): Promise<string | null> {
  for (const name of ["PAMET_KAREL", "Pamet_Karel", "pamet_karel"]) {
    const id = await findFolder(token, name);
    if (id) return id;
  }
  return null;
}

// ── Resolve target to Drive file ID ──
async function resolveTarget(
  token: string,
  kartotekaRoot: string,
  target: string,
): Promise<string | null> {
  // KARTA_{NAME} → lives in KARTOTEKA_DID/01_AKTIVNI_FRAGMENTY (or 03_ARCHIV)
  if (target.startsWith("KARTA_")) {
    const partName = target.replace("KARTA_", "");
    console.log(`[resolve] Looking for part '${partName}' in kartoteka ${kartotekaRoot}`);

    const activeFolder = await findFolder(token, "01_AKTIVNI_FRAGMENTY", kartotekaRoot);
    if (activeFolder) {
      const items = await listFiles(token, activeFolder);
      // Items can be either folders (containing card file) or direct Google Docs
      for (const item of items) {
        if (!item.name.toUpperCase().includes(partName.toUpperCase())) continue;
        
        if (item.mimeType === FOLDER_MIME) {
          // Folder → find card file inside
          const cardFile = await findCardFileInFolder(token, item.id);
          if (cardFile) return cardFile.id;
        } else if (item.mimeType === GDOC_MIME) {
          // Direct Google Doc = the card itself
          return item.id;
        }
      }
    }

    const archiveFolder = await findFolder(token, "03_ARCHIV_SPICICH", kartotekaRoot);
    if (archiveFolder) {
      const items = await listFiles(token, archiveFolder);
      for (const item of items) {
        if (!item.name.toUpperCase().includes(partName.toUpperCase())) continue;
        
        if (item.mimeType === FOLDER_MIME) {
          const cardFile = await findCardFileInFolder(token, item.id);
          if (cardFile) return cardFile.id;
        } else if (item.mimeType === GDOC_MIME) {
          return item.id;
        }
      }
    }

    return null;
  }

  // KARTOTEKA_DID/... → navigate inside kartoteka root
  if (target.startsWith("KARTOTEKA_DID/")) {
    const segments = target.replace("KARTOTEKA_DID/", "").split("/");
    let currentFolder = kartotekaRoot;
    for (let i = 0; i < segments.length - 1; i++) {
      const nextFolder = await findFolder(token, segments[i], currentFolder);
      if (!nextFolder) return null;
      currentFolder = nextFolder;
    }
    const docName = segments[segments.length - 1];
    const files = await listFiles(token, currentFolder);
    const doc = files.find(
      (f) => f.mimeType === GDOC_MIME && f.name.toUpperCase().includes(docName.toUpperCase()),
    );
    return doc?.id || null;
  }

  // PAMET_KAREL/... → separate root on Drive, NOT inside kartoteka
  if (target.startsWith("PAMET_KAREL/")) {
    const pametRoot = await resolvePametKarelRoot(token);
    if (!pametRoot) return null;

    const segments = target.replace("PAMET_KAREL/", "").split("/");

    let currentFolder = pametRoot;
    for (let i = 0; i < segments.length - 1; i++) {
      const nextFolder = await findFolder(token, segments[i], currentFolder);
      if (!nextFolder) return null;
      currentFolder = nextFolder;
    }

    const docName = segments[segments.length - 1];
    const files = await listFiles(token, currentFolder);
    const doc = files.find(
      (f) => f.mimeType === GDOC_MIME && f.name.toUpperCase().includes(docName.toUpperCase()),
    );
    return doc?.id || null;
  }

  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const startTime = Date.now();
  const log: string[] = [];
  const addLog = (msg: string) => {
    console.log(`[drive-queue] ${msg}`);
    log.push(msg);
  };

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const sb = createClient(supabaseUrl, serviceKey);

    // Fetch pending writes (max 20 per run, oldest first)
    const { data: pendingWrites, error: fetchErr } = await sb
      .from("did_pending_drive_writes")
      .select("*")
      .eq("status", "pending")
      .order("created_at", { ascending: true })
      .limit(20);

    if (fetchErr) {
      addLog(`DB fetch error: ${fetchErr.message}`);
      return new Response(JSON.stringify({ error: fetchErr.message, log }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!pendingWrites || pendingWrites.length === 0) {
      addLog("No pending writes found.");
      return new Response(
        JSON.stringify({ processed: 0, log, duration_ms: Date.now() - startTime }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    addLog(`Found ${pendingWrites.length} pending writes`);

    // Get Drive access
    const token = await getAccessToken();
    const kartotekaRoot = await resolveKartotekaRoot(token);
    addLog(`kartotekaRoot resolved: ${kartotekaRoot || "NULL"}`);
    
    const pametRoot = await resolvePametKarelRoot(token);
    addLog(`pametKarelRoot resolved: ${pametRoot || "NULL"}`);
    
    if (!kartotekaRoot) {
      addLog("ERROR: Cannot find kartoteka root folder on Drive");
      return new Response(
        JSON.stringify({ error: "kartoteka root not found", log }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    let completed = 0;
    let failed = 0;
    let skipped = 0;

    for (const pw of pendingWrites) {
      const target = pw.target_document;
      const writeId = pw.id;

      try {
        // V1: only append is supported
        if (pw.write_type && pw.write_type !== "append") {
          addLog(`SKIP ${writeId}: write_type '${pw.write_type}' not supported in v1`);
          await sb
            .from("did_pending_drive_writes")
            .update({ status: "skipped", processed_at: new Date().toISOString() })
            .eq("id", writeId);
          skipped++;
          continue;
        }

        // Check whitelist
        if (!isAllowedTarget(target)) {
          addLog(`SKIP ${writeId}: target '${target}' not in whitelist`);
          await sb
            .from("did_pending_drive_writes")
            .update({ status: "skipped", processed_at: new Date().toISOString() })
            .eq("id", writeId);
          skipped++;
          continue;
        }

        // Resolve target to Drive file ID
        const fileId = await resolveTarget(token, kartotekaRoot, target);
        if (!fileId) {
          addLog(`FAIL ${writeId}: could not resolve target '${target}' on Drive`);
          await sb
            .from("did_pending_drive_writes")
            .update({ status: "failed", processed_at: new Date().toISOString() })
            .eq("id", writeId);
          failed++;
          continue;
        }

        // Append content
        const timestamp = new Date().toISOString().slice(0, 16).replace("T", " ");
        const contentWithTimestamp = `\n\n--- [${timestamp}] ---\n${pw.content}`;
        await appendToDoc(token, fileId, contentWithTimestamp);

        // Mark completed
        await sb
          .from("did_pending_drive_writes")
          .update({ status: "completed", processed_at: new Date().toISOString() })
          .eq("id", writeId);

        addLog(`OK ${writeId}: appended to '${target}' (file ${fileId})`);
        completed++;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        addLog(`FAIL ${writeId}: ${errMsg}`);
        await sb
          .from("did_pending_drive_writes")
          .update({ status: "failed", processed_at: new Date().toISOString() })
          .eq("id", writeId);
        failed++;
      }
    }

    const summary = {
      processed: pendingWrites.length,
      completed,
      failed,
      skipped,
      duration_ms: Date.now() - startTime,
      log,
    };

    addLog(`Done: ${completed} completed, ${failed} failed, ${skipped} skipped in ${summary.duration_ms}ms`);

    return new Response(JSON.stringify(summary), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    addLog(`Fatal error: ${errMsg}`);
    return new Response(JSON.stringify({ error: errMsg, log }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
