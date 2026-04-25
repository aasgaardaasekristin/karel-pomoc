import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.50.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

type FinalizeSource = "manual_end" | "save_transcript" | "exit_session" | "auto_safety_net" | "completed" | "partial";

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const sb = createClient(supabaseUrl, serviceKey);

    const body = await req.json().catch(() => ({}));
    const planId = String(body?.planId || "").trim();
    const source = String(body?.source || "manual_end") as FinalizeSource;
    const reason = String(body?.reason || source);
    const force = body?.force === true;

    if (!planId) {
      return new Response(JSON.stringify({ ok: false, error: "planId je povinné" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: plan, error: planErr } = await sb
      .from("did_daily_session_plans")
      .select("id, user_id, plan_date, selected_part, lifecycle_status")
      .eq("id", planId)
      .maybeSingle();
    if (planErr) throw planErr;
    if (!plan) {
      return new Response(JSON.stringify({ ok: false, error: "Plán sezení nenalezen" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: existingReview } = await sb
      .from("did_session_reviews")
      .select("id, status, clinical_summary")
      .eq("plan_id", planId)
      .eq("is_current", true)
      .maybeSingle();

    if (existingReview && !force) {
      return new Response(JSON.stringify({ ok: true, reused: true, review: existingReview }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const now = new Date().toISOString();
    await sb.from("did_daily_session_plans").update({
      lifecycle_status: "awaiting_analysis",
      finalized_at: now,
      finalization_source: source,
      finalization_reason: reason,
      updated_at: now,
    }).eq("id", planId);

    const { data: liveProgress } = await sb
      .from("did_live_session_progress")
      .select("items, turns_by_block, completed_blocks, total_blocks")
      .eq("plan_id", planId)
      .maybeSingle();

    const items = Array.isArray(liveProgress?.items) ? liveProgress.items : [];
    const observationsByBlock = Object.fromEntries(
      items
        .map((it: any, idx: number) => [String(idx), String(it?.observation ?? "")])
        .filter((entry: string[]) => String(entry[1] ?? "").trim().length > 0),
    );

    const evalRes = await fetch(`${supabaseUrl}/functions/v1/karel-did-session-evaluate`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        planId,
        endedReason: source === "auto_safety_net" ? "auto_safety_net" : reason === "completed" ? "completed" : "partial",
        completedBlocks: liveProgress?.completed_blocks,
        totalBlocks: liveProgress?.total_blocks,
        turnsByBlock: liveProgress?.turns_by_block ?? {},
        observationsByBlock,
        force,
      }),
    });

    const evalPayload = await evalRes.json().catch(() => ({}));
    if (!evalRes.ok || evalPayload?.ok === false) {
      const message = evalPayload?.error || `Evaluator HTTP ${evalRes.status}`;
      await sb.from("did_daily_session_plans").update({
        lifecycle_status: "failed_analysis",
        analysis_error: message,
        updated_at: new Date().toISOString(),
      }).eq("id", planId);

      const failureReview = {
        user_id: plan.user_id,
        plan_id: planId,
        part_name: plan.selected_part,
        session_date: plan.plan_date,
        status: "failed_analysis",
        review_kind: source === "auto_safety_net" ? "calendar_day_safety_net" : "scheduled_session",
        evidence_items: [{ kind: "failure", available: true, error: message }],
        source_data_summary: "analysis failed",
        projection_status: "skipped",
        error_message: message,
        updated_at: new Date().toISOString(),
      };

      const { data: existingFailureReview } = await sb
        .from("did_session_reviews")
        .select("id")
        .eq("plan_id", planId)
        .eq("is_current", true)
        .maybeSingle();
      if (existingFailureReview?.id) {
        await sb.from("did_session_reviews").update(failureReview).eq("id", existingFailureReview.id);
      } else {
        await sb.from("did_session_reviews").insert(failureReview);
      }

      return new Response(JSON.stringify({ ok: false, error: message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ ok: true, ...evalPayload }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e: any) {
    console.error("[karel-did-session-finalize] fatal:", e);
    return new Response(JSON.stringify({ ok: false, error: e?.message ?? String(e) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
