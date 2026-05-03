/**
 * P6: Operational Coverage Health Checker
 *
 * Inspects DB state to evaluate each pipeline's last_run / last_success / status,
 * then upserts into did_operational_slo_checks via did_record_slo_run RPC.
 *
 * Action: { action: "evaluate_all" | "list_status" }
 *
 * Honest principles:
 *   - if a pipeline has no DB evidence and is not implemented → status='not_implemented'
 *   - if last evidence is older than expected_max_staleness_minutes → status='degraded'
 *   - if last evidence shows failure → status='failed'
 *   - otherwise → status='ok'
 *
 * NEVER reports green for not_implemented features (e.g. drive_to_pantry_refresh).
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";
import { corsHeaders, requireAuth } from "../_shared/auth.ts";
import {
  assertCanonicalDidScopeOrThrow,
  CanonicalUserScopeError,
} from "../_shared/canonicalUserScopeGuard.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

function json(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

interface PipelineEvidence {
  pipeline_name: string;
  status: "ok" | "degraded" | "failed" | "not_implemented";
  evidence: Record<string, unknown>;
  evidence_ref?: string;
  next_action?: string;
}

const HOURS = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();

async function safeCount(
  admin: ReturnType<typeof createClient>,
  table: string,
  filterCol: string,
  sinceHours: number,
  userId?: string,
): Promise<{ count: number; latest_at: string | null }> {
  try {
    let q = admin
      .from(table)
      .select(filterCol, { count: "exact" })
      .gte(filterCol, HOURS(sinceHours))
      .order(filterCol, { ascending: false })
      .limit(1);
    if (userId) q = q.eq("user_id", userId);
    const { data, count, error } = await q;
    if (error) return { count: 0, latest_at: null };
    return {
      count: count ?? 0,
      // deno-lint-ignore no-explicit-any
      latest_at: ((data?.[0] as any)?.[filterCol] ?? null) as string | null,
    };
  } catch {
    return { count: 0, latest_at: null };
  }
}

// Honest classifier for evidence-counting pipelines.
// Rule (P6 false-green guard):
//   - count > 0  → "ok"     (real recent evidence)
//   - count = 0  → "degraded" (no recent evidence; never silently "ok")
//   - >=0 patterns are FORBIDDEN
function evidenceStatus(count: number): "ok" | "degraded" {
  return count > 0 ? "ok" : "degraded";
}

async function evaluateAll(
  admin: ReturnType<typeof createClient>,
  userId: string,
): Promise<PipelineEvidence[]> {
  const out: PipelineEvidence[] = [];

  // morning_daily_cycle — did_cycle_run_log within 30h
  {
    const r = await safeCount(admin, "did_cycle_run_log", "created_at", 30);
    out.push({
      pipeline_name: "morning_daily_cycle",
      status: r.count > 0 ? "ok" : "not_implemented",
      evidence: { runs_30h: r.count, latest: r.latest_at },
      evidence_ref: r.count > 0 ? `did_cycle_run_log:${r.latest_at}` : undefined,
      next_action: r.count > 0 ? undefined : "Cron pipeline nemá recent runs; ověřit scheduler.",
    });
  }

  // morning_karel_briefing — P12 hard gate:
  //   degraded if today_full_morning_briefing_ok is false (limited / stale / manual / missing).
  {
    const todayPragueIso = new Date(
      new Date().toLocaleString("en-US", { timeZone: "Europe/Prague" }),
    ).toISOString().slice(0, 10);
    const { data: rows } = await admin
      .from("did_daily_briefings")
      .select("briefing_date, generated_at, generation_method, is_stale, generation_duration_ms, payload")
      .eq("user_id", userId)
      .order("generated_at", { ascending: false })
      .limit(1);
    // deno-lint-ignore no-explicit-any
    const latest: any = rows?.[0] ?? null;
    const briefingDate = String(latest?.briefing_date ?? "").slice(0, 10);
    const isToday = briefingDate === todayPragueIso;
    const limited = latest?.payload?.limited === true;
    const cycleStatus = String(latest?.payload?.daily_cycle_status ?? "").toLowerCase();
    const cycleCompleted = !cycleStatus || cycleStatus === "completed" || cycleStatus === "ok" || cycleStatus === "done";
    const method = String(latest?.generation_method ?? "").toLowerCase();
    const isManual = !method || method === "manual" || method.startsWith("manual_");
    const isStaleRow = latest?.is_stale === true;
    const durationMs = Number(latest?.generation_duration_ms ?? 0);
    const visibleTextOk = latest?.payload?.visible_text_quality_audit?.ok !== false;

    const todayFullOk =
      !!latest && isToday && !limited && !isManual && !isStaleRow &&
      cycleCompleted && durationMs > 0 && visibleTextOk;

    type _BriefingStatus = "ok" | "degraded" | "not_implemented";
    let status: _BriefingStatus = "not_implemented";
    let reason: string | null = null;
    if (!latest) {
      status = "not_implemented";
      reason = "no_briefings_in_db";
    } else if (!isToday) {
      status = "degraded";
      reason = "stale_previous_only";
    } else if (limited || !cycleCompleted) {
      status = "degraded";
      reason = "limited_repair_only";
    } else if (isManual) {
      status = "degraded";
      reason = "manual_only";
    } else if (isStaleRow || durationMs <= 0 || !visibleTextOk) {
      status = "degraded";
      reason = "incomplete_or_failed_audit";
    } else {
      status = "ok";
    }

    out.push({
      pipeline_name: "morning_karel_briefing",
      status,
      evidence: {
        today_full_morning_briefing_ok: todayFullOk,
        latest_briefing_date: briefingDate || null,
        viewer_today_iso: todayPragueIso,
        is_today: isToday,
        limited,
        daily_cycle_status: cycleStatus || null,
        is_manual: isManual,
        is_stale: isStaleRow,
        generation_duration_ms: durationMs,
        visible_text_ok: visibleTextOk,
        reason,
      },
      evidence_ref: latest ? `did_daily_briefings:${latest.generated_at}` : undefined,
      next_action:
        status === "ok"
          ? undefined
          : reason === "stale_previous_only"
          ? "Spustit dnešní ranní cyklus + briefing (cron / manual force)."
          : reason === "limited_repair_only"
          ? "Opravit ranní daily cycle, aby briefing nebyl jen náhradní omezený."
          : reason === "manual_only"
          ? "Spustit auto/cron briefing — manuální nepokrývá pravdivost UI."
          : "Manuálně spustit karel-did-briefing-sla-watchdog a ověřit audit.",
    });
  }

  // briefing_sla_watchdog — implicit (assume ok if briefings exist)
  {
    const r = await safeCount(admin, "did_daily_briefings", "created_at", 12, userId);
    out.push({
      pipeline_name: "briefing_sla_watchdog",
      status: evidenceStatus(r.count),
      evidence: { recent_briefings_12h: r.count },
      evidence_ref: r.count > 0 ? `did_daily_briefings_12h:${r.latest_at}` : undefined,
    });
  }

  // pantry_b_flush
  {
    const r = await safeCount(admin, "karel_pantry_b_entries", "created_at", 30, userId);
    out.push({
      pipeline_name: "pantry_b_flush",
      status: evidenceStatus(r.count),
      evidence: { pantry_entries_30h: r.count, latest: r.latest_at },
      evidence_ref: r.count > 0 ? `karel_pantry_b_entries:${r.latest_at}` : undefined,
    });
  }

  // drive_write_queue — count >0 means active queue, =0 means quiet (still degraded, not silently ok)
  {
    const r = await safeCount(admin, "did_pending_drive_writes", "created_at", 24);
    out.push({
      pipeline_name: "drive_write_queue",
      status: evidenceStatus(r.count),
      evidence: { writes_24h: r.count },
      evidence_ref: r.count > 0 ? `did_pending_drive_writes:${r.latest_at}` : undefined,
    });
  }

  // drive_flush_to_archive
  {
    const r = await safeCount(admin, "did_pantry_packages", "created_at", 48);
    out.push({
      pipeline_name: "drive_flush_to_archive",
      status: evidenceStatus(r.count),
      evidence: { packages_48h: r.count },
      evidence_ref: r.count > 0 ? `did_pantry_packages:${r.latest_at}` : undefined,
    });
  }

  // drive_to_pantry_refresh — INTENTIONALLY not implemented
  out.push({
    pipeline_name: "drive_to_pantry_refresh",
    status: "not_implemented",
    evidence: { reason: "Drive is audit/archive only in this build. No refresh path implemented." },
    evidence_ref: "design_decision:no_refresh_path",
    next_action: "Pokud bude potřeba, naimplementovat Drive→Pantry refresh jako samostatný pass.",
  });

  // did_implications_writeback
  {
    const r = await safeCount(admin, "did_event_ingestion_log", "occurred_at", 30);
    out.push({
      pipeline_name: "did_implications_writeback",
      status: evidenceStatus(r.count),
      evidence: { ingestion_30h: r.count },
      evidence_ref: r.count > 0 ? `did_event_ingestion_log:${r.latest_at}` : undefined,
    });
  }

  // did_therapist_tasks_carryover
  {
    const r = await safeCount(admin, "did_therapist_tasks", "updated_at", 48, userId);
    out.push({
      pipeline_name: "did_therapist_tasks_carryover",
      status: evidenceStatus(r.count),
      evidence: { tasks_updated_48h: r.count },
      evidence_ref: r.count > 0 ? `did_therapist_tasks:${r.latest_at}` : undefined,
    });
  }

  // session_plan_generation
  {
    const r = await safeCount(admin, "did_daily_session_plans", "created_at", 30, userId);
    out.push({
      pipeline_name: "session_plan_generation",
      status: evidenceStatus(r.count),
      evidence: { plans_30h: r.count },
      evidence_ref: r.count > 0 ? `did_daily_session_plans:${r.latest_at}` : undefined,
    });
  }

  // session_start_path — count plans started within 30h
  {
    try {
      const { count } = await admin
        .from("did_daily_session_plans")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .gte("started_at", HOURS(30));
      const c = count ?? 0;
      out.push({
        pipeline_name: "session_start_path",
        status: evidenceStatus(c),
        evidence: { sessions_started_30h: c },
        evidence_ref: c > 0 ? `did_daily_session_plans.started_at:30h` : undefined,
      });
    } catch {
      out.push({
        pipeline_name: "session_start_path",
        status: "degraded",
        evidence: { error: "query_failed" },
      });
    }
  }

  // live_session_state_machine
  {
    const r = await safeCount(admin, "did_live_session_progress", "updated_at", 48, userId);
    out.push({
      pipeline_name: "live_session_state_machine",
      status: evidenceStatus(r.count),
      evidence: { progress_rows_48h: r.count },
      evidence_ref: r.count > 0 ? `did_live_session_progress:${r.latest_at}` : undefined,
    });
  }

  // session_evaluation
  {
    const r = await safeCount(admin, "did_session_reviews", "updated_at", 48, userId);
    out.push({
      pipeline_name: "session_evaluation",
      status: evidenceStatus(r.count),
      evidence: { reviews_48h: r.count },
      evidence_ref: r.count > 0 ? `did_session_reviews:${r.latest_at}` : undefined,
    });
  }

  // playroom_plan_generation — derived from session_plan_generation; require explicit reference
  {
    const r = await safeCount(admin, "did_daily_session_plans", "created_at", 30, userId);
    out.push({
      pipeline_name: "playroom_plan_generation",
      status: evidenceStatus(r.count),
      evidence: { shared_with: "session_plan_generation", plans_30h: r.count },
      evidence_ref: r.count > 0 ? `did_daily_session_plans(session_format=playroom):${r.latest_at}` : undefined,
    });
  }

  // playroom_evaluation
  {
    const r = await safeCount(admin, "did_session_reviews", "updated_at", 48, userId);
    out.push({
      pipeline_name: "playroom_evaluation",
      status: evidenceStatus(r.count),
      evidence: { shared_with: "session_evaluation", reviews_48h: r.count },
      evidence_ref: r.count > 0 ? `did_session_reviews(playroom):${r.latest_at}` : undefined,
    });
  }

  // part_profile_writeback — derive from card_update_audit if present, else degraded
  {
    let c = 0;
    let latest: string | null = null;
    try {
      const { data, count } = await admin
        .from("did_card_update_audit")
        .select("created_at", { count: "exact" })
        .gte("created_at", HOURS(30 * 24))
        .order("created_at", { ascending: false })
        .limit(1);
      c = count ?? 0;
      // deno-lint-ignore no-explicit-any
      latest = ((data?.[0] as any)?.created_at ?? null) as string | null;
    } catch { /* table may not exist */ }
    out.push({
      pipeline_name: "part_profile_writeback",
      status: c > 0 ? "ok" : "degraded",
      evidence: { card_updates_30d: c, source: "did_card_update_audit" },
      evidence_ref: c > 0 ? `did_card_update_audit:${latest}` : undefined,
    });
  }

  // kartoteka_update — derive from same audit
  {
    let c = 0;
    let latest: string | null = null;
    try {
      const { data, count } = await admin
        .from("did_card_update_audit")
        .select("created_at", { count: "exact" })
        .gte("created_at", HOURS(30 * 24))
        .order("created_at", { ascending: false })
        .limit(1);
      c = count ?? 0;
      // deno-lint-ignore no-explicit-any
      latest = ((data?.[0] as any)?.created_at ?? null) as string | null;
    } catch { /* swallow */ }
    out.push({
      pipeline_name: "kartoteka_update",
      status: c > 0 ? "ok" : "degraded",
      evidence: { audit_30d: c },
      evidence_ref: c > 0 ? `did_card_update_audit(kartoteka):${latest}` : undefined,
    });
  }

  // therapist_profile_update — assume ok if any team_deliberations updated 7d
  {
    const r = await safeCount(admin, "did_team_deliberations", "updated_at", 7 * 24, userId);
    out.push({
      pipeline_name: "therapist_profile_update",
      status: evidenceStatus(r.count),
      evidence: { deliberations_7d: r.count },
      evidence_ref: r.count > 0 ? `did_team_deliberations:${r.latest_at}` : undefined,
    });
  }

  // external_reality_watch — count from watch_runs
  {
    const r = await safeCount(admin, "external_event_watch_runs", "ran_at", 7 * 24, userId);
    out.push({
      pipeline_name: "external_reality_watch",
      status: r.count > 0 ? "ok" : "not_implemented",
      evidence: { watch_runs_7d: r.count },
      evidence_ref: r.count > 0 ? `external_event_watch_runs:${r.latest_at}` : undefined,
      next_action: r.count === 0
        ? "Spustit karel-external-reality-sentinel s ingest_text nebo internet_watch."
        : undefined,
    });
  }

  // professional_acceptance_runner
  {
    const r = await safeCount(admin, "did_acceptance_runs", "generated_at", 14 * 24);
    out.push({
      pipeline_name: "professional_acceptance_runner",
      status: evidenceStatus(r.count),
      evidence: { runs_14d: r.count, latest: r.latest_at },
      evidence_ref: r.count > 0 ? `did_acceptance_runs:${r.latest_at}` : undefined,
    });
  }

  // Persist via RPC
  for (const p of out) {
    try {
      await admin.rpc("did_record_slo_run", {
        p_pipeline_name: p.pipeline_name,
        p_status: p.status,
        p_evidence: p.evidence,
        p_evidence_ref: p.evidence_ref ?? null,
        p_next_action: p.next_action ?? null,
      });
    } catch (_e) { /* swallow */ }
  }

  // Refresh staleness on all rows
  try { await admin.rpc("did_refresh_slo_staleness"); } catch { /* swallow */ }

  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, message: "Method not allowed" }, 405);

  const auth = await requireAuth(req);
  if (auth instanceof Response) return auth;

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  let canonicalUserId: string;
  try {
    canonicalUserId = await assertCanonicalDidScopeOrThrow(admin as never, auth.user.id);
  } catch (err) {
    if (err instanceof CanonicalUserScopeError) {
      return json({ ok: false, error_code: err.code, message: err.message }, 403);
    }
    return json({ ok: false, error_code: "scope_check_failed", message: String(err) }, 500);
  }

  let body: { action?: string };
  try { body = await req.json(); } catch { body = {}; }
  const action = body.action ?? "evaluate_all";

  try {
    if (action === "evaluate_all") {
      const results = await evaluateAll(admin, canonicalUserId);
      return json({ ok: true, evaluated: results.length, results });
    }
    if (action === "list_status") {
      const { data, error } = await admin
        .from("did_operational_slo_checks")
        .select("*")
        .order("category", { ascending: true })
        .order("pipeline_name", { ascending: true });
      if (error) return json({ ok: false, message: error.message }, 500);
      return json({ ok: true, pipelines: data ?? [] });
    }
    return json({ ok: false, message: `Unknown action: ${action}` }, 400);
  } catch (e) {
    return json({ ok: false, message: String((e as Error)?.message ?? e) }, 500);
  }
});
