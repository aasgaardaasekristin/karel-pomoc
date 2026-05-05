import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { requireAuth, corsHeaders } from "../_shared/auth.ts";
import { runGlobalDidEventIngestion, type RunGlobalDidEventIngestionOptions } from "../_shared/didEventIngestion.ts";
import type { PantryBSourceKind } from "../_shared/pantryB.ts";
import { resolveCanonicalDidUserId, CanonicalScopeResolveError } from "../_shared/canonicalUserResolver.ts";

const VALID_MODES = new Set(["last_24h", "since_cursor", "source_test", "fallback_sweeper"]);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const authHeader = req.headers.get("Authorization") || "";
    const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    const isServiceCall = !!serviceRole && authHeader === `Bearer ${serviceRole}`;
    const cronSecretHeader = req.headers.get("X-Karel-Cron-Secret") || "";

    const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    // Verify cron-secret via RPC (P14B) — header presence alone is not sufficient.
    let isCronSecretCall = false;
    if (cronSecretHeader) {
      try {
        const { data: ok } = await sb.rpc("verify_karel_cron_secret", { p_secret: cronSecretHeader });
        isCronSecretCall = ok === true;
      } catch (e) {
        console.warn("[event-ingest] cron secret rpc failed:", (e as Error)?.message);
      }
    }
    const isInternalCall = isServiceCall || isCronSecretCall;

    // P2 fail-closed canonical scope guard (P23 fix). For both auth and service/cron paths
    // we must resolve to canonical and reject any mismatch.
    let requestedUserId = String(body?.userId ?? "").trim() || null;
    if (!isInternalCall) {
      const auth = await requireAuth(req);
      if (auth instanceof Response) return auth;
      const authenticatedUserId = String((auth as { user: any }).user?.id ?? "");
      if (requestedUserId && requestedUserId !== authenticatedUserId) {
        return new Response(JSON.stringify({ error: "user_scope_mismatch" }), { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }
      requestedUserId = authenticatedUserId;
    }

    let canonicalUserId: string;
    try {
      canonicalUserId = await resolveCanonicalDidUserId(sb as any, requestedUserId ?? null);
    } catch (e) {
      if (e instanceof CanonicalScopeResolveError) {
        const status = e.code === "CANONICAL_USER_SCOPE_MISMATCH" ? 403 : 500;
        return new Response(JSON.stringify({ ok: false, error_code: e.code, message: e.message }), {
          status, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      throw e;
    }

    // Non-destructive health/dryRun short-circuit for P23 canary.
    if (body?.health === true || body?.dryRun === true) {
      const { error: dbErr } = await sb.from("did_event_ingestion_log").select("id").limit(1);
      return new Response(JSON.stringify({
        ok: true, health: "event-ingest", auth: "ok", db: dbErr ? "error" : "ok",
        canonical_user_id: canonicalUserId,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const mode = String(body?.mode ?? "last_24h");
    if (!VALID_MODES.has(mode)) {
      return new Response(JSON.stringify({ error: "Invalid mode" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const sourceFilter = Array.isArray(body?.source_filter)
      ? body.source_filter.map((s: unknown) => String(s)).filter(Boolean) as PantryBSourceKind[]
      : undefined;

    // P28_CDI_3 — fallback sweeper. Does NOT do a full global poll. It only
    // runs ingestion if there are stale active sessions or stale pipeline
    // events the active-session processor missed. Time-window bounded.
    if (mode === "fallback_sweeper") {
      const maxAgeHours = Math.max(1, Math.min(72, Number(body?.max_age_hours ?? 24)));
      const sinceISO = new Date(Date.now() - maxAgeHours * 3600_000).toISOString();
      const staleAfterMin = Math.max(15, Math.min(360, Number(body?.stale_after_minutes ?? 30)));
      const staleCutoffISO = new Date(Date.now() - staleAfterMin * 60_000).toISOString();

      // Stale active sessions: last_activity_at advanced past last_processed_at
      const { data: missedSessions } = await sb
        .from("active_app_activity_sessions")
        .select("id, surface_type, surface_id, last_activity_at, last_processed_at, status")
        .eq("user_id", canonicalUserId)
        .gte("last_activity_at", sinceISO)
        .or(`last_processed_at.is.null,last_processed_at.lt.${staleCutoffISO}`)
        .in("status", ["active", "idle_closed"])
        .limit(50);

      // Stale unconsumed pipeline events
      const { count: staleEventCount } = await sb
        .from("dynamic_pipeline_events")
        .select("id", { count: "exact", head: true })
        .eq("user_id", canonicalUserId)
        .eq("pipeline_state", "new_event")
        .lt("created_at", staleCutoffISO)
        .gte("created_at", sinceISO);

      const missedCount = missedSessions?.length ?? 0;
      const staleCount = staleEventCount ?? 0;

      if (missedCount === 0 && staleCount === 0) {
        return new Response(JSON.stringify({
          ok: true, mode: "fallback_sweeper", canonical_user_id: canonicalUserId,
          missed_sessions: 0, stale_events: 0,
          ran_global_ingest: false, reason: "no_missed_work",
          since_iso: sinceISO,
        }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      // Run bounded ingestion for the missed window only.
      const fallbackFilter = sourceFilter ?? ["hana_personal_ingestion", "did_thread_ingestion"] as PantryBSourceKind[];
      const summary = await runGlobalDidEventIngestion(sb, canonicalUserId, {
        mode: "since_cursor",
        sinceISO,
        source_filter: fallbackFilter,
      });
      return new Response(JSON.stringify({
        ok: true, mode: "fallback_sweeper", canonical_user_id: canonicalUserId,
        missed_sessions: missedCount, stale_events: staleCount,
        ran_global_ingest: true, since_iso: sinceISO, source_filter: fallbackFilter,
        ...summary,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const options: RunGlobalDidEventIngestionOptions = {
      mode: mode as RunGlobalDidEventIngestionOptions["mode"],
      sinceISO: typeof body?.sinceISO === "string" ? body.sinceISO : undefined,
      source_filter: sourceFilter,
    };

    const summary = await runGlobalDidEventIngestion(sb, canonicalUserId, options);
    return new Response(JSON.stringify({ ok: true, canonical_user_id: canonicalUserId, ...summary }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String((e as Error)?.message ?? e) }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
