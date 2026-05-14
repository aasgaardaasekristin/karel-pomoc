/**
 * karel-playroom-preview — FÁZE 1 (HERNA runtime preview, revize 2026-05-14)
 *
 * Read-only helper. Tři režimy:
 *   - preview_ready              — máme snapshot + WM + dnešní session plan
 *   - preview_degraded           — máme aspoň jeden bezpečný podklad (snapshot
 *                                  nebo dnešní session plan / part context),
 *                                  postavíme stabilizační therapist-facing opening
 *                                  + pipeline_notice o tom, co chybí
 *   - pipeline_repair_required   — žádný bezpečný podklad pro therapist-facing
 *                                  opening (poslední možnost, ne default)
 *
 * Karta NIKDY nesmí dostat hlavně diagnostickou hlášku, pokud existuje aspoň
 * minimální bezpečný podklad. ŽÁDNÝ child-facing text. ŽÁDNÝ AI fallback.
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
 * Deterministický terapeutický opening (žádné AI, žádné child-facing).
 * Vychází POUZE z runtime polí. V degraded režimu drží stabilizační rámec.
 */
function buildCardOpening(args: {
  partName: string;
  readiness: ReadinessKey;
  phase: string;
  whyToday: string | null;
  contextHeadline: string | null;
  degraded: boolean;
}): { opening: string; reason: string } {
  const part = args.partName || "dnešní část";
  const readinessClause = args.degraded
    ? `Dnes u ${part} dává smysl držet jen krátký, bezpečný kontakt v jemném stabilizačním režimu, bez tlaku na obsah. Herna má být spíš klidný check-in než hluboká práce.`
    : args.readiness === "red"
      ? `${part} dnes drží jen úzké stabilizační okno; workspace má smysl otevřít, jen pokud je kontakt minimální a krátký.`
      : args.readiness === "amber"
        ? `Dnes dává smysl otevřít pro ${part} jen krátký, bezpečný workspace se zátěží drženou nízko.`
        : args.readiness === "green"
          ? `${part} je dnes v dosahu; workspace může běžet v klidném pracovním tempu, bez tlaku na hloubku.`
          : `Pro ${part} je workspace připravený k otevření v jemném diagnostickém režimu, dokud nebude readiness jednoznačně potvrzen.`;
  const reason = (args.whyToday && args.whyToday.trim())
    || (args.contextHeadline && args.contextHeadline.trim())
    || (args.degraded
      ? `Pro dnešek nejsou všechny pipeline vrstvy hotové, ale podklad pro bezpečný stabilizační kontakt s ${part} existuje.`
      : `V dnešním snapshotu je kontakt s ${part} možný, ale jen v jemném režimu fáze ${args.phase}.`);
  return { opening: readinessClause, reason };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const authResult = await requireAuth(req);
  if (authResult instanceof Response) return authResult;
  const userId = String((authResult as { user: any }).user?.id ?? "");
  if (!userId) return jsonRes({ status: "pipeline_repair_required", broken_step: "auth", reason: "missing user_id" }, 401);

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

  const has = { snapshot: !!ctx, wm: !!wm, plan: !!plan };
  const missing: string[] = [];
  if (!ctx) missing.push("did_daily_context.context_json");
  if (!wm) missing.push("karel_working_memory_snapshots.snapshot_json");
  if (!plan) missing.push("did_daily_session_plans (dnešní session plan)");

  const broken_step = !ctx ? "karel-daily-refresh" : !wm ? "karel-wm-bootstrap" : !plan ? "generate-session-plan" : null;
  const pipeline_notice = missing.length > 0 ? {
    level: missing.length >= 2 ? "warning" : "info",
    broken_step,
    reason: `Chybí: ${missing.join(", ")}`,
    repair_action: broken_step ? { required: true, function: broken_step, for_date: today, priority: "immediate" } : null,
  } : null;

  // Pokud nemáme ANI snapshot ANI plan → nemáme z čeho bezpečně sestavit therapist-facing opening.
  if (!ctx && !plan) {
    return jsonRes({
      status: "pipeline_repair_required",
      requested_part: requestedPart || null,
      plannedpart: requestedPart || null,
      treatmentphase: "stabilization",
      readinessstatus: "unknown",
      card_opening_message: `Pro dnešek (${today}) nemám u ${requestedPart || "této části"} žádný bezpečný podklad pro Hernu — než ji otevřeme, je potřeba opravit pipeline.`,
      reason: `Chybí canonical snapshot i dnešní session plan.`,
      source: { daily_snapshot: false, working_memory: !!wm, session_plan: false },
      pipeline_notice,
      target_surface: "did_part_session_workspace",
      runtime_status: "pipeline_repair_required",
      action_label: "Otevřít dnešní workspace",
      plan_id: null,
      generated_for_date: today,
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

  const fullyReady = has.snapshot && has.wm && has.plan;
  const status = fullyReady ? "preview_ready" : "preview_degraded";

  const { opening, reason } = buildCardOpening({
    partName, readiness, phase, whyToday, contextHeadline,
    degraded: !fullyReady,
  });

  return jsonRes({
    status,
    requested_part: requestedPart || partName,
    plannedpart: partName,
    treatmentphase: phase,
    readinessstatus: readiness,
    card_opening_message: opening,
    reason,
    source: { daily_snapshot: has.snapshot, working_memory: has.wm, session_plan: has.plan },
    pipeline_notice,
    target_surface: "did_part_session_workspace",
    runtime_status: status,
    action_label: "Otevřít dnešní workspace",
    plan_id: plan?.id ?? null,
    generated_for_date: today,
  }, 200);
});
