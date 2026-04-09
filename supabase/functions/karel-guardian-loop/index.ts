import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

// ═══════════════════════════════════════════════════════════════
// KAREL GUARDIAN LOOP
// Běží každou hodinu. Žádné AI volání — čistě databázové kontroly.
//
// Co hlídá:
// 1. Nesplněné závazky (karel_commitments) po termínu
// 2. Ignorované úkoly (did_therapist_tasks) starší 3 dní bez reakce
// 3. Krize bez nových dat (crisis_alerts) — eskalace pokud >48h ticho
// 4. Nezodpovězené otázky (did_pending_questions) >24h
// 5. Sezení která měla proběhnout ale neproběhla
// 6. Agenda položky které expirují (karel_conversation_agenda)
//
// Princip: Karel Strážce. Primárně hlídá termíny a generuje upozornění.
// U některých záznamů také posouvá stav (např. broken / expired / escalated),
// ale nikdy nemaže existující data. Pokud něco selže, jen zaloguje chybu.
// ═══════════════════════════════════════════════════════════════

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ── Konstanty (žádná "magic numbers") ──────────────────────────
const GUARDIAN_TIME_ZONE = "Europe/Prague";
const HOURS_24 = 24;
const HOURS_48 = 48;
const DAYS_COMMITMENT_BROKEN = 7;
const DAYS_COMMITMENT_REMIND = 1;
const DAYS_TASK_IGNORED = 3;
const DAYS_SESSION_MISSED = 2;
const DAYS_AGENDA_ESCALATE_URGENT = 3;
const DAYS_AGENDA_EXPIRE_OPPORTUNITY = 7;
const DAYS_AGENDA_EXPIRE_NORMAL = 14;
const REMINDER_COOLDOWN_HOURS = 48;
const REMINDER_EXPIRY_DAYS = 3;
const MAX_ITEMS_PER_CHECK = 20;
const MAX_AGENDA_ITEMS_PER_CHECK = 50;

const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

// ── Typy ───────────────────────────────────────────────────────
interface GuardianStats {
  commitments_overdue: number;
  commitments_broken: number;
  commitments_reminded: number;
  tasks_ignored: number;
  tasks_reminded: number;
  crises_stale: number;
  crises_escalated: number;
  questions_unanswered: number;
  sessions_missed: number;
  sessions_reminded: number;
  agenda_expired: number;
  agenda_escalated: number;
}

type ReminderParams = {
  question: string;
  directed_to: string;
  subject_type: string;
  subject_id: string;
  now: Date;
};

type UpdatePayload = Record<string, string | boolean | null>;

// ── Helper: Datum v lokální TZ bez UTC posunu ──────────────────
function getDateInTimeZone(date: Date, timeZone: string): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  return formatter.format(date);
}

// ── Helper: Bezpečný update s logem ────────────────────────────
async function updateRowSafely(
  sb: SupabaseClient,
  table: string,
  id: string,
  patch: UpdatePayload,
): Promise<boolean> {
  const { error } = await sb.from(table).update(patch).eq("id", id);

  if (error) {
    console.warn(`[GUARDIAN] Chyba při update ${table}.${id}:`, error.message);
    return false;
  }

  return true;
}

// ── Helper: Odeslání reminderu s deduplikací ───────────────────
// Každý reminder se pošle maximálně jednou za REMINDER_COOLDOWN_HOURS.
// Vrací true pokud reminder byl odeslán, false pokud už existoval.
async function sendReminderIfNotRecent(
  sb: SupabaseClient,
  params: ReminderParams,
): Promise<boolean> {
  try {
    const cooldownSince = new Date(
      params.now.getTime() - REMINDER_COOLDOWN_HOURS * MS_PER_HOUR,
    ).toISOString();

    const { data: existing, error: checkError } = await sb
      .from("did_pending_questions")
      .select("id")
      .eq("subject_type", params.subject_type)
      .eq("subject_id", params.subject_id)
      .gte("created_at", cooldownSince)
      .limit(1);

    if (checkError) {
      console.warn(
        `[GUARDIAN] Chyba při kontrole duplicity reminderu (${params.subject_type}):`,
        checkError.message,
      );
      return false;
    }

    if (existing && existing.length > 0) {
      return false;
    }

    const { error: insertError } = await sb.from("did_pending_questions").insert({
      question: params.question,
      directed_to: params.directed_to,
      subject_type: params.subject_type,
      subject_id: params.subject_id,
      status: "pending",
      expires_at: new Date(
        params.now.getTime() + REMINDER_EXPIRY_DAYS * MS_PER_DAY,
      ).toISOString(),
    });

    if (insertError) {
      console.warn(
        `[GUARDIAN] Chyba při vkládání reminderu (${params.subject_type}):`,
        insertError.message,
      );
      return false;
    }

    return true;
  } catch (err) {
    console.warn("[GUARDIAN] Neočekávaná chyba v sendReminderIfNotRecent:", err);
    return false;
  }
}

// ── Helper: Výpočet dní od data ────────────────────────────────
function daysSince(date: string | Date, now: Date): number {
  const d = typeof date === "string" ? new Date(date) : date;
  if (Number.isNaN(d.getTime())) return 0;
  return Math.floor((now.getTime() - d.getTime()) / MS_PER_DAY);
}

// ── Helper: Normalizace therapist pro directed_to ──────────────
function normalizeDirectedTo(assignedTo: string | null): string {
  if (!assignedTo) return "both";
  const lower = assignedTo.toLowerCase().trim();
  if (lower === "kata" || lower === "káťa" || lower === "katka") return "kata";
  if (lower === "hanka" || lower === "hanička" || lower === "hanicka") return "hanka";
  return "both";
}

// ── Helper: Standardizovaná odpověď ────────────────────────────
function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ═══════════════════════════════════════════════════════════════
// HLAVNÍ FUNKCE
// ═══════════════════════════════════════════════════════════════

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error("[GUARDIAN] FATAL: Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    return jsonResponse({ error: "Missing environment variables" }, 500);
  }

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const now = new Date();
  const today = getDateInTimeZone(now, GUARDIAN_TIME_ZONE);

  console.log("[GUARDIAN] Starting run at", now.toISOString(), "local_date", today);

  const stats: GuardianStats = {
    commitments_overdue: 0,
    commitments_broken: 0,
    commitments_reminded: 0,
    tasks_ignored: 0,
    tasks_reminded: 0,
    crises_stale: 0,
    crises_escalated: 0,
    questions_unanswered: 0,
    sessions_missed: 0,
    sessions_reminded: 0,
    agenda_expired: 0,
    agenda_escalated: 0,
  };

  try {
    // 1. NESPLNĚNÉ ZÁVAZKY
    const { data: overdueCommitments, error: commitErr } = await sb
      .from("karel_commitments")
      .select("id, commitment_text, committed_by, due_date, follow_up_sent, created_at")
      .eq("status", "open")
      .lt("due_date", today)
      .order("due_date", { ascending: true })
      .limit(MAX_ITEMS_PER_CHECK);

    if (commitErr) {
      console.warn("[GUARDIAN] Chyba při čtení commitments:", commitErr.message);
    }

    for (const c of overdueCommitments || []) {
      const days = daysSince(c.due_date, now);
      stats.commitments_overdue++;

      if (days >= DAYS_COMMITMENT_BROKEN) {
        const updated = await updateRowSafely(sb, "karel_commitments", c.id, {
          status: "broken",
        });
        if (updated) stats.commitments_broken++;
        continue;
      }

      if (!c.follow_up_sent && days >= DAYS_COMMITMENT_REMIND) {
        const sent = await sendReminderIfNotRecent(sb, {
          question:
            `Závazek "${(c.commitment_text || "").slice(0, 150)}" měl být splněn do ${c.due_date} (${days} dní zpožděno). Jak to vypadá?`,
          directed_to: c.committed_by === "karel"
            ? "both"
            : normalizeDirectedTo(c.committed_by),
          subject_type: "commitment_followup",
          subject_id: c.id,
          now,
        });

        if (sent) {
          const updated = await updateRowSafely(sb, "karel_commitments", c.id, {
            follow_up_sent: true,
            follow_up_sent_at: now.toISOString(),
          });
          if (updated) stats.commitments_reminded++;
        }
      }
    }

    // 2. IGNOROVANÉ ÚKOLY
    const taskCutoff = new Date(
      now.getTime() - DAYS_TASK_IGNORED * MS_PER_DAY,
    ).toISOString();

    const { data: ignoredTasks, error: taskErr } = await sb
      .from("did_therapist_tasks")
      .select("id, task, assigned_to, source, created_at")
      .eq("status", "pending")
      .lt("created_at", taskCutoff)
      .limit(MAX_ITEMS_PER_CHECK);

    if (taskErr) {
      console.warn("[GUARDIAN] Chyba při čtení úkolů:", taskErr.message);
    }

    for (const t of ignoredTasks || []) {
      if (t.source === "therapist_manual") continue;

      stats.tasks_ignored++;
      const days = daysSince(t.created_at, now);

      const sent = await sendReminderIfNotRecent(sb, {
        question:
          `Úkol "${(t.task || "").slice(0, 120)}" čeká ${days} dní. Potřebujete s ním pomoci?`,
        directed_to: normalizeDirectedTo(t.assigned_to),
        subject_type: "task_reminder",
        subject_id: t.id,
        now,
      });

      if (sent) stats.tasks_reminded++;
    }

    // 3. KRIZE BEZ NOVÝCH DAT
    const { data: activeCrises, error: crisisErr } = await sb
      .from("crisis_alerts")
      .select("id, part_name, days_in_crisis, created_at")
      .neq("status", "resolved");

    if (crisisErr) {
      console.warn("[GUARDIAN] Chyba při čtení krizí:", crisisErr.message);
    }

    for (const crisis of activeCrises || []) {
      const { data: lastJournal, error: journalErr } = await sb
        .from("crisis_journal")
        .select("date, created_at")
        .eq("crisis_alert_id", crisis.id)
        .order("created_at", { ascending: false })
        .limit(1);

      if (journalErr) {
        console.warn(
          `[GUARDIAN] Chyba při čtení crisis_journal pro ${crisis.part_name}:`,
          journalErr.message,
        );
        continue;
      }

      const lastEntryDate =
        (lastJournal && lastJournal.length > 0 && lastJournal[0].created_at)
          ? new Date(lastJournal[0].created_at)
          : new Date(crisis.created_at);

      if (Number.isNaN(lastEntryDate.getTime())) {
        console.warn(`[GUARDIAN] Nevalidní datum pro krizi ${crisis.part_name}, přeskakuji.`);
        continue;
      }

      const hoursSinceEntry = (now.getTime() - lastEntryDate.getTime()) / MS_PER_HOUR;

      if (hoursSinceEntry > HOURS_48) {
        stats.crises_stale++;

        const sent = await sendReminderIfNotRecent(sb, {
          question:
            `Krize ${crisis.part_name} nemá žádný nový záznam přes ${Math.floor(hoursSinceEntry)} hodin. Jak situace pokračuje? Potřebujete sezení?`,
          directed_to: "both",
          subject_type: "crisis_stale_escalation",
          subject_id: crisis.id,
          now,
        });

        if (sent) stats.crises_escalated++;
      }
    }

    // 4. NEZODPOVĚZENÉ OTÁZKY > 24h
    const questionCutoff = new Date(
      now.getTime() - HOURS_24 * MS_PER_HOUR,
    ).toISOString();

    const { data: unansweredQuestions, error: questErr } = await sb
      .from("did_pending_questions")
      .select("id")
      .in("status", ["pending", "sent"])
      .lt("created_at", questionCutoff);

    if (questErr) {
      console.warn("[GUARDIAN] Chyba při čtení otázek:", questErr.message);
    }

    stats.questions_unanswered = unansweredQuestions?.length || 0;

    // 5. ZMEŠKANÁ SEZENÍ
    const sessionCutoff = getDateInTimeZone(
      new Date(now.getTime() - DAYS_SESSION_MISSED * MS_PER_DAY),
      GUARDIAN_TIME_ZONE,
    );

    const { data: missedPlans, error: sessionErr } = await sb
      .from("did_daily_session_plans")
      .select("id, selected_part, therapist, plan_date")
      .in("status", ["planned", "pending"])
      .lt("plan_date", sessionCutoff)
      .limit(MAX_ITEMS_PER_CHECK);

    if (sessionErr) {
      console.warn("[GUARDIAN] Chyba při čtení sezení:", sessionErr.message);
    }

    for (const plan of missedPlans || []) {
      stats.sessions_missed++;

      const sent = await sendReminderIfNotRecent(sb, {
        question:
          `Plánované sezení s ${plan.selected_part || "neznámou částí"} (${plan.plan_date || "bez data"}) neproběhlo. Chcete přeplánovat?`,
        directed_to: normalizeDirectedTo(plan.therapist),
        subject_type: "session_missed",
        subject_id: plan.id,
        now,
      });

      if (sent) stats.sessions_reminded++;
    }

    // 6. EXPIRUJÍCÍ AGENDA POLOŽKY
    const { data: pendingAgenda, error: agendaErr } = await sb
      .from("karel_conversation_agenda")
      .select("id, topic, therapist, priority, created_at")
      .eq("status", "pending")
      .limit(MAX_AGENDA_ITEMS_PER_CHECK);

    if (agendaErr) {
      console.warn("[GUARDIAN] Chyba při čtení agendy:", agendaErr.message);
    }

    for (const item of pendingAgenda || []) {
      const days = daysSince(item.created_at, now);

      if (item.priority === "urgent" && days >= DAYS_AGENDA_ESCALATE_URGENT) {
        const sent = await sendReminderIfNotRecent(sb, {
          question: `Urgentní téma neprobráno: ${(item.topic || "").slice(0, 200)}`,
          directed_to: normalizeDirectedTo(item.therapist),
          subject_type: "agenda_escalation",
          subject_id: item.id,
          now,
        });

        if (sent) {
          const updated = await updateRowSafely(sb, "karel_conversation_agenda", item.id, {
            status: "escalated",
          });
          if (updated) stats.agenda_escalated++;
        }
      } else if (
        item.priority === "when_appropriate" && days >= DAYS_AGENDA_EXPIRE_OPPORTUNITY
      ) {
        const updated = await updateRowSafely(sb, "karel_conversation_agenda", item.id, {
          status: "expired",
        });
        if (updated) stats.agenda_expired++;
      } else if (item.priority === "normal" && days >= DAYS_AGENDA_EXPIRE_NORMAL) {
        const updated = await updateRowSafely(sb, "karel_conversation_agenda", item.id, {
          status: "expired",
        });
        if (updated) stats.agenda_expired++;
      }
    }

    // 7. LOG VÝSLEDKŮ
    const summary = [
      `Závazky: ${stats.commitments_overdue} po termínu, ${stats.commitments_broken} broken, ${stats.commitments_reminded} reminded`,
      `Úkoly: ${stats.tasks_ignored} ignorovaných, ${stats.tasks_reminded} reminded`,
      `Krize: ${stats.crises_stale} bez dat >${HOURS_48}h, ${stats.crises_escalated} eskalováno`,
      `Otázky: ${stats.questions_unanswered} nezodpovězených >${HOURS_24}h`,
      `Sezení: ${stats.sessions_missed} zmeškaných, ${stats.sessions_reminded} reminded`,
      `Agenda: ${stats.agenda_escalated} eskalováno, ${stats.agenda_expired} expirováno`,
    ].join(" | ");

    const { error: logError } = await sb.from("system_health_log").insert({
      event_type: "guardian_loop_run",
      severity: "info",
      message: summary,
    });

    if (logError) {
      console.warn("[GUARDIAN] Chyba při zápisu system_health_log:", logError.message);
    }

    console.log("[GUARDIAN] Completed:", summary);
    return jsonResponse({ success: true, stats });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    const errStack = error instanceof Error ? error.stack : "";
    console.error("[GUARDIAN] FATAL ERROR:", errMsg, errStack);

    try {
      await sb.from("system_health_log").insert({
        event_type: "guardian_loop_error",
        severity: "error",
        message: `FATAL: ${errMsg}`.slice(0, 500),
      });
    } catch (logErr) {
      console.error("[GUARDIAN] Nelze zapsat chybu do logu:", logErr);
    }

    return jsonResponse({ error: errMsg }, 500);
  }
});
