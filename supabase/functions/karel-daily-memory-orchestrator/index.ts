/**
 * karel-daily-memory-orchestrator
 *
 * Denní orchestrátor paměťové vrstvy Karla.
 * Sekvence: sorter → processor → souhrnný log.
 *
 * Volá se jednou denně (cron) nebo manuálně.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

async function callEdgeFunction(
  name: string,
  body: Record<string, unknown> = {},
): Promise<{ ok: boolean; status: number; data: any }> {
  const url = `${SUPABASE_URL}/functions/v1/${name}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({ raw: await res.text() }));
  return { ok: res.ok, status: res.status, data };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const startMs = Date.now();
  const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  const result: {
    sorter: { ok: boolean; threads: number; writes: number; error?: string };
    processor: { ok: boolean; completed: number; failed: number; skipped: number; error?: string } | null;
    elapsed_ms: number;
  } = {
    sorter: { ok: false, threads: 0, writes: 0 },
    processor: null,
    elapsed_ms: 0,
  };

  try {
    // ── KROK 1: Sorter ──────────────────────────────────────────────
    console.log("[memory-orchestrator] Step 1: calling karel-daily-thread-sorter");
    const sorterRes = await callEdgeFunction("karel-daily-thread-sorter");

    if (!sorterRes.ok) {
      result.sorter = {
        ok: false,
        threads: 0,
        writes: 0,
        error: `HTTP ${sorterRes.status}: ${JSON.stringify(sorterRes.data).slice(0, 300)}`,
      };
      console.error("[memory-orchestrator] Sorter failed:", result.sorter.error);

      // Log failure and return early — processor is NOT called
      await logToHealth(sb, result, startMs);
      return respond(result, startMs, 502);
    }

    const sd = sorterRes.data;
    result.sorter = {
      ok: true,
      threads: sd.threads ?? 0,
      writes: sd.writes ?? 0,
    };
    console.log(`[memory-orchestrator] Sorter done: ${result.sorter.threads} threads, ${result.sorter.writes} writes`);

    // ── KROK 2: Processor ────────────────────────────────────────────
    console.log("[memory-orchestrator] Step 2: calling karel-drive-queue-processor");
    const procRes = await callEdgeFunction("karel-drive-queue-processor");

    if (!procRes.ok) {
      result.processor = {
        ok: false,
        completed: 0,
        failed: 0,
        skipped: 0,
        error: `HTTP ${procRes.status}: ${JSON.stringify(procRes.data).slice(0, 300)}`,
      };
      console.error("[memory-orchestrator] Processor failed:", result.processor.error);
    } else {
      const pd = procRes.data;
      result.processor = {
        ok: true,
        completed: pd.completed ?? pd.results?.filter?.((r: any) => r.status === "completed")?.length ?? 0,
        failed: pd.failed ?? pd.results?.filter?.((r: any) => r.status === "error")?.length ?? 0,
        skipped: pd.skipped ?? pd.results?.filter?.((r: any) => r.status === "skipped")?.length ?? 0,
      };
      console.log(`[memory-orchestrator] Processor done: ${result.processor.completed} completed, ${result.processor.failed} failed, ${result.processor.skipped} skipped`);
    }

    // ── KROK 3: Log ──────────────────────────────────────────────────
    await logToHealth(sb, result, startMs);
    return respond(result, startMs);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[memory-orchestrator] Fatal:", msg);
    result.sorter.error = result.sorter.error || msg;
    await logToHealth(sb, result, startMs);
    return new Response(
      JSON.stringify({ ok: false, error: msg, result }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});

// ─── Helpers ─────────────────────────────────────────────────────────

function respond(
  result: any,
  startMs: number,
  status = 200,
): Response {
  result.elapsed_ms = Date.now() - startMs;
  return new Response(
    JSON.stringify({ ok: status === 200, ...result }),
    { status, headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
}

async function logToHealth(
  sb: ReturnType<typeof createClient>,
  result: any,
  startMs: number,
): Promise<void> {
  try {
    await sb.from("system_health_log").insert({
      event_type: "daily_memory_orchestrator",
      severity: result.sorter.ok ? "info" : "warning",
      source: "karel-daily-memory-orchestrator",
      details: {
        sorter_threads: result.sorter.threads,
        sorter_writes: result.sorter.writes,
        sorter_ok: result.sorter.ok,
        sorter_error: result.sorter.error || null,
        processor_completed: result.processor?.completed ?? null,
        processor_failed: result.processor?.failed ?? null,
        processor_skipped: result.processor?.skipped ?? null,
        processor_ok: result.processor?.ok ?? null,
        processor_error: result.processor?.error || null,
        elapsed_ms: Date.now() - startMs,
      },
    });
  } catch (e) {
    console.warn("[memory-orchestrator] Health log insert failed:", e);
  }
}
