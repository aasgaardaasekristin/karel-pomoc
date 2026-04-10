import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getAccessToken, resolveKartotekaRoot, findFolder, findFileByName, readFileContent, overwriteDoc, GDOC_MIME } from "../_shared/driveHelpers.ts";
import { SYSTEM_RULES } from "../_shared/system-rules.ts";

// ═══════════════════════════════════════════════════════════════
// KAREL ANALYST LOOP — v1
// Běží 2× denně (7:00 + 15:00 SEČ).
//
// v1 scope:
// - Sběr dat z DB (vlákna, porady, krize, registr, úkoly)
// - Read-only načtení 2 Drive dokumentů (dashboard, operativní plán)
// - Jedno AI volání (Gemini 2.5 Flash)
// - Parsování [TASK:...] bloků
// - INSERT nových úkolů do did_therapist_tasks s deduplikací
// - INSERT/UPDATE did_update_cycles
// - INSERT system_health_log
//
// v1 NEZAPISUJE do Drive.
// v1 NEVOLÁ další edge functions.
// v1 NEMĚNÍ did_threads.is_processed.
// ═══════════════════════════════════════════════════════════════

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ── Konstanty ──────────────────────────────────────────────────
const AI_URL = "https://ai.gateway.lovable.dev/v1/chat/completions";
const AI_MODEL = "google/gemini-2.5-flash";
const AI_TIMEOUT_MS = 150_000;
const AI_MAX_TOKENS = 8000;
const AI_TEMPERATURE = 0.3;

const DEDUP_WINDOW_HOURS = 3;
const CONCURRENCY_WINDOW_MIN = 10;
const CUTOFF_THREADS_HOURS = 12;
const CUTOFF_MEETINGS_HOURS = 24;
const MAX_THREADS = 50;
const MAX_TASKS_CONTEXT = 30;
const MAX_MESSAGES_PER_THREAD = 20;
const TASK_DEDUP_PREFIX_LEN = 40;
const DEFAULT_TASK_DUE_DAYS = 3;

const MS_PER_HOUR = 3_600_000;
const MS_PER_MIN = 60_000;
const MS_PER_DAY = 86_400_000;

// ── Typy ───────────────────────────────────────────────────────
interface ParsedTask {
  assignedTo: string;
  task: string;
  priority: string;
}

// ── Helper: JSON response ──────────────────────────────────────
function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// ── Helper: Normalize therapist name ───────────────────────────
function normalizeTherapist(raw: string): "hanka" | "kata" {
  const lower = (raw || "").toLowerCase().trim();
  if (["kata", "káťa", "katka"].includes(lower)) return "kata";
  return "hanka";
}

// ── Helper: Parse [TASK:therapist]text[/TASK] blocks ───────────
function parseTaskBlocks(text: string): ParsedTask[] {
  const tasks: ParsedTask[] = [];
  const regex = /\[TASK:([\w]+)\]([\s\S]*?)\[\/TASK\]/gi;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    const rawTherapist = (match[1] || "").trim();
    const rawContent = (match[2] || "").trim();

    if (!rawContent) continue;

    // Detect priority from content
    let priority = "medium";
    if (/\b(urgentní|akutní|ihned|urgent|critical)\b/i.test(rawContent)) {
      priority = "high";
    } else if (/\b(nízká|low|optional|volitelné)\b/i.test(rawContent)) {
      priority = "low";
    }

    tasks.push({
      assignedTo: normalizeTherapist(rawTherapist),
      task: rawContent.slice(0, 500),
      priority,
    });
  }

  return tasks;
}

// ── Helper: Build conversation summaries ───────────────────────
function buildConversationSummaries(threads: any[]): string {
  const summaries: string[] = [];

  for (const thread of threads) {
    const msgs = Array.isArray(thread.messages) ? thread.messages : [];
    const recentMsgs = msgs.slice(-MAX_MESSAGES_PER_THREAD);
    const summary = recentMsgs
      .map((m: any) =>
        `[${m.role || m.author || "?"}]: ${(m.content || "").slice(0, 400)}`
      )
      .join("\n");

    summaries.push(
      `=== VLÁKNO: ${thread.part_name || thread.sub_mode || "?"} [${(thread.last_activity_at || "").slice(0, 16)}] ===\n${summary}`,
    );
  }

  return summaries.join("\n\n");
}

// ── Helper: Build meetings summary ─────────────────────────────
function buildMeetingsSummary(meetings: any[]): string {
  if (!meetings.length) return "Žádné porady za posledních 24h.";

  return meetings
    .map((m) => {
      const msgs = Array.isArray(m.messages) ? m.messages : [];
      const lastMsgs = msgs.slice(-10);
      const text = lastMsgs
        .map((msg: any) => `[${msg.role || msg.author || "?"}]: ${(msg.content || msg.text || "").slice(0, 300)}`)
        .join("\n");
      return `=== PORADA: ${m.topic || "?"} (status: ${m.status || "?"}) ===\n${text}`;
    })
    .join("\n\n");
}

// ── Helper: Build crisis summary ───────────────────────────────
function buildCrisisSummary(crises: any[]): string {
  if (!crises.length) return "Žádné aktivní krize.";

  return crises
    .map(
      (c) =>
        `- ${c.part_name}: status=${c.status}, dní v krizi=${c.days_in_crisis || "?"}, shrnutí: ${(c.summary || c.description || "").slice(0, 300)}`,
    )
    .join("\n");
}

// ── Helper: Build pending tasks summary ────────────────────────
function buildPendingTasksSummary(tasks: any[]): string {
  if (!tasks.length) return "Žádné nesplněné úkoly.";

  return tasks
    .map(
      (t) =>
        `- [${t.priority || "?"}] ${t.assigned_to || "?"}: ${(t.task || "").slice(0, 200)} (status: ${t.status}, due: ${t.due_date || "?"})`,
    )
    .join("\n");
}

// ── Helper: Build registry summary ─────────────────────────────
function buildRegistrySummary(parts: any[]): string {
  if (!parts.length) return "Žádné aktivní části.";

  return parts
    .map(
      (p) =>
        `- ${p.part_name} (ID: ${p.id_number || "?"}, status: ${p.status}, role: ${(p.role_in_system || "").slice(0, 100)})`,
    )
    .join("\n");
}

// ── Helper: Extract JSON block from AI response ───────────────
function extractAnalysisJson(text: string): Record<string, unknown> | null {
  // Try ```json ... ``` fence first
  const fenceMatch = text.match(/```json\s*([\s\S]*?)```/);
  if (fenceMatch) {
    try { return JSON.parse(fenceMatch[1]); } catch { /* continue */ }
  }

  // Try first { ... } block
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    try { return JSON.parse(text.slice(firstBrace, lastBrace + 1)); } catch { /* continue */ }
  }

  return null;
}

// ── Helper: Resolve user_id from DB (no JWT in cron) ──────────
async function resolveUserId(sb: SupabaseClient): Promise<string> {
  const { data } = await sb
    .from("did_part_registry")
    .select("user_id")
    .limit(1)
    .single();
  return data?.user_id || "00000000-0000-0000-0000-000000000000";
}

// ── Helper: Build system prompt ────────────────────────────────
function buildSystemPrompt(
  dashboard: string,
  operPlan: string,
): string {
  return `${SYSTEM_RULES}

═══ ROLE ═══
Ty jsi Karel, vedoucí terapeutického týmu. Tvůj úkol je analyzovat data z posledních 12–24 hodin, vytvořit strukturovanou analýzu a navrhnout KONKRÉTNÍ úkoly pro terapeutky Haničku a Káťu.

═══ AKTUÁLNÍ DASHBOARD ═══
${dashboard || "(Dashboard není k dispozici)"}

═══ AKTUÁLNÍ OPERATIVNÍ PLÁN ═══
${operPlan || "(Operativní plán není k dispozici)"}

═══ VÝSTUPNÍ FORMÁT — STRIKTNĚ DODRŽUJ ═══
Tvůj výstup má DVĚ části. Obě jsou povinné.

ČÁST 1 — ANALÝZA (JSON blok):
Vrať přesně tento JSON uvnitř \`\`\`json ... \`\`\`:
{
  "date": "YYYY-MM-DD",
  "overview": "Stručné 3–5 větné shrnutí celkového stavu DID systému dnes.",
  "therapists": {
    "Hanka": {
      "long_term": { "style": "", "reliability": "" },
      "situational": { "energy": "low|medium|high", "current_stressors": [], "notes": "" }
    },
    "Kata": {
      "long_term": { "style": "", "reliability": "" },
      "situational": { "energy": "low|medium|high", "current_stressors": [], "notes": "" }
    }
  },
  "parts": [
    {
      "name": "JMÉNO",
      "status": "active|sleeping",
      "recent_emotions": "stručný popis",
      "needs": ["potřeba1"],
      "risk_level": "low|medium|high",
      "session_recommendation": {
        "needed": true,
        "who_leads": "Hanka|Kata",
        "priority": "today|soon|later",
        "goals": ["cíl1"]
      }
    }
  ],
  "team_observations": {
    "cooperation": "stručný popis spolupráce",
    "warnings": [],
    "praise": []
  }
}

Pravidla pro JSON:
- "overview" je POVINNÉ — stručné shrnutí pro dashboard
- Pro KAŽDOU aktivní část vytvoř záznam v "parts"
- U spících částí: session_recommendation.needed=false, priority="later"
- Nikdy nezařazuj Locíka (pes), terapeutky ani Karla do "parts"

ČÁST 2 — ÚKOLY (po JSON bloku):
Generuj bloky [TASK:jméno]...[/TASK].

Pravidla pro úkoly:
- Maximálně 5 denních úkolů na terapeutku
- Úkoly musí být KONKRÉTNÍ a MĚŘITELNÉ
- Pokud jsou aktivní krize, úkoly k nim mají prioritu
- Nenavrhuj úkoly které už jsou v seznamu nesplněných
- Používej české názvy

Formát:
[TASK:hanka]Konkrétní text úkolu[/TASK]
[TASK:kata]Konkrétní text úkolu[/TASK]

Povolená jména: hanka, kata`;
}

// ── Helper: Build user message ─────────────────────────────────
function buildUserMessage(
  conversationSummaries: string,
  meetingsSummary: string,
  crisisSummary: string,
  pendingTasksSummary: string,
  registrySummary: string,
  todayDate: string,
  cycleTime: string,
): string {
  return `═══ DATUM: ${todayDate} (${cycleTime === "morning" ? "ranní" : "odpolední"} cyklus) ═══

═══ AKTIVNÍ ČÁSTI ═══
${registrySummary}

═══ AKTIVNÍ KRIZE ═══
${crisisSummary}

═══ NESPLNĚNÉ ÚKOLY TERAPEUTŮ ═══
${pendingTasksSummary}

═══ KONVERZACE ZA POSLEDNÍCH 12H ═══
${conversationSummaries || "Žádné konverzace."}

═══ PORADY ZA POSLEDNÍCH 24H ═══
${meetingsSummary}

Na základě výše uvedených dat vygeneruj konkrétní úkoly pro Haničku a Káťu na dnešek. Použij výhradně formát [TASK:jméno]...[/TASK].`;
}

// ── Helper: Deterministic fallback (no AI) ─────────────────────
function buildDeterministicFallback(
  crises: any[],
  parts: any[],
): string {
  const blocks: string[] = [];

  // For each active crisis, generate a follow-up task
  for (const crisis of crises.slice(0, 3)) {
    blocks.push(
      `[TASK:hanka]Zkontrolovat stav krize ${crisis.part_name} — zapsat aktuální pozorování do krizového deníku[/TASK]`,
    );
  }

  // For active parts without crisis, suggest observation
  const nonCrisisParts = parts
    .filter((p) => p.status === "active")
    .slice(0, 2);

  for (const part of nonCrisisParts) {
    blocks.push(
      `[TASK:hanka]Pozorovat ${part.part_name} při běžné komunikaci — zaznamenat náladu a aktivitu[/TASK]`,
    );
  }

  return blocks.join("\n");
}

// ── Helper: Build DASHBOARD content from analysis + DB ─────────
function buildDashboardContent(
  todayDate: string,
  analysisJson: Record<string, unknown> | null,
  activeCrises: any[],
  pendingTasks: any[],
): string {
  const lines: string[] = [];
  const timeStr = new Date().toLocaleString("cs-CZ", { timeZone: "Europe/Prague" });

  lines.push(`AKTUÁLNÍ DASHBOARD – DID SYSTÉM`);
  lines.push(`Aktualizace: ${todayDate} ${timeStr.split(" ")[1] || ""}`);
  lines.push(`Správce: Karel (analyst-loop v2a)`);
  lines.push("");

  // 1. Overview
  const overview = (analysisJson?.overview as string) || "";
  if (overview) {
    lines.push(`═══ KARLŮV PŘEHLED ═══`);
    lines.push(overview);
    lines.push("");
  }

  // 2. Aktivní krize
  lines.push(`═══ KRIZE ═══`);
  if (activeCrises.length > 0) {
    for (const c of activeCrises) {
      lines.push(`🔴 ${c.part_name} — status: ${c.status}, den ${c.days_in_crisis || "?"} — ${(c.summary || c.description || "").slice(0, 150)}`);
    }
  } else {
    lines.push(`✅ Žádné aktivní krize.`);
  }
  lines.push("");

  // 3. Top úkoly
  lines.push(`═══ ÚKOLY ═══`);
  const topTasks = (pendingTasks || []).slice(0, 8);
  if (topTasks.length > 0) {
    const hankaTasks = topTasks.filter((t: any) => t.assigned_to === "hanka");
    const kataTasks = topTasks.filter((t: any) => t.assigned_to === "kata");
    if (hankaTasks.length > 0) {
      lines.push(`Pro HANIČKU:`);
      for (const t of hankaTasks) {
        lines.push(`  • [${t.priority || "?"}] ${(t.task || "").slice(0, 200)}`);
      }
    }
    if (kataTasks.length > 0) {
      lines.push(`Pro KÁŤU:`);
      for (const t of kataTasks) {
        lines.push(`  • [${t.priority || "?"}] ${(t.task || "").slice(0, 200)}`);
      }
    }
  } else {
    lines.push(`(žádné aktivní úkoly)`);
  }
  lines.push("");

  // 4. Aktivní části
  const parts = Array.isArray(analysisJson?.parts) ? (analysisJson.parts as any[]) : [];
  const activeParts = parts.filter((p: any) => p.status === "active");
  const sleepingParts = parts.filter((p: any) => p.status === "sleeping");

  lines.push(`═══ ČÁSTI ═══`);
  if (activeParts.length > 0) {
    lines.push(`Aktivní (${activeParts.length}):`);
    for (const p of activeParts) {
      const rec = p.session_recommendation;
      const recStr = rec?.needed ? ` → sezení: ${rec.who_leads}, priorita: ${rec.priority}` : "";
      lines.push(`  ▸ ${p.name} | riziko: ${p.risk_level || "?"} | emoce: ${p.recent_emotions || "?"}${recStr}`);
    }
  }
  if (sleepingParts.length > 0) {
    lines.push(`Spící (${sleepingParts.length}): ${sleepingParts.map((p: any) => p.name).join(", ")}`);
  }

  return lines.join("\n");
}

// ── Helper: Read Drive doc safely ──────────────────────────────
async function readDriveDocSafely(
  token: string,
  centrumFolderId: string,
  docName: string,
): Promise<string> {
  try {
    const fileId = await findFileByName(token, docName, centrumFolderId);
    if (!fileId) {
      console.warn(`[ANALYST] Drive doc "${docName}" nenalezen`);
      return "";
    }
    return await readFileContent(token, fileId, GDOC_MIME);
  } catch (err) {
    console.warn(`[ANALYST] Chyba při čtení "${docName}":`, err);
    return "";
  }
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
  const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error("[ANALYST] FATAL: Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    return jsonResponse({ error: "Missing environment variables" }, 500);
  }

  if (!LOVABLE_API_KEY) {
    console.error("[ANALYST] FATAL: Missing LOVABLE_API_KEY");
    return jsonResponse({ error: "Missing LOVABLE_API_KEY" }, 500);
  }

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const now = new Date();
  const todayDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Prague",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const pragueHour = new Date(now.toLocaleString("en-US", { timeZone: "Europe/Prague" })).getHours();
  const cycleTime = pragueHour < 12 ? "morning" : "afternoon";

  console.log("[ANALYST] Starting run at", now.toISOString(), "cycleTime:", cycleTime);

  // ── KROK 0: Dedup guard ────────────────────────────────────
  const dedupSince = new Date(now.getTime() - DEDUP_WINDOW_HOURS * MS_PER_HOUR).toISOString();

  const { data: recentCycle, error: dedupErr } = await sb
    .from("did_update_cycles")
    .select("id, completed_at")
    .eq("status", "completed")
    .gte("completed_at", dedupSince)
    .limit(1);

  if (dedupErr) {
    console.warn("[ANALYST] Dedup check failed:", dedupErr.message);
  }

  // Allow force run via request body
  let forceRun = false;
  try {
    const body = await req.json();
    forceRun = body?.force === true;
  } catch {
    // No body or invalid JSON — that's fine
  }

  if (recentCycle && recentCycle.length > 0 && !forceRun) {
    console.log("[ANALYST] Skipped — recent successful cycle exists");
    return jsonResponse({ status: "skipped", reason: "recent_success" });
  }

  // ── KROK 0b: Concurrency guard ────────────────────────────
  const concurrencySince = new Date(now.getTime() - CONCURRENCY_WINDOW_MIN * MS_PER_MIN).toISOString();

  const { data: runningCycle } = await sb
    .from("did_update_cycles")
    .select("id, created_at")
    .eq("status", "running")
    .gte("created_at", concurrencySince)
    .limit(1);

  if (runningCycle && runningCycle.length > 0 && !forceRun) {
    console.log("[ANALYST] Skipped — another cycle is running");
    return jsonResponse({ status: "skipped", reason: "already_running" });
  }

  // Cleanup stale running cycles
  const { error: cleanupErr } = await sb
    .from("did_update_cycles")
    .update({ status: "failed", last_error: "stale_running" })
    .eq("status", "running")
    .lt("created_at", concurrencySince);

  if (cleanupErr) {
    console.warn("[ANALYST] Stale cleanup failed:", cleanupErr.message);
  }

  // Create new cycle record
  const { data: cycleRow, error: cycleInsertErr } = await sb
    .from("did_update_cycles")
    .insert({ status: "running", cycle_type: forceRun ? "manual" : "analyst_loop", user_id: "00000000-0000-0000-0000-000000000000" })
    .select()
    .single();

  if (cycleInsertErr || !cycleRow) {
    console.error("[ANALYST] Cannot create cycle record:", cycleInsertErr?.message);
    return jsonResponse({ error: "Cannot create cycle record" }, 500);
  }

  const cycleId = cycleRow.id;

  try {
    // ── KROK 1: Sběr dat z DB ──────────────────────────────
    const cutoff12h = new Date(now.getTime() - CUTOFF_THREADS_HOURS * MS_PER_HOUR).toISOString();
    const cutoff24h = new Date(now.getTime() - CUTOFF_MEETINGS_HOURS * MS_PER_HOUR).toISOString();

    // Konverzační vlákna za 12h
    const { data: threads, error: threadsErr } = await sb
      .from("did_threads")
      .select("id, messages, sub_mode, part_name, last_activity_at")
      .gte("last_activity_at", cutoff12h)
      .order("last_activity_at", { ascending: false })
      .limit(MAX_THREADS);

    if (threadsErr) {
      console.warn("[ANALYST] Chyba při čtení did_threads:", threadsErr.message);
    }

    // Porady za 24h
    const { data: meetings, error: meetingsErr } = await sb
      .from("did_meetings")
      .select("id, topic, messages, status")
      .gte("updated_at", cutoff24h);

    if (meetingsErr) {
      console.warn("[ANALYST] Chyba při čtení did_meetings:", meetingsErr.message);
    }

    // Aktivní krize
    const { data: activeCrises, error: crisesErr } = await sb
      .from("crisis_alerts")
      .select("*")
      .in("status", ["ACTIVE", "ACKNOWLEDGED"]);

    if (crisesErr) {
      console.warn("[ANALYST] Chyba při čtení crisis_alerts:", crisesErr.message);
    }

    // Registr aktivních částí
    const { data: activePartsRegistry, error: registryErr } = await sb
      .from("did_part_registry")
      .select("*")
      .in("status", ["active", "crisis", "stabilizing"]);

    if (registryErr) {
      console.warn("[ANALYST] Chyba při čtení did_part_registry:", registryErr.message);
    }

    // Pending úkoly
    const { data: pendingTasks, error: tasksErr } = await sb
      .from("did_therapist_tasks")
      .select("id, task, assigned_to, status, priority, due_date, source")
      .in("status", ["pending", "active", "in_progress", "not_started"])
      .order("priority", { ascending: false })
      .limit(MAX_TASKS_CONTEXT);

    if (tasksErr) {
      console.warn("[ANALYST] Chyba při čtení did_therapist_tasks:", tasksErr.message);
    }

    // ── KROK 2: Read-only Drive kontext ────────────────────
    let dashboardContent = "";
    let operPlanContent = "";

    try {
      const token = await getAccessToken();
      const kartotekaRoot = await resolveKartotekaRoot(token);

      if (!kartotekaRoot) {
        console.warn("[ANALYST] KARTOTEKA_DID root folder nenalezen");
      } else {
        const centrumFolderId = await findFolder(token, "00_CENTRUM", kartotekaRoot);

        if (centrumFolderId) {
          [dashboardContent, operPlanContent] = await Promise.all([
            readDriveDocSafely(token, centrumFolderId, "DASHBOARD"),
            readDriveDocSafely(token, centrumFolderId, "05A_OPERATIVNI_PLAN"),
          ]);
        } else {
          console.warn("[ANALYST] 00_CENTRUM folder nenalezen v KARTOTEKA_DID");
        }
      }
    } catch (driveErr) {
      console.warn("[ANALYST] Drive čtení selhalo (non-fatal):", driveErr);
      // Continue without Drive context — AI still works with DB data
    }

    // ── KROK 3: Sestavení vstupů pro AI ────────────────────
    const conversationSummaries = buildConversationSummaries(threads || []);
    const meetingsSummary = buildMeetingsSummary(meetings || []);
    const crisisSummary = buildCrisisSummary(activeCrises || []);
    const pendingTasksSummary = buildPendingTasksSummary(pendingTasks || []);
    const registrySummary = buildRegistrySummary(activePartsRegistry || []);

    const systemPrompt = buildSystemPrompt(dashboardContent, operPlanContent);
    const userMessage = buildUserMessage(
      conversationSummaries,
      meetingsSummary,
      crisisSummary,
      pendingTasksSummary,
      registrySummary,
      todayDate,
      cycleTime,
    );

    // ── KROK 4: AI volání ──────────────────────────────────
    let analysisText = "";

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);

    try {
      const response = await fetch(AI_URL, {
        signal: controller.signal,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${LOVABLE_API_KEY}`,
        },
        body: JSON.stringify({
          model: AI_MODEL,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userMessage },
          ],
          temperature: AI_TEMPERATURE,
          max_tokens: AI_MAX_TOKENS,
        }),
      });

      clearTimeout(timeout);

      if (!response.ok) {
        const errBody = await response.text().catch(() => "");
        console.error(`[ANALYST] AI HTTP ${response.status}:`, errBody.slice(0, 300));
        throw new Error(`AI HTTP ${response.status}`);
      }

      const data = await response.json();
      analysisText = data.choices?.[0]?.message?.content || "";

      if (!analysisText) {
        console.warn("[ANALYST] AI vrátilo prázdnou odpověď — fallback");
        analysisText = buildDeterministicFallback(activeCrises || [], activePartsRegistry || []);
      }
    } catch (aiErr) {
      clearTimeout(timeout);
      console.error("[ANALYST] AI call failed:", aiErr);
      analysisText = buildDeterministicFallback(activeCrises || [], activePartsRegistry || []);
    }

    console.log("[ANALYST] AI response length:", analysisText.length);

    // ── KROK 5a: Parsování analysis JSON ───────────────────
    const analysisJson = extractAnalysisJson(analysisText);
    console.log("[ANALYST] Analysis JSON parsed:", analysisJson ? "yes" : "no");

    // ── KROK 5b: Uložit analysis JSON do did_daily_context ───
    if (analysisJson) {
      try {
        const userId = await resolveUserId(sb);

        // 1. SELECT existing row for today
        const { data: existingCtx } = await sb
          .from("did_daily_context")
          .select("id")
          .eq("user_id", userId)
          .eq("context_date", todayDate)
          .limit(1)
          .maybeSingle();

        if (existingCtx) {
          // 2. UPDATE by id
          const { error: updateErr } = await sb
            .from("did_daily_context")
            .update({
              analysis_json: analysisJson,
              updated_at: new Date().toISOString(),
            })
            .eq("id", existingCtx.id);

          if (updateErr) {
            console.warn("[ANALYST] did_daily_context update error:", updateErr.message);
          } else {
            console.log("[ANALYST] did_daily_context updated for", todayDate);
          }
        } else {
          // 3. INSERT new row
          const { error: insertErr } = await sb
            .from("did_daily_context")
            .insert({
              user_id: userId,
              context_date: todayDate,
              context_json: {},
              analysis_json: analysisJson,
              source: "analyst_loop",
              updated_at: new Date().toISOString(),
            });

          if (insertErr) {
            console.warn("[ANALYST] did_daily_context insert error:", insertErr.message);
          } else {
            console.log("[ANALYST] did_daily_context inserted for", todayDate);
          }
        }
      } catch (ctxErr) {
        console.warn("[ANALYST] did_daily_context write failed (non-fatal):", ctxErr);
      }
    } else {
      console.warn("[ANALYST] No analysis JSON extracted — skipping did_daily_context write");
    }

    // ── KROK 5c: Parsování [TASK:...] bloků ────────────────
    const parsedTasks = parseTaskBlocks(analysisText);
    console.log("[ANALYST] Parsed tasks:", parsedTasks.length);

    // ── KROK 6: INSERT úkolů s deduplikací ─────────────────
    const taskUserId = await resolveUserId(sb);
    let insertedTasks = 0;

    for (const task of parsedTasks) {
      try {
        // Deduplikace: zkontroluj zda podobný úkol neexistuje
        const prefix = task.task.slice(0, TASK_DEDUP_PREFIX_LEN);
        const { data: existing } = await sb
          .from("did_therapist_tasks")
          .select("id")
          .eq("assigned_to", task.assignedTo)
          .ilike("task", `%${prefix}%`)
          .in("status", ["pending", "active", "in_progress"])
          .limit(1);

        if (existing && existing.length > 0) {
          console.log(`[ANALYST] Duplicitní úkol přeskočen: "${prefix}..."`);
          continue;
        }

        const { error: insertErr } = await sb.from("did_therapist_tasks").insert({
          task: task.task,
          assigned_to: task.assignedTo,
          priority: task.priority,
          status: "pending",
          source: "analyst_loop",
          due_date: new Date(now.getTime() + DEFAULT_TASK_DUE_DAYS * MS_PER_DAY)
            .toISOString()
            .slice(0, 10),
          user_id: taskUserId,
        });

        if (insertErr) {
          console.warn(`[ANALYST] Chyba při insertu úkolu:`, insertErr.message);
        } else {
          insertedTasks++;
        }
      } catch (taskErr) {
        console.warn("[ANALYST] Neočekávaná chyba při zpracování úkolu:", taskErr);
      }
    }

    // ── KROK 6c: Crisis follow-through (deterministický) ────
    let crisisTasksCreated = 0;
    let crisisSessionsPlanned = 0;

    for (const crisis of activeCrises || []) {
      try {
        const partName = crisis.part_name;
        const crisisId = crisis.id;

        // 1. Existuje follow-up úkol pro tuto krizi?
        const { data: existingTask } = await sb
          .from("did_therapist_tasks")
          .select("id")
          .eq("category", "crisis")
          .ilike("task", `%${partName}%`)
          .in("status", ["pending", "active", "in_progress"])
          .limit(1);

        if (!existingTask || existingTask.length === 0) {
          const dayNum = crisis.days_in_crisis || 1;
          const { error: taskErr } = await sb.from("did_therapist_tasks").insert({
            task: `Krizový follow-up: ${partName} (den ${dayNum}) — ověřit aktuální stav, naplánovat nebo provést stabilizační sezení`,
            assigned_to: "both",
            priority: "high",
            status: "pending",
            source: "analyst_loop",
            category: "crisis",
            due_date: todayDate,
            user_id: taskUserId,
          });

          if (taskErr) {
            console.warn(`[ANALYST] Crisis task insert error (${partName}):`, taskErr.message);
          } else {
            crisisTasksCreated++;
            console.log(`[ANALYST] Crisis follow-up task created: ${partName}`);
          }
        }

        // 2. Existuje nedávné sezení (48h) nebo plán sezení (dnes/včera)?
        const cutoff48h = new Date(now.getTime() - 48 * MS_PER_HOUR).toISOString();
        const yesterdayDate = new Intl.DateTimeFormat("en-CA", {
          timeZone: "Europe/Prague",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).format(new Date(now.getTime() - MS_PER_DAY));

        const { data: recentSession } = await sb
          .from("did_part_sessions")
          .select("id")
          .eq("part_name", partName)
          .gte("session_date", cutoff48h.slice(0, 10))
          .limit(1);

        const { data: existingPlan } = await sb
          .from("did_daily_session_plans")
          .select("id")
          .eq("selected_part", partName)
          .gte("plan_date", yesterdayDate)
          .in("status", ["pending", "planned"])
          .limit(1);

        const hasRecentSession = recentSession && recentSession.length > 0;
        const hasExistingPlan = existingPlan && existingPlan.length > 0;

        if (!hasRecentSession && !hasExistingPlan) {
          const userId = await resolveUserId(sb);
          const dayNum = crisis.days_in_crisis || 1;
          const severity = crisis.severity || "moderate";

          const planMarkdown = [
            `# Krizové sezení: ${partName} (den ${dayNum})`,
            ``,
            `## Cíl`,
            `Ověřit aktuální stav, stabilizovat, zjistit trend.`,
            ``,
            `## Formát`,
            severity === "critical" ? `Krizová intervence (30 min)` : `Stabilizační sezení (30–45 min)`,
            ``,
            `## Metoda`,
            `Grounding + bezpečné místo. Začít kotvením, neotírat traumatický materiál.`,
            ``,
            `## Otevírací otázky`,
            `- "Jak se dnes cítíš?"`,
            `- "Co se změnilo od posledně?"`,
            `- "Je něco, co potřebuješ hned teď?"`,
          ].join("\n");

          const { error: planErr } = await sb.from("did_daily_session_plans").insert({
            selected_part: partName,
            plan_date: todayDate,
            plan_markdown: planMarkdown,
            plan_html: `<pre>${planMarkdown}</pre>`,
            session_format: severity === "critical" ? "crisis_intervention" : "stabilization",
            session_lead: "karel",
            therapist: "both",
            urgency_score: severity === "critical" ? 100 : 80,
            urgency_breakdown: { source: "analyst_loop", crisis_day: dayNum, severity },
            status: "pending",
            generated_by: "analyst_loop",
            part_tier: "crisis",
            user_id: userId,
          });

          if (planErr) {
            console.warn(`[ANALYST] Crisis session plan error (${partName}):`, planErr.message);
          } else {
            crisisSessionsPlanned++;
            console.log(`[ANALYST] Crisis session planned: ${partName}`);
          }
        }
      } catch (crisisErr) {
        console.warn(`[ANALYST] Crisis follow-through error (${crisis.part_name}):`, crisisErr);
      }
    }

    // ── KROK 6b: Zápis DASHBOARD na Drive ──────────────────
    let dashboardWritten = false;
    try {
      const token = await getAccessToken();
      const kartotekaRoot = await resolveKartotekaRoot(token);

      if (!kartotekaRoot) {
        console.warn("[ANALYST] KARTOTEKA_DID root nenalezen — přeskakuji dashboard zápis");
      } else {
        const centrumFolderId = await findFolder(token, "00_CENTRUM", kartotekaRoot);

        if (!centrumFolderId) {
          console.warn("[ANALYST] 00_CENTRUM nenalezen — přeskakuji dashboard zápis");
        } else {
          const dashFileId = await findFileByName(token, "DASHBOARD", centrumFolderId);

          if (!dashFileId) {
            console.warn("[ANALYST] DASHBOARD doc nenalezen v 00_CENTRUM");
          } else {
            const dashContent = buildDashboardContent(
              todayDate,
              analysisJson,
              activeCrises || [],
              pendingTasks || [],
            );

            await overwriteDoc(token, dashFileId, dashContent);
            dashboardWritten = true;
            console.log(`[ANALYST] DASHBOARD written: ${dashContent.length} chars`);
          }
        }
      }
    } catch (driveWriteErr) {
      console.warn("[ANALYST] Dashboard Drive zápis selhal (non-fatal):", driveWriteErr);
    }

    // ── KROK 7: Cycle completed ────────────────────────────
    const { error: cycleUpdateErr } = await sb
      .from("did_update_cycles")
      .update({
        status: "completed",
        completed_at: new Date().toISOString(),
      })
      .eq("id", cycleId);

    if (cycleUpdateErr) {
      console.warn("[ANALYST] Chyba při update cycle:", cycleUpdateErr.message);
    }

    // ── KROK 8: Log ────────────────────────────────────────
    const summary = [
      `Analyst v1: ${threads?.length || 0} vláken`,
      `${meetings?.length || 0} porad`,
      `${activeCrises?.length || 0} krizí`,
      `${parsedTasks.length} AI úkolů parsed`,
      `${insertedTasks} úkolů inserted`,
      `Drive: dashboard=${dashboardContent.length > 0 ? "ok" : "N/A"}, plan=${operPlanContent.length > 0 ? "ok" : "N/A"}`,
      `analysis_json: ${analysisJson ? "saved" : "not_parsed"}`,
      `dashboard_drive: ${dashboardWritten ? "written" : "skipped"}`,
      `crisis_follow: ${crisisTasksCreated}t ${crisisSessionsPlanned}s`,
    ].join(" | ");

    const { error: logError } = await sb.from("system_health_log").insert({
      event_type: "analyst_loop_run",
      severity: "info",
      message: summary,
    });

    if (logError) {
      console.warn("[ANALYST] Chyba při zápisu logu:", logError.message);
    }

    console.log("[ANALYST] Completed:", summary);

    return jsonResponse({
      success: true,
      stats: {
        threads: threads?.length || 0,
        meetings: meetings?.length || 0,
        crises: activeCrises?.length || 0,
        tasksParsed: parsedTasks.length,
        tasksInserted: insertedTasks,
        driveRead: {
          dashboard: dashboardContent.length > 0,
          operPlan: operPlanContent.length > 0,
        },
      },
    });
  } catch (error) {
    // ── FATAL ERROR ────────────────────────────────────────
    const errMsg = error instanceof Error ? error.message : String(error);
    const errStack = error instanceof Error ? error.stack : "";
    console.error("[ANALYST] FATAL ERROR:", errMsg, errStack);

    // Mark cycle as failed
    try {
      await sb
        .from("did_update_cycles")
        .update({ status: "failed", last_error: errMsg.slice(0, 500) })
        .eq("id", cycleId);
    } catch {
      console.error("[ANALYST] Cannot mark cycle as failed");
    }

    // Log error
    try {
      await sb.from("system_health_log").insert({
        event_type: "analyst_loop_error",
        severity: "error",
        message: `FATAL: ${errMsg}`.slice(0, 500),
      });
    } catch {
      console.error("[ANALYST] Cannot write error log");
    }

    return jsonResponse({ error: errMsg }, 500);
  }
});
