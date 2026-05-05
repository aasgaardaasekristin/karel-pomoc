/**
 * karel-task-drive-enqueue (P29A)
 *
 * Thin server proxy so the TaskBoard UI cannot bypass Drive governance.
 * Every enqueue funnels through safeEnqueueDriveWrite.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { safeEnqueueDriveWrite } from "../_shared/documentGovernance.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) {
      return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json().catch(() => ({}));
    const { target_document, content, write_type, priority } = body ?? {};
    if (!target_document || !content) {
      return new Response(JSON.stringify({ ok: false, error: "missing target_document/content" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const admin = createClient(SUPABASE_URL, SERVICE_KEY);
    const r = await safeEnqueueDriveWrite(
      admin as any,
      {
        user_id: user.id,
        target_document,
        content,
        write_type: write_type ?? "append",
        priority: priority ?? "normal",
        status: "pending",
      },
      { source: "karel-task-drive-enqueue" },
    );

    return new Response(JSON.stringify({ ok: r.inserted, blocked: r.blocked, reason: r.reason ?? null, target: r.target }), {
      status: r.inserted ? 200 : 422,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, error: e?.message ?? String(e) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
