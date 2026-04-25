import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.50.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const json = (payload: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const authHeader = req.headers.get("Authorization") || "";
    const sb = createClient(supabaseUrl, serviceKey);

    const body = await req.json().catch(() => ({}));
    const jobId = String(body?.job_id || "").trim();
    const dedupeKey = String(body?.dedupe_key || "").trim();
    if (!jobId && !dedupeKey) return json({ ok: false, error: "job_id nebo dedupe_key je povinné" }, 400);

    let userId: string | null = null;
    if (authHeader) {
      const userClient = createClient(supabaseUrl, serviceKey, { global: { headers: { Authorization: authHeader } } });
      const { data } = await userClient.auth.getUser();
      userId = data?.user?.id ?? null;
    }

    let query = sb
      .from("karel_action_jobs")
      .select("id, user_id, job_type, dedupe_key, status, target_type, target_id, result_summary, result_payload, error_message, created_at, started_at, completed_at")
      .limit(1);
    query = jobId ? query.eq("id", jobId) : query.eq("dedupe_key", dedupeKey);
    const { data: rows, error } = await query;
    if (error) throw error;
    const job = rows?.[0] ?? null;
    if (!job) return json({ ok: false, error: "Job nenalezen" }, 404);

    if (userId && job.user_id && job.user_id !== userId) return json({ ok: false, error: "Job nenalezen" }, 404);

    return json({
      ok: true,
      job_id: job.id,
      status: job.status,
      job_type: job.job_type,
      dedupe_key: job.dedupe_key,
      target_type: job.target_type,
      target_id: job.target_id,
      result_summary: job.result_summary,
      result_payload: job.result_payload ?? {},
      error_message: job.error_message,
      created_at: job.created_at,
      started_at: job.started_at,
      completed_at: job.completed_at,
    });
  } catch (e: any) {
    console.error("[karel-action-job-status] fatal:", e);
    return json({ ok: false, error: e?.message ?? String(e) }, 500);
  }
});