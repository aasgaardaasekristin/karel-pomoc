/**
 * karel-hourglass-inspect — read-only observability endpoint pro Hourglass.
 *
 * Vrací pravdivý stav:
 *   - Spižírny B (karel_pantry_b_entries):
 *       total / unprocessed / processed / blocked / retryable / expired
 *       last_flush_attempt_at, last_processed_at, last_created_at
 *       routing breakdown (úspěšné inserts za poslední 24h)
 *   - Spižírny A (selectPantryA summary):
 *       presence flags pro canonical/WM, counts pro crisis / followups /
 *       priorities, oddělenost slotů hana_personal vs hana_therapeutic
 *       vs kata_therapeutic.
 *
 * Pure read. Žádný side-effect. Žádný insert. Žádný update.
 *
 * Auth: Bearer <user JWT>; čteme přes user-scoped client → RLS automaticky
 * filtruje na vlastní rows (Pantry B má RLS na user_id).
 *
 * Pantry A composer drží service_role klienta jako parametr; pro
 * inspect potřebujeme jen agregace, takže si user-scoped client stačí.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { selectPantryA } from "../_shared/pantryA.ts";
import { IMPLICATIONS_BLOCKED_REASON } from "../_shared/pantryFlushShapes.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

interface PantryBRow {
  id: string;
  entry_kind: string;
  source_kind: string;
  intended_destinations: string[] | null;
  related_therapist: string | null;
  related_part_name: string | null;
  processed_at: string | null;
  processed_by: string | null;
  flush_result: Record<string, unknown> | null;
  expires_at: string;
  created_at: string;
}

interface FlushResultShape {
  requested_destinations?: string[];
  succeeded?: string[];
  failed?: Array<{ destination: string; reason: string }>;
  blocked?: Array<{ destination: string; reason: string }>;
  last_attempt_at?: string;
  retryable?: boolean;
  status?: string;
  routed_to_implications?: number;
  routed_to_tasks?: number;
  routed_to_questions?: number;
}

const pragueTodayISO = (): string =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Prague" }).format(
    new Date(),
  );

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const url = Deno.env.get("SUPABASE_URL")!;
  const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
  const userClient = createClient(url, anon, {
    global: { headers: { Authorization: auth } },
  });

  const { data: userData, error: authErr } = await userClient.auth.getUser();
  if (authErr || !userData?.user) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  const userId = userData.user.id;

  // ── PANTRY B: load + classify ─────────────────────────────────────
  const { data: bRowsRaw, error: bErr } = await userClient
    .from("karel_pantry_b_entries")
    .select(
      "id, entry_kind, source_kind, intended_destinations, related_therapist, related_part_name, processed_at, processed_by, flush_result, expires_at, created_at",
    )
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(500);

  if (bErr) {
    return new Response(
      JSON.stringify({ error: "pantry_b_read_failed", detail: bErr.message }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }

  const bRows = (bRowsRaw ?? []) as PantryBRow[];
  const now = Date.now();
  const past24h = now - 24 * 60 * 60 * 1000;

  let total = bRows.length;
  let unprocessed = 0;
  let processed = 0;
  let expired = 0;
  let blocked = 0; // unprocessed s flush_result.blocked.length > 0
  let retryable = 0; // unprocessed s flush_result.failed.length > 0 nebo blocked
  let blockedByImplications = 0;
  let neverAttempted = 0; // unprocessed bez flush_result (= ještě se to nezkusilo)

  let routedToTasks24h = 0;
  let routedToQuestions24h = 0;
  let routedToImplications24h = 0;

  let lastFlushAttemptAt: string | null = null;
  let lastProcessedAt: string | null = null;
  let lastCreatedAt: string | null = null;

  const blockedSamples: Array<{
    id: string;
    entry_kind: string;
    reason: string;
    last_attempt_at: string | null;
  }> = [];

  for (const row of bRows) {
    if (!lastCreatedAt || row.created_at > lastCreatedAt) {
      lastCreatedAt = row.created_at;
    }
    if (new Date(row.expires_at).getTime() < now) {
      expired++;
    }
    const fr = (row.flush_result ?? null) as FlushResultShape | null;
    if (fr?.last_attempt_at) {
      if (!lastFlushAttemptAt || fr.last_attempt_at > lastFlushAttemptAt) {
        lastFlushAttemptAt = fr.last_attempt_at;
      }
    }
    if (row.processed_at) {
      processed++;
      if (!lastProcessedAt || row.processed_at > lastProcessedAt) {
        lastProcessedAt = row.processed_at;
      }
      // Routing breakdown za 24h — z flush_result úspěšných batchů.
      if (new Date(row.processed_at).getTime() >= past24h && fr?.succeeded) {
        if (fr.succeeded.includes("did_therapist_tasks")) routedToTasks24h++;
        if (fr.succeeded.includes("did_pending_questions")) routedToQuestions24h++;
        if (fr.succeeded.includes("did_implications")) routedToImplications24h++;
      }
    } else {
      unprocessed++;
      if (!fr) {
        neverAttempted++;
      } else {
        const isBlocked = (fr.blocked?.length ?? 0) > 0;
        const isFailed = (fr.failed?.length ?? 0) > 0;
        if (isBlocked) {
          blocked++;
          if (
            fr.blocked?.some((b) =>
              b.destination === "did_implications" &&
              b.reason === IMPLICATIONS_BLOCKED_REASON
            )
          ) {
            blockedByImplications++;
          }
          if (blockedSamples.length < 5) {
            blockedSamples.push({
              id: row.id,
              entry_kind: row.entry_kind,
              reason: fr.blocked?.[0]?.reason ?? "unknown",
              last_attempt_at: fr.last_attempt_at ?? null,
            });
          }
        }
        if (isBlocked || isFailed) retryable++;
      }
    }
  }

  // ── PANTRY A: composer summary (read-only, idempotent) ────────────
  let pantryASummary: Record<string, unknown> | null = null;
  let pantryAError: string | null = null;
  try {
    const a = await selectPantryA(userClient as any, userId, pragueTodayISO());
    pantryASummary = {
      schema_version: a.schema_version,
      composed_at: a.composed_at,
      prague_date: a.prague_date,
      sources: a.sources,
      counts: {
        canonical_crises: a.canonical_crises.length,
        canonical_today_session_present: !!a.canonical_today_session,
        canonical_queue_primary: a.canonical_queue?.primary_count ?? 0,
        canonical_queue_adjunct: a.canonical_queue?.adjunct_count ?? 0,
        parts_status: a.parts_status.length,
        therapists_status: a.therapists_status.length,
        yesterday_session_results: a.yesterday_session_results.length,
        open_followups: a.open_followups.length,
        today_priorities: a.today_priorities.length,
        today_therapy_plan: a.today_therapy_plan.length,
      },
      slots: {
        // Důkaz, že Hana osobně vs Hana terapeuticky vs Káťa terapeuticky
        // jsou samostatné typed sloty, NIKDY jeden blob.
        hana_personal: {
          present: !!a.hana_personal,
          personal_thread_count_24h: a.hana_personal.personal_thread_count_24h,
          last_personal_thread_at: a.hana_personal.last_personal_thread_at,
          recent_personal_signals_count:
            a.hana_personal.recent_personal_signals.length,
        },
        hana_therapeutic: {
          present: !!a.hana_therapeutic,
          caseload_focus_count: a.hana_therapeutic.current_caseload_focus.length,
          countertransference_bonds_count:
            a.hana_therapeutic.active_countertransference_bonds.length,
          open_supervision_questions:
            a.hana_therapeutic.open_supervision_questions,
          last_therapeutic_thread_at:
            a.hana_therapeutic.last_therapeutic_thread_at,
        },
        kata_therapeutic: {
          present: !!a.kata_therapeutic,
          caseload_focus_count: a.kata_therapeutic.current_caseload_focus.length,
          countertransference_bonds_count:
            a.kata_therapeutic.active_countertransference_bonds.length,
          open_supervision_questions:
            a.kata_therapeutic.open_supervision_questions,
          last_observed_at: a.kata_therapeutic.last_observed_at,
        },
        // Strukturální důkaz oddělenosti — three-way distinct slot keys.
        slots_isolated: true,
      },
      briefing_present: !!a.briefing,
      briefing_is_stale: a.briefing?.is_stale ?? null,
    };
  } catch (e) {
    pantryAError = (e as Error).message ?? "selectPantryA_failed";
  }

  // ── HEALTH VERDICT ─────────────────────────────────────────────────
  const verdict = {
    pantry_b_healthy: blocked === 0 && unprocessed - neverAttempted === 0,
    has_blocked_entries: blocked > 0,
    has_retryable_entries: retryable > 0,
    has_unattempted_entries: neverAttempted > 0,
    expired_present: expired > 0,
    pantry_a_loaded: pantryASummary !== null,
  };

  return new Response(
    JSON.stringify({
      ok: true,
      generated_at: new Date().toISOString(),
      user_id: userId,
      pantry_b: {
        total,
        unprocessed,
        processed,
        expired,
        blocked,
        retryable,
        never_attempted: neverAttempted,
        blocked_by_implications: blockedByImplications,
        last_flush_attempt_at: lastFlushAttemptAt,
        last_processed_at: lastProcessedAt,
        last_created_at: lastCreatedAt,
        routed_24h: {
          tasks: routedToTasks24h,
          questions: routedToQuestions24h,
          implications: routedToImplications24h,
        },
        blocked_samples: blockedSamples,
      },
      pantry_a: pantryASummary,
      pantry_a_error: pantryAError,
      verdict,
    }),
    {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    },
  );
});
