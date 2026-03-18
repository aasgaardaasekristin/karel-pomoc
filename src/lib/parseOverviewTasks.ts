import { supabase } from "@/integrations/supabase/client";

interface ParsedTask {
  task: string;
  assigned_to: "hanka" | "kata" | "both";
  category: "today" | "tomorrow" | "longterm";
  note: string;
}

/**
 * Parse daily/weekly tasks from Karel's overview markdown text.
 * Daily tasks → today/tomorrow categories
 * Weekly tasks → longterm category (passive list)
 */
export function parseTasksFromOverview(text: string): ParsedTask[] {
  const tasks: ParsedTask[] = [];
  if (!text) return tasks;

  // --- DAILY TASKS (DNES/ZÍTRA) ---
  const dailyMatch = text.match(/#{0,3}\s*📋?\s*Úkoly pro DNES a ZÍTRA([\s\S]*?)(?=#{1,3}\s*📋?\s*Úkoly pro tento týden|$)/i);
  if (dailyMatch) {
    const dailyBlock = dailyMatch[1];

    const hankaToday = extractSection(dailyBlock, /Hanička\s*[–—-]\s*DNES\s*:/i, /(?:Hanička\s*[–—-]\s*ZÍTRA|Káťa\s*[–—-]\s*DNES|Společné)/i);
    const hankaTomorrow = extractSection(dailyBlock, /Hanička\s*[–—-]\s*ZÍTRA\s*:/i, /(?:Káťa\s*[–—-]\s*DNES|Společné)/i);
    const kataToday = extractSection(dailyBlock, /Káťa\s*[–—-]\s*DNES\s*:/i, /(?:Káťa\s*[–—-]\s*ZÍTRA|Společné)/i);
    const kataTomorrow = extractSection(dailyBlock, /Káťa\s*[–—-]\s*ZÍTRA\s*:/i, /(?:Společné|Hanička|$)/i);
    const shared = extractSection(dailyBlock, /Společné\s*[–—-]?\s*(?:DNES)?\s*:/i, /(?:Hanička|Káťa|$)/i);

    tasks.push(...extractTaskLines(hankaToday, "hanka", "today"));
    tasks.push(...extractTaskLines(hankaTomorrow, "hanka", "tomorrow"));
    tasks.push(...extractTaskLines(kataToday, "kata", "today"));
    tasks.push(...extractTaskLines(kataTomorrow, "kata", "tomorrow"));
    tasks.push(...extractTaskLines(shared, "both", "today"));
  }

  // --- WEEKLY TASKS → longterm (passive list only) ---
  const weeklyMatch = text.match(/#{0,3}\s*📋?\s*Úkoly pro tento týden([\s\S]*?)$/i);
  if (weeklyMatch) {
    const weeklyBlock = weeklyMatch[1];

    const hankaWeekly = extractSection(weeklyBlock, /Hanička\s*:/i, /(?:Káťa\s*:|Společné)/i);
    const kataWeekly = extractSection(weeklyBlock, /Káťa\s*:/i, /(?:Společné|Hanička|$)/i);
    const sharedWeekly = extractSection(weeklyBlock, /Společné\s*:/i, /(?:Hanička|Káťa|$)/i);

    tasks.push(...extractTaskLines(hankaWeekly, "hanka", "longterm"));
    tasks.push(...extractTaskLines(kataWeekly, "kata", "longterm"));
    tasks.push(...extractTaskLines(sharedWeekly, "both", "longterm"));
  }

  // --- FALLBACK: parse action bullets from "Dnes doporučuji" if structured sections are missing ---
  if (tasks.length === 0) {
    tasks.push(...extractRecommendationTasks(text));
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

/**
 * Truncate a raw title to a short actionable label (~60 chars max).
 * Splits at common Czech explanation markers and returns [shortTitle, overflow].
 */
function truncateTitle(raw: string): [string, string] {
  // Split at explanation markers
  const splitRe = /\s*(?:Proč:|Důvod:|Poznámka:|Oba si|Pokus se|Je to|Má to|Tento|Jedná se)\b/i;
  const splitMatch = raw.match(splitRe);
  let title = splitMatch ? raw.slice(0, splitMatch.index!).trim() : raw.trim();
  let overflow = splitMatch ? raw.slice(splitMatch.index!).trim() : "";

  // Hard cap at 80 chars, break at last space
  if (title.length > 80) {
    const cut = title.lastIndexOf(" ", 80);
    overflow = title.slice(cut > 30 ? cut : 80).trim() + (overflow ? " " + overflow : "");
    title = title.slice(0, cut > 30 ? cut : 80).trim();
  }

  // Strip trailing colon/dash
  title = title.replace(/[:\-–—]\s*$/, "").trim();

  return [title, overflow];
}

function extractTaskLines(section: string, assignee: "hanka" | "kata" | "both", category: "today" | "tomorrow" | "longterm"): ParsedTask[] {
  if (!section.trim()) return [];
  const tasks: ParsedTask[] = [];
  const lines = section.split(/\n/);
  let currentTitle = "";
  let currentNote = "";

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const boldMatch = trimmed.match(/^\*\*(.+?)\*\*\s*:?\s*(.*)/);
    const plainMatch = !boldMatch ? trimmed.match(/^([A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ][^:]{3,50}):\s*(.+)/i) : null;

    if (boldMatch || plainMatch) {
      if (currentTitle) {
        const [shortTitle, overflow] = truncateTitle(currentTitle);
        const fullNote = (overflow + " " + currentNote).trim();
        tasks.push({ task: shortTitle, assigned_to: assignee, category, note: fullNote });
      }
      const match = boldMatch || plainMatch!;
      currentTitle = match[1].trim();
      currentNote = match[2] || "";
    } else if (currentTitle) {
      currentNote += " " + trimmed;
    } else {
      if (trimmed.length > 10) {
        const [shortTitle, overflow] = truncateTitle(trimmed);
        tasks.push({ task: shortTitle, assigned_to: assignee, category, note: overflow });
      }
    }
  }

  if (currentTitle) {
    const [shortTitle, overflow] = truncateTitle(currentTitle);
    const fullNote = (overflow + " " + currentNote).trim();
    tasks.push({ task: shortTitle, assigned_to: assignee, category, note: fullNote });
  }

  return tasks;
}

/**
 * Normalize task text for dedup comparison (lowercase, strip whitespace/punctuation)
 */
function normalizeTask(text: string): string {
  return text.toLowerCase().replace(/[^\w\sáčďéěíňóřšťúůýž]/gi, "").replace(/\s+/g, " ").trim();
}

/**
 * Insert parsed tasks into did_therapist_tasks, with hash-based dedup.
 * Checks ALL existing active tasks (not just today's) to prevent duplicates.
 */
export async function syncOverviewTasksToBoard(overviewText: string): Promise<number> {
  const parsed = parseTasksFromOverview(overviewText);
  if (parsed.length === 0) return 0;

  // Check ALL existing non-done tasks for dedup
  const { data: existing } = await supabase
    .from("did_therapist_tasks")
    .select("task, assigned_to, category")
    .neq("status", "done");

  const existingSet = new Set(
    (existing || []).map(e => `${normalizeTask(e.task)}|${e.assigned_to}`)
  );

  const toInsert = parsed.filter(t => {
    const key = `${normalizeTask(t.task)}|${t.assigned_to}`;
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
    priority: t.category === "today" ? "high" : t.category === "tomorrow" ? "normal" : "low",
  }));

  const { error } = await supabase.from("did_therapist_tasks").insert(rows);
  if (error) {
    console.error("Failed to sync overview tasks:", error);
    return 0;
  }

  return toInsert.length;
}
