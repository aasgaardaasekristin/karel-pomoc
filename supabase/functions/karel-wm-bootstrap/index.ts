/**
 * karel-wm-bootstrap — Working Memory Slice 1
 *
 * Hydratuje denní snapshot Karlovy pracovní paměti z KANONICKÝCH zdrojů.
 * Working Memory NENÍ source of truth — je odvozená operační vrstva.
 *
 * Source of truth zůstává:
 *   - did_observations / did_implications / did_profile_claims (evidence)
 *   - did_pending_drive_writes (queue / sync state)
 *   - did_daily_context (canonical context already emitted by daily-cycle)
 *   - crisis_events (canonical crisis state via canonicalCrisis resolver)
 *
 * Tento bootstrap:
 *   - upsertne 1 row do karel_working_memory_snapshots per (user_id, snapshot_key)
 *   - snapshot_key = YYYY-MM-DD (denní)
 *   - snapshot_json = derived working state
 *   - events_json   = lehký seznam recent changes (24h window)
 *   - sync_state_json = drive queue counts
 *   - source_meta_json = audit (zdroje, skipped, degraded, stale, duration)
 *
 * Vstupy:
 *   - Authorization: Bearer <user JWT>     → user-scoped bootstrap
 *   - X-Service-Role: 1 + service-role key → cron / system-scoped bootstrap (vyžaduje user_id v body)
 *   - body: { snapshot_key?: string, user_id?: string }
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-service-role",
};

interface BootstrapBody {
  snapshot_key?: string;
  user_id?: string;
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function safeArray<T = any>(v: any): T[] {
  return Array.isArray(v) ? v : [];
}

async function resolveActor(req: Request): Promise<
  | { mode: "user"; userId: string; client: any }
  | { mode: "service"; userId: string; client: any }
  | { error: Response }
> {
  const url = Deno.env.get("SUPABASE_URL")!;
  const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  const isService = req.headers.get("x-service-role") === "1";
  const auth = req.headers.get("Authorization") ?? "";

  // Service-role path: requires explicit user_id in body
  if (isService) {
    let body: BootstrapBody = {};
    try {
      body = await req.clone().json();
    } catch {}
    if (!body.user_id) {
      return {
        error: new Response(
          JSON.stringify({ error: "service-role bootstrap requires user_id in body" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        ),
      };
    }
    return {
      mode: "service",
      userId: body.user_id,
      client: createClient(url, service, { auth: { persistSession: false } }),
    };
  }

  // User-JWT path
  if (!auth.startsWith("Bearer ")) {
    return {
      error: new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }),
    };
  }
  const userClient = createClient(url, anon, {
    global: { headers: { Authorization: auth } },
  });
  const { data, error } = await userClient.auth.getUser();
  if (error || !data?.user) {
    return {
      error: new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }),
    };
  }
  // Use service-role client for hydration reads (consistent across canonical sources),
  // but writes are still scoped to the authenticated user_id.
  return {
    mode: "user",
    userId: data.user.id,
    client: createClient(url, service, { auth: { persistSession: false } }),
  };
}

interface SourceAudit {
  source: string;
  ok: boolean;
  count?: number;
  skipped?: boolean;
  degraded?: boolean;
  stale?: boolean;
  error?: string;
  duration_ms: number;
}

async function timed<T>(
  source: string,
  fn: () => Promise<{ data: T; meta?: Partial<SourceAudit> }>,
): Promise<{ data: T | null; audit: SourceAudit }> {
  const t0 = Date.now();
  try {
    const { data, meta } = await fn();
    return {
      data,
      audit: { source, ok: true, duration_ms: Date.now() - t0, ...(meta ?? {}) },
    };
  } catch (e) {
    return {
      data: null,
      audit: {
        source,
        ok: false,
        duration_ms: Date.now() - t0,
        error: e instanceof Error ? e.message : String(e),
      },
    };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const t0 = Date.now();
  const actor = await resolveActor(req);
  if ("error" in actor) return actor.error;

  let body: BootstrapBody = {};
  try {
    body = await req.json();
  } catch {}
  const snapshotKey = body.snapshot_key ?? todayKey();
  const userId = actor.userId;
  const db = actor.client;

  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const audits: SourceAudit[] = [];

  // ── 1. did_daily_context (canonical context emitted by daily-cycle) ──
  const ctxRes = await timed("did_daily_context", async () => {
    const { data, error } = await db
      .from("did_daily_context")
      .select("context_date, context_json, updated_at")
      .eq("user_id", userId)
      .order("context_date", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    const stale =
      !data?.updated_at ||
      Date.now() - new Date(data.updated_at).getTime() > 36 * 60 * 60 * 1000;
    return { data, meta: { stale, count: data ? 1 : 0 } };
  });
  audits.push(ctxRes.audit);

  // ── 2. Evidence: did_observations (last 24h count + last 20 sample) ──
  const obsRes = await timed("did_observations", async () => {
    const { data, error, count } = await db
      .from("did_observations")
      .select(
        "id, subject_type, subject_id, fact, created_at, source_type, evidence_level, evidence_kind",
        { count: "exact" },
      )
      .gte("created_at", since24h)
      .order("created_at", { ascending: false })
      .limit(20);
    if (error) throw error;
    return { data: { recent: data ?? [], count_24h: count ?? 0 }, meta: { count: count ?? 0 } };
  });
  audits.push(obsRes.audit);

  // ── 3. Evidence: did_implications (last 24h count) ──
  const implRes = await timed("did_implications", async () => {
    const { data, error, count } = await db
      .from("did_implications")
      .select(
        "id, implication_text, created_at, destinations, status, impact_type, owner",
        { count: "exact" },
      )
      .gte("created_at", since24h)
      .order("created_at", { ascending: false })
      .limit(20);
    if (error) throw error;
    return { data: { recent: data ?? [], count_24h: count ?? 0 }, meta: { count: count ?? 0 } };
  });
  audits.push(implRes.audit);

  // ── 4. Evidence: did_profile_claims (last 24h count) ──
  const claimRes = await timed("did_profile_claims", async () => {
    const { data, error, count } = await db
      .from("did_profile_claims")
      .select(
        "id, part_name, claim_text, claim_type, card_section, created_at, status",
        { count: "exact" },
      )
      .gte("created_at", since24h)
      .order("created_at", { ascending: false })
      .limit(20);
    if (error) throw error;
    return { data: { recent: data ?? [], count_24h: count ?? 0 }, meta: { count: count ?? 0 } };
  });
  audits.push(claimRes.audit);

  // ── 5. Drive queue: did_pending_drive_writes (status breakdown 24h) ──
  const queueRes = await timed("did_pending_drive_writes", async () => {
    const { data, error } = await db
      .from("did_pending_drive_writes")
      .select(
        "id, status, target_document, write_type, priority, created_at, processed_at, last_attempt_at, last_error_message, retry_count",
      )
      .gte("created_at", since24h)
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) throw error;
    const rows = data ?? [];
    const breakdown = {
      pending: rows.filter((r) => r.status === "pending").length,
      processing: rows.filter((r) => r.status === "processing").length,
      completed: rows.filter((r) => r.status === "completed").length,
      failed: rows.filter((r) => r.status === "failed" || r.status === "retry").length,
      total: rows.length,
    };
    return {
      data: { breakdown, recent: rows.slice(0, 20) },
      meta: { count: rows.length },
    };
  });
  audits.push(queueRes.audit);

  // ── 6. Crisis state (canonical view via crisis_events open phases) ──
  const crisisRes = await timed("crisis_events", async () => {
    const { data, error } = await db
      .from("crisis_events")
      .select("id, part_name, severity, phase, opened_at, days_active")
      .not("phase", "in", '("closed","CLOSED")')
      .order("opened_at", { ascending: false })
      .limit(20);
    if (error) throw error;
    return { data: data ?? [], meta: { count: (data ?? []).length } };
  });
  audits.push(crisisRes.audit);

  // ── Compose snapshot ──
  const snapshotJson = {
    snapshot_key: snapshotKey,
    daily_context: ctxRes.data
      ? {
          context_date: (ctxRes.data as any).context_date,
          updated_at: (ctxRes.data as any).updated_at,
          canonical_crisis_count:
            (ctxRes.data as any).context_json?.canonical_crisis_count ?? null,
          canonical_today_session:
            (ctxRes.data as any).context_json?.canonical_today_session ?? null,
        }
      : null,
    evidence: {
      observations_24h: (obsRes.data as any)?.count_24h ?? 0,
      implications_24h: (implRes.data as any)?.count_24h ?? 0,
      profile_claims_24h: (claimRes.data as any)?.count_24h ?? 0,
    },
    crises_open: crisisRes.data ?? [],
  };

  // events_json — lightweight unified stream of recent changes
  const events: any[] = [];
  for (const o of safeArray((obsRes.data as any)?.recent)) {
    events.push({
      kind: "observation",
      id: o.id,
      at: o.created_at,
      subject_type: o.subject_type,
      subject_id: o.subject_id,
      summary: o.fact,
      source_type: o.source_type,
      evidence_level: o.evidence_level,
    });
  }
  for (const i of safeArray((implRes.data as any)?.recent)) {
    events.push({
      kind: "implication",
      id: i.id,
      at: i.created_at,
      destinations: i.destinations,
      status: i.status,
      impact_type: i.impact_type,
      summary: i.implication_text,
    });
  }
  for (const c of safeArray((claimRes.data as any)?.recent)) {
    events.push({
      kind: "profile_claim",
      id: c.id,
      at: c.created_at,
      part: c.part_name,
      card_section: c.card_section,
      summary: c.claim_text,
    });
  }
  events.sort((a, b) => (a.at < b.at ? 1 : -1));
  const eventsJson = events.slice(0, 50);

  const syncStateJson = {
    drive_queue: (queueRes.data as any)?.breakdown ?? {
      pending: 0,
      processing: 0,
      completed: 0,
      failed: 0,
      total: 0,
    },
    drive_queue_recent: (queueRes.data as any)?.recent ?? [],
    window_hours: 24,
  };

  const sourceMetaJson = {
    bootstrap_mode: actor.mode,
    snapshot_key: snapshotKey,
    generated_at: new Date().toISOString(),
    duration_ms: Date.now() - t0,
    sources: audits,
    degraded_sources: audits.filter((a) => !a.ok).map((a) => a.source),
    stale_sources: audits.filter((a) => a.stale).map((a) => a.source),
    derived_layer_notice:
      "Working Memory is a derived operational layer. Source of truth remains in evidence tables, did_daily_context, did_pending_drive_writes, and crisis_events.",
  };

  // ── Upsert snapshot ──
  const { data: upserted, error: upErr } = await db
    .from("karel_working_memory_snapshots")
    .upsert(
      {
        user_id: userId,
        snapshot_key: snapshotKey,
        snapshot_json: snapshotJson,
        events_json: eventsJson,
        sync_state_json: syncStateJson,
        source_meta_json: sourceMetaJson,
        generated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,snapshot_key" },
    )
    .select("id, snapshot_key, generated_at, updated_at")
    .single();

  if (upErr) {
    return new Response(
      JSON.stringify({ error: "upsert_failed", detail: upErr.message, audits }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  return new Response(
    JSON.stringify({
      ok: true,
      mode: actor.mode,
      snapshot: upserted,
      summary: {
        observations_24h: snapshotJson.evidence.observations_24h,
        implications_24h: snapshotJson.evidence.implications_24h,
        profile_claims_24h: snapshotJson.evidence.profile_claims_24h,
        crises_open: snapshotJson.crises_open.length,
        drive_queue: syncStateJson.drive_queue,
        events_count: eventsJson.length,
        degraded_sources: sourceMetaJson.degraded_sources,
        stale_sources: sourceMetaJson.stale_sources,
        duration_ms: sourceMetaJson.duration_ms,
      },
    }),
    { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});
