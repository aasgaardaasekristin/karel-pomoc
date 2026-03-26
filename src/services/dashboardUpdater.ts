/**
 * Dashboard Updater — denní aktualizace 00_Aktualni_Dashboard na Google Drive.
 *
 * Karel KAŽDÝ DEN sestaví tento dokument ZNOVU od nuly.
 * Sbírá data z DB, volá AI pro analýzu, ukládá na Drive a aktualizuje app.
 */

import { supabase } from "@/integrations/supabase/client";

/* ================================================================
   TYPY
   ================================================================ */

interface AppDashboardData {
  systemOverview: string;
  criticalAlerts: string[];
  todayTasks: Array<{
    task: string;
    assignedTo: string;
    priority: string;
  }>;
}

interface DashboardResult {
  dashboardMarkdown: string;
  appData: AppDashboardData | null;
}

/* ================================================================
   SBĚR DAT
   ================================================================ */

/** Načte aktivní části za posledních 24h z did_threads */
async function fetchActiveParts24h(): Promise<string> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from("did_threads")
    .select("part_name, last_activity_at, thread_label, messages, sub_mode")
    .eq("sub_mode", "cast")
    .gte("last_activity_at", since)
    .order("last_activity_at", { ascending: false });

  if (error || !data?.length) {
    console.log("[Dashboard] Žádné aktivní části za 24h.");
    return "(žádná aktivita)";
  }

  return data
    .map((t) => {
      const msgs = Array.isArray(t.messages) ? t.messages : [];
      const userMsgs = msgs.filter((m: any) => m.role === "user").length;
      return `- **${t.part_name}** (${t.thread_label || "bez názvu"}): ${userMsgs} zpráv, posl. aktivita ${t.last_activity_at}`;
    })
    .join("\n");
}

/** Načte stav úkolů terapeutek */
async function fetchTasksData(): Promise<string> {
  const { data, error } = await supabase
    .from("did_therapist_tasks")
    .select("task, assigned_to, status, status_hanka, status_kata, due_date, priority, created_at, completed_at")
    .order("created_at", { ascending: false })
    .limit(50);

  if (error || !data?.length) {
    return "(žádné úkoly)";
  }

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
}

/** Načte porady za 24h */
async function fetchMeetingsData(): Promise<string> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from("did_meetings")
    .select("topic, status, hanka_joined_at, kata_joined_at, outcome_summary, created_at")
    .gte("created_at", since)
    .order("created_at", { ascending: false });

  if (error || !data?.length) {
    return "(žádné porady za 24h)";
  }

  return data
    .map((m) => {
      const hankaStatus = m.hanka_joined_at ? `Hanka: ✅ (${m.hanka_joined_at})` : "Hanka: ❌ nereagovala";
      const kataStatus = m.kata_joined_at ? `Káťa: ✅ (${m.kata_joined_at})` : "Káťa: ❌ nereagovala";
      return `- **${m.topic}** [${m.status}]: ${hankaStatus}, ${kataStatus}${m.outcome_summary ? ` → ${m.outcome_summary}` : ""}`;
    })
    .join("\n");
}

/** Načte operativní plán (did_daily_session_plans) */
async function fetchOperativePlan(): Promise<string> {
  const today = new Date().toISOString().slice(0, 10);

  const { data, error } = await supabase
    .from("did_daily_session_plans")
    .select("selected_part, therapist, session_format, urgency_score, status, plan_markdown")
    .gte("plan_date", today)
    .order("urgency_score", { ascending: false })
    .limit(20);

  if (error || !data?.length) {
    return "(žádné plánované sezení)";
  }

  return data
    .map((p) => `- **${p.selected_part}** [${p.therapist}, urgence: ${p.urgency_score}]: ${p.session_format}, status: ${p.status}`)
    .join("\n");
}

/** Informace o kartách aktualizovaných v posledních 24h */
async function fetchUpdatedCardsInfo(): Promise<string> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from("card_update_queue")
    .select("part_id, section, action, new_content, reason, created_at")
    .gte("created_at", since)
    .eq("applied", true)
    .order("created_at", { ascending: false })
    .limit(100);

  if (error || !data?.length) {
    return "(žádné aktualizace karet)";
  }

  // Seskup podle part_id
  const byPart: Record<string, string[]> = {};
  for (const d of data) {
    if (!byPart[d.part_id]) byPart[d.part_id] = [];
    byPart[d.part_id].push(`Sekce ${d.section}: ${d.action} – ${(d.reason || d.new_content || "").slice(0, 80)}`);
  }

  return Object.entries(byPart)
    .map(([part, changes]) => `### ${part}\n${changes.map(c => `- ${c}`).join("\n")}`)
    .join("\n\n");
}

/* ================================================================
   ULOŽENÍ NA DRIVE
   ================================================================ */

async function saveDashboardToDrive(markdown: string): Promise<void> {
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
   AKTUALIZACE APP
   ================================================================ */

async function applyAppUpdates(appData: AppDashboardData): Promise<void> {
  try {
    // Aktualizuj system profile s novým overview
    if (appData.systemOverview) {
      const { error } = await supabase
        .from("did_system_profile")
        .update({
          karel_master_analysis: appData.systemOverview,
          updated_at: new Date().toISOString(),
        })
        .not("id", "is", null); // update all rows for current user (RLS filtered)

      if (error) {
        console.warn("[Dashboard] Failed to update system overview:", error);
      }
    }

    // Vytvoř nové úkoly z dashboardu
    if (appData.todayTasks?.length) {
      const tasksToInsert = appData.todayTasks
        .filter((t) => t.task && t.assignedTo)
        .map((t) => ({
          task: t.task,
          assigned_to: normalizeAssignee(t.assignedTo),
          priority: t.priority || "medium",
          status: "pending",
          task_tier: "daily",
          category: "dashboard",
        }));

      if (tasksToInsert.length) {
        const { error } = await supabase
          .from("did_therapist_tasks")
          .insert(tasksToInsert);

        if (error) {
          console.warn("[Dashboard] Failed to insert tasks:", error);
        } else {
          console.log(`[Dashboard] Vytvořeno ${tasksToInsert.length} nových úkolů.`);
        }
      }
    }

    console.log("[Dashboard] App updates applied.");
  } catch (err) {
    console.error("[Dashboard] App update exception:", err);
  }
}

function normalizeAssignee(raw: string): string {
  const lower = (raw || "").toLowerCase();
  if (lower.includes("both") || lower.includes("tandem")) return "both";
  if (lower.includes("kata") || lower.includes("káťa")) return "kata";
  if (lower.includes("karel")) return "karel";
  return "hanka";
}

/* ================================================================
   HLAVNÍ FUNKCE
   ================================================================ */

/**
 * Sestaví denní dashboard od nuly, uloží na Drive a aktualizuje aplikaci.
 */
export async function updateDailyDashboard(date: string): Promise<void> {
  console.log(`[Dashboard] ═══ Spouštím denní dashboard pro ${date} ═══`);

  // 1. SBĚR DAT (paralelně)
  console.log("[Dashboard] Krok 1: Sběr dat...");
  const [activePartsData, tasksData, meetingsData, operativePlan, updatedCardsInfo] = await Promise.all([
    fetchActiveParts24h(),
    fetchTasksData(),
    fetchMeetingsData(),
    fetchOperativePlan(),
    fetchUpdatedCardsInfo(),
  ]);

  console.log("[Dashboard] Data sebrána. Volám AI pro generování dashboardu...");

  // 2. VOLÁNÍ AI (edge function)
  try {
    const { data, error } = await supabase.functions.invoke("karel-daily-dashboard", {
      body: {
        date,
        activePartsData,
        tasksData,
        meetingsData,
        operativePlan,
        updatedCardsInfo,
      },
    });

    if (error) {
      console.error("[Dashboard] AI generování selhalo:", error);
      return;
    }

    const result = data as DashboardResult;

    if (!result?.dashboardMarkdown) {
      console.error("[Dashboard] AI nevrátila markdown.");
      return;
    }

    console.log(`[Dashboard] Dashboard vygenerován (${result.dashboardMarkdown.length} znaků).`);

    // 3. ULOŽENÍ NA DRIVE
    console.log("[Dashboard] Krok 3: Ukládám na Drive...");
    await saveDashboardToDrive(result.dashboardMarkdown);

    // 4. AKTUALIZACE APP
    if (result.appData) {
      console.log("[Dashboard] Krok 4: Aktualizuji aplikaci...");
      await applyAppUpdates(result.appData);
    }

    console.log(`[Dashboard] ═══ Dashboard pro ${date} dokončen ═══`);
  } catch (err) {
    console.error("[Dashboard] Neočekávaná chyba:", err);
  }
}
