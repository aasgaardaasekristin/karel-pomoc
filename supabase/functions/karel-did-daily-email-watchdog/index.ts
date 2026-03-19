import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/auth.ts";

/**
 * karel-did-daily-email-watchdog
 * 
 * Self-healing watchdog for daily DID email reports.
 * Triggered by pg_cron at 14:30, 15:00, 15:30 CET.
 * 
 * Logic:
 * 1. Check did_daily_report_dispatches for today
 * 2. If both hanka+kata have status "sent" → do nothing
 * 3. If any failed/missing → classify error → choose retry strategy → execute
 * 
 * Retry strategies:
 * - retry_full: call karel-did-daily-cycle again
 * - retry_standalone: call karel-did-daily-email (DB-only, no Drive)
 * - retry_emergency: send raw plain-text email with minimal data
 */

const RECIPIENTS = [
  { key: "hanka", email: "mujosobniasistentnamiru@gmail.com", label: "Hanka" },
  { key: "kata", email: "", label: "Káťa" }, // email from env
];

const MAX_RETRIES = 3;

function getPragueDate(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Prague" }).format(new Date());
}

function getPragueHour(): number {
  const now = new Date();
  const pragueTime = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Prague", hour: "numeric", hour12: false }).format(now);
  return parseInt(pragueTime, 10);
}

type RetryStrategy = "retry_full" | "retry_standalone" | "retry_emergency";

function classifyError(errorMessage: string | null): { strategy: RetryStrategy; reason: string } {
  if (!errorMessage) return { strategy: "retry_full", reason: "no_error_recorded" };
  
  const err = errorMessage.toLowerCase();
  
  if (err.includes("token error") || err.includes("invalid_grant") || err.includes("oauth")) {
    return { strategy: "retry_full", reason: "oauth_token_error" };
  }
  if (err.includes("rate_limit") || err.includes("rate limit") || err.includes("429")) {
    return { strategy: "retry_standalone", reason: "rate_limit" };
  }
  if (err.includes("timeout") || err.includes("timed out") || err.includes("deadline")) {
    return { strategy: "retry_standalone", reason: "ai_timeout" };
  }
  if (err.includes("boot_error") || err.includes("503") || err.includes("runtime_error")) {
    return { strategy: "retry_standalone", reason: "boot_error" };
  }
  if (err.includes("resend") || err.includes("email")) {
    return { strategy: "retry_standalone", reason: "email_api_error" };
  }
  
  return { strategy: "retry_standalone", reason: "unknown_error" };
}

function escalateStrategy(current: RetryStrategy, retryCount: number): RetryStrategy {
  // After 2+ retries, escalate to emergency
  if (retryCount >= 2) return "retry_emergency";
  // After 1 retry with full, try standalone
  if (current === "retry_full" && retryCount >= 1) return "retry_standalone";
  return current;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const sb = createClient(supabaseUrl, serviceRoleKey);

  const today = getPragueDate();
  const pragueHour = getPragueHour();
  const logs: string[] = [];
  
  logs.push(`[watchdog] Started at Prague hour ${pragueHour}, date ${today}`);

  try {
    // 1. Check today's dispatches
    const { data: dispatches, error: fetchErr } = await sb
      .from("did_daily_report_dispatches")
      .select("*")
      .eq("report_date", today)
      .order("created_at", { ascending: false });

    if (fetchErr) throw new Error(`DB fetch error: ${fetchErr.message}`);

    // Group by recipient, get latest per recipient
    const latestByRecipient: Record<string, any> = {};
    for (const d of (dispatches || [])) {
      if (!latestByRecipient[d.recipient]) {
        latestByRecipient[d.recipient] = d;
      }
    }

    const hankaDispatch = latestByRecipient["hanka"];
    const kataDispatch = latestByRecipient["kata"];

    // 2. Check if both sent successfully
    const hankaSent = hankaDispatch?.status === "sent";
    const kataSent = kataDispatch?.status === "sent";

    if (hankaSent && kataSent) {
      logs.push("[watchdog] Both recipients have status 'sent'. Nothing to do.");
      return new Response(JSON.stringify({ action: "none", reason: "all_sent", logs }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 3. Determine what needs retry
    const needsRetry: Array<{ recipient: string; dispatch: any; error: string | null; retryCount: number }> = [];

    if (!hankaSent) {
      needsRetry.push({
        recipient: "hanka",
        dispatch: hankaDispatch,
        error: hankaDispatch?.error_message || null,
        retryCount: hankaDispatch?.retry_count || 0,
      });
    }
    if (!kataSent) {
      needsRetry.push({
        recipient: "kata",
        dispatch: kataDispatch,
        error: kataDispatch?.error_message || null,
        retryCount: kataDispatch?.retry_count || 0,
      });
    }

    // Check max retries
    const retriable = needsRetry.filter(r => r.retryCount < MAX_RETRIES);
    if (retriable.length === 0) {
      logs.push("[watchdog] All failed recipients have hit max retries. Giving up.");
      return new Response(JSON.stringify({ action: "max_retries_reached", logs }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 4. Choose strategy based on error classification
    const strategies = retriable.map(r => {
      const classified = classifyError(r.error);
      const finalStrategy = escalateStrategy(classified.strategy, r.retryCount);
      return { ...r, strategy: finalStrategy, reason: classified.reason };
    });

    logs.push(`[watchdog] Retry needed for: ${strategies.map(s => `${s.recipient}(${s.strategy}, attempt ${s.retryCount + 1}, reason: ${s.reason})`).join(", ")}`);

    // 5. Execute retry strategies
    const results: Array<{ recipient: string; strategy: string; success: boolean; detail: string }> = [];

    // Determine highest-priority strategy (if any needs full, do full for all)
    const needsFull = strategies.some(s => s.strategy === "retry_full");
    const needsStandalone = strategies.some(s => s.strategy === "retry_standalone");
    const needsEmergency = strategies.some(s => s.strategy === "retry_emergency");

    // Strategy: retry_full — call daily-cycle again
    if (needsFull && !needsEmergency) {
      logs.push("[watchdog] Executing retry_full: calling karel-did-daily-cycle");
      try {
        const res = await fetch(`${supabaseUrl}/functions/v1/karel-did-daily-cycle`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${serviceRoleKey}`,
            "User-Agent": "pg_net/watchdog",
          },
          body: JSON.stringify({ source: "watchdog", retryAttempt: true }),
        });
        const data = await res.json();
        const success = res.ok && data.success !== false;
        
        for (const s of strategies.filter(s => s.strategy === "retry_full")) {
          results.push({ recipient: s.recipient, strategy: "retry_full", success, detail: success ? "daily-cycle retry succeeded" : `daily-cycle retry failed: ${JSON.stringify(data).slice(0, 200)}` });
        }
      } catch (err) {
        for (const s of strategies.filter(s => s.strategy === "retry_full")) {
          results.push({ recipient: s.recipient, strategy: "retry_full", success: false, detail: `fetch error: ${err instanceof Error ? err.message : "unknown"}` });
        }
      }
    }

    // Strategy: retry_standalone — call daily-email (DB-only)
    if (needsStandalone || (needsFull && results.some(r => !r.success))) {
      const standaloneRecipients = strategies.filter(s => 
        s.strategy === "retry_standalone" || 
        (s.strategy === "retry_full" && results.find(r => r.recipient === s.recipient && !r.success))
      );
      
      if (standaloneRecipients.length > 0) {
        logs.push("[watchdog] Executing retry_standalone: calling karel-did-daily-email");
        try {
          const res = await fetch(`${supabaseUrl}/functions/v1/karel-did-daily-email`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${serviceRoleKey}`,
              "User-Agent": "pg_net/watchdog",
            },
            body: JSON.stringify({ source: "watchdog", retryAttempt: true }),
          });
          const data = await res.json();
          const success = res.ok && !data.error;

          for (const s of standaloneRecipients) {
            const existing = results.find(r => r.recipient === s.recipient);
            if (existing) {
              existing.strategy = "retry_standalone";
              existing.success = success;
              existing.detail = success ? "standalone email retry succeeded" : `standalone retry failed: ${JSON.stringify(data).slice(0, 200)}`;
            } else {
              results.push({ recipient: s.recipient, strategy: "retry_standalone", success, detail: success ? "standalone email retry succeeded" : `standalone retry failed: ${JSON.stringify(data).slice(0, 200)}` });
            }
          }
        } catch (err) {
          for (const s of standaloneRecipients) {
            const existing = results.find(r => r.recipient === s.recipient);
            if (existing) {
              existing.success = false;
              existing.detail = `standalone fetch error: ${err instanceof Error ? err.message : "unknown"}`;
            } else {
              results.push({ recipient: s.recipient, strategy: "retry_standalone", success: false, detail: `fetch error: ${err instanceof Error ? err.message : "unknown"}` });
            }
          }
        }
      }
    }

    // Strategy: retry_emergency — send raw plain-text email directly via Resend
    const emergencyRecipients = strategies.filter(s => 
      s.strategy === "retry_emergency" || 
      results.find(r => r.recipient === s.recipient && !r.success)
    );

    if (emergencyRecipients.length > 0) {
      logs.push("[watchdog] Executing retry_emergency: sending raw plain-text email via Resend");
      const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
      const KATA_EMAIL = Deno.env.get("KATA_EMAIL") || "K.CC@seznam.cz";
      
      if (RESEND_API_KEY) {
        // Gather minimal data from DB
        let emergencyBody = `⚠️ NOUZOVÝ DENNÍ REPORT (${today})\n\nAutomatický systém selhal při generování plného reportu. Toto je nouzová verze.\n\n`;
        
        try {
          // Get recent threads
          const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
          const { data: threads } = await sb.from("did_threads").select("part_name, sub_mode, thread_label, last_activity_at").gte("last_activity_at", since).order("last_activity_at", { ascending: false }).limit(20);
          
          if (threads && threads.length > 0) {
            emergencyBody += `═══ VLÁKNA (24h) ═══\n`;
            for (const t of threads) {
              emergencyBody += `  ▸ ${t.part_name} [${t.sub_mode}] ${t.thread_label || ""} (${t.last_activity_at})\n`;
            }
          }
          
          // Get open tasks
          const { data: tasks } = await sb.from("did_therapist_tasks").select("task, assigned_to, status, priority").in("status", ["pending", "in_progress"]).limit(15);
          
          if (tasks && tasks.length > 0) {
            emergencyBody += `\n═══ OTEVŘENÉ ÚKOLY ═══\n`;
            for (const t of tasks) {
              emergencyBody += `  ▸ [${t.priority}/${t.assigned_to}] ${t.task} (${t.status})\n`;
            }
          }

          emergencyBody += `\n---\nTento nouzový report byl odeslán watchdog systémem po ${MAX_RETRIES} neúspěšných pokusech o vygenerování plného reportu.\n`;
        } catch (dataErr) {
          emergencyBody += `Nepodařilo se načíst ani nouzová data: ${dataErr instanceof Error ? dataErr.message : "unknown"}\n`;
        }

        // Send emergency emails
        const { Resend } = await import("npm:resend@2.0.0");
        const resend = new Resend(RESEND_API_KEY);

        for (const s of emergencyRecipients) {
          const recipientEmail = s.recipient === "hanka" ? "mujosobniasistentnamiru@gmail.com" : KATA_EMAIL;
          try {
            await resend.emails.send({
              from: "Karel DID <karel@karel-pomoc.lovable.app>",
              to: [recipientEmail],
              subject: `⚠️ Nouzový denní report DID – ${today}`,
              text: emergencyBody,
            });
            
            const existing = results.find(r => r.recipient === s.recipient);
            if (existing) {
              existing.strategy = "retry_emergency";
              existing.success = true;
              existing.detail = "emergency plain-text email sent";
            } else {
              results.push({ recipient: s.recipient, strategy: "retry_emergency", success: true, detail: "emergency plain-text email sent" });
            }
          } catch (emailErr) {
            const existing = results.find(r => r.recipient === s.recipient);
            if (existing) {
              existing.success = false;
              existing.detail = `emergency email failed: ${emailErr instanceof Error ? emailErr.message : "unknown"}`;
            } else {
              results.push({ recipient: s.recipient, strategy: "retry_emergency", success: false, detail: `emergency email failed: ${emailErr instanceof Error ? emailErr.message : "unknown"}` });
            }
          }
        }
      } else {
        logs.push("[watchdog] RESEND_API_KEY not configured, cannot send emergency emails");
      }
    }

    // 6. Update dispatch records
    for (const r of results) {
      const matchingStrategy = strategies.find(s => s.recipient === r.recipient);
      const dispatchRecord = matchingStrategy?.dispatch;
      const newRetryCount = (matchingStrategy?.retryCount || 0) + 1;
      const watchdogEntry = `[${new Date().toISOString()}] strategy=${r.strategy} success=${r.success} detail=${r.detail}`;
      
      if (dispatchRecord) {
        // Update existing record
        const existingLog = dispatchRecord.watchdog_log || "";
        await sb.from("did_daily_report_dispatches").update({
          status: r.success ? "sent" : "failed",
          sent_at: r.success ? new Date().toISOString() : dispatchRecord.sent_at,
          error_message: r.success ? null : r.detail.slice(0, 500),
          retry_count: newRetryCount,
          last_retry_strategy: r.strategy,
          watchdog_log: (existingLog ? existingLog + "\n" : "") + watchdogEntry,
        }).eq("id", dispatchRecord.id);
      } else {
        // No dispatch record exists yet — create one
        await sb.from("did_daily_report_dispatches").insert({
          report_date: today,
          recipient: r.recipient,
          status: r.success ? "sent" : "failed",
          sent_at: r.success ? new Date().toISOString() : null,
          error_message: r.success ? null : r.detail.slice(0, 500),
          retry_count: newRetryCount,
          last_retry_strategy: r.strategy,
          watchdog_log: watchdogEntry,
        });
      }
    }

    logs.push(`[watchdog] Completed. Results: ${JSON.stringify(results.map(r => ({ r: r.recipient, s: r.success, st: r.strategy })))}`);

    return new Response(JSON.stringify({ action: "retried", results, logs }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (error) {
    console.error("[watchdog] Fatal error:", error);
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "Unknown", logs }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
