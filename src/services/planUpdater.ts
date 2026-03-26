/**
 * Plan Updater — aktualizace složky 05_PLAN na Google Drive.
 *
 * Dvě podsložky:
 * 1. operativni_plan — krátkodobý (do 14 dnů)
 * 2. strategie — týdenní a měsíční přehledy
 */

import { supabase } from "@/integrations/supabase/client";
import type { OperativePlanEntry } from "@/services/cardUpdaters/sectionDUpdater";

/* ================================================================
   TYPY
   ================================================================ */

interface OperativePlanRecord {
  createdAt: string;
  partId: string;
  partName: string;
  activity: string;
  therapist: string;
  urgency: string;
  status: "novy" | "probiha" | "splnen";
  reason: string;
  note: string;
}

const URGENCY_ORDER: Record<string, number> = {
  dnes: 0,
  zitra: 1,
  tento_tyden: 2,
  do_14_dni: 3,
};

/* ================================================================
   DRIVE HELPERS
   ================================================================ */

async function readDriveDocument(docName: string): Promise<string> {
  try {
    const { data, error } = await supabase.functions.invoke("karel-did-drive-read", {
      body: { documentName: docName },
    });
    if (error) {
      console.warn(`[PlanUpdater] Drive read error for "${docName}":`, error);
      return "";
    }
    return data?.content ?? "";
  } catch (err) {
    console.warn(`[PlanUpdater] Drive read exception for "${docName}":`, err);
    return "";
  }
}

async function writeDriveDocument(docName: string, content: string, writeType = "plan_update"): Promise<void> {
  try {
    const { error } = await supabase.functions.invoke("karel-did-drive-write", {
      body: { partId: docName, content, writeType },
    });
    if (error) {
      console.error(`[PlanUpdater] Drive write error for "${docName}":`, error);
      throw error;
    }
    console.log(`[PlanUpdater] Uloženo "${docName}" na Drive`);
  } catch (err) {
    console.error(`[PlanUpdater] Drive write exception for "${docName}":`, err);
    throw err;
  }
}

/* ================================================================
   OPERATIVNÍ PLÁN — parsování a serializace
   ================================================================ */

function parseOperativePlan(raw: string): OperativePlanRecord[] {
  if (!raw.trim()) return [];

  const records: OperativePlanRecord[] = [];
  const blocks = raw.split(/\n---\n|\n\n/).filter((b) => b.trim());

  for (const block of blocks) {
    const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
    const record: Partial<OperativePlanRecord> = { status: "novy", note: "" };

    for (const line of lines) {
      const kv = line.match(/^-?\s*\*?\*?(.+?)\*?\*?:\s*(.+)$/);
      if (!kv) continue;
      const [, key, val] = kv;
      const k = key.trim().toLowerCase();

      if (k.includes("datum") || k.includes("vytvořen")) record.createdAt = val.trim();
      else if (k.includes("část") || k.includes("part")) {
        const parts = val.split(/[(/]/);
        record.partName = parts[0]?.trim() || val.trim();
        if (parts[1]) record.partId = parts[1].replace(/[)]/g, "").trim();
      }
      else if (k.includes("aktivita") || k.includes("sezení")) record.activity = val.trim();
      else if (k.includes("terapeut")) record.therapist = val.trim();
      else if (k.includes("urgenc") || k.includes("naléhavost")) record.urgency = val.trim();
      else if (k.includes("stav") || k.includes("status")) {
        const s = val.trim().toLowerCase();
        if (s.includes("splněn") || s.includes("done")) record.status = "splnen";
        else if (s.includes("probíh") || s.includes("progress")) record.status = "probiha";
        else record.status = "novy";
      }
      else if (k.includes("poznámka") || k.includes("note")) record.note = val.trim();
      else if (k.includes("důvod") || k.includes("reason")) record.reason = val.trim();
    }

    if (record.activity && record.createdAt) {
      records.push(record as OperativePlanRecord);
    }
  }

  return records;
}

function serializeOperativePlan(records: OperativePlanRecord[]): string {
  if (!records.length) return "# Operativní plán\n\n(žádné záznamy)";

  const lines = ["# Operativní plán\n"];

  for (const r of records) {
    lines.push(
      `- **Datum vytvoření:** ${r.createdAt}`,
      `- **Část:** ${r.partName}${r.partId ? ` (${r.partId})` : ""}`,
      `- **Aktivita:** ${r.activity}`,
      `- **Doporučený terapeut:** ${r.therapist}`,
      `- **Urgence:** ${r.urgency}`,
      `- **Stav:** ${r.status === "splnen" ? "✅ splněn" : r.status === "probiha" ? "🔄 probíhá" : "🆕 nový"}`,
      r.reason ? `- **Důvod:** ${r.reason}` : "",
      r.note ? `- **Poznámka:** ${r.note}` : "",
      "\n---\n",
    );
  }

  return lines.filter(Boolean).join("\n");
}

function normalizeUrgencyKey(raw: string): string {
  const lower = (raw || "").toLowerCase().replace(/\s+/g, "_");
  if (lower.includes("dnes")) return "dnes";
  if (lower.includes("zítra") || lower.includes("zitra")) return "zitra";
  if (lower.includes("týden") || lower.includes("tyden")) return "tento_tyden";
  return "do_14_dni";
}

/* ================================================================
   OPERATIVNÍ PLÁN — hlavní funkce
   ================================================================ */

/**
 * Aktualizuje operativní plán v 05_PLAN/operativni_plan na Drive.
 *
 * 1. Načti aktuální plán
 * 2. Odstraň záznamy starší 14 dnů
 * 3. Odstraň splněné záznamy
 * 4. Přidej nové z operativePlanEntries
 * 5. Seřaď podle urgence
 * 6. Ulož zpět
 */
export async function updateOperativePlan(
  operativePlanEntries: OperativePlanEntry[],
  date: string,
): Promise<void> {
  console.log(`[PlanUpdater] Aktualizace operativního plánu: ${operativePlanEntries.length} nových entries`);

  // 1. Načti aktuální plán
  const rawPlan = await readDriveDocument("05_Operativni_Plan");
  let records = parseOperativePlan(rawPlan);

  console.log(`[PlanUpdater] Existující záznamy: ${records.length}`);

  // 2. Odstraň záznamy starší 14 dnů
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 14);
  const before = records.length;
  records = records.filter((r) => {
    try {
      return new Date(r.createdAt) >= cutoff;
    } catch {
      return true; // pokud datum nelze parsovat, ponecháme
    }
  });
  if (records.length < before) {
    console.log(`[PlanUpdater] Odstraněno ${before - records.length} záznamů starších 14 dnů`);
  }

  // 3. Odstraň splněné záznamy
  const beforeCompleted = records.length;
  records = records.filter((r) => r.status !== "splnen");
  if (records.length < beforeCompleted) {
    console.log(`[PlanUpdater] Odstraněno ${beforeCompleted - records.length} splněných záznamů`);
  }

  // 3b. Zkontroluj splněné úkoly v DB a označ odpovídající záznamy
  try {
    const { data: completedTasks } = await supabase
      .from("did_therapist_tasks")
      .select("task, completed_at, assigned_to")
      .eq("status", "done")
      .not("completed_at", "is", null)
      .order("completed_at", { ascending: false })
      .limit(50);

    if (completedTasks?.length) {
      records = records.filter((r) => {
        const match = completedTasks.find(
          (t) => r.activity.toLowerCase().includes(t.task.toLowerCase().slice(0, 20)),
        );
        if (match) {
          console.log(`[PlanUpdater] Záznam splněn dle DB: "${r.activity.slice(0, 40)}…"`);
          return false;
        }
        return true;
      });
    }
  } catch (err) {
    console.warn("[PlanUpdater] Chyba při kontrole splněných úkolů:", err);
  }

  // 4. Přidej nové záznamy
  for (const entry of operativePlanEntries) {
    // Deduplikace — nepřidávej pokud už existuje stejná aktivita pro stejnou část
    const isDuplicate = records.some(
      (r) =>
        r.partId === entry.partId &&
        r.activity.toLowerCase().includes(entry.activity.toLowerCase().slice(0, 25)),
    );
    if (isDuplicate) {
      console.log(`[PlanUpdater] Přeskočen duplikát: "${entry.activity.slice(0, 40)}…"`);
      continue;
    }

    records.push({
      createdAt: entry.sourceDate || date,
      partId: entry.partId,
      partName: entry.partName,
      activity: entry.activity,
      therapist: entry.therapist,
      urgency: entry.urgency,
      status: "novy",
      reason: entry.reason,
      note: "",
    });
  }

  // 5. Seřaď podle urgence
  records.sort((a, b) => {
    const ua = URGENCY_ORDER[normalizeUrgencyKey(a.urgency)] ?? 99;
    const ub = URGENCY_ORDER[normalizeUrgencyKey(b.urgency)] ?? 99;
    return ua - ub;
  });

  // 6. Ulož zpět na Drive
  const serialized = serializeOperativePlan(records);
  await writeDriveDocument("05_Operativni_Plan", serialized, "plan_update");

  console.log(`[PlanUpdater] Operativní plán uložen: ${records.length} záznamů`);
}

/* ================================================================
   STRATEGIE — sběr dat
   ================================================================ */

async function fetchWeeklyData(since: string): Promise<string> {
  const sections: string[] = [];

  // Aktualizované karty (card_update_queue)
  const { data: cardUpdates } = await supabase
    .from("card_update_queue")
    .select("part_id, section, action, new_content, created_at, reason")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(100);

  if (cardUpdates?.length) {
    const partSections = new Map<string, string[]>();
    for (const cu of cardUpdates) {
      const key = cu.part_id;
      if (!partSections.has(key)) partSections.set(key, []);
      partSections.get(key)!.push(`  - Sekce ${cu.section}: ${cu.action} (${cu.reason?.slice(0, 60) || "?"})`);
    }
    const lines = Array.from(partSections.entries())
      .map(([part, changes]) => `**${part}** (${changes.length} změn):\n${changes.slice(0, 5).join("\n")}`)
      .join("\n\n");
    sections.push(`## Aktualizace karet\n${lines}`);
  }

  // Úkoly
  const { data: tasks } = await supabase
    .from("did_therapist_tasks")
    .select("task, assigned_to, status, status_hanka, status_kata, completed_at, created_at, priority")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(80);

  if (tasks?.length) {
    const done = tasks.filter((t) => t.status === "done").length;
    const pending = tasks.filter((t) => t.status !== "done").length;
    const byAssignee = new Map<string, number>();
    for (const t of tasks) {
      byAssignee.set(t.assigned_to, (byAssignee.get(t.assigned_to) || 0) + 1);
    }
    const assigneeLines = Array.from(byAssignee.entries())
      .map(([who, count]) => `- ${who}: ${count} úkolů`)
      .join("\n");
    sections.push(
      `## Úkoly\n- Splněno: ${done}\n- Probíhá/nesplněno: ${pending}\n\n### Podle terapeutů:\n${assigneeLines}`,
    );
  }

  // Sezení
  const { data: sessions } = await supabase
    .from("did_part_sessions")
    .select("part_name, therapist, session_type, methods_used, ai_analysis, session_date")
    .gte("session_date", since.slice(0, 10))
    .order("session_date", { ascending: false })
    .limit(30);

  if (sessions?.length) {
    const methodSet = new Set<string>();
    for (const s of sessions) {
      if (s.methods_used) {
        for (const m of s.methods_used) methodSet.add(m);
      }
    }
    sections.push(
      `## Sezení (${sessions.length})\n` +
      sessions.map((s) => `- ${s.part_name} (${s.therapist}, ${s.session_type}): ${s.ai_analysis?.slice(0, 80) || "bez analýzy"}`).join("\n") +
      (methodSet.size ? `\n\n### Použité metody:\n${Array.from(methodSet).map((m) => `- ${m}`).join("\n")}` : ""),
    );
  }

  // Aktivita vláken
  const { data: threads } = await supabase
    .from("did_threads")
    .select("part_name, thread_label, last_activity_at, messages")
    .eq("sub_mode", "cast")
    .gte("last_activity_at", since)
    .order("last_activity_at", { ascending: false })
    .limit(30);

  if (threads?.length) {
    sections.push(
      `## Aktivita ve vláknech (${threads.length})\n` +
      threads.map((t) => {
        const msgs = Array.isArray(t.messages) ? t.messages.length : 0;
        return `- ${t.part_name} / "${t.thread_label || "bez názvu"}" — ${msgs} zpráv`;
      }).join("\n"),
    );
  }

  return sections.join("\n\n") || "(nedostatek dat pro analýzu)";
}

/* ================================================================
   STRATEGIE — AI analýza
   ================================================================ */

async function callStrategyAI(
  data: string,
  period: "tydenni" | "mesicni",
  date: string,
): Promise<string> {
  try {
    const { data: result, error } = await supabase.functions.invoke("karel-plan-strategy", {
      body: { data, period, date },
    });

    if (error) {
      console.error(`[PlanUpdater] Strategy AI error:`, error);
      return `⚠️ AI analýza selhala pro ${period} strategii (${date}). Důvod: ${error}`;
    }

    return result?.strategy || `⚠️ AI nevrátila strategii pro období ${period} (${date}).`;
  } catch (err) {
    console.error(`[PlanUpdater] Strategy AI exception:`, err);
    return `⚠️ AI analýza selhala (${err})`;
  }
}

/* ================================================================
   STRATEGIE — hlavní funkce
   ================================================================ */

/**
 * Generuje strategický dokument — týdenní (každé pondělí) nebo měsíční (1. den).
 */
export async function updateStrategy(date: string): Promise<void> {
  const d = new Date(date);
  const dayOfWeek = d.getDay(); // 0=Sun, 1=Mon
  const dayOfMonth = d.getDate();

  const isWeekly = dayOfWeek === 1; // pondělí
  const isMonthly = dayOfMonth === 1;

  if (!isWeekly && !isMonthly) {
    console.log("[PlanUpdater] Dnes se strategie negeneruje (není pondělí ani 1. den měsíce).");
    return;
  }

  if (isMonthly) {
    console.log(`[PlanUpdater] Generuji MĚSÍČNÍ strategii pro ${date}…`);
    const since = new Date(d);
    since.setMonth(since.getMonth() - 1);
    const data = await fetchWeeklyData(since.toISOString());
    const strategy = await callStrategyAI(data, "mesicni", date);
    const docName = `strategie_mesic_${date.slice(0, 10)}`;
    await writeDriveDocument(docName, strategy, "strategy_monthly");
    console.log(`[PlanUpdater] Měsíční strategie uložena: ${docName}`);
  }

  if (isWeekly) {
    console.log(`[PlanUpdater] Generuji TÝDENNÍ strategii pro ${date}…`);
    const since = new Date(d);
    since.setDate(since.getDate() - 7);
    const data = await fetchWeeklyData(since.toISOString());
    const strategy = await callStrategyAI(data, "tydenni", date);
    const docName = `strategie_tyden_${date.slice(0, 10)}`;
    await writeDriveDocument(docName, strategy, "strategy_weekly");
    console.log(`[PlanUpdater] Týdenní strategie uložena: ${docName}`);
  }
}
