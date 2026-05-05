import { createClient } from "https://esm.sh/@supabase/supabase-js@2.95.0";
import { corsHeaders, requireAuth } from "../_shared/auth.ts";
import { recordServerSubmission } from "../_shared/dynamicPipelineServer.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

type StartResult = {
  ok?: boolean;
  error_code?: string;
  message?: string;
  plan_id?: string;
  already_started?: boolean;
  started?: boolean;
  synced?: boolean;
  was_missing_sync?: boolean;
};

function json(payload: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error_code: "method_not_allowed", message: "Method not allowed" }, 405);

  const auth = await requireAuth(req);
  if (auth instanceof Response) return auth;

  try {
    const body = await req.json().catch(() => ({}));
    const deliberationId = String(body?.deliberation_id ?? "").trim();
    if (!deliberationId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(deliberationId)) {
      return json({ ok: false, error_code: "bad_input", message: "Chybí platné ID porady." }, 400);
    }

    const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
      auth: { persistSession: false },
    });

    // SECURITY: user_id je odvozené výhradně z ověřené auth session.
    // Klient neposílá a neurčuje p_user_id.
    const { data, error } = await admin.rpc("sync_and_start_approved_daily_plan", {
      p_deliberation_id: deliberationId,
      p_user_id: auth.user.id,
    });

    if (error) {
      console.error("[daily-plan-sync-start] rpc failed", error);
      return json({ ok: false, error_code: "sync_failed", message: error.message }, 500);
    }

    const result = (data ?? {}) as StartResult;
    if (result.ok === false) {
      return json(result as Record<string, unknown>, 409);
    }

    // P28_CDI_2b — server-side pipeline event for plan-edit/start
    try {
      await recordServerSubmission({
        sb: admin,
        userId: auth.user.id,
        surfaceType: "daily_plan_edit",
        surfaceId: result.plan_id ?? deliberationId,
        eventType: "plan_edited",
        sourceTable: "did_daily_session_plans",
        sourceRowId: result.plan_id ?? null,
        safeSummary: `plan_sync:${result.started ? "started" : result.already_started ? "already_started" : "synced"}`,
        rawAllowed: false,
        metadata: { deliberation_id: deliberationId, started: result.started, synced: result.synced },
        resumeStatePatch: {
          changed_fields: { synced: !!result.synced, started: !!result.started },
          previous_status: result.was_missing_sync ? "missing_sync" : "approved",
          next_status: result.started ? "in_progress" : (result.already_started ? "in_progress" : "ready_to_start"),
          next_resume_point: result.started ? "session_running" : "ready_to_start",
        },
      });
    } catch (err) {
      console.warn("[daily-plan-sync-start] dyn pipeline write failed:", err);
    }

    return json(result as Record<string, unknown>);
  } catch (error) {
    console.error("[daily-plan-sync-start] unexpected failure", error);
    return json({ ok: false, error_code: "sync_failed", message: error instanceof Error ? error.message : "Start selhal." }, 500);
  }
});
