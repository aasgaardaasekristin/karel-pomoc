/**
 * karel-drive-queue-processor v2
 *
 * Zpracovává frontu `did_pending_drive_writes`.
 * Používá centrální Document Governance vrstvu pro whitelist a audit.
 *
 * Řízené dokumentové cíle:
 *   - KARTA_{JMENO}         → append do karty části v kartotece
 *   - KARTOTEKA_DID/00_CENTRUM/05A_OPERATIVNI_PLAN
 *   - KARTOTEKA_DID/00_CENTRUM/05B_STRATEGICKY_VYHLED
 *   - KARTOTEKA_DID/00_CENTRUM/05C_DLOUHODOBA_INTEGRACNI_TRAJEKTORIE
 *   - KARTOTEKA_DID/00_CENTRUM/DASHBOARD
 *   - PAMET_KAREL/DID/{HANKA,KATA,KONTEXTY}/...
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
  replaceFile,
  overwriteDoc,
  FOLDER_MIME,
  GDOC_MIME,
} from "../_shared/driveHelpers.ts";
import {
  isGovernedTarget,
  REPLACE_ALLOWED_TARGETS,
} from "../_shared/documentGovernance.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

// ── Resolve PAMET_KAREL root (separate Drive root, NOT inside kartoteka) ──
async function resolvePametKarelRoot(token: string): Promise<string | null> {
  for (const name of ["PAMET_KAREL", "Pamet_Karel", "pamet_karel"]) {
    const id = await findFolder(token, name);
    if (id) return id;
  }
  return null;
}

type ResolvedFile = { id: string; mimeType: string };

// ── Resolve target to Drive file ID + mimeType ──
async function resolveTarget(
  token: string,
  kartotekaRoot: string,
  target: string,
): Promise<ResolvedFile | null> {
  // KARTA_{NAME} → lives in KARTOTEKA_DID/01_AKTIVNI_FRAGMENTY (or 03_ARCHIV)
  if (target.startsWith("KARTA_")) {
    const partName = target.replace("KARTA_", "");
    console.log(`[resolve] Looking for part '${partName}' in kartoteka ${kartotekaRoot}`);

    const activeFolder = await findFolder(token, "01_AKTIVNI_FRAGMENTY", kartotekaRoot);
    if (activeFolder) {
      const items = await listFiles(token, activeFolder);
      for (const item of items) {
        if (!item.name.toUpperCase().includes(partName.toUpperCase())) continue;
        
        if (item.mimeType === FOLDER_MIME) {
          const cardFile = await findCardFileInFolder(token, item.id);
          if (cardFile) return { id: cardFile.id, mimeType: cardFile.mimeType || GDOC_MIME };
        } else if (item.mimeType !== FOLDER_MIME) {
          return { id: item.id, mimeType: item.mimeType || "text/plain" };
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
          if (cardFile) return { id: cardFile.id, mimeType: cardFile.mimeType || GDOC_MIME };
        } else if (item.mimeType !== FOLDER_MIME) {
          return { id: item.id, mimeType: item.mimeType || "text/plain" };
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
      (f) => f.mimeType !== FOLDER_MIME && f.name.toUpperCase().includes(docName.toUpperCase()),
    );
    return doc ? { id: doc.id, mimeType: doc.mimeType || "text/plain" } : null;
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
      (f) => f.mimeType !== FOLDER_MIME && f.name.toUpperCase().includes(docName.toUpperCase()),
    );
    return doc ? { id: doc.id, mimeType: doc.mimeType || "text/plain" } : null;
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
        const writeType = pw.write_type || "append";

        // Validate write_type
        if (writeType !== "append" && writeType !== "replace") {
          addLog(`SKIP ${writeId}: write_type '${writeType}' not supported`);
          await sb
            .from("did_pending_drive_writes")
            .update({ status: "skipped", processed_at: new Date().toISOString() })
            .eq("id", writeId);
          skipped++;
          continue;
        }

        // Replace is only allowed for specific targets (from governance)
        if (writeType === "replace" && !REPLACE_ALLOWED_TARGETS.has(target)) {
          addLog(`SKIP ${writeId}: replace not allowed for target '${target}'`);
          await sb
            .from("did_pending_drive_writes")
            .update({ status: "skipped", processed_at: new Date().toISOString() })
            .eq("id", writeId);
          skipped++;
          continue;
        }

        // Check governance whitelist (replaces old hardcoded ALLOWED_TARGETS)
        if (!isGovernedTarget(target)) {
          addLog(`SKIP ${writeId}: target '${target}' not in governance whitelist`);
          await sb
            .from("did_pending_drive_writes")
            .update({ status: "skipped", processed_at: new Date().toISOString() })
            .eq("id", writeId);
          skipped++;
          continue;
        }

        // Resolve target to Drive file ID + mimeType
        const resolved = await resolveTarget(token, kartotekaRoot, target);
        if (!resolved) {
          addLog(`FAIL ${writeId}: could not resolve target '${target}' on Drive`);
          await sb
            .from("did_pending_drive_writes")
            .update({ status: "failed", processed_at: new Date().toISOString() })
            .eq("id", writeId);
          failed++;
          continue;
        }

        // Dispatch write by type
        const timestamp = new Date().toISOString().slice(0, 16).replace("T", " ");

        if (writeType === "replace") {
          if (resolved.mimeType === GDOC_MIME) {
            // Google Docs: use overwriteDoc (delete + insert)
            const contentWithHeader = `--- Poslední aktualizace: ${timestamp} ---\n\n${pw.content}`;
            await overwriteDoc(token, resolved.id, contentWithHeader);
            addLog(`REPLACED (GDoc) file ${resolved.id} for target '${target}'`);
          } else {
            // Plain text: use replaceFile
            const contentWithHeader = `--- Poslední aktualizace: ${timestamp} ---\n\n${pw.content}`;
            await replaceFile(token, resolved.id, contentWithHeader);
            addLog(`REPLACED (plain) file ${resolved.id} for target '${target}'`);
          }
        } else {
          // Append
          const contentWithTimestamp = `\n\n--- [${timestamp}] ---\n${pw.content}`;
          if (resolved.mimeType === GDOC_MIME) {
            await appendToDoc(token, resolved.id, contentWithTimestamp);
          } else {
            await appendToFile(token, resolved.id, contentWithTimestamp);
          }
          addLog(`Appended via ${resolved.mimeType === GDOC_MIME ? "Docs API" : "Drive API"} to ${resolved.id}`);
        }

        // Mark completed
        await sb
          .from("did_pending_drive_writes")
          .update({ status: "completed", processed_at: new Date().toISOString() })
          .eq("id", writeId);

        // Audit log
        try {
          await sb.from("did_doc_sync_log").insert({
            source_type: pw.source_type || "drive-queue-processor",
            source_id: pw.source_id || writeId,
            target_document: target,
            content_type: pw.content_type || "card_section_update",
            subject_type: pw.subject_type || "system",
            subject_id: pw.subject_id || "",
            sync_type: `${writeType}_via_queue`,
            content_written: (pw.content || "").slice(0, 500),
            success: true,
            status: "ok",
          });
        } catch (auditErr) {
          console.warn(`[drive-queue] Audit log failed for ${writeId}:`, auditErr);
        }

        addLog(`OK ${writeId}: ${writeType} to '${target}' (file ${resolved.id})`);
        completed++;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        addLog(`FAIL ${writeId}: ${errMsg}`);
        await sb
          .from("did_pending_drive_writes")
          .update({ status: "failed", processed_at: new Date().toISOString() })
          .eq("id", writeId);

        // Audit failure
        try {
          await sb.from("did_doc_sync_log").insert({
            source_type: pw.source_type || "drive-queue-processor",
            source_id: pw.source_id || writeId,
            target_document: target,
            content_type: pw.content_type || "card_section_update",
            subject_type: pw.subject_type || "system",
            subject_id: pw.subject_id || "",
            sync_type: `${pw.write_type || "append"}_via_queue`,
            content_written: "",
            success: false,
            status: "failed",
            error_message: errMsg.slice(0, 500),
          });
        } catch (_) { /* ignore audit errors */ }

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
