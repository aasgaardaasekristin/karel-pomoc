import { supabase } from "@/integrations/supabase/client";

interface ParsedTask {
  task: string;
  detail_instruction: string;
  assigned_to: "hanka" | "kata" | "both";
  category: "today" | "tomorrow" | "longterm";
  note: string;
}

// Cooldown: prevent re-sync within 60 seconds
let lastSyncTimestamp = 0;
const SYNC_COOLDOWN_MS = 60_000;

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
 * Truncate a raw title to a short actionable label (~80 chars max).
 * Returns [shortTitle, fullOriginalText] — the full text is preserved for detail_instruction.
 */
function truncateTitle(raw: string): [string, string] {
  const fullText = raw.trim().replace(/\s+/g, " ");
  let title = fullText
    .replace(/^(?:(?:miláčku|milacku)\s*,?\s*)?(?:haničko|hanička|hanka|káťo|káťa|kata|obě terapeutky|obě|společně|haničko a káťo|hanka a káťa|haničko i káťo)\s*[:–,—-]*\s*/i, "")
    .trim();

  // Strip "Proč:/Důvod:" prefix for the short title only
  const splitRe = /\s*(?:Proč:|Důvod:|Poznámka:)\b/i;
  const splitMatch = title.match(splitRe);
  if (splitMatch) {
    title = title.slice(0, splitMatch.index!).trim();
  }

  // Prefer a compact action label before explanatory clauses
  const clauseSplit = title.search(/(?:,\s*(?:aby|protože|a potom|a pak)|\s+-\s+|\s+→\s+|\.\s+)/i);
  if (clauseSplit > 24) {
    title = title.slice(0, clauseSplit).trim();
  }

  if (title.length > 68) {
    const sentenceEnd = Math.max(
      title.lastIndexOf(". ", 68),
      title.lastIndexOf(": ", 68),
      title.lastIndexOf(", ", 68),
    );
    const cut = sentenceEnd > 30 ? sentenceEnd + 1 : title.lastIndexOf(" ", 68);
    const cutPos = cut > 30 ? cut : 68;
    title = title.slice(0, cutPos).trim();
  }

  title = title.replace(/[:\-–—,]\s*$/, "").trim();
  return [title || fullText, fullText];
}

function buildDetailInstruction(params: {
  shortTitle: string;
  fullText: string;
  explicitInstruction?: string;
  note?: string;
  assignee: "hanka" | "kata" | "both";
  category: "today" | "tomorrow" | "longterm";
}): string {
  const { shortTitle, fullText, explicitInstruction = "", note = "", assignee, category } = params;
  const actionText = explicitInstruction.trim() || fullText.trim() || shortTitle.trim();
  const who = assignee === "hanka" ? "Hanka" : assignee === "kata" ? "Káťa" : "Hanka i Káťa";
  const when = category === "today" ? "Je potřeba to rozběhnout ještě dnes." : category === "tomorrow" ? "Připravte to na zítřek a ověřte další krok." : "Ber to jako dlouhodobější úkol a průběžně sleduj posun.";
  const uniqueNote = note.trim() && normalizeTask(note) !== normalizeTask(actionText) ? note.trim() : "";

  return [
    `Co udělat: ${actionText}`,
    `Pro koho: ${who}.`,
    `Zaměření: ${when}`,
    uniqueNote ? `Doplňující kontext: ${uniqueNote}` : `Další krok: Udělej první konkrétní krok a pak napiš krátký update, co se pohnulo a kde to vázne.`,
  ].join("\n");
}

function extractTaskLines(section: string, assignee: "hanka" | "kata" | "both", category: "today" | "tomorrow" | "longterm"): ParsedTask[] {
  if (!section.trim()) return [];
  const tasks: ParsedTask[] = [];
  const lines = section.split(/\n/);
  let currentTitle = "";
  let currentInstruction = "";
  let currentNote = "";

  const flushTask = () => {
    if (!currentTitle) return;
    const [shortTitle, fullOriginal] = truncateTitle(currentTitle);
    const detail = buildDetailInstruction({
      shortTitle,
      fullText: fullOriginal,
      explicitInstruction: currentInstruction,
      note: currentNote,
      assignee,
      category,
    });
    tasks.push({
      task: shortTitle,
      detail_instruction: detail,
      assigned_to: assignee,
      category,
      note: currentNote.trim(),
    });
    currentTitle = "";
    currentInstruction = "";
    currentNote = "";
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const instructionMatch = trimmed.match(/^Instrukce\s*:\s*(.+)/i);
    if (instructionMatch && currentTitle) {
      currentInstruction = instructionMatch[1].trim();
      continue;
    }

    const boldMatch = trimmed.match(/^\*\*(.+?)\*\*\s*:?\s*(.*)/);
    const plainMatch = !boldMatch ? trimmed.match(/^([A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ][^:]{3,50}):\s*(.+)/i) : null;

    if (boldMatch || plainMatch) {
      flushTask();
      const match = boldMatch || plainMatch!;
      currentTitle = match[1].trim();
      currentNote = match[2] || "";
    } else if (currentTitle) {
      if (currentInstruction) {
        currentInstruction += " " + trimmed;
      } else {
        currentNote += " " + trimmed;
      }
    } else if (trimmed.length > 10) {
      const [shortTitle, fullText] = truncateTitle(trimmed);
      tasks.push({
        task: shortTitle,
        detail_instruction: buildDetailInstruction({ shortTitle, fullText, assignee, category }),
        assigned_to: assignee,
        category,
        note: "",
      });
    }
  }

  flushTask();
  return tasks;
}

function extractRecommendationTasks(text: string): ParsedTask[] {
  const match = text.match(/Dnes doporučuji\s*:([\s\S]*?)(?:\n\s*📋\s*Úkoly pro|$)/i);
  if (!match) return [];

  const tasks: ParsedTask[] = [];
  const lines = match[1].split(/\n/).map((line) => line.trim()).filter(Boolean);

  let pendingTitle = "";
  let pendingAssignee: "hanka" | "kata" | "both" = "both";
  let pendingCategory: "today" | "tomorrow" | "longterm" = "today";

  const flushPending = (instruction: string) => {
    if (!pendingTitle) return;
    const [shortTitle, fullText] = truncateTitle(pendingTitle);
    const detail = instruction.trim() || fullText;
    if (shortTitle) {
      tasks.push({ task: shortTitle, detail_instruction: detail, assigned_to: pendingAssignee, category: pendingCategory, note: "" });
    }
    pendingTitle = "";
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Check for "Instrukce:" line following a bold title
    const instructionMatch = line.match(/^Instrukce\s*:\s*(.+)/i);
    if (instructionMatch && pendingTitle) {
      flushPending(instructionMatch[1].trim());
      continue;
    }

    // Bold title line
    const boldMatch = line.match(/^\*\*(.+?)\*\*\s*:?\s*(.*)/);
    if (boldMatch) {
      flushPending("");
      const raw = boldMatch[1].trim();
      pendingTitle = raw.replace(/^(?:Hanička|Hanka|Káťa|Kata|Obě terapeutky|Obě|Společně)\s*[:–-]\s*/i, "").trim();
      pendingAssignee = /\b(?:haničk|hanka)\b/i.test(raw) ? "hanka" : /\b(?:káť|kata)\b/i.test(raw) ? "kata" : "both";
      pendingCategory = /\b(?:zítra|zitra)\b/i.test(raw) ? "tomorrow" : /\b(?:tento týden|během týdne|do týdne|později)\b/i.test(raw) ? "longterm" : "today";
      continue;
    }

    // Bullet or plain line (old format fallback)
    const bulletMatch = line.match(/^(?:[-–•]|\d+[.)])\s+(.+)/);
    const raw = (bulletMatch ? bulletMatch[1] : line).trim();
    if (!raw || raw.length < 8) continue;

    flushPending("");

    const assignee = /\b(?:haničk|hanka)\b/i.test(raw) ? "hanka" : /\b(?:káť|kata)\b/i.test(raw) ? "kata" : "both";
    const category = /\b(?:zítra|zitra)\b/i.test(raw) ? "tomorrow" : /\b(?:tento týden|během týdne|do týdne|později)\b/i.test(raw) ? "longterm" : "today";
    const cleaned = raw.replace(/^(?:Hanička|Hanka|Káťa|Kata|Obě terapeutky|Obě|Společně)\s*[:–-]\s*/i, "").trim();
    const [shortTitle, fullText] = truncateTitle(cleaned);
    if (!shortTitle) continue;
    tasks.push({ task: shortTitle, detail_instruction: fullText, assigned_to: assignee, category, note: "" });
  }

  flushPending("");
  return tasks;
}


/**
 * Normalize task text for dedup comparison:
 * - lowercase, strip punctuation, strip filler words/salutations
 */
function normalizeTask(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\sáčďéěíňóřšťúůýž]/gi, "")
    // Strip salutations and filler
    .replace(/\b(haničko|hanka|káťo|kata|prosím|miláčku|milá|obě|společně|bezodkladně|co\s+nejdříve|zkus|prosím|proveďte|proveď|začni|aktivněji)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extract core action words (3+ chars, skip stopwords) for semantic comparison
 */
function extractCoreWords(text: string): Set<string> {
  const stopwords = new Set(["pro", "jako", "kde", "jak", "aby", "při", "což", "ten", "tato", "tyto", "jeho", "její", "jsou", "být", "mít", "dnes", "zítra", "úkol", "úkoly"]);
  return new Set(
    normalizeTask(text).split(" ").filter(w => w.length > 2 && !stopwords.has(w))
  );
}

/**
 * Fuzzy similarity: Jaccard + containment for short phrases
 */
function wordSimilarity(a: string, b: string): number {
  const wordsA = extractCoreWords(a);
  const wordsB = extractCoreWords(b);
  if (wordsA.size === 0 && wordsB.size === 0) return 1;
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let intersection = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) intersection++;
  }
  const jaccard = intersection / (wordsA.size + wordsB.size - intersection);
  // Also check containment (smaller set fully in larger set)
  const containment = intersection / Math.min(wordsA.size, wordsB.size);
  return Math.max(jaccard, containment * 0.85);
}

/**
 * Insert parsed tasks into did_therapist_tasks, with fuzzy dedup and cooldown.
 */
export async function syncOverviewTasksToBoard(overviewText: string): Promise<number> {
  // Cooldown check
  const now = Date.now();
  if (now - lastSyncTimestamp < SYNC_COOLDOWN_MS) {
    console.log("[task-sync] Cooldown active, skipping sync");
    return 0;
  }
  lastSyncTimestamp = now;

  const parsed = parseTasksFromOverview(overviewText);
  if (parsed.length === 0) return 0;

  // Check ALL existing non-done tasks for dedup
  const { data: existing } = await supabase
    .from("did_therapist_tasks")
    .select("task, assigned_to, category")
    .neq("status", "done");

  const existingTasks = (existing || []).map(e => ({
    normalized: normalizeTask(e.task),
    assigned_to: e.assigned_to,
    raw: e.task,
  }));

  const toInsert = parsed.filter(t => {
    const normNew = normalizeTask(t.task);
    // Check exact match OR fuzzy similarity > 0.6
    return !existingTasks.some(e =>
      e.assigned_to === t.assigned_to && (
        e.normalized === normNew ||
        wordSimilarity(e.raw, t.task) > 0.6
      )
    );
  });

  if (toInsert.length === 0) return 0;

  const rows = toInsert.map(t => ({
    task: t.task,
    detail_instruction: t.detail_instruction || "",
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
