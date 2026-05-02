/**
 * P4: Professional Acceptance Runner — edge function.
 *
 * Vyhodnocuje SQL audit + deployment + guard kontroly pro pass `P1` a
 * `P2_P3`, sestaví strukturovaný `AcceptanceRun` a perzistuje do
 * `did_acceptance_runs` (RLS bypass přes service_role).
 *
 * DOM/Vitest/Deno test kontroly NEsmí běžet v edge runtime — jejich výstupy
 * se předávají z volajícího (CLI runner / UI panel) v `client_evidence`.
 *
 * Body:
 *   { pass_name: "P1" | "P2_P3", client_evidence?: Record<string, unknown> }
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";
import { corsHeaders, requireAuth } from "../_shared/auth.ts";
import {
  assertCanonicalDidScopeOrThrow,
  CanonicalUserScopeError,
} from "../_shared/canonicalUserScopeGuard.ts";
import {
  type AcceptanceCheck,
  buildRun,
  P1_CHECK_IDS,
  P2P3_CHECK_IDS,
} from "../_shared/professionalAcceptanceRegistry.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

function json(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

type ClientEvidence = {
  briefing_dom_forbidden_count?: number;
  herna_modal_dom_forbidden_count?: number;
  team_deliberation_modal_forbidden_count?: number;
  live_session_dom_forbidden_count?: number;
  required_all_true?: boolean;
  tests_passed?: boolean;
  edge_helpers_present?: boolean;
  notes?: string;
};

function intCheck(
  id: string,
  label: string,
  observed: unknown,
  expectedZero: boolean,
  required: boolean,
): AcceptanceCheck {
  if (typeof observed !== "number" || Number.isNaN(observed)) {
    return {
      id, label, type: "sql_check", required, status: "skipped",
      observed, expected: expectedZero ? "= 0" : ">= 0",
      message: "Observed value missing or not a number.",
    };
  }
  const ok = expectedZero ? observed === 0 : observed >= 0;
  return {
    id, label, type: "sql_check", required,
    observed, expected: expectedZero ? "= 0" : ">= 0",
    status: ok ? "passed" : "failed",
  };
}

function boolCheck(
  id: string,
  label: string,
  type: AcceptanceCheck["type"],
  observed: unknown,
  required: boolean,
  message?: string,
): AcceptanceCheck {
  if (typeof observed !== "boolean") {
    return {
      id, label, type, required, status: "skipped",
      observed, expected: "true",
      message: message ?? "Observed value missing.",
    };
  }
  return {
    id, label, type, required, observed,
    expected: "true",
    status: observed ? "passed" : "failed",
    message: observed ? undefined : message,
  };
}

async function p1Checks(admin: ReturnType<typeof createClient>, ev: ClientEvidence): Promise<{
  checks: AcceptanceCheck[];
  evidence: Record<string, unknown>;
}> {
  const checks: AcceptanceCheck[] = [];

  // Pure DOM/test checks come from client_evidence (browser-driven proofs).
  checks.push(intCheck(P1_CHECK_IDS.briefing_dom, "Karlův přehled DOM forbidden_count",
    ev.briefing_dom_forbidden_count, true, true));
  checks.push(intCheck(P1_CHECK_IDS.herna_dom, "Herna modal DOM forbidden_count",
    ev.herna_modal_dom_forbidden_count, true, true));
  checks.push(intCheck(P1_CHECK_IDS.team_delib_dom, "Team deliberation modal DOM forbidden_count",
    ev.team_deliberation_modal_forbidden_count, true, true));
  checks.push(intCheck(P1_CHECK_IDS.live_session_dom, "Live session DOM forbidden_count",
    ev.live_session_dom_forbidden_count, true, true));

  // visible_fields_dirty_count via SQL — scan persisted plan/deliberation text
  // for forbidden tokens that would surface in UI.
  const { data: dirty, error: dirtyErr } = await admin.rpc("did_count_visible_dirty_fields");
  let dirtyCount: number | null = null;
  if (dirtyErr) {
    // RPC may not exist in older deployments — fall back to inline COUNT.
    const inline = await admin
      .from("did_team_deliberations")
      .select("id", { count: "exact", head: true })
      .or(`karel_proposed_plan.ilike.%Fallback%,karel_proposed_plan.ilike.%Karel-led%`);
    dirtyCount = typeof inline.count === "number" ? inline.count : null;
  } else {
    dirtyCount = typeof dirty === "number" ? dirty : null;
  }
  checks.push(intCheck(P1_CHECK_IDS.visible_fields_dirty,
    "Persisted visible-fields dirty count", dirtyCount ?? undefined, true, true));

  checks.push(boolCheck(P1_CHECK_IDS.required_all_true,
    "DOM required-text all true", "dom_check", ev.required_all_true, true,
    "Required clinical phrases missing in one of the surfaces."));

  checks.push(boolCheck(P1_CHECK_IDS.tests_passed,
    "Vitest suite", "test_check", ev.tests_passed, true,
    "Vitest reported failing tests."));

  return {
    checks,
    evidence: {
      visible_fields_dirty_count: dirtyCount,
      client_evidence: ev,
    },
  };
}

async function p2p3Checks(admin: ReturnType<typeof createClient>, ev: ClientEvidence): Promise<{
  checks: AcceptanceCheck[];
  evidence: Record<string, unknown>;
}> {
  const checks: AcceptanceCheck[] = [];

  // canonical scope
  let canonicalUserId: string | null = null;
  let canonicalActive = 0;
  {
    const { data, error } = await admin
      .from("did_canonical_scope")
      .select("canonical_user_id", { count: "exact" })
      .eq("scope_name", "primary_did")
      .eq("active", true)
      .eq("seed_status", "ready");
    if (!error) {
      canonicalActive = data?.length ?? 0;
      canonicalUserId = (data?.[0]?.canonical_user_id as string | undefined) ?? null;
    }
  }
  checks.push({
    id: P2P3_CHECK_IDS.canonical_active_count,
    label: "Canonical scope active count",
    type: "sql_check", required: true,
    observed: canonicalActive, expected: "= 1",
    status: canonicalActive === 1 ? "passed" : "failed",
  });
  checks.push({
    id: P2P3_CHECK_IDS.canonical_user_resolves,
    label: "Canonical user id resolves",
    type: "guard_check", required: true,
    observed: canonicalUserId, expected: "uuid present",
    status: canonicalUserId ? "passed" : "failed",
  });

  // orphan fresh rows (last 7 days) — count rows whose user_id != canonical
  const sevenDays = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  let teamOrphan = 0;
  let plansOrphan = 0;
  if (canonicalUserId) {
    const td = await admin
      .from("did_team_deliberations")
      .select("id", { count: "exact", head: true })
      .gt("created_at", sevenDays)
      .neq("user_id", canonicalUserId);
    teamOrphan = td.count ?? 0;
    const dp = await admin
      .from("did_daily_session_plans")
      .select("id", { count: "exact", head: true })
      .gt("created_at", sevenDays)
      .neq("user_id", canonicalUserId);
    plansOrphan = dp.count ?? 0;
  }
  checks.push(intCheck(P2P3_CHECK_IDS.team_delib_orphan_fresh_7d,
    "did_team_deliberations orphan fresh 7d", teamOrphan, true, true));
  checks.push(intCheck(P2P3_CHECK_IDS.daily_plans_orphan_fresh_7d,
    "did_daily_session_plans orphan fresh 7d", plansOrphan, true, true));

  // RPC + table existence
  const { data: routines } = await admin.rpc("did_p4_acceptance_inventory");
  const inv = (routines ?? {}) as Record<string, boolean>;
  const snapshotRpc = inv.snapshot_rpc_exists === true;
  const rollbackRpc = inv.rollback_rpc_exists === true;
  const snapshotsTable = inv.snapshots_table_exists === true;
  const snapshotsTotal = typeof inv.snapshots_total === "number" ? inv.snapshots_total : null;

  checks.push(boolCheck(P2P3_CHECK_IDS.snapshot_rpc_exists,
    "did_snapshot_protected_mutation exists", "guard_check", snapshotRpc, true));
  checks.push(boolCheck(P2P3_CHECK_IDS.rollback_rpc_exists,
    "did_rollback_protected_mutation exists", "guard_check", rollbackRpc, true));
  checks.push(boolCheck(P2P3_CHECK_IDS.snapshots_table_exists,
    "did_mutation_snapshots table exists", "guard_check", snapshotsTable, true));
  checks.push({
    id: P2P3_CHECK_IDS.snapshots_total,
    label: "did_mutation_snapshots total rows",
    type: "sql_check", required: false,
    observed: snapshotsTotal, expected: ">= 0",
    status: snapshotsTotal !== null ? "passed" : "skipped",
  });

  checks.push(boolCheck(P2P3_CHECK_IDS.edge_helpers_present,
    "Edge functions wired with helpers (CLI/CI verified)",
    "deployment_check", ev.edge_helpers_present, true,
    "CLI runner could not confirm edge wiring."));

  checks.push(boolCheck(P2P3_CHECK_IDS.tests_passed,
    "Production helper tests + Vitest suite",
    "test_check", ev.tests_passed, true,
    "Tests failed or were not provided."));

  return {
    checks,
    evidence: {
      canonical_user_id: canonicalUserId,
      canonical_active_count: canonicalActive,
      team_delib_orphan_fresh_7d: teamOrphan,
      daily_plans_orphan_fresh_7d: plansOrphan,
      inventory: inv,
      client_evidence: ev,
    },
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, message: "Method not allowed" }, 405);

  const auth = await requireAuth(req);
  if (auth instanceof Response) return auth;

  const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  // Canonical user enforcement (P2 wiring of the runner itself)
  try {
    await assertCanonicalDidScopeOrThrow(admin as never, auth.user.id);
  } catch (err) {
    if (err instanceof CanonicalUserScopeError) {
      return json({ ok: false, error_code: err.code, message: err.message }, 403);
    }
    return json({ ok: false, error_code: "scope_check_failed", message: String(err) }, 500);
  }

  let body: { pass_name?: string; client_evidence?: ClientEvidence; app_version?: string };
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, message: "Invalid JSON body" }, 400);
  }

  const passName = body.pass_name;
  if (passName !== "P1" && passName !== "P2_P3") {
    return json({ ok: false, message: "pass_name must be 'P1' or 'P2_P3'" }, 400);
  }
  const ev: ClientEvidence = body.client_evidence ?? {};

  const { checks, evidence } = passName === "P1"
    ? await p1Checks(admin, ev)
    : await p2p3Checks(admin, ev);

  const run = buildRun(passName, checks, evidence, body.app_version);

  // Persist
  const { data: persisted, error: insertErr } = await admin
    .from("did_acceptance_runs")
    .insert({
      pass_name: run.pass_name,
      status: run.status,
      generated_at: run.generated_at,
      checks: run.checks,
      failed_checks: run.failed_checks,
      evidence: run.evidence,
      created_by: auth.user.id,
      app_version: run.app_version ?? null,
    })
    .select("id")
    .single();

  if (insertErr) {
    return json({ ok: false, message: `persist failed: ${insertErr.message}`, run }, 500);
  }

  return json({ ok: true, run_id: persisted?.id, run });
});
