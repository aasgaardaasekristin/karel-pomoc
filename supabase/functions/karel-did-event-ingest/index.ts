import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { requireAuth, corsHeaders } from "../_shared/auth.ts";
import { runGlobalDidEventIngestion, type RunGlobalDidEventIngestionOptions } from "../_shared/didEventIngestion.ts";
import type { PantryBSourceKind } from "../_shared/pantryB.ts";

const VALID_MODES = new Set(["last_24h", "since_cursor", "source_test"]);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const authHeader = req.headers.get("Authorization") || "";
    const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    const isServiceCall = serviceRole && authHeader === `Bearer ${serviceRole}`;

    let userId = String(body?.userId ?? "").trim();
    if (!isServiceCall) {
      const auth = await requireAuth(req);
      if (auth instanceof Response) return auth;
      const authenticatedUserId = String((auth as { user: any }).user?.id ?? "");
      if (userId && userId !== authenticatedUserId) {
        return new Response(JSON.stringify({ error: "user_scope_mismatch" }), { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      userId = authenticatedUserId;
    }

    if (!userId) {
      return new Response(JSON.stringify({ error: "Missing userId" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const mode = String(body?.mode ?? "last_24h");
    if (!VALID_MODES.has(mode)) {
      return new Response(JSON.stringify({ error: "Invalid mode" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const sourceFilter = Array.isArray(body?.source_filter)
      ? body.source_filter.map((s: unknown) => String(s)).filter(Boolean) as PantryBSourceKind[]
      : undefined;
    const options: RunGlobalDidEventIngestionOptions = {
      mode: mode as RunGlobalDidEventIngestionOptions["mode"],
      sinceISO: typeof body?.sinceISO === "string" ? body.sinceISO : undefined,
      source_filter: sourceFilter,
    };

    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const summary = await runGlobalDidEventIngestion(sb, userId, options);
    return new Response(JSON.stringify({ ok: true, ...summary }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String((e as Error)?.message ?? e) }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
