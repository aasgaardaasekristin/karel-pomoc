import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { SYSTEM_RULES, isKnownNonPart, deduplicateTasks } from "../_shared/system-rules.ts";
import { appendToDoc, findFolder, findFileByName, getAccessToken } from "../_shared/driveHelpers.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

/* ================================================================
   SYSTEM PROMPT
   ================================================================ */

const DASHBOARD_PROMPT = `Jsi Karel – AI vedoucí terapeutického týmu pro DID systém.
Tvým úkolem je sestavit DENNÍ DASHBOARD – komplexní briefing o stavu celého systému.

## PRAVIDLA ENTITY SEPARACE
- Hanka, Káťa = terapeutky, NEJSOU DID části.
- Locík = pes, NENÍ DID část.
- Amálka, Tonička = biologické děti, NEJSOU DID části.
- Jiří = partner, NENÍ DID část.
- Karel = AI asistent (ty), NENÍ DID část.

## BEZPEČNOSTNÍ PRAVIDLA
- NIKDY nezařazuj soukromé emoční stavy terapeutek (vinu, osobní trauma) do dashboardu.
- Soukromá data z PAMET_KAREL používej POUZE pro vnitřní dedukci.
- Kvůli epilepsii NENAVRHUJ dechová cvičení.
- NIKDY nepoužívej intimní oslovení.

## STRUKTURA DASHBOARDU

Vrať KOMPLETNÍ markdown dokument s touto strukturou:

# KARLŮV DENNÍ DASHBOARD - [datum]

## 1. CELKOVÝ STAV SYSTÉMU
[Zhodnoť celkový stav DID systému – stabilita, trendy, rizika]

## 2. AKTIVNÍ ČÁSTI ZA POSLEDNÍCH 24H
Pro každou aktivní část:
- **[Jméno]** (ID): [stručný popis stavu, co řešila, kritické problémy]

## 3. KRITICKÉ PROBLÉMY
[Seznam akutních problémů seřazených podle závažnosti]

## 4. TERAPEUTICKÉ POTŘEBY
Pro každý návrh sezení:
- **Část:** [jméno]
- **Téma:** [co řešit]
- **Doporučený terapeut:** [Hanka/Káťa/Karel/Tandem]
- **Priorita:** [vysoká/střední/nízká]
- **Důvod:** [proč právě teď]

## 5. STAV TERAPEUTICKÉHO TÝMU
- Kdo reagoval na porady
- Kdo nereagoval
- Kde jsou mezery v komunikaci
- Doporučení pro zlepšení spolupráce

## 6. STAV ÚKOLŮ
- **Posunuly se:** [seznam]
- **Visí (po termínu):** [seznam]
- **Nové:** [seznam]

## 7. KARLOVY ÚKOLY NA DNES
[Co Karel dnes musí udělat – rozdat úkoly, upozornit terapeuty, otevřít porady, poslat maily]

## 8. CO VYVĚSIT NA DASHBOARD V APLIKACI
Vrať strukturovaný JSON blok uvnitř markdown:
\`\`\`json
{
  "systemOverview": "stručný text pro Karlův přehled v aplikaci",
  "criticalAlerts": ["alert1", "alert2"],
  "todayTasks": [
    {"task": "...", "assignedTo": "hanka|kata|both", "priority": "high|medium|low"}
  ]
}
\`\`\`

Buď analytický, stručný a přesný. Každé tvrzení musí být podložené daty.
Pokud nemáš pro nějakou sekci data, napiš to otevřeně – NIKDY nevymýšlej.`;

/* ================================================================
   DATA COLLECTION (server-side)
   ================================================================ */

function createSupabaseAdmin() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );
}

async function fetchActiveParts24h(supabase: ReturnType<typeof createClient>): Promise<string> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  try {
    const { data, error } = await supabase
      .from("did_threads")
      .select("part_name, last_activity_at, thread_label, messages, sub_mode")
      .eq("sub_mode", "cast")
      .gte("last_activity_at", since)
      .order("last_activity_at", { ascending: false });

    if (error || !data?.length) return "(žádná aktivita)";

    const filtered = data.filter((t: any) => !isKnownNonPart(t.part_name || ""));

    if (!filtered.length) return "(žádná aktivita)";

    return filtered.map((t: any) => {
      const msgs = Array.isArray(t.messages) ? t.messages : [];
      const userMsgs = msgs.filter((m: any) => m.role === "user").length;
      return `- **${t.part_name}** (${t.thread_label || "bez názvu"}): ${userMsgs} zpráv, posl. aktivita ${t.last_activity_at}`;
    }).join("\n");
  } catch (e) {
    console.error("[Dashboard] fetchActiveParts24h error:", e);
    return "(chyba načítání)";
  }
}

async function fetchTasksData(supabase: ReturnType<typeof createClient>): Promise<string> {
  try {
    const { data, error } = await supabase
      .from("did_therapist_tasks")
      .select("task, assigned_to, status, status_hanka, status_kata, due_date, priority, created_at, completed_at")
      .order("created_at", { ascending: false })
      .limit(50);

    if (error || !data?.length) return "(žádné úkoly)";

    const now = new Date();
    const completed: string[] = [];
    const overdue: string[] = [];
    const newTasks: string[] = [];
    const active: string[] = [];

    for (const t of data) {
      const created = new Date(t.created_at);
      const isNew = (now.getTime() - created.getTime()) < 24 * 60 * 60 * 1000;
      const isOverdue = t.due_date && new Date(t.due_date) < now && t.status !== "done";
      const isDone = t.status === "done";
      const line = `${t.task} [${t.assigned_to}, ${t.priority || "medium"}]`;

      if (isDone && t.completed_at) {
        const completedAt = new Date(t.completed_at);
        if ((now.getTime() - completedAt.getTime()) < 24 * 60 * 60 * 1000) {
          completed.push(line);
        }
      } else if (isOverdue) {
        overdue.push(`${line} (termín: ${t.due_date})`);
      } else if (isNew) {
        newTasks.push(line);
      } else {
        active.push(line);
      }
    }

    const sections: string[] = [];
    if (completed.length) sections.push(`### Dokončené (24h):\n${completed.map(l => `- ${l}`).join("\n")}`);
    if (overdue.length) sections.push(`### Po termínu:\n${overdue.map(l => `- ⚠️ ${l}`).join("\n")}`);
    if (newTasks.length) sections.push(`### Nové:\n${newTasks.map(l => `- ${l}`).join("\n")}`);
    if (active.length) sections.push(`### Aktivní:\n${active.map(l => `- ${l}`).join("\n")}`);

    return sections.join("\n\n") || "(žádné úkoly)";
  } catch (e) {
    console.error("[Dashboard] fetchTasksData error:", e);
    return "(chyba načítání úkolů)";
  }
}

async function fetchMeetingsData(supabase: ReturnType<typeof createClient>): Promise<string> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  try {
    const { data, error } = await supabase
      .from("did_meetings")
      .select("topic, status, hanka_joined_at, kata_joined_at, outcome_summary, created_at")
      .gte("created_at", since)
      .order("created_at", { ascending: false });

    if (error || !data?.length) return "(žádné porady za 24h)";

    return data.map((m: any) => {
      const hankaStatus = m.hanka_joined_at ? `Hanka: ✅ (${m.hanka_joined_at})` : "Hanka: ❌ nereagovala";
      const kataStatus = m.kata_joined_at ? `Káťa: ✅ (${m.kata_joined_at})` : "Káťa: ❌ nereagovala";
      return `- **${m.topic}** [${m.status}]: ${hankaStatus}, ${kataStatus}${m.outcome_summary ? ` → ${m.outcome_summary}` : ""}`;
    }).join("\n");
  } catch (e) {
    console.error("[Dashboard] fetchMeetingsData error:", e);
    return "(chyba načítání porad)";
  }
}

async function fetchOperativePlan(supabase: ReturnType<typeof createClient>): Promise<string> {
  const today = new Date().toISOString().slice(0, 10);
  try {
    const { data, error } = await supabase
      .from("did_daily_session_plans")
      .select("selected_part, therapist, session_format, urgency_score, status, plan_markdown")
      .gte("plan_date", today)
      .order("urgency_score", { ascending: false })
      .limit(20);

    if (error || !data?.length) return "(žádné plánované sezení)";

    return data.map((p: any) =>
      `- **${p.selected_part}** [${p.therapist}, urgence: ${p.urgency_score}]: ${p.session_format}, status: ${p.status}`
    ).join("\n");
  } catch (e) {
    console.error("[Dashboard] fetchOperativePlan error:", e);
    return "(chyba načítání plánu)";
  }
}

async function fetchUpdatedCardsInfo(supabase: ReturnType<typeof createClient>): Promise<string> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  try {
    const { data, error } = await supabase
      .from("card_update_queue")
      .select("part_id, section, action, new_content, reason, created_at")
      .gte("created_at", since)
      .eq("applied", true)
      .order("created_at", { ascending: false })
      .limit(100);

    if (error || !data?.length) return "(žádné aktualizace karet)";

    const byPart: Record<string, string[]> = {};
    for (const d of data) {
      if (!byPart[d.part_id]) byPart[d.part_id] = [];
      byPart[d.part_id].push(`Sekce ${d.section}: ${d.action} – ${(d.reason || d.new_content || "").slice(0, 80)}`);
    }

    return Object.entries(byPart)
      .map(([part, changes]) => `### ${part}\n${changes.map(c => `- ${c}`).join("\n")}`)
      .join("\n\n");
  } catch (e) {
    console.error("[Dashboard] fetchUpdatedCardsInfo error:", e);
    return "(chyba načítání aktualizací karet)";
  }
}

async function fetchCrisisAlerts(supabase: ReturnType<typeof createClient>): Promise<{ active: any[]; resolved: any[]; text: string }> {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  try {
    const { data, error } = await supabase
      .from("crisis_alerts")
      .select("*")
      .gte("created_at", todayStart.toISOString())
      .order("created_at", { ascending: false });

    if (error || !data?.length) return { active: [], resolved: [], text: "" };

    const active = data.filter((a: any) => a.status === "ACTIVE" || a.status === "ACKNOWLEDGED");
    const resolved = data.filter((a: any) => a.status === "RESOLVED");

    const lines: string[] = [];
    for (const a of data) {
      const signals = (a.trigger_signals || []).join(", ");
      lines.push(`- **${a.part_name}** [${a.severity}, ${a.status}]: ${a.summary} | Signály: ${signals}`);
    }
    return { active, resolved, text: lines.join("\n") || "(žádné)" };
  } catch (e) {
    console.error("[Dashboard] fetchCrisisAlerts error:", e);
    return { active: [], resolved: [], text: "(chyba načítání)" };
  }
}

/* ================================================================
   COMMAND SNAPSHOT — structured 4-section data for KarelDailyPlan
   ================================================================ */

// Prague-day boundary: returns ISO timestamp for today's 00:00 in Europe/Prague.
function pragueStartOfDayISO(reference: Date = new Date()): string {
  // sv-SE locale yields "YYYY-MM-DD" — same calendar day as Prague.
  const ymd = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Prague" }).format(reference);
  // Prague offset varies (CET +01:00 / CEST +02:00). We compute it for the reference moment.
  const dtfParts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Prague",
    timeZoneName: "shortOffset",
  }).formatToParts(reference);
  const offPart = dtfParts.find((p) => p.type === "timeZoneName")?.value || "GMT+01:00";
  const m = offPart.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/);
  const sign = m?.[1] === "-" ? "-" : "+";
  const hh = (m?.[2] || "1").padStart(2, "0");
  const mm = (m?.[3] || "00").padStart(2, "0");
  return `${ymd}T00:00:00${sign}${hh}:${mm}`;
}
function pragueTodayYMD(reference: Date = new Date()): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Prague" }).format(reference);
}

async function buildCommandSnapshot(supabase: ReturnType<typeof createClient>): Promise<any> {
  const now = Date.now();
  const startISO = pragueStartOfDayISO(new Date(now));
  const oneDayAgoISO = new Date(now - 24 * 60 * 60 * 1000).toISOString();
  const fiveDaysAgoISO = new Date(now - 5 * 24 * 60 * 60 * 1000).toISOString();

  const [threadsRes, registryRes, crisisEventsRes, crisisAlertsRes, questionsRes, tasksRes, prevMetricsRes, todayMetricsRes] = await Promise.all([
    supabase
      .from("did_threads")
      .select("id, part_name, sub_mode, last_activity_at, created_at, thread_label")
      .gte("created_at", startISO)
      .order("created_at", { ascending: false })
      .limit(20),
    supabase
      .from("did_part_registry")
      .select("part_name, status, last_seen_at, last_emotional_intensity, updated_at, first_seen_at")
      .order("updated_at", { ascending: false })
      .limit(50),
    // CANONICAL crisis source: crisis_events (open phases). crisis_alerts is secondary
    // and only used to enrich severity / summary / hours-stale when not present on event.
    supabase
      .from("crisis_events")
      .select("id, part_name, severity, phase, trigger_description, opened_at, updated_at, awaiting_response_from")
      .not("phase", "in", "(\"closed\",\"CLOSED\")")
      .order("updated_at", { ascending: false })
      .limit(10),
    supabase
      .from("crisis_alerts")
      .select("id, part_name, severity, summary, created_at, status")
      .in("status", ["ACTIVE", "ACKNOWLEDGED"])
      .gte("created_at", oneDayAgoISO)
      .order("created_at", { ascending: false })
      .limit(10),
    supabase
      .from("did_pending_questions")
      .select("id, question, directed_to, created_at, status, part_name")
      .in("status", ["pending", "sent", "open"])
      .lt("created_at", oneDayAgoISO)
      .order("created_at", { ascending: true })
      .limit(15),
    supabase
      .from("did_therapist_tasks")
      .select("id, task, assigned_to, priority, status, created_at, due_date")
      .in("priority", ["high", "urgent", "critical"])
      .in("status", ["pending", "active", "in_progress", "not_started"])
      .lt("created_at", fiveDaysAgoISO)
      .order("created_at", { ascending: true })
      .limit(15),
    supabase
      .from("daily_metrics")
      .select("part_name, valence, captured_at")
      .gte("captured_at", new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString())
      .lt("captured_at", oneDayAgoISO)
      .order("captured_at", { ascending: false })
      .limit(50),
    supabase
      .from("daily_metrics")
      .select("part_name, valence, captured_at")
      .gte("captured_at", oneDayAgoISO)
      .order("captured_at", { ascending: false })
      .limit(50),
  ]);

  const isBanned = (n: string | null) => {
    const x = (n || "").toLowerCase();
    return !x || x === "system" || x === "karel" || x === "hanka" || x === "hanička" || x === "kata" || x === "káťa" || x === "locík";
  };
  const hoursSince = (iso: string | null) => iso ? Math.round((now - new Date(iso).getTime()) / 3_600_000) : null;
  const detectOwner = (raw: string | null): string => {
    const low = (raw || "").toLowerCase();
    if (low.includes("han")) return "hanka";
    if (low.includes("kát") || low.includes("kata")) return "kata";
    if (low.includes("both") || low.includes("obe")) return "obě";
    return "tým";
  };

  // 1. DNES NOVĚ — new threads or new registry parts created today
  const todayNewMap = new Map<string, any>();
  for (const t of (threadsRes.data || [])) {
    if (isBanned(t.part_name)) continue;
    if (todayNewMap.has(t.part_name)) continue;
    todayNewMap.set(t.part_name, {
      entity: t.part_name,
      owner: t.sub_mode === "kata" ? "kata" : "hanka",
      lastUpdate: t.last_activity_at,
      reason: t.thread_label ? `nové vlákno: „${(t.thread_label || "").slice(0, 80)}"` : "nové vlákno",
      ctaPath: `/chat?did_submode=cast&thread_id=${t.id}`,
    });
  }
  for (const r of (registryRes.data || [])) {
    if (isBanned(r.part_name)) continue;
    if (!r.first_seen_at || r.first_seen_at < startISO) continue;
    if (todayNewMap.has(r.part_name)) continue;
    todayNewMap.set(r.part_name, {
      entity: r.part_name,
      owner: "tým",
      lastUpdate: r.first_seen_at,
      reason: "nově identifikovaná část",
      ctaPath: `/chat?did_submode=cast`,
    });
  }
  const todayNew = Array.from(todayNewMap.values()).slice(0, 6);

  // 2. DNES HORŠÍ — high intensity (≥4) registry rows updated today, or new high-severity crisis
  const todayWorse: any[] = [];
  const prevValence = new Map<string, number>();
  for (const m of (prevMetricsRes.data || [])) {
    if (!prevValence.has(m.part_name)) prevValence.set(m.part_name, m.valence);
  }
  for (const m of (todayMetricsRes.data || [])) {
    if (isBanned(m.part_name)) continue;
    const prev = prevValence.get(m.part_name);
    if (prev != null && m.valence < prev - 0.3) {
      todayWorse.push({
        entity: m.part_name,
        owner: "tým",
        lastUpdate: m.captured_at,
        reason: `valence klesla ${prev.toFixed(1)} → ${m.valence.toFixed(1)}`,
        ctaPath: `/chat?did_submode=cast`,
      });
    }
  }
  for (const r of (registryRes.data || [])) {
    if (isBanned(r.part_name)) continue;
    if ((r.last_emotional_intensity || 0) >= 4 && r.updated_at && r.updated_at >= oneDayAgoISO) {
      if (todayWorse.find(x => x.entity === r.part_name)) continue;
      todayWorse.push({
        entity: r.part_name,
        owner: "tým",
        lastUpdate: r.updated_at,
        reason: `emoční intenzita ${r.last_emotional_intensity}/5`,
        ctaPath: `/chat?did_submode=cast`,
      });
    }
  }
  // Index alerts by part_name for enrichment of canonical crisis_events rows.
  const alertsByPart = new Map<string, any>();
  for (const a of (crisisAlertsRes.data || [])) {
    if (!alertsByPart.has(a.part_name)) alertsByPart.set(a.part_name, a);
  }

  for (const ev of (crisisEventsRes.data || [])) {
    if (isBanned(ev.part_name)) continue;
    const sev = ev.severity || alertsByPart.get(ev.part_name)?.severity;
    if (sev !== "high" && sev !== "critical") continue;
    if (todayWorse.find(x => x.entity === ev.part_name)) continue;
    todayWorse.push({
      entity: ev.part_name,
      owner: "tým",
      lastUpdate: ev.updated_at || ev.opened_at,
      reason: `${sev} krize: ${(ev.trigger_description || alertsByPart.get(ev.part_name)?.summary || "").slice(0, 80)}`,
      ctaPath: `/chat?did_submode=cast&crisis_id=${ev.id}`,
    });
  }

  // 3. DNES NEPOTVRZENÉ — pending questions older than 24h
  const todayUnconfirmed = (questionsRes.data || []).map((q: any) => ({
    entity: q.part_name && !isBanned(q.part_name) ? q.part_name : "obecné",
    owner: detectOwner(q.directed_to),
    lastUpdate: q.created_at,
    reason: (q.question || "").slice(0, 100),
    ctaPath: `/chat?did_submode=mamka&question_id=${q.id}`,
  })).slice(0, 6);

  // 4. DNES VYŽADUJE ZÁSAH — overdue tasks (priority high+) + crises without today interview
  const todayActionRequired: any[] = [];
  for (const t of (tasksRes.data || [])) {
    todayActionRequired.push({
      entity: t.task ? (t.task.match(/[A-ZČŠŘŽÝÁÍÉŮÚĎŤŇ][a-zčšřžýáíéůúďťň]+/)?.[0] || "úkol") : "úkol",
      owner: detectOwner(t.assigned_to),
      lastUpdate: t.created_at,
      reason: `${t.priority?.toUpperCase() || "HIGH"}: ${(t.task || "").slice(0, 80)}`,
      deadline: t.due_date,
      ctaPath: `/chat?did_submode=mamka&task_id=${t.id}`,
    });
  }

  // Crisis command cards (top of dashboard) — canonical source: crisis_events.
  // Each card carries the canonical crisisEventId so command card, thread badge and
  // detail panel point to the SAME entity.
  const phaseToState = (phase: string | null): string => {
    const p = (phase || "").toLowerCase();
    if (p === "closing" || p === "ready_to_close") return "ready_to_close";
    if (p === "diagnostic" || p === "stabilizing") return "awaiting_feedback";
    if (p === "closed") return "closed";
    return "active";
  };
  const commandCrises = (crisisEventsRes.data || []).map((ev: any) => {
    const alert = alertsByPart.get(ev.part_name);
    const sev = ev.severity || alert?.severity || "medium";
    const lastUpdate = ev.updated_at || ev.opened_at || alert?.created_at;
    const summary = ev.trigger_description || alert?.summary || "";
    const awaiting: string[] = Array.isArray(ev.awaiting_response_from) ? ev.awaiting_response_from : [];
    const missing: string[] = [];
    if (awaiting.length > 0) missing.push(`feedback: ${awaiting.join(", ")}`);
    return {
      crisisEventId: ev.id,
      partName: ev.part_name,
      state: phaseToState(ev.phase),
      severity: sev,
      hoursStaleUpdate: hoursSince(lastUpdate),
      missing,
      requires: summary ? [summary.slice(0, 120)] : [],
      ctas: [
        { label: "Otevřít krizové vlákno", path: `/chat?crisis_action=interview&crisis_id=${ev.id}` },
      ],
    };
  });

  return {
    generated_at: new Date().toISOString(),
    pragueDate: pragueTodayYMD(new Date(now)),
    command: { crises: commandCrises },
    todayNew,
    todayWorse: todayWorse.slice(0, 6),
    todayUnconfirmed,
    todayActionRequired: todayActionRequired.slice(0, 8),
  };
}

async function saveDashboardToDrive(supabase: ReturnType<typeof createClient>, markdown: string): Promise<void> {
  try {
    const { error } = await supabase.functions.invoke("karel-did-drive-write", {
      body: {
        targetDocument: "00_Aktualni_Dashboard",
        content: markdown,
        writeType: "replace",
      },
    });
    if (error) {
      console.error("[Dashboard] Drive write failed:", error);
    } else {
      console.log("[Dashboard] Dashboard uložen na Drive.");
    }
  } catch (err) {
    console.error("[Dashboard] Drive write exception:", err);
  }
}

/* ================================================================
   APP DATA UPDATE
   ================================================================ */

async function applyAppUpdates(supabase: ReturnType<typeof createClient>, appData: any): Promise<void> {
  try {
    if (appData.systemOverview) {
      const { error } = await supabase
        .from("did_system_profile")
        .update({
          karel_master_analysis: appData.systemOverview,
          updated_at: new Date().toISOString(),
        })
        .not("id", "is", null);
      if (error) console.warn("[Dashboard] Failed to update system overview:", error);
    }

    if (appData.todayTasks?.length) {
      const normalizeAssignee = (raw: string): string => {
        const lower = (raw || "").toLowerCase();
        if (lower.includes("both") || lower.includes("tandem")) return "both";
        if (lower.includes("kata") || lower.includes("káťa")) return "kata";
        if (lower.includes("karel")) return "karel";
        return "hanka";
      };

      // Anti-dup: load existing pending tasks
      const { data: existingTasks } = await supabase
        .from("did_therapist_tasks")
        .select("task")
        .in("status", ["pending", "active", "in_progress"])
        .limit(200);
      const existingPrefixes = new Set(
        (existingTasks || []).map((t: any) => (t.task || "").slice(0, 40).toLowerCase())
      );

      const tasksToInsert = appData.todayTasks
        .filter((t: any) => {
          if (!t.task || !t.assignedTo) return false;
          const prefix = (t.task || "").slice(0, 40).toLowerCase();
          if (existingPrefixes.has(prefix)) return false;
          existingPrefixes.add(prefix); // prevent intra-batch dups
          return true;
        })
        .map((t: any) => ({
          task: t.task,
          assigned_to: normalizeAssignee(t.assignedTo),
          priority: t.priority || "medium",
          status: "pending",
          task_tier: "daily",
          category: "dashboard",
        }));

      if (tasksToInsert.length) {
        const { error } = await supabase.from("did_therapist_tasks").insert(tasksToInsert);
        if (error) console.warn("[Dashboard] Failed to insert tasks:", error);
        else console.log(`[Dashboard] Vytvořeno ${tasksToInsert.length} nových úkolů (anti-dup filtr).`);
      }
    }
  } catch (err) {
    console.error("[Dashboard] App update exception:", err);
  }
}

async function syncSavedTopicsToDrive(supabase: ReturnType<typeof createClient>): Promise<{ scanned: number; synced: number; pending: number }> {
  const { data: topics, error } = await supabase
    .from("karel_saved_topics")
    .select("id, title, extracted_context, synced_to_drive_at, pending_drive_sync, section, sub_mode")
    .eq("is_active", true)
    .or("pending_drive_sync.eq.true,synced_to_drive_at.is.null")
    .limit(20);

  if (error || !topics?.length) {
    if (error) console.warn("[Dashboard] Saved topics sync load failed:", error);
    return { scanned: 0, synced: 0, pending: 0 };
  }

  let synced = 0;
  let pending = 0;

  try {
    const token = await getAccessToken();
    const kartotekaRoot = await findFolder(token, "kartoteka_DID");
    const memoryRoot = await findFolder(token, "PAMET_KAREL");

    for (const topic of topics) {
      const destinationRoot = /did|část|fragment|vnitřn/i.test(topic.extracted_context) ? kartotekaRoot : memoryRoot;
      if (!destinationRoot) {
        pending++;
        await supabase.from("karel_saved_topics").update({ pending_drive_sync: true }).eq("id", topic.id);
        continue;
      }

      const existingFileId = await findFileByName(token, topic.title, destinationRoot);
      if (!existingFileId) {
        pending++;
        await supabase.from("karel_saved_topics").update({ pending_drive_sync: true }).eq("id", topic.id);
        continue;
      }

      await appendToDoc(token, existingFileId, `\n\n## Rozpracované téma: ${topic.title}\n${topic.extracted_context}\n`);
      await supabase
        .from("karel_saved_topics")
        .update({ synced_to_drive_at: new Date().toISOString(), pending_drive_sync: false })
        .eq("id", topic.id);
      synced++;
    }
  } catch (driveError) {
    console.warn("[Dashboard] Saved topics drive sync deferred:", driveError);
    pending = topics.length;
    await supabase
      .from("karel_saved_topics")
      .update({ pending_drive_sync: true })
      .in("id", topics.map((topic: any) => topic.id));
  }

  return { scanned: topics.length, synced, pending };
}

/* ================================================================
   MAIN HANDLER
   ================================================================ */

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const reqBody = await req.json().catch(() => ({}));
    const { date, trigger, mode } = reqBody;
    const targetDate = date || new Date().toISOString().slice(0, 10);
    const triggerSource = trigger || "manual";

    console.log(`[Dashboard] ═══ Spouštím dashboard pro ${targetDate} (trigger: ${triggerSource}, mode: ${mode || "full"}) ═══`);

    const supabase = createSupabaseAdmin();

    // ═══ MODE: snapshot — return only structured command data (no AI, no Drive write) ═══
    if (mode === "snapshot") {
      try {
        const snapshot = await buildCommandSnapshot(supabase);
        return new Response(JSON.stringify({ success: true, snapshot }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      } catch (e) {
        console.error("[Dashboard] snapshot build failed:", e);
        return new Response(JSON.stringify({ success: false, error: String(e) }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY is not configured");

    // 1. COLLECT ALL DATA (parallel)
    console.log("[Dashboard] Krok 1: Sběr dat server-side...");
    const [activePartsData, tasksData, meetingsData, operativePlan, updatedCardsInfo, crisisData] = await Promise.all([
      fetchActiveParts24h(supabase),
      fetchTasksData(supabase),
      fetchMeetingsData(supabase),
      fetchOperativePlan(supabase),
      fetchUpdatedCardsInfo(supabase),
      fetchCrisisAlerts(supabase),
    ]);

    // ═══ CRISIS CONTEXT INJECTION ═══
    let crisisSystemInjection = "";
    if (crisisData.active.length > 0) {
      const alertBlocks = crisisData.active.map((a: any) => {
        const statusText = a.status === "ACTIVE" ? "čeká na reakci" : ("řeší se (potvrzeno " + (a.acknowledged_by || "?") + ")");
        const plan = a.intervention_plan || "(nebyl vygenerován)";
        return "- Část: " + a.part_name + ", Úroveň: " + a.severity + ", Status: " + statusText + "\n  Souhrn: " + a.summary + "\n  Plán intervence: " + plan;
      }).join("\n\n");

      crisisSystemInjection = `

POZOR – KRIZOVÁ SITUACE:

Dnes byla detekována krizová situace. Toto MUSÍ být PRVNÍ a NEJDŮLEŽITĚJŠÍ část tvého přehledu. Nezačínej přehled běžným shrnutím dne. Začni KRIZOVÝM BLOKEM.

Aktivní krize:
${alertBlocks}

Tvůj přehled MUSÍ začínat takto:

"🔴 KRIZOVÉ UPOZORNĚNÍ

[part_name] je/byl dnes v akutním distresu. [summary]

Úroveň rizika: [severity]
Status: [status]

OKAMŽITÉ KROKY:
1. [z intervention_plan]
2. [z intervention_plan]

Krizová porada je otevřena – připojte se."

Teprve PO krizovém bloku pokračuj s běžným přehledem dne.
Ale i v běžném přehledu ZMIŇ krizovou situaci v kontextu aktivity dané části.
NIKDY neprezentuj den jako "normální" pokud existuje aktivní krize.`;
    }

    // ═══ SECURITY STATUS BLOCK ═══
    let securityStatusBlock = "\n\n## BEZPEČNOSTNÍ STATUS\n";
    if (crisisData.active.length > 0) {
      securityStatusBlock += "🔴 AKTIVNÍ KRIZE – viz krizový blok výše.\n";
      for (const a of crisisData.active) {
        securityStatusBlock += `- ${a.part_name}: ${a.severity}, status: ${a.status}\n`;
      }
    } else if (crisisData.resolved.length > 0) {
      for (const a of crisisData.resolved) {
        securityStatusBlock += `⚠️ Dnes byla řešena krizová situace u ${a.part_name}. Status: vyřešeno v ${a.resolved_at || "?"}. Detaily v krizovém vlákně.\n`;
      }
    } else {
      securityStatusBlock += "✅ Žádné krizové situace dnes detekovány.\n";
    }

    // 2. BUILD PROMPT
    const effectiveSystemPrompt = DASHBOARD_PROMPT + crisisSystemInjection;

    const userPrompt = `## DATUM: ${targetDate}

## AKTIVNÍ ČÁSTI (posledních 24h):
${activePartsData}

## AKTUALIZOVANÉ KARTY:
${updatedCardsInfo}

## STAV ÚKOLŮ:
${tasksData}

## PORADY:
${meetingsData}

## OPERATIVNÍ PLÁN:
${operativePlan}

${crisisData.text ? `## KRIZOVÉ ALERTY DNES:\n${crisisData.text}` : ""}
${securityStatusBlock}

Sestav kompletní denní dashboard.`;

    console.log(`[Dashboard] Data sebrána. Prompt ~${userPrompt.length} chars. Volám AI...`);

    // 3. CALL AI — TWO SEPARATE BRIEFINGS
    const callBriefingAI = async (therapistPrompt: string, userMsg: string): Promise<string> => {
      let content = "";
      let lastErr = "";
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const aiResponse = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${LOVABLE_API_KEY}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model: "google/gemini-2.5-flash",
              messages: [
                { role: "system", content: therapistPrompt },
                { role: "user", content: userMsg },
              ],
              temperature: 0.3,
            }),
          });

          if (!aiResponse.ok) {
            const errText = await aiResponse.text();
            lastErr = `AI error ${aiResponse.status}: ${errText}`;
            console.warn(`[Dashboard] Attempt ${attempt}/3: ${lastErr}`);
            if (aiResponse.status === 429 || aiResponse.status === 402) {
              throw new Error(lastErr);
            }
            if (attempt < 3) { await new Promise(r => setTimeout(r, 3000)); continue; }
            throw new Error(lastErr);
          }

          const aiData = await aiResponse.json();
          content = aiData.choices?.[0]?.message?.content ?? "";
          break;
        } catch (e) {
          lastErr = String(e);
          if (attempt < 3) { await new Promise(r => setTimeout(r, 3000)); continue; }
        }
      }
      return content;
    };

    const todayISO = new Date().toISOString().slice(0, 10);
    const roleGuard = `\n\nDNEŠNÍ DATUM: ${todayISO}. Události starší 5 dnů považuj za HISTORICKÉ.\n\nROLE GUARD: Karel NIKDY neúkoluje terapeutky přípravou materiálů, plánů, technik ani analytickou prací. Karel tyto materiály PŘIPRAVUJE SÁM. Úkoly pro terapeutky: potvrdit účast, sdělit pozorování, odpovědět na otázku, provést konkrétní intervenci při sezení.\n`;
    const hanaSystemPrompt = SYSTEM_RULES + "\n\n" + effectiveSystemPrompt + roleGuard + "\nGenerujes DENNI BRIEFING pro terapeutku HANICKU.\nZahrn POUZE ukoly prirazene Hanicce nebo obema.\nNEZAHRNUJ ukoly ktere jsou POUZE pro Katu.\nNERIKEJ Hanicce aby koordinovala Katu — to je TVOJE prace.";
    const kataSystemPrompt = SYSTEM_RULES + "\n\n" + effectiveSystemPrompt + roleGuard + "\nGenerujes DENNI BRIEFING pro terapeutku KATU.\nZahrn POUZE ukoly prirazene Kate nebo obema.\nNEZAHRNUJ ukoly ktere jsou POUZE pro Hanicku.\nPokud ma Kata zpozdene ukoly, upozorni JI PRIMO — neposilej upozorneni pres Hanicku.";

    console.log("[Dashboard] Generuji dva separátní briefingy...");
    const [hanaBriefing, kataBriefing] = await Promise.all([
      callBriefingAI(hanaSystemPrompt, userPrompt + "\n\nVygeneruj briefing pro Hanicku."),
      callBriefingAI(kataSystemPrompt, userPrompt + "\n\nVygeneruj briefing pro Katu."),
    ]);

    if (!hanaBriefing && !kataBriefing) {
      throw new Error("Both briefings failed to generate");
    }

    const aiContent = "# BRIEFING PRO HANIČKU\n\n" + (hanaBriefing || "(nepodařilo se vygenerovat)") + "\n\n---\n\n# BRIEFING PRO KÁŤU\n\n" + (kataBriefing || "(nepodařilo se vygenerovat)");

    // 4. EXTRACT APP DATA from both briefings
    let appData: any = null;
    const jsonMatch = aiContent.match(/```json\s*([\s\S]*?)```/);
    if (jsonMatch) {
      try {
        appData = JSON.parse(jsonMatch[1].trim());
      } catch {
        console.warn("[Dashboard] Failed to parse app data JSON");
      }
    }
    // Try second briefing if first had no JSON
    if (!appData) {
      const jsonMatch2 = kataBriefing.match(/```json\s*([\s\S]*?)```/);
      if (jsonMatch2) {
        try {
          const appData2 = JSON.parse(jsonMatch2[1].trim());
          appData = appData2;
        } catch { /* ignore */ }
      }
    }
    // Deduplicate tasks if found
    if (appData?.todayTasks) {
      appData.todayTasks = deduplicateTasks(appData.todayTasks);
    }

    console.log(`[Dashboard] AI vygenerováno: ${aiContent.length} chars, appData: ${appData ? "yes" : "no"}`);

    // 5. SAVE TO DRIVE
    console.log("[Dashboard] Krok 5: Ukládám na Drive...");
    await saveDashboardToDrive(supabase, aiContent);

    // 6. UPDATE APP DATA
    if (appData) {
      console.log("[Dashboard] Krok 6: Aktualizuji aplikaci...");
      await applyAppUpdates(supabase, appData);
    }

    const topicSync = await syncSavedTopicsToDrive(supabase);
    console.log(`[Dashboard] Saved topics sync: scanned=${topicSync.scanned}, synced=${topicSync.synced}, pending=${topicSync.pending}`);

    console.log(`[Dashboard] ═══ Dashboard pro ${targetDate} dokončen ═══`);

    // 7. CRISIS DAILY ASSESSMENT — auto-trigger for active crises
    try {
      const crisisResp = await fetch(
        `${Deno.env.get("SUPABASE_URL")}/functions/v1/karel-crisis-daily-assessment`,
        {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({}),
        }
      );
      const crisisData = await crisisResp.json();
      console.log("[Dashboard] Crisis assessments:", JSON.stringify(crisisData));
    } catch (e) {
      console.error("[Dashboard] Crisis assessment failed:", e);
    }

    // Build command snapshot for KarelDailyPlan command sections (best-effort, non-fatal)
    let commandSnapshot: any = null;
    try {
      commandSnapshot = await buildCommandSnapshot(supabase);
    } catch (e) {
      console.warn("[Dashboard] command snapshot build failed (non-fatal):", e);
    }

    return new Response(JSON.stringify({
      success: true,
      date: targetDate,
      trigger: triggerSource,
      dashboardLength: aiContent.length,
      appDataExtracted: !!appData,
      snapshot: commandSnapshot,
      summary: `Dashboard pro ${targetDate} vygenerován (${aiContent.length} znaků), ${appData?.todayTasks?.length || 0} úkolů vytvořeno, témata: ${topicSync.synced} synchronizována / ${topicSync.pending} čeká.`,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("[Dashboard] Error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Unknown error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
