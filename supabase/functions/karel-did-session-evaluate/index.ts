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
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const AI_URL = "https://ai.gateway.lovable.dev/v1/chat/completions";
const MODEL = "google/gemini-2.5-pro";
const PAMET_KAREL_HANKA_INSIGHTS_TARGET = "PAMET_KAREL/DID/HANKA/KARLOVY_POZNATKY";
const PAMET_KAREL_DEDUPE_STATUSES = ["pending", "completed", "failed", "failed_permanent", "skipped"];

type EndedReason = "completed" | "partial" | "auto_safety_net" | "manual_end" | "save_transcript" | "exit_session";

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
          description: "completed = celý program; partial = část programu; abandoned = sotva začalo.",
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
          description: "2-4 klinické závěry / hypotézy z dnešního sezení. Konkrétní, ne 'pokračovat v práci'.",
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
              owner: { type: "string", enum: ["hanka", "kata", "karel", "both"] },
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
- Práce terapeutky (Hanička / Káťa) je SEKUNDÁRNÍ vrstva — pojmenuj v 1-2 větách, ale neorientuj na to celý report.
- Pokud sezení nebylo dokončené, NEPŘEDSTÍREJ, že bylo. Explicitně to napiš v completion_status + incomplete_note,
  a vyhodnoť POUZE to, co reálně proběhlo. Nevymýšlej si bloky, které nikdo neudělal.

ANTI-FABRIKACE:
- Vycházej VÝHRADNĚ z poskytnutého: programu sezení, konverzace per blok, observací,
  karty části. Pokud něco v datech nemáš, napiš "nebylo zaznamenáno", NIKDY nefabrikuj.
- ABSENCE ZÁZNAMU NENÍ DŮKAZ, ŽE SEZENÍ NEPROBĚHLO. Pokud chybí průběhová data,
  napiš, že chybí záznam o průběhu / formálním ukončení; nesmíš tvrdit, že sezení
  bylo sotva začaté, přerušeno nebo neuskutečněno.
- Pokud většina bodů programu proběhla, completion_status nesmí být abandoned.

TÓN:
- Kultivovaná čeština. Konkrétně, klinicky, bez patosu.
- Žádné "celkově to byl posun" / "skvělá práce" — místo toho konkrétní moment z dat.

Vrať VÝHRADNĚ tool call emit_session_evaluation.`;

interface SessionPlan {
  id: string;
  user_id: string;
  plan_date: string;
  selected_part: string;
  therapist: string;
  session_lead?: string | null;
  session_format?: string | null;
  plan_markdown: string | null;
  status: string;
  completed_at: string | null;
  crisis_event_id: string | null;
}

type ReviewStatus = "analyzed" | "partially_analyzed" | "evidence_limited" | "failed_analysis" | "cancelled";

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

interface PartCardLookup {
  status: "resolved" | "missing" | "ambiguous";
  reason: string;
  selected_part: string;
  canonical_part_name: string | null;
  registry_id: string | null;
  candidates: Array<{ id: string; part_name: string; display_name?: string | null; status?: string | null; drive_folder_label?: string | null; updated_at?: string | null }>;
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
  const aliases = Array.isArray(row?.aliases) ? row.aliases : Array.isArray(row?.metadata?.aliases) ? row.metadata.aliases : [];
  return [row?.part_name, row?.display_name, row?.drive_folder_label, ...aliases].filter(Boolean).map(String);
}

function scorePartCandidate(row: any, selectedPart: string): number[] {
  const selectedTrim = selectedPart.trim();
  const selectedNorm = normalizePartLookupKey(selectedTrim);
  const partNorm = normalizePartLookupKey(row?.part_name);
  const displayNorm = normalizePartLookupKey(row?.display_name);
  const driveNorm = normalizePartLookupKey(row?.drive_folder_label);
  const statusNorm = normalizePartLookupKey(row?.status);
  const uppercaseCanonical = row?.part_name === String(row?.part_name ?? "").toUpperCase() && row?.display_name === String(row?.display_name ?? "").toUpperCase();
  return [
    uppercaseCanonical ? 1 : 0,
    row?.part_name === selectedTrim ? 1 : 0,
    partNorm === selectedNorm ? 1 : 0,
    displayNorm && displayNorm === partNorm && row?.display_name === String(row?.display_name ?? "").toUpperCase() ? 1 : 0,
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

async function resolveCanonicalPart(sb: any, userId: string, selectedPart: string): Promise<{ partCard: any | null; lookup: PartCardLookup }> {
  const selectedNorm = normalizePartLookupKey(selectedPart);
  const { data: registryRows, error } = await sb
    .from("did_part_registry")
    .select("id, part_name, display_name, status, drive_folder_label, age_estimate, role_in_system, last_emotional_state, updated_at")
    .eq("user_id", userId);
  if (error) throw error;

  const candidates = (registryRows ?? []).filter((row: any) =>
    partCandidateNames(row).some((name) => {
      const norm = normalizePartLookupKey(name);
      return norm === selectedNorm || norm.includes(selectedNorm) || selectedNorm.includes(norm);
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
    console.warn("[evaluate] part_lookup_missing", { selectedPart, selectedNorm });
    return {
      partCard: null,
      lookup: { status: "missing", reason: "no_registry_candidate", selected_part: selectedPart, canonical_part_name: null, registry_id: null, candidates: [] },
    };
  }

  const ranked = candidates
    .map((row: any) => ({ row, score: scorePartCandidate(row, selectedPart) }))
    .sort((a: any, b: any) => comparePartScores(b.score, a.score));
  const top = ranked[0];
  const second = ranked[1];
  if (second && comparePartScores(top.score, second.score) === 0) {
    console.warn("[evaluate] ambiguous_part_lookup", { selectedPart, candidates: candidateSummary });
    return {
      partCard: null,
      lookup: { status: "ambiguous", reason: "multiple_equal_registry_candidates", selected_part: selectedPart, canonical_part_name: null, registry_id: null, candidates: candidateSummary },
    };
  }

  if (candidates.length > 1) {
    console.warn("[evaluate] canonical_part_lookup_multiple_candidates", { selectedPart, selected: top.row.id, candidates: candidateSummary });
  }
  return {
    partCard: top.row,
    lookup: {
      status: "resolved",
      reason: candidates.length > 1 ? "resolved_by_priority" : "single_registry_candidate",
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

  // Najít LIVE thread (cast/karel_part_session) pro stejnou část v okně sezení.
  const { data: threadCandidates } = await sb
    .from("did_threads")
    .select("id, part_name, sub_mode, started_at, last_activity_at, messages")
    .ilike("part_name", plan.selected_part)
    .gte("last_activity_at", `${plan.plan_date}T00:00:00Z`)
    .lte("last_activity_at", `${plan.plan_date}T23:59:59Z`)
    .order("last_activity_at", { ascending: false })
    .limit(3);

  // Karta části (DB-side mirror) — deterministický resolver místo nejednoznačného ilike+maybeSingle.
  const { partCard, lookup: partCardLookup } = await resolveCanonicalPart(sb, plan.user_id, plan.selected_part);

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
    new Set([...Object.keys(turnsByBlock), ...Object.keys(observationsByBlock)]),
  ).sort((a, b) => Number(a) - Number(b));
  if (blockKeys.length === 0) return "(žádný turn-by-turn log z bloků nebyl předán)";
  return blockKeys
    .map((k) => {
      const turns = (turnsByBlock[k] ?? []).slice(0, 30);
      const obs = (observationsByBlock[k] ?? "").trim();
      const turnsBlock = turns.length
        ? turns.map((t) => `  ${t.from === "karel" ? "K" : "H"}: ${(t.text || "").slice(0, 400)}`).join("\n")
        : "  (bez konverzace)";
      const obsBlock = obs ? `\n  📝 pozorování: ${obs.slice(0, 400)}` : "";
      return `▸ Bod #${Number(k) + 1}\n${turnsBlock}${obsBlock}`;
    })
    .join("\n\n");
}

function formatThreadMessagesForPrompt(threads: any[], plan: SessionPlan): string {
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
    return `(thread existuje, ale žádná zpráva ze dne ${plan.plan_date}; používám i mimo-denní vzorek)\n` +
      messages.slice(-15).map((m) => `${m.role}: ${m.content}`).join("\n");
  }
  return filtered.map((m) => `${m.role}: ${m.content}`).join("\n");
}

async function loadLiveProgress(sb: any, planId: string) {
  const { data } = await sb
    .from("did_live_session_progress")
    .select("items, turns_by_block, artifacts_by_block, completed_blocks, total_blocks, finalized_reason, last_activity_at")
    .eq("plan_id", planId)
    .maybeSingle();
  return data ?? null;
}

function hasEvidence(turnsByBlock: Record<string, any[]>, observationsByBlock: Record<string, string>, completedBlocks?: number): boolean {
  return (completedBlocks ?? 0) > 0 ||
    Object.values(turnsByBlock || {}).some(v => Array.isArray(v) && v.length > 0) ||
    Object.values(observationsByBlock || {}).some(v => String(v || "").trim().length > 0);
}

function buildEvidenceItems(ctx: { plan: SessionPlan; threads: any[]; partCard: any; partCardLookup?: PartCardLookup }, liveProgress: any, turnsByBlock: Record<string, any[]>, observationsByBlock: Record<string, string>) {
  const progressItems = Array.isArray(liveProgress?.items) ? liveProgress.items : [];
  const lookup = ctx.partCardLookup ?? {
    status: ctx.partCard ? "resolved" : "missing",
    reason: ctx.partCard ? "legacy_resolved" : "legacy_missing",
    canonical_part_name: ctx.partCard?.part_name ?? null,
    registry_id: ctx.partCard?.id ?? null,
  } as PartCardLookup;
  return [
    { kind: "session_plan", available: !!ctx.plan, source_table: "did_daily_session_plans", source_id: ctx.plan.id, date: ctx.plan.plan_date },
    { kind: "live_progress", available: !!liveProgress, source_table: "did_live_session_progress", source_id: ctx.plan.id, completed_blocks: liveProgress?.completed_blocks ?? null, total_blocks: liveProgress?.total_blocks ?? null },
    { kind: "checklist", available: progressItems.length > 0, count: progressItems.length },
    { kind: "turn_by_turn", available: Object.values(turnsByBlock || {}).some((v) => Array.isArray(v) && v.length > 0), block_count: Object.keys(turnsByBlock || {}).length },
    { kind: "observations", available: Object.values(observationsByBlock || {}).some((v) => String(v || "").trim().length > 0), count: Object.values(observationsByBlock || {}).filter((v) => String(v || "").trim().length > 0).length },
    { kind: "thread_transcript", available: (ctx.threads || []).some((t: any) => Array.isArray(t.messages) && t.messages.length > 0), thread_count: ctx.threads?.length ?? 0 },
    { kind: "part_card", available: lookup.status === "resolved" && !!ctx.partCard, source_table: "did_part_registry", part_name: ctx.plan.selected_part, canonical_part_name: lookup.canonical_part_name, registry_id: lookup.registry_id, lookup_status: lookup.status, lookup_reason: lookup.reason },
  ];
}

function checklistItems(liveProgress: any) {
  const items = Array.isArray(liveProgress?.items) ? liveProgress.items : [];
  const labelOf = (it: any, idx: number) => String(it?.title || it?.label || it?.text || it?.name || `Bod ${idx + 1}`);
  const done = items.filter((it: any) => it?.done === true || it?.completed === true || it?.status === "done");
  const missing = items.filter((it: any) => !(it?.done === true || it?.completed === true || it?.status === "done"));
  return {
    completed: done.map((it: any, idx: number) => ({ label: labelOf(it, idx), status: it?.status ?? "done" })),
    missing: missing.map((it: any, idx: number) => ({ label: labelOf(it, idx), status: it?.status ?? "missing" })),
  };
}

function reviewStatusFor(evaluation: any, evidencePresent: boolean, completedBlocks?: number, totalBlocks?: number): ReviewStatus {
  if (!evidencePresent) return "evidence_limited";
  if (evaluation?.completion_status === "completed") return "analyzed";
  if ((completedBlocks ?? 0) > 0 || evaluation?.completion_status === "partial") return "partially_analyzed";
  if (totalBlocks && totalBlocks > 0) return "evidence_limited";
  return "partially_analyzed";
}

function cleanMemoryLine(value: unknown, max = 520): string {
  return String(value ?? "")
    .replace(/<!--[^]*?-->/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function hasHankaWorkImplication(review: SessionReviewRow, evaluation?: any): boolean {
  if (review.status === "failed_analysis" || !review.id) return false;
  const teamText = cleanMemoryLine(review.team_implications ?? evaluation?.therapist_motivation, 900);
  if (teamText.length < 35) return false;
  const workSignal = /(hanič|hanka|hana|terapeut|tým|veden[íi]|karel|další pr[aá]c|zp[uů]sob|postup|koordinac|superviz)/i;
  const clinicalOnly = /(arthur|část|dít[eě]|kluci)/i.test(teamText) && !workSignal.test(teamText);
  return workSignal.test(teamText) && !clinicalOnly;
}

function buildPametKarelReviewPayload(review: SessionReviewRow, ctx?: { plan?: SessionPlan }, evaluation?: any): string | null {
  if (!hasHankaWorkImplication(review, evaluation)) return null;
  const date = review.session_date || ctx?.plan?.plan_date || pragueDayISO();
  const partName = review.part_name || ctx?.plan?.selected_part || "část";
  const teamInsight = cleanMemoryLine(review.team_implications ?? evaluation?.therapist_motivation);
  const nextStep = cleanMemoryLine(review.next_session_recommendation ?? evaluation?.recommended_next_step ?? "Příště má Karel navázat pracovně opatrně a ověřit, zda se tento závěr potvrzuje v další evidenci.");
  const verification = cleanMemoryLine(review.evidence_limitations ?? "Validita je omezená podle evidence review; je potřeba doplnit nebo ověřit v dalším kontaktu.", 420);

  return `[${date}] Z review sezení ${partName} plyne pracovní poznatek:

- ${teamInsight}
- Příště má Karel při vedení Haničky / týmu zohlednit tento pracovní signál: ${nextStep}
- Ověřit nebo doplnit: ${verification}

Poznámka k jistotě:
Toto je pracovní dedukce z review, ne tvrdý klinický fakt. Validita je omezená podle evidence review.

Zdroj: did_session_review:${review.id}
`.trim();
}

async function projectReviewToPametKarel(sb: any, review: SessionReviewRow, ctx?: { plan?: SessionPlan }, evaluation?: any) {
  const payload = buildPametKarelReviewPayload(review, ctx, evaluation);
  if (!payload) return { inserted: false, reason: "no_clear_hanka_work_implication" };

  const marker = `did_session_review:${review.id}`;
  const { data: existingWrites, error: existingErr } = await sb
    .from("did_pending_drive_writes")
    .select("id,status")
    .eq("target_document", PAMET_KAREL_HANKA_INSIGHTS_TARGET)
    .in("status", PAMET_KAREL_DEDUPE_STATUSES)
    .ilike("content", `%${marker}%`)
    .limit(1);
  if (existingErr) throw existingErr;
  if (existingWrites && existingWrites.length > 0) return { inserted: false, reason: "already_projected" };

  const content = encodeGovernedWrite(payload, {
    source_type: "did_session_review",
    source_id: review.id,
    content_type: "therapist_memory_note",
    subject_type: "therapist",
    subject_id: "hanka",
    payload_fingerprint: marker,
  });
  const { error: insertErr } = await sb.from("did_pending_drive_writes").insert({
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

function sanitizeEvaluation(evaluation: any, endedReason: EndedReason, completedBlocks?: number, totalBlocks?: number) {
  const ratio = totalBlocks && totalBlocks > 0 ? (completedBlocks ?? 0) / totalBlocks : 0;
  if (ratio >= 0.5 && evaluation.completion_status === "abandoned") {
    evaluation.completion_status = ratio >= 0.85 ? "completed" : "partial";
    evaluation.incomplete_note = evaluation.incomplete_note || "Sezení proběhlo z větší části; nedokončené zůstaly jen některé body programu.";
  }
  if (endedReason === "auto_safety_net" && ratio === 0) {
    const forbidden = /(neuskutečn|sotva zač|hned v úvodu|okamžitě přeruš|nebylo možné realizovat|vůbec zahájit)/i;
    for (const key of ["incomplete_note", "session_arc", "child_perspective", "recommended_next_step"]) {
      if (typeof evaluation[key] === "string" && forbidden.test(evaluation[key])) {
        evaluation[key] = "Sezení nebylo formálně uzavřeno a v backendu není dost průběhových dat pro spolehlivý klinický závěr. Nelze z toho usuzovat, že sezení neproběhlo; je potřeba doplnit ruční záznam terapeutky.";
      }
    }
    if (evaluation.completion_status === "abandoned") evaluation.completion_status = "partial";
  }
  return evaluation;
}

function buildDiagnosticValidityReport(planText: string | null, turnsByBlock: Record<string, any[]>, observationsByBlock: Record<string, string>, liveProgress: any): string {
  const text = `${planText ?? ""}\n${Object.values(observationsByBlock).join("\n")}`.toLowerCase();
  const isAssociation = /(asocia|prvn[íi] n[áa]pad|slovn[íi] hra|\b\d+\s*slov)/i.test(text);
  const isDrawing = /(kresb|nakresl|strom|postav|d[ůu]m|rodin|mapa t[ěe]la|body map)/i.test(text);
  const isRorschach = /(rorsch|ror|inkblot|skvrn)/i.test(text);
  const allTurns = Object.values(turnsByBlock || {}).flat().map((t: any) => String(t?.text ?? ""));
  const allText = `${allTurns.join("\n")}\n${Object.values(observationsByBlock).join("\n")}`;
  const hasLatency = /latenc|\b\d{1,3}\s*(s|sec|sek|sekund)\b/i.test(allText);
  const hasVerbatim = allTurns.some((s) => s.trim().length > 12);
  const hasAffect = /(afekt|pláč|plac|úzkost|uzkost|freeze|ztuhl|smích|smich|napětí|napeti|mlč|mlc)/i.test(allText);
  const hasNonverbal = /(neverb|mimika|postoj|ruce|oči|oci|hlas|zbled|červen|cerven|slzy)/i.test(allText);
  const hasReproduction = /(reproduk|vzpomene|pamatuje|zopak)/i.test(allText);
  const artifacts = liveProgress?.artifacts_by_block && typeof liveProgress.artifacts_by_block === "object"
    ? Object.values(liveProgress.artifacts_by_block).flat() as any[]
    : [];
  const hasImage = artifacts.some((a: any) => a?.kind === "image");
  const hasAudio = artifacts.some((a: any) => a?.kind === "audio");
  const missing: string[] = [];
  if (isAssociation && !hasLatency) missing.push("latence v sekundách");
  if ((isAssociation || isDrawing) && !hasVerbatim) missing.push("doslovný verbatim zápis");
  if ((isAssociation || isDrawing) && !hasAffect) missing.push("afekt / emoční reakce");
  if ((isAssociation || isDrawing) && !hasNonverbal) missing.push("neverbální projevy");
  if (isAssociation && !hasReproduction) missing.push("reprodukční kontrola po pauze");
  if (isAssociation && !hasAudio && !hasVerbatim) missing.push("audio nebo přesný turn-by-turn protokol");
  if (isDrawing && !hasImage) missing.push("foto/kopie kresby či artefaktu");
  const methodLine = [isAssociation ? "asociační experiment" : null, isDrawing ? "kresbová/projektivní metoda" : null, isRorschach ? "ROR/Rorschach téma" : null].filter(Boolean).join(", ") || "bez jasně rozpoznané standardní diagnostické metody";
  const rorGuard = isRorschach
    ? "\n- ROR/Rorschach: Karel nesmí předstírat standardizované skórování; bez kompletní licencované administrace jde pouze o orientační projektivní rozhovor."
    : "";
  return `### Diagnostická validita\nRozpoznaná metoda: ${methodLine}.\n${missing.length ? `Validita je omezená — chybí: ${missing.join(", ")}. Závěry níže ber jako pracovní hypotézy, ne jako standardizovanou psychodiagnostiku.` : "Minimální důkazní vrstva je přítomná; závěry přesto formuluj jako klinické hypotézy a odděl je od doložených pozorování."}${rorGuard}`;
}

function countTurnBlocks(turnsByBlock: Record<string, any[]>): number {
  return Object.values(turnsByBlock || {}).filter((v) => Array.isArray(v) && v.length > 0).length;
}

function countObservationBlocks(observationsByBlock: Record<string, string>): number {
  return Object.values(observationsByBlock || {}).filter((v) => String(v || "").trim().length > 0).length;
}

function countArtifacts(liveProgress: any): number {
  if (!liveProgress?.artifacts_by_block || typeof liveProgress.artifacts_by_block !== "object") return 0;
  return Object.values(liveProgress.artifacts_by_block).flat().length;
}

function hasThreadTranscript(threads: any[] = []): boolean {
  return threads.some((t: any) => Array.isArray(t.messages) && t.messages.length > 0);
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
  const ratio = args.totalBlocks && args.totalBlocks > 0 ? completed / args.totalBlocks : 0;
  const hasStrongEvidence = args.turnBlocks > 0 || args.transcriptAvailable || args.observationBlocks > 0 || args.provenance === "therapist_entered";
  if (completed <= 1 || !hasStrongEvidence || args.provenance !== "therapist_entered") return "low";
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
  const derivedEvidence = args.evidencePresent || turnBlocks > 0 || observationBlocks > 0 || args.transcriptAvailable || artifactCount > 0;
  const provenance: "auto_derived" | "missing" = derivedEvidence ? "auto_derived" : "missing";
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
  const completionRatio = args.totalBlocks && args.totalBlocks > 0 ? (args.completedBlocks ?? 0) / args.totalBlocks : null;
  const transcriptAvailable = hasThreadTranscript(args.threads);
  const confirmedFacts = {
    plan_id: args.plan.id,
    part_name: args.plan.selected_part,
    completedBlocks: args.completedBlocks ?? null,
    totalBlocks: args.totalBlocks ?? null,
    completion_ratio: completionRatio,
    contactOccurred: args.postSessionResult?.contactOccurred ?? false,
    actualPart: args.partCardLookup?.status === "resolved" ? args.partCardLookup.canonical_part_name : null,
    durationMinutes: null,
    evidence_availability: {
      live_progress: args.evidenceItems.find((e) => e.kind === "live_progress")?.available ? "available" : "missing",
      checklist_count: Array.isArray(args.liveProgress?.items) ? args.liveProgress.items.length : 0,
      turn_by_turn_count: countTurnBlocks(args.turnsByBlock),
      observations_count: countObservationBlocks(args.observationsByBlock),
      transcript: transcriptAvailable ? "available" : "missing",
      artifacts_count: countArtifacts(args.liveProgress),
    },
    review_status: args.reviewStatus,
  };
  return {
    schema: "did_session_review.analysis.v1",
    status: "created",
    confirmed_facts: confirmedFacts,
    narrative_summary: {
      session_arc: args.evaluation?.session_arc ?? null,
      child_perspective: args.evaluation?.child_perspective ?? null,
    },
    working_deductions: Array.isArray(args.evaluation?.key_insights) ? args.evaluation.key_insights : [],
    unknowns: [
      args.evaluation?.incomplete_note,
      args.diagnosticValidity,
    ].filter((v) => typeof v === "string" && v.trim().length > 0),
    writebacks: {
      therapeutic_implications: args.evaluation?.implications_for_tomorrow ?? null,
      team_implications: args.evaluation?.therapist_motivation ?? null,
      next_session_recommendation: args.evaluation?.recommended_next_step ?? null,
    },
    review_status: args.reviewStatus,
    post_session_result: args.postSessionResult,
  };
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
      tool_choice: { type: "function", function: { name: "emit_session_evaluation" } },
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
        (totalBlocks ? ` (${completedBlocks ?? "?"}/${totalBlocks} bodů)` : "") +
        (endedReason === "auto_safety_net" ? " · vyhodnoceno automaticky ráno" : "");

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

async function persistEvaluation(
  sb: any,
  ctx: { plan: SessionPlan; existingSession: PartSessionRow | null; threads?: any[]; partCard?: any; partCardLookup?: PartCardLookup },
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
    : String(therapistLabel).toLowerCase().includes("oba") || String(therapistLabel).toLowerCase().includes("společ")
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
    short_term_goals: evaluation.implications_for_tomorrow ? [evaluation.implications_for_tomorrow] : [],
    handoff_note: evaluation.recommended_next_step ?? null,
    updated_at: now,
  };

  if (ctx.existingSession) {
    if (ctx.existingSession.ai_analysis && !force) {
      console.log(`[evaluate] did_part_sessions ${ctx.existingSession.id} already evaluated, skipping (use force=true to overwrite)`);
    } else {
      await sb.from("did_part_sessions").update(sessionPayload).eq("id", ctx.existingSession.id);
    }
  } else {
    await sb.from("did_part_sessions").insert(sessionPayload);
  }

  const evidencePresent = hasEvidence(turnsByBlock, observationsByBlock, completedBlocks);
  const reviewStatus = reviewStatusFor(evaluation, evidencePresent, completedBlocks, totalBlocks);
  const evidenceItems = buildEvidenceItems(ctx as any, liveProgress, turnsByBlock, observationsByBlock);
  const checklist = checklistItems(liveProgress);
  const postSessionResult = buildStructuredPostSessionResult({ evaluation, endedReason, completedBlocks, totalBlocks, evidencePresent, turnsByBlock, observationsByBlock, liveProgress });
  const analysisJson = buildAnalysisJson(evaluation, diagnosticValidity, reviewStatus, postSessionResult);

  const reviewPayload = {
    user_id: userId,
    plan_id: ctx.plan.id,
    part_name: partName,
    session_date: ctx.plan.plan_date,
    status: reviewStatus,
    review_kind: endedReason === "auto_safety_net" ? "calendar_day_safety_net" : "scheduled_session",
    analysis_version: "did-session-review-v1",
    source_data_summary: evidenceItems.map((e: any) => `${e.kind}:${e.available ? "available" : "missing"}`).join(", "),
    evidence_items: evidenceItems,
    completed_checklist_items: checklist.completed,
    missing_checklist_items: checklist.missing,
    transcript_available: evidenceItems.some((e: any) => ["turn_by_turn", "thread_transcript"].includes(e.kind) && e.available),
    live_progress_available: !!liveProgress,
    clinical_summary: markdown,
    therapeutic_implications: evaluation.implications_for_tomorrow ?? null,
    team_implications: evaluation.therapist_motivation ?? null,
    next_session_recommendation: evaluation.recommended_next_step ?? null,
    evidence_limitations: diagnosticValidity,
    analysis_json: analysisJson,
    projection_status: reviewStatus === "failed_analysis" ? "skipped" : "queued",
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
    await sb.from("did_session_reviews").update(reviewPayload).eq("id", reviewId);
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
      lifecycle_status: reviewStatus,
      completed_at: now,
      finalized_at: now,
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

  // 3) karel_pantry_b_entries — anti-dup podle source_ref
  const sourceRef = `session-evaluate:${ctx.plan.id}`;
  const { data: existingPantryB } = await sb
    .from("karel_pantry_b_entries")
    .select("id")
    .eq("source_ref", sourceRef);
  if (existingPantryB && existingPantryB.length > 0 && !force) {
    console.log(`[evaluate] Pantry B already has ${existingPantryB.length} entries for ${sourceRef}, skipping`);
  } else {
    if (force && existingPantryB && existingPantryB.length > 0) {
      await sb.from("karel_pantry_b_entries").delete().eq("source_ref", sourceRef);
    }
    // Hlavní conclusion
    await appendPantryB(sb, {
      user_id: userId,
      entry_kind: "conclusion",
      source_kind: "therapy_session",
      source_ref: sourceRef,
      summary: `Sezení s ${partName} (${ctx.plan.plan_date}, vede ${therapistLabel}) — ${evaluation.child_perspective.slice(0, 280)}`,
      detail: {
        plan_id: ctx.plan.id,
        completion_status: evaluation.completion_status,
        completed_blocks: completedBlocks,
        total_blocks: totalBlocks,
        ended_reason: endedReason,
        child_perspective: evaluation.child_perspective,
        therapist_motivation: evaluation.therapist_motivation,
        recommended_next_step: evaluation.recommended_next_step,
        incomplete_note: evaluation.incomplete_note,
      },
      intended_destinations: ["briefing_input", "did_implications", "did_therapist_tasks"],
      related_part_name: partName,
      related_therapist: therapistKey ?? undefined,
    });

    // Followup_need pro každý task
    for (const task of evaluation.tasks ?? []) {
      await appendPantryB(sb, {
        user_id: userId,
        entry_kind: "followup_need",
        source_kind: "therapy_session",
        source_ref: sourceRef,
        summary: `[${task.owner}/${task.urgency}] ${task.text}`,
        detail: { plan_id: ctx.plan.id, task },
        intended_destinations: ["did_therapist_tasks", "briefing_input"],
        related_part_name: partName,
        related_therapist: task.owner === "hanka" ? "hanka" : task.owner === "kata" ? "kata" : undefined,
      });
    }

    // Hypothesis_change pro každý key_insight
    for (const insight of evaluation.key_insights ?? []) {
      await appendPantryB(sb, {
        user_id: userId,
        entry_kind: "hypothesis_change",
        source_kind: "therapy_session",
        source_ref: sourceRef,
        summary: insight,
        detail: { plan_id: ctx.plan.id },
        intended_destinations: ["did_implications", "briefing_input"],
        related_part_name: partName,
      });
    }
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
      await sb.from("did_session_reviews").update({ projection_status: "queued", updated_at: now }).eq("id", reviewId);
    }
  }

  // 4) did_pantry_packages — session_summary balík → KARTA_<part>
  const cardTarget = `KARTA_${partName.toUpperCase()}`;
  const sessionLogTarget = `KARTOTEKA_DID/00_CENTRUM/05C_SEZENI_LOG`;

  // Anti-dup: smaž případné staré balíky se stejným source_id (planId).
  if (force) {
    await sb
      .from("did_pantry_packages")
      .delete()
      .eq("source_id", ctx.plan.id)
      .in("status", ["pending_drive", "flushed"]);
  } else {
    const { data: existingPkgs } = await sb
      .from("did_pantry_packages")
      .select("id")
      .eq("source_id", ctx.plan.id)
      .eq("package_type", "session_summary");
    if (existingPkgs && existingPkgs.length > 0) {
      console.log(`[evaluate] Pantry package session_summary for plan ${ctx.plan.id} already exists, skipping`);
      return { sessionLogTarget, cardTarget };
    }
  }

  // Session summary → karta části
  await sb.from("did_pantry_packages").insert({
    user_id: userId,
    package_type: "session_summary",
    source_id: ctx.plan.id,
    source_table: "did_daily_session_plans",
    content_md: `<!-- session_evaluate plan_id=${ctx.plan.id} ended_reason=${endedReason} -->\n\n${markdown}`,
    drive_target_path: cardTarget,
    metadata: {
      part_name: partName,
      session_date: ctx.plan.plan_date,
      therapist: therapistLabel,
      completion_status: evaluation.completion_status,
      completed_blocks: completedBlocks,
      total_blocks: totalBlocks,
      ended_reason: endedReason,
    },
    status: "pending_drive",
  });

  // Globální session log
  const logEntry = `### ${ctx.plan.plan_date} · ${partName} · ${therapistLabel}\n` +
    `_${evaluation.completion_status === "completed" ? "dokončené" : evaluation.completion_status === "partial" ? "neukončené" : "sotva začaté"}_\n\n` +
    `**Co prožívalo dítě:** ${evaluation.child_perspective.slice(0, 600)}\n\n` +
    `**Doporučený další krok:** ${evaluation.recommended_next_step}\n`;

  await sb.from("did_pantry_packages").insert({
    user_id: userId,
    package_type: "session_log",
    source_id: ctx.plan.id,
    source_table: "did_daily_session_plans",
    content_md: logEntry,
    drive_target_path: sessionLogTarget,
    metadata: { part_name: partName, session_date: ctx.plan.plan_date },
    status: "pending_drive",
  });

  return { sessionLogTarget, cardTarget, reviewId, reviewStatus };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const apiKey = Deno.env.get("LOVABLE_API_KEY")!;
    if (!apiKey) throw new Error("LOVABLE_API_KEY není nastavený.");

    const sb = createClient(supabaseUrl, serviceKey);

    const body = await req.json().catch(() => ({}));
    const planId = body?.planId as string | undefined;
    let completedBlocks = typeof body?.completedBlocks === "number" ? body.completedBlocks : undefined;
    let totalBlocks = typeof body?.totalBlocks === "number" ? body.totalBlocks : undefined;
    const endedReason: EndedReason = body?.endedReason ?? "completed";
    let turnsByBlock = (body?.turnsByBlock ?? {}) as Record<string, any[]>;
    let observationsByBlock = (body?.observationsByBlock ?? {}) as Record<string, string>;
    const force = body?.force === true;

    if (body?.projection_only === true) {
      const reviewId = body?.reviewId as string | undefined;
      if (!reviewId) {
        return new Response(
          JSON.stringify({ ok: false, error: "reviewId je povinné pro projection_only" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      const { data: review, error: reviewErr } = await sb
        .from("did_session_reviews")
        .select("id,user_id,plan_id,part_name,session_date,status,team_implications,therapeutic_implications,next_session_recommendation,evidence_limitations")
        .eq("id", reviewId)
        .maybeSingle();
      if (reviewErr) throw reviewErr;
      if (!review) {
        return new Response(
          JSON.stringify({ ok: false, error: "Review nenalezeno" }),
          { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      const projection = await projectReviewToPametKarel(sb, review as SessionReviewRow);
      return new Response(
        JSON.stringify({ ok: true, projection_only: true, review_id: reviewId, projection }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (!planId) {
      return new Response(
        JSON.stringify({ ok: false, error: "planId je povinné" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const ctx = await loadContext(sb, planId);
    const liveProgress = await loadLiveProgress(sb, planId);
    if (liveProgress) {
      completedBlocks = completedBlocks ?? liveProgress.completed_blocks ?? undefined;
      totalBlocks = totalBlocks ?? liveProgress.total_blocks ?? undefined;
      if (!hasEvidence(turnsByBlock, observationsByBlock, completedBlocks)) {
        turnsByBlock = (liveProgress.turns_by_block ?? {}) as Record<string, any[]>;
        const items = Array.isArray(liveProgress.items) ? liveProgress.items : [];
        observationsByBlock = Object.fromEntries(
          items
            .map((it: any, idx: number): [string, string] => [String(idx), String(it?.observation ?? "")])
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
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const evidencePresent = hasEvidence(turnsByBlock, observationsByBlock, completedBlocks);
    const blockTranscript = formatBlockTurnsForPrompt(turnsByBlock, observationsByBlock);
    const threadTranscript = formatThreadMessagesForPrompt(ctx.threads, ctx.plan);

    const partInfo = ctx.partCard
      ? `Karta/registry záznam části nalezen: zadané jméno=${ctx.plan.selected_part}, kanonické jméno=${ctx.partCard.part_name}, ` +
        `registry_id=${ctx.partCard.id}, věk≈${ctx.partCard.age_estimate ?? "?"}, role=${ctx.partCard.role_in_system ?? "?"}, ` +
        `aktuální stav=${ctx.partCard.last_emotional_state ?? "?"}. Přímá Drive vazba není v DB uložena, netvrď proto, že karta neexistuje.`
      : ctx.partCardLookup?.status === "ambiguous"
        ? `(registry lookup části ${ctx.plan.selected_part} je nejednoznačný: ${ctx.partCardLookup.reason}; netvrď, že karta neexistuje)`
        : `(registry záznam části ${ctx.plan.selected_part} v DB nenalezen)`;

    const blockSummary = totalBlocks
      ? `Blocks completed: ${completedBlocks ?? "?"}/${totalBlocks}` +
        (endedReason === "auto_safety_net" ? " (vyhodnocování spustil noční safety-net, terapeutka sezení formálně neuzavřela)" : "")
      : "Počet bloků nebyl předán.";

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
══════════════════════════════════════════════

ÚKOL:
Vyhodnoť toto sezení. Drž se pravidel ze system promptu.
- Pokud sezení nebylo dokončené, completion_status='partial' nebo 'abandoned' a v incomplete_note popiš co se nestihlo.
- Pokud chybí průběhová data, nepiš, že sezení bylo sotva začaté/neuskutečněné; napiš jen, že chybí dostatečný záznam.
- Pokud proběhla alespoň polovina bodů, completion_status nesmí být 'abandoned'.
- HLAVNÍ VRSTVA = child_perspective (4-7 vět, konkrétně, pro Tundrupka / příslušnou část).
- Therapist_motivation drž stručné (1-2 věty).
- Vrať VÝHRADNĚ tool call emit_session_evaluation.`;

    const evaluation = sanitizeEvaluation(await callAi(prompt, apiKey), endedReason, completedBlocks, totalBlocks);
    const diagnosticValidity = buildDiagnosticValidityReport(ctx.plan.plan_markdown, turnsByBlock, observationsByBlock, liveProgress);
    const markdown = renderEvaluationMarkdown(evaluation, ctx.plan, endedReason, completedBlocks, totalBlocks, diagnosticValidity);

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

    return new Response(
      JSON.stringify({
        ok: true,
        plan_id: planId,
        part_name: ctx.plan.selected_part,
        completion_status: evaluation.completion_status,
        review_id: targets.reviewId,
        review_status: targets.reviewStatus,
        markdown,
        evaluation,
        drive_targets: targets,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e: any) {
    console.error("[karel-did-session-evaluate] fatal:", e);
    return new Response(
      JSON.stringify({ ok: false, error: e?.message ?? String(e) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
