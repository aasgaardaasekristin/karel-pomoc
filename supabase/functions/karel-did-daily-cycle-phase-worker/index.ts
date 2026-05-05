/**
 * karel-did-daily-cycle-phase-worker (P29B)
 *
 * Detached worker that processes did_daily_cycle_phase_jobs. The main
 * daily-cycle never waits on this — it only enqueues.
 *
 * Auth: cron secret (X-Karel-Cron-Secret) OR service-role key.
 * Canonical guard: every job's user_id is checked against the canonical
 * DID user before any work runs.
 *
 * Each job_kind delegates to an existing standalone edge function so we
 * don't duplicate logic. The worker enforces:
 *   - per-job heartbeat (every 10s while job is running)
 *   - per-call timeout (120s default; 90s for AI heavy)
 *   - retry with exponential backoff up to max_attempts
 *   - controlled_skip when a non-fatal precondition is missing
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { resolveCanonicalDidUserId } from "../_shared/canonicalUserResolver.ts";
import { runPhase4CentrumTail, type CentrumTailResult } from "../_shared/dailyCyclePhase4CentrumTail.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-karel-cron-secret",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const HEARTBEAT_INTERVAL_MS = 10_000;
const DEFAULT_JOB_TIMEOUT_MS = 120_000;

type Job = {
  id: string;
  cycle_id: string | null;
  user_id: string;
  phase_name: string;
  job_kind: string;
  attempt_count: number;
  max_attempts: number;
  input: Record<string, unknown>;
};

async function verifyCronSecret(provided: string | null): Promise<boolean> {
  if (!provided) return false;
  const admin = createClient(SUPABASE_URL, SERVICE_KEY);
  const { data, error } = await admin.rpc("verify_karel_cron_secret", { p_secret: provided });
  if (error) return false;
  return data === true;
}

async function withHeartbeat<T>(admin: any, jobId: string, fn: () => Promise<T>): Promise<T> {
  const ticker = setInterval(() => {
    admin.from("did_daily_cycle_phase_jobs")
      .update({ last_heartbeat_at: new Date().toISOString() })
      .eq("id", jobId)
      .then(() => {}, () => {});
  }, HEARTBEAT_INTERVAL_MS);
  try {
    return await fn();
  } finally {
    clearInterval(ticker);
  }
}

async function callEdgeFunction(fnName: string, body: Record<string, unknown>, timeoutMs: number) {
  const url = `${SUPABASE_URL}/functions/v1/${fnName}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        Authorization: `Bearer ${SERVICE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const text = await res.text().catch(() => "");
    let parsed: any = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* keep null */ }
    return { ok: res.ok, status: res.status, body: parsed ?? text?.slice(0, 500) };
  } finally {
    clearTimeout(t);
  }
}

function dispatchTarget(job: Job): { fn: string; body: Record<string, unknown>; timeoutMs: number } | { skip: string } {
  switch (job.job_kind) {
    case "phase4_card_profiling":
    case "phase4_card_update_tail":
      // Delegate to update-part-profile loop driver. We invoke run-daily-card-updates
      // which already iterates active parts with its own per-call AI budget.
      return { fn: "run-daily-card-updates", body: { source: "p29b_phase_worker", cycle_id: job.cycle_id }, timeoutMs: 180_000 };
    case "phase6_card_autoupdate":
      return { fn: "run-daily-card-updates", body: { source: "p29b_phase_worker_phase6", cycle_id: job.cycle_id }, timeoutMs: 180_000 };
    case "phase8_therapist_intel":
      return { fn: "karel-daily-therapist-intelligence", body: { source: "p29b_phase_worker" }, timeoutMs: 90_000 };
    case "phase8a5_session_eval_safety_net": {
      const planId = (job.input as any)?.plan_id;
      if (!planId) return { skip: "missing_plan_id" };
      return { fn: "karel-did-session-finalize", body: { ...(job.input as any), source: "auto_safety_net" }, timeoutMs: 90_000 };
    }
    case "phase8b_pantry_flush":
      return { fn: "karel-pantry-flush-to-drive", body: { source: "p29b_phase_worker" }, timeoutMs: 90_000 };
    case "phase9_drive_queue_flush":
      return { fn: "karel-drive-queue-processor", body: { triggered_by: "p29b_phase_worker" }, timeoutMs: 90_000 };
    default:
      return { skip: `unknown_job_kind:${job.job_kind}` };
  }
}

async function processJob(admin: any, job: Job, canonicalUserId: string) {
  // Canonical guard
  if (job.user_id !== canonicalUserId) {
    await admin.from("did_daily_cycle_phase_jobs").update({
      status: "controlled_skipped",
      error_message: `non_canonical_user:${job.user_id}`,
      completed_at: new Date().toISOString(),
    }).eq("id", job.id);
    return { id: job.id, kind: job.job_kind, outcome: "controlled_skipped", reason: "non_canonical_user" };
  }

  // Claim job: queued/failed_retry → running (only if still in expected state)
  const { data: claimed, error: claimErr } = await admin
    .from("did_daily_cycle_phase_jobs")
    .update({
      status: "running",
      started_at: new Date().toISOString(),
      last_heartbeat_at: new Date().toISOString(),
      attempt_count: job.attempt_count + 1,
    })
    .eq("id", job.id)
    .in("status", ["queued", "failed_retry"])
    .select("id")
    .maybeSingle();
  if (claimErr || !claimed) {
    return { id: job.id, kind: job.job_kind, outcome: "skipped_already_claimed" };
  }

  // ── In-process dispatch for phase4_centrum_tail (no HTTP self-call) ──
  if (job.job_kind === "phase4_centrum_tail") {
    const ref = (job.input as any)?.payload_ref;
    if (!ref?.payload_id || !job.cycle_id) {
      await admin.from("did_daily_cycle_phase_jobs").update({
        status: "controlled_skipped",
        error_message: "missing_payload_ref_or_cycle",
        completed_at: new Date().toISOString(),
      }).eq("id", job.id);
      return { id: job.id, kind: job.job_kind, outcome: "controlled_skipped", reason: "missing_payload_ref" };
    }
    try {
      const tailResult: CentrumTailResult = await withHeartbeat(admin, job.id, () =>
        runPhase4CentrumTail({
          cycleId: job.cycle_id!,
          userId: job.user_id,
          payloadRef: ref,
          setHeartbeat: async () => {
            await admin.from("did_daily_cycle_phase_jobs")
              .update({ last_heartbeat_at: new Date().toISOString() })
              .eq("id", job.id);
          },
        }),
      );
      const status = tailResult.outcome === "controlled_skipped" ? "controlled_skipped" : "completed";
      await admin.from("did_daily_cycle_phase_jobs").update({
        status,
        completed_at: new Date().toISOString(),
        result: tailResult as unknown as Record<string, unknown>,
      }).eq("id", job.id);
      return { id: job.id, kind: job.job_kind, outcome: status, writes: tailResult.writes_enqueued, duration_ms: tailResult.duration_ms };
    } catch (e: any) {
      const exhausted = job.attempt_count + 1 >= job.max_attempts;
      await admin.from("did_daily_cycle_phase_jobs").update({
        status: exhausted ? "failed_permanent" : "failed_retry",
        error_message: (e?.message ?? String(e)).slice(0, 500),
        next_retry_at: exhausted ? null : new Date(Date.now() + Math.min(60_000 * Math.pow(2, job.attempt_count), 30 * 60_000)).toISOString(),
      }).eq("id", job.id);
      return { id: job.id, kind: job.job_kind, outcome: exhausted ? "failed_permanent" : "failed_retry", error: e?.message ?? String(e) };
    }
  }

  const target = dispatchTarget(job);
  if ("skip" in target) {
    await admin.from("did_daily_cycle_phase_jobs").update({
      status: "controlled_skipped",
      error_message: target.skip,
      completed_at: new Date().toISOString(),
    }).eq("id", job.id);
    return { id: job.id, kind: job.job_kind, outcome: "controlled_skipped", reason: target.skip };
  }

  try {
    const result = await withHeartbeat(admin, job.id, () =>
      callEdgeFunction(target.fn, target.body, target.timeoutMs),
    );
    if (result.ok) {
      await admin.from("did_daily_cycle_phase_jobs").update({
        status: "completed",
        completed_at: new Date().toISOString(),
        result: { http_status: result.status, body: result.body },
      }).eq("id", job.id);
      return { id: job.id, kind: job.job_kind, outcome: "completed", http: result.status };
    }
    const exhausted = job.attempt_count + 1 >= job.max_attempts;
    await admin.from("did_daily_cycle_phase_jobs").update({
      status: exhausted ? "failed_permanent" : "failed_retry",
      error_message: `delegate_http_${result.status}: ${typeof result.body === "string" ? result.body : JSON.stringify(result.body).slice(0, 400)}`,
      next_retry_at: exhausted ? null : new Date(Date.now() + Math.min(60_000 * Math.pow(2, job.attempt_count), 30 * 60_000)).toISOString(),
    }).eq("id", job.id);
    return { id: job.id, kind: job.job_kind, outcome: exhausted ? "failed_permanent" : "failed_retry", http: result.status };
  } catch (e: any) {
    const exhausted = job.attempt_count + 1 >= job.max_attempts;
    const msg = (e?.name === "AbortError") ? "timeout" : (e?.message ?? String(e));
    await admin.from("did_daily_cycle_phase_jobs").update({
      status: exhausted ? "failed_permanent" : "failed_retry",
      error_message: msg.slice(0, 500),
      next_retry_at: exhausted ? null : new Date(Date.now() + Math.min(60_000 * Math.pow(2, job.attempt_count), 30 * 60_000)).toISOString(),
    }).eq("id", job.id);
    return { id: job.id, kind: job.job_kind, outcome: exhausted ? "failed_permanent" : "failed_retry", error: msg };
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    // Auth: cron secret OR service-role bearer.
    const cronSecret = req.headers.get("x-karel-cron-secret");
    const authHeader = req.headers.get("authorization") ?? "";
    const isServiceRole = authHeader === `Bearer ${SERVICE_KEY}`;
    const cronOk = await verifyCronSecret(cronSecret);
    if (!cronOk && !isServiceRole) {
      return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const admin = createClient(SUPABASE_URL, SERVICE_KEY);

    // Resolve canonical user (fail-closed).
    const canonicalUserId = await resolveCanonicalDidUserId(admin as any);

    // Sweep stale running jobs (cheap; idempotent).
    try { await admin.rpc("did_phase_jobs_sweep_stale"); } catch { /* non-fatal */ }

    // Pick up to N jobs ready to run.
    const body = await req.json().catch(() => ({}));
    const batchSize = Math.min(Math.max(Number(body?.batch ?? 5), 1), 10);

    const { data: jobs, error: pickErr } = await admin
      .from("did_daily_cycle_phase_jobs")
      .select("id, cycle_id, user_id, phase_name, job_kind, attempt_count, max_attempts, input")
      .in("status", ["queued", "failed_retry"])
      .or(`next_retry_at.is.null,next_retry_at.lte.${new Date().toISOString()}`)
      .order("created_at", { ascending: true })
      .limit(batchSize);
    if (pickErr) {
      return new Response(JSON.stringify({ ok: false, error: pickErr.message }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const results: any[] = [];
    for (const job of jobs ?? []) {
      results.push(await processJob(admin, job as Job, canonicalUserId));
    }

    return new Response(JSON.stringify({ ok: true, processed: results.length, results }), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, error: e?.message ?? String(e) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
