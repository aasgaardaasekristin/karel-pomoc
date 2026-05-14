/**
 * karel-playroom-preview — FÁZE 1 (HERNA runtime preview)
 *
 * Read-only helper, který sestaví terapeutickou kartu Herny POUZE z runtime dat:
 *   1) did_daily_context.context_json          (canonical daily snapshot)
 *   2) karel_working_memory_snapshots          (derived WM continuity)
 *   3) did_daily_session_plans / playroom_plan (dnešní session plan)
 *
 * Nezasahuje do workspace flow. Vrací stabilní `preview_ready` payload, který je
 * strukturálně kompatibilní s budoucím karel-part-session-prepare kontraktem
 * (workspace_ready | pipeline_repair_required | pipeline_broken).
 *
 * ŽÁDNÝ child-facing text. ŽÁDNÝ fallback. ŽÁDNÉ poradní CTA.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { requireAuth, corsHeaders } from "../_shared/auth.ts";

function pragueTodayISO(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Prague" }).format(new Date());
}

function jsonRes(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

type ReadinessKey = "green" | "amber" | "red" | "unknown";

function pickReadiness(plan: any, contract: any): ReadinessKey {
  const raw = String(plan?.readiness_today ?? contract?.readiness_today ?? contract?.playroom_plan?.readiness_today ?? "").toLowerCase();
  if (raw === "green" || raw === "amber" || raw === "red") return raw;
  return "unknown";
}

function pickTreatmentPhase(plan: any, contract: any): string {
  return String(
    plan?.treatment_phase
      ?? contract?.treatment_phase
      ?? contract?.playroom_plan?.treatment_phase
      ?? "stabilization",
  );
}

function pickPlannedPart(plan: any, contract: any, fallback: string): string {
  return String(plan?.selected_part ?? contract?.planned_part ?? contract?.playroom_plan?.part_name ?? fallback ?? "").trim();
}

/**
 * Deterministický terapeutický opening.
 * Vychází POUZE z runtime polí, které vrátily 3 vrstvy — žádný AI, žádný placeholder.
 */
function buildCardOpening(args: {
  partName: string;
  readiness: ReadinessKey;
  phase: string;
  whyToday: string | null;
  contextHeadline: string | null;
}): { opening: string; reason: string } {
  const part = args.partName || "dnešní část";
  const readinessClause =
    args.readiness === "red"
      ? `${part} dnes drží jen úzké stabilizační okno; workspace má smysl otevřít, jen pokud je kontakt minimální a krátký.`
      : args.readiness === "amber"
        ? `Dnes dává smysl otevřít pro ${part} jen krátký, bezpečný workspace se zátěží drženou nízko.`
        : args.readiness === "green"
          ? `${part} je dnes v dosahu; workspace může běžet v klidném pracovním tempu, bez tlaku na hloubku.`
          : `Pro ${part} je workspace připravený k otevření v jemném diagnostickém režimu, dokud nebude readiness jednoznačně potvrzen.`;
  const opening = readinessClause;
  const reason = (args.whyToday && args.whyToday.trim())
    || (args.contextHeadline && args.contextHeadline.trim())
    || `V dnešním snapshotu je kontakt s ${part} možný, ale jen v jemném režimu fáze ${args.phase}.`;
  return { opening, reason };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const authResult = await requireAuth(req);
  if (authResult instanceof Response) return authResult;
  const userId = String((authResult as { user: any }).user?.id ?? "");
  if (!userId) return jsonRes({ status: "pipeline_broken", broken_step: "auth", reason: "missing user_id" }, 401);

  let body: any = {};
  try { body = await req.json(); } catch { /* ignore */ }
  const requestedPart: string = String(body?.part_name ?? "").trim();
  const today = pragueTodayISO();

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  const [ctxRes, wmRes, planRes] = await Promise.all([
    sb.from("did_daily_context")
      .select("id, context_date, context_json, updated_at")
      .eq("user_id", userId).eq("context_date", today).maybeSingle(),
    sb.from("karel_working_memory_snapshots")
      .select("id, snapshot_key, snapshot_json, updated_at")
      .eq("user_id", userId).eq("snapshot_key", today).maybeSingle(),
    requestedPart
      ? sb.from("did_daily_session_plans")
          .select("id, plan_date, selected_part, treatment_phase, readiness_today, urgency_breakdown, plan_markdown")
          .eq("user_id", userId).eq("plan_date", today).ilike("selected_part", requestedPart)
          .order("created_at", { ascending: false }).limit(1).maybeSingle()
      : sb.from("did_daily_session_plans")
          .select("id, plan_date, selected_part, treatment_phase, readiness_today, urgency_breakdown, plan_markdown")
          .eq("user_id", userId).eq("plan_date", today)
          .order("urgency_score", { ascending: false }).limit(1).maybeSingle(),
  ]);

  const ctx = ctxRes.data ?? null;
  const wm = wmRes.data ?? null;
  const plan = planRes.data ?? null;
  const contract = (plan?.urgency_breakdown && typeof plan.urgency_breakdown === "object") ? plan.urgency_breakdown as any : {};

  const missing: string[] = [];
  if (!ctx) missing.push("diddailycontext.contextjson");
  if (!wm) missing.push("karelworkingmemorysnapshots.snapshotjson");
  if (!plan) missing.push("did_daily_session_plans (dnešní session plan)");

  if (missing.length > 0) {
    const broken_step = !ctx ? "karel-daily-refresh" : !wm ? "karel-wm-bootstrap" : "generate-session-plan";
    return jsonRes({
      status: "pipeline_repair_required",
      requested_part: requestedPart || null,
      broken_step,
      reason: `Pro dnešek (${today}) chybí: ${missing.join(", ")}`,
      repair_action: { required: true, function: broken_step, for_date: today, priority: "immediate" },
      source: { daily_snapshot: !!ctx, working_memory: !!wm, session_plan: !!plan },
      workspace: null,
      follow_up_actions: [`Spustit ${broken_step} pro ${today} a znovu otevřít náhled Herny.`],
    }, 200);
  }

  const partName = pickPlannedPart(plan, contract, requestedPart);
  const phase = pickTreatmentPhase(plan, contract);
  const readiness = pickReadiness(plan, contract);
  const ctxJson: any = ctx?.context_json ?? {};
  const contextHeadline =
    typeof ctxJson?.headline === "string" ? ctxJson.headline
      : typeof ctxJson?.summary === "string" ? ctxJson.summary
        : null;
  const whyToday =
    String(contract?.playroom_plan?.why_this_part_today ?? contract?.why_this_part_today ?? "").trim() || null;

  const { opening, reason } = buildCardOpening({ partName, readiness, phase, whyToday, contextHeadline });

  return jsonRes({
    status: "preview_ready",
    requested_part: requestedPart || partName,
    plannedpart: partName,
    treatmentphase: phase,
    readinessstatus: readiness,
    card_opening_message: opening,
    reason,
    source: { daily_snapshot: true, working_memory: true, session_plan: true },
    target_surface: "did_part_session_workspace",
    runtime_status: "preview_ready",
    action_label: "Otevřít dnešní workspace",
    plan_id: plan?.id ?? null,
    generated_for_date: today,
  }, 200);
});
