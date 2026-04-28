/**
 * karel-did-session-evaluate
 *
 * Vyhodnocovací funkce pro DID sezení vedená v Pracovně (LIVE program
 * skrz BlockDiagnosticChat / LiveProgramChecklist).
 *
 * Volaná dvěma cestami:
 *   1) z UI po stisku "Ukončit a vyhodnotit" (i částečné — `endedReason='partial'|'completed'`)
 *   2) z karel-did-daily-cycle Phase 8A.5 jako safety-net pro plány,
 *      které zůstaly `in_progress` přes noc (`endedReason='auto_safety_net'`)
 *
 * Vstup:
 *   {
 *     planId: string                 // did_daily_session_plans.id (povinné)
 *     completedBlocks?: number       // kolik bodů programu Hana označila done
 *     totalBlocks?: number
 *     endedReason?: 'completed'|'partial'|'auto_safety_net'
 *     turnsByBlock?: Record<number, Array<{from:'karel'|'hana', text:string}>>
 *                                    // konverzace per blok z LiveProgramChecklist
 *     observationsByBlock?: Record<number, string>
 *                                    // textová pozorování per blok
 *   }
 *
 * Co dělá:
 *   1) Načte plán + bloky + threadId pokud existuje + kartu části + profil terapeutky
 *   2) Vygeneruje strukturovanou evaluaci (Gemini 2.5 Pro, tool-calling)
 *      s důrazem na CHILD_PERSPECTIVE; therapist_motivation jen sekundárně.
 *   3) IDEMPOTENTNĚ zapíše do:
 *      - did_part_sessions (UPDATE: ai_analysis, methods_*, karel_*, tasks_*)
 *      - did_daily_session_plans (status=completed)
 *      - karel_pantry_b_entries (1× conclusion + N× followup_need + případně hypothesis_change)
 *      - did_pantry_packages (session_summary balík → KARTA_<part>)
 *
 * Idempotence: rozpoznává "už vyhodnocené" sezení podle
 * `did_part_sessions.ai_analysis` neprázdného + `did_daily_session_plans.completed_at`
 * + per-planId source_ref ve Spižírně B / Pantry packages.
 * Při force=true (admin replay) přepíše.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.50.0";
import { appendPantryB } from "../_shared/pantryB.ts";
import { encodeGovernedWrite } from "../_shared/documentWriteEnvelope.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const AI_URL = "https://ai.gateway.lovable.dev/v1/chat/completions";
const MODEL = "google/gemini-2.5-pro";
const PAMET_KAREL_HANKA_INSIGHTS_TARGET =
  "PAMET_KAREL/DID/HANKA/KARLOVY_POZNATKY";
const PAMET_KAREL_DEDUPE_STATUSES = [
  "pending",
  "completed",
  "failed",
  "failed_permanent",
  "skipped",
];

type EndedReason =
  | "completed"
  | "partial"
  | "auto_safety_net"
  | "manual_end"
  | "save_transcript"
  | "exit_session";

const pragueDayISO = (d: Date = new Date()): string =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Prague" }).format(d);

const SESSION_EVAL_TOOL = {
  type: "function",
  function: {
    name: "emit_session_evaluation",
    description:
      "Vrátí strukturovanou klinickou evaluaci právě skončeného DID sezení. " +
      "DŮRAZ: hlavní pozornost na PROŽITEK A POSUN ČÁSTI (dítěte). " +
      "Práce a motivace terapeutky je SEKUNDÁRNÍ — pojmenuj v jedné větě, jak to ustála.",
    parameters: {
      type: "object",
      properties: {
        completion_status: {
          type: "string",
          enum: ["completed", "partial", "abandoned"],
          description:
            "completed = celý program; partial = část programu; abandoned = sotva začalo.",
        },
        incomplete_note: {
          type: "string",
          description:
            "Pokud completion_status≠'completed': 1-2 věty čeho se nestihlo a co s tím pro další sezení. Jinak prázdné.",
        },
        session_arc: {
          type: "string",
          description:
            "Stručný oblouk sezení (3-5 vět). Co se dělo blok po bloku, kde nastal posun, kde uvíznutí. Konkrétní jména bloků z programu.",
        },
        child_perspective: {
          type: "string",
          description:
            "PRIMÁRNÍ OBSAH — 4-7 vět o tom, jak na tom byla část (např. Tundrupek). " +
            "Co prožívala, co fungovalo / nefungovalo Z POHLEDU DÍTĚTE, regrese / progrese, " +
            "riziko retraumatizace, citlivá místa, kde se otevřela vs. uzavřela. " +
            "Pojmenuj konkrétní momenty z konverzace, ne obecné fráze.",
        },
        therapist_motivation: {
          type: "string",
          description:
            "SEKUNDÁRNÍ vrstva (1-2 věty). Jak to terapeutka ustála, kde byla skvělá, co ji posílilo / vyčerpalo. " +
            "Jméno terapeutky uvádej (Hanička, Káťa). NEMORALIZUJ.",
        },
        methods_used: {
          type: "array",
          items: { type: "string" },
          description:
            "Konkrétní použité techniky (např. 'asociační test 8 slov', 'kresba Strážce spánku', 'simultánní šachy'). " +
            "Vycházej z bloků programu a reálné konverzace, NEvymýšlej.",
        },
        methods_effectiveness: {
          type: "array",
          description: "Per použitá metoda: efektivita + 1 věta proč.",
          items: {
            type: "object",
            properties: {
              method: { type: "string" },
              rating: { type: "string", enum: ["✅", "⚠️", "❌"] },
              note: { type: "string", description: "1 věta proč." },
            },
            required: ["method", "rating", "note"],
            additionalProperties: false,
          },
        },
        key_insights: {
          type: "array",
          items: { type: "string" },
          description:
            "2-4 klinické závěry / hypotézy z dnešního sezení. Konkrétní, ne 'pokračovat v práci'.",
          minItems: 1,
          maxItems: 4,
        },
        implications_for_tomorrow: {
          type: "string",
          description:
            "2-4 věty: co z dnešního sezení plyne pro další postup. Konkrétní směr, ne 'dál sledovat'.",
        },
        tasks: {
          type: "array",
          description: "Konkrétní úkoly vzniklé ze sezení.",
          items: {
            type: "object",
            properties: {
              owner: {
                type: "string",
                enum: ["hanka", "kata", "karel", "both"],
              },
              urgency: { type: "string", enum: ["high", "normal", "low"] },
              text: { type: "string" },
            },
            required: ["owner", "urgency", "text"],
            additionalProperties: false,
          },
          maxItems: 6,
        },
        recommended_next_step: {
          type: "string",
          description:
            "Návrh dalšího sezení / pauzy / krizové intervence (1-2 věty). " +
            "Konkrétní část, kdy, proč, jakou metodou.",
        },
        detailed_analysis_text: {
          type: "string",
          description:
            "Detailní profesionální analýza Sezení: role terapeutky, role Karla jako live asistenta, program, proběhlé bloky, pozorování vs hypotézy, limity evidence, rizika, stabilizační/destabilizační faktory a doporučení.",
        },
        practical_report_text: {
          type: "string",
          description:
            "Kratší praktický report pro Karlův přehled: co se stalo, co víme o části, co z toho plyne pro kluky, co mají terapeutky udělat, čemu se vyvarovat a doporučení pro další Sezení/Hernu.",
        },
        team_closing_text: {
          type: "string",
          description:
            "Konkrétní týmové uzavření navázané na průběh Sezení; poděkování terapeutce/terapeutkám a posílení týmové soudržnosti bez obecné fráze.",
        },
        implications_for_part: { type: "string" },
        implications_for_system: { type: "string" },
        recommendations_for_therapists: { type: "string" },
        recommendations_for_next_session: { type: "string" },
        recommendations_for_next_playroom: { type: "string" },
        risks: { type: "array", items: { type: "string" } },
        evidence_limitations: { type: "string" },
        what_not_to_do: { type: "array", items: { type: "string" } },
      },
      required: [
        "completion_status",
        "session_arc",
        "child_perspective",
        "therapist_motivation",
        "methods_used",
        "methods_effectiveness",
        "key_insights",
        "implications_for_tomorrow",
        "tasks",
        "recommended_next_step",
        "detailed_analysis_text",
        "practical_report_text",
        "team_closing_text",
        "implications_for_part",
        "implications_for_system",
        "recommendations_for_therapists",
        "recommendations_for_next_session",
        "recommendations_for_next_playroom",
        "evidence_limitations",
      ],
      additionalProperties: false,
    },
  },
};

const SYSTEM_PROMPT = `Jsi Karel — klinický supervizor a vedoucí terapeutického týmu (Hanička, Káťa).
Právě skončilo (nebo bylo přerušeno) sezení s jednou z částí systému kluků.
Vyhodnocuješ ho retrospektivně.

ABSOLUTNÍ PRAVIDLA:
- ŽÁDNÉ "systém"/"DID systém". Vždy "kluci" nebo konkrétní jméno části.
- ŽÁDNÝ "klient". Kluci jsou kluci.
- HLAVNÍ DŮRAZ = PROŽITEK ČÁSTI (dítěte). Jak na tom bylo, co prožívalo, co fungovalo / nefungovalo z jeho pohledu.
- Sezení je THERAPIST-LED: fyzicky ho vede terapeutka; Karel je live real-time asistent terapeutky, ne přímý vedoucí dítěte.
- Práce terapeutky (Hanička / Káťa) je důležitá týmová vrstva, ale klinické závěry odděluj od podpory terapeutky.
- Pokud sezení nebylo dokončené, NEPŘEDSTÍREJ, že bylo. Explicitně to napiš v completion_status + incomplete_note,
  a vyhodnoť POUZE to, co reálně proběhlo. Nevymýšlej si bloky, které nikdo neudělal.

ANTI-FABRIKACE:
- Vycházej VÝHRADNĚ z poskytnutého: programu sezení, konverzace per blok, observací,
  karty části. Pokud něco v datech nemáš, napiš "nebylo zaznamenáno", NIKDY nefabrikuj.
- ABSENCE ZÁZNAMU NENÍ DŮKAZ, ŽE SEZENÍ NEPROBĚHLO. Pokud chybí průběhová data,
  napiš, že chybí záznam o průběhu / formálním ukončení; nesmíš tvrdit, že sezení
  bylo sotva začaté, přerušeno nebo neuskutečněno.
- Pokud většina bodů programu proběhla, completion_status nesmí být abandoned.
- Pokud liveProgress obsahuje LIVE_REPLAN_PATCH / reality override, rozliš tři vrstvy evidence:
  1. therapist_factual_correction = faktický rámec od terapeutky, NENÍ klinický důkaz o části.
  2. verified_external_fact = ověřená externí informace, NENÍ klinický důkaz o části.
  3. child_response_to_event = vlastní slova, afekt, tělesná reakce nebo chování části; pouze to může být klinický materiál.
- Nesmíš udělat závěr typu „externí událost uvízla → část se cítí uvězněná“. Smíš říct: „Událost byla faktickým rámcem; klinický význam lze posuzovat až podle reakce části.“

TÓN:
- Kultivovaná čeština. Konkrétně, klinicky, bez patosu.
- Žádné "celkově to byl posun" / "skvělá práce" — místo toho konkrétní moment z dat.

Vrať VÝHRADNĚ tool call emit_session_evaluation.

POVINNÉ ROZDĚLENÍ VÝSTUPU:
- detailed_analysis_text = odborná detailní analýza, delší a strukturovaná.
- practical_report_text = kratší report pro Karlův přehled a další plánování.
- team_closing_text = konkrétní týmové uzavření navázané na průběh Sezení.
- Pokud evidence nestačí, nevyplňuj falešnou plnou analýzu; jasně popiš limity a bezpečný další krok.`;

interface SessionPlan {
  id: string;
  user_id: string;
  plan_date: string;
  selected_part: string;
  therapist: string;
  session_lead?: string | null;
  session_format?: string | null;
  plan_markdown: string | null;
  urgency_breakdown?: Record<string, any> | null;
  status: string;
  lifecycle_status?: string | null;
  program_status?: string | null;
  completed_at: string | null;
  crisis_event_id: string | null;
}

const PROGRAM_START_BLOCKED_STATUSES = new Set([
  "draft",
  "in_revision",
  "awaiting_signatures",
  "awaiting_signature",
  "pending_review",
]);

function assertPlanWasApprovedAndStarted(plan: SessionPlan) {
  const contract =
    plan.urgency_breakdown && typeof plan.urgency_breakdown === "object"
      ? plan.urgency_breakdown
      : {};
  const programStatus = String(
    plan.program_status ||
      contract.review_state ||
      contract.approval?.review_state ||
      "",
  ).toLowerCase();
  const humanReviewRequired =
    contract.human_review_required === true ||
    contract.approval?.required === true ||
    contract.playroom_plan?.approval?.required === true ||
    contract.playroom_plan?.therapist_review?.required === true;
  const reviewFulfilled =
    ["approved", "ready_to_start", "in_progress", "completed"].includes(
      programStatus,
    ) || !!contract.approved_at;
  const childFacingPlayroom =
    contract.session_actor === "karel_direct" ||
    contract.ui_surface === "did_kids_playroom" ||
    contract.mode === "playroom" ||
    !!contract.playroom_plan;
  const approvedForChild =
    contract.approved_for_child_session === true ||
    contract.approval?.approved_for_child_session === true ||
    contract.playroom_plan?.approval?.approved_for_child_session === true ||
    contract.playroom_plan?.therapist_review?.approved_for_child_session ===
      true;
  const activeLifecycle =
    ["in_progress", "pending_review", "done", "completed"].includes(
      String(plan.status || "").toLowerCase(),
    ) ||
    ["in_progress", "pending_review", "done", "completed"].includes(
      String(plan.lifecycle_status || "").toLowerCase(),
    );

  if (
    !activeLifecycle ||
    (humanReviewRequired && !reviewFulfilled) ||
    PROGRAM_START_BLOCKED_STATUSES.has(programStatus) ||
    (childFacingPlayroom && !approvedForChild)
  ) {
    const err = new Error(
      "Program byl upraven podle odpovědi terapeutky a čeká na podpis Haničky a Káti.",
    );
    (err as any).status = 403;
    throw err;
  }
}

type ReviewStatus =
  | "analyzed"
  | "partially_analyzed"
  | "evidence_limited"
  | "pending_review"
  | "analysis_running"
  | "failed_retry"
  | "failed_analysis"
  | "cancelled";
type KarelDirectOutcome =
  | "completed"
  | "partial"
  | "unavailable"
  | "deferred"
  | "actual_part_differs";

interface PartSessionRow {
  id: string;
  user_id: string;
  part_name: string;
  therapist: string;
  session_date: string;
  session_type: string;
  ai_analysis: string | null;
  methods_used: any;
  methods_effectiveness: any;
  karel_notes: string | null;
  karel_therapist_feedback: string | null;
  tasks_assigned: any;
  thread_id: string | null;
}

interface SessionReviewRow {
  id: string;
  user_id: string;
  plan_id: string | null;
  part_name: string | null;
  session_date: string | null;
  status: ReviewStatus | string;
  team_implications: string | null;
  therapeutic_implications: string | null;
  next_session_recommendation: string | null;
  evidence_limitations: string | null;
}

function isPlayroomPlan(plan: SessionPlan): boolean {
  const contract =
    plan.urgency_breakdown && typeof plan.urgency_breakdown === "object"
      ? (plan.urgency_breakdown as Record<string, any>)
      : {};
  return (
    contract.ui_surface === "did_kids_playroom" ||
    contract.session_actor === "karel_direct" ||
    (contract.playroom_plan && typeof contract.playroom_plan === "object")
  );
}

interface PartCardLookup {
  status: "resolved" | "missing" | "ambiguous";
  reason: string;
  selected_part: string;
  canonical_part_name: string | null;
  registry_id: string | null;
  candidates: Array<{
    id: string;
    part_name: string;
    display_name?: string | null;
    status?: string | null;
    drive_folder_label?: string | null;
    updated_at?: string | null;
  }>;
}

function normalizePartLookupKey(value: string | null | undefined): string {
  return String(value ?? "")
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[_\-]+/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function partCandidateNames(row: any): string[] {
  const aliases = Array.isArray(row?.aliases)
    ? row.aliases
    : Array.isArray(row?.metadata?.aliases)
      ? row.metadata.aliases
      : [];
  return [
    row?.part_name,
    row?.display_name,
    row?.drive_folder_label,
    ...aliases,
  ]
    .filter(Boolean)
    .map(String);
}

function scorePartCandidate(row: any, selectedPart: string): number[] {
  const selectedTrim = selectedPart.trim();
  const selectedNorm = normalizePartLookupKey(selectedTrim);
  const partNorm = normalizePartLookupKey(row?.part_name);
  const displayNorm = normalizePartLookupKey(row?.display_name);
  const driveNorm = normalizePartLookupKey(row?.drive_folder_label);
  const statusNorm = normalizePartLookupKey(row?.status);
  const uppercaseCanonical =
    row?.part_name === String(row?.part_name ?? "").toUpperCase() &&
    row?.display_name === String(row?.display_name ?? "").toUpperCase();
  return [
    uppercaseCanonical ? 1 : 0,
    row?.part_name === selectedTrim ? 1 : 0,
    partNorm === selectedNorm ? 1 : 0,
    displayNorm &&
    displayNorm === partNorm &&
    row?.display_name === String(row?.display_name ?? "").toUpperCase()
      ? 1
      : 0,
    driveNorm.includes(partNorm) || driveNorm.includes(selectedNorm) ? 1 : 0,
    statusNorm === "active" || statusNorm === "aktivni" ? 1 : 0,
    Date.parse(row?.updated_at ?? "") || 0,
  ];
}

function comparePartScores(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

async function resolveCanonicalPart(
  sb: any,
  userId: string,
  selectedPart: string,
): Promise<{ partCard: any | null; lookup: PartCardLookup }> {
  const selectedNorm = normalizePartLookupKey(selectedPart);
  const { data: registryRows, error } = await sb
    .from("did_part_registry")
    .select(
      "id, part_name, display_name, status, drive_folder_label, age_estimate, role_in_system, last_emotional_state, updated_at",
    )
    .eq("user_id", userId);
  if (error) throw error;

  const candidates = (registryRows ?? []).filter((row: any) =>
    partCandidateNames(row).some((name) => {
      const norm = normalizePartLookupKey(name);
      return (
        norm === selectedNorm ||
        norm.includes(selectedNorm) ||
        selectedNorm.includes(norm)
      );
    }),
  );

  const candidateSummary = candidates.map((c: any) => ({
    id: c.id,
    part_name: c.part_name,
    display_name: c.display_name ?? null,
    status: c.status ?? null,
    drive_folder_label: c.drive_folder_label ?? null,
    updated_at: c.updated_at ?? null,
  }));

  if (candidates.length === 0) {
    console.warn("[evaluate] part_lookup_missing", {
      selectedPart,
      selectedNorm,
    });
    return {
      partCard: null,
      lookup: {
        status: "missing",
        reason: "no_registry_candidate",
        selected_part: selectedPart,
        canonical_part_name: null,
        registry_id: null,
        candidates: [],
      },
    };
  }

  const ranked = candidates
    .map((row: any) => ({ row, score: scorePartCandidate(row, selectedPart) }))
    .sort((a: any, b: any) => comparePartScores(b.score, a.score));
  const top = ranked[0];
  const second = ranked[1];
  if (second && comparePartScores(top.score, second.score) === 0) {
    console.warn("[evaluate] ambiguous_part_lookup", {
      selectedPart,
      candidates: candidateSummary,
    });
    return {
      partCard: null,
      lookup: {
        status: "ambiguous",
        reason: "multiple_equal_registry_candidates",
        selected_part: selectedPart,
        canonical_part_name: null,
        registry_id: null,
        candidates: candidateSummary,
      },
    };
  }

  if (candidates.length > 1) {
    console.warn("[evaluate] canonical_part_lookup_multiple_candidates", {
      selectedPart,
      selected: top.row.id,
      candidates: candidateSummary,
    });
  }
  return {
    partCard: top.row,
    lookup: {
      status: "resolved",
      reason:
        candidates.length > 1
          ? "resolved_by_priority"
          : "single_registry_candidate",
      selected_part: selectedPart,
      canonical_part_name: top.row.part_name,
      registry_id: top.row.id,
      candidates: candidateSummary,
    },
  };
}

async function loadContext(sb: any, planId: string) {
  const { data: plan, error: planErr } = await sb
    .from("did_daily_session_plans")
    .select("*")
    .eq("id", planId)
    .maybeSingle();
  if (planErr) throw planErr;
  if (!plan) throw new Error(`Plán sezení ${planId} nenalezen.`);

  // Najít odpovídající did_part_sessions row (vznikne při schválení porady).
  // Match: stejný part + stejný session_date.
  const { data: existingSession } = await sb
    .from("did_part_sessions")
    .select("*")
    .eq("part_name", plan.selected_part)
    .eq("session_date", plan.plan_date)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  // Thread evidence must be linked to this exact plan. Do not attach another session's
  // Karel-direct opener to a therapist-led plan just because part/date match.
  let exactThreadQuery = sb
    .from("did_threads")
    .select(
      "id, part_name, sub_mode, started_at, last_activity_at, messages, workspace_type, workspace_id",
    )
    .eq("workspace_type", "session")
    .eq("workspace_id", planId);
  if (isPlayroomPlan(plan as SessionPlan))
    exactThreadQuery = exactThreadQuery.eq("sub_mode", "karel_part_session");
  const { data: exactThreads } = await exactThreadQuery
    .order("last_activity_at", { ascending: false })
    .limit(3);
  const threadCandidates: any[] = exactThreads ?? [];

  // Karta části (DB-side mirror) — deterministický resolver místo nejednoznačného ilike+maybeSingle.
  const { partCard, lookup: partCardLookup } = await resolveCanonicalPart(
    sb,
    plan.user_id,
    plan.selected_part,
  );

  return {
    plan: plan as SessionPlan,
    existingSession: (existingSession ?? null) as PartSessionRow | null,
    threads: threadCandidates ?? [],
    partCard: partCard ?? null,
    partCardLookup,
  };
}

function formatBlockTurnsForPrompt(
  turnsByBlock: Record<string, Array<{ from: string; text: string }>> = {},
  observationsByBlock: Record<string, string> = {},
): string {
  const blockKeys = Array.from(
    new Set([
      ...Object.keys(turnsByBlock),
      ...Object.keys(observationsByBlock),
    ]),
  ).sort((a, b) => Number(a) - Number(b));
  if (blockKeys.length === 0)
    return "(žádný turn-by-turn log z bloků nebyl předán)";
  return blockKeys
    .map((k) => {
      const turns = (turnsByBlock[k] ?? []).slice(0, 30);
      const obs = (observationsByBlock[k] ?? "").trim();
      const turnsBlock = turns.length
        ? turns
            .map(
              (t) =>
                `  ${t.from === "karel" ? "K" : "H"}: ${(t.text || "").slice(0, 400)}`,
            )
            .join("\n")
        : "  (bez konverzace)";
      const obsBlock = obs ? `\n  📝 pozorování: ${obs.slice(0, 400)}` : "";
      return `▸ Bod #${Number(k) + 1}\n${turnsBlock}${obsBlock}`;
    })
    .join("\n\n");
}

function formatThreadMessagesForPrompt(
  threads: any[],
  plan: SessionPlan,
): string {
  if (!threads || threads.length === 0) return "(žádné thread vlákno k sezení)";
  const messages: Array<{ ts?: string; role: string; content: string }> = [];
  for (const t of threads) {
    const arr = Array.isArray(t.messages) ? t.messages : [];
    for (const m of arr) {
      messages.push({
        ts: m.timestamp || m.ts,
        role: String(m.role || "?"),
        content: String(m.content || "").slice(0, 600),
      });
    }
  }
  // Ořež na den sezení a max 40 zpráv.
  const dayPrefix = plan.plan_date;
  const filtered = messages
    .filter((m) => !m.ts || String(m.ts).startsWith(dayPrefix))
    .slice(-40);
  if (filtered.length === 0) {
    return (
      `(thread existuje, ale žádná zpráva ze dne ${plan.plan_date}; používám i mimo-denní vzorek)\n` +
      messages
        .slice(-15)
        .map((m) => `${m.role}: ${m.content}`)
        .join("\n")
    );
  }
  return filtered.map((m) => `${m.role}: ${m.content}`).join("\n");
}

async function loadLiveProgress(sb: any, planId: string) {
  const { data } = await sb
    .from("did_live_session_progress")
    .select(
      "items, turns_by_block, artifacts_by_block, completed_blocks, total_blocks, finalized_reason, post_session_result, last_activity_at, current_block_status, active_live_replan_id, live_replan_patch, reality_verification",
    )
    .eq("plan_id", planId)
    .maybeSingle();
  return data ?? null;
}

async function enqueueSessionEvaluationJob(
  sb: any,
  ctx: any,
  payload: Record<string, any>,
) {
  const now = new Date().toISOString();
  const dedupeKey = `session_evaluation:${ctx.plan.id}`;
  const { data: existing } = await sb
    .from("karel_action_jobs")
    .select("*")
    .eq("job_type", "session_evaluation")
    .eq("dedupe_key", dedupeKey)
    .in("status", ["pending", "running", "failed_retry", "completed"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existing && !payload.force) return existing;

  const cleanPayload = { ...payload };
  delete cleanPayload.enqueueOnly;
  delete cleanPayload.processJob;
  delete cleanPayload.processPendingJobs;
  const { data, error } = await sb
    .from("karel_action_jobs")
    .insert({
      user_id: ctx.plan.user_id,
      job_type: "session_evaluation",
      status: "pending",
      dedupe_key: dedupeKey,
      source_function: "karel-did-session-evaluate",
      target_type: "did_daily_session_plans",
      target_id: ctx.plan.id,
      plan_id: ctx.plan.id,
      thread_id: (ctx.threads ?? [])[0]?.id ?? null,
      part_name: ctx.plan.selected_part,
      result_payload: cleanPayload,
      result_summary: "Session evaluation queued; waiting for worker.",
      attempt_count: 0,
      created_at: now,
      updated_at: now,
    })
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

async function markJobRunning(sb: any, job: any) {
  const now = new Date().toISOString();
  await sb
    .from("karel_action_jobs")
    .update({
      status: "running",
      started_at: job.started_at ?? now,
      finished_at: null,
      completed_at: null,
      last_error: null,
      error_message: null,
      attempt_count: Number(job.attempt_count ?? 0) + 1,
      updated_at: now,
    })
    .eq("id", job.id);
}

async function markJobCompleted(
  sb: any,
  jobId: string | null,
  result: Record<string, any>,
) {
  if (!jobId) return;
  const now = new Date().toISOString();
  await sb
    .from("karel_action_jobs")
    .update({
      status: "completed",
      review_id: result.review_id ?? null,
      result_payload: result,
      result_summary: `Session evaluation completed: review_id=${result.review_id ?? "n/a"}, status=${result.review_status ?? "n/a"}`,
      finished_at: now,
      completed_at: now,
      updated_at: now,
    })
    .eq("id", jobId);
}

async function markJobFailedRetry(sb: any, jobId: string | null, error: any) {
  if (!jobId) return;
  const now = new Date().toISOString();
  const message = String(error?.message ?? error).slice(0, 1000);
  await sb
    .from("karel_action_jobs")
    .update({
      status: "failed_retry",
      last_error: message,
      error_message: message,
      finished_at: now,
      result_summary:
        "Session evaluation failed safely and is available for retry.",
      updated_at: now,
    })
    .eq("id", jobId);
}

function hasEvidence(
  turnsByBlock: Record<string, any[]>,
  observationsByBlock: Record<string, string>,
  completedBlocks?: number,
): boolean {
  return (
    (completedBlocks ?? 0) > 0 ||
    Object.values(turnsByBlock || {}).some(
      (v) => Array.isArray(v) && v.length > 0,
    ) ||
    Object.values(observationsByBlock || {}).some(
      (v) => String(v || "").trim().length > 0,
    )
  );
}

function countArtifactsByBlock(
  artifactsByBlock: Record<string, any> = {},
): number {
  return Object.values(artifactsByBlock || {}).reduce((sum, value: any) => {
    if (Array.isArray(value)) return sum + value.length;
    if (value && typeof value === "object")
      return sum + Object.keys(value).length;
    return sum;
  }, 0);
}

function hasThreadUserResponse(threads: any[] = []): boolean {
  return threads.some((thread: any) => {
    const messages = Array.isArray(thread?.messages) ? thread.messages : [];
    return messages
      .slice(1)
      .some(
        (m: any) =>
          String(m?.role ?? "").toLowerCase() === "user" &&
          String(m?.content ?? "").trim().length > 0,
      );
  });
}

function sessionStartedEvidence(args: {
  completedBlocks?: number;
  turnsByBlock?: Record<string, any[]>;
  observationsByBlock?: Record<string, string>;
  liveProgress?: any;
  threads?: any[];
}) {
  const completedBlocks =
    args.completedBlocks ?? args.liveProgress?.completed_blocks ?? 0;
  const turns = args.turnsByBlock ?? args.liveProgress?.turns_by_block ?? {};
  const observations = args.observationsByBlock ?? {};
  const artifacts = args.liveProgress?.artifacts_by_block ?? {};
  const postSessionResult =
    args.liveProgress?.post_session_result &&
    typeof args.liveProgress.post_session_result === "object"
      ? args.liveProgress.post_session_result
      : null;
  const reasons = [
    completedBlocks > 0 ? "completed_blocks" : null,
    Object.values(turns || {}).some(
      (v: any) => Array.isArray(v) && v.length > 0,
    )
      ? "turns_by_block"
      : null,
    Object.values(observations || {}).some(
      (v: any) => String(v || "").trim().length > 0,
    )
      ? "observations"
      : null,
    countArtifactsByBlock(artifacts) > 0 ? "artifacts" : null,
    postSessionResult?.provenance === "therapist_entered" ||
    !!postSessionResult?.entered_by
      ? "therapist_entered_result"
      : null,
    hasThreadUserResponse(args.threads ?? [])
      ? "matching_thread_user_response"
      : null,
  ].filter(Boolean) as string[];
  return { started: reasons.length > 0, reasons };
}

function karelDirectHasPartResponse(threads: any[] = []): boolean {
  return threads.some((thread: any) => {
    const messages = Array.isArray(thread?.messages) ? thread.messages : [];
    return messages
      .slice(1)
      .some(
        (m: any) =>
          String(m?.role ?? "").toLowerCase() === "user" &&
          String(m?.content ?? "").trim().length > 0,
      );
  });
}

function inferActualPartIfDiffers(ctx: {
  plan: SessionPlan;
  threads?: any[];
}): string | null {
  const planned = normalizePartLookupKey(ctx.plan.selected_part);
  const text = (ctx.threads ?? [])
    .flatMap((thread: any) =>
      Array.isArray(thread?.messages) ? thread.messages.slice(1) : [],
    )
    .filter((m: any) => String(m?.role ?? "").toLowerCase() === "user")
    .map((m: any) => String(m?.content ?? ""))
    .join("\n");
  if (!text.trim()) return null;
  const normalized = normalizePartLookupKey(text);
  const plannedPattern = planned
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\s+/g, "\\s+");
  if (
    new RegExp(`\\b(?:ja\\s+)?nejsem\\s+${plannedPattern}\\b`).test(normalized)
  )
    return "uncertain";
  if (/\bto\s+nejsem\s+ja\b/.test(normalized)) {
    const afterCorrection = text
      .match(
        /to\s+nejsem\s+j[áa]\s*[,.;:-]?\s*jsem\s+([A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ][\p{L}\s-]{1,32})/u,
      )?.[1]
      ?.trim();
    if (afterCorrection && normalizePartLookupKey(afterCorrection) !== planned)
      return afterCorrection;
    return "uncertain";
  }
  if (/\bnejsem\s+ten\s*,?\s+koho\s+hledas\b/.test(normalized))
    return "uncertain";
  const explicit = text.match(
    /(?:^|[\n.!?]\s*)(?:j[áa]\s+)?(?:jsem|tady je|oz[ýy]v[áa] se|mluv[íi])\s+([A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ][\p{L}\s-]{1,32})/u,
  );
  const candidate = explicit?.[1]?.replace(/[.,;:!?].*$/, "").trim();
  if (candidate && normalizePartLookupKey(candidate) !== planned)
    return candidate;
  return null;
}

function karelDirectEvidenceValidity(args: {
  hasPartResponse: boolean;
  evidencePresent: boolean;
  completedBlocks?: number;
  totalBlocks?: number;
  turnsByBlock?: Record<string, any[]>;
  observationsByBlock?: Record<string, string>;
  liveProgress?: any;
}): "low" | "moderate" | "high" {
  const turnBlocks = countTurnBlocks(args.turnsByBlock ?? {});
  const observationBlocks = countObservationBlocks(
    args.observationsByBlock ?? {},
  );
  const transcriptAvailable = args.hasPartResponse;
  const postSessionResult =
    args.liveProgress?.post_session_result &&
    typeof args.liveProgress.post_session_result === "object"
      ? args.liveProgress.post_session_result
      : null;
  const therapistEntered =
    postSessionResult?.provenance === "therapist_entered" ||
    !!postSessionResult?.entered_by;
  const completed = args.completedBlocks ?? 0;
  const ratio =
    args.totalBlocks && args.totalBlocks > 0 ? completed / args.totalBlocks : 0;
  const supportiveEvidence =
    turnBlocks > 0 ||
    observationBlocks > 0 ||
    transcriptAvailable ||
    therapistEntered;
  const strongEvidence =
    therapistEntered ||
    observationBlocks >= 2 ||
    turnBlocks >= 2 ||
    (transcriptAvailable && completed >= 2);
  if (!args.hasPartResponse || !args.evidencePresent || !supportiveEvidence)
    return "low";
  if (ratio >= 0.8 && completed >= 2 && strongEvidence) return "high";
  if (supportiveEvidence) return "moderate";
  return "low";
}

function reviewStatusForKarelDirect(
  outcome: KarelDirectOutcome,
  evidenceValidity: "low" | "moderate" | "high",
  args: { hasPartResponse: boolean; supportiveEvidence: boolean },
): ReviewStatus {
  if (outcome === "deferred") return "cancelled";
  if (outcome === "completed") {
    if (!args.hasPartResponse || evidenceValidity === "low")
      return args.supportiveEvidence
        ? "partially_analyzed"
        : "evidence_limited";
    if (
      evidenceValidity === "high" ||
      (evidenceValidity === "moderate" && args.supportiveEvidence)
    )
      return "analyzed";
    return "partially_analyzed";
  }
  if (
    outcome === "partial" &&
    evidenceValidity !== "low" &&
    args.hasPartResponse
  )
    return "partially_analyzed";
  return "evidence_limited";
}

function hasKarelDirectDeferredReason(
  plan: SessionPlan,
  liveProgress?: any,
): boolean {
  const contract =
    plan.urgency_breakdown && typeof plan.urgency_breakdown === "object"
      ? (plan.urgency_breakdown as Record<string, any>)
      : {};
  const postSessionResult =
    liveProgress?.post_session_result &&
    typeof liveProgress.post_session_result === "object"
      ? liveProgress.post_session_result
      : null;
  return [
    contract.defer_reason,
    contract.result_reason,
    contract.reason,
    postSessionResult?.reason,
    postSessionResult?.defer_reason,
    postSessionResult?.result_reason,
  ].some((value) => String(value ?? "").trim().length > 0);
}

function buildEvidenceItems(
  ctx: {
    plan: SessionPlan;
    threads: any[];
    partCard: any;
    partCardLookup?: PartCardLookup;
  },
  liveProgress: any,
  turnsByBlock: Record<string, any[]>,
  observationsByBlock: Record<string, string>,
) {
  const progressItems = Array.isArray(liveProgress?.items)
    ? liveProgress.items
    : [];
  const lookup =
    ctx.partCardLookup ??
    ({
      status: ctx.partCard ? "resolved" : "missing",
      reason: ctx.partCard ? "legacy_resolved" : "legacy_missing",
      canonical_part_name: ctx.partCard?.part_name ?? null,
      registry_id: ctx.partCard?.id ?? null,
    } as PartCardLookup);
  return [
    {
      kind: "session_plan",
      available: !!ctx.plan,
      source_table: "did_daily_session_plans",
      source_id: ctx.plan.id,
      date: ctx.plan.plan_date,
    },
    {
      kind: "live_progress",
      available: !!liveProgress,
      source_table: "did_live_session_progress",
      source_id: ctx.plan.id,
      completed_blocks: liveProgress?.completed_blocks ?? null,
      total_blocks: liveProgress?.total_blocks ?? null,
    },
    {
      kind: "checklist",
      available: progressItems.length > 0,
      count: progressItems.length,
    },
    {
      kind: "turn_by_turn",
      available: Object.values(turnsByBlock || {}).some(
        (v) => Array.isArray(v) && v.length > 0,
      ),
      block_count: Object.keys(turnsByBlock || {}).length,
    },
    {
      kind: "observations",
      available: Object.values(observationsByBlock || {}).some(
        (v) => String(v || "").trim().length > 0,
      ),
      count: Object.values(observationsByBlock || {}).filter(
        (v) => String(v || "").trim().length > 0,
      ).length,
    },
    {
      kind: "thread_transcript",
      available: (ctx.threads || []).some(
        (t: any) => Array.isArray(t.messages) && t.messages.length > 0,
      ),
      thread_count: ctx.threads?.length ?? 0,
    },
    {
      kind: "part_card",
      available: lookup.status === "resolved" && !!ctx.partCard,
      source_table: "did_part_registry",
      part_name: ctx.plan.selected_part,
      canonical_part_name: lookup.canonical_part_name,
      registry_id: lookup.registry_id,
      lookup_status: lookup.status,
      lookup_reason: lookup.reason,
    },
  ];
}

function checklistItems(liveProgress: any) {
  const items = Array.isArray(liveProgress?.items) ? liveProgress.items : [];
  const labelOf = (it: any, idx: number) =>
    String(it?.title || it?.label || it?.text || it?.name || `Bod ${idx + 1}`);
  const done = items.filter(
    (it: any) =>
      it?.done === true || it?.completed === true || it?.status === "done",
  );
  const missing = items.filter(
    (it: any) =>
      !(it?.done === true || it?.completed === true || it?.status === "done"),
  );
  return {
    completed: done.map((it: any, idx: number) => ({
      label: labelOf(it, idx),
      status: it?.status ?? "done",
    })),
    missing: missing.map((it: any, idx: number) => ({
      label: labelOf(it, idx),
      status: it?.status ?? "missing",
    })),
  };
}

function reviewStatusFor(
  evaluation: any,
  evidencePresent: boolean,
  completedBlocks?: number,
  totalBlocks?: number,
): ReviewStatus {
  if (!evidencePresent) return "evidence_limited";
  if (evaluation?.completion_status === "completed") return "analyzed";
  if ((completedBlocks ?? 0) > 0 || evaluation?.completion_status === "partial")
    return "partially_analyzed";
  if (totalBlocks && totalBlocks > 0) return "evidence_limited";
  return "partially_analyzed";
}

function cleanText(value: unknown, max = 20000): string {
  return String(value ?? "")
    .replace(/\r/g, "")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim()
    .slice(0, max);
}

function listLines(items: unknown): string {
  return Array.isArray(items) && items.length > 0
    ? items.map((x) => `- ${String(x).trim()}`).join("\n")
    : "- nebylo zaznamenáno";
}

function deriveSessionOutputs(args: {
  evaluation: any;
  plan: SessionPlan;
  markdown: string;
  diagnosticValidity: string;
  reviewStatus: ReviewStatus;
  completedBlocks?: number;
  totalBlocks?: number;
  endedReason: EndedReason;
}) {
  const e = args.evaluation ?? {};
  const part = args.plan.selected_part;
  const lead = args.plan.session_lead || args.plan.therapist || "Hanička";
  const assistants = Array.isArray(
    (args.plan.urgency_breakdown as any)?.assistant_persons,
  )
    ? (args.plan.urgency_breakdown as any).assistant_persons.join(", ")
    : "Karel jako live asistent terapeutky";
  const evidenceLine =
    args.reviewStatus === "evidence_limited"
      ? "Evidence je omezená; výstup odděluje doložené poznatky od hypotéz a nepředstírá plnou analýzu."
      : "Výstup vychází z dostupného programu, průběhových poznámek, checklistu a navázaného threadu.";
  const detailedFallback = `## SEZENÍ — DETAILNÍ PROFESIONÁLNÍ ANALÝZA
plan_id: ${args.plan.id}
datum: ${args.plan.plan_date}
část: ${part}
vedla: ${lead}
asistovali: ${assistants}
role Karla: live real-time asistent terapeutky
stav review: ${args.reviewStatus}

### Identifikace a program
Sezení bylo vedeno terapeutkou (${lead}) podle schváleného programu ${args.plan.id}. Karel nevystupoval jako přímý vedoucí dítěte, ale jako průběžný asistent terapeutky. Dokončení bloků: ${args.completedBlocks ?? "?"}/${args.totalBlocks ?? "?"}. Důvod ukončení: ${args.endedReason}.

### Co proběhlo
${cleanText(e.session_arc || "nebylo zaznamenáno")}

### Co zapsala terapeutka / co projevila část
${cleanText(e.child_perspective || "nebylo zaznamenáno")}

### Co navrhl Karel a role týmu
${cleanText(e.therapist_motivation || "nebylo zaznamenáno")}

### Pozorování vs hypotézy
Pozorování: ${cleanText(e.session_arc || "nebylo zaznamenáno")}

Hypotézy:
${listLines(e.key_insights)}

### Význam pro část
${cleanText(e.implications_for_part || e.child_perspective || "nebylo zaznamenáno")}

### Význam pro kluky
${cleanText(e.implications_for_system || e.implications_for_tomorrow || "nebylo zaznamenáno")}

### Rizika a limity evidence
Rizika:
${listLines(e.risks)}

${cleanText(e.evidence_limitations || args.diagnosticValidity || evidenceLine)}

### Doporučení
Pro terapeutky: ${cleanText(e.recommendations_for_therapists || e.therapist_motivation || "nebylo zaznamenáno")}

Pro další Sezení: ${cleanText(e.recommendations_for_next_session || e.recommended_next_step || "nebylo zaznamenáno")}

Pro další Hernu: ${cleanText(e.recommendations_for_next_playroom || "není jasně indikováno; zvážit jen podle stability části")}

### Čeho se vyvarovat
${listLines(e.what_not_to_do)}

### Otevřené otázky
${cleanText(e.incomplete_note || "nebylo zaznamenáno")}`;
  const practicalFallback = `## SEZENÍ — PRAKTICKÝ REPORT PRO KARLŮV PŘEHLED
S částí ${part} pracovala ${lead}; Karel byl live asistent terapeutky. Hlavní téma: ${cleanText((args.plan.urgency_breakdown as any)?.main_topic || e.session_arc || "nebylo zaznamenáno", 600)}

Co se stalo: ${cleanText(e.session_arc || "nebylo zaznamenáno", 1000)}

Co víme o části: ${cleanText(e.child_perspective || "nebylo zaznamenáno", 1000)}

Co z toho plyne pro část: ${cleanText(e.implications_for_part || e.child_perspective || "nebylo zaznamenáno", 900)}

Co z toho plyne pro kluky: ${cleanText(e.implications_for_system || e.implications_for_tomorrow || "nebylo zaznamenáno", 900)}

Co mají terapeutky udělat: ${cleanText(e.recommendations_for_therapists || e.recommended_next_step || "doplnit a ověřit evidenci", 900)}

Čeho se vyvarovat: ${Array.isArray(e.what_not_to_do) && e.what_not_to_do.length ? e.what_not_to_do.join("; ") : "nepřetěžovat část a nevyvozovat závěry nad rámec evidence"}.

Doporučení pro další Sezení: ${cleanText(e.recommendations_for_next_session || e.recommended_next_step || "navázat opatrně podle dostupnosti části", 900)}

Doporučení pro další Hernu: ${cleanText(e.recommendations_for_next_playroom || "pouze pokud bude část stabilní a bude jasný bezpečný nízkoprahový cíl", 900)}

Bezpečnostní závěr: ${cleanText(e.evidence_limitations || evidenceLine, 700)}`;
  const teamFallback =
    cleanText(e.team_closing_text) ||
    `${String(lead).includes("Ká") ? "Káťo" : "Haničko"}, bylo důležité, že jsi dnes držela tempo podle dostupné evidence a nepřetlačila ${part} za hranici záznamu. Karel zůstává v roli asistenta a tým se může opřít o malé, přesné kroky místo rychlých závěrů.`;
  return {
    detailed_analysis_text: cleanText(
      e.detailed_analysis_text || detailedFallback,
    ),
    practical_report_text: cleanText(
      e.practical_report_text || practicalFallback,
      8000,
    ),
    team_closing_text: teamFallback,
    implications_for_part: cleanText(
      e.implications_for_part || e.child_perspective || "",
    ),
    implications_for_system: cleanText(
      e.implications_for_system || e.implications_for_tomorrow || "",
    ),
    recommendations_for_therapists: cleanText(
      e.recommendations_for_therapists || e.therapist_motivation || "",
    ),
    recommendations_for_next_session: cleanText(
      e.recommendations_for_next_session || e.recommended_next_step || "",
    ),
    recommendations_for_next_playroom: cleanText(
      e.recommendations_for_next_playroom || "",
    ),
    risks: Array.isArray(e.risks) ? e.risks : [],
    evidence_limitations: cleanText(
      e.evidence_limitations || args.diagnosticValidity || evidenceLine,
    ),
    what_not_to_do: Array.isArray(e.what_not_to_do) ? e.what_not_to_do : [],
  };
}

function cleanMemoryLine(value: unknown, max = 520): string {
  return String(value ?? "")
    .replace(/<!--[^]*?-->/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function hasHankaWorkImplication(
  review: SessionReviewRow,
  evaluation?: any,
): boolean {
  if (review.status === "failed_analysis" || !review.id) return false;
  const teamText = cleanMemoryLine(
    review.team_implications ?? evaluation?.therapist_motivation,
    900,
  );
  if (teamText.length < 35) return false;
  const workSignal =
    /(hanič|hanka|hana|terapeut|tým|veden[íi]|karel|další pr[aá]c|zp[uů]sob|postup|koordinac|superviz)/i;
  const clinicalOnly =
    /(arthur|část|dít[eě]|kluci)/i.test(teamText) && !workSignal.test(teamText);
  return workSignal.test(teamText) && !clinicalOnly;
}

function buildPametKarelReviewPayload(
  review: SessionReviewRow,
  ctx?: { plan?: SessionPlan },
  evaluation?: any,
): string | null {
  if (!hasHankaWorkImplication(review, evaluation)) return null;
  const date = review.session_date || ctx?.plan?.plan_date || pragueDayISO();
  const partName = review.part_name || ctx?.plan?.selected_part || "část";
  const teamInsight = cleanMemoryLine(
    review.team_implications ?? evaluation?.therapist_motivation,
  );
  const nextStep = cleanMemoryLine(
    review.next_session_recommendation ??
      evaluation?.recommended_next_step ??
      "Příště má Karel navázat pracovně opatrně a ověřit, zda se tento závěr potvrzuje v další evidenci.",
  );
  const verification = cleanMemoryLine(
    review.evidence_limitations ??
      "Validita je omezená podle evidence review; je potřeba doplnit nebo ověřit v dalším kontaktu.",
    420,
  );

  return `[${date}] Z review sezení ${partName} plyne pracovní poznatek:

- ${teamInsight}
- Příště má Karel při vedení Haničky / týmu zohlednit tento pracovní signál: ${nextStep}
- Ověřit nebo doplnit: ${verification}

Poznámka k jistotě:
Toto je pracovní dedukce z review, ne tvrdý klinický fakt. Validita je omezená podle evidence review.

Zdroj: did_session_review:${review.id}
`.trim();
}

async function projectReviewToPametKarel(
  sb: any,
  review: SessionReviewRow,
  ctx?: { plan?: SessionPlan },
  evaluation?: any,
) {
  const payload = buildPametKarelReviewPayload(review, ctx, evaluation);
  if (!payload)
    return { inserted: false, reason: "no_clear_hanka_work_implication" };

  const marker = `did_session_review:${review.id}`;
  const { data: existingWrites, error: existingErr } = await sb
    .from("did_pending_drive_writes")
    .select("id,status")
    .eq("target_document", PAMET_KAREL_HANKA_INSIGHTS_TARGET)
    .in("status", PAMET_KAREL_DEDUPE_STATUSES)
    .ilike("content", `%${marker}%`)
    .limit(1);
  if (existingErr) throw existingErr;
  if (existingWrites && existingWrites.length > 0)
    return { inserted: false, reason: "already_projected" };

  const content = encodeGovernedWrite(payload, {
    source_type: "did_session_review",
    source_id: review.id,
    content_type: "therapist_memory_note",
    subject_type: "therapist",
    subject_id: "hanka",
    payload_fingerprint: marker,
  });
  const { error: insertErr } = await sb
    .from("did_pending_drive_writes")
    .insert({
      user_id: review.user_id,
      target_document: PAMET_KAREL_HANKA_INSIGHTS_TARGET,
      content,
      write_type: "append",
      priority: "normal",
      status: "pending",
    });
  if (insertErr) throw insertErr;
  return { inserted: true, target_document: PAMET_KAREL_HANKA_INSIGHTS_TARGET };
}

function sanitizeEvaluation(
  evaluation: any,
  endedReason: EndedReason,
  completedBlocks?: number,
  totalBlocks?: number,
) {
  const ratio =
    totalBlocks && totalBlocks > 0 ? (completedBlocks ?? 0) / totalBlocks : 0;
  if (ratio >= 0.5 && evaluation.completion_status === "abandoned") {
    evaluation.completion_status = ratio >= 0.85 ? "completed" : "partial";
    evaluation.incomplete_note =
      evaluation.incomplete_note ||
      "Sezení proběhlo z větší části; nedokončené zůstaly jen některé body programu.";
  }
  if (endedReason === "auto_safety_net" && ratio === 0) {
    const neutral =
      "Sezení bylo naplánováno, ale v evidenci není záznam, že začalo. Nelze z toho odvozovat stav části. Je potřeba ověřit u terapeutky, zda se pokus skutečně odehrál.";
    evaluation.completion_status = "abandoned";
    evaluation.incomplete_note = neutral;
    for (const key of [
      "session_arc",
      "child_perspective",
      "therapist_motivation",
      "implications_for_tomorrow",
      "recommended_next_step",
    ]) {
      if (typeof evaluation[key] === "string")
        evaluation[key] = key === "child_perspective" ? "unknown" : neutral;
    }
    evaluation.methods_used = [];
    evaluation.methods_effectiveness = [];
    evaluation.key_insights = ["planned_not_started"];
  }
  return evaluation;
}

async function persistPlannedNotStartedAudit(
  sb: any,
  ctx: any,
  args: {
    liveProgress: any;
    turnsByBlock: Record<string, any[]>;
    observationsByBlock: Record<string, string>;
    force?: boolean;
  },
) {
  const now = new Date().toISOString();
  const text =
    "Sezení bylo naplánováno, ale v evidenci není záznam, že začalo. Nelze z toho odvozovat stav části. Je potřeba ověřit u terapeutky, zda se pokus skutečně odehrál.";
  const evidenceItems = [
    {
      kind: "session_plan",
      available: true,
      source_table: "did_daily_session_plans",
      source_id: ctx.plan.id,
      date: ctx.plan.plan_date,
    },
    {
      kind: "session_started_evidence",
      available: false,
      basis:
        "no_completed_blocks_no_turns_no_observations_no_artifacts_no_matching_thread_user_response",
    },
    {
      kind: "live_progress",
      available: !!args.liveProgress,
      source_table: "did_live_session_progress",
      source_id: ctx.plan.id,
      completed_blocks: args.liveProgress?.completed_blocks ?? null,
      total_blocks: args.liveProgress?.total_blocks ?? null,
    },
    {
      kind: "matching_thread_user_response",
      available: false,
      thread_count: ctx.threads?.length ?? 0,
    },
  ];
  const analysisJson = {
    outcome: "planned_not_started",
    post_session_result: {
      status: "planned_not_started",
      contactOccurred: false,
    },
    evidence_basis: "planned_only",
    evidence_validity: "low",
    child_perspective: "unknown",
    confirmed_facts: {
      plan_id: ctx.plan.id,
      part_name: ctx.plan.selected_part,
      plan_existed: true,
      no_live_progress: !args.liveProgress,
      no_matching_thread_user_response: true,
      no_user_response: true,
    },
    unknowns: ["zda se pokus o sezení vůbec odehrál"],
  };
  const reviewPayload = {
    user_id: ctx.plan.user_id,
    plan_id: ctx.plan.id,
    part_name: ctx.plan.selected_part,
    session_date: ctx.plan.plan_date,
    mode: isPlayroomPlan(ctx.plan) ? "playroom" : "session",
    status: "evidence_limited",
    review_kind: "calendar_day_safety_net",
    analysis_version: "did-session-review-v1-planned-not-started",
    source_data_summary: "planned_only:no_session_started_evidence",
    evidence_items: evidenceItems,
    completed_checklist_items: [],
    missing_checklist_items: [],
    transcript_available: false,
    live_progress_available: !!args.liveProgress,
    clinical_summary: text,
    therapeutic_implications:
      "Ověřit u terapeutky, zda se pokus o sezení skutečně odehrál.",
    team_implications: null,
    next_session_recommendation:
      "Neodvozovat klinické závěry z plánu; nejprve ověřit realitu sezení.",
    evidence_limitations:
      "Existuje plán, ale chybí evidence zahájení: žádné completed blocks, turn-by-turn data, observations, artifacts ani odpověď části v threadu navázaném na tento plan_id.",
    analysis_json: analysisJson,
    projection_status: "skipped",
    error_message: null,
    is_current: true,
    updated_at: now,
  };
  const { data: existingReview } = await sb
    .from("did_session_reviews")
    .select("id")
    .eq("plan_id", ctx.plan.id)
    .eq("is_current", true)
    .maybeSingle();
  let reviewId = existingReview?.id ?? null;
  if (reviewId)
    await sb
      .from("did_session_reviews")
      .update(reviewPayload)
      .eq("id", reviewId);
  else {
    const { data: inserted } = await sb
      .from("did_session_reviews")
      .insert(reviewPayload)
      .select("id")
      .single();
    reviewId = inserted?.id ?? null;
  }
  await sb
    .from("did_daily_session_plans")
    .update({
      lifecycle_status: "evidence_limited",
      urgency_breakdown: {
        ...(ctx.plan.urgency_breakdown ?? {}),
        result_status: "planned_not_started",
        session_started_evidence: false,
      },
      updated_at: now,
    })
    .eq("id", ctx.plan.id);
  return {
    reviewId,
    reviewStatus: "evidence_limited",
    postSessionResult: analysisJson.post_session_result,
  };
}

function buildDiagnosticValidityReport(
  planText: string | null,
  turnsByBlock: Record<string, any[]>,
  observationsByBlock: Record<string, string>,
  liveProgress: any,
): string {
  const text =
    `${planText ?? ""}\n${Object.values(observationsByBlock).join("\n")}`.toLowerCase();
  const isAssociation =
    /(asocia|prvn[íi] n[áa]pad|slovn[íi] hra|\b\d+\s*slov)/i.test(text);
  const isDrawing =
    /(kresb|nakresl|strom|postav|d[ůu]m|rodin|mapa t[ěe]la|body map)/i.test(
      text,
    );
  const isRorschach = /(rorsch|ror|inkblot|skvrn)/i.test(text);
  const allTurns = Object.values(turnsByBlock || {})
    .flat()
    .map((t: any) => String(t?.text ?? ""));
  const allText = `${allTurns.join("\n")}\n${Object.values(observationsByBlock).join("\n")}`;
  const hasLatency = /latenc|\b\d{1,3}\s*(s|sec|sek|sekund)\b/i.test(allText);
  const hasVerbatim = allTurns.some((s) => s.trim().length > 12);
  const hasAffect =
    /(afekt|pláč|plac|úzkost|uzkost|freeze|ztuhl|smích|smich|napětí|napeti|mlč|mlc)/i.test(
      allText,
    );
  const hasNonverbal =
    /(neverb|mimika|postoj|ruce|oči|oci|hlas|zbled|červen|cerven|slzy)/i.test(
      allText,
    );
  const hasReproduction = /(reproduk|vzpomene|pamatuje|zopak)/i.test(allText);
  const artifacts =
    liveProgress?.artifacts_by_block &&
    typeof liveProgress.artifacts_by_block === "object"
      ? (Object.values(liveProgress.artifacts_by_block).flat() as any[])
      : [];
  const hasImage = artifacts.some((a: any) => a?.kind === "image");
  const hasAudio = artifacts.some((a: any) => a?.kind === "audio");
  const missing: string[] = [];
  if (isAssociation && !hasLatency) missing.push("latence v sekundách");
  if ((isAssociation || isDrawing) && !hasVerbatim)
    missing.push("doslovný verbatim zápis");
  if ((isAssociation || isDrawing) && !hasAffect)
    missing.push("afekt / emoční reakce");
  if ((isAssociation || isDrawing) && !hasNonverbal)
    missing.push("neverbální projevy");
  if (isAssociation && !hasReproduction)
    missing.push("reprodukční kontrola po pauze");
  if (isAssociation && !hasAudio && !hasVerbatim)
    missing.push("audio nebo přesný turn-by-turn protokol");
  if (isDrawing && !hasImage) missing.push("foto/kopie kresby či artefaktu");
  const methodLine =
    [
      isAssociation ? "asociační experiment" : null,
      isDrawing ? "kresbová/projektivní metoda" : null,
      isRorschach ? "ROR/Rorschach téma" : null,
    ]
      .filter(Boolean)
      .join(", ") || "bez jasně rozpoznané standardní diagnostické metody";
  const rorGuard = isRorschach
    ? "\n- ROR/Rorschach: Karel nesmí předstírat standardizované skórování; bez kompletní licencované administrace jde pouze o orientační projektivní rozhovor."
    : "";
  return `### Diagnostická validita\nRozpoznaná metoda: ${methodLine}.\n${missing.length ? `Validita je omezená — chybí: ${missing.join(", ")}. Závěry níže ber jako pracovní hypotézy, ne jako standardizovanou psychodiagnostiku.` : "Minimální důkazní vrstva je přítomná; závěry přesto formuluj jako klinické hypotézy a odděl je od doložených pozorování."}${rorGuard}`;
}

function countTurnBlocks(turnsByBlock: Record<string, any[]>): number {
  return Object.values(turnsByBlock || {}).filter(
    (v) => Array.isArray(v) && v.length > 0,
  ).length;
}

function countObservationBlocks(
  observationsByBlock: Record<string, string>,
): number {
  return Object.values(observationsByBlock || {}).filter(
    (v) => String(v || "").trim().length > 0,
  ).length;
}

function countArtifacts(liveProgress: any): number {
  if (
    !liveProgress?.artifacts_by_block ||
    typeof liveProgress.artifacts_by_block !== "object"
  )
    return 0;
  return Object.values(liveProgress.artifacts_by_block).flat().length;
}

function hasThreadTranscript(threads: any[] = []): boolean {
  return threads.some(
    (t: any) => Array.isArray(t.messages) && t.messages.length > 0,
  );
}

function evidenceValidityFor(args: {
  completedBlocks?: number;
  totalBlocks?: number;
  turnBlocks: number;
  observationBlocks: number;
  transcriptAvailable: boolean;
  provenance: "therapist_entered" | "auto_derived" | "missing";
}): "low" | "moderate" | "high" {
  const completed = args.completedBlocks ?? 0;
  const ratio =
    args.totalBlocks && args.totalBlocks > 0 ? completed / args.totalBlocks : 0;
  const hasStrongEvidence =
    args.turnBlocks > 0 ||
    args.transcriptAvailable ||
    args.observationBlocks > 0 ||
    args.provenance === "therapist_entered";
  if (
    completed <= 1 ||
    !hasStrongEvidence ||
    args.provenance !== "therapist_entered"
  )
    return "low";
  if (ratio >= 0.8) return "high";
  return "moderate";
}

function buildStructuredPostSessionResult(args: {
  evaluation: any;
  endedReason: EndedReason;
  completedBlocks?: number;
  totalBlocks?: number;
  evidencePresent: boolean;
  turnsByBlock: Record<string, any[]>;
  observationsByBlock: Record<string, string>;
  liveProgress: any;
  transcriptAvailable: boolean;
}) {
  const turnBlocks = countTurnBlocks(args.turnsByBlock);
  const observationBlocks = countObservationBlocks(args.observationsByBlock);
  const artifactCount = countArtifacts(args.liveProgress);
  const derivedEvidence =
    args.evidencePresent ||
    turnBlocks > 0 ||
    observationBlocks > 0 ||
    args.transcriptAvailable ||
    artifactCount > 0;
  const provenance: "auto_derived" | "missing" = derivedEvidence
    ? "auto_derived"
    : "missing";
  if (provenance === "missing") {
    return {
      schema: "post_session_result.v1",
      provenance,
      status: "missing",
      entered_by: null,
      entered_at: null,
    };
  }
  return {
    schema: "post_session_result.v1",
    provenance,
    status: "derived",
    entered_by: null,
    entered_at: null,
    endedReason: args.endedReason,
    contactOccurred: args.evidencePresent,
    completionStatus: args.evaluation?.completion_status ?? null,
    completedBlocks: args.completedBlocks ?? null,
    totalBlocks: args.totalBlocks ?? null,
    evidenceValidity: evidenceValidityFor({
      completedBlocks: args.completedBlocks,
      totalBlocks: args.totalBlocks,
      turnBlocks,
      observationBlocks,
      transcriptAvailable: args.transcriptAvailable,
      provenance,
    }),
    evidenceSignals: {
      turnBlocks,
      observationBlocks,
      transcriptAvailable: args.transcriptAvailable,
      artifactCount,
    },
    outcome: args.evaluation?.recommended_next_step ?? null,
  };
}

function buildAnalysisJson(args: {
  evaluation: any;
  diagnosticValidity: string;
  reviewStatus: ReviewStatus;
  postSessionResult: any;
  plan: SessionPlan;
  evidenceItems: any[];
  checklist: { completed: any[]; missing: any[] };
  completedBlocks?: number;
  totalBlocks?: number;
  turnsByBlock: Record<string, any[]>;
  observationsByBlock: Record<string, string>;
  liveProgress: any;
  threads: any[];
  partCardLookup?: PartCardLookup;
}) {
  const completionRatio =
    args.totalBlocks && args.totalBlocks > 0
      ? (args.completedBlocks ?? 0) / args.totalBlocks
      : null;
  const transcriptAvailable = hasThreadTranscript(args.threads);
  const confirmedFacts = {
    plan_id: args.plan.id,
    part_name: args.plan.selected_part,
    completedBlocks: args.completedBlocks ?? null,
    totalBlocks: args.totalBlocks ?? null,
    completion_ratio: completionRatio,
    contactOccurred: args.postSessionResult?.contactOccurred ?? false,
    actualPart:
      args.partCardLookup?.status === "resolved"
        ? args.partCardLookup.canonical_part_name
        : null,
    durationMinutes: null,
    evidence_availability: {
      live_progress: args.evidenceItems.find((e) => e.kind === "live_progress")
        ?.available
        ? "available"
        : "missing",
      checklist_count: Array.isArray(args.liveProgress?.items)
        ? args.liveProgress.items.length
        : 0,
      turn_by_turn_count: countTurnBlocks(args.turnsByBlock),
      observations_count: countObservationBlocks(args.observationsByBlock),
      transcript: transcriptAvailable ? "available" : "missing",
      artifacts_count: countArtifacts(args.liveProgress),
    },
    review_status: args.reviewStatus,
  };
  return {
    schema: "did_session_review.v2",
    status: "created",
    detailed_analysis_text: cleanText(args.evaluation?.detailed_analysis_text),
    practical_report_text: cleanText(args.evaluation?.practical_report_text),
    team_closing_text: cleanText(args.evaluation?.team_closing_text),
    key_findings: Array.isArray(args.evaluation?.key_insights)
      ? args.evaluation.key_insights
      : [],
    implications_for_part: cleanText(
      args.evaluation?.implications_for_part ||
        args.evaluation?.child_perspective,
    ),
    implications_for_system: cleanText(
      args.evaluation?.implications_for_system ||
        args.evaluation?.implications_for_tomorrow,
    ),
    recommendations_for_therapists: cleanText(
      args.evaluation?.recommendations_for_therapists ||
        args.evaluation?.therapist_motivation,
    ),
    recommendations_for_next_session: cleanText(
      args.evaluation?.recommendations_for_next_session ||
        args.evaluation?.recommended_next_step,
    ),
    recommendations_for_next_playroom: cleanText(
      args.evaluation?.recommendations_for_next_playroom,
    ),
    risks: Array.isArray(args.evaluation?.risks) ? args.evaluation.risks : [],
    evidence_limitations: cleanText(
      args.evaluation?.evidence_limitations || args.diagnosticValidity,
    ),
    what_not_to_do: Array.isArray(args.evaluation?.what_not_to_do)
      ? args.evaluation.what_not_to_do
      : [],
    confirmed_facts: confirmedFacts,
    narrative_summary: {
      session_arc: args.evaluation?.session_arc ?? null,
      child_perspective: args.evaluation?.child_perspective ?? null,
    },
    working_deductions: Array.isArray(args.evaluation?.key_insights)
      ? args.evaluation.key_insights
      : [],
    unknowns: [
      args.evaluation?.incomplete_note,
      args.diagnosticValidity,
    ].filter((v) => typeof v === "string" && v.trim().length > 0),
    writebacks: {
      therapeutic_implications:
        args.evaluation?.implications_for_tomorrow ?? null,
      team_implications: args.evaluation?.therapist_motivation ?? null,
      next_session_recommendation:
        args.evaluation?.recommended_next_step ?? null,
    },
    review_status: args.reviewStatus,
    post_session_result: args.postSessionResult,
  };
}

async function createKarelDirectFollowUp(
  sb: any,
  args: {
    userId: string;
    planId: string;
    partName: string;
    outcome: KarelDirectOutcome;
    actualPart?: string | null;
  },
) {
  const subjectId = args.planId;
  const { data: existing } = await sb
    .from("did_pending_questions")
    .select("id")
    .eq("status", "open")
    .eq("subject_type", "karel_direct_session")
    .eq("subject_id", subjectId)
    .limit(1);
  if (existing?.length) return;
  const question =
    args.outcome === "actual_part_differs"
      ? `Haničko, v Karlově přímém kontaktu se možná ozvala jiná část než ${args.partName}. Můžeš prosím podle dnešního chování potvrdit, kdo byl pravděpodobně přítomný?`
      : `Haničko, ${args.partName} dnes v Karlově přímém kontaktu neodpověděl/a. Viděla jsi dnes známky stažení, únavy, přítomnosti jiné části nebo důvod, proč kontakt nebyl možný?`;
  await sb.from("did_pending_questions").insert({
    question,
    context: `MVP-SESSION-2 karel_direct outcome: ${args.outcome}`,
    subject_type: "karel_direct_session",
    subject_id: subjectId,
    directed_to: "both",
    blocking: "clinical_clarification",
    status: "open",
  });
}

async function persistKarelDirectOutcome(
  sb: any,
  ctx: { plan: SessionPlan; threads?: any[]; partCardLookup?: PartCardLookup },
  args: {
    outcome: KarelDirectOutcome;
    endedReason: EndedReason;
    evidencePresent: boolean;
    evidenceValidity: "low" | "moderate" | "high";
    hasPartResponse: boolean;
    supportiveEvidence: boolean;
    createFollowUp?: boolean;
    actualPartIfDiffers?: string | null;
  },
) {
  const now = new Date().toISOString();
  const outcome = args.outcome;
  const reviewStatus: ReviewStatus = reviewStatusForKarelDirect(
    outcome,
    args.evidenceValidity,
    {
      hasPartResponse: args.hasPartResponse,
      supportiveEvidence: args.supportiveEvidence,
    },
  );
  const postSessionResult = {
    schema: "post_session_result.v1",
    provenance: "auto_derived",
    status: outcome,
    entered_by: null,
    entered_at: null,
    endedReason: args.endedReason,
    contactOccurred:
      args.hasPartResponse &&
      (outcome === "completed" ||
        outcome === "partial" ||
        outcome === "actual_part_differs"),
    completionStatus: outcome,
    evidenceValidity: args.evidenceValidity,
    actualPart: args.actualPartIfDiffers ?? null,
    actual_part_if_differs: args.actualPartIfDiffers ?? null,
  };
  const analysisJson = {
    schema: "did_session_review.analysis.v1",
    status: "created",
    outcome,
    confirmed_facts: {
      plan_id: ctx.plan.id,
      part_name: ctx.plan.selected_part,
      completedBlocks: 0,
      totalBlocks: null,
      completion_ratio: null,
      contactOccurred: postSessionResult.contactOccurred,
      actualPart:
        ctx.partCardLookup?.status === "resolved"
          ? ctx.partCardLookup.canonical_part_name
          : null,
      durationMinutes: null,
      evidence_availability: {
        live_progress: "missing",
        checklist_count: 0,
        turn_by_turn_count: 0,
        observations_count: 0,
        transcript: "missing",
        artifacts_count: 0,
      },
      review_status: reviewStatus,
    },
    narrative_summary: { session_arc: null, child_perspective: null },
    working_deductions: [],
    unknowns: [
      outcome === "deferred"
        ? "Karlův přímý kontakt byl odložen; důvod je potřeba doplnit terapeutkou."
        : outcome === "actual_part_differs"
          ? "Pravděpodobně se ozvala jiná část; identitu musí potvrdit terapeutka."
          : "Výsledek Karlova přímého kontaktu je evidence-limited; nelze předstírat hotový klinický závěr.",
    ],
    writebacks: {
      therapeutic_implications: null,
      team_implications: null,
      next_session_recommendation:
        "Doplnit krátkou odpověď terapeutky a podle ní upravit další plán.",
    },
    review_status: reviewStatus,
    post_session_result: postSessionResult,
  };
  const reviewPayload = {
    user_id: ctx.plan.user_id,
    plan_id: ctx.plan.id,
    part_name: ctx.plan.selected_part,
    session_date: ctx.plan.plan_date,
    mode: isPlayroomPlan(ctx.plan) ? "playroom" : "session",
    recommendations_for_next_playroom: isPlayroomPlan(ctx.plan)
      ? "Doplnit krátkou odpověď terapeutky a podle ní upravit další Karlovu hernu."
      : null,
    status: reviewStatus,
    review_kind: "karel_direct_session",
    analysis_version: "did-session-review-v1",
    source_data_summary: `karel_direct:${outcome}`,
    evidence_items: [
      { kind: "karel_direct_thread", available: false, outcome },
    ],
    transcript_available: false,
    live_progress_available: false,
    clinical_summary:
      outcome === "deferred"
        ? "Karlův přímý kontakt byl dnes odložen."
        : outcome === "unavailable"
          ? "Část dnes nebyla v Karlově přímém kontaktu dostupná."
          : outcome === "actual_part_differs"
            ? "V Karlově přímém kontaktu se možná ozvala jiná část; výsledek vyžaduje potvrzení terapeutkou."
            : "Karlův přímý kontakt má omezenou evidenci; výstup je pouze auditní.",
    evidence_limitations:
      "Kontakt neproběhl nebo není dostupná průběhová evidence; výstup není terapeutický záznam.",
    analysis_json: analysisJson,
    projection_status: "skipped",
    updated_at: now,
  };
  const { data: existingReview } = await sb
    .from("did_session_reviews")
    .select("id")
    .eq("plan_id", ctx.plan.id)
    .eq("is_current", true)
    .maybeSingle();
  if (existingReview?.id)
    await sb
      .from("did_session_reviews")
      .update(reviewPayload)
      .eq("id", existingReview.id);
  else await sb.from("did_session_reviews").insert(reviewPayload);
  await sb
    .from("did_daily_session_plans")
    .update({
      status: "done",
      lifecycle_status: reviewStatus,
      completed_at: now,
      finalized_at: now,
      finalization_source: args.endedReason,
      finalization_reason: outcome,
      urgency_breakdown: {
        ...(ctx.plan.urgency_breakdown ?? {}),
        result_status: outcome,
        actual_part_if_differs:
          args.actualPartIfDiffers ??
          (ctx.plan.urgency_breakdown as any)?.actual_part_if_differs ??
          null,
      },
      updated_at: now,
    })
    .eq("id", ctx.plan.id);
  await sb
    .from("did_live_session_progress")
    .update({ post_session_result: postSessionResult, updated_at: now })
    .eq("plan_id", ctx.plan.id);
  if (
    (args.createFollowUp ??
      ["unavailable", "actual_part_differs"].includes(outcome)) ||
    (outcome === "deferred" && args.createFollowUp === true)
  )
    await createKarelDirectFollowUp(sb, {
      userId: ctx.plan.user_id,
      planId: ctx.plan.id,
      partName: ctx.plan.selected_part,
      outcome,
      actualPart: args.actualPartIfDiffers,
    });
  return { reviewStatus, postSessionResult };
}

async function callAi(prompt: string, apiKey: string): Promise<any> {
  const res = await fetch(AI_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
      tools: [SESSION_EVAL_TOOL],
      tool_choice: {
        type: "function",
        function: { name: "emit_session_evaluation" },
      },
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    if (res.status === 429) throw new Error("AI rate limit překročen.");
    if (res.status === 402) throw new Error("AI kredit vyčerpán.");
    throw new Error(`AI gateway ${res.status}: ${text.slice(0, 240)}`);
  }
  const data = await res.json();
  const toolCall = data.choices?.[0]?.message?.tool_calls?.[0];
  if (!toolCall?.function?.arguments) {
    throw new Error("AI nevrátila tool call.");
  }
  return JSON.parse(toolCall.function.arguments);
}

function renderEvaluationMarkdown(
  evaluation: any,
  plan: SessionPlan,
  endedReason: EndedReason,
  completedBlocks: number | undefined,
  totalBlocks: number | undefined,
  diagnosticValidity: string,
): string {
  const dateLabel = plan.plan_date;
  const partLabel = plan.selected_part;
  const therapistLabel = plan.session_lead || plan.therapist || "?";
  const completionLine =
    evaluation.completion_status === "completed"
      ? "Stav: dokončené"
      : `Stav: ${evaluation.completion_status === "partial" ? "neukončené" : "sotva začaté"}` +
        (totalBlocks
          ? ` (${completedBlocks ?? "?"}/${totalBlocks} bodů)`
          : "") +
        (endedReason === "auto_safety_net"
          ? " · vyhodnoceno automaticky ráno"
          : "");

  const methodsLines = (evaluation.methods_effectiveness ?? [])
    .map((m: any) => `- ${m.rating} **${m.method}** — ${m.note}`)
    .join("\n");

  const tasksLines = (evaluation.tasks ?? [])
    .map((t: any) => `- [${t.owner}] [${t.urgency}] ${t.text}`)
    .join("\n");

  const insightsLines = (evaluation.key_insights ?? [])
    .map((k: string) => `- ${k}`)
    .join("\n");

  const incompleteSection = evaluation.incomplete_note
    ? `\n### Co se nestihlo\n${evaluation.incomplete_note}\n`
    : "";

  return `## Vyhodnocení sezení — ${partLabel} (${dateLabel})
**Vede:** ${therapistLabel}  
${completionLine}
${incompleteSection}
### Oblouk sezení
${evaluation.session_arc}

### Z pohledu ${partLabel}
${evaluation.child_perspective}

### Práce terapeutky
${evaluation.therapist_motivation}

### Použité metody a jejich efektivita
${methodsLines || "(nezaznamenáno)"}

${diagnosticValidity}

### Klíčové závěry
${insightsLines || "(žádné)"}

### Co z toho plyne pro další postup
${evaluation.implications_for_tomorrow}

### Doporučený další krok
${evaluation.recommended_next_step}

### Úkoly ze sezení
${tasksLines || "(žádné)"}
`.trim();
}

async function insertPackageOnce(
  sb: any,
  row: any,
  force = false,
): Promise<string | null> {
  const reviewId = String(row.metadata?.review_id ?? "");
  let q = sb
    .from("did_pantry_packages")
    .select("id,status")
    .eq("source_id", row.source_id)
    .eq("package_type", row.package_type);
  if (reviewId) q = q.eq("metadata->>review_id", reviewId);
  const { data: existing } = await q.limit(1);
  if (existing?.length && !force) return existing[0].id;
  if (existing?.length && force)
    await sb.from("did_pantry_packages").delete().eq("id", existing[0].id);
  const { data, error } = await sb
    .from("did_pantry_packages")
    .insert(row)
    .select("id")
    .single();
  if (error) throw error;
  return data?.id ?? null;
}

async function insertDriveWriteOnce(
  sb: any,
  row: any,
  dedupe: { reviewId?: string; contentType: string; target: string },
  force = false,
): Promise<string | null> {
  const reviewMarker = dedupe.reviewId
    ? `review_id=${dedupe.reviewId}`
    : "session_evaluate";
  const typeMarker = `content_type=${dedupe.contentType}`;
  const { data: existing } = await sb
    .from("did_pending_drive_writes")
    .select("id,status")
    .eq("target_document", dedupe.target)
    .ilike("content", `%${reviewMarker}%`)
    .ilike("content", `%${typeMarker}%`)
    .limit(1);
  if (existing?.length && !force) return existing[0].id;
  if (existing?.length && force)
    await sb.from("did_pending_drive_writes").delete().eq("id", existing[0].id);
  const { data, error } = await sb
    .from("did_pending_drive_writes")
    .insert(row)
    .select("id")
    .single();
  if (error) throw error;
  return data?.id ?? null;
}

function sessionDetailMarkdown(args: {
  text: string;
  plan: SessionPlan;
  reviewId?: string;
  lead: string;
  assistants: any[];
}) {
  return `## SEZENÍ — DETAILNÍ PROFESIONÁLNÍ ANALÝZA
plan_id: ${args.plan.id}
review_id: ${args.reviewId ?? "pending"}
datum: ${args.plan.plan_date}
část: ${args.plan.selected_part}
vedla: ${args.lead}
asistovali: ${args.assistants.length ? args.assistants.join(", ") : "Karel jako live asistent terapeutky"}

${args.text}`;
}

function sessionPracticalMarkdown(args: {
  text: string;
  teamClosing: string;
  plan: SessionPlan;
  reviewId?: string;
  lead: string;
  assistants: any[];
}) {
  return `## SEZENÍ — PRAKTICKÝ REPORT PRO KARLŮV PŘEHLED
plan_id: ${args.plan.id}
review_id: ${args.reviewId ?? "pending"}
datum: ${args.plan.plan_date}
část: ${args.plan.selected_part}
vedla: ${args.lead}
asistovali: ${args.assistants.length ? args.assistants.join(", ") : "Karel jako live asistent terapeutky"}

${args.text}

## SEZENÍ — TÝMOVÉ UZAVŘENÍ
plan_id: ${args.plan.id}
review_id: ${args.reviewId ?? "pending"}

${args.teamClosing}`;
}

async function persistEvaluation(
  sb: any,
  ctx: {
    plan: SessionPlan;
    existingSession: PartSessionRow | null;
    threads?: any[];
    partCard?: any;
    partCardLookup?: PartCardLookup;
  },
  evaluation: any,
  markdown: string,
  endedReason: EndedReason,
  completedBlocks: number | undefined,
  totalBlocks: number | undefined,
  force: boolean,
  liveProgress: any,
  turnsByBlock: Record<string, any[]>,
  observationsByBlock: Record<string, string>,
  diagnosticValidity: string,
) {
  const now = new Date().toISOString();
  const userId = ctx.plan.user_id;
  const partName = ctx.plan.selected_part;
  const therapistLabel = ctx.plan.session_lead || ctx.plan.therapist || "hanka";
  const therapistKey = String(therapistLabel).toLowerCase().includes("kát")
    ? "kata"
    : String(therapistLabel).toLowerCase().includes("oba") ||
        String(therapistLabel).toLowerCase().includes("společ")
      ? null
      : "hanka";

  // 1) did_part_sessions — UPDATE existující nebo INSERT nový
  const sessionPayload = {
    user_id: userId,
    part_name: partName,
    therapist: therapistKey ?? "hanka",
    session_date: ctx.plan.plan_date,
    session_type: "live_program",
    ai_analysis: markdown,
    methods_used: evaluation.methods_used ?? [],
    methods_effectiveness: evaluation.methods_effectiveness ?? [],
    karel_notes: evaluation.session_arc + "\n\n" + evaluation.child_perspective,
    karel_therapist_feedback: evaluation.therapist_motivation,
    tasks_assigned: evaluation.tasks ?? [],
    short_term_goals: evaluation.implications_for_tomorrow
      ? [evaluation.implications_for_tomorrow]
      : [],
    handoff_note: evaluation.recommended_next_step ?? null,
    updated_at: now,
  };

  if (ctx.existingSession) {
    if (ctx.existingSession.ai_analysis && !force) {
      console.log(
        `[evaluate] did_part_sessions ${ctx.existingSession.id} already evaluated, skipping (use force=true to overwrite)`,
      );
    } else {
      await sb
        .from("did_part_sessions")
        .update(sessionPayload)
        .eq("id", ctx.existingSession.id);
    }
  } else {
    await sb.from("did_part_sessions").insert(sessionPayload);
  }

  const evidencePresent = hasEvidence(
    turnsByBlock,
    observationsByBlock,
    completedBlocks,
  );
  const reviewStatus = reviewStatusFor(
    evaluation,
    evidencePresent,
    completedBlocks,
    totalBlocks,
  );
  const evidenceItems = buildEvidenceItems(
    ctx as any,
    liveProgress,
    turnsByBlock,
    observationsByBlock,
  );
  const checklist = checklistItems(liveProgress);
  const transcriptAvailable = hasThreadTranscript(ctx.threads ?? []);
  const postSessionResult = buildStructuredPostSessionResult({
    evaluation,
    endedReason,
    completedBlocks,
    totalBlocks,
    evidencePresent,
    turnsByBlock,
    observationsByBlock,
    liveProgress,
    transcriptAvailable,
  });
  const analysisJson = buildAnalysisJson({
    evaluation,
    diagnosticValidity,
    reviewStatus,
    postSessionResult,
    plan: ctx.plan,
    evidenceItems,
    checklist,
    completedBlocks,
    totalBlocks,
    turnsByBlock,
    observationsByBlock,
    liveProgress,
    threads: ctx.threads ?? [],
    partCardLookup: ctx.partCardLookup,
  });

  const outputs = deriveSessionOutputs({
    evaluation,
    plan: ctx.plan,
    markdown,
    diagnosticValidity,
    reviewStatus,
    completedBlocks,
    totalBlocks,
    endedReason,
  });
  Object.assign(analysisJson, outputs, {
    processing_status: "completed",
    generated_at: now,
    lead_person: therapistLabel,
    assistant_persons:
      (ctx.plan.urgency_breakdown as any)?.assistant_persons || [],
    approved_program_id: ctx.plan.id,
  });

  const reviewPayload = {
    user_id: userId,
    plan_id: ctx.plan.id,
    part_name: partName,
    session_date: ctx.plan.plan_date,
    mode: isPlayroomPlan(ctx.plan) ? "playroom" : "session",
    lead_person: ctx.plan.session_lead || ctx.plan.therapist || "Hanka",
    assistant_persons:
      (ctx.plan.urgency_breakdown as any)?.assistant_persons || [],
    approved_program_id: ctx.plan.id,
    program_title:
      (ctx.plan.urgency_breakdown as any)?.program_title ||
      (ctx.plan.urgency_breakdown as any)?.main_topic ||
      `Program ${ctx.plan.plan_date} — ${partName}`,
    main_topic: (ctx.plan.urgency_breakdown as any)?.main_topic || null,
    status: reviewStatus,
    review_kind:
      endedReason === "auto_safety_net"
        ? "calendar_day_safety_net"
        : "therapist_led_session",
    analysis_version: "did-session-review-v2",
    source_data_summary: evidenceItems
      .map((e: any) => `${e.kind}:${e.available ? "available" : "missing"}`)
      .join(", "),
    evidence_items: evidenceItems,
    completed_checklist_items: checklist.completed,
    missing_checklist_items: checklist.missing,
    transcript_available: evidenceItems.some(
      (e: any) =>
        ["turn_by_turn", "thread_transcript"].includes(e.kind) && e.available,
    ),
    live_progress_available: !!liveProgress,
    clinical_summary: outputs.practical_report_text.slice(0, 1800),
    clinical_findings:
      evaluation.child_perspective ?? evaluation.session_arc ?? null,
    implications_for_part: outputs.implications_for_part || null,
    implications_for_whole_system: outputs.implications_for_system || null,
    recommendations_for_therapists:
      outputs.recommendations_for_therapists || null,
    recommendations_for_next_session:
      outputs.recommendations_for_next_session || null,
    recommendations_for_next_playroom:
      outputs.recommendations_for_next_playroom || null,
    team_closing: outputs.team_closing_text,
    kartoteka_card_target: `KARTA_${String(partName || "UNKNOWN").toUpperCase()}`,
    drive_sync_status: "queued",
    source_of_truth_status: "pending_drive_sync",
    therapeutic_implications:
      outputs.implications_for_system || outputs.implications_for_part || null,
    team_implications: outputs.recommendations_for_therapists || null,
    next_session_recommendation:
      outputs.recommendations_for_next_session || null,
    evidence_limitations: outputs.evidence_limitations,
    analysis_json: analysisJson,
    projection_status:
      reviewStatus === "failed_analysis" ? "skipped" : "queued",
    error_message: null,
    updated_at: now,
  };

  const { data: existingReview } = await sb
    .from("did_session_reviews")
    .select("id")
    .eq("plan_id", ctx.plan.id)
    .eq("is_current", true)
    .maybeSingle();

  let reviewId = existingReview?.id as string | undefined;
  if (reviewId) {
    await sb
      .from("did_session_reviews")
      .update(reviewPayload)
      .eq("id", reviewId);
  } else {
    const { data: insertedReview, error: reviewErr } = await sb
      .from("did_session_reviews")
      .insert(reviewPayload)
      .select("id")
      .single();
    if (reviewErr) throw reviewErr;
    reviewId = insertedReview?.id;
  }

  if (reviewId) {
    await projectReviewToPametKarel(
      sb,
      {
        id: reviewId,
        user_id: userId,
        plan_id: ctx.plan.id,
        part_name: partName,
        session_date: ctx.plan.plan_date,
        status: reviewStatus,
        team_implications: reviewPayload.team_implications,
        therapeutic_implications: reviewPayload.therapeutic_implications,
        next_session_recommendation: reviewPayload.next_session_recommendation,
        evidence_limitations: reviewPayload.evidence_limitations,
      },
      ctx,
      evaluation,
    );
  }

  // 2) did_daily_session_plans — auditovatelný lifecycle stav podle review
  await sb
    .from("did_daily_session_plans")
    .update({
      status: "done",
      program_status:
        reviewStatus === "analyzed" || reviewStatus === "partially_analyzed"
          ? "evaluated"
          : "completed",
      drive_sync_status: "queued",
      kartoteka_card_target: `KARTA_${String(partName || "UNKNOWN").toUpperCase()}`,
      lifecycle_status: reviewStatus,
      completed_at: now,
      finalized_at: now,
      evaluated_at: now,
      finalization_source: endedReason,
      finalization_reason: evaluation.incomplete_note ?? endedReason,
      analysis_error: null,
      updated_at: now,
    })
    .eq("id", ctx.plan.id);

  if (liveProgress) {
    await sb
      .from("did_live_session_progress")
      .update({ post_session_result: postSessionResult, updated_at: now })
      .eq("plan_id", ctx.plan.id);
  }

  // 3) karel_pantry_b_entries — idempotentně podle source_kind + source_ref + entry_kind + related_part_name
  const sourceRef = `session-evaluate:${ctx.plan.id}`;
  await appendPantryB(sb, {
    user_id: userId,
    entry_kind: "conclusion",
    source_kind: "therapy_session",
    source_ref: sourceRef,
    summary: `Sezení s ${partName} (${ctx.plan.plan_date}, vede ${therapistLabel}) — ${outputs.practical_report_text.slice(0, 420)}`,
    detail: {
      plan_id: ctx.plan.id,
      review_id: reviewId,
      part_name: partName,
      practical_report_text: outputs.practical_report_text,
      key_findings: evaluation.key_insights ?? [],
      implications_for_part: outputs.implications_for_part,
      implications_for_system: outputs.implications_for_system,
        evidence_limitations: outputs.evidence_limitations,
        reality_override_evidence_discipline: liveProgress?.live_replan_patch && typeof liveProgress.live_replan_patch === "object"
          ? {
              therapist_factual_correction: "factual frame from therapist, not child clinical evidence",
              verified_external_fact: "external fact, not child clinical evidence",
              child_response_to_event: "possible clinical material only when based on child's own words, affect, body reaction or behavior",
              live_replan_id: liveProgress.active_live_replan_id ?? (liveProgress.live_replan_patch as any)?.id ?? null,
            }
          : undefined,
    },
    intended_destinations: [
      "briefing_input",
      "did_implications",
      "did_therapist_tasks",
    ],
    related_part_name: partName,
    related_therapist: therapistKey ?? undefined,
  });

  const followupSummary =
    [
      outputs.recommendations_for_therapists,
      outputs.recommendations_for_next_session,
      outputs.recommendations_for_next_playroom,
    ]
      .filter(Boolean)
      .join("\n\n") ||
    evaluation.recommended_next_step ||
    "Doplnit navazující kroky podle dostupnosti části.";
  await appendPantryB(sb, {
    user_id: userId,
    entry_kind: "followup_need",
    source_kind: "therapy_session",
    source_ref: `${sourceRef}:followup`,
    summary: followupSummary.slice(0, 1000),
    detail: {
      plan_id: ctx.plan.id,
      review_id: reviewId,
      recommendations_for_therapists: outputs.recommendations_for_therapists,
      recommendations_for_next_session:
        outputs.recommendations_for_next_session,
      recommendations_for_next_playroom:
        outputs.recommendations_for_next_playroom,
      what_not_to_do: outputs.what_not_to_do,
    },
    intended_destinations: ["did_therapist_tasks", "briefing_input"],
    related_part_name: partName,
    related_therapist: therapistKey ?? undefined,
  });

  if (outputs.risks.length > 0) {
    await appendPantryB(sb, {
      user_id: userId,
      entry_kind: "risk",
      source_kind: "therapy_session",
      source_ref: `${sourceRef}:risk`,
      summary: outputs.risks.join("; ").slice(0, 1000),
      detail: {
        plan_id: ctx.plan.id,
        review_id: reviewId,
        risks: outputs.risks,
        evidence_limitations: outputs.evidence_limitations,
      },
      intended_destinations: ["briefing_input", "did_implications"],
      related_part_name: partName,
    });
  }

  for (const insight of (evaluation.key_insights ?? []).slice(0, 3)) {
    await appendPantryB(sb, {
      user_id: userId,
      entry_kind: "hypothesis_change",
      source_kind: "therapy_session",
      source_ref: `${sourceRef}:hypothesis:${String(insight).slice(0, 80)}`,
      summary: String(insight).slice(0, 1000),
      detail: { plan_id: ctx.plan.id, review_id: reviewId },
      intended_destinations: ["did_implications", "briefing_input"],
      related_part_name: partName,
    });
  }

  if (reviewStatus !== "failed_analysis" && reviewId) {
    const projectionTarget = "KARTOTEKA_DID/00_CENTRUM/05A_OPERATIVNI_PLAN";
    const projectionContent = `<!-- did_session_review:${reviewId} plan:${ctx.plan.id} -->\n\n### Vyhodnocení včerejšího sezení — ${ctx.plan.plan_date} · ${partName}\n\n**Stav review:** ${reviewStatus}\n**Evidence:** ${reviewPayload.source_data_summary}\n\n**Shrnutí:**\n${evaluation.session_arc ?? "nebylo zaznamenáno"}\n\n**Co z toho plyne pro další plán:**\n${evaluation.implications_for_tomorrow ?? "nebylo zaznamenáno"}\n\n**Doporučený další krok:**\n${evaluation.recommended_next_step ?? "doplnit evidenci / ruční poznámku terapeutky"}\n`;
    const { data: existingWrites } = await sb
      .from("did_pending_drive_writes")
      .select("id")
      .eq("target_document", projectionTarget)
      .ilike("content", `%did_session_review:${reviewId}%`)
      .limit(1);
    if (!existingWrites || existingWrites.length === 0 || force) {
      await sb.from("did_pending_drive_writes").insert({
        user_id: userId,
        target_document: projectionTarget,
        content: projectionContent,
        write_type: "append",
        priority: "high",
        status: "pending",
      });
      await sb
        .from("did_session_reviews")
        .update({ projection_status: "queued", updated_at: now })
        .eq("id", reviewId);
    }
  }

  // 4) did_pantry_packages + did_pending_drive_writes — nové autoritativní typy, starý session_summary zachován kompatibilně
  const cardTarget = `KARTA_${partName.toUpperCase()}`;
  const sessionLogTarget = `KARTOTEKA_DID/00_CENTRUM/05C_SEZENI_LOG`;
  const assistants = Array.isArray(
    (ctx.plan.urgency_breakdown as any)?.assistant_persons,
  )
    ? (ctx.plan.urgency_breakdown as any).assistant_persons
    : [];
  const commonMetadata = {
    review_id: reviewId,
    plan_id: ctx.plan.id,
    thread_id: (ctx.threads ?? [])[0]?.id ?? null,
    part_name: partName,
    session_date: ctx.plan.plan_date,
    lead_person: therapistLabel,
    assistant_persons: assistants,
    mode: "session",
  };
  const packageSpecs = [
    {
      package_type: "session_detail_analysis",
      content_type: "session_detail_analysis",
      report_kind: "detail_analysis",
      target: cardTarget,
      content: sessionDetailMarkdown({
        text: outputs.detailed_analysis_text,
        plan: ctx.plan,
        reviewId,
        lead: therapistLabel,
        assistants,
      }),
    },
    {
      package_type: "session_practical_report",
      content_type: "session_practical_report",
      report_kind: "practical_report",
      target: cardTarget,
      content: sessionPracticalMarkdown({
        text: outputs.practical_report_text,
        teamClosing: outputs.team_closing_text,
        plan: ctx.plan,
        reviewId,
        lead: therapistLabel,
        assistants,
      }),
    },
    {
      package_type: "session_log",
      content_type: "session_log",
      report_kind: "session_log",
      target: sessionLogTarget,
      content: `### ${ctx.plan.plan_date} · ${partName} · ${therapistLabel}
plan_id: ${ctx.plan.id}
review_id: ${reviewId}
status: ${reviewStatus}

**Stručný praktický report:**
${outputs.practical_report_text.slice(0, 1600)}

**Doporučený další krok:**
${outputs.recommendations_for_next_session || evaluation.recommended_next_step || "doplnit evidenci"}
`,
    },
  ];
  const writeIds: string[] = [];
  for (const spec of packageSpecs) {
    const metadata = {
      ...commonMetadata,
      report_kind: spec.report_kind,
      content_type: spec.content_type,
    };
    const packageId = await insertPackageOnce(
      sb,
      {
        user_id: userId,
        package_type: spec.package_type,
        source_id: ctx.plan.id,
        source_table: "did_daily_session_plans",
        content_md: spec.content,
        drive_target_path: spec.target,
        metadata,
        status: "pending_drive",
      },
      force,
    );
    const governed = encodeGovernedWrite(
      `<!-- session_evaluate plan_id=${ctx.plan.id} review_id=${reviewId} content_type=${spec.content_type} -->

${spec.content}`,
      {
        source_type: "did_session_review",
        source_id: reviewId ?? ctx.plan.id,
        content_type: spec.content_type,
        subject_type: spec.target === sessionLogTarget ? "system" : "part",
        subject_id: partName,
        payload_fingerprint: `${reviewId}:${spec.content_type}:${spec.target}`,
      },
    );
    const writeId = await insertDriveWriteOnce(
      sb,
      {
        user_id: userId,
        target_document: spec.target,
        content: governed,
        write_type: "append",
        priority: spec.content_type === "session_log" ? "normal" : "high",
        status: "pending",
      },
      { reviewId, contentType: spec.content_type, target: spec.target },
      force,
    );
    if (writeId) writeIds.push(writeId);
    if (packageId && writeId)
      await sb
        .from("did_pantry_packages")
        .update({ metadata: { ...metadata, pending_drive_write_id: writeId } })
        .eq("id", packageId);
  }

  const { data: legacySummary } = await sb
    .from("did_pantry_packages")
    .select("id")
    .eq("source_id", ctx.plan.id)
    .eq("package_type", "session_summary")
    .limit(1);
  if (!legacySummary?.length) {
    await sb.from("did_pantry_packages").insert({
      user_id: userId,
      package_type: "session_summary",
      source_id: ctx.plan.id,
      source_table: "did_daily_session_plans",
      content_md: `<!-- backward_compatible session_summary plan_id=${ctx.plan.id} review_id=${reviewId} -->

${outputs.practical_report_text}`,
      drive_target_path: cardTarget,
      metadata: {
        ...commonMetadata,
        report_kind: "backward_compatible_summary",
        authoritative: false,
      },
      status: "pending_drive",
    });
  }

  await sb
    .from("did_session_reviews")
    .update({
      analysis_json: { ...analysisJson, drive_write_ids: writeIds },
      drive_sync_status: "queued",
      source_of_truth_status: "pending_drive_sync",
      updated_at: now,
    })
    .eq("id", reviewId);

  return { sessionLogTarget, cardTarget, reviewId, reviewStatus };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS")
    return new Response(null, { headers: corsHeaders });

  let requestBody: any = {};
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const apiKey = Deno.env.get("LOVABLE_API_KEY")!;
    if (!apiKey) throw new Error("LOVABLE_API_KEY není nastavený.");

    const sb = createClient(supabaseUrl, serviceKey);

    const body = await req.json().catch(() => ({}));
    requestBody = body;
    if (body?.processPendingJobs === true) {
      const limit = Math.max(1, Math.min(5, Number(body?.limit ?? 1)));
      const { data: jobs, error: jobsError } = await sb
        .from("karel_action_jobs")
        .select("*")
        .eq("job_type", "session_evaluation")
        .in("status", ["pending", "failed_retry"])
        .order("created_at", { ascending: true })
        .limit(limit);
      if (jobsError) throw jobsError;
      const results: any[] = [];
      for (const job of jobs ?? []) {
        const payload = {
          ...(job.result_payload && typeof job.result_payload === "object"
            ? job.result_payload
            : {}),
          planId: job.plan_id,
          jobId: job.id,
          attempt_count: job.attempt_count ?? 0,
          jobStartedAt: job.started_at ?? null,
        };
        delete payload.enqueueOnly;
        delete payload.processPendingJobs;
        const res = await fetch(
          `${supabaseUrl}/functions/v1/karel-did-session-evaluate`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${Deno.env.get("SUPABASE_ANON_KEY") ?? serviceKey}`,
            },
            body: JSON.stringify(payload),
          },
        );
        const json = await res
          .json()
          .catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
        results.push({ job_id: job.id, status: res.status, ...json });
      }
      return new Response(
        JSON.stringify({ ok: true, processed: results.length, results }),
        {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }
    const planId = body?.planId as string | undefined;
    let completedBlocks =
      typeof body?.completedBlocks === "number"
        ? body.completedBlocks
        : undefined;
    let totalBlocks =
      typeof body?.totalBlocks === "number" ? body.totalBlocks : undefined;
    const endedReason: EndedReason = body?.endedReason ?? "completed";
    let turnsByBlock = (body?.turnsByBlock ?? {}) as Record<string, any[]>;
    let observationsByBlock = (body?.observationsByBlock ?? {}) as Record<
      string,
      string
    >;
    const force = body?.force === true;
    const deterministicBackfill = body?.deterministic_backfill === true;
    const enqueueOnly = body?.enqueueOnly === true;
    const jobId = typeof body?.jobId === "string" ? body.jobId : null;

    if (body?.projection_only === true) {
      const reviewId = body?.reviewId as string | undefined;
      if (!reviewId) {
        return new Response(
          JSON.stringify({
            ok: false,
            error: "reviewId je povinné pro projection_only",
          }),
          {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }
      const { data: review, error: reviewErr } = await sb
        .from("did_session_reviews")
        .select(
          "id,user_id,plan_id,part_name,session_date,status,team_implications,therapeutic_implications,next_session_recommendation,evidence_limitations",
        )
        .eq("id", reviewId)
        .maybeSingle();
      if (reviewErr) throw reviewErr;
      if (!review) {
        return new Response(
          JSON.stringify({ ok: false, error: "Review nenalezeno" }),
          {
            status: 404,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }
      const projection = await projectReviewToPametKarel(
        sb,
        review as SessionReviewRow,
      );
      return new Response(
        JSON.stringify({
          ok: true,
          projection_only: true,
          review_id: reviewId,
          projection,
        }),
        {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    if (!planId) {
      return new Response(
        JSON.stringify({ ok: false, error: "planId je povinné" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    if (jobId)
      await markJobRunning(sb, {
        id: jobId,
        started_at: body?.jobStartedAt ?? null,
        attempt_count: body?.attempt_count ?? 0,
      });
    const ctx = await loadContext(sb, planId);
    if (enqueueOnly) {
      assertPlanWasApprovedAndStarted(ctx.plan);
      const job = await enqueueSessionEvaluationJob(sb, ctx, body);
      await sb
        .from("did_daily_session_plans")
        .update({
          status: "pending_review",
          updated_at: new Date().toISOString(),
        })
        .eq("id", planId);
      return new Response(
        JSON.stringify({
          ok: true,
          queued: true,
          job_id: job.id,
          job_type: job.job_type,
          status: job.status,
          plan_id: planId,
          thread_id: job.thread_id,
          part_name: job.part_name,
        }),
        {
          status: 202,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }
    const liveProgress = await loadLiveProgress(sb, planId);
    if (liveProgress) {
      completedBlocks =
        completedBlocks ?? liveProgress.completed_blocks ?? undefined;
      totalBlocks = totalBlocks ?? liveProgress.total_blocks ?? undefined;
      if (!hasEvidence(turnsByBlock, observationsByBlock, completedBlocks)) {
        turnsByBlock = (liveProgress.turns_by_block ?? {}) as Record<
          string,
          any[]
        >;
        const items = Array.isArray(liveProgress.items)
          ? liveProgress.items
          : [];
        observationsByBlock = Object.fromEntries(
          items
            .map((it: any, idx: number): [string, string] => [
              String(idx),
              String(it?.observation ?? ""),
            ])
            .filter((entry: [string, string]) => entry[1].trim().length > 0),
        );
      }
    }

    // Idempotence guard — pokud už evaluováno a NE force, vrať existující.
    if (
      !force &&
      ctx.existingSession?.ai_analysis &&
      ctx.existingSession.ai_analysis.length > 200 &&
      ctx.plan.status === "completed"
    ) {
      return new Response(
        JSON.stringify({
          ok: true,
          reused: true,
          message: "Sezení už bylo vyhodnoceno. Použij force=true pro přepis.",
          markdown: ctx.existingSession.ai_analysis,
        }),
        {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const evidencePresent = hasEvidence(
      turnsByBlock,
      observationsByBlock,
      completedBlocks,
    );
    const startEvidence = sessionStartedEvidence({
      completedBlocks,
      turnsByBlock,
      observationsByBlock,
      liveProgress,
      threads: ctx.threads,
    });
    const sessionContract =
      ctx.plan.urgency_breakdown &&
      typeof ctx.plan.urgency_breakdown === "object"
        ? ctx.plan.urgency_breakdown
        : {};
    if (
      endedReason === "auto_safety_net" &&
      !startEvidence.started &&
      sessionContract?.session_actor !== "karel_direct"
    ) {
      const audit = await persistPlannedNotStartedAudit(sb, ctx, {
        liveProgress,
        turnsByBlock,
        observationsByBlock,
        force,
      });
      return new Response(
        JSON.stringify({
          ok: true,
          plan_id: planId,
          part_name: ctx.plan.selected_part,
          outcome: "planned_not_started",
          review_status: audit.reviewStatus,
          review_id: audit.reviewId,
          post_session_result: audit.postSessionResult,
        }),
        {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }
    if (endedReason !== "auto_safety_net" || startEvidence.started) {
      assertPlanWasApprovedAndStarted(ctx.plan);
    }
    if (sessionContract?.session_actor === "karel_direct") {
      const mode = String(sessionContract?.session_mode ?? "");
      const hasPartResponse = karelDirectHasPartResponse(ctx.threads);
      const evidenceValidity = karelDirectEvidenceValidity({
        hasPartResponse,
        evidencePresent,
        completedBlocks,
        totalBlocks,
        turnsByBlock,
        observationsByBlock,
        liveProgress,
      });
      const supportiveEvidence =
        countTurnBlocks(turnsByBlock) > 0 ||
        countObservationBlocks(observationsByBlock) > 0 ||
        hasPartResponse ||
        liveProgress?.post_session_result?.provenance === "therapist_entered" ||
        !!liveProgress?.post_session_result?.entered_by;
      const actualPartIfDiffers = inferActualPartIfDiffers(ctx);
      if (
        mode === "deferred" ||
        actualPartIfDiffers ||
        (!hasPartResponse && !evidencePresent)
      ) {
        const outcome: KarelDirectOutcome =
          mode === "deferred"
            ? "deferred"
            : actualPartIfDiffers
              ? "actual_part_differs"
              : "unavailable";
        const audit = await persistKarelDirectOutcome(sb, ctx, {
          outcome,
          endedReason,
          evidencePresent,
          evidenceValidity,
          hasPartResponse,
          supportiveEvidence,
          createFollowUp:
            outcome === "deferred"
              ? !hasKarelDirectDeferredReason(ctx.plan, liveProgress)
              : true,
          actualPartIfDiffers,
        });
        return new Response(
          JSON.stringify({
            ok: true,
            plan_id: planId,
            part_name: ctx.plan.selected_part,
            completion_status: outcome,
            review_status: audit.reviewStatus,
            post_session_result: audit.postSessionResult,
          }),
          {
            status: 200,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }
    }
    const blockTranscript = formatBlockTurnsForPrompt(
      turnsByBlock,
      observationsByBlock,
    );
    const threadTranscript = formatThreadMessagesForPrompt(
      ctx.threads,
      ctx.plan,
    );

    if (deterministicBackfill && ctx.existingSession?.ai_analysis) {
      const existing = String(ctx.existingSession.ai_analysis ?? "").trim();
      const karelNotes = String(ctx.existingSession.karel_notes ?? "").trim();
      const evaluation = sanitizeEvaluation(
        {
          completion_status:
            completedBlocks && totalBlocks && completedBlocks >= totalBlocks
              ? "completed"
              : "partial",
          incomplete_note:
            completedBlocks && totalBlocks && completedBlocks >= totalBlocks
              ? ""
              : "Deterministický backfill vychází ze starší uložené analýzy; průběhová evidence může být omezená.",
          session_arc: existing.slice(0, 1400),
          child_perspective: karelNotes || existing.slice(0, 1200),
          therapist_motivation: `Sezení vedla ${ctx.plan.session_lead || ctx.plan.therapist || "Hanička"}; Karel zůstává v roli live asistenta terapeutky.`,
          methods_used: ctx.existingSession.methods_used ?? [],
          methods_effectiveness:
            ctx.existingSession.methods_effectiveness ?? [],
          key_insights: [existing.slice(0, 500)].filter(Boolean),
          implications_for_tomorrow:
            ctx.existingSession.handoff_note ||
            "Navázat podle závěrů starší analýzy a nepřekročit limity dostupné evidence.",
          tasks: [],
          recommended_next_step:
            ctx.existingSession.handoff_note ||
            "Navázat bezpečným, terapeutkou vedeným Sezením podle dostupnosti části.",
          detailed_analysis_text: `## SEZENÍ — DETAILNÍ PROFESIONÁLNÍ ANALÝZA\n\nDeterministický backfill ze starší uložené analýzy, bez mazání původního clinical_summary ani ai_analysis.\n\n${existing}`,
          practical_report_text: `## SEZENÍ — PRAKTICKÝ REPORT PRO KARLŮV PŘEHLED\n\nSezení s ${ctx.plan.selected_part} bylo vyhodnoceno ze starší uložené analýzy a dostupného plánu. Karel tento výstup používá jako praktický vstup pro ranní přehled a další plánování.\n\n${(karelNotes || existing).slice(0, 2600)}`,
          team_closing_text: `## SEZENÍ — TÝMOVÉ UZAVŘENÍ\n\nDěkuji Haničce a týmu za vedení Sezení s ${ctx.plan.selected_part}. Tento backfill odděluje detailní analýzu, praktický report a týmové uzavření, aniž by přepisoval původní data do prázdna.`,
          implications_for_part: karelNotes || existing.slice(0, 900),
          implications_for_system:
            ctx.existingSession.handoff_note ||
            "Kluci potřebují návaznost opřenou o uloženou analýzu a bezpečné tempo.",
          recommendations_for_therapists:
            "Použít report jako pracovní, zkontrolovat jej proti vlastní paměti Sezení a neeskalovat nad rámec evidence.",
          recommendations_for_next_session:
            ctx.existingSession.handoff_note ||
            "Navázat krátce a bezpečně podle dostupnosti části.",
          recommendations_for_next_playroom:
            "Hernu použít jen tehdy, pokud bude pro část bezpečný nízkoprahový cíl.",
          risks: [],
          evidence_limitations:
            "Deterministický backfill: strukturovaný výstup vznikl z existující uložené analýzy, nikoli z nového dlouhého AI běhu.",
          what_not_to_do: [
            "nemazat původní ai_analysis",
            "nepředstírat novou turn-by-turn evidenci",
          ],
        },
        endedReason,
        completedBlocks,
        totalBlocks,
      );
      const diagnosticValidity = buildDiagnosticValidityReport(
        ctx.plan.plan_markdown,
        turnsByBlock,
        observationsByBlock,
        liveProgress,
      );
      const markdown = renderEvaluationMarkdown(
        evaluation,
        ctx.plan,
        endedReason,
        completedBlocks,
        totalBlocks,
        diagnosticValidity,
      );
      const targets = await persistEvaluation(
        sb,
        ctx,
        evaluation,
        markdown,
        endedReason,
        completedBlocks,
        totalBlocks,
        force,
        liveProgress,
        turnsByBlock,
        observationsByBlock,
        diagnosticValidity,
      );
      const result = {
        ok: true,
        deterministic_backfill: true,
        job_id: jobId,
        plan_id: planId,
        part_name: ctx.plan.selected_part,
        completion_status: evaluation.completion_status,
        review_id: targets.reviewId,
        review_status: targets.reviewStatus,
        drive_targets: targets,
      };
      await markJobCompleted(sb, jobId, result);
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const partInfo = ctx.partCard
      ? `Karta/registry záznam části nalezen: zadané jméno=${ctx.plan.selected_part}, kanonické jméno=${ctx.partCard.part_name}, ` +
        `registry_id=${ctx.partCard.id}, věk≈${ctx.partCard.age_estimate ?? "?"}, role=${ctx.partCard.role_in_system ?? "?"}, ` +
        `aktuální stav=${ctx.partCard.last_emotional_state ?? "?"}. Přímá Drive vazba není v DB uložena, netvrď proto, že karta neexistuje.`
      : ctx.partCardLookup?.status === "ambiguous"
        ? `(registry lookup části ${ctx.plan.selected_part} je nejednoznačný: ${ctx.partCardLookup.reason}; netvrď, že karta neexistuje)`
        : `(registry záznam části ${ctx.plan.selected_part} v DB nenalezen)`;

    const blockSummary = totalBlocks
      ? `Blocks completed: ${completedBlocks ?? "?"}/${totalBlocks}` +
        (endedReason === "auto_safety_net"
          ? " (vyhodnocování spustil noční safety-net, terapeutka sezení formálně neuzavřela)"
          : "")
      : "Počet bloků nebyl předán.";
    const liveReplanPatch = liveProgress?.live_replan_patch && typeof liveProgress.live_replan_patch === "object" ? liveProgress.live_replan_patch : null;
    const liveReplanEvidence = liveReplanPatch
      ? `────────────  LIVE_REPLAN_PATCH / REALITY OVERRIDE  ────────────
current_block_status: ${liveProgress?.current_block_status ?? "paused_by_reality_override"}
active_live_replan_id: ${liveProgress?.active_live_replan_id ?? liveReplanPatch.id ?? "unknown"}
verification_status: ${liveReplanPatch?.factual_frame?.verification_status ?? liveProgress?.reality_verification?.verification_status ?? "therapist_report_only"}
source_url: ${liveReplanPatch?.factual_frame?.source_url ?? "none"}
evidence discipline: therapist_factual_correction ≠ child clinical evidence; verified_external_fact ≠ child clinical evidence; child_response_to_event = possible clinical material only if vlastní slova/afekt/tělo/chování části jsou zaznamenané.
LIVE_REPLAN_PATCH:
${JSON.stringify(liveReplanPatch, null, 2).slice(0, 3500)}`
      : "";

    const prompt = `KONTEXT VYHODNOCOVANÉHO SEZENÍ
══════════════════════════════════════════════
Datum: ${ctx.plan.plan_date}
Část: ${ctx.plan.selected_part}
Vede: ${ctx.plan.session_lead || ctx.plan.therapist}
Důvod ukončení: ${endedReason}
${blockSummary}
Evidence status: ${evidencePresent ? "průběhová data jsou k dispozici" : "chybí průběhová data; NESMÍŠ z toho vyvodit, že sezení neproběhlo"}

${partInfo}

────────────  PROGRAM SEZENÍ (z porady)  ────────────
${ctx.plan.plan_markdown ?? "(plán nebyl uložen)"}

────────────  KONVERZACE PER BLOK (z LiveProgramChecklist)  ────────────
${blockTranscript}

────────────  THREAD VLÁKNO ZE DNE SEZENÍ  ────────────
${threadTranscript}
${liveReplanEvidence ? `\n${liveReplanEvidence}\n` : ""}
══════════════════════════════════════════════

ÚKOL:
Vyhodnoť toto sezení. Drž se pravidel ze system promptu.
- Pokud sezení nebylo dokončené, completion_status='partial' nebo 'abandoned' a v incomplete_note popiš co se nestihlo.
- Pokud chybí průběhová data, nepiš, že sezení bylo sotva začaté/neuskutečněné; napiš jen, že chybí dostatečný záznam.
- Pokud proběhla alespoň polovina bodů, completion_status nesmí být 'abandoned'.
- HLAVNÍ VRSTVA = child_perspective (4-7 vět, konkrétně, pro Tundrupka / příslušnou část).
- Therapist_motivation drž stručné (1-2 věty).
- Vrať VÝHRADNĚ tool call emit_session_evaluation.

POVINNÉ ROZDĚLENÍ VÝSTUPU:
- detailed_analysis_text = odborná detailní analýza, delší a strukturovaná.
- practical_report_text = kratší report pro Karlův přehled a další plánování.
- team_closing_text = konkrétní týmové uzavření navázané na průběh Sezení.
- Pokud evidence nestačí, nevyplňuj falešnou plnou analýzu; jasně popiš limity a bezpečný další krok.`;

    const evaluation = sanitizeEvaluation(
      await callAi(prompt, apiKey),
      endedReason,
      completedBlocks,
      totalBlocks,
    );
    const diagnosticValidity = buildDiagnosticValidityReport(
      ctx.plan.plan_markdown,
      turnsByBlock,
      observationsByBlock,
      liveProgress,
    );
    const markdown = renderEvaluationMarkdown(
      evaluation,
      ctx.plan,
      endedReason,
      completedBlocks,
      totalBlocks,
      diagnosticValidity,
    );

    if (sessionContract?.session_actor === "karel_direct") {
      const hasPartResponse = karelDirectHasPartResponse(ctx.threads);
      const evidenceValidity = karelDirectEvidenceValidity({
        hasPartResponse,
        evidencePresent,
        completedBlocks,
        totalBlocks,
        turnsByBlock,
        observationsByBlock,
        liveProgress,
      });
      const supportiveEvidence =
        countTurnBlocks(turnsByBlock) > 0 ||
        countObservationBlocks(observationsByBlock) > 0 ||
        hasPartResponse ||
        liveProgress?.post_session_result?.provenance === "therapist_entered" ||
        !!liveProgress?.post_session_result?.entered_by;
      const karelOutcome: KarelDirectOutcome =
        evaluation.completion_status === "completed" &&
        evidencePresent &&
        hasPartResponse
          ? "completed"
          : "partial";
      const audit = await persistKarelDirectOutcome(sb, ctx, {
        outcome: karelOutcome,
        endedReason,
        evidencePresent,
        evidenceValidity,
        hasPartResponse,
        supportiveEvidence,
        actualPartIfDiffers: null,
      });
      return new Response(
        JSON.stringify({
          ok: true,
          plan_id: planId,
          part_name: ctx.plan.selected_part,
          completion_status: karelOutcome,
          review_status: audit.reviewStatus,
          post_session_result: audit.postSessionResult,
          markdown,
        }),
        {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const targets = await persistEvaluation(
      sb,
      ctx,
      evaluation,
      markdown,
      endedReason,
      completedBlocks,
      totalBlocks,
      force,
      liveProgress,
      turnsByBlock,
      observationsByBlock,
      diagnosticValidity,
    );

    const result = {
      ok: true,
      job_id: jobId,
      plan_id: planId,
      part_name: ctx.plan.selected_part,
      completion_status: evaluation.completion_status,
      review_id: targets.reviewId,
      review_status: targets.reviewStatus,
      markdown,
      evaluation,
      drive_targets: targets,
    };
    await markJobCompleted(sb, jobId, result);
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e: any) {
    console.error("[karel-did-session-evaluate] fatal:", e);
    const failedJobId =
      typeof requestBody?.jobId === "string" ? requestBody.jobId : null;
    if (failedJobId)
      await markJobFailedRetry(
        createClient(
          Deno.env.get("SUPABASE_URL")!,
          Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
        ),
        failedJobId,
        e,
      );
    return new Response(
      JSON.stringify({ ok: false, error: e?.message ?? String(e) }),
      {
        status: e?.status ?? 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
