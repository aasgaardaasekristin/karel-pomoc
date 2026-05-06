/**
 * P29B.3-H2: detached helper for phase7.5 — eskalační emaily pro
 * zpožděné terapeutické úkoly. Nahrazuje původní inline blok v
 * `karel-did-daily-cycle/index.ts` (FÁZE 7.5).
 *
 * SAFETY:
 *   - DEFAULT je dry_run = true. Reálný email se odešle POUZE pokud
 *     `input.send_email === true`.
 *   - Smoke testy musí volat helper bez `send_email` → nic se neodešle.
 *
 * Kandidáti k eskalaci:
 *   - did_therapist_tasks ve stavu pending/active/in_progress/not_started
 *   - daysOld >= 3 → warning, >= 7 → critical
 *
 * Dedupe / already-sent guard:
 *   - last_escalation_email_at: critical = 1x/24h, warning = 1x/72h
 *
 * Recipients:
 *   - assignee "hanka" → MAMKA_EMAIL (env nebo default mujosobniasistentnamiru@gmail.com)
 *   - assignee "kata"  → KATA_EMAIL  (env nebo default K.CC@seznam.cz)
 *   - assignee "both"  → oba
 */

export interface Phase75Input {
  dry_run?: boolean;
  send_email?: boolean;
  source?: string;
}

export interface Phase75Result {
  outcome: "completed" | "controlled_skipped";
  duration_ms: number;
  dry_run: boolean;
  send_email: boolean;
  escalation_candidates_count: number;
  would_send_count: number;
  sent_count: number;
  skipped_count: number;
  deduped_count: number;
  recipients_count: number;
  controlled_skips: string[];
  errors: string[];
  reason?: string;
}

export interface Phase75Deps {
  sb: any;
  cycleId: string;
  userId: string;
  input: Phase75Input;
  setHeartbeat?: () => Promise<void>;
  log?: (msg: string) => void;
}

const HANKA_DEFAULT = "mujosobniasistentnamiru@gmail.com";
const KATA_DEFAULT = "K.CC@seznam.cz";

function fmtBody(assignee: string, criticalTasks: any[], warningTasks: any[]): { subject: string; body: string } {
  const hasCritical = criticalTasks.length > 0;
  const subject = hasCritical
    ? `Karel: 🚨 URGENT — ${criticalTasks.length} kriticky zpožděných úkolů!`
    : `Karel: ⏰ ${warningTasks.length} úkolů čeká na vyřízení`;
  let body = `<h2 style="color: ${hasCritical ? "#dc2626" : "#d97706"}">`;
  body += hasCritical ? `🚨 ${criticalTasks.length} kriticky zpožděných úkolů` : `⏰ ${warningTasks.length} úkolů čeká`;
  body += `</h2><p>Ahoj ${assignee === "hanka" ? "Hanko" : "Káťo"},</p>`;
  body += `<p>Tyto úkoly čekají na tvou pozornost:</p>`;
  if (criticalTasks.length > 0) {
    body += `<h3 style="color:#dc2626">🔴 KRITICKÉ (7+ dní)</h3><ul>`;
    for (const ct of criticalTasks) {
      body += `<li><strong>${ct.task.task}</strong> — ${ct.daysOverdue} dní`;
      if (ct.task.detail_instruction) body += `<br><small>Zadání: ${ct.task.detail_instruction}</small>`;
      body += `</li>`;
    }
    body += `</ul>`;
  }
  if (warningTasks.length > 0) {
    body += `<h3 style="color:#d97706">🟡 UPOZORNĚNÍ (3+ dní)</h3><ul>`;
    for (const wt of warningTasks) {
      body += `<li><strong>${wt.task.task}</strong> — ${wt.daysOverdue} dní</li>`;
    }
    body += `</ul>`;
  }
  body += `<p>Karel</p>`;
  return { subject, body };
}

export async function runPhase75EscalationEmails(deps: Phase75Deps): Promise<Phase75Result> {
  const t0 = Date.now();
  const { sb, input } = deps;
  const log = deps.log ?? ((m: string) => console.log(m));

  // Safety default: dry_run unless caller explicitly requests send_email=true.
  const send_email = input.send_email === true;
  const dry_run = !send_email || input.dry_run === true;

  const result: Phase75Result = {
    outcome: "completed",
    duration_ms: 0,
    dry_run,
    send_email,
    escalation_candidates_count: 0,
    would_send_count: 0,
    sent_count: 0,
    skipped_count: 0,
    deduped_count: 0,
    recipients_count: 0,
    controlled_skips: [],
    errors: [],
  };

  try {
    await deps.setHeartbeat?.();

    const { data: pendingTasks, error: tasksErr } = await sb
      .from("did_therapist_tasks")
      .select("id, task, detail_instruction, assigned_to, status, priority, created_at, escalation_level, last_escalation_email_at")
      .in("status", ["pending", "active", "in_progress", "not_started"])
      .order("created_at", { ascending: true })
      .limit(200);
    if (tasksErr) {
      result.errors.push(`tasks_query: ${tasksErr.message}`);
    }

    const overdue: Array<{ task: any; daysOverdue: number; assignee: string; escalationLevel: "warning" | "critical" }> = [];
    for (const task of pendingTasks ?? []) {
      const daysOld = Math.floor((Date.now() - new Date(task.created_at).getTime()) / 86400000);
      let lvl: "warning" | "critical" | "none" = "none";
      if (daysOld >= 7) lvl = "critical";
      else if (daysOld >= 3) lvl = "warning";
      if (lvl === "none") continue;
      overdue.push({ task, daysOverdue: daysOld, assignee: task.assigned_to || "nespecifikováno", escalationLevel: lvl });
    }
    result.escalation_candidates_count = overdue.length;

    if (overdue.length === 0) {
      result.outcome = "controlled_skipped";
      result.reason = "no_escalation_candidates";
      result.controlled_skips.push("no_escalation_candidates");
      result.duration_ms = Date.now() - t0;
      return result;
    }

    const hankaEmail = Deno.env.get("MAMKA_EMAIL") || Deno.env.get("HANKA_EMAIL") || HANKA_DEFAULT;
    const kataEmail = Deno.env.get("KATA_EMAIL") || KATA_DEFAULT;

    const byAssignee: Record<string, typeof overdue> = {};
    for (const ot of overdue) {
      const targets = ot.assignee === "both" ? ["hanka", "kata"] : [ot.assignee];
      for (const t of targets) {
        (byAssignee[t] ??= []).push(ot);
      }
    }

    await deps.setHeartbeat?.();

    for (const [assignee, tasks] of Object.entries(byAssignee)) {
      if (assignee !== "hanka" && assignee !== "kata") {
        result.controlled_skips.push(`unknown_assignee:${assignee}`);
        continue;
      }
      const target = assignee === "hanka" ? hankaEmail : kataEmail;
      if (!target) {
        result.controlled_skips.push(`missing_recipient:${assignee}`);
        continue;
      }

      const hasCritical = tasks.some(t => t.escalationLevel === "critical");
      const maxFreqMs = hasCritical ? 86400000 : 3 * 86400000;
      const lastEmailAt = tasks[0]?.task?.last_escalation_email_at;
      if (lastEmailAt && Date.now() - new Date(lastEmailAt).getTime() < maxFreqMs) {
        result.deduped_count += 1;
        log(`[phase7.5] dedupe ${assignee} (last=${lastEmailAt})`);
        continue;
      }

      const criticalTasks = tasks.filter(t => t.escalationLevel === "critical");
      const warningTasks = tasks.filter(t => t.escalationLevel === "warning");
      const { subject, body } = fmtBody(assignee, criticalTasks, warningTasks);

      result.would_send_count += 1;
      result.recipients_count += 1;

      if (dry_run) {
        log(`[phase7.5][dry_run] would email ${assignee} → ${target}: ${subject}`);
        continue;
      }

      // Production send: Resend HTTP, no third-party SDK to keep helper light.
      const RESEND_KEY = Deno.env.get("RESEND_API_KEY");
      if (!RESEND_KEY) {
        result.controlled_skips.push("email_transport_not_configured");
        result.skipped_count += 1;
        continue;
      }
      try {
        const res = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${RESEND_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            from: "Karel <karel@hana-chlebcova.cz>",
            to: [target],
            subject,
            html: body,
          }),
        });
        if (!res.ok) {
          const txt = await res.text().catch(() => "");
          result.errors.push(`resend_${res.status}:${assignee}:${txt.slice(0, 120)}`);
          result.skipped_count += 1;
          continue;
        }
        result.sent_count += 1;
        // Update last_escalation_email_at for these tasks.
        const ids = tasks.map(t => t.task?.id).filter(Boolean);
        for (const id of ids) {
          await sb.from("did_therapist_tasks")
            .update({ last_escalation_email_at: new Date().toISOString() } as any)
            .eq("id", id);
        }
      } catch (e: any) {
        result.errors.push(`send_throw:${assignee}:${e?.message ?? String(e)}`);
        result.skipped_count += 1;
      }
      await deps.setHeartbeat?.();
    }

    result.outcome = "completed";
    result.duration_ms = Date.now() - t0;
    return result;
  } catch (e: any) {
    result.errors.push(`fatal:${e?.message ?? String(e)}`);
    result.outcome = "controlled_skipped";
    result.reason = "helper_threw";
    result.duration_ms = Date.now() - t0;
    return result;
  }
}
