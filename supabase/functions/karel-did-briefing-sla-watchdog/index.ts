// @ts-nocheck
/**
 * karel-did-briefing-sla-watchdog
 * ───────────────────────────────────────────────────────────
 * Cílem této funkce je zajistit, že každé ráno existuje pro aktuální
 * Europe/Prague den `did_daily_briefings` row, který:
 *
 *   - has generation_method ∈ {sla_watchdog, sla_watchdog_repair,
 *     auto_repair_after_missed_morning, auto_sla_test}  (= NIKDY manual)
 *   - has is_stale = false
 *   - byl vyroben non-manual cestou (cron secret nebo service role)
 *
 * Pravidlo idempotence:
 *   Pokud už existuje fresh non-manual briefing pro dnešek, watchdog končí no-op
 *   a zapíše audit row do `did_briefing_sla_runs` s action='skipped_already_ok'.
 *
 * Decision matrix:
 *   - fresh non-manual exists       → no-op
 *   - only manual exists            → vyrob sla_watchdog(_repair) a manual řádek
 *                                     se v briefing fn označí stale
 *   - cycle completed + no fresh    → method=sla_watchdog
 *   - cycle running/failed/missing  → method=sla_watchdog_repair (limited)
 *
 * Auth: cron-secret header `X-Karel-Cron-Secret` NEBO service-role bearer.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, x-karel-cron-secret",
};

const ZERO_UUID = "00000000-0000-0000-0000-000000000000";
const STALE_CYCLE_MINUTES = 90;

const pragueDayISO = (d: Date = new Date()): string =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Prague" }).format(d);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

interface AuditArgs {
  user_id: string;
  action: "skipped_already_ok" | "invoked_briefing" | "wrote_limited" | "error" | "unauthorized";
  reason?: string | null;
  briefing_id?: string | null;
  briefing_attempt_id?: string | null;
  cycle_status?: string | null;
  generation_method?: string | null;
  payload?: Record<string, unknown>;
}

async function audit(sb: any, args: AuditArgs) {
  try {
    await sb.from("did_briefing_sla_runs").insert({
      user_id: args.user_id,
      action: args.action,
      reason: args.reason ?? null,
      briefing_id: args.briefing_id ?? null,
      briefing_attempt_id: args.briefing_attempt_id ?? null,
      cycle_status: args.cycle_status ?? null,
      generation_method: args.generation_method ?? null,
      payload: args.payload ?? {},
    });
  } catch (e) {
    console.error("[sla-watchdog] audit insert failed:", e);
  }
}

interface DecideResult {
  action: "noop" | "invoke_sla_watchdog" | "invoke_sla_repair";
  method?: "sla_watchdog" | "sla_watchdog_repair";
  reason: string;
  cycle_status?: string;
  cycle_id?: string | null;
}

/**
 * Pure decision logic. Exported for unit tests.
 */
export function decideAction(input: {
  fresh_non_manual_exists: boolean;
  fresh_manual_exists: boolean;
  cycle_status: "completed" | "running" | "failed" | "failed_stale" | "missing" | null;
  cycle_id?: string | null;
}): DecideResult {
  if (input.fresh_non_manual_exists) {
    return { action: "noop", reason: "fresh_non_manual_exists", cycle_status: input.cycle_status ?? undefined };
  }
  if (input.cycle_status === "completed") {
    return {
      action: "invoke_sla_watchdog",
      method: "sla_watchdog",
      reason: input.fresh_manual_exists ? "replacing_manual_with_sla_watchdog" : "no_fresh_briefing_cycle_completed",
      cycle_status: input.cycle_status,
      cycle_id: input.cycle_id ?? null,
    };
  }
  // cycle running/failed/missing/null  → limited repair
  const reason =
    input.cycle_status === "running"        ? "cycle_running" :
    input.cycle_status === "failed_stale"   ? "cycle_stuck"   :
    input.cycle_status === "failed"         ? "cycle_failed"  :
    "cycle_missing";
  return {
    action: "invoke_sla_repair",
    method: "sla_watchdog_repair",
    reason,
    cycle_status: input.cycle_status ?? "missing",
    cycle_id: input.cycle_id ?? null,
  };
}

if ((import.meta as any).main) {
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const sb = createClient(supabaseUrl, serviceKey);

  // Auth: cron secret header OR service role bearer
  const authHeader = req.headers.get("Authorization") || "";
  const cronSecretHeader = req.headers.get("X-Karel-Cron-Secret") || "";
  const isServiceCall = !!serviceKey && authHeader === `Bearer ${serviceKey}`;
  let isCronSecretCall = false;
  if (cronSecretHeader) {
    try {
      const { data: ok } = await sb.rpc("verify_karel_cron_secret", { p_secret: cronSecretHeader });
      isCronSecretCall = ok === true;
    } catch (e) {
      console.warn("[sla-watchdog] cron secret rpc failed:", (e as Error)?.message);
    }
  }
  if (!isServiceCall && !isCronSecretCall) {
    await audit(sb, {
      user_id: ZERO_UUID,
      action: "unauthorized",
      reason: "missing_or_invalid_cron_secret",
    });
    return json({ error: "unauthorized" }, 401);
  }

  let body: any = {};
  try { body = await req.json(); } catch { /* GET / no body */ }

  // Discover scoped user. Priority:
  //   1) explicit body.userId
  //   2) most recent today's briefing (manual or otherwise) — keeps SLA scoped
  //      to the same user the therapist is actually using
  //   3) most recent did_update_cycles user
  //   4) most recent did_threads activity
  let scopedUserId: string | null = body?.userId || null;
  if (!scopedUserId) {
    // Prefer most-recent MANUAL briefing today — manual rows come from a real
    // therapist UI session, so they reliably identify the correct human user.
    const todayISO = pragueDayISO();
    const { data: latestManual } = await sb
      .from("did_daily_briefings")
      .select("user_id, generation_method, generated_at")
      .eq("briefing_date", todayISO)
      .not("user_id", "is", null)
      .neq("user_id", ZERO_UUID)
      .or("generation_method.eq.manual,generation_method.like.manual_%")
      .order("generated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    scopedUserId = latestManual?.user_id ?? null;
  }
  if (!scopedUserId) {
    const { data: cycleUser } = await sb
      .from("did_update_cycles")
      .select("user_id")
      .not("user_id", "is", null)
      .neq("user_id", ZERO_UUID)
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    scopedUserId = cycleUser?.user_id ?? null;
  }
  if (!scopedUserId) {
    const { data: anyThread } = await sb
      .from("did_threads")
      .select("user_id")
      .not("user_id", "is", null)
      .neq("user_id", ZERO_UUID)
      .order("last_activity_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    scopedUserId = anyThread?.user_id ?? null;
  }
  if (!scopedUserId) return json({ error: "missing_user_scope" }, 400);

  const today = pragueDayISO();
  const overrideMethod = typeof body?.method === "string" ? body.method : null;

  // Step 1: idempotence check
  const { data: freshRows, error: freshErr } = await sb
    .from("did_daily_briefings")
    .select("id, generation_method, generated_at, is_stale")
    .eq("briefing_date", today)
    .eq("user_id", scopedUserId)
    .eq("is_stale", false)
    .order("generated_at", { ascending: false });

  if (freshErr) {
    await audit(sb, { user_id: scopedUserId, action: "error", reason: `fresh_lookup_failed: ${freshErr.message}` });
    return json({ error: "fresh_lookup_failed", details: freshErr.message }, 500);
  }

  const freshList = freshRows ?? [];
  const freshNonManual = freshList.find((r: any) =>
    r.generation_method && r.generation_method !== "manual" && !String(r.generation_method).startsWith("manual")
  );
  const freshManual = freshList.find((r: any) =>
    !r.generation_method || r.generation_method === "manual" || String(r.generation_method).startsWith("manual")
  );

  // Step 2: cycle status
  const morningStartUtc = `${today}T00:00:00Z`;
  // Watchdog horizon — cover the whole day so we don't miss late cycle completion
  const morningEndUtc   = `${today}T23:59:59Z`;
  const { data: cycleRow } = await sb
    .from("did_update_cycles")
    .select("id, status, started_at, last_heartbeat_at, last_error")
    .eq("cycle_type", "daily")
    .eq("user_id", scopedUserId)
    .gte("started_at", morningStartUtc)
    .lt("started_at", morningEndUtc)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  let cycleStatus: any = !cycleRow ? "missing" : cycleRow.status;
  if (cycleRow && cycleStatus === "running") {
    const ageMs = Date.now() - new Date(cycleRow.last_heartbeat_at || cycleRow.started_at).getTime();
    if (ageMs > STALE_CYCLE_MINUTES * 60 * 1000) cycleStatus = "failed_stale";
  }

  const decision = decideAction({
    fresh_non_manual_exists: !!freshNonManual,
    fresh_manual_exists: !!freshManual,
    cycle_status: cycleStatus,
    cycle_id: cycleRow?.id ?? null,
  });

  // Optional override (used by tests / forced repair)
  if (overrideMethod === "auto_sla_test" && decision.action === "noop") {
    decision.action = "invoke_sla_watchdog";
    decision.method = "sla_watchdog" as any;
    decision.reason = "test_override";
  }

  if (decision.action === "noop") {
    await audit(sb, {
      user_id: scopedUserId,
      action: "skipped_already_ok",
      reason: decision.reason,
      briefing_id: freshNonManual?.id || null,
      cycle_status: decision.cycle_status,
      generation_method: freshNonManual?.generation_method || null,
    });
    return json({
      ok: true,
      action: "skipped_already_ok",
      reason: decision.reason,
      briefing_id: freshNonManual?.id || null,
      cycle_status: cycleStatus,
      briefing_date: today,
    });
  }

  // Step 3: invoke briefing fn with appropriate method
  const briefingMethod = overrideMethod && overrideMethod !== "auto_sla_test"
    ? overrideMethod
    : (decision.method || "sla_watchdog_repair");

  const briefingUrl = `${supabaseUrl}/functions/v1/karel-did-daily-briefing`;
  let briefingId: string | null = null;
  let briefingAttemptId: string | null = null;
  let briefingErr: string | null = null;

  try {
    const resp = await fetch(briefingUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${serviceKey}`,
      },
      body: JSON.stringify({
        method: briefingMethod,
        source: "sla_watchdog",
        force: true,
        userId: scopedUserId,
      }),
    });
    const text = await resp.text();
    let parsed: any = null;
    try { parsed = JSON.parse(text); } catch { /* keep null */ }
    if (!resp.ok) {
      briefingErr = `briefing_http_${resp.status}: ${text.slice(0, 300)}`;
    } else {
      briefingId = parsed?.briefing?.id || null;
    }
  } catch (e) {
    briefingErr = `briefing_fetch_failed: ${(e as Error).message}`;
  }

  // Look up the attempt id we just created (best-effort)
  try {
    const { data: latestAttempt } = await sb
      .from("did_daily_briefing_attempts")
      .select("id")
      .eq("user_id", scopedUserId)
      .eq("briefing_date", today)
      .eq("generation_method", briefingMethod)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    briefingAttemptId = latestAttempt?.id || null;
  } catch { /* best effort */ }

  if (briefingErr) {
    await audit(sb, {
      user_id: scopedUserId,
      action: "error",
      reason: briefingErr,
      cycle_status: cycleStatus,
      generation_method: briefingMethod,
      briefing_attempt_id: briefingAttemptId,
    });
    return json({ ok: false, error: briefingErr, action: decision.action }, 500);
  }

  const auditAction =
    decision.action === "invoke_sla_repair" ? "wrote_limited" : "invoked_briefing";
  await audit(sb, {
    user_id: scopedUserId,
    action: auditAction as any,
    reason: decision.reason,
    briefing_id: briefingId,
    briefing_attempt_id: briefingAttemptId,
    cycle_status: cycleStatus,
    generation_method: briefingMethod,
  });

  return json({
    ok: true,
    action: auditAction,
    reason: decision.reason,
    briefing_id: briefingId,
    briefing_attempt_id: briefingAttemptId,
    cycle_status: cycleStatus,
    generation_method: briefingMethod,
    briefing_date: today,
  });
});
}
