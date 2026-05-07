/**
 * P30.2 — External Reality Daily Orchestrator.
 *
 * Glues the P30.1 internet_watch + active-part daily brief generation into
 * the daily flow:
 *   1. Resolve canonical user + Prague date.
 *   2. Evaluate P29C truth gate. Refuse to run unless ok=true (unless force).
 *   3. Skip idempotently if (user, run_date, source_cycle_id) already ran
 *      successfully today (unless force).
 *   4. Invoke karel-external-reality-sentinel#internet_watch.
 *   5. Invoke karel-external-reality-sentinel#generate_active_part_daily_brief.
 *   6. Record one audit row + a "fail-closed" SLO update.
 *
 * Auth: cron secret OR canonical authenticated user.
 * Read-only with respect to clinical data; no writes to part cards.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";
import { corsHeaders, requireAuth } from "../_shared/auth.ts";
import { evaluateDailyBriefingTruthGate } from "../_shared/dailyBriefingTruthGate.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

function json(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function pragueToday(): string {
  return new Date(
    new Date().toLocaleString("en-US", { timeZone: "Europe/Prague" }),
  )
    .toISOString()
    .slice(0, 10);
}

interface OrchestratorInput {
  userId?: string;
  date?: string;
  force?: boolean;
  source?: string;
}

interface SentinelResult {
  ok: boolean;
  status?: string;
  watch_run_id?: string | null;
  events_created?: number;
  events_deduped?: number;
  source_backed_events_count?: number;
  reason?: string;
  [key: string]: unknown;
}

async function callSentinelInternal(
  cronSecret: string,
  body: Record<string, unknown>,
): Promise<SentinelResult> {
  const res = await fetch(
    `${SUPABASE_URL}/functions/v1/karel-external-reality-sentinel`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SERVICE_KEY}`,
        "X-Karel-Cron-Secret": cronSecret,
      },
      body: JSON.stringify(body),
    },
  );
  let parsed: SentinelResult = { ok: false };
  try {
    parsed = (await res.json()) as SentinelResult;
  } catch {
    parsed = { ok: false, reason: `non_json_status_${res.status}` };
  }
  if (!parsed.ok && res.ok) parsed.ok = true;
  return parsed;
}

async function recordSlo(
  admin: ReturnType<typeof createClient>,
  status: "ok" | "degraded" | "failed" | "not_implemented",
  evidence: Record<string, unknown>,
  evidenceRef: string,
  nextAction: string | null,
): Promise<void> {
  try {
    await admin.rpc("did_record_slo_run", {
      p_pipeline_name: "external_reality_watch",
      p_status: status,
      p_evidence: evidence,
      p_evidence_ref: evidenceRef,
      p_next_action: nextAction,
    });
  } catch (e) {
    console.warn(
      "[ext-reality-orchestrator] slo_record_failed",
      (e as Error)?.message,
    );
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json({ ok: false, message: "method_not_allowed" }, 405);
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false },
  });

  // ── Auth: cron secret OR authenticated user ──
  const cronSecretHeader = req.headers.get("X-Karel-Cron-Secret") || "";
  let isCronSecretCall = false;
  if (cronSecretHeader) {
    try {
      const { data: ok } = await admin.rpc("verify_karel_cron_secret", {
        p_secret: cronSecretHeader,
      });
      isCronSecretCall = ok === true;
    } catch (e) {
      console.warn("[ext-reality-orch] cron secret rpc failed", (e as Error).message);
    }
  }

  let body: OrchestratorInput = {};
  try {
    body = await req.json();
  } catch {
    /* empty body allowed */
  }

  let userId: string | null = body.userId ?? null;
  if (!isCronSecretCall) {
    const auth = await requireAuth(req);
    if (auth instanceof Response) return auth;
    userId = (auth as { user: any }).user?.id ?? null;
  }
  if (!userId) {
    try {
      const { data: canonicalId } = await admin.rpc("get_canonical_did_user_id");
      if (typeof canonicalId === "string" && canonicalId) userId = canonicalId;
    } catch {/* ignore */}
  }
  if (!userId) {
    return json({ ok: false, error_code: "no_user_resolved" }, 400);
  }
  // Canonical guard
  try {
    const { data: canonicalId } = await admin.rpc("get_canonical_did_user_id");
    if (typeof canonicalId === "string" && canonicalId && canonicalId !== userId) {
      return json(
        { ok: false, error_code: "canonical_user_scope_mismatch" },
        403,
      );
    }
  } catch {/* non-fatal */}

  const date = body.date ?? pragueToday();
  const force = body.force === true;
  const source = body.source ?? "manual";
  const startedAt = new Date().toISOString();

  // ── Truth gate ──
  const gate = await evaluateDailyBriefingTruthGate(admin as any, {
    userId,
    briefingDatePrague: date,
  });

  if (!gate.ok && !force) {
    // Record audit row + degraded SLO so callers can see WHY we didn't run.
    const { data: row } = await admin
      .from("external_reality_daily_orchestrator_runs")
      .insert({
        user_id: userId,
        run_date: date,
        source_cycle_id: gate.source_cycle_id ?? null,
        truth_gate_ok: false,
        truth_gate_status: gate.status,
        provider_status: "not_run",
        status: "blocked_by_truth_gate",
        error_code: gate.status,
        error_message: gate.explanation?.slice(0, 480) ?? null,
        source,
        forced: false,
        idempotent_skip: false,
        payload: { gate_snapshot: gate.job_graph_snapshot },
        started_at: startedAt,
        completed_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    await recordSlo(
      admin,
      "degraded",
      { reason: "truth_gate_not_ok", gate_status: gate.status },
      "daily_orchestrator:truth_gate",
      "wait for daily-cycle to complete and required jobs to terminate",
    );
    return json(
      {
        ok: false,
        error_code: "truth_gate_not_ok",
        truth_gate_ok: false,
        truth_gate_status: gate.status,
        run_id: row?.id ?? null,
      },
      200,
    );
  }

  const sourceCycleId = gate.source_cycle_id;

  // ── Idempotency check ──
  if (!force && sourceCycleId) {
    const { data: existing } = await admin
      .from("external_reality_daily_orchestrator_runs")
      .select("id, status, internet_watch_run_id, provider_status")
      .eq("user_id", userId)
      .eq("run_date", date)
      .eq("source_cycle_id", sourceCycleId)
      .in("status", ["ok", "ok_provider_not_configured", "ok_provider_error"])
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (existing?.id) {
      return json({
        ok: true,
        idempotent_skip: true,
        run_id: existing.id,
        date,
        truth_gate_ok: true,
        source_cycle_id: sourceCycleId,
        provider_status: existing.provider_status,
      });
    }
  }

  // ── Step 1: internet_watch ──
  const watchResult = await callSentinelInternal(cronSecretHeader || "", {
    action: "internet_watch",
    date,
  });
  const providerStatus =
    (watchResult.status as string) ??
    (watchResult.ok ? "configured" : "provider_error");
  const watchRunId = (watchResult.watch_run_id as string | null) ?? null;
  const eventsCreated = Number(watchResult.events_created ?? 0);
  const eventsDeduped = Number(watchResult.events_deduped ?? 0);
  const sourceBacked = Number(watchResult.source_backed_events_count ?? 0);

  // ── Step 2: generate active-part daily briefs ──
  const briefResult = await callSentinelInternal(cronSecretHeader || "", {
    action: "generate_active_part_daily_brief",
    date,
  });
  const briefsUpserted = Number(
    (briefResult as any).briefs_upserted ?? 0,
  );

  // ── Determine final status ──
  let finalStatus = "ok";
  let errorCode: string | null = null;
  let errorMessage: string | null = null;
  if (providerStatus === "provider_not_configured") {
    finalStatus = "ok_provider_not_configured";
    errorCode = "provider_not_configured";
  } else if (providerStatus === "provider_error") {
    finalStatus = "ok_provider_error";
    errorCode = "provider_error";
    errorMessage = (watchResult.reason as string | undefined) ?? null;
  }

  // ── Audit row ──
  const completedAt = new Date().toISOString();
  const { data: insertedRow, error: insertErr } = await admin
    .from("external_reality_daily_orchestrator_runs")
    .insert({
      user_id: userId,
      run_date: date,
      source_cycle_id: sourceCycleId,
      truth_gate_ok: gate.ok,
      truth_gate_status: gate.status,
      provider_status: providerStatus,
      internet_watch_run_id: watchRunId,
      events_created: eventsCreated,
      events_deduped: eventsDeduped,
      active_part_briefs_upserted: briefsUpserted,
      status: finalStatus,
      error_code: errorCode,
      error_message: errorMessage,
      source,
      forced: force,
      idempotent_skip: false,
      payload: {
        internet_watch: watchResult,
        active_part_daily_brief: briefResult,
      },
      started_at: startedAt,
      completed_at: completedAt,
    })
    .select("id")
    .single();

  // If unique conflict (race), surface as idempotent_skip
  if (insertErr && /duplicate key|unique constraint/i.test(insertErr.message)) {
    return json({
      ok: true,
      idempotent_skip: true,
      date,
      truth_gate_ok: true,
      source_cycle_id: sourceCycleId,
      provider_status: providerStatus,
    });
  }

  // ── SLO truth ──
  if (providerStatus === "configured") {
    await recordSlo(
      admin,
      "ok",
      {
        events_created: eventsCreated,
        events_deduped: eventsDeduped,
        source_backed_events_count: sourceBacked,
        active_part_briefs_upserted: briefsUpserted,
        source_cycle_id: sourceCycleId,
      },
      `daily_orchestrator:configured`,
      null,
    );
  } else if (providerStatus === "provider_not_configured") {
    await recordSlo(
      admin,
      "degraded",
      { reason: "provider_not_configured" },
      "daily_orchestrator:provider_not_configured",
      "configure PERPLEXITY_API_KEY (or alternate provider)",
    );
  } else {
    await recordSlo(
      admin,
      "failed",
      {
        reason: "provider_error",
        details: (watchResult.reason as string | undefined) ?? null,
      },
      "daily_orchestrator:provider_error",
      "investigate provider error and retry",
    );
  }

  return json({
    ok: true,
    date,
    truth_gate_ok: true,
    source_cycle_id: sourceCycleId,
    internet_watch: watchResult,
    active_part_daily_brief: briefResult,
    idempotent_skip: false,
    run_id: insertedRow?.id ?? null,
    provider_status: providerStatus,
  });
});
