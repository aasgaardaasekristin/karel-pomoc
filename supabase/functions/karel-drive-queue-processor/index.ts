/**
 * karel-drive-queue-processor v3
 *
 * Lane-aware processor pro frontu `did_pending_drive_writes`.
 *
 * Lanes (přepínané query paramem `?lane=fast|bulk`, default = bulk pro zpětnou kompatibilitu):
 *   - fast  → priority IN ('critical','urgent','high'), limit 10, cron 1×/min
 *   - bulk  → priority IN ('normal','low') nebo NULL, limit 20, cron 1×/5min
 *
 * Retry policy:
 *   - každý fail zvyšuje retry_count, naplánuje next_retry_at exponenciálně (1m → 5m → 30m → 2h → 6h)
 *   - po 5 pokusech status=failed_permanent (už ho processor nesahá)
 *   - row se vybírá jen pokud next_retry_at IS NULL nebo <= now()
 *
 * Heartbeat:
 *   - každý úspěšný běh zapíše row do system_health_log s event_type='drive_queue_heartbeat'
 *
 * Whitelist + governance: viz documentGovernance.ts.
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
  isReplaceAllowed,
} from "../_shared/documentGovernance.ts";
import { decodeGovernedWrite } from "../_shared/documentWriteEnvelope.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

type Lane = "fast" | "bulk";

const FAST_PRIORITIES = ["critical", "urgent", "high"];
const BULK_PRIORITIES = ["normal", "low"];

const FAST_LIMIT = 10;
const BULK_LIMIT = 20;

const MAX_RETRIES = 5;
// Backoff in seconds for retry attempts 1..5
const RETRY_BACKOFF_SECONDS = [60, 300, 1800, 7200, 21600];

function nextRetryAt(retryCount: number): string | null {
  if (retryCount >= MAX_RETRIES) return null;
  const seconds = RETRY_BACKOFF_SECONDS[Math.min(retryCount, RETRY_BACKOFF_SECONDS.length - 1)];
  return new Date(Date.now() + seconds * 1000).toISOString();
}

// ── Resolve PAMET_KAREL root (separate Drive root) ──
async function resolvePametKarelRoot(token: string): Promise<string | null> {
  for (const name of ["PAMET_KAREL", "Pamet_Karel", "pamet_karel"]) {
    const id = await findFolder(token, name);
    if (id) return id;
  }
  return null;
}

type ResolvedFile = { id: string; mimeType: string };

async function resolveTarget(
  token: string,
  kartotekaRoot: string,
  target: string,
): Promise<ResolvedFile | null> {
  if (target.startsWith("KARTA_")) {
    const partName = target.replace("KARTA_", "");
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

  // ── Determine lane from query param OR body.lane (default bulk for backward compatibility) ──
  const url = new URL(req.url);
  let lane: Lane = (url.searchParams.get("lane") as Lane) || "bulk";
  if (req.method === "POST") {
    try {
      const body = await req.clone().json();
      if (body?.lane === "fast" || body?.lane === "bulk") {
        lane = body.lane;
      }
    } catch (_) { /* ignore */ }
  }

  const lanePriorities = lane === "fast" ? FAST_PRIORITIES : BULK_PRIORITIES;
  const laneLimit = lane === "fast" ? FAST_LIMIT : BULK_LIMIT;

  addLog(`Lane=${lane}, priorities=[${lanePriorities.join(",")}], limit=${laneLimit}`);

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const sb = createClient(supabaseUrl, serviceKey);

    // ── Build query ──
    // Bulk includes NULL priority too (treated as 'normal').
    let query = sb
      .from("did_pending_drive_writes")
      .select("*")
      .eq("status", "pending")
      .or("next_retry_at.is.null,next_retry_at.lte." + new Date().toISOString());

    if (lane === "fast") {
      query = query.in("priority", lanePriorities);
    } else {
      // bulk: priority NOT IN fast lane (covers normal, low, NULL)
      query = query.not("priority", "in", `(${FAST_PRIORITIES.map((p) => `"${p}"`).join(",")})`);
    }

    const { data: pendingWrites, error: fetchErr } = await query
      .order("priority", { ascending: false }) // critical/urgent/high first
      .order("created_at", { ascending: true })
      .limit(laneLimit);

    if (fetchErr) {
      addLog(`DB fetch error: ${fetchErr.message}`);
      await heartbeat(sb, lane, 0, 0, 0, 0, Date.now() - startTime, fetchErr.message);
      return new Response(JSON.stringify({ error: fetchErr.message, lane, log }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!pendingWrites || pendingWrites.length === 0) {
      addLog("No eligible pending writes for this lane.");
      await heartbeat(sb, lane, 0, 0, 0, 0, Date.now() - startTime, null);
      return new Response(
        JSON.stringify({ lane, processed: 0, log, duration_ms: Date.now() - startTime }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    addLog(`Found ${pendingWrites.length} pending writes for lane=${lane}`);

    const token = await getAccessToken();
    const kartotekaRoot = await resolveKartotekaRoot(token);
    addLog(`kartotekaRoot=${kartotekaRoot || "NULL"}`);

    if (!kartotekaRoot) {
      const msg = "kartoteka root not found";
      addLog(`ERROR: ${msg}`);
      await heartbeat(sb, lane, 0, 0, 0, 0, Date.now() - startTime, msg);
      return new Response(
        JSON.stringify({ error: msg, lane, log }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    let completed = 0;
    let failed = 0;
    let skipped = 0;
    let permanent = 0;

    for (const pw of pendingWrites) {
      const target = pw.target_document;
      const writeId = pw.id;
      const { payload, metadata } = decodeGovernedWrite(pw.content || "");
      const sourceType = metadata?.source_type || null;
      const sourceId = metadata?.source_id || writeId;
      const contentType = metadata?.content_type || "card_section_update";
      const subjectType = metadata?.subject_type || "system";
      const subjectId = metadata?.subject_id || "";
      const crisisEventId = metadata?.crisis_event_id || null;
      const writeType = pw.write_type || "append";
      const currentRetry = pw.retry_count || 0;

      // ── Mark attempt start ──
      await sb
        .from("did_pending_drive_writes")
        .update({ last_attempt_at: new Date().toISOString() })
        .eq("id", writeId);

      try {
        // Validate write_type
        if (writeType !== "append" && writeType !== "replace") {
          await markSkipped(sb, writeId, `unsupported write_type '${writeType}'`);
          await audit(sb, { sourceType, sourceId, target, contentType, subjectType, subjectId, writeType, payload, crisisEventId, success: false, status: "skipped", err: "write_type unsupported" });
          skipped++;
          addLog(`SKIP ${writeId}: write_type '${writeType}'`);
          continue;
        }

        // Replace allowed?
        if (writeType === "replace" && !isReplaceAllowed(target, sourceType, contentType)) {
          await markSkipped(sb, writeId, "replace not allowed");
          await audit(sb, { sourceType, sourceId, target, contentType, subjectType, subjectId, writeType, payload, crisisEventId, success: false, status: "skipped", err: "replace not allowed" });
          skipped++;
          addLog(`SKIP ${writeId}: replace not allowed for '${target}'`);
          continue;
        }

        // Governance whitelist
        if (!isGovernedTarget(target)) {
          await markSkipped(sb, writeId, "target not in governance whitelist");
          await audit(sb, { sourceType, sourceId, target, contentType, subjectType, subjectId, writeType, payload, crisisEventId, success: false, status: "skipped", err: "not in whitelist" });
          skipped++;
          addLog(`SKIP ${writeId}: '${target}' not in whitelist`);
          continue;
        }

        // Resolve target
        const resolved = await resolveTarget(token, kartotekaRoot, target);
        if (!resolved) {
          // This is a transient-or-permanent failure — retry until MAX_RETRIES
          const result = await markFailedWithRetry(sb, writeId, currentRetry, "target could not be resolved on Drive");
          await audit(sb, { sourceType, sourceId, target, contentType, subjectType, subjectId, writeType, payload, crisisEventId, success: false, status: result.status, err: "target unresolved" });
          if (result.permanent) permanent++; else failed++;
          addLog(`${result.permanent ? "PERMANENT" : "RETRY"} ${writeId}: target '${target}' unresolved (attempt ${currentRetry + 1}/${MAX_RETRIES})`);
          continue;
        }

        // Dispatch write
        const timestamp = new Date().toISOString().slice(0, 16).replace("T", " ");

        if (writeType === "replace") {
          const contentWithHeader = `--- Poslední aktualizace: ${timestamp} ---\n\n${payload}`;
          if (resolved.mimeType === GDOC_MIME) {
            await overwriteDoc(token, resolved.id, contentWithHeader);
          } else {
            await replaceFile(token, resolved.id, contentWithHeader);
          }
        } else {
          const contentWithTimestamp = `\n\n--- [${timestamp}] ---\n${payload}`;
          if (resolved.mimeType === GDOC_MIME) {
            await appendToDoc(token, resolved.id, contentWithTimestamp);
          } else {
            await appendToFile(token, resolved.id, contentWithTimestamp);
          }
        }

        await sb
          .from("did_pending_drive_writes")
          .update({
            status: "completed",
            processed_at: new Date().toISOString(),
            last_error_message: null,
            next_retry_at: null,
          })
          .eq("id", writeId);

        await audit(sb, { sourceType, sourceId, target, contentType, subjectType, subjectId, writeType, payload, crisisEventId, success: true, status: "ok" });
        addLog(`OK ${writeId}: ${writeType} → '${target}' (file ${resolved.id})`);
        completed++;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const result = await markFailedWithRetry(sb, writeId, currentRetry, errMsg);
        await audit(sb, { sourceType, sourceId, target, contentType, subjectType, subjectId, writeType, payload, crisisEventId, success: false, status: result.status, err: errMsg });
        if (result.permanent) permanent++; else failed++;
        addLog(`${result.permanent ? "PERMANENT" : "RETRY"} ${writeId}: ${errMsg}`);
      }
    }

    const duration = Date.now() - startTime;
    await heartbeat(sb, lane, pendingWrites.length, completed, failed + permanent, skipped, duration, null);

    const summary = {
      lane,
      processed: pendingWrites.length,
      completed,
      failed,
      permanent_failed: permanent,
      skipped,
      duration_ms: duration,
      log,
    };
    addLog(`Done: ${completed} ok, ${failed} retry, ${permanent} permanent, ${skipped} skipped in ${duration}ms`);

    return new Response(JSON.stringify(summary), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    addLog(`Fatal: ${errMsg}`);
    return new Response(JSON.stringify({ error: errMsg, lane, log }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

// ── Helpers ──

async function markSkipped(sb: any, id: string, reason: string) {
  await sb
    .from("did_pending_drive_writes")
    .update({
      status: "skipped",
      processed_at: new Date().toISOString(),
      last_error_message: reason,
    })
    .eq("id", id);
}

async function markFailedWithRetry(sb: any, id: string, currentRetry: number, errMsg: string) {
  const newRetry = currentRetry + 1;
  if (newRetry >= MAX_RETRIES) {
    await sb
      .from("did_pending_drive_writes")
      .update({
        status: "failed_permanent",
        processed_at: new Date().toISOString(),
        retry_count: newRetry,
        last_error_message: errMsg.slice(0, 1000),
        next_retry_at: null,
      })
      .eq("id", id);
    return { permanent: true, status: "failed_permanent" };
  }
  await sb
    .from("did_pending_drive_writes")
    .update({
      status: "pending",
      retry_count: newRetry,
      last_error_message: errMsg.slice(0, 1000),
      next_retry_at: nextRetryAt(newRetry),
    })
    .eq("id", id);
  return { permanent: false, status: "pending_retry" };
}

async function audit(sb: any, p: {
  sourceType: string | null; sourceId: string; target: string;
  contentType: string; subjectType: string; subjectId: string;
  writeType: string; payload: string; crisisEventId: string | null;
  success: boolean; status: string; err?: string;
}) {
  try {
    await sb.from("did_doc_sync_log").insert({
      source_type: p.sourceType || "drive-queue-processor",
      source_id: p.sourceId,
      target_document: p.target,
      content_type: p.contentType,
      subject_type: p.subjectType,
      subject_id: p.subjectId,
      sync_type: `${p.writeType}_via_queue`,
      content_written: p.payload.slice(0, 500),
      success: p.success,
      status: p.status,
      error_message: p.err ? p.err.slice(0, 500) : null,
      crisis_event_id: p.crisisEventId,
    });
  } catch (_) { /* ignore audit errors */ }
}

async function heartbeat(
  sb: any,
  lane: Lane,
  selected: number,
  completed: number,
  failed: number,
  skipped: number,
  durationMs: number,
  errorMsg: string | null,
) {
  try {
    await sb.from("system_health_log").insert({
      event_type: "drive_queue_heartbeat",
      severity: errorMsg ? "error" : "info",
      message: errorMsg
        ? `[${lane}] processor error: ${errorMsg}`
        : `[${lane}] processed=${selected} ok=${completed} fail=${failed} skip=${skipped} (${durationMs}ms)`,
      details: {
        lane,
        selected,
        completed,
        failed,
        skipped,
        duration_ms: durationMs,
        error: errorMsg,
      },
      resolved: !errorMsg,
    });
  } catch (_) { /* ignore */ }
}
