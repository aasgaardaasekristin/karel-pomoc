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
import { requireAuth } from "../_shared/auth.ts";
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
  canonicalizeTarget,
  resolveCardPhysicalTitle,
  isCanonicalKartaTarget,
  hasPhysicalCardMapping,
} from "../_shared/documentGovernance.ts";
import { decodeGovernedWrite } from "../_shared/documentWriteEnvelope.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

type Lane = "fast" | "bulk";
type WriteResult = { write_id: string; status: "completed" | "skipped" | "failed" | "not_found"; target_document?: string; error?: string };


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
    // P29A closeout-fix: logical canonical KARTA_<NAME> → physical numeric-prefixed file (e.g. 003_TUNDRUPEK).
    // For canonical KARTA_* targets we require an exact physical-title match (no fuzzy includes fallback)
    // to prevent collisions like KARTA_GUSTIK matching 017_GUSTAV_PUVODNI_CAST.
    const physicalTitle = resolveCardPhysicalTitle(target);
    const segments = target.replace("KARTOTEKA_DID/", "").split("/");
    let currentFolder = kartotekaRoot;
    for (let i = 0; i < segments.length - 1; i++) {
      const nextFolder = await findFolder(token, segments[i], currentFolder);
      if (!nextFolder) return null;
      currentFolder = nextFolder;
    }
    const docName = segments[segments.length - 1];
    const files = await listFiles(token, currentFolder);
    if (isCanonicalKartaTarget(target)) {
      if (!physicalTitle) return null; // gated upstream as blocked_by_governance_no_physical_card
      const physical = files.find(
        (f) => f.mimeType !== FOLDER_MIME && f.name.toUpperCase() === physicalTitle.toUpperCase(),
      );
      return physical ? { id: physical.id, mimeType: physical.mimeType || GDOC_MIME } : null;
    }
    if (physicalTitle) {
      const physical = files.find(
        (f) => f.mimeType !== FOLDER_MIME && f.name.toUpperCase() === physicalTitle.toUpperCase(),
      );
      if (physical) return { id: physical.id, mimeType: physical.mimeType || GDOC_MIME };
    }
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

async function createCentrumDocIfMissing(token: string, kartotekaRoot: string, target: string): Promise<ResolvedFile | null> {
  if (!target.startsWith("KARTOTEKA_DID/")) return null;
  const segments = target.replace("KARTOTEKA_DID/", "").split("/");
  let currentFolder = kartotekaRoot;
  for (let i = 0; i < segments.length - 1; i++) {
    const nextFolder = await findFolder(token, segments[i], currentFolder);
    if (!nextFolder) return null;
    currentFolder = nextFolder;
  }
  const name = segments[segments.length - 1];
  const res = await fetch("https://www.googleapis.com/drive/v3/files?supportsAllDrives=true", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name, parents: [currentFolder], mimeType: GDOC_MIME }),
  });
  if (!res.ok) throw new Error(`Create missing Drive doc failed: ${res.status} ${await res.text()}`);
  const doc = await res.json();
  return { id: doc.id, mimeType: GDOC_MIME };
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
  let body: any = {};
  if (req.method === "POST") {
    try {
      body = await req.clone().json();
    } catch (_) { /* ignore */ }
  }

  const writeIds = Array.isArray(body?.write_ids)
    ? body.write_ids.filter((v: unknown) => typeof v === "string" && v.trim()).map((v: string) => v.trim())
    : [];
  const scoped = body?.mode === "scoped" || writeIds.length > 0;
  let lane: Lane = (url.searchParams.get("lane") as Lane) || "bulk";
  if (body?.lane === "fast" || body?.lane === "bulk") {
    lane = body.lane;
  }

  const lanePriorities = lane === "fast" ? FAST_PRIORITIES : BULK_PRIORITIES;
  const laneLimit = lane === "fast" ? FAST_LIMIT : BULK_LIMIT;

  if (scoped) {
    addLog(`Scoped mode: write_ids=${writeIds.length}`);
  } else {
    addLog(`Lane=${lane}, priorities=[${lanePriorities.join(",")}], limit=${laneLimit}`);
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const authHeader = req.headers.get("Authorization") || "";
    const isServiceCall = authHeader === `Bearer ${serviceKey}`;
    // P14: Accept X-Karel-Cron-Secret (Supabase JWT signing-keys system rejects
    // the legacy service-role bearer at the platform gateway with 401 before
    // our code runs, so cron must use an in-code-verified shared secret).
    const cronSecretHeader = req.headers.get("X-Karel-Cron-Secret") || "";
    let isCronSecretCall = false;
    if (cronSecretHeader) {
      try {
        const cronSb = createClient(supabaseUrl, serviceKey);
        const { data: ok } = await cronSb.rpc("verify_karel_cron_secret", { p_secret: cronSecretHeader });
        isCronSecretCall = ok === true;
      } catch (e) {
        console.warn("[drive-queue] cron secret rpc failed:", (e as Error)?.message);
      }
    }
    if (!isServiceCall && !isCronSecretCall) {
      if (!scoped) {
        return new Response(JSON.stringify({ error: "Unauthorized", log }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const auth = await requireAuth(req);
      if (auth instanceof Response) return auth;
    }
    const sb = createClient(supabaseUrl, serviceKey);

    if (scoped && writeIds.length === 0) {
      return new Response(JSON.stringify({ error: "Scoped režim vyžaduje write_ids.", mode: "scoped", log }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── Build query ──
    // Scoped mode never selects lane/batch writes; it only reads explicit write_ids.
    let query = sb.from("did_pending_drive_writes").select("*");

    if (scoped) {
      query = query.in("id", writeIds);
    } else {
      query = query
        .eq("status", "pending")
        .or("next_retry_at.is.null,next_retry_at.lte." + new Date().toISOString());

      if (lane === "fast") {
        query = query.in("priority", lanePriorities);
      } else {
        // bulk: priority NOT IN fast lane (covers normal, low, NULL)
        query = query.not("priority", "in", `(${FAST_PRIORITIES.map((p) => `"${p}"`).join(",")})`);
      }
    }

    const queryWithOrder = query
      .order("priority", { ascending: false }) // critical/urgent/high first
      .order("created_at", { ascending: true });

    const { data: pendingWrites, error: fetchErr } = scoped
      ? await queryWithOrder
      : await queryWithOrder.limit(laneLimit);

    if (fetchErr) {
      addLog(`DB fetch error: ${fetchErr.message}`);
      await heartbeat(sb, lane, 0, 0, 0, 0, Date.now() - startTime, fetchErr.message);
      return new Response(JSON.stringify({ error: fetchErr.message, lane, log }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const writeResults: WriteResult[] = [];
    const foundIds = new Set((pendingWrites ?? []).map((pw: any) => pw.id));
    if (scoped) {
      for (const id of writeIds) {
        if (!foundIds.has(id)) writeResults.push({ write_id: id, status: "not_found" });
      }
    }

    if (!pendingWrites || pendingWrites.length === 0) {
      addLog(scoped ? "No scoped writes found." : "No eligible pending writes for this lane.");
      if (!scoped) await heartbeat(sb, lane, 0, 0, 0, 0, Date.now() - startTime, null);
      return new Response(
        JSON.stringify({ mode: scoped ? "scoped" : "batch", lane, processed: 0, results: writeResults, log, duration_ms: Date.now() - startTime }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    addLog(scoped ? `Found ${pendingWrites.length} scoped writes` : `Found ${pendingWrites.length} pending writes for lane=${lane}`);

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

      if (scoped && pw.status !== "pending") {
        writeResults.push({ write_id: writeId, status: "skipped", target_document: target, error: `status is ${pw.status}` });
        skipped++;
        addLog(`SKIP ${writeId}: status '${pw.status}'`);
        continue;
      }

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
          writeResults.push({ write_id: writeId, status: "skipped", target_document: target, error: `unsupported write_type '${writeType}'` });
          addLog(`SKIP ${writeId}: write_type '${writeType}'`);
          continue;
        }

        // Replace allowed?
        if (writeType === "replace" && !isReplaceAllowed(target, sourceType, contentType)) {
          await markSkipped(sb, writeId, "replace not allowed");
          await audit(sb, { sourceType, sourceId, target, contentType, subjectType, subjectId, writeType, payload, crisisEventId, success: false, status: "skipped", err: "replace not allowed" });
          skipped++;
          writeResults.push({ write_id: writeId, status: "skipped", target_document: target, error: "replace not allowed" });
          addLog(`SKIP ${writeId}: replace not allowed for '${target}'`);
          continue;
        }

        // P29A: Canonicalize target — fail-closed.
        const canon = canonicalizeTarget(target);
        if (!canon.ok) {
          await sb
            .from("did_pending_drive_writes")
            .update({
              status: "blocked_by_governance",
              pipeline_state: "blocked_by_governance",
              last_error_message: `governance: ${canon.reason}`,
              next_retry_at: null,
            })
            .eq("id", writeId);
          await audit(sb, { sourceType, sourceId, target, contentType, subjectType, subjectId, writeType, payload, crisisEventId, success: false, status: "blocked_by_governance", err: canon.reason });
          skipped++;
          writeResults.push({ write_id: writeId, status: "skipped", target_document: target, error: `blocked_by_governance: ${canon.reason}` });
          addLog(`BLOCK ${writeId}: '${target}' rejected by governance (${canon.reason})`);
          continue;
        }
        const effectiveTarget = canon.target;
        if (canon.rerouted) {
          addLog(`REROUTE ${writeId}: '${target}' → '${effectiveTarget}'`);
          await sb
            .from("did_pending_drive_writes")
            .update({ target_document: effectiveTarget })
            .eq("id", writeId);
        }

        // Governance whitelist (defensive — canonicalize already enforces this).
        if (!isGovernedTarget(effectiveTarget)) {
          await markSkipped(sb, writeId, "target not in governance whitelist");
          await audit(sb, { sourceType, sourceId, target: effectiveTarget, contentType, subjectType, subjectId, writeType, payload, crisisEventId, success: false, status: "skipped", err: "not in whitelist" });
          skipped++;
          writeResults.push({ write_id: writeId, status: "skipped", target_document: effectiveTarget, error: "target not in governance whitelist" });
          addLog(`SKIP ${writeId}: '${effectiveTarget}' not in whitelist`);
          continue;
        }

        // P29A: Hard gate canonical KARTA_<NAME> targets without physical Drive mapping.
        if (isCanonicalKartaTarget(effectiveTarget) && !hasPhysicalCardMapping(effectiveTarget)) {
          await sb
            .from("did_pending_drive_writes")
            .update({
              status: "blocked_by_governance",
              pipeline_state: "blocked_by_governance_no_physical_card",
              last_error_message: `blocked_by_governance_no_physical_card: ${effectiveTarget} has no entry in CARD_PHYSICAL_MAP`,
              next_retry_at: null,
            })
            .eq("id", writeId);
          await audit(sb, { sourceType, sourceId, target: effectiveTarget, contentType, subjectType, subjectId, writeType, payload, crisisEventId, success: false, status: "blocked_by_governance", err: "no_physical_card" });
          skipped++;
          writeResults.push({ write_id: writeId, status: "skipped", target_document: effectiveTarget, error: "blocked_by_governance_no_physical_card" });
          addLog(`BLOCK ${writeId}: '${effectiveTarget}' has no physical card mapping`);
          continue;
        }

        // Resolve target — only canonical centrum docs may be auto-created.
        let resolved = await resolveTarget(token, kartotekaRoot, effectiveTarget);
        if (!resolved && (
              effectiveTarget === "KARTOTEKA_DID/00_CENTRUM/05D_HERNY_LOG"
           || effectiveTarget === "KARTOTEKA_DID/00_CENTRUM/05C_SEZENI_LOG"
        )) {
          resolved = await createCentrumDocIfMissing(token, kartotekaRoot, effectiveTarget);
          if (resolved) addLog(`Created missing centrum doc for '${effectiveTarget}' (file ${resolved.id})`);
        }
        if (!resolved) {
          const result = await markFailedWithRetry(sb, writeId, currentRetry, "target could not be resolved on Drive");
          await audit(sb, { sourceType, sourceId, target: effectiveTarget, contentType, subjectType, subjectId, writeType, payload, crisisEventId, success: false, status: result.status, err: "target unresolved" });
          if (result.permanent) permanent++; else failed++;
          writeResults.push({ write_id: writeId, status: "failed", target_document: effectiveTarget, error: "target could not be resolved on Drive" });
          addLog(`${result.permanent ? "PERMANENT" : "RETRY"} ${writeId}: target '${effectiveTarget}' unresolved (attempt ${currentRetry + 1}/${MAX_RETRIES})`);
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

        await audit(sb, { sourceType, sourceId, target: effectiveTarget, contentType, subjectType, subjectId, writeType, payload, crisisEventId, success: true, status: "ok" });
        await updateReviewDriveSync(sb, { sourceType, sourceId, contentType, fileId: resolved.id, status: "completed" });
        await updatePantryPackageSync(sb, writeId, "flushed", null, true);
        writeResults.push({ write_id: writeId, status: "completed", target_document: effectiveTarget });
        addLog(`OK ${writeId}: ${writeType} → '${effectiveTarget}' (file ${resolved.id})`);
        completed++;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const result = await markFailedWithRetry(sb, writeId, currentRetry, errMsg);
        await audit(sb, { sourceType, sourceId, target, contentType, subjectType, subjectId, writeType, payload, crisisEventId, success: false, status: result.status, err: errMsg });
        await updateReviewDriveSync(sb, { sourceType, sourceId, contentType, status: result.permanent ? "failed" : "retrying", error: errMsg });
        await updatePantryPackageSync(sb, writeId, result.permanent ? "failed" : "pending_drive", errMsg, false);
        if (result.permanent) permanent++; else failed++;
        writeResults.push({ write_id: writeId, status: "failed", target_document: target, error: errMsg });
        addLog(`${result.permanent ? "PERMANENT" : "RETRY"} ${writeId}: ${errMsg}`);
      }
    }

    const duration = Date.now() - startTime;
    if (!scoped) await heartbeat(sb, lane, pendingWrites.length, completed, failed + permanent, skipped, duration, null);

    const summary = {
      mode: scoped ? "scoped" : "batch",
      lane,
      processed: pendingWrites.length,
      completed,
      failed,
      permanent_failed: permanent,
      skipped,
      results: writeResults,
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

async function updateReviewDriveSync(sb: any, p: { sourceType: string | null; sourceId: string; contentType: string | null; fileId?: string; status: "completed" | "retrying" | "failed"; error?: string }) {
  const contentType = String(p.contentType || "");
  const isPlayroom = contentType.startsWith("playroom_");
  const isSession = contentType.startsWith("session_");
  if (p.sourceType !== "did_session_review" || !p.sourceId || (!isPlayroom && !isSession)) return;
  try {
    const patch: Record<string, unknown> = {
      last_sync_at: new Date().toISOString(),
      source_of_truth_status: p.status === "completed" ? "partial_sync" : "drive_failed",
      drive_sync_status: p.status === "completed" ? "syncing" : p.status,
      last_sync_error: p.error ? String(p.error).slice(0, 1000) : null,
    };
    if (p.fileId && (contentType === "playroom_detail_analysis" || contentType === "session_detail_analysis")) {
      patch.detail_analysis_drive_id = p.fileId;
      patch.detail_analysis_drive_url = `https://drive.google.com/open?id=${p.fileId}`;
    }
    if (p.fileId && (contentType === "playroom_practical_report" || contentType === "session_practical_report")) {
      patch.practical_report_drive_id = p.fileId;
      patch.practical_report_drive_url = `https://drive.google.com/open?id=${p.fileId}`;
    }
    const { data: review } = await sb
      .from("did_session_reviews")
      .select("id,detail_analysis_drive_id,practical_report_drive_id")
      .eq("id", p.sourceId)
      .maybeSingle();
    const hasBoth = review && (review.detail_analysis_drive_id || patch.detail_analysis_drive_id) && (review.practical_report_drive_id || patch.practical_report_drive_id);
    if (review && (p.status !== "completed" || hasBoth)) {
      patch.drive_sync_status = p.status === "completed" ? "synced" : p.status;
      patch.source_of_truth_status = p.status === "completed" ? "drive_synced" : "drive_failed";
      if (p.status === "completed") patch.synced_to_drive = true;
    }
    await sb.from("did_session_reviews").update(patch).eq("id", p.sourceId);
  } catch (e) {
    console.warn("[drive-queue] session/playroom review sync patch failed", e);
  }
}

async function updatePantryPackageSync(sb: any, writeId: string, status: "flushed" | "pending_drive" | "failed", error: string | null, completed: boolean) {
  try {
    await sb
      .from("did_pantry_packages")
      .update({ status, flushed_at: completed ? new Date().toISOString() : null, flush_error: error ? error.slice(0, 1000) : null, updated_at: new Date().toISOString() })
      .eq("metadata->>pending_drive_write_id", writeId);
  } catch (e) {
    console.warn("[drive-queue] pantry package sync patch failed", e);
  }
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
