/**
 * karel-drive-queue-watchdog
 *
 * Spouštěno pg_cronem 1×/2 min.
 * Detekuje stuck stavy a zapisuje alert rows do system_health_log.
 *
 * Pravidla:
 *   - kterýkoli `pending` row s priority IN (critical, urgent, high) starší než 2 min     → severity=critical
 *   - kterýkoli `pending` row starší než 15 min                                            → severity=warning
 *   - poslední drive_queue_heartbeat starší než 10 min                                     → severity=critical (processor stojí)
 *   - počet `failed`/`failed_permanent` rows přidaných za posledních 24h > 10              → severity=warning
 *
 * Alert je auto-resolved při následujícím čistém heartbeatu (mimo scope, sleduje se UI).
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const sb = createClient(supabaseUrl, serviceKey);

  const findings: Array<{ severity: string; message: string; details: any }> = [];
  const now = Date.now();

  // 1) Stuck high-priority writes (> 2 min)
  const twoMinAgo = new Date(now - 2 * 60 * 1000).toISOString();
  const { data: stuckHigh } = await sb
    .from("did_pending_drive_writes")
    .select("id, target_document, priority, created_at, retry_count")
    .eq("status", "pending")
    .in("priority", ["critical", "urgent", "high"])
    .lt("created_at", twoMinAgo);
  if (stuckHigh && stuckHigh.length > 0) {
    findings.push({
      severity: "critical",
      message: `${stuckHigh.length} high-priority drive write(s) stuck > 2 min`,
      details: { rows: stuckHigh.slice(0, 10) },
    });
  }

  // 2) Stuck normal/low writes (> 15 min)
  const fifteenMinAgo = new Date(now - 15 * 60 * 1000).toISOString();
  const { data: stuckBulk } = await sb
    .from("did_pending_drive_writes")
    .select("id, target_document, priority, created_at, retry_count")
    .eq("status", "pending")
    .lt("created_at", fifteenMinAgo);
  if (stuckBulk && stuckBulk.length > 0) {
    findings.push({
      severity: "warning",
      message: `${stuckBulk.length} drive write(s) stuck > 15 min`,
      details: { rows: stuckBulk.slice(0, 10) },
    });
  }

  // 3) Heartbeat freshness — last drive_queue_heartbeat must be < 10 min old
  const tenMinAgo = new Date(now - 10 * 60 * 1000).toISOString();
  const { data: lastHeartbeat } = await sb
    .from("system_health_log")
    .select("created_at, message, details")
    .eq("event_type", "drive_queue_heartbeat")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!lastHeartbeat) {
    findings.push({
      severity: "critical",
      message: "Drive queue processor has no heartbeat at all",
      details: {},
    });
  } else if (lastHeartbeat.created_at < tenMinAgo) {
    findings.push({
      severity: "critical",
      message: `Drive queue processor heartbeat is stale (last: ${lastHeartbeat.created_at})`,
      details: { last: lastHeartbeat },
    });
  }

  // 4) Failed write rate over last 24h
  const dayAgo = new Date(now - 24 * 60 * 60 * 1000).toISOString();
  const { count: failedCount } = await sb
    .from("did_pending_drive_writes")
    .select("id", { count: "exact", head: true })
    .in("status", ["failed", "failed_permanent"])
    .gte("processed_at", dayAgo);
  if ((failedCount || 0) > 10) {
    findings.push({
      severity: "warning",
      message: `${failedCount} drive writes failed in last 24h`,
      details: { failedCount },
    });
  }

  // ── Persist findings ──
  let alertsWritten = 0;
  for (const f of findings) {
    try {
      await sb.from("system_health_log").insert({
        event_type: "drive_queue_alert",
        severity: f.severity,
        message: f.message,
        details: f.details,
        resolved: false,
      });
      alertsWritten++;
    } catch (_) { /* ignore */ }
  }

  // Self-heartbeat
  await sb.from("system_health_log").insert({
    event_type: "drive_queue_watchdog_heartbeat",
    severity: findings.length > 0 ? "warning" : "info",
    message: `watchdog scan complete — ${findings.length} finding(s)`,
    details: { findings_summary: findings.map((f) => ({ s: f.severity, m: f.message })) },
    resolved: findings.length === 0,
  });

  return new Response(
    JSON.stringify({
      checked_at: new Date().toISOString(),
      findings_count: findings.length,
      alerts_written: alertsWritten,
      findings,
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});
