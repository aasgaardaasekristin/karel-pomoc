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

// ── Entity filtering ───────────────────────────────────────────
const DIACRITICS_REGEX = /[\u0300-\u036f]/g;
const stripDiacritics = (s: string) => s.normalize("NFD").replace(DIACRITICS_REGEX, "");
const NON_DID_ENTITIES = new Set([
  "hanicka", "hanka", "hana", "hanička",
  "kata", "katka", "káťa", "kaca", "káča",
  "karel", "locik", "locek", "locíček",
  "dokument bez nazvu", "untitled", "untitled document",
  "indian", "indián",
]);
function isNonDidEntity(name: string): boolean {
  const norm = stripDiacritics(name).toLowerCase().trim();
  return NON_DID_ENTITIES.has(norm) || norm.includes("dokument bez nazvu") || norm.includes("untitled");
}
function cleanDisplayName(raw: string): string {
  let name = raw.replace(/^\d+_/, "").replace(/\.(txt|md|doc|docx)$/i, "").replace(/_/g, " ").trim();
  if (!name) return raw;
  return name.charAt(0).toUpperCase() + name.slice(1);
}
function normalizePartKey(name: string): string {
  return stripDiacritics(name).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

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

// ── Helper: Build crisis summary (from crisis_events) ──────────
function buildCrisisSummary(crises: any[]): string {
  if (!crises.length) return "Žádné aktivní krize.";

  return crises
    .map(
      (c) =>
        `- ${c.part_name}: fáze=${c.phase}, severity=${c.severity}, dní aktivních=${c.days_active || "?"}, trigger=${c.trigger_resolved ? "zvládnut" : "aktivní"}, shrnutí: ${(c.clinical_summary || c.trigger_description || "").slice(0, 300)}`,
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
  const todayISO = new Date().toISOString().slice(0, 10);
  return `${SYSTEM_RULES}

═══ DNEŠNÍ DATUM: ${todayISO} ═══
Události starší 5 dnů považuj za HISTORICKÉ. Nepiš o nich jako o aktuálních.
Pokud nemáš čerstvé informace (72h+), explicitně to uveď.

═══ ROLE ═══
Ty jsi Karel, vedoucí terapeutického týmu. Tvůj úkol je analyzovat data z posledních 12–24 hodin, vytvořit strukturovanou analýzu a navrhnout KONKRÉTNÍ úkoly pro terapeutky Haničku a Káťu.

═══ ROLE GUARD ═══
Karel NIKDY neúkoluje terapeutky přípravou materiálů, plánů sezení, groundingových technik, scénářů, karet částí ani analytickou prací. Karel tyto materiály PŘIPRAVUJE SÁM a terapeutkám je předává HOTOVÉ.
Úkoly pro terapeutky jsou VÝHRADNĚ: potvrdit účast, sdělit pozorování, odpovědět na otázku, provést konkrétní intervenci PŘI sezení.

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

// ── Helper: Deduplicate session plans by part name (case-insensitive) ──
function deduplicateSessions(plans: any[]): any[] {
  const seen = new Map<string, any>();
  for (const s of plans) {
    const key = normalizePartKey(s.selected_part || "");
    if (!key || isNonDidEntity(s.selected_part || "")) continue;
    const existing = seen.get(key);
    if (!existing || (s.urgency_score ?? 0) > (existing.urgency_score ?? 0)) {
      seen.set(key, s);
    }
  }
  return Array.from(seen.values());
}

// ── Helper: Auto-assign "both" tasks to specific therapist ────
function resolveTaskAssignment(task: any, activeCrises: any[]): string {
  const raw = (task.assigned_to || "").toLowerCase().trim();
  if (raw === "hanka" || raw === "kata") return raw;

  // Heuristic: if task mentions a crisis part name and that part is local → hanka
  const taskText = (task.task || "").toLowerCase();
  for (const c of activeCrises) {
    if (taskText.includes((c.part_name || "").toLowerCase())) return "hanka";
  }
  // If task mentions remote/school keywords → kata
  if (/škol|school|townshend|angličtin|amálk|toničk/i.test(taskText)) return "kata";
  // If task mentions direct observation → hanka (she's local)
  if (/pozorova|kontakt|sezení|session|grounding|stabiliz/i.test(taskText)) return "hanka";

  return raw; // keep "both" only as last resort
}

// ── Helper: Resolve therapist lead — never use blind "both" ───
function resolveSessionLead(s: any): string {
  const raw = (s.therapist || s.session_lead || "").toLowerCase().trim();
  if (["hanka", "hanička", "hana"].includes(raw)) return "Hanička";
  if (["kata", "káťa", "katka"].includes(raw)) return "Káťa";
  if (raw === "both" || raw === "obě" || !raw) return "⚠️ nutno rozhodnout";
  return raw;
}

// ── Helper: Staleness thresholds ──────────────────────────────
const STALE_CRISIS_HOURS = 24;
const STALE_TASK_DAYS = 2;
const STALE_QUESTION_DAYS = 3;
const STALE_SESSION_DAYS = 5;
const STALE_CONTACT_DAYS = 3;

// ═══ RECOVERY MODE — concrete recovery plan per stale part ═══
interface RecoveryAction {
  partName: string;
  reason: string;
  updateRequest: { who: string; what: string; returnTo: string };
  sessionProposal: { format: string; lead: string; goal: string; openingQuestions: string[]; expectedOutcome: string } | null;
  karelConversation: { channel: string; goal: string; questions: string[] } | null;
  pendingQuestion: { text: string; directedTo: string } | null;
}

function generateRecoveryPlans(
  activeCrises: any[],
  activePartsRegistry: any[],
  recentThreadParts: Set<string>,
  pendingTasks: any[],
  sessionPlans: any[],
): RecoveryAction[] {
  const plans: RecoveryAction[] = [];
  const nowMs = Date.now();
  const seenKeys = new Set<string>();

  // 1. Crisis parts without fresh data
  for (const c of activeCrises) {
    const partName = c.part_name || "";
    const key = normalizePartKey(partName);
    if (!key || seenKeys.has(key) || isNonDidEntity(partName)) continue;
    seenKeys.add(key);

    const updatedAt = c.updated_at || c.created_at || "";
    const hoursSince = updatedAt ? (nowMs - new Date(updatedAt).getTime()) / 3_600_000 : 999;
    if (hoursSince <= STALE_CRISIS_HOURS) continue;

    const dayNum = c.days_in_crisis || 1;
    const severity = c.severity || "moderate";

    plans.push({
      partName,
      reason: `Krize den ${dayNum}, poslední data ${Math.floor(hoursSince)}h zpět — Karel nemůže řídit bez aktuálních informací`,
      updateRequest: {
        who: "Hanička",
        what: `Zapsat do krizového deníku: (1) aktuální emoční stav ${partName}, (2) výsledek posledního zásahu, (3) co se za posledních ${Math.floor(hoursSince)}h změnilo, (4) zda jsou přítomny rizikové signály`,
        returnTo: "Karel potřebuje tyto informace do konce dnešního dne pro úpravu krizového plánu",
      },
      sessionProposal: {
        format: severity === "critical" ? "krizová intervence (30 min)" : "stabilizační sezení (30–45 min)",
        lead: "Hanička",
        goal: `Ověřit aktuální krizový stav ${partName}, zmapovat trend, provést grounding pokud třeba`,
        openingQuestions: [
          `Jak se dnes cítíš, ${partName}?`,
          `Co se změnilo od posledně?`,
          `Je něco, co teď potřebuješ?`,
          `Máš pocit bezpečí?`,
        ],
        expectedOutcome: `Karel obdrží: (1) aktuální risk level, (2) trend krize (zlepšení/stagnace/zhoršení), (3) doporučení pro další den`,
      },
      karelConversation: {
        channel: "DID/Kluci",
        goal: `Karel provede krátký check-in s ${partName} — zjistit subjektivní vnímání situace`,
        questions: [
          `Jak se dnes cítíš?`,
          `Co bys teď potřeboval?`,
          `Jak vnímáš spolupráci s terapeutkami?`,
        ],
      },
      pendingQuestion: {
        text: `Karel potřebuje aktuální stav ${partName} (den ${dayNum} krize). Co se změnilo za posledních ${Math.floor(hoursSince)}h? Jaký je výsledek posledního zásahu?`,
        directedTo: "both",
      },
    });
  }

  // 2. Active (non-crisis) parts without recent contact
  for (const p of activePartsRegistry) {
    const partName = p.part_name || "";
    const key = normalizePartKey(partName);
    if (!key || seenKeys.has(key) || isNonDidEntity(partName)) continue;
    if (!["active", "stabilizing"].includes(p.status)) continue;
    if (recentThreadParts.has(partName.toLowerCase())) continue;
    seenKeys.add(key);

    // Check if there's already a pending session
    const hasPlan = sessionPlans.some((s: any) =>
      normalizePartKey(s.selected_part || "") === key && ["pending", "planned"].includes(s.status)
    );

    plans.push({
      partName,
      reason: `Aktivní část bez kontaktu ${STALE_CONTACT_DAYS}+ dní — Karel nemá aktuální informace pro řízení`,
      updateRequest: {
        who: p.status === "stabilizing" ? "Hanička" : (Math.random() > 0.5 ? "Hanička" : "Káťa"),
        what: `Krátký check-in s ${partName}: (1) aktuální nálada, (2) zda potřebuje sezení, (3) jakékoli nové pozorování`,
        returnTo: "Karel zapracuje info do operativního plánu a karty části",
      },
      sessionProposal: hasPlan ? null : {
        format: "check-in (15–20 min)",
        lead: p.status === "stabilizing" ? "Hanička" : "Káťa",
        goal: `Zjistit aktuální stav ${partName}, ověřit stabilitu, identifikovat potřeby`,
        openingQuestions: [
          `Jak se ti daří?`,
          `Je něco, o čem bys chtěl(a) mluvit?`,
          `Jak vnímáš poslední dny?`,
        ],
        expectedOutcome: `Karel obdrží: aktuální status, emoční ladění, případné potřeby pro plánování`,
      },
      karelConversation: {
        channel: "DID/Kluci",
        goal: `Karel naváže kontakt s ${partName} — zjistit, jestli je vše v pořádku`,
        questions: [
          `Ahoj, ${partName}, jak se ti daří?`,
          `Potřebuješ něco?`,
        ],
      },
      pendingQuestion: null, // don't escalate non-crisis parts
    });
  }

  return plans;
}

interface StaleItem {
  type: "crisis" | "task" | "question" | "session" | "contact";
  entity: string;
  detail: string;
  action: string;
  who: string;
  deadline: string;
  why: string;
}

// ── Helper: Detect stale state across all entities ────────────
function detectStaleState(
  activeCrises: any[],
  pendingTasks: any[],
  pendingQuestions: any[],
  sessionPlans: any[],
  activePartsRegistry: any[],
  recentThreadParts: Set<string>,
  todayDate: string,
): StaleItem[] {
  const stale: StaleItem[] = [];
  const nowMs = Date.now();

  // 1. Crises without fresh update
  for (const c of activeCrises) {
    const updatedAt = c.updated_at || c.created_at || "";
    const hoursSinceUpdate = updatedAt ? (nowMs - new Date(updatedAt).getTime()) / 3_600_000 : 999;
    if (hoursSinceUpdate > STALE_CRISIS_HOURS) {
      stale.push({
        type: "crisis",
        entity: c.part_name,
        detail: `Krize den ${c.days_in_crisis || "?"}, poslední update ${Math.floor(hoursSinceUpdate)}h zpět`,
        action: "Dodat čerstvé pozorování a výsledek posledního zásahu",
        who: "hanka",
        deadline: todayDate,
        why: `Krizová informace starší ${Math.floor(hoursSinceUpdate)}h — nelze řídit bez aktuálních dat`,
      });
    }
  }

  // 2. Tasks overdue or without update
  for (const t of pendingTasks) {
    if (!t.due_date) continue;
    const daysOverdue = Math.floor((nowMs - new Date(t.due_date).getTime()) / 86_400_000);
    if (daysOverdue > STALE_TASK_DAYS) {
      stale.push({
        type: "task",
        entity: (t.task || "").slice(0, 80),
        detail: `${daysOverdue} dní po termínu, status: ${t.status}`,
        action: "Splnit, delegovat nebo uzavřít s vysvětlením",
        who: t.assigned_to || "hanka",
        deadline: todayDate,
        why: `Úkol visí ${daysOverdue} dní bez update`,
      });
    }
  }

  // 3. Questions without answer
  for (const q of pendingQuestions) {
    const createdAt = q.created_at || "";
    const daysSinceCreated = createdAt ? Math.floor((nowMs - new Date(createdAt).getTime()) / 86_400_000) : 0;
    if (daysSinceCreated > STALE_QUESTION_DAYS) {
      stale.push({
        type: "question",
        entity: (q.question || "").slice(0, 80),
        detail: `Bez odpovědi ${daysSinceCreated} dní`,
        action: "Odpovědět nebo označit jako neaktuální",
        who: q.directed_to === "kata" ? "kata" : "hanka",
        deadline: new Date(nowMs + 86_400_000).toISOString().slice(0, 10),
        why: `Otevřená otázka blokuje rozhodování`,
      });
    }
  }

  // 4. Planned sessions past date without completion
  for (const s of sessionPlans) {
    if (!s.plan_date) continue;
    const daysPast = Math.floor((nowMs - new Date(s.plan_date).getTime()) / 86_400_000);
    if (daysPast > 0 && ["pending", "planned"].includes(s.status)) {
      stale.push({
        type: "session",
        entity: s.selected_part,
        detail: `Plánované sezení ${daysPast} dní po termínu, stále "${s.status}"`,
        action: "Provést sezení nebo přeplánovat s novým datem",
        who: s.therapist === "kata" ? "kata" : "hanka",
        deadline: todayDate,
        why: `Sezení neproběhlo — část může stagnovat nebo se zhoršovat`,
      });
    }
  }

  // 5. Active/crisis parts without recent contact (skip non-DID entities)
  const seenContactKeys = new Set<string>();
  for (const p of activePartsRegistry) {
    if (!["active", "crisis", "stabilizing"].includes(p.status)) continue;
    const partName = p.part_name || "";
    if (isNonDidEntity(partName)) continue;
    const key = normalizePartKey(partName);
    if (seenContactKeys.has(key)) continue;
    seenContactKeys.add(key);
    if (recentThreadParts.has(partName.toLowerCase())) continue;
    stale.push({
      type: "contact",
      entity: partName,
      detail: `Aktivní část bez čerstvého kontaktu (${STALE_CONTACT_DAYS}+ dní)`,
      action: `Naplánovat sezení nebo alespoň krátký check-in`,
      who: "hanka",
      deadline: new Date(nowMs + 2 * 86_400_000).toISOString().slice(0, 10),
      why: `Část v ${p.status} zóně potřebuje kontinuální pozornost`,
    });
  }

  return stale;
}

// ── Helper: Classify task status ──────────────────────────────
function classifyTaskStatus(t: any, todayDate: string): string {
  const nowMs = Date.now();
  if (t.status === "pending" && t.created_at) {
    const ageHours = (nowMs - new Date(t.created_at).getTime()) / 3_600_000;
    if (ageHours < 24) return "🆕 nový";
  }
  if (t.status === "in_progress") return "🔄 rozpracovaný";
  if (t.status === "active") return "▶️ aktivní";
  if (t.due_date) {
    const daysOverdue = Math.floor((nowMs - new Date(t.due_date).getTime()) / 86_400_000);
    if (daysOverdue > 0) return `🔴 ${daysOverdue}d po termínu`;
  }
  if (t.priority === "blocked") return "🚫 blokovaný";
  return "⏳ čeká";
}

// ── Helper: Build 05A_OPERATIVNI_PLAN content ─────────────────
function build05AContent(
  todayDate: string,
  cycleTime: string,
  analysisJson: Record<string, unknown> | null,
  activeCrises: any[],
  pendingTasks: any[],
  sessionPlans: any[],
  pendingQuestions: any[],
  commitments: any[],
  activePartsRegistry: any[],
  recentThreadParts: Set<string>,
  recoveryPlans: RecoveryAction[] = [],
  crisisInterviews: any[] = [],
  crisisSessionQuestions: any[] = [],
  crisisMeetings: any[] = [],
): string {
  const lines: string[] = [];
  const timeStr = new Date().toLocaleString("cs-CZ", { timeZone: "Europe/Prague" });

  lines.push(`═══ OPERATIVNÍ PLÁN 05A ═══`);
  lines.push(`Datum: ${todayDate} | Cyklus: ${cycleTime === "morning" ? "ranní" : "odpolední"} | Aktualizace: ${timeStr}`);
  lines.push(`Generováno: Karel (analyst-loop v3 — active command)`);
  lines.push(``);

  // ── STALE STATE DETECTION ──
  const staleItems = detectStaleState(
    activeCrises, pendingTasks, pendingQuestions, sessionPlans,
    activePartsRegistry || [], recentThreadParts, todayDate,
  );

  // --- 1. KRIZOVÝ KONTEXT (structured operational block) ---
  lines.push(`━━━ 1. KRIZOVÝ KONTEXT ━━━`);
  if (activeCrises.length > 0) {
    for (const c of activeCrises) {
      const updatedAt = c.updated_at || c.created_at || "";
      const hoursSince = updatedAt ? Math.floor((Date.now() - new Date(updatedAt).getTime()) / 3_600_000) : 0;
      const triggerLabel = c.trigger_resolved ? "✅ zvládnut" : "🔴 aktivní";
      const stabilityLabel = c.stable_since
        ? `stabilní ${Math.floor((Date.now() - new Date(c.stable_since).getTime()) / 3_600_000)}h`
        : "nestabilní";
      lines.push(`🔴 ${cleanDisplayName(c.part_name || "")} | ${c.severity || "?"} | fáze: ${c.phase || "active"} | den ${c.days_active || "?"}`);
      lines.push(`   Trigger: ${triggerLabel} | Stabilita: ${stabilityLabel} | Stav: ${c.operating_state || "?"}`);
      if (c.primary_therapist) {
        lines.push(`   Vede: ${c.primary_therapist}${c.secondary_therapist ? ` + ${c.secondary_therapist}` : ""} (${c.ownership_source || "?"})`);
      }
      if (hoursSince > STALE_CRISIS_HOURS) {
        lines.push(`   ⚠️ ZASTARALÉ — poslední update ${hoursSince}h zpět`);
        lines.push(`   → POŽADAVEK: Hanička dodá aktuální pozorování DNES`);
        lines.push(`   → POŽADAVEK: Výsledek posledního zásahu — co se stalo?`);
      } else if (c.clinical_summary) {
        lines.push(`   Klinické shrnutí: ${(c.clinical_summary as string).slice(0, 250)}`);
      }

      // ── KAREL DNEŠNÍ ROZHODNUTÍ (from interviews) ──
      const todayInterviews = (crisisInterviews || []).filter((iv: any) =>
        iv.crisis_event_id === c.id && iv.completed_at && iv.started_at?.startsWith(todayDate)
      );
      if (todayInterviews.length > 0) {
        const latest = todayInterviews[0];
        lines.push(`   ── KAREL DNEŠNÍ ROZHODNUTÍ ──`);
        lines.push(`   Rozhodnutí: ${latest.karel_decision_after_interview || "?"}`);
        if (latest.summary_for_team) lines.push(`   Souhrn: ${(latest.summary_for_team as string).slice(0, 200)}`);
        if (latest.what_remains_unclear) lines.push(`   ⚠️ Nejasné: ${(latest.what_remains_unclear as string).slice(0, 150)}`);
        if (latest.next_required_actions?.length) {
          const actions = (latest.next_required_actions as any[]).map((a: any) => typeof a === "string" ? a : a?.text || "?");
          lines.push(`   Další kroky: ${actions.join("; ")}`);
        }
        if (latest.observed_regulation != null || latest.observed_trust != null) {
          lines.push(`   Regulace: ${latest.observed_regulation ?? "?"}/10 | Důvěra: ${latest.observed_trust ?? "?"}/10 | Koherence: ${latest.observed_coherence ?? "?"}/10`);
        }
      } else {
        const anyTodayStarted = (crisisInterviews || []).find((iv: any) =>
          iv.crisis_event_id === c.id && !iv.completed_at && iv.started_at?.startsWith(todayDate)
        );
        if (anyTodayStarted) {
          lines.push(`   ⏳ Karlův rozhovor PROBÍHÁ (zatím nedokončen)`);
        } else {
          lines.push(`   ⚠️ Chybí dnešní Karlův krizový rozhovor`);
        }
      }

      // ── CO DNES CHYBÍ (required outputs + awaiting) ──
      const missingItems: string[] = [];
      if (c.required_outputs_today && Array.isArray(c.required_outputs_today)) {
        for (const o of c.required_outputs_today) {
          const label = typeof o === "string" ? o : (o as any)?.label || JSON.stringify(o);
          const fulfilled = typeof o === "object" && (o as any)?.fulfilled;
          if (!fulfilled) missingItems.push(label);
        }
      }
      if (c.awaiting_response_from_therapists && Array.isArray(c.awaiting_response_from_therapists)) {
        for (const t of c.awaiting_response_from_therapists) {
          missingItems.push(`Čeká na odpověď: ${t}`);
        }
      }
      if (missingItems.length > 0) {
        lines.push(`   ── CO DNES CHYBÍ ──`);
        for (const m of missingItems) lines.push(`   ❌ ${m}`);
      }

      // ── SEZENÍ A FOLLOW-UP ──
      const crisisSession = sessionPlans.find((s: any) =>
        (s.selected_part || "").toLowerCase() === (c.part_name || "").toLowerCase()
      );
      const eventQuestions = (crisisSessionQuestions || []).filter((q: any) => q.crisis_event_id === c.id);
      const answeredQ = eventQuestions.filter((q: any) => q.answered_at);
      const unansweredQ = eventQuestions.filter((q: any) => !q.answered_at);

      if (crisisSession || eventQuestions.length > 0) {
        lines.push(`   ── SEZENÍ A FOLLOW-UP ──`);
        if (crisisSession) {
          const daysPast = Math.floor((Date.now() - new Date(crisisSession.plan_date || todayDate).getTime()) / 86_400_000);
          const status = daysPast > 0 && ["pending", "planned"].includes(crisisSession.status)
            ? `🔴 PO TERMÍNU (${daysPast}d)` : crisisSession.status;
          lines.push(`   Sezení: ${status} | Vede: ${crisisSession.session_lead || crisisSession.therapist || "?"}`);
        }
        if (eventQuestions.length > 0) {
          lines.push(`   Post-session otázky: ${answeredQ.length}/${eventQuestions.length} zodpovězeno`);
          if (unansweredQ.length > 0) {
            lines.push(`   ❌ Nezodpovězeno: ${unansweredQ.map((q: any) => q.therapist_name).join(", ")}`);
          }
          // Show Karel analysis if available
          const analyzed = answeredQ.find((q: any) => q.karel_analysis);
          if (analyzed) {
            try {
              const analysis = JSON.parse(analyzed.karel_analysis);
              lines.push(`   Efektivita: ${analysis.intervention_effectiveness || "?"} | Trend: ${analysis.stabilization_trend || "?"}`);
              if (analysis.main_risk) lines.push(`   Riziko: ${(analysis.main_risk as string).slice(0, 150)}`);
            } catch { /* parse error, skip */ }
          }
        }
      }

      // ── PORADA ──
      const eventMeetings = (crisisMeetings || []).filter((m: any) => m.crisis_event_id === c.id);
      if (eventMeetings.length > 0) {
        lines.push(`   ── PORADA ──`);
        for (const m of eventMeetings.slice(0, 2)) {
          lines.push(`   ${m.status === "scheduled" ? "📅" : m.status === "completed" ? "✅" : "⏳"} ${m.meeting_type || "porada"} | ${m.status} ${m.scheduled_for ? `| ${m.scheduled_for}` : ""}`);
          if (m.outcome) lines.push(`   Závěr: ${(m.outcome as string).slice(0, 150)}`);
          if (m.agenda) lines.push(`   Agenda: ${(m.agenda as string).slice(0, 150)}`);
        }
      } else if (c.crisis_meeting_required) {
        lines.push(`   ⚠️ Porada DOPORUČENA — zatím nezaložena`);
      }

      // ── DENNÍ CYKLUS ──
      if (c.daily_checklist && typeof c.daily_checklist === "object") {
        const dc = c.daily_checklist as any;
        const phases = ["morning_review", "midday_followthrough", "post_session_review", "evening_decision"];
        const phaseLabels: Record<string, string> = {
          morning_review: "Ráno", midday_followthrough: "Poledne",
          post_session_review: "Po sezení", evening_decision: "Večer",
        };
        const phaseStatuses = phases.map(p => {
          const ph = dc[p];
          if (!ph) return `${phaseLabels[p]}: ?`;
          const icon = ph.status === "completed" ? "✅" : ph.status === "partial" ? "⚠️" : ph.status === "missing" ? "❌" : "⏳";
          return `${icon}${phaseLabels[p]}`;
        });
        lines.push(`   ── DENNÍ CYKLUS ──`);
        lines.push(`   ${phaseStatuses.join(" | ")}`);
        if (dc.missing_outputs_today?.length) {
          lines.push(`   Missing: ${(dc.missing_outputs_today as string[]).slice(0, 3).join("; ")}`);
        }
        if (dc.next_day_ready === false) {
          lines.push(`   ⚠️ Další den NEPŘIPRAVEN`);
          if (dc.next_day_open_items?.length) {
            lines.push(`   Přenáší se: ${(dc.next_day_open_items as string[]).slice(0, 3).join("; ")}`);
          }
        }
      }

      // ── ROZHODOVACÍ BOD DNE ──
      const decisionPoint: string[] = [];
      if (!todayInterviews.length) decisionPoint.push("Provést Karlův krizový rozhovor");
      if (unansweredQ.length > 0) decisionPoint.push("Získat odpovědi od terapeutek");
      if (missingItems.length > 0) decisionPoint.push(`Splnit ${missingItems.length} výstupů`);
      if (c.operating_state === "ready_for_joint_review") decisionPoint.push("Rozhodnout o closure");
      if (decisionPoint.length > 0) {
        lines.push(`   ── ROZHODOVACÍ BOD DNE ──`);
        for (const dp of decisionPoint) lines.push(`   ▸ ${dp}`);
      }

      lines.push(``);
    }
  } else {
    lines.push(`✅ Žádné aktivní krize.`);
  }
  lines.push(``);

  // --- 2. PLÁNOVANÁ SEZENÍ (with overdue detection) ---
  lines.push(`━━━ 2. PLÁNOVANÁ SEZENÍ ━━━`);
  const uniqueSessions = deduplicateSessions(sessionPlans);
  if (uniqueSessions.length > 0) {
    for (const s of uniqueSessions) {
      const lead = resolveSessionLead(s);
      const daysPast = s.plan_date ? Math.floor((Date.now() - new Date(s.plan_date).getTime()) / 86_400_000) : 0;
      const statusTag = daysPast > 0 && ["pending", "planned"].includes(s.status)
        ? `🔴 PO TERMÍNU (${daysPast}d)` : s.status;
      lines.push(`▸ ${cleanDisplayName(s.selected_part || "")}`);
      lines.push(`  Vede: ${lead} | Formát: ${s.session_format || "?"} | Urgence: ${s.urgency_score ?? "?"} | Status: ${statusTag}`);
      const md = (s.plan_markdown || "") as string;
      const goalMatch = md.match(/##\s*Cíl\s*\n([^\n#]+)/);
      if (goalMatch) lines.push(`  Cíl: ${goalMatch[1].trim().slice(0, 200)}`);
      if (daysPast > 0 && ["pending", "planned"].includes(s.status)) {
        lines.push(`  → AKCE: Provést DNES nebo přeplánovat s novým termínem`);
      }
    }
  } else {
    // Check if active parts need sessions
    const activeWithoutSession = (activePartsRegistry || []).filter((p: any) =>
      ["active", "crisis"].includes(p.status) && !recentThreadParts.has((p.part_name || "").toLowerCase())
    );
    if (activeWithoutSession.length > 0) {
      lines.push(`⚠️ Části bez plánovaného sezení a bez čerstvého kontaktu:`);
      for (const p of activeWithoutSession) {
        lines.push(`  → ${cleanDisplayName(p.part_name || "")} (${p.status}) — NAPLÁNOVAT sezení`);
      }
    } else {
      lines.push(`  (žádná plánovaná sezení)`);
    }
  }
  lines.push(``);

  // --- 3. ÚKOLY PRO TERAPEUTKY (with auto-assignment + status) ---
  lines.push(`━━━ 3. ÚKOLY ━━━`);
  // Auto-reassign "both" tasks where possible
  const reassignedTasks = pendingTasks.map((t: any) => ({
    ...t,
    assigned_to: resolveTaskAssignment(t, activeCrises),
  }));
  const hankaTasks = reassignedTasks.filter((t: any) => t.assigned_to === "hanka");
  const kataTasks = reassignedTasks.filter((t: any) => t.assigned_to === "kata");
  const bothTasks = reassignedTasks.filter((t: any) => t.assigned_to !== "hanka" && t.assigned_to !== "kata");

  const renderTaskGroup = (label: string, tasks: any[]) => {
    if (tasks.length === 0) return;
    lines.push(`${label} (${tasks.length}):`);
    for (const t of tasks.slice(0, 8)) {
      const statusLabel = classifyTaskStatus(t, todayDate);
      lines.push(`  • ${statusLabel} [${t.priority || "?"}] ${(t.task || "").slice(0, 200)}${t.due_date ? ` — do ${t.due_date}` : ""}`);
    }
  };

  renderTaskGroup("HANIČKA", hankaTasks);
  renderTaskGroup("KÁŤA", kataTasks);
  if (bothTasks.length > 0) {
    lines.push(`OBĚ — ⚠️ nutno přiřadit (${bothTasks.length}):`);
    for (const t of bothTasks.slice(0, 3)) {
      const statusLabel = classifyTaskStatus(t, todayDate);
      lines.push(`  • ${statusLabel} [${t.priority || "?"}] ${(t.task || "").slice(0, 200)}${t.due_date ? ` — do ${t.due_date}` : ""}`);
    }
    if (bothTasks.length > 3) lines.push(`  … a dalších ${bothTasks.length - 3}`);
  }
  if (!hankaTasks.length && !kataTasks.length && !bothTasks.length) {
    lines.push(`  (žádné aktivní úkoly)`);
  }
  lines.push(``);

  // --- 4. OTEVŘENÉ OTÁZKY KARLA ---
  lines.push(`━━━ 4. OTEVŘENÉ OTÁZKY ━━━`);
  if (pendingQuestions.length > 0) {
    for (const q of pendingQuestions.slice(0, 10)) {
      const createdAt = q.created_at || "";
      const daysSince = createdAt ? Math.floor((Date.now() - new Date(createdAt).getTime()) / 86_400_000) : 0;
      const staleTag = daysSince > STALE_QUESTION_DAYS ? ` ⚠️ ${daysSince}d bez odpovědi` : "";
      lines.push(`  ❓ [${q.directed_to || "?"}] ${(q.question || "").slice(0, 200)} (${q.status})${staleTag}`);
    }
  } else {
    lines.push(`  (žádné otevřené otázky)`);
  }
  lines.push(``);

  // --- 5. URGENTNÍ FOLLOW-UP + STALE ITEMS ---
  lines.push(`━━━ 5. URGENTNÍ FOLLOW-UP ━━━`);
  const urgentTasks = pendingTasks.filter((t: any) => t.priority === "high" || t.priority === "critical");
  const overdueCommitments = commitments.filter((c: any) => {
    if (!c.due_date) return false;
    return new Date(c.due_date) < new Date(todayDate);
  });

  // 5a. Stale items requiring action
  if (staleItems.length > 0) {
    lines.push(`🔴 KAREL VYŽADUJE AKCI (${staleItems.length} položek):`);
    for (const si of staleItems) {
      lines.push(`  → [${si.type.toUpperCase()}] ${si.entity}`);
      lines.push(`    ${si.detail}`);
      lines.push(`    KDO: ${si.who === "kata" ? "Káťa" : "Hanička"} | DO KDY: ${si.deadline}`);
      lines.push(`    CO: ${si.action}`);
      lines.push(`    PROČ: ${si.why}`);
    }
    lines.push(``);
  }

  if (urgentTasks.length > 0) {
    lines.push(`⚠️ Urgentní úkoly (${urgentTasks.length}):`);
    for (const t of urgentTasks.slice(0, 5)) {
      lines.push(`  • [${t.assigned_to}] ${(t.task || "").slice(0, 200)}`);
    }
  }
  if (overdueCommitments.length > 0) {
    lines.push(`⚠️ Nesplněné závazky (${overdueCommitments.length}):`);
    for (const c of overdueCommitments.slice(0, 5)) {
      const daysOver = Math.floor((Date.now() - new Date(c.due_date).getTime()) / 86400000);
      lines.push(`  • ${(c.commitment_text || "").slice(0, 150)} — ${daysOver} dní po termínu (${c.committed_by})`);
    }
  }
  if (!urgentTasks.length && !overdueCommitments.length && !staleItems.length) {
    lines.push(`  ✅ Žádné urgentní položky.`);
  }
  lines.push(``);

  // --- 6. KARLŮV PŘEHLED (command briefing, not narrative) ---
  lines.push(`━━━ 6. KARLŮV PŘEHLED ━━━`);
  // Build short command briefing
  const briefLines: string[] = [];

  // What's most important today
  const crisisCount = activeCrises.length;
  const staleCount = staleItems.length;
  const overdueTaskCount = pendingTasks.filter((t: any) =>
    t.due_date && Math.floor((Date.now() - new Date(t.due_date).getTime()) / 86_400_000) > 0
  ).length;

  if (crisisCount > 0) {
    briefLines.push(`🔴 PRIORITA: ${crisisCount} aktivní krize — řešit PRVNÍ`);
  }
  if (staleCount > 0) {
    briefLines.push(`⚠️ NEOVĚŘENÉ: ${staleCount} položek bez čerstvých dat`);
  }
  if (overdueTaskCount > 0) {
    briefLines.push(`📋 PO TERMÍNU: ${overdueTaskCount} úkolů čeká na uzavření`);
  }

  // What Hanička must do today
  const hankaActions: string[] = [];
  const hankaStale = staleItems.filter(s => s.who === "hanka");
  if (hankaStale.length > 0) hankaActions.push(`Dodat update k ${hankaStale.length} položkám`);
  const hankaUrgent = urgentTasks.filter((t: any) => t.assigned_to === "hanka");
  if (hankaUrgent.length > 0) hankaActions.push(`${hankaUrgent.length} urgentních úkolů`);
  if (hankaActions.length > 0) {
    briefLines.push(`👩 HANIČKA DNES: ${hankaActions.join("; ")}`);
  }

  // What Káťa must do today
  const kataActions: string[] = [];
  const kataStale = staleItems.filter(s => s.who === "kata");
  if (kataStale.length > 0) kataActions.push(`Dodat update k ${kataStale.length} položkám`);
  const kataUrgent = urgentTasks.filter((t: any) => t.assigned_to === "kata");
  if (kataUrgent.length > 0) kataActions.push(`${kataUrgent.length} urgentních úkolů`);
  if (kataActions.length > 0) {
    briefLines.push(`👩‍🦰 KÁŤA DNES: ${kataActions.join("; ")}`);
  }

  // What Karel must check
  const karelChecks: string[] = [];
  if (crisisCount > 0) karelChecks.push(`Zkontrolovat krizové výsledky`);
  if (staleCount > 0) karelChecks.push(`Ověřit dodání ${staleCount} požadavků`);
  const unansweredQ = pendingQuestions.filter((q: any) =>
    q.created_at && Math.floor((Date.now() - new Date(q.created_at).getTime()) / 86_400_000) > STALE_QUESTION_DAYS
  );
  if (unansweredQ.length > 0) karelChecks.push(`${unansweredQ.length} otázek bez odpovědi`);
  if (karelChecks.length > 0) {
    briefLines.push(`🤖 KAREL KONTROLUJE: ${karelChecks.join("; ")}`);
  }

  if (briefLines.length === 0) {
    briefLines.push(`✅ Systém stabilní. Žádné urgentní položky.`);
  }

  lines.push(...briefLines);
  lines.push(``);

  // --- 7. STAV ČÁSTÍ (ze AI analýzy + staleness, deduplicated, filtered) ---
  const parts = Array.isArray(analysisJson?.parts) ? (analysisJson!.parts as any[]) : [];
  if (parts.length > 0) {
    lines.push(`━━━ 7. PŘEHLED ČÁSTÍ ━━━`);
    const seenPartKeys = new Set<string>();
    const activeParts = parts.filter((p: any) => p.status === "active" && !isNonDidEntity(p.name || ""));
    for (const p of activeParts) {
      const key = normalizePartKey(p.name || "");
      if (!key || seenPartKeys.has(key)) continue;
      seenPartKeys.add(key);
      const hasContact = recentThreadParts.has((p.name || "").toLowerCase());
      const contactTag = hasContact ? "" : " | ⚠️ bez čerstvého kontaktu";
      lines.push(`  ▸ ${cleanDisplayName(p.name || "")} | riziko: ${p.risk_level || "?"} | emoce: ${p.recent_emotions || "?"}${contactTag}`);
      if (p.needs?.length) lines.push(`    Potřeby: ${p.needs.join(", ")}`);
    }
    lines.push(``);
  }

  // --- 8. REŽIM OBNOVY ŘÍZENÍ (recovery plans) ---
  if (recoveryPlans.length > 0) {
    lines.push(`━━━ 8. REŽIM OBNOVY ŘÍZENÍ ━━━`);
    lines.push(`🔄 Karel aktivně řeší díry v datech pro ${recoveryPlans.length} částí:`);
    lines.push(``);
    for (const rp of recoveryPlans) {
      lines.push(`── ${cleanDisplayName(rp.partName)} ──`);
      lines.push(`DŮVOD: ${rp.reason}`);
      lines.push(``);
      lines.push(`1️⃣ POŽADAVEK NA UPDATE:`);
      lines.push(`   KDO: ${rp.updateRequest.who}`);
      lines.push(`   CO: ${rp.updateRequest.what}`);
      lines.push(`   VÝSLEDEK PRO KARLA: ${rp.updateRequest.returnTo}`);
      if (rp.sessionProposal) {
        lines.push(``);
        lines.push(`2️⃣ NAVRŽENÉ SEZENÍ:`);
        lines.push(`   FORMÁT: ${rp.sessionProposal.format}`);
        lines.push(`   VEDE: ${rp.sessionProposal.lead}`);
        lines.push(`   CÍL: ${rp.sessionProposal.goal}`);
        lines.push(`   OTÁZKY:`);
        for (const q of rp.sessionProposal.openingQuestions) {
          lines.push(`     • "${q}"`);
        }
        lines.push(`   OČEKÁVANÝ VÝSTUP: ${rp.sessionProposal.expectedOutcome}`);
      }
      if (rp.karelConversation) {
        lines.push(``);
        lines.push(`3️⃣ KAREL PROVEDE ROZHOVOR:`);
        lines.push(`   KANÁL: ${rp.karelConversation.channel}`);
        lines.push(`   CÍL: ${rp.karelConversation.goal}`);
        lines.push(`   OTÁZKY:`);
        for (const q of rp.karelConversation.questions) {
          lines.push(`     • "${q}"`);
        }
      }
      lines.push(``);
    }
  }

  // Update briefing with recovery info
  if (recoveryPlans.length > 0) {
    // Find the briefing section and append recovery summary
    const recoveryIdx = lines.findIndex(l => l.includes("KARLŮV PŘEHLED"));
    if (recoveryIdx >= 0) {
      const insertAt = lines.findIndex((l, i) => i > recoveryIdx && l.startsWith("━━━"));
      const recoveryBrief = [
        `🔄 RECOVERY: Karel aktivně řeší ${recoveryPlans.length} dír v datech`,
        ...recoveryPlans.map(rp => `  → ${cleanDisplayName(rp.partName)}: ${rp.updateRequest.who} dodá update, ${rp.sessionProposal ? "navrženo sezení" : "check-in"}`),
      ];
      if (insertAt > 0) {
        lines.splice(insertAt, 0, ...recoveryBrief, ``);
      }
    }
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

    // Aktivní krize — primární zdroj: crisis_events
    const { data: activeCrises, error: crisesErr } = await sb
      .from("crisis_events")
      .select("*")
      .not("phase", "eq", "closed");

    if (crisesErr) {
      console.warn("[ANALYST] Chyba při čtení crisis_events:", crisesErr.message);
    }

    // Crisis alerts pro notifikační metadata (sekundární)
    const { data: crisisAlerts } = await sb
      .from("crisis_alerts")
      .select("id, part_name, status")
      .in("status", ["ACTIVE", "ACKNOWLEDGED"]);

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
      .select("id, task, assigned_to, status, priority, due_date, source, created_at")
      .in("status", ["pending", "active", "in_progress", "not_started"])
      .order("priority", { ascending: false })
      .limit(MAX_TASKS_CONTEXT);

    if (tasksErr) {
      console.warn("[ANALYST] Chyba při čtení did_therapist_tasks:", tasksErr.message);
    }

    // Session plány pro 05A
    const { data: sessionPlans } = await sb
      .from("did_daily_session_plans")
      .select("id, selected_part, therapist, session_lead, session_format, urgency_score, plan_markdown, status")
      .in("status", ["pending", "planned", "in_progress"])
      .gte("plan_date", new Date(now.getTime() - 5 * MS_PER_DAY).toISOString().slice(0, 10))
      .order("urgency_score", { ascending: false })
      .limit(10);

    // Pending questions pro 05A
    const { data: pendingQuestions } = await (sb as any)
      .from("did_pending_questions")
      .select("id, question, directed_to, status, created_at")
      .in("status", ["open", "pending", "sent"])
      .order("created_at", { ascending: false })
      .limit(15);

    // Commitments pro 05A
    const { data: commitments } = await (sb as any)
      .from("karel_commitments")
      .select("id, commitment_text, due_date, committed_by, status")
      .eq("status", "open")
      .order("due_date", { ascending: true })
      .limit(15);

    // Crisis assessments for trend + closure readiness
    const { data: crisisAssessments } = await sb
      .from("crisis_daily_assessments")
      .select("crisis_alert_id, crisis_event_id, assessment_date, karel_decision, karel_risk_assessment, day_number")
      .order("assessment_date", { ascending: true });

    // Crisis closure checklists
    const { data: closureChecklists } = await sb
      .from("crisis_closure_checklist")
      .select("crisis_alert_id, crisis_event_id, hanka_agrees, kata_agrees, karel_diagnostic_done, no_risk_signals, emotional_stable_days, grounding_works, trigger_managed, no_open_questions, relapse_plan_exists, karel_recommends_closure")
      ;

    // Crisis interviews today (for 05A)
    const { data: crisisInterviews } = await sb
      .from("crisis_karel_interviews")
      .select("crisis_event_id, part_name, interview_type, interview_goal, started_at, completed_at, karel_decision_after_interview, summary_for_team, what_remains_unclear, next_required_actions, observed_regulation, observed_trust, observed_coherence")
      .gte("started_at", new Date(now.getTime() - 2 * MS_PER_DAY).toISOString())
      .order("started_at", { ascending: false })
      .limit(20);

    // Crisis session questions (for 05A)
    const { data: crisisSessionQuestions } = await sb
      .from("crisis_session_questions")
      .select("crisis_event_id, therapist_name, question_text, answer_text, answered_at, karel_analysis, required_by")
      .gte("created_at", new Date(now.getTime() - 3 * MS_PER_DAY).toISOString())
      .order("created_at", { ascending: true })
      .limit(50);

    // Did meetings with crisis link (for 05A)
    const { data: crisisMeetings } = await sb
      .from("did_meetings")
      .select("id, meeting_type, status, scheduled_for, outcome, agenda, crisis_event_id")
      .not("status", "eq", "cancelled")
      .gte("created_at", new Date(now.getTime() - 7 * MS_PER_DAY).toISOString())
      .order("created_at", { ascending: false })
      .limit(10);

    // Note: crisis_events data is already in activeCrises (primary source of truth)

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

    // ── KROK 2b: Compute recentThreadParts (72h contact) ───
    const cutoff72h = new Date(now.getTime() - 72 * MS_PER_HOUR).toISOString();
    const { data: recentConvs } = await sb
      .from("did_conversations")
      .select("sub_mode")
      .gte("updated_at", cutoff72h);

    const recentThreadParts = new Set<string>();
    for (const t of threads || []) {
      if (t.part_name) recentThreadParts.add(t.part_name.toLowerCase());
    }
    for (const c of recentConvs || []) {
      if (c.sub_mode) recentThreadParts.add(c.sub_mode.toLowerCase());
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

    // ── KROK 6d: Missing Karel interview detection ──────────
    for (const crisis of activeCrises || []) {
      try {
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);
        const { data: todayInterview } = await sb
          .from("crisis_karel_interviews")
          .select("id, completed_at")
          .eq("crisis_event_id", crisis.id)
          .gte("started_at", todayStart.toISOString())
          .limit(1);

        const hasCompletedToday = todayInterview?.some((i: any) => i.completed_at);

        if (!hasCompletedToday) {
          // Flag as missing required output
          const existingOutputs = Array.isArray(crisis.required_outputs_today) ? crisis.required_outputs_today : [];
          const alreadyFlagged = existingOutputs.some((o: string) =>
            typeof o === "string" && o.includes("Karlův krizový rozhovor")
          );

          if (!alreadyFlagged) {
            const updatedOutputs = [...existingOutputs, `⚠️ Chybí dnešní Karlův krizový rozhovor s ${crisis.part_name}`];
            await sb.from("crisis_events")
              .update({ required_outputs_today: updatedOutputs })
              .eq("id", crisis.id);
            console.log(`[ANALYST] Missing Karel interview flagged: ${crisis.part_name}`);
          }
        }
      } catch (e) {
        console.warn(`[ANALYST] Interview detection error (${crisis.part_name}):`, e);
      }
    }

    // ── KROK 6e: Stale-state auto follow-through ────────────
    const staleItems = detectStaleState(
      activeCrises || [], pendingTasks || [], pendingQuestions || [],
      sessionPlans || [], activePartsRegistry || [], recentThreadParts, todayDate,
    );
    let staleTasksCreated = 0;
    let staleQuestionsCreated = 0;

    for (const si of staleItems.slice(0, 8)) {
      try {
        if (si.type === "crisis" || si.type === "session" || si.type === "contact") {
          // Create follow-up task
          const prefix = si.action.slice(0, TASK_DEDUP_PREFIX_LEN);
          const { data: existing } = await sb
            .from("did_therapist_tasks")
            .select("id")
            .eq("assigned_to", si.who)
            .ilike("task", `%${prefix}%`)
            .in("status", ["pending", "active", "in_progress"])
            .limit(1);

          if (!existing || existing.length === 0) {
            await sb.from("did_therapist_tasks").insert({
              task: `[Auto] ${si.action} — ${si.entity}. ${si.why}`,
              assigned_to: si.who,
              priority: si.type === "crisis" ? "high" : "medium",
              status: "pending",
              source: "analyst_loop",
              due_date: si.deadline,
              user_id: taskUserId,
            });
            staleTasksCreated++;
          }
        } else if (si.type === "question" || si.type === "task") {
          // Create pending question for overdue tasks
          const { data: existing } = await (sb as any)
            .from("did_pending_questions")
            .select("id")
            .ilike("question", `%${si.entity.slice(0, 30)}%`)
            .in("status", ["pending", "sent"])
            .limit(1);

          if (!existing || existing.length === 0) {
            await (sb as any).from("did_pending_questions").insert({
              question: `${si.action}: "${si.entity}". ${si.why}`,
              directed_to: si.who === "kata" ? "kata" : "both",
              subject_type: "stale_followup",
              status: "pending",
              expires_at: new Date(Date.now() + 3 * 86_400_000).toISOString(),
            });
            staleQuestionsCreated++;
          }
        }
      } catch (staleErr) {
        console.warn(`[ANALYST] Stale follow-through error:`, staleErr);
      }
    }
    console.log(`[ANALYST] Stale follow-through: ${staleTasksCreated} tasks, ${staleQuestionsCreated} questions`);

    // ── KROK 6f: Recovery mode — generate & execute recovery plans ──
    const recoveryPlans = generateRecoveryPlans(
      activeCrises || [], activePartsRegistry || [], recentThreadParts,
      pendingTasks || [], sessionPlans || [],
    );
    let recoveryTasksCreated = 0;
    let recoveryQuestionsCreated = 0;
    let recoverySessionsCreated = 0;

    for (const rp of recoveryPlans) {
      try {
        // 1. Create update-request task
        const taskText = `[RECOVERY] ${rp.partName}: ${rp.updateRequest.what}`;
        const prefix = taskText.slice(0, TASK_DEDUP_PREFIX_LEN);
        const { data: existingTask } = await sb
          .from("did_therapist_tasks")
          .select("id")
          .ilike("task", `%${prefix}%`)
          .in("status", ["pending", "active", "in_progress"])
          .limit(1);

        if (!existingTask || existingTask.length === 0) {
          await sb.from("did_therapist_tasks").insert({
            task: taskText.slice(0, 500),
            assigned_to: rp.updateRequest.who.toLowerCase().includes("káťa") || rp.updateRequest.who.toLowerCase().includes("kata") ? "kata" : "hanka",
            priority: "high",
            status: "pending",
            source: "recovery_mode",
            due_date: todayDate,
            user_id: taskUserId,
          });
          recoveryTasksCreated++;
        }

        // 2. Create pending question if specified
        if (rp.pendingQuestion) {
          const qPrefix = rp.pendingQuestion.text.slice(0, 30);
          const { data: existingQ } = await (sb as any)
            .from("did_pending_questions")
            .select("id")
            .ilike("question", `%${qPrefix}%`)
            .in("status", ["open", "pending", "sent"])
            .limit(1);

          if (!existingQ || existingQ.length === 0) {
            await (sb as any).from("did_pending_questions").insert({
              question: rp.pendingQuestion.text.slice(0, 500),
              directed_to: rp.pendingQuestion.directedTo,
              subject_type: "recovery_request",
              status: "open",
              expires_at: new Date(Date.now() + 2 * 86_400_000).toISOString(),
            });
            recoveryQuestionsCreated++;
          }
        }

        // 3. Create session plan if proposed and doesn't exist
        if (rp.sessionProposal) {
          const partKey = normalizePartKey(rp.partName);
          const { data: existingPlan } = await sb
            .from("did_daily_session_plans")
            .select("id")
            .eq("selected_part", rp.partName)
            .gte("plan_date", new Date(Date.now() - 86_400_000).toISOString().slice(0, 10))
            .in("status", ["pending", "planned"])
            .limit(1);

          if (!existingPlan || existingPlan.length === 0) {
            const planMd = [
              `# Recovery sezení: ${rp.partName}`,
              ``,
              `## Cíl`,
              rp.sessionProposal.goal,
              ``,
              `## Formát`,
              rp.sessionProposal.format,
              ``,
              `## Otevírací otázky`,
              ...rp.sessionProposal.openingQuestions.map(q => `- "${q}"`),
              ``,
              `## Očekávaný výstup pro Karla`,
              rp.sessionProposal.expectedOutcome,
            ].join("\n");

            const userId = await resolveUserId(sb);
            await sb.from("did_daily_session_plans").insert({
              selected_part: rp.partName,
              plan_date: todayDate,
              plan_markdown: planMd,
              plan_html: `<pre>${planMd}</pre>`,
              session_format: rp.sessionProposal.format.includes("check-in") ? "check_in" : "stabilization",
              session_lead: "karel",
              therapist: rp.sessionProposal.lead.toLowerCase().includes("káťa") || rp.sessionProposal.lead.toLowerCase().includes("kata") ? "kata" : "hanka",
              urgency_score: 70,
              urgency_breakdown: { source: "recovery_mode", reason: rp.reason },
              status: "pending",
              generated_by: "recovery_mode",
              part_tier: "active",
              user_id: userId,
            });
            recoverySessionsCreated++;
          }
        }
      } catch (recoveryErr) {
        console.warn(`[ANALYST] Recovery execution error (${rp.partName}):`, recoveryErr);
      }
    }
    console.log(`[ANALYST] Recovery mode: ${recoveryPlans.length} plans, ${recoveryTasksCreated}t ${recoveryQuestionsCreated}q ${recoverySessionsCreated}s`);

    // ── KROK 6g: Crisis daily assessment check + closure readiness ──
    let closureProposals = 0;
    for (const crisis of activeCrises || []) {
      try {
        const eventId = crisis.id;
        const partName = crisis.part_name || "";

        // Find matching alert for assessment linkage (legacy FK)
        const matchingAlert = (crisisAlerts || []).find((a: any) => a.part_name?.toUpperCase() === partName.toUpperCase());
        const alertId = matchingAlert?.id || eventId;

        // Get assessments: primary via crisis_event_id, fallback via crisis_alert_id
        const assessments = (crisisAssessments || []).filter((a: any) =>
          (a.crisis_event_id && a.crisis_event_id === eventId) ||
          (!a.crisis_event_id && a.crisis_alert_id === alertId)
        );
        const latest = assessments.length > 0 ? assessments[assessments.length - 1] : null;

        // Check if today's assessment exists
        if (!latest || latest.assessment_date < todayDate) {
          // No today assessment → create recovery request
          const taskText = `[CRISIS-ASSESSMENT] Dnešní hodnocení pro ${partName} chybí — provést assessment nebo dodat pozorování`;
          const prefix = taskText.slice(0, TASK_DEDUP_PREFIX_LEN);
          const { data: existing } = await sb
            .from("did_therapist_tasks")
            .select("id")
            .ilike("task", `%${prefix}%`)
            .in("status", ["pending", "active", "in_progress"])
            .limit(1);

          if (!existing || existing.length === 0) {
            await sb.from("did_therapist_tasks").insert({
              task: taskText,
              assigned_to: "hanka",
              priority: "high",
              status: "pending",
              source: "analyst_loop",
              due_date: todayDate,
              user_id: taskUserId,
            });
          }
        }

        // Check trend: if stagnating/worsening for 3+ assessments → escalate
        if (assessments.length >= 3) {
          const last3 = assessments.slice(-3);
          const riskOrder: Record<string, number> = { minimal: 1, low: 2, moderate: 3, high: 4, critical: 5 };
          const risks = last3.map((a: any) => riskOrder[a.karel_risk_assessment] ?? 3);
          const isWorsening = risks[2] >= risks[1] && risks[1] >= risks[0] && risks[2] >= 4;

          if (isWorsening) {
            const escalationText = `⚠️ ESKALACE: ${partName} — riziko stagnuje/zhoršuje se 3 dny v řadě (${last3.map((a: any) => a.karel_risk_assessment).join(" → ")})`;
            await sb.from("system_health_log").insert({
              event_type: "crisis_escalation",
              severity: "critical",
              message: escalationText.slice(0, 500),
            });
          }
        }

        // Check closure readiness — 10-item model
        // Crisis state model: ACTIVE → INTERVENED → STABILIZING → READY_TO_CLOSE → RESOLVED → MONITORING_POST → CLOSED
        // Analyst-loop may only PROPOSE READY_TO_CLOSE — never directly set RESOLVED
        const checklist = (closureChecklists || []).find((c: any) =>
          (c.crisis_event_id && c.crisis_event_id === eventId) ||
          (!c.crisis_event_id && c.crisis_alert_id === alertId)
        );
        const event = crisis; // crisis_events IS the source of truth now

        if (checklist && event) {
          const allIndicatorsAbove5 = [event.indicator_safety, event.indicator_coherence, event.indicator_emotional_regulation, event.indicator_trust, event.indicator_time_orientation]
            .every((v: number | null) => v !== null && v > 5);

          // Expanded 10-item closure readiness
          const closureItems = [
            checklist.karel_diagnostic_done,
            checklist.hanka_agrees,
            checklist.kata_agrees,
            checklist.no_risk_signals,
            (checklist.emotional_stable_days || 0) >= 3,
            checklist.grounding_works ?? false,
            checklist.trigger_managed ?? false,
            checklist.no_open_questions ?? false,
            checklist.relapse_plan_exists ?? false,
            checklist.karel_recommends_closure ?? false,
          ];
          const readiness = closureItems.filter(Boolean).length / closureItems.length;

          // Clinical proposal conditions (without therapist approvals)
          const clinicalReady =
            checklist.karel_diagnostic_done &&
            checklist.no_risk_signals &&
            (checklist.emotional_stable_days || 0) >= 3 &&
            (checklist.grounding_works ?? false) &&
            (checklist.trigger_managed ?? false) &&
            (checklist.no_open_questions ?? false) &&
            (checklist.relapse_plan_exists ?? false);

          // Full readiness includes therapist approvals + Karel recommendation
          const fullReady = clinicalReady &&
            checklist.hanka_agrees &&
            checklist.kata_agrees &&
            (checklist.karel_recommends_closure ?? false);

          // Derive trigger_resolved from checklist
          const triggerResolved = !!(checklist.trigger_managed);

          // Build clinical summary
          const summaryParts: string[] = [];
          summaryParts.push(`Closure readiness ${Math.round(readiness * 100)}%`);
          if (checklist.emotional_stable_days) summaryParts.push(`${checklist.emotional_stable_days} stabilních dní`);
          if (checklist.no_risk_signals) summaryParts.push(`bez rizikových signálů`);
          if (triggerResolved) summaryParts.push(`trigger zvládnut`);
          if (checklist.grounding_works) summaryParts.push(`grounding funguje`);
          if (checklist.relapse_plan_exists) summaryParts.push(`relapse plán existuje`);
          const clinicalSummary = summaryParts.join(". ") + ".";

          // Determine stable_since: if 3+ consecutive stable assessments, use the date of the first one in the streak
          let stableSince: string | null = null;
          if (assessments.length >= 2) {
            const reversed = assessments.slice().reverse();
            let streakStart = 0;
            for (const a of reversed) {
              const risk = (a as any).karel_risk_assessment;
              if (risk === "high" || risk === "critical") break;
              streakStart++;
            }
            if (streakStart >= 3) {
              const oldestStableIdx = assessments.length - streakStart;
              stableSince = (assessments[oldestStableIdx] as any).assessment_date || null;
            }
          }

          // Common event update payload
          const eventUpdate: Record<string, unknown> = {
            clinical_summary: clinicalSummary,
            trigger_resolved: triggerResolved,
            updated_at: new Date().toISOString(),
          };
          eventUpdate.stable_since = stableSince; // null when stability lost → clears DB field

          // ── Ownership logic ──
          // Determine primary/secondary therapist based on crisis context
          const crisisTasksForPart = (pendingTasks || []).filter((t: any) =>
            t.category === "crisis" && (t.task || "").toLowerCase().includes(partName.toLowerCase())
          );
          const hankaTasks = crisisTasksForPart.filter((t: any) => t.assigned_to === "hanka").length;
          const kataTasks = crisisTasksForPart.filter((t: any) => t.assigned_to === "kata").length;
          
          // Default: Hanka leads crisis (local, direct contact), Kata supports (remote)
          if (hankaTasks > 0 || kataTasks > 0) {
            eventUpdate.primary_therapist = hankaTasks >= kataTasks ? "hanka" : "kata";
            eventUpdate.secondary_therapist = hankaTasks >= kataTasks ? (kataTasks > 0 ? "kata" : null) : "hanka";
            eventUpdate.ownership_source = "explicit";
          } else if (!event.primary_therapist) {
            // No tasks yet → default to hanka for crisis (local work)
            eventUpdate.primary_therapist = "hanka";
            eventUpdate.secondary_therapist = "kata";
            eventUpdate.ownership_source = "explicit";
          }

          // ── Daily cycle tracking ──
          const nowHour = new Date().getUTCHours() + 1; // rough CET offset
          if (nowHour >= 6 && nowHour < 12) {
            eventUpdate.last_morning_review_at = new Date().toISOString();
          } else if (nowHour >= 12 && nowHour < 18) {
            eventUpdate.last_afternoon_review_at = new Date().toISOString();
          } else {
            eventUpdate.last_evening_decision_at = new Date().toISOString();
          }

          // ── Required outputs ──
          const requiredOutputs: Array<{ label: string; fulfilled: boolean }> = [
            { label: "Aktuální stav", fulfilled: !!latest && latest.assessment_date >= todayDate },
            { label: "Výsledek posledního zásahu", fulfilled: !!(event as any).last_outcome_recorded_at && (event as any).last_outcome_recorded_at >= todayDate + "T00:00:00" },
            { label: "Potvrzení bezpečí", fulfilled: !!checklist?.no_risk_signals },
            { label: "Kontakt dne", fulfilled: !!latest && latest.assessment_date >= todayDate },
            { label: "Zpětná vazba terapeutek", fulfilled: !!(latest?.therapist_hana_input || latest?.therapist_kata_input) },
            { label: "Karlovo rozhodnutí", fulfilled: !!latest?.karel_decision },
          ];
          eventUpdate.today_required_outputs = requiredOutputs;

          // Awaiting response from
          const awaitingFrom: string[] = [];
          if (!latest || latest.assessment_date < todayDate) {
            awaitingFrom.push("hanka"); // primary always owes daily update
          }
          if (checklist && !checklist.kata_agrees && (checklist.emotional_stable_days || 0) >= 3) {
            awaitingFrom.push("kata");
          }
          eventUpdate.awaiting_response_from = awaitingFrom;

          // ── Daily checklist ──
          const dailyChecklist = {
            statusChecked: !!latest && latest.assessment_date >= todayDate,
            lastUpdateVerified: !!latest,
            safetyConfirmed: !!checklist?.no_risk_signals,
            contactCompleted: !!latest && latest.assessment_date >= todayDate,
            interventionRecorded: !!(event as any).last_outcome_recorded_at,
            therapistsResponded: !!(latest?.therapist_hana_input || latest?.therapist_kata_input),
            nextStepDetermined: !!latest?.karel_decision,
            decisionMade: !!latest?.karel_decision && latest.karel_decision !== "needs_more_data",
          };
          eventUpdate.daily_checklist = dailyChecklist;

          // ── Crisis meeting trigger ──
          const hoursSinceLastContact = latest?.assessment_date
            ? (Date.now() - new Date(latest.assessment_date + "T12:00:00Z").getTime()) / 3_600_000
            : 999;
          
          // Check for stagnation (3+ assessments with no improvement)
          let isStagnating = false;
          if (assessments.length >= 3) {
            const last3 = assessments.slice(-3);
            const riskOrder2: Record<string, number> = { minimal: 1, low: 2, moderate: 3, high: 4, critical: 5 };
            const risks2 = last3.map((a: any) => riskOrder2[a.karel_risk_assessment] ?? 3);
            isStagnating = risks2[2] >= risks2[0] && risks2.every(r => r >= 3);
          }

          const meetingNeeded = 
            hoursSinceLastContact > 48 ||
            isStagnating ||
            !event.primary_therapist;
          
          eventUpdate.crisis_meeting_required = meetingNeeded;
          if (meetingNeeded) {
            const reasons: string[] = [];
            if (hoursSinceLastContact > 48) reasons.push("48h+ bez update");
            if (isStagnating) reasons.push("stagnace rizika");
            if (!event.primary_therapist) reasons.push("nejasný ownership");
            eventUpdate.crisis_meeting_reason = reasons.join(", ");
          } else {
            eventUpdate.crisis_meeting_reason = null;
          }

          if (fullReady && allIndicatorsAbove5 && latest?.karel_decision !== "crisis_continues") {
            // Propose READY_TO_CLOSE
            eventUpdate.phase = "ready_to_close";
            await sb.from("crisis_events").update(eventUpdate).eq("id", event.id);
            await sb.from("system_health_log").insert({
              event_type: "crisis_closure_ready",
              severity: "info",
              message: `✅ READY_TO_CLOSE: ${partName} — ${clinicalSummary}`,
            });
            closureProposals++;
          } else if (clinicalReady && allIndicatorsAbove5) {
            // Clinical conditions met — move to stabilizing, write summary
            if (event.phase === "active" || event.phase === "intervened") {
              eventUpdate.phase = "stabilizing";
            }
            await sb.from("crisis_events").update(eventUpdate).eq("id", event.id);
            if (!checklist.karel_recommends_closure) {
              await sb.from("system_health_log").insert({
                event_type: "crisis_closure_proposal_pending",
                severity: "info",
                message: `📋 ${partName} — ${clinicalSummary} Čeká na Karlovo doporučení a souhlas terapeutek.`,
              });
            }
          } else {
            // Not yet ready — still write summary + trigger_resolved for transparency
            await sb.from("crisis_events").update(eventUpdate).eq("id", event.id);
          }

          // ── Auto-create crisis meeting if required and none exists ──
          if (eventUpdate.crisis_meeting_required && event.id) {
            try {
              const { data: existingMeeting } = await sb
                .from("did_meetings")
                .select("id")
                .eq("crisis_event_id", event.id)
                .in("status", ["pending", "active", "in_progress"])
                .limit(1);

              if (!existingMeeting || existingMeeting.length === 0) {
                const meetingReason = eventUpdate.crisis_meeting_reason || "Automaticky vyžádána";
                const meetingTopic = `Krizová porada: ${partName} (den ${event.days_active || "?"})`;
                const meetingAgenda = [
                  `Důvod: ${meetingReason}`,
                  `Aktuální fáze: ${eventUpdate.phase || event.phase || "active"}`,
                  `Severity: ${event.severity || "moderate"}`,
                  eventUpdate.clinical_summary ? `Klinické shrnutí: ${eventUpdate.clinical_summary}` : null,
                  `\nBody k projednání:`,
                  `1. Aktuální stav ${partName}`,
                  `2. Ownership krize — kdo vede?`,
                  `3. Výsledek posledního zásahu`,
                  `4. Další kroky a rozhodnutí`,
                ].filter(Boolean).join("\n");

                await sb.from("did_meetings").insert({
                  topic: meetingTopic,
                  agenda: meetingAgenda,
                  status: "pending",
                  crisis_event_id: event.id,
                  triggered_by: "karel_analyst_loop",
                  messages: [],
                });
                console.log(`[ANALYST] Auto-created crisis meeting for ${partName}`);
              }
            } catch (meetingErr) {
              console.warn(`[ANALYST] Failed to auto-create crisis meeting for ${partName}:`, meetingErr);
            }
          }
        }
      } catch (assessErr) {
        console.warn(`[ANALYST] Crisis assessment check error (${crisis.part_name}):`, assessErr);
      }
    }
    console.log(`[ANALYST] Crisis assessment check: ${closureProposals} closure proposals`);

    // ── KROK 6h: Auto crisis journal entries ──────────────────
    for (const crisis of activeCrises || []) {
      try {
        const partName = crisis.part_name || "";
        const matchingAlert2 = (crisisAlerts || []).find((a: any) => a.part_name?.toUpperCase() === partName.toUpperCase());
        const journalCrisisId = matchingAlert2?.id || crisis.id;

        const { data: existingJournal } = await sb
          .from("crisis_journal")
          .select("id")
          .eq("crisis_alert_id", journalCrisisId)
          .eq("date", todayDate)
          .limit(1);

        if (!existingJournal || existingJournal.length === 0) {
          const trendLabel = crisis.stable_since ? "stabilizující" :
            crisis.phase === "active" ? "aktivní" :
            crisis.phase === "stabilizing" ? "stabilizující" :
            crisis.phase === "ready_to_close" ? "připraveno k uzavření" : crisis.phase || "?";

          await sb.from("crisis_journal").insert({
            crisis_alert_id: journalCrisisId,
            crisis_event_id: crisis.id,
            part_id: partName,
            date: todayDate,
            day_number: crisis.days_active || 1,
            crisis_trend: trendLabel,
            karel_action: `Analyst-loop ${cycleTime} — review proběhl`,
            karel_notes: (crisis.clinical_summary || "").slice(0, 500) || null,
            session_summary: crisis.last_outcome_recorded_at ? "Sezení proběhlo" : "Žádné sezení dnes",
            what_worked: crisis.trigger_resolved ? "Trigger zvládnut" : null,
            what_failed: !crisis.trigger_resolved && (crisis.days_active || 0) > 3 ? "Trigger stále aktivní" : null,
            hanka_cooperation: crisis.primary_therapist === "hanka" ? "vede" : "podpora",
            kata_cooperation: crisis.primary_therapist === "kata" ? "vede" : "podpora",
          });
          console.log(`[ANALYST] Auto crisis journal entry for ${partName} (${todayDate})`);
        }
      } catch (journalErr) {
        console.warn(`[ANALYST] Crisis journal error (${crisis.part_name}):`, journalErr);
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

    // ── KROK 6d: Zápis 05A_OPERATIVNI_PLAN na Drive ───────
    let plan05AWritten = false;
    try {
      const token = await getAccessToken();
      const kartotekaRoot = await resolveKartotekaRoot(token);

      if (kartotekaRoot) {
        const centrumFolderId = await findFolder(token, "00_CENTRUM", kartotekaRoot);

        if (centrumFolderId) {
          const plan05AFileId = await findFileByName(token, "05A_OPERATIVNI_PLAN", centrumFolderId);

          if (plan05AFileId) {
            const plan05AContent = build05AContent(
              todayDate,
              cycleTime,
              analysisJson,
              activeCrises || [],
              pendingTasks || [],
              sessionPlans || [],
              pendingQuestions || [],
              commitments || [],
              activePartsRegistry || [],
              recentThreadParts,
              recoveryPlans,
              crisisInterviews || [],
              crisisSessionQuestions || [],
              crisisMeetings || [],
            );

            await overwriteDoc(token, plan05AFileId, plan05AContent);
            plan05AWritten = true;
            console.log(`[ANALYST] 05A_OPERATIVNI_PLAN written: ${plan05AContent.length} chars`);
          } else {
            console.warn("[ANALYST] 05A_OPERATIVNI_PLAN doc nenalezen v 00_CENTRUM");
          }
        }
      }
    } catch (plan05AErr) {
      console.warn("[ANALYST] 05A Drive zápis selhal (non-fatal):", plan05AErr);
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

    // ── KROK 7f: Therapist crisis profiling (fire-and-forget) ──
    if ((activeCrises?.length || 0) > 0) {
      try {
        const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
        const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
        fetch(`${supabaseUrl}/functions/v1/karel-therapist-crisis-review`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${serviceKey}`,
          },
          body: JSON.stringify({ mode: "auto" }),
        }).then(r => console.log(`[ANALYST] Therapist crisis review triggered: ${r.status}`))
          .catch(e => console.warn(`[ANALYST] Therapist crisis review trigger failed:`, e));
      } catch (e) {
        console.warn("[ANALYST] Cannot trigger therapist crisis review:", e);
      }
    }

    // ── KROK 7g: Daily crisis cycle computation (fire-and-forget) ──
    if ((activeCrises?.length || 0) > 0) {
      try {
        const supabaseUrl2 = Deno.env.get("SUPABASE_URL")!;
        const serviceKey2 = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
        fetch(`${supabaseUrl2}/functions/v1/karel-crisis-daily-cycle`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${serviceKey2}`,
          },
          body: JSON.stringify({ action: "compute" }),
        }).then(r => console.log(`[ANALYST] Daily crisis cycle triggered: ${r.status}`))
          .catch(e => console.warn(`[ANALYST] Daily crisis cycle trigger failed:`, e));
      } catch (e) {
        console.warn("[ANALYST] Cannot trigger daily crisis cycle:", e);
      }
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
      `05A_drive: ${plan05AWritten ? "written" : "skipped"}`,
      `crisis_follow: ${crisisTasksCreated}t ${crisisSessionsPlanned}s`,
      `stale_follow: ${staleTasksCreated}t ${staleQuestionsCreated}q`,
      `recovery: ${recoveryPlans.length} plans, ${recoveryTasksCreated}t ${recoveryQuestionsCreated}q ${recoverySessionsCreated}s`,
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
