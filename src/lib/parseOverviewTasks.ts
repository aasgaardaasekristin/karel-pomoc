import { supabase } from "@/integrations/supabase/client";

interface ParsedTask {
  task: string;
  assigned_to: "hanka" | "kata" | "both";
  category: "daily" | "weekly";
  note: string;
}

/**
 * Parse daily/weekly tasks from Karel's overview markdown text.
 * Expected format sections:
 *   "Hanička – DNES:" / "Hanička – ZÍTRA:" / "Káťa – DNES:" / "Káťa – ZÍTRA:" / "Společné"
 *   "Úkoly pro tento týden" with "Hanička:" / "Káťa:" / "Společné:"
 */
export function parseTasksFromOverview(text: string): ParsedTask[] {
  const tasks: ParsedTask[] = [];
  if (!text) return tasks;

  // --- DAILY TASKS ---
  // Find the daily tasks section
  const dailyMatch = text.match(/#{0,3}\s*📋?\s*Úkoly pro DNES a ZÍTRA([\s\S]*?)(?=#{1,3}\s*📋?\s*Úkoly pro tento týden|$)/i);
  if (dailyMatch) {
    const dailyBlock = dailyMatch[1];
    
    // Split by therapist headers
    const hankaToday = extractSection(dailyBlock, /Hanička\s*[–—-]\s*DNES\s*:/i, /(?:Hanička\s*[–—-]\s*ZÍTRA|Káťa\s*[–—-]\s*DNES|Společné)/i);
    const hankaTomorrow = extractSection(dailyBlock, /Hanička\s*[–—-]\s*ZÍTRA\s*:/i, /(?:Káťa\s*[–—-]\s*DNES|Společné)/i);
    const kataToday = extractSection(dailyBlock, /Káťa\s*[–—-]\s*DNES\s*:/i, /(?:Káťa\s*[–—-]\s*ZÍTRA|Společné)/i);
    const kataTomorrow = extractSection(dailyBlock, /Káťa\s*[–—-]\s*ZÍTRA\s*:/i, /(?:Společné|Hanička|$)/i);
    const shared = extractSection(dailyBlock, /Společné\s*[–—-]?\s*(?:DNES)?\s*:/i, /(?:Hanička|Káťa|$)/i);

    tasks.push(...extractTaskLines(hankaToday, "hanka", "daily", "DNES"));
    tasks.push(...extractTaskLines(hankaTomorrow, "hanka", "daily", "ZÍTRA"));
    tasks.push(...extractTaskLines(kataToday, "kata", "daily", "DNES"));
    tasks.push(...extractTaskLines(kataTomorrow, "kata", "daily", "ZÍTRA"));
    tasks.push(...extractTaskLines(shared, "both", "daily", "DNES"));
  }

  // --- WEEKLY TASKS ---
  const weeklyMatch = text.match(/#{0,3}\s*📋?\s*Úkoly pro tento týden([\s\S]*?)$/i);
  if (weeklyMatch) {
    const weeklyBlock = weeklyMatch[1];
    
    const hankaWeekly = extractSection(weeklyBlock, /Hanička\s*:/i, /(?:Káťa\s*:|Společné)/i);
    const kataWeekly = extractSection(weeklyBlock, /Káťa\s*:/i, /(?:Společné|Hanička|$)/i);
    const sharedWeekly = extractSection(weeklyBlock, /Společné\s*:/i, /(?:Hanička|Káťa|$)/i);

    tasks.push(...extractTaskLines(hankaWeekly, "hanka", "weekly"));
    tasks.push(...extractTaskLines(kataWeekly, "kata", "weekly"));
    tasks.push(...extractTaskLines(sharedWeekly, "both", "weekly"));
  }

  return tasks;
}

function extractSection(block: string, startRe: RegExp, endRe: RegExp): string {
  const startMatch = block.match(startRe);
  if (!startMatch) return "";
  
  const startIdx = startMatch.index! + startMatch[0].length;
  const rest = block.slice(startIdx);
  const endMatch = rest.match(endRe);
  const endIdx = endMatch ? endMatch.index! : rest.length;
  
  return rest.slice(0, endIdx).trim();
}

function extractTaskLines(
  section: string,
  assignee: "hanka" | "kata" | "both",
  category: "daily" | "weekly",
  timeLabel?: string
): ParsedTask[] {
  if (!section.trim()) return [];
  
  const tasks: ParsedTask[] = [];
  
  // Split by bold task titles: **Title:** or just lines starting with bold
  // Pattern: lines that start with a bold word/phrase followed by ":"
  const lines = section.split(/\n/);
  let currentTitle = "";
  let currentNote = "";
  
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    
    // Check for bold task title: **Something:** or **Something**:
    const boldMatch = trimmed.match(/^\*\*(.+?)\*\*\s*:?\s*(.*)/);
    // Or non-bold but clear task line starting with a capitalized word followed by ":"
    const plainMatch = !boldMatch ? trimmed.match(/^([A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ][^:]{3,50}):\s*(.+)/i) : null;
    
    if (boldMatch || plainMatch) {
      // Save previous task if exists
      if (currentTitle) {
        tasks.push({
          task: timeLabel ? `[${timeLabel}] ${currentTitle}` : currentTitle,
          assigned_to: assignee,
          category,
          note: currentNote.trim(),
        });
      }
      
      const match = boldMatch || plainMatch!;
      currentTitle = match[1].trim();
      currentNote = match[2] || "";
    } else if (currentTitle) {
      // Continuation of previous task's description
      currentNote += " " + trimmed;
    } else {
      // Standalone line without bold title - treat as a task
      if (trimmed.length > 10) {
        tasks.push({
          task: timeLabel ? `[${timeLabel}] ${trimmed.slice(0, 80)}` : trimmed.slice(0, 80),
          assigned_to: assignee,
          category,
          note: trimmed.length > 80 ? trimmed : "",
        });
      }
    }
  }
  
  // Don't forget the last task
  if (currentTitle) {
    tasks.push({
      task: timeLabel ? `[${timeLabel}] ${currentTitle}` : currentTitle,
      assigned_to: assignee,
      category,
      note: currentNote.trim(),
    });
  }
  
  return tasks;
}

/**
 * Insert parsed tasks into did_therapist_tasks, avoiding duplicates from today.
 * Returns number of tasks inserted.
 */
export async function syncOverviewTasksToBoard(overviewText: string): Promise<number> {
  const parsed = parseTasksFromOverview(overviewText);
  if (parsed.length === 0) return 0;

  // Get today's date for dedup
  const today = new Date().toISOString().slice(0, 10);

  // Check existing tasks created today to avoid duplicates
  const { data: existing } = await supabase
    .from("did_therapist_tasks")
    .select("task, assigned_to, category")
    .gte("created_at", `${today}T00:00:00`)
    .lte("created_at", `${today}T23:59:59`);

  const existingSet = new Set(
    (existing || []).map(e => `${e.task}|${e.assigned_to}|${e.category}`)
  );

  const toInsert = parsed.filter(t => {
    const key = `${t.task}|${t.assigned_to}|${t.category}`;
    return !existingSet.has(key);
  });

  if (toInsert.length === 0) return 0;

  const rows = toInsert.map(t => ({
    task: t.task,
    assigned_to: t.assigned_to,
    category: t.category,
    note: t.note || "",
    status: "pending",
    status_hanka: "not_started",
    status_kata: "not_started",
    source_agreement: "Karlův přehled",
    priority: t.category === "daily" ? "high" : "normal",
  }));

  const { error } = await supabase.from("did_therapist_tasks").insert(rows);
  if (error) {
    console.error("Failed to sync overview tasks:", error);
    return 0;
  }

  return toInsert.length;
}
