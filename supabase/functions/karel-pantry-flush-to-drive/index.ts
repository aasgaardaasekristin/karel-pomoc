/**
 * karel-pantry-flush-to-drive
 *
 * Noční flush Spižírny (did_pantry_packages) na Drive.
 *
 * Scoped mode:
 *   POST { mode: "scoped", package_ids: ["..."], dry_run?: boolean }
 *   Zpracuje výhradně uvedené package_ids, nikdy nevybírá široký batch.
 */

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";
import { isGovernedTarget, safeEnqueueDriveWrite } from "../_shared/documentGovernance.ts";
import { requireAuth } from "../_shared/auth.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const MAX_BATCH = 50;
const MAX_RETRIES = 5;
const DEDUPE_STATUSES = ["pending", "completed", "failed", "failed_permanent", "skipped"];

interface PantryPackage {
  id: string;
  user_id: string;
  package_type: string;
  source_id: string | null;
  source_table: string | null;
  content_md: string;
  drive_target_path: string;
  metadata: Record<string, any> | null;
  status: string;
}

type PackageResult = {
  package_id: string;
  status: "would_enqueue" | "enqueued" | "deduped" | "blocked_existing_failed_write" | "failed" | "not_found" | "invalid_status";
  target_document?: string;
  write_id?: string;
  error?: string;
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v) => typeof v === "string" && v.trim()).map((v) => v.trim());
}

function findReviewId(pkg: PantryPackage): string | null {
  const metadata = pkg.metadata ?? {};
  const candidates = [
    metadata.review_id,
    metadata.did_session_review_id,
    metadata.session_review_id,
    metadata.reviewId,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  const content = pkg.content_md || "";
  const match = content.match(/(?:did_session_review|review_id|session_review_id)[:=]\s*([0-9a-fA-F-]{20,})/);
  return match?.[1] ?? null;
}

function buildContent(pkg: PantryPackage): string {
  const markers = [`pantry_pkg:${pkg.id}`, `pantry_pkg=${pkg.id} type=${pkg.package_type}`];
  if (pkg.source_id) markers.push(`source_id:${pkg.source_id}`);
  const reviewId = findReviewId(pkg);
  if (reviewId) markers.push(`did_session_review:${reviewId}`);

  const headerLines = [
    `<!-- ${markers.join(" ")} -->`,
    `<!-- generated_at=${new Date().toISOString()} -->`,
    "",
  ];
  return `${headerLines.join("\n")}${(pkg.content_md || "").trim()}`;
}

async function findExistingWrite(admin: any, pkg: PantryPackage, targetDoc: string) {
  const { data, error } = await admin
    .from("did_pending_drive_writes")
    .select("id,status,target_document")
    .eq("target_document", targetDoc)
    .in("status", DEDUPE_STATUSES)
    .ilike("content", `%pantry_pkg:${pkg.id}%`)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data ?? null;
}

async function processPackage(admin: any, pkg: PantryPackage, dryRun: boolean): Promise<PackageResult> {
  if (pkg.status !== "pending_drive") {
    return { package_id: pkg.id, status: "invalid_status", target_document: pkg.drive_target_path, error: `status is ${pkg.status}` };
  }

  const targetDoc = (pkg.drive_target_path || "").trim();
  const content = (pkg.content_md || "").trim();
  if (!targetDoc || !content) {
    throw new Error("Prázdný target nebo content");
  }

  if (!isGovernedTarget(targetDoc)) {
    throw new Error(`Target není v governance whitelistu: ${targetDoc}`);
  }

  const existing = await findExistingWrite(admin, pkg, targetDoc);
  if (existing) {
    if (["failed", "failed_permanent", "skipped"].includes(existing.status)) {
      return {
        package_id: pkg.id,
        status: "blocked_existing_failed_write",
        target_document: targetDoc,
        write_id: existing.id,
        error: "Existing write with same pantry_pkg marker is failed/skipped; manual decision required.",
      };
    }

    if (!dryRun) {
      const { error: updErr } = await admin
        .from("did_pantry_packages")
        .update({ status: "flushed", flushed_at: new Date().toISOString(), flush_error: null })
        .eq("id", pkg.id);
      if (updErr) throw updErr;
    }
    return { package_id: pkg.id, status: "deduped", target_document: targetDoc, write_id: existing.id };
  }

  if (dryRun) {
    return { package_id: pkg.id, status: "would_enqueue", target_document: targetDoc };
  }

  const enqRes = await safeEnqueueDriveWrite(
    admin as any,
    {
      user_id: pkg.user_id,
      content: buildContent(pkg),
      target_document: targetDoc,
      write_type: "append",
      priority: "normal",
      status: "pending",
    },
    { source: "pantry-flush-to-drive", returning: "id" },
  );
  if (!enqRes.inserted) throw new Error(enqRes.reason ?? "blocked_by_governance");
  const inserted = enqRes.data as any;

  const { error: updErr } = await admin
    .from("did_pantry_packages")
    .update({ status: "flushed", flushed_at: new Date().toISOString(), flush_error: null })
    .eq("id", pkg.id);
  if (updErr) throw updErr;

  return { package_id: pkg.id, status: "enqueued", target_document: targetDoc, write_id: inserted.id };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const startedAt = Date.now();
  const admin = createClient(SUPABASE_URL, SERVICE_KEY);

  try {
    let body: any = {};
    if (req.method === "POST") {
      try {
        body = await req.json();
      } catch (_) {
        body = {};
      }
    }

    const packageIds = normalizeStringArray(body?.package_ids);
    const scoped = body?.mode === "scoped" || packageIds.length > 0;
    const dryRun = Boolean(body?.dry_run);
    const authHeader = req.headers.get("Authorization") || "";
    const isServiceCall = authHeader === `Bearer ${SERVICE_KEY}`;
    // P14: Accept X-Karel-Cron-Secret for cron-path auth.
    const cronSecretHeader = req.headers.get("X-Karel-Cron-Secret") || "";
    let isCronSecretCall = false;
    if (cronSecretHeader) {
      try {
        const { data: ok } = await admin.rpc("verify_karel_cron_secret", { p_secret: cronSecretHeader });
        isCronSecretCall = ok === true;
      } catch (e) {
        console.warn("[pantry-flush] cron secret rpc failed:", (e as Error)?.message);
      }
    }
    if (!isServiceCall && !isCronSecretCall) {
      if (!scoped) return json({ ok: false, error: "Unauthorized" }, 401);
      const auth = await requireAuth(req);
      if (auth instanceof Response) return auth;
    }

    if (scoped) {
      if (packageIds.length === 0) {
        return json({ ok: false, error: "Scoped režim vyžaduje package_ids." }, 400);
      }
      if (packageIds.length > MAX_BATCH) {
        return json({ ok: false, error: `Scoped režim povoluje max ${MAX_BATCH} package_ids.` }, 400);
      }

      const { data, error: fetchErr } = await admin
        .from("did_pantry_packages")
        .select("*")
        .in("id", packageIds);
      if (fetchErr) throw fetchErr;

      const byId = new Map<string, PantryPackage>((data ?? []).map((pkg: PantryPackage) => [pkg.id, pkg]));
      const results: PackageResult[] = [];

      for (const id of packageIds) {
        const pkg = byId.get(id);
        if (!pkg) {
          results.push({ package_id: id, status: "not_found" });
          continue;
        }
        try {
          results.push(await processPackage(admin, pkg, dryRun));
        } catch (e: any) {
          if (!dryRun) {
            const retryCount = ((pkg.metadata as any)?.flush_retry_count ?? 0) + 1;
            const newStatus = retryCount >= MAX_RETRIES ? "failed" : "pending_drive";
            const newMeta = { ...(pkg.metadata ?? {}), flush_retry_count: retryCount };
            await admin
              .from("did_pantry_packages")
              .update({
                status: newStatus,
                flush_error: String(e?.message ?? e).slice(0, 500),
                metadata: newMeta,
              })
              .eq("id", pkg.id);
          }
          results.push({
            package_id: id,
            status: "failed",
            target_document: pkg.drive_target_path,
            error: String(e?.message ?? e),
          });
        }
      }

      return json({
        ok: results.every((r) => r.status !== "failed"),
        mode: "scoped",
        dry_run: dryRun,
        total_seen: results.length,
        results,
        duration_ms: Date.now() - startedAt,
      });
    }

    const cutoff = new Date(Date.now() - 60_000).toISOString();
    const { data: pending, error: fetchErr } = await admin
      .from("did_pantry_packages")
      .select("*")
      .eq("status", "pending_drive")
      .lte("created_at", cutoff)
      .order("created_at", { ascending: true })
      .limit(MAX_BATCH);

    if (fetchErr) throw fetchErr;
    const list = (pending ?? []) as PantryPackage[];
    if (list.length === 0) {
      return json({ ok: true, flushed: 0, message: "Žádné balíky k propsání.", duration_ms: Date.now() - startedAt });
    }

    let flushed = 0;
    let failed = 0;

    for (const pkg of list) {
      try {
        const result = await processPackage(admin, pkg, false);
        if (result.status === "enqueued" || result.status === "deduped") flushed++;
      } catch (e: any) {
        failed++;
        const retryCount = ((pkg.metadata as any)?.flush_retry_count ?? 0) + 1;
        const newStatus = retryCount >= MAX_RETRIES ? "failed" : "pending_drive";
        const newMeta = { ...(pkg.metadata ?? {}), flush_retry_count: retryCount };
        await admin
          .from("did_pantry_packages")
          .update({
            status: newStatus,
            flush_error: String(e?.message ?? e).slice(0, 500),
            metadata: newMeta,
          })
          .eq("id", pkg.id);
        console.error(`[pantry-flush] pkg ${pkg.id} failed (try ${retryCount}/${MAX_RETRIES}):`, e);
      }
    }

    return json({ ok: true, mode: "batch", flushed, failed, total_seen: list.length, duration_ms: Date.now() - startedAt });
  } catch (e: any) {
    console.error("[pantry-flush] fatal:", e);
    return json({ ok: false, error: e?.message ?? String(e) }, 500);
  }
});
