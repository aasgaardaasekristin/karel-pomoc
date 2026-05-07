/**
 * P31.2B — karel-ai-polish-canary
 *
 * Real AI polish canary runner. Calls the AI polish module against the latest
 * truth-gated, human-rendered briefing payload, validates every candidate
 * section, and stores the result in `p31_ai_polish_canary_runs`.
 *
 * Hard guarantees:
 *   - NEVER updates `did_daily_briefings`.
 *   - NEVER returns/exposes the canary path to UI.
 *   - Requires service-role bearer OR valid `X-Karel-Cron-Secret` header.
 *   - The scoped user MUST be the canonical DID user.
 *   - Only runs when the briefing has `karel_human_briefing.ok = true`,
 *     `briefing_truth_gate.ok = true`, and `>= 6` deterministic sections.
 *   - Uses the in-process `forceEnableForCanary` flag so production briefing
 *     generation stays disabled by default.
 */

// deno-lint-ignore-file no-explicit-any
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import {
  generateKarelAiPolishCandidate,
} from "../_shared/karelBriefingVoiceAiPolish.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-karel-cron-secret",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function deriveStatus(polish: any): string {
  if (!polish) return "validation_failed";
  if (Array.isArray(polish.errors)) {
    if (polish.errors.includes("ai_polish_disabled_by_default")) return "disabled";
    if (polish.errors.some((e: string) => /^ai_http_|^ai_call_failed|^ai_json_parse_failed|^ai_schema_invalid|^missing_lovable_api_key/.test(e))) {
      return "provider_error";
    }
    if (polish.errors.includes("deterministic_not_ok") || polish.errors.includes("no_sections")) {
      return "validation_failed";
    }
  }
  const acc = polish.accepted_candidate_count ?? 0;
  const rej = polish.rejected_candidate_count ?? 0;
  if (acc === 0 && rej === 0) return "validation_failed";
  if (acc === 0 && rej > 0) return "rejected_all";
  if (acc > 0 && rej > 0) return "partial_candidates";
  return "accepted_candidate";
}

if ((import.meta as any).main) {
  Deno.serve(async (req) => {
    if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const sb = createClient(supabaseUrl, serviceKey);

    // ---- Auth: service-role bearer OR cron secret OR canonical authenticated user.
    const authHeader = req.headers.get("Authorization") || "";
    const cronSecretHeader = req.headers.get("X-Karel-Cron-Secret") || "";
    const isServiceCall = !!serviceKey && authHeader === `Bearer ${serviceKey}`;
    let isCronSecretCall = false;
    if (cronSecretHeader) {
      try {
        const { data: ok } = await sb.rpc("verify_karel_cron_secret", { p_secret: cronSecretHeader });
        isCronSecretCall = ok === true;
      } catch (_e) { /* ignore */ }
    }

    let callingUserId: string | null = null;
    if (!isServiceCall && !isCronSecretCall && authHeader.startsWith("Bearer ")) {
      try {
        const userClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY") || "", {
          global: { headers: { Authorization: authHeader } },
        });
        const { data: u } = await userClient.auth.getUser();
        callingUserId = u?.user?.id ?? null;
      } catch (_e) { /* ignore */ }
    }

    // Canonical user (single source of truth).
    let canonicalUserId: string | null = null;
    try {
      const { data: cid } = await sb.rpc("get_canonical_did_user_id");
      if (typeof cid === "string") canonicalUserId = cid;
    } catch (_e) { /* ignore */ }

    if (!canonicalUserId) {
      return json({ ok: false, error: "canonical_user_unresolved" }, 500);
    }

    const internalAuthOk = isServiceCall || isCronSecretCall;
    const userAuthOk = callingUserId !== null && callingUserId === canonicalUserId;
    if (!internalAuthOk && !userAuthOk) {
      return json({ ok: false, error: "unauthorized" }, 401);
    }

    let body: any = {};
    try { body = await req.json(); } catch { /* GET / no body */ }

    const briefingIdInput: string | null = typeof body?.briefing_id === "string" ? body.briefing_id : null;
    const dateInput: string | null = typeof body?.date === "string" ? body.date : null;
    const source: string = typeof body?.source === "string" ? body.source : "p31_2b_canary";

    // ---- Load latest truth-gated briefing for canonical user.
    let briefingQ = sb
      .from("did_daily_briefings")
      .select("id, user_id, briefing_date, payload, generated_at")
      .eq("user_id", canonicalUserId)
      .order("generated_at", { ascending: false })
      .limit(1);
    if (briefingIdInput) {
      briefingQ = sb
        .from("did_daily_briefings")
        .select("id, user_id, briefing_date, payload, generated_at")
        .eq("id", briefingIdInput)
        .limit(1);
    } else if (dateInput) {
      briefingQ = sb
        .from("did_daily_briefings")
        .select("id, user_id, briefing_date, payload, generated_at")
        .eq("user_id", canonicalUserId)
        .eq("briefing_date", dateInput)
        .order("generated_at", { ascending: false })
        .limit(1);
    }
    const { data: rows, error: bErr } = await briefingQ;
    if (bErr) return json({ ok: false, error: "briefing_query_failed", message: bErr.message }, 500);
    const briefing: any = (rows && rows[0]) || null;
    if (!briefing) return json({ ok: false, error: "no_briefing_found" }, 404);

    const payload = briefing.payload || {};
    const human = payload?.karel_human_briefing || null;
    const truthGate = payload?.briefing_truth_gate || null;

    if (!truthGate || truthGate.ok !== true) {
      return json({ ok: false, error: "truth_gate_not_ok" }, 412);
    }
    if (!human || human.ok !== true) {
      return json({ ok: false, error: "human_briefing_not_ok" }, 412);
    }
    const detSections = Array.isArray(human.sections) ? human.sections : [];
    if (detSections.length < 6) {
      return json({ ok: false, error: "deterministic_sections_too_few", count: detSections.length }, 412);
    }

    // ---- Run AI polish with canary override (force-enable for this server-side path only).
    const canaryRunId = crypto.randomUUID();
    const polish = await generateKarelAiPolishCandidate({
      payload,
      deterministic: {
        ok: human.ok,
        renderer_version: human.renderer_version,
        source_cycle_id: human.source_cycle_id,
        briefing_truth_gate_ok: human.briefing_truth_gate_ok,
        sections: detSections,
        render_audit: human.render_audit,
        errors: human.errors,
      } as any,
      mode: "candidate_only",
      forceEnableForCanary: true,
      canaryRunId,
    });

    const status = deriveStatus(polish);

    // ---- Store canary audit row. NEVER touch did_daily_briefings.
    const insertRow = {
      user_id: canonicalUserId,
      briefing_id: briefing.id,
      briefing_date: briefing.briefing_date,
      source_cycle_id: human.source_cycle_id ?? null,
      renderer_version: human.renderer_version ?? null,
      model: polish.model ?? null,
      status,
      attempted: polish.attempted === true,
      accepted_candidate_count: polish.accepted_candidate_count ?? 0,
      rejected_candidate_count: polish.rejected_candidate_count ?? 0,
      unsupported_claims_count: polish.audit?.unsupported_claims_count ?? 0,
      robotic_phrase_count: polish.audit?.robotic_phrase_count ?? 0,
      meaning_drift_count: polish.audit?.meaning_drift_count ?? 0,
      forbidden_phrase_hits: polish.audit?.forbidden_phrase_hits ?? [],
      sections: polish.sections ?? [],
      errors: polish.errors ?? [],
      payload: {
        canary_run_id: canaryRunId,
        source,
        deterministic_section_count: detSections.length,
        audit: polish.audit ?? {},
      },
    };

    const { data: ins, error: insErr } = await sb
      .from("p31_ai_polish_canary_runs")
      .insert(insertRow)
      .select("id")
      .single();
    if (insErr) {
      return json({ ok: false, error: "canary_insert_failed", message: insErr.message }, 500);
    }

    return json({
      ok: true,
      canary_run_id: canaryRunId,
      canary_row_id: ins?.id ?? null,
      briefing_id: briefing.id,
      briefing_date: briefing.briefing_date,
      status,
      attempted: polish.attempted === true,
      accepted_candidate_count: polish.accepted_candidate_count ?? 0,
      rejected_candidate_count: polish.rejected_candidate_count ?? 0,
      sections_count: (polish.sections ?? []).length,
      errors: polish.errors ?? [],
      production_briefing_overwritten: false,
    });
  });
}
