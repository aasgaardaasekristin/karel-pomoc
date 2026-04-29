/**
 * karel-did-daily-briefing
 *
 * Generuje kanonický denní briefing Karla.
 * Briefing je redakční artefakt — vzniká jednou denně, ukládá se do
 * `did_daily_briefings`, dashboard ho jen čte.
 *
 * Generation methods (uloženo do `did_daily_briefings.generation_method`):
 *   - "auto"   → ranní cron (job `did-daily-briefing-morning`, viz pg_cron)
 *   - "manual" → tlačítko `Přegenerovat` v UI (DidDailyBriefingPanel)
 *
 * Anti-dup: pokud existuje fresh (is_stale=false) briefing pro dnešek
 * a request nemá `force: true`, vrátí se cached. Cron volá BEZ `force`,
 * takže neudusí ruční briefing, pokud už existuje. Manuální regenerace
 * posílá `force: true`.
 *
 * Workflow:
 * 1. Načti kontext: aktivní krize, signály z posledních 3 dnů, otevřené tasky, parts
 * 2. Spočítej skóre kandidátů na dnešní sezení (heuristika)
 * 3. Pošli AI strukturovaný kontext + tool-call schema
 * 4. Ulož výsledek do did_daily_briefings
 *
 * Tone: kultivovaná čeština, jungovská noblesa v úvodu/přechodech,
 * konkrétní pracovní formulace v rozhodovacích bodech.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { selectPantryA, summarizePantryAForPrompt, type PantryASnapshot } from "../_shared/pantryA.ts";
import { readUnprocessedPantryB, markPantryBProcessed } from "../_shared/pantryB.ts";
import { summarizeToolboxForPrompt } from "../_shared/therapeuticToolbox.ts";
import { runGlobalDidEventIngestion } from "../_shared/didEventIngestion.ts";
import { requireAuth } from "../_shared/auth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-karel-cron-secret",
};

const AI_URL = "https://ai.gateway.lovable.dev/v1/chat/completions";
const MODEL = "google/gemini-2.5-pro";
const STALE_CYCLE_MINUTES = 90;
const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

const pragueDayISO = (d: Date = new Date()): string =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Prague" }).format(d);

const daysAgoISO = (n: number): string => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return pragueDayISO(d);
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

async function startBriefingAttempt(sb: any, values: Record<string, unknown>): Promise<string | null> {
  try {
    const { data } = await sb.from("did_daily_briefing_attempts").insert(values).select("id").single();
    return data?.id ?? null;
  } catch (e) {
    console.warn("[briefing-audit] start failed:", (e as Error)?.message || e);
    return null;
  }
}

async function finishBriefingAttempt(sb: any, attemptId: string | null, values: Record<string, unknown>) {
  if (!attemptId) return;
  try {
    await sb.from("did_daily_briefing_attempts").update({ ...values, completed_at: new Date().toISOString() }).eq("id", attemptId);
  } catch (e) {
    console.warn("[briefing-audit] finish failed:", (e as Error)?.message || e);
  }
}

const normalizeTherapistLabel = (value: unknown): "Hanička" | "Káťa" | "společně" | undefined => {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return undefined;
  if (raw.includes("spol") || raw.includes("oba") || raw.includes("both")) return "společně";
  if (raw.includes("han") || raw.includes("hanka")) return "Hanička";
  if (raw.includes("kat") || raw.includes("káťa") || raw.includes("kata")) return "Káťa";
  return undefined;
};

const cleanBlockText = (value: unknown): string =>
  String(value ?? "")
    .replace(/\r/g, "")
    .replace(/^[-*]\s+/gm, "• ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

const extractMarkdownSection = (markdown: string, heading: string): string => {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = markdown.match(new RegExp(`###\\s+${escaped}\\s*\\n([\\s\\S]*?)(?=\\n###\\s+|$)`, "i"));
  return cleanBlockText(match?.[1] ?? "");
};

const extractMarkdownSectionByPrefix = (markdown: string, prefix: string): string => {
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = markdown.match(new RegExp(`###\\s+${escaped}[^\\n]*\\n([\\s\\S]*?)(?=\\n###\\s+|$)`, "i"));
  return cleanBlockText(match?.[1] ?? "");
};

const mergeUniqueParagraphs = (...chunks: Array<unknown>): string => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const chunk of chunks) {
    const text = cleanBlockText(chunk);
    if (!text) continue;
    for (const paragraph of text.split(/\n\n+/)) {
      const trimmed = paragraph.trim();
      if (!trimmed) continue;
      const key = trimmed.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(trimmed);
    }
  }
  return out.join("\n\n");
};

const jsonItemCount = (value: unknown): number => {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === "object") return Object.keys(value as Record<string, unknown>).length;
  return 0;
};

const buildMandatoryPlayroomProposal = (payload: any, context: any, candidates: Array<{ part_name: string; score: number; reasons: string[] }>) => {
  const selectedPart = String(payload?.proposed_session?.part_name || candidates?.[0]?.part_name || context?.crises?.[0]?.part_name || context?.recent_threads?.[0]?.part_name || "část vybraná ranním přehledem").trim();
  const whyToday = cleanBlockText(payload?.proposed_session?.why_today)
    || cleanBlockText(candidates?.[0]?.reasons?.join(", "))
    || cleanBlockText(context?.last_3_days)
    || "Ranní přehled musí každý den připravit samostatnou Hernu; aktuální signály jsou slabé, proto volím bezpečný nízkoprahový diagnosticko-terapeutický program.";

  return {
    part_name: selectedPart,
    status: "awaiting_therapist_review",
    why_this_part_today: whyToday,
    main_theme: `Bezpečný kontakt a zmapování toho, co ${selectedPart} dnes unese`,
    evidence_sources: ["ranní briefing", "poslední tři dny", "kandidáti dnešního sezení"],
    goals: [
      "navázat kontakt bez tlaku na výkon",
      "rozlišit aktuální bezpečí, ochotu a únavu části",
      "získat konkrétní materiál pro následné klinické review",
      "ukončit včas při zahlcení nebo stažení",
    ],
    playroom_plan: {
      therapeutic_program: [
        { block: "Bezpečný práh", minutes: 3, detail: "Karel nabídne odpověď slovem, symbolem nebo tichem; cílem je zjistit dostupnost části, ne vynutit výkon." },
        { block: "Vnitřní počasí", minutes: 6, detail: "Část vybere barvu, obraz nebo jedno slovo pro dnešní stav. Karel sleduje konkrétnost, vyhýbání a toleranci kontaktu." },
        { block: "Symbolická postava", minutes: 8, detail: "Krátká bezpečná imaginativní hra s jednou postavou nebo předmětem, bez otevírání traumatické paměti." },
        { block: "Jeden malý krok", minutes: 5, detail: "Karel hledá jeden zvládnutelný krok pro tělo, klid nebo kontakt; bez slibů a bez konfrontace." },
        { block: "Měkké uzavření", minutes: 3, detail: "Karel shrne slyšené, nabídne zakotvení a označí podklady pro review." },
      ],
      child_safe_version: "Dnes si spolu opatrně zkusíme, jaké je uvnitř počasí, kdo tam je poblíž a co by pomohlo, aby toho nebylo moc.",
      micro_steps: ["zvolit způsob odpovědi", "pojmenovat obraz nebo barvu", "nechat symbol něco říct", "vybrat jeden pomocný krok", "společně hru zavřít"],
      expected_child_reactions: ["krátké odpovědi", "nejistota", "odmítnutí tématu", "zájem o symbol", "únava"],
      recommended_karel_responses: ["zpomalit", "nabídnout volbu", "potvrdit právo neodpovědět", "držet symbolickou rovinu", "ukončit při stop signálu"],
      risks_and_stop_signals: ["náhlé stažení", "zmatek v čase nebo místě", "somatické zhoršení", "tlak na tajemství", "výrazné odpojení"],
      forbidden_directions: ["nevynucovat vzpomínky", "neinterpretovat kresbu jako diagnózu bez review", "neeskalovat trauma", "nepokračovat přes stop signál"],
      runtime_packet_seed: { source: "mandatory_backend_fallback" },
    },
    questions_for_hanka: ["Je dnes pro tuto část bezpečnější krátká Karel-led Herna, nebo má být Hanička fyzicky poblíž?"],
    questions_for_kata: ["Vidíš dnes riziko, kvůli kterému má Herna zůstat pouze stabilizační a ne hlubinně explorativní?"],
  };
};

function buildMandatorySessionProposal(payload: any, context: any, candidates: Array<{ part_name: string; score: number; reasons: string[] }>) {
  const entries = operationalContextEntries(context);
  const sessionRelevant = entries.filter((e: any) => e?.detail?.include_in_next_session_plan === true || /sezen|session|timmy|timmi|velryb|kepor|skute|reáln|odkaz/i.test(`${e?.summary ?? ""} ${JSON.stringify(e?.detail ?? {})}`));
  const selectedPart = String(context?.yesterday_session_reviews?.[0]?.part_name || context?.yesterday_plans?.[0]?.selected_part || sessionRelevant?.[0]?.related_part_name || candidates?.[0]?.part_name || payload?.proposed_playroom?.part_name || "část vybraná ranním přehledem").trim();
  const refs = sessionRelevant.map((e: any) => e.source_ref || e.id).filter(Boolean).slice(0, 10);
  const excerpts = sessionRelevant.map((e: any) => cleanBlockText(e.summary || e.detail?.operational_implication || "")).filter(Boolean).slice(0, 6);
  if (!refs.length && !context?.yesterday_session_reviews?.length && !context?.yesterday_plans?.length) return null;
  return {
    part_name: selectedPart,
    status: "awaiting_therapist_review",
    why_today: "Navázat na včerejší aktivitu a real-world korekci bez předstírání klinického závěru: nejdřív ověřit tělo, emoci, dostupnost a bezpečí.",
    led_by: "Hanička",
    duration_min: 20,
    first_draft: "Krátké terapeutkou vedené Sezení: 1) ověřit aktuální stav a únavu, 2) přiznat Timmyho/keporkaka jako skutečný externí stresor, 3) ptát se jen na vlastní reakci kluků, neinterpretovat samotnou zprávu jako projekci, 4) ukončit stabilizačně.",
    kata_involvement: "Káťa hlídá evidence discipline: real-world fact / therapist correction není child evidence bez samostatné reakce části.",
    evidence_sources: ["RECENT OPERATIONAL CONTEXT — Pantry B", "YESTERDAY ACTIVITY — plans/progress/reviews"],
    backend_context_inputs: {
      used_yesterday_activity: true,
      used_recent_operational_context: true,
      reality_correction_used: refs.length > 0,
      operational_context_source_refs: refs,
      operational_context_excerpts: excerpts,
      evidence_discipline: "real-world fact / therapist correction is operational context, not child evidence unless the child response is separately recorded",
    },
  };
}

const getResolvedPartCardEvidence = (review: any): any | null => {
  const items = Array.isArray(review?.evidence_items) ? review.evidence_items : [];
  return items.find((item: any) =>
    item?.kind === "part_card"
    && item?.available === true
    && String(item?.lookup_status ?? "").toLowerCase() === "resolved"
  ) ?? null;
};

const partCardMissingPattern = /(part\s*card\s*(chyb|missing)|chyb[íi]\s+(?:part\s*card|karta|kartu|karty)|karta\s+[^.!?\n]{0,80}\s+chyb[íi]|absence\s+karty|založit\s+kartu|kartu\s+pro\s+část\s+arthur|je\s+nutn[ée]\s+založit\s+kartu)/i;

const stripContradictoryPartCardText = (value: unknown, partCard: any | null): string => {
  const text = cleanBlockText(value);
  if (!text || !partCard) return text;
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence && !partCardMissingPattern.test(sentence))
    .join(" ")
    .trim();
};

const buildBriefingEvidenceLimitations = (review: any): string => {
  const partCard = getResolvedPartCardEvidence(review);
  const base = stripContradictoryPartCardText(review?.evidence_limitations, partCard);
  const validityLimits = "chybí turn-by-turn data, transcript, observations/audio a plný průběh sezení";

  if (partCard) {
    const canonical = String(partCard?.canonical_part_name ?? partCard?.part_name ?? review?.part_name ?? "část").trim();
    return mergeUniqueParagraphs(
      base,
      `Karta / registry záznam části byl dohledán jako ${canonical}. Evidence je nadále omezená nikoli kvůli chybějící kartě, ale kvůli tomu, že ${validityLimits}.`,
      "Evidence-limited hardening: závěry jsou pracovní a Karel nepředstírá plnou analýzu.",
    );
  }

  return mergeUniqueParagraphs(
    base || "Validita je omezená; závěry jsou pracovní hypotézy.",
    `Evidence-limited hardening: ${validityLimits}; závěry jsou pracovní a Karel nepředstírá plnou analýzu.`,
  );
};

function reviewOutcome(review: any): string {
  return String(review?.analysis_json?.outcome ?? review?.analysis_json?.post_session_result?.status ?? "").trim();
}

function reviewEvidenceBasis(review: any): "planned_only" | "started_partial" | "completed" | "unknown" {
  const outcome = reviewOutcome(review);
  if (outcome === "planned_not_started") return "planned_only";
  const items = Array.isArray(review?.evidence_items) ? review.evidence_items : [];
  const hasStartedEvidence = items.some((e: any) =>
    (e?.kind === "live_progress" && e?.available && Number(e?.completed_blocks ?? 0) > 0) ||
    (e?.kind === "turn_by_turn" && e?.available) ||
    (e?.kind === "observations" && e?.available) ||
    (e?.kind === "thread_transcript" && e?.available && Number(e?.thread_count ?? 0) > 0) ||
    (e?.kind === "session_started_evidence" && e?.available)
  );
  if (review?.status === "analyzed" && hasStartedEvidence) return "completed";
  if (hasStartedEvidence) return "started_partial";
  return "unknown";
}

function buildYesterdaySessionReview(context: any) {
  const reviews = Array.isArray(context?.yesterday_session_reviews) ? context.yesterday_session_reviews : [];
  const sessionReviews = reviews.filter((r: any) => String(r?.mode ?? "session") !== "playroom");
  const review = sessionReviews[0] ?? null;
  if (review) {
    const analysis = review.analysis_json && typeof review.analysis_json === "object" ? review.analysis_json : {};
    const evidenceBasis = reviewEvidenceBasis(review);
    const technicalTest = isTechnicalTestSessionReview(review) || evidenceBasis === "planned_only";
    return {
      exists: true,
      held: !technicalTest && !["pending_review", "analysis_running"].includes(String(review.status)),
      status: technicalTest ? "technical_test" : review.status,
      review_status: review.status,
      fallback_reason: technicalTest ? "planned_session_not_clinically_held" : undefined,
      part_name: review.part_name,
      plan_id: review.plan_id,
      thread_id: analysis.thread_id ?? analysis.confirmed_facts?.thread_id ?? review.evidence_items?.find?.((e: any) => e?.kind === "thread_transcript")?.source_id ?? null,
      review_id: review.id,
      lead_person: review.lead_person ?? review.lead ?? null,
      lead: normalizeTherapistLabel(review.lead_person ?? review.lead) ?? undefined,
      assistant_persons: review.assistant_persons ?? [],
      completion: technicalTest ? "abandoned" : evidenceBasis === "completed" ? "completed" : review.status === "evidence_limited" || review.status === "partially_analyzed" ? "partial" : "abandoned",
      practical_report_text: technicalTest
        ? `Plánované Sezení s ${review.part_name || "částí"} se klinicky neuskutečnilo. Záznam odpovídá technickému testu nebo plánované aktivitě bez klinického průběhu, proto z něj nevyvozujeme nové klinické poznatky. Původní potřeba Sezení — zejména práce s tělesnými potížemi a neverbálním zpracováním — zůstává otevřená.`
        : cleanBlockText(analysis.practical_report_text ?? review.clinical_summary ?? ""),
      detailed_analysis_text: cleanBlockText(analysis.detailed_analysis_text ?? ""),
      team_closing_text: cleanBlockText(analysis.team_closing_text ?? review.team_closing ?? ""),
      karel_summary: technicalTest
        ? `Plánované Sezení s ${review.part_name || "částí"} se klinicky neuskutečnilo. Z tohoto záznamu nevyvozujeme nové klinické poznatky; původní potřeba Sezení zůstává otevřená.`
        : cleanBlockText(analysis.practical_report_text ?? review.clinical_summary ?? review.evidence_limitations ?? ""),
      key_finding_about_part: cleanBlockText(review.implications_for_part ?? review.therapeutic_implications ?? analysis.implications_for_part ?? ""),
      implications_for_plan: cleanBlockText(review.recommendations_for_next_session ?? review.next_session_recommendation ?? analysis.recommendations_for_next_session ?? ""),
      team_acknowledgement: cleanBlockText(analysis.team_closing_text ?? review.team_closing ?? review.team_implications ?? ""),
      implications_for_part: cleanBlockText(review.implications_for_part ?? analysis.implications_for_part ?? ""),
      implications_for_system: cleanBlockText(review.implications_for_whole_system ?? analysis.implications_for_system ?? ""),
      recommendations_for_therapists: cleanBlockText(review.recommendations_for_therapists ?? analysis.recommendations_for_therapists ?? ""),
      recommendations_for_next_session: technicalTest
        ? "Carry-over z neuskutečněného Sezení: nejprve ověřit aktuální tělesný a emoční stav a teprve poté rozhodnout, zda dnes provést terapeutkou vedené Sezení, nízkoprahovou Hernu, nebo jen stabilizační kontakt."
        : cleanBlockText(review.recommendations_for_next_session ?? review.next_session_recommendation ?? analysis.recommendations_for_next_session ?? ""),
      recommendations_for_next_playroom: cleanBlockText(review.recommendations_for_next_playroom ?? analysis.recommendations_for_next_playroom ?? ""),
      detail_analysis_drive_url: review.detail_analysis_drive_url ?? null,
      practical_report_drive_url: review.practical_report_drive_url ?? null,
      drive_sync_status: review.drive_sync_status ?? "not_queued",
      source_of_truth_status: review.source_of_truth_status ?? "pending_drive_sync",
      evidence_basis: evidenceBasis,
      evidence_limitations: buildBriefingEvidenceLimitations(review),
    };
  }
  const activity = Array.isArray(context?.yesterday_plans) ? context.yesterday_plans.find((p: any) => String(p?.mode ?? "session") !== "playroom") : null;
  if (!activity) return { exists: false, status: "none" };
  return {
    exists: true,
    held: false,
    status: "pending_review",
    fallback_reason: "session_activity_exists_without_review",
    part_name: activity.selected_part ?? activity.part_name ?? null,
    plan_id: activity.id ?? null,
    thread_id: null,
    evidence_count: 1,
    practical_report_text: "Včerejší Sezení proběhlo nebo bylo zahájeno, ale čeká na vyhodnocení. Karlův přehled ho uvádí jako pending_review, ne jako hotový klinický závěr.",
    detailed_analysis_text: "",
    team_closing_text: "",
    drive_sync_status: "not_queued",
    source_of_truth_status: "pending_drive_sync",
  };
}

function enrichYesterdaySessionReview(payload: any, context: any) {
  payload.yesterday_session_review = buildYesterdaySessionReview(context);
  return payload;
}

function injectSessionReviewIntoProposals(payload: any) {
  const y = payload?.yesterday_session_review;
  if (!y?.exists || !y?.review_id) return payload;
  const report = cleanBlockText(y.practical_report_text);
  const nextSession = cleanBlockText(y.recommendations_for_next_session || y.recommendations_for_therapists || y.implications_for_plan);
  if (payload?.proposed_session && typeof payload.proposed_session === "object") {
    const ps = payload.proposed_session;
    if (y.held === false || y.status === "technical_test") {
      ps.carry_over_reason = "unheld_yesterday_session";
      ps.why_today = `Carry-over z neuskutečněného Sezení. Tento návrh nenavazuje na nové klinické poznatky ze včerejšího Sezení, protože to klinicky neproběhlo; navazuje na původní potřebu řešit tělesné potíže a neverbální zpracování tělesného stavu. ${cleanBlockText(ps.why_today)}`.trim();
      ps.first_draft = `Začít krátkým ověřením tělesného a emočního stavu, bez tlaku na vysvětlování. Pokud je část dostupná a stabilní, pokračovat krátkým terapeutkou vedeným Sezením; pokud je unavená nebo zahlcená, zůstat jen u stabilizačního kontaktu. ${cleanBlockText(ps.first_draft)}`.trim();
    }
    ps.evidence_sources = Array.from(new Set([...(Array.isArray(ps.evidence_sources) ? ps.evidence_sources : []), "VČEREJŠÍ SEZENÍ — PRAKTICKÝ REPORT", "VČEREJŠÍ SEZENÍ — DOPORUČENÍ PRO DALŠÍ PLÁNOVÁNÍ"]));
    ps.backend_context_inputs = {
      ...(ps.backend_context_inputs ?? {}),
      used_yesterday_session_review: true,
      yesterday_session_review_id: y.review_id,
      practical_report_excerpt: report.slice(0, 1200),
      next_session_recommendation_excerpt: nextSession.slice(0, 1200),
    };
    payload.proposed_session = ps;
  }
  const nextPlayroom = cleanBlockText(y.recommendations_for_next_playroom);
  if (nextPlayroom && payload?.proposed_playroom && typeof payload.proposed_playroom === "object") {
    const pp = payload.proposed_playroom;
    pp.evidence_sources = Array.from(new Set([...(Array.isArray(pp.evidence_sources) ? pp.evidence_sources : []), "VČEREJŠÍ SEZENÍ — PRAKTICKÝ REPORT"]));
    pp.backend_context_inputs = { ...(pp.backend_context_inputs ?? {}), used_yesterday_session_review: true, yesterday_session_review_id: y.review_id };
    payload.proposed_playroom = pp;
  }
  return payload;
}

function buildYesterdayPlayroomReview(context: any) {
  const reviews = Array.isArray(context?.yesterday_playroom_reviews) ? context.yesterday_playroom_reviews : [];
  const rankPlayroomReview = (r: any) => {
    const basis = reviewEvidenceBasis(r);
    const status = String(r?.status ?? "").toLowerCase();
    const source = String(r?.source_data_summary ?? "");
    const clinicalTurns = Number(source.match(/clinical_turns=(\d+)/)?.[1] ?? 0);
    if (status === "analyzed" && basis === "completed") return 0;
    if (status === "analyzed") return 1;
    if (basis === "started_partial") return 2;
    if (status === "evidence_limited" && clinicalTurns > 1) return 3;
    if (status === "evidence_limited") return 4;
    if (status === "pending_review" || status === "analysis_running") return 5;
    return 6;
  };
  const review = [...reviews].sort((a: any, b: any) => {
    const rankDiff = rankPlayroomReview(a) - rankPlayroomReview(b);
    if (rankDiff !== 0) return rankDiff;
    return new Date(b?.created_at ?? 0).getTime() - new Date(a?.created_at ?? 0).getTime();
  })[0] ?? null;
  if (review) {
    const analysis = review.analysis_json && typeof review.analysis_json === "object" ? review.analysis_json : {};
    return {
      exists: true,
      status: review.status,
      part_name: review.part_name,
      plan_id: review.plan_id,
      thread_id: analysis.thread_id ?? analysis.program_evidence?.thread_id ?? review.evidence_items?.find?.((e: any) => e?.kind === "bound_thread")?.source_id ?? null,
      review_id: review.id,
      practical_report_text: analysis.practical_report_text ?? review.clinical_summary ?? "",
      detailed_analysis_text: analysis.detailed_analysis_text ?? "",
      implications_for_part: review.implications_for_part ?? review.therapeutic_implications ?? analysis.implications_for_part ?? "",
      implications_for_system: review.implications_for_whole_system ?? analysis.implications_for_system ?? "",
      recommendations_for_therapists: review.recommendations_for_therapists ?? review.team_implications ?? "",
      recommendations_for_next_playroom: review.recommendations_for_next_playroom ?? "",
      recommendations_for_next_session: review.recommendations_for_next_session ?? review.next_session_recommendation ?? "",
      detail_analysis_drive_url: review.detail_analysis_drive_url ?? null,
      practical_report_drive_url: review.practical_report_drive_url ?? null,
      drive_sync_status: review.drive_sync_status ?? "not_queued",
    };
  }
  const thread = context?.yesterday_playroom_thread;
  if (!thread) return { exists: false, status: "none" };
  const messages = Array.isArray(thread.messages) ? thread.messages : [];
  return {
    exists: true,
    status: "pending_review",
    fallback_reason: "thread_exists_without_review",
    part_name: thread.part_name ?? null,
    plan_id: thread.workspace_id ?? null,
    thread_id: thread.id,
    message_count: messages.length,
    practical_report_text: "Herna proběhla, ale čeká na review. Karlův přehled ji proto uvádí jako nedokončený vstup, ne jako klinicky uzavřený závěr.",
    detailed_analysis_text: "",
    implications_for_part: "Zatím nelze poctivě uzavřít význam pro část bez playroom review.",
    implications_for_system: "Pro kluky jako celek je teď závazné hlavně to, že Herna nesmí zmizet z návazného plánování.",
    recommendations_for_therapists: "Zkontrolovat, zda má Herna review; pokud ne, spustit vyhodnocení nebo ji označit evidence_limited.",
    recommendations_for_next_playroom: "Nenavazovat hlubší Hernou, dokud není jasné, co z této Herny vyplývá.",
    recommendations_for_next_session: "V Sezení se neopírat o domnělé závěry z Herny; použít jen fakt, že review čeká.",
    drive_sync_status: "not_queued",
  };
}

function injectPlayroomReviewIntoProposal(payload: any) {
  const y = payload?.yesterday_playroom_review;
  if (!y?.exists || !payload?.proposed_playroom || typeof payload.proposed_playroom !== "object") return payload;
  const pp = payload.proposed_playroom;
  const report = cleanBlockText(y.practical_report_text);
  const next = cleanBlockText(y.recommendations_for_next_playroom || y.recommendations_for_therapists || y.recommendations_for_next_session);
  pp.evidence_sources = Array.from(new Set([...(Array.isArray(pp.evidence_sources) ? pp.evidence_sources : []), "VČEREJŠÍ HERNA — PRAKTICKÝ REPORT", "VČEREJŠÍ HERNA — DOPORUČENÍ PRO DALŠÍ PLÁNOVÁNÍ"]));
  pp.why_this_part_today = sanitizeKarelClinicalText(`Nízkoprahová stabilizační návaznost na včerejší Hernu. Symboly z včerejška používat primárně s ${y.part_name || pp.part_name || "touto částí"} a jen tehdy, pokud je část sama přinese nebo na ně klidně reaguje; u ostatních částí je nepřenášet automaticky. ${cleanBlockText(pp.why_this_part_today)}`);
  pp.main_theme = `Jemný check-in bezpečného místa a dnešního vnitřního počasí, ne automatické pokračování hluboké symbolické práce`;
  pp.goals = Array.from(new Set([
    "ověřit dnešní tělesnou a emoční dostupnost bez tlaku",
    "připomenout včerejší zdroje jen pokud jsou dnes bezpečné",
    "držet krátký rámec a měkké zakončení",
    ...(Array.isArray(pp.goals) ? pp.goals : []),
  ])).slice(0, 4);
  pp.backend_context_inputs = {
    ...(pp.backend_context_inputs ?? {}),
    yesterday_playroom_review_id: y.review_id ?? null,
    used_yesterday_playroom_review: true,
    practical_report_excerpt: sanitizeKarelClinicalText(report).slice(0, 1200),
    next_playroom_recommendation_excerpt: sanitizeKarelClinicalText(next).slice(0, 1200),
  };
  const seed = pp.playroom_plan?.runtime_packet_seed && typeof pp.playroom_plan.runtime_packet_seed === "object" ? pp.playroom_plan.runtime_packet_seed : {};
  pp.playroom_plan = {
    ...(pp.playroom_plan ?? {}),
    child_safe_version: "Chceš dnes jen zkontrolovat, jestli je to bezpečné místo pořád někde poblíž, nebo chceš raději začít dnešním vnitřním počasím? Nemusíme pokračovat v ničem hlubokém.",
    therapeutic_program: [
      { block: "Jemný práh", minutes: 3, detail: "Karel nezačíná otázkou na ochranné bytosti. Nabídne volbu: bezpečné místo poblíž, dnešní vnitřní počasí, nebo jen ticho a jedno slovo." },
      { block: "Tělo a den", minutes: 5, detail: "Krátce ověřit, jestli je v těle něco nepříjemného, únavného nebo bezpečného. Bez rozebírání, jen mapa aktuální dostupnosti." },
      { block: "Zdroj jen se souhlasem", minutes: 7, detail: "Symboly světla, domova nebo ochrany použít pouze tehdy, pokud je část sama přinese nebo na ně klidně reaguje. Nevkládat je jako povinnost." },
      { block: "Malý přenos do přítomnosti", minutes: 5, detail: "Pokud se objeví bezpečný symbol, pomoci ho spojit s přítomným tělem, dnešním dnem a bezpečnými dospělými, ne s odchodem mimo realitu." },
      { block: "Měkké zavření", minutes: 4, detail: "Oznámit blížící se konec, nabídnout poslední stabilizační krok, ujistit, že bezpečné místo nezmizí, a neotevírat nové těžké téma." },
    ],
    forbidden_directions: Array.from(new Set([
      "nezačínat přímým dotazem na ochranné bytosti",
      "nepřenášet Tundrupkovy symboly automaticky na ostatní části",
      "neposilovat představu, že bezpečí existuje jen mimo současný život",
      ...(Array.isArray(pp.playroom_plan?.forbidden_directions) ? pp.playroom_plan.forbidden_directions : []),
    ])).slice(0, 8),
    risks_and_stop_signals: Array.from(new Set([
      "duchovní symbolika se stáčí k odpojení od reality nebo k touze nebýt",
      "část se cítí tlačená pokračovat v symbolu, který dnes sama nepřinesla",
      ...(Array.isArray(pp.playroom_plan?.risks_and_stop_signals) ? pp.playroom_plan.risks_and_stop_signals : []),
    ])).slice(0, 8),
    runtime_packet_seed: {
      ...seed,
      yesterday_playroom_review: {
        review_id: y.review_id ?? null,
        status: y.status,
        practical_report_text: sanitizeKarelClinicalText(report).slice(0, 1600),
        recommendations_for_next_playroom: sanitizeKarelClinicalText(next).slice(0, 1600),
      },
    },
  };
  payload.proposed_playroom = pp;
  return payload;
}

function operationalContextEntries(context: any): any[] {
  const entries = Array.isArray(context?.pantry_b_entries) ? context.pantry_b_entries : [];
  return entries.filter((e: any) => {
    const detail = e?.detail && typeof e.detail === "object" ? e.detail : {};
    const text = `${e?.summary ?? ""} ${JSON.stringify(detail)}`.toLowerCase();
    return ["live_session_reality_override", "live_session_progress", "hana_personal_ingestion", "therapist_task_note", "briefing_ask_resolution"].includes(String(e?.source_kind ?? ""))
      && (detail?.action_required === true
        || detail?.include_in_next_session_plan === true
        || detail?.include_in_next_playroom_plan === true
        || /timmy|timmi|velryb|kepor|skute|reáln|odkaz|aktualne|mělčin|záchran/.test(text));
  });
}

function injectOperationalContextIntoProposals(payload: any, context: any) {
  const entries = operationalContextEntries(context);
  if (!entries.length) return payload;
  const refs = entries.map((e: any) => e.source_ref || e.id).filter(Boolean).slice(0, 12);
  const excerpts = entries.map((e: any) => cleanBlockText(e.summary || e.detail?.operational_implication || "")).filter(Boolean).slice(0, 8);
  const hasReality = entries.some((e: any) => ["live_session_reality_override", "hana_personal_ingestion", "therapist_task_note"].includes(String(e?.source_kind ?? "")) && /timmy|timmi|velryb|kepor|skute|reáln|odkaz|aktualne|mělčin|záchran/i.test(`${e?.summary ?? ""} ${JSON.stringify(e?.detail ?? {})}`));
  const patchTarget = (target: any) => {
    if (!target || typeof target !== "object") return;
    target.backend_context_inputs = {
      ...(target.backend_context_inputs ?? {}),
      used_yesterday_activity: true,
      used_recent_operational_context: true,
      operational_context_source_refs: refs,
      operational_context_excerpts: excerpts,
      reality_correction_used: hasReality,
      evidence_discipline: "real-world fact / therapist correction is operational context, not child evidence unless the child response is separately recorded",
    };
    target.evidence_sources = Array.from(new Set([...(Array.isArray(target.evidence_sources) ? target.evidence_sources : []), "RECENT OPERATIONAL CONTEXT — Pantry B", "REALITY CORRECTION — not child evidence"]));
  };
  patchTarget(payload.proposed_session);
  patchTarget(payload.proposed_playroom);
  payload.operational_context_used = entries.map((e: any) => ({ id: e.id, source_kind: e.source_kind, source_ref: e.source_ref, summary: e.summary, evidence_level: e.detail?.evidence_level, what_not_to_conclude: e.detail?.what_not_to_conclude })).slice(0, 12);
  return payload;
}

function injectBriefingAskResolutionsIntoProposals(payload: any, context: any) {
  const entries = Array.isArray(context?.pantry_b_entries) ? context.pantry_b_entries : [];
  const resolutions = entries.filter((e: any) => e?.source_kind === "briefing_ask_resolution");
  if (resolutions.length === 0) return payload;

  const latestPlayroom = resolutions.find((e: any) => e?.detail?.target_type === "proposed_playroom" || e?.detail?.decision === "apply_to_playroom_program");
  const latestSession = resolutions.find((e: any) => e?.detail?.target_type === "proposed_session" || e?.detail?.decision === "apply_to_session_program");
  const inject = (target: any, entry: any) => {
    if (!target || !entry) return;
    target.backend_context_inputs = {
      ...(target.backend_context_inputs ?? {}),
      used_briefing_ask_resolution: true,
      briefing_ask_resolution_id: entry.detail?.resolution_id ?? entry.source_ref ?? entry.id,
      therapist_response_used: true,
      decision: entry.detail?.decision ?? null,
      evidence_level: entry.detail?.evidence_level ?? "therapist_observation_D2",
      requires_reapproval: Boolean(entry.detail?.requires_reapproval),
      source_of_truth: "DB/Pantry B",
      drive_role: "audit/archive",
    };
  };
  inject(payload.proposed_playroom, latestPlayroom);
  inject(payload.proposed_session, latestSession);
  payload.opening_monologue = {
    ...(payload.opening_monologue ?? {}),
    briefing_ask_resolution_used: true,
    briefing_ask_resolution_summary: String(resolutions[0]?.summary ?? "").slice(0, 700),
  };
  return payload;
}

function buildDeterministicBriefingPayload(context: any, candidates: SessionCandidate[]) {
  const playroomReview = buildYesterdayPlayroomReview(context);
  const sessionReview = buildYesterdaySessionReview(context);
  const selectedPart = String(playroomReview?.part_name || candidates?.[0]?.part_name || context?.crises?.[0]?.part_name || context?.recent_threads?.[0]?.part_name || "část vybraná ranním přehledem").trim();
  const payload: any = {
    greeting: "Dobré ráno, Haničko a Káťo. Dnes držím hlavně návaznost, klidné tempo a práci jen s tím, co máme doložené z včerejších stop.",
    last_3_days: playroomReview?.exists
      ? `Autoritativní vstup pro dnešek je včerejší Herna části ${playroomReview.part_name || selectedPart}; její praktický report je vložen přímo z DB review, nikoli z dlouhé AI syntézy.`
      : "Pro dnešek používám deterministický backendový přehled bez závěrů z Herny, protože včerejší playroom review není k dispozici.",
    lingering: "Důležité je dnes nepřetížit včerejší materiál a převést ho do jednoho malého, ověřitelného kroku.",
    technical_note: "Briefing byl sestaven z DB review a dostupných reportů bez dlouhé syntézy.",
    yesterday_session_review: null,
    yesterday_playroom_review: playroomReview,
    decisions: [],
    proposed_session: sessionReview?.exists && sessionReview?.review_id ? {
      part_name: sessionReview.part_name || candidates?.[0]?.part_name || selectedPart,
      why_today: sessionReview.recommendations_for_next_session || sessionReview.practical_report_text || "Navázat na doložený praktický report ze Sezení.",
      led_by: normalizeTherapistLabel(sessionReview.lead_person) ?? "Hanička",
      duration_min: 20,
      first_draft: sessionReview.recommendations_for_next_session || "Krátké terapeutkou vedené Sezení navázané na včerejší praktický report.",
      kata_involvement: "Káťa ověří rizika a hranice návaznosti.",
    } : null,
    proposed_playroom: buildMandatoryPlayroomProposal({ proposed_session: { part_name: selectedPart, why_today: playroomReview?.recommendations_for_next_playroom || playroomReview?.practical_report_text || "Herna musí navázat jen na doloženou evidenci." }, last_3_days: "" }, context, candidates),
    ask_hanka: ["Prosím ověř, zda dnešní Herna má navázat na doložený praktický report, nebo má zůstat jen stabilizační."],
    ask_kata: ["Prosím zkontroluj rizika a stop signály pro dnešní Hernu podle včerejšího review."],
    closing: "Beru to jako bezpečně omezený přehled: závěry z Herny jsou převzaté z DB review a návrh další Herny je na ně výslovně navázaný.",
  };
  injectPlayroomReviewIntoProposal(payload);
  injectSessionReviewIntoProposals(payload);
  return payload;
}

const firstMeaningful = (...values: unknown[]): string => {
  for (const value of values) {
    const text = cleanBlockText(value);
    if (text) return text;
  }
  return "";
};

const trimSentence = (value: unknown, max = 360): string => {
  const text = cleanBlockText(value).replace(/\s+/g, " ");
  if (!text) return "";
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  return `${cut.slice(0, Math.max(cut.lastIndexOf("."), cut.lastIndexOf(";"), cut.lastIndexOf(","), 180)).trim()}…`;
};

const partGenitive = (name: string): string => name.trim().toLowerCase() === "tundrupek" ? "Tundrupka" : name;
const partDative = (name: string): string => name.trim().toLowerCase() === "tundrupek" ? "Tundrupkovi" : name;

const sanitizeKarelClinicalText = (value: unknown): string =>
  cleanBlockText(value)
    .replace(/DID\s+syst[eé]m/gi, "kluci")
    .replace(/\bsyst[eé]mu\b/gi, "kluků")
    .replace(/\bsyst[eé]m\b/gi, "kluci")
    .replace(/\bklient(?:a|em|ovi|ů|i)?\b/gi, "kluci")
    .replace(/Tundrupek\s+je\s+aktivní,?\s*duchovn[eě]\s+zalo[žz]en[áa]\s+[čc][áa]st\.?/gi, "Tundrupek v této Herně spontánně použil duchovní a ochrannou symboliku jako jazyk bezpečí.")
    .replace(/duchovn[íi]\s+symbolika\s+je\s+pro\s+n[eě]j\s+kl[íi][čc]ov[ýy]m\s+jazykem\s+l[eé][čc]en[íi]/gi, "v této evidenci se duchovní symbolika jeví jako důležitý zdroj bezpečí; je potřeba ji dál ověřovat jemně a bez vnucování")
    .replace(/T[eé]ma\s+Boha,\s+n[áa]vratu\s+"dom[ůu]"[^.\n]*je\s+pro\s+Tundrupka\s+centr[áa]ln[íi][^.\n]*/gi, "Duchovní motivy se v této Herně objevily jako výrazný jazyk bezpečí, který je potřeba respektovat a zároveň dál opatrně ověřovat")
    .replace(/neukon[čc]ovat\s+Hernu,?\s*dokud\s+Tundrupek\s+nedos[áa]hne\s+pocitu\s+bezpe[čc][íi]/gi, "ukončovat Hernu pomalu, předvídatelně a s delším měkkým závěrem; neukončovat náhle, ale zároveň držet bezpečný časový rámec")
    .replace(/pou[žz][íi]vat\s+symboly\s+['„"]?sv[eě]tla[^.\n]*u\s+ostatn[íi]ch\s+kluk[ůu][^.\n]*/gi, "symboly používat primárně s Tundrupkem a jen tehdy, pokud je sám přinese nebo na ně klidně reaguje; u ostatních částí je nepřenášet automaticky")
    .replace(/Terapeutky\s+by\s+m[eě]ly[^.\n]*ostatn[íi]mi\s+kluky[^.\n]*/gi, "Terapeutky mají symboly používat primárně s Tundrupkem a nepřenášet je automaticky na ostatní části")
    .replace(/P[řr][íi][šs]t[íi]\s+Herna\s+s\s+Tundrupkem\s+by\s+mohla\s+za[čc][íi]t\s+p[řr][íi]m[ýy]m\s+dotazem\s+na\s+['"][^\n]*?\./gi, "Příští Herna s Tundrupkem má začít jemným check-inem bezpečného místa nebo dnešního vnitřního počasí, ne přímým dotazem na ochranné bytosti.")
    .replace(/Je\s+to\s+siln[ýy]\s+zdroj,\s+kter[ýy]\s+mohou\s+ostatn[íi]\s+kluci\s+vyu[žz][íi]vat\.?/gi, "Je to silný zdroj pro tuto část; u ostatních kluků ho nelze používat bez ověření.")
    .trim();

const isTechnicalStatusText = (value: unknown): boolean =>
  /(t[eě][žz]k[áa]\s+synt[eé]za|fallback|bezpe[čc]n[ýy]\s+re[žz]im|technick|funk[čc]nost|v[šs]e\s+b[eě][žz][íi]|db review|payload|backend)/i.test(cleanBlockText(value));

const isTechnicalTestSessionReview = (review: any): boolean => {
  const analysis = review?.analysis_json && typeof review.analysis_json === "object" ? review.analysis_json : {};
  const haystack = cleanBlockText([
    review?.status,
    review?.review_kind,
    review?.source_data_summary,
    review?.clinical_summary,
    review?.evidence_limitations,
    analysis?.outcome,
    analysis?.practical_report_text,
    analysis?.detailed_analysis_text,
    analysis?.post_session_result?.status,
  ].join("\n")).toLowerCase();
  return /(technick[ýy]\s+test|technical[_\s-]*test|klinicky\s+neprob[eě]hlo|sezen[íi]\s+se\s+neuskute[čc]nilo|planned_not_started|neprob[eě]hlo)/i.test(haystack);
};

function buildClinicalLast3Days(payload: any, context: any, candidates: SessionCandidate[]): string {
  const play = payload?.yesterday_playroom_review?.exists ? payload.yesterday_playroom_review : null;
  const sess = payload?.yesterday_session_review?.exists ? payload.yesterday_session_review : null;
  const activePart = String(play?.part_name || sess?.part_name || candidates?.[0]?.part_name || "část, která se ukáže v evidenci").trim();
  const recentThreads = Array.isArray(context?.recent_threads) ? context.recent_threads : [];
  const recentNames = Array.from(new Set(recentThreads.map((t: any) => String(t?.part_name ?? "").trim()).filter(Boolean))).slice(0, 4);
  const communicated = recentNames.length ? recentNames.join(", ") : activePart;
  const sessionNotHeld = sess?.exists && sess?.held === false;
  if (!play && !sess && recentNames.length === 0) return "Na toto nemám dost dat.";
  return [
    `Za posledních 24–72 hodin máme nejvýraznější doloženou aktivitu u ${partGenitive(activePart)}. V komunikaci se objevuje zejména ${communicated}; u kormidla to ale neznamená celodenní jistotu, jen nejsilnější dostupnou stopu.`,
    play ? `Včerejší Herna ukázala práci přes symboly bezpečí, domova, světla nebo ochrany; beru je jako aktuální jazyk této části, ne jako hotovou charakteristiku všech kluků.` : "Z Herny za včerejšek nemám dostatečný uzavřený materiál pro klinický závěr.",
    sessionNotHeld ? "Plánované terapeutické Sezení klinicky neproběhlo, případně odpovídá technickému testu; z něj proto nevyvozuji nové klinické poznatky." : sess?.held ? "Včerejší Sezení má doložený klinický vstup a může sloužit jako samostatný zdroj pro dnešní plán." : "O samostatném včerejším Sezení nemám dost dat.",
    "Bezpečný závěr pro dnešek: držet se doloženého materiálu, oddělit jisté poznatky od hypotéz a nejprve ověřit aktuální tělesnou i emoční dostupnost části.",
  ].join("\n\n");
}

function buildClinicalLingering(payload: any, candidates: SessionCandidate[]): string {
  const part = String(payload?.yesterday_playroom_review?.part_name || payload?.yesterday_session_review?.part_name || candidates?.[0]?.part_name || "Tundrupka").trim();
  return `Z dřívějška zůstává podstatné, že u ${partGenitive(part)} je potřeba pracovat pomalu, nepřetlačovat ho do vysvětlování a umožnit mu vyjadřování přes symbol, obraz nebo tělesný pocit. Bezpečí tady nevzniká přes rychlé odpovědi, ale přes opakovanou zkušenost, že dospělý zůstává dostupný, nespěchá a zároveň drží jasný rámec.`;
}

function buildDailyTherapeuticPriority(payload: any): string {
  const play = payload?.yesterday_playroom_review?.exists ? payload.yesterday_playroom_review : null;
  const sess = payload?.yesterday_session_review?.exists ? payload.yesterday_session_review : null;
  const part = String(play?.part_name || sess?.part_name || payload?.proposed_session?.part_name || payload?.proposed_playroom?.part_name || "části").trim();
  if (sess?.exists && sess?.held === false) {
    return `Protože plánované Sezení kvůli tělesným nebo neverbálním potížím klinicky neproběhlo, první krok dne má být krátké ověření aktuálního tělesného a emočního stavu ${partGenitive(part)}. Teprve podle toho má tým rozhodnout, zda dnes udělat terapeutkou vedené Sezení, nízkoprahovou stabilizační Hernu, nebo jen bezpečný kontakt bez otevírání nového těžkého materiálu.`;
  }
  return `Dnešní priorita je nejdřív ověřit dostupnost a míru zahlcení ${partGenitive(part)}. Pokud je část stabilní, může následovat malý návazný krok; pokud je unavená nebo stažená, přednost má stabilizace a žádné prohlubování tématu.`;
}

function buildOpeningMonologue(payload: any, context: any, candidates: SessionCandidate[]) {
  const play = payload?.yesterday_playroom_review?.exists ? payload.yesterday_playroom_review : null;
  const sess = payload?.yesterday_session_review?.exists ? payload.yesterday_session_review : null;
  const proposedSession = payload?.proposed_session && typeof payload.proposed_session === "object" ? payload.proposed_session : null;
  const proposedPlayroom = payload?.proposed_playroom && typeof payload.proposed_playroom === "object" ? payload.proposed_playroom : null;
  const activePart = String(play?.part_name || sess?.part_name || proposedSession?.part_name || proposedPlayroom?.part_name || candidates?.[0]?.part_name || "část, která se dnes nejvíc ukáže v datech").trim();
  const hasReview = Boolean(play || sess);
  const playReport = sanitizeKarelClinicalText(firstMeaningful(play?.practical_report_text, play?.implications_for_part, play?.recommendations_for_therapists));
  const sessionReport = sanitizeKarelClinicalText(firstMeaningful(sess?.practical_report_text, sess?.karel_summary, sess?.key_finding_about_part));
  const operationalEntries = operationalContextEntries(context);
  const operationalInfo = sanitizeKarelClinicalText(operationalEntries.map((e: any) => e.summary || e.detail?.operational_implication || "").filter(Boolean).slice(0, 4).join(" "));
  const hasRealityCorrection = operationalEntries.some((e: any) => /timmy|timmi|velryb|kepor|skute|reáln|odkaz|aktualne|mělčin|záchran/i.test(`${e?.summary ?? ""} ${JSON.stringify(e?.detail ?? {})}`));
  const newInfo = sanitizeKarelClinicalText(firstMeaningful(operationalInfo, play?.implications_for_part, sess?.key_finding_about_part, playReport, sessionReport));
  const planImplication = sanitizeKarelClinicalText(firstMeaningful(operationalInfo, sess?.implications_for_plan, play?.recommendations_for_next_session, play?.recommendations_for_next_playroom, proposedSession?.why_today, proposedPlayroom?.why_this_part_today));
  const teamWorkCandidate = sanitizeKarelClinicalText(firstMeaningful(sess?.team_closing_text, sess?.team_acknowledgement, play?.recommendations_for_therapists));
  const teamWork = isTechnicalStatusText(teamWorkCandidate) ? "" : teamWorkCandidate;
  const evidenceKnown: string[] = [];
  if (play) evidenceKnown.push(`${activePart} byl včera aktivní v Herně a pracoval se symboly bezpečí, světla, domova nebo ochrany.`);
  if (sess?.held) evidenceKnown.push(`${sess.part_name || activePart} má doložené včerejší Sezení${sess.status ? ` se stavem ${sess.status}` : ""}.`);
  if (sess?.exists && !sess?.held) evidenceKnown.push(`Plánované Sezení s ${sess.part_name || activePart} klinicky neproběhlo; z tohoto záznamu nevyvozujeme nové klinické poznatky.`);
  if (!evidenceKnown.length) evidenceKnown.push("V dostupném payloadu zatím nevidím plné review včerejší Herny ani Sezení.");

  const greeting = "Dobré ráno, Haničko a Káťo.";
  const frame = hasReview
    ? `Dnes bych chtěl, abychom u kluků drželi hlavně návaznost, klidné tempo a přesnost v tom, co víme a co si zatím jen pracovně myslíme. Včerejší den přinesl výrazný materiál od ${partGenitive(activePart)}, ale zároveň nás vede k opatrnosti: silný zdrojový prožitek z Herny nesmíme zaměnit za hotový závěr ani za proběhlé terapeutické Sezení.`
    : "Dnes bych chtěl, abychom drželi hlavně stabilitu, návaznost a opatrnost v závěrech. Tam, kde data chybí, nebudu domýšlet příběh; raději navrhnu bezpečný ověřovací krok.";
  const team_recognition = teamWork
    ? `Včera bylo pro tým důležité toto: ${trimSentence(teamWork, 420)}`
    : "Včera bylo důležité držet klidný rytmus a nepřetlačit materiál do rychlých odpovědí. Právě taková práce u kluků buduje bezpečí: ne přes výkon, ale přes opakovanou zkušenost, že dospělý zůstává a nespěchá.";
  const executive_summary = [
    `Nejdůležitější pro dnešek jsou tři věci. Zaprvé, ${activePart} je aktuálně nejvýraznější doložená stopa.`,
    hasRealityCorrection
      ? `Zadruhé, faktický rámec kolem Timmyho/keporkaka držíme jako real-world kontext a terapeutickou korekci reality; není to child evidence ani diagnostický důkaz bez samostatné reakce části.`
      : `Zadruhé, duchovní a ochranná symbolika se v této evidenci jeví jako zdroj bezpečí, ale je potřeba ji dál ověřovat jemně a bez vnucování.`,
    `Zatřetí, dnešní práce má nejdřív ověřit tělesný a emoční stav; pokračování do Herny nebo Sezení má přijít až podle dostupnosti části.`,
  ].join(" ");
  const parts_at_helm = play || sess
    ? `Z hlediska toho, kdo byl nejblíže u kormidla, máme nejjasnější evidenci u části ${activePart}. Neznamená to, že byla u kormidla celý den. Znamená to, že terapeuticky je dnes nejvýraznější částí, ke které se potřebujeme vztahovat. O ostatních částech zatím nemám dost nových dat na silné závěry.`
    : "Z hlediska toho, kdo byl u kormidla, nemám dost dat na jisté pojmenování. Budu tedy rozlišovat jen přítomné stopy a nebudu doplňovat části, které se samy v evidenci neukázaly.";
  const yesterday_new_information = newInfo
    ? `Nové nebo nejpodstatnější z včerejška je toto: ${trimSentence(newInfo, 520).replace(/m[ůu][žz]e\s+pos[íi]lit\s+jeho\s+pocit\s+kontroly\s+a\s+d[ůu]v[eě]ry/i, "může být pracovně významné pro jeho pocit kontroly a důvěry, pokud se to dnes potvrdí")}`
    : "Nové informace z včerejška jsou zatím omezené. To samo o sobě je klinicky důležité: dnešní krok má být ověřovací, ne interpretačně těžký.";
  const clinical_formulation = hasRealityCorrection
    ? `Moje pracovní formulace pro dnešek je opatrná: realita kolem Timmyho/keporkaka má být přiznaná jako skutečná událost a faktický stresor. Klinicky smíme pracovat až s tím, co kluci sami řeknou, cítí nebo ukážou; samotný odkaz ani zpráva nejsou projekce části.`
    : `Moje pracovní formulace pro dnešek je opatrná: ${activePart} včera použil vlastní symbolický jazyk bezpečí. Zatím je bezpečnější chápat ho jako aktuální zdroj této části, ne jako definitivní charakteristiku ani společný jazyk všech kluků. Praktický cíl je pomoci pocit ochrany přenést zpět do přítomného těla, dne a vztahu s bezpečnými dospělými.`;
  const recommendations_for_hana = `Haničko, u tebe dnes vidím jako hlavní úkol jemně ověřit tělesný stav a dostupnost ${partGenitive(activePart)}, bez tlaku na vysvětlování. Pokud je stabilní, může následovat krátké Sezení nebo nízkoprahová Herna; pokud je zahlcený, stačí kontakt a připomenutí zdrojů.`;
  const recommendations_for_katka = `Káťo, u tebe dnes doporučuji hlídat hranice návaznosti: nepřenášet včerejší symboly automaticky na ostatní části a nepoužít je dřív, než se ukáže, že jsou dnes pro ${partGenitive(activePart)} stále bezpečné.`;
  const what_not_to_do_today = "Dnes bych se vyhnul třem věcem: netlačit do vysvětlování, neotevírat nové trauma téma bez stabilizačního rámce a nepředávat části příliš velkou odpovědnost otázkou typu „co chceš dělat?“. Bezpečnější je nabídnout dvě nebo tři malé možnosti.";
  const priority_of_the_day = buildDailyTherapeuticPriority(payload);
  const evidence_limits = [
    `Jistě víme: ${evidenceKnown.join(" ")}`,
    `Pracovní hypotéza: tyto symboly mohou části ${activePart} pomáhat vytvořit vnitřní prostor ochrany a klidu, pokud s nimi dnes bude sama souhlasit.`,
    "Nevíme / čeká na ověření: zda jde o stabilní zdroj dostupný i dnes, zda je bezpečné tento jazyk rozšiřovat k ostatním částem, a jaký je aktuální tělesný stav.",
  ].join("\n");
  const team_closing_line = "Včerejší práce nám dává materiál. Dnes ho nemusíme zvětšovat; potřebujeme ho správně podržet a převést do jednoho bezpečného kroku.";
  const opening_monologue_text = [
    greeting,
    frame,
    team_recognition,
    executive_summary,
    parts_at_helm,
    yesterday_new_information,
    clinical_formulation,
    recommendations_for_hana,
    recommendations_for_katka,
    what_not_to_do_today,
    priority_of_the_day,
    evidence_limits,
    team_closing_line,
  ].join("\n\n");

  return {
    greeting,
    team_recognition,
    executive_summary,
    parts_at_helm,
    yesterday_new_information,
    clinical_formulation,
    recommendations_for_hana,
    recommendations_for_katka,
    what_not_to_do_today,
    priority_of_the_day,
    team_closing_line,
    evidence_limits,
    opening_monologue_text,
    technical_note: payload?.technical_note || "Briefing byl sestaven z DB review a dostupných reportů; technický stav není hlavním obsahem přehledu.",
  };
}

function applyOpeningMonologue(payload: any, context: any, candidates: SessionCandidate[]) {
  payload.last_3_days = buildClinicalLast3Days(payload, context, candidates);
  payload.lingering = buildClinicalLingering(payload, candidates);
  payload.daily_therapeutic_priority = buildDailyTherapeuticPriority(payload);
  if (payload?.yesterday_playroom_review && typeof payload.yesterday_playroom_review === "object") {
    for (const key of ["practical_report_text", "detailed_analysis_text", "implications_for_part", "implications_for_system", "recommendations_for_therapists", "recommendations_for_next_playroom", "recommendations_for_next_session"]) {
      payload.yesterday_playroom_review[key] = sanitizeKarelClinicalText(payload.yesterday_playroom_review[key]);
    }
    payload.yesterday_playroom_review.spiritual_symbolics_safety_frame = "Duchovní symbolika se v této Herně objevila jako zdroj bezpečí a úlevy. Je důležité ji respektovat, nepřerámovat ji příliš racionálně a nebrat ji části. Zároveň ji nesmíme nekriticky posilovat směrem k odpojení od reality nebo k představě, že bezpečí existuje jen mimo současný život. Praktický cíl je pomoci Tundrupkovi přenést pocit ochrany zpět do přítomného těla, dne a vztahu s bezpečnými dospělými.";
  }
  const opening = buildOpeningMonologue(payload, context, candidates);
  return {
    ...payload,
    greeting: opening.greeting,
    opening_monologue: {
      ...opening,
      briefing_ask_resolution_used: payload.opening_monologue?.briefing_ask_resolution_used ?? false,
      briefing_ask_resolution_summary: payload.opening_monologue?.briefing_ask_resolution_summary ?? undefined,
    },
    opening_monologue_text: opening.opening_monologue_text,
    technical_note: opening.technical_note,
  };
}

// ───────────────────────────────────────────────────────────
// HEURISTIKA: skórování kandidátů na dnešní sezení
// ───────────────────────────────────────────────────────────
interface SessionCandidate {
  part_id: string;
  part_name: string;
  score: number;
  reasons: string[];
}

async function scoreSessionCandidates(supabase: any): Promise<SessionCandidate[]> {
  const threeDaysAgo = daysAgoISO(3);
  const candidates = new Map<string, SessionCandidate>();

  const ensure = (part_id: string, part_name: string): SessionCandidate => {
    if (!candidates.has(part_id)) {
      candidates.set(part_id, { part_id, part_name, score: 0, reasons: [] });
    }
    return candidates.get(part_id)!;
  };

  // 1) Aktivní krize (×3)
  const { data: crises } = await supabase
    .from("crisis_events")
    .select("id, part_name, severity, phase, indicator_safety, indicator_emotional_regulation")
    .not("phase", "in", '("closed","CLOSED")');

  for (const c of crises || []) {
    // PROPOSAL-TO-DNES TRUTH PASS: kanonická tabulka částí je did_part_registry,
    // pole part_name (ne `name`). Předchozí volání `did_parts` tiše failovalo a
    // tím pádem scorer vždy vracel 0 kandidátů → briefing nikdy nenavrhl sezení.
    // Použít limit(1) místo maybeSingle() — registr může mít víc řádků (per user, case).
    const { data: parts } = await supabase
      .from("did_part_registry")
      .select("id, part_name")
      .ilike("part_name", c.part_name)
      .limit(1);
    const part = parts?.[0];
    if (!part) continue;
    const cand = ensure(part.id, part.part_name);
    cand.score += 3;
    cand.reasons.push(`aktivní krize (${c.severity || "?"}, fáze ${c.phase || "?"})`);
    if ((c.indicator_safety ?? 5) <= 2) {
      cand.score += 2;
      cand.reasons.push("nízký bezpečnostní indikátor");
    }
  }

  // 2) Opakované signály z posledních 3 dnů (×2)
  const { data: recentObs } = await supabase
    .from("did_observations")
    .select("part_id, severity, signal_type")
    .gte("created_at", `${threeDaysAgo}T00:00:00Z`)
    .order("created_at", { ascending: false })
    .limit(100);

  const obsCounts = new Map<string, number>();
  for (const o of recentObs || []) {
    if (!o.part_id) continue;
    obsCounts.set(o.part_id, (obsCounts.get(o.part_id) || 0) + 1);
  }
  for (const [part_id, count] of obsCounts) {
    if (count >= 2) {
      const { data: part } = await supabase.from("did_part_registry").select("id, part_name").eq("id", part_id).maybeSingle();
      if (!part) continue;
      const cand = ensure(part.id, part.part_name);
      cand.score += Math.min(count, 4);
      cand.reasons.push(`${count} signálů za 3 dny`);
    }
  }

  // 3) Pending questions bez odpovědi (×1)
  const { data: pending } = await supabase
    .from("did_pending_questions")
    .select("part_id")
    .in("status", ["pending", "sent"]);

  for (const p of pending || []) {
    if (!p.part_id) continue;
    const { data: part } = await supabase.from("did_part_registry").select("id, part_name").eq("id", p.part_id).maybeSingle();
    if (!part) continue;
    const cand = ensure(part.id, part.part_name);
    cand.score += 1;
    cand.reasons.push("nedořešená otázka");
  }

  return Array.from(candidates.values()).sort((a, b) => b.score - a.score);
}

// ───────────────────────────────────────────────────────────
// KONTEXT: posledních 3 dní + lingering
// ───────────────────────────────────────────────────────────
async function gatherContext(supabase: any, proofReviewId?: string | null, requestedUserId?: string | null) {
  const threeDaysAgo = daysAgoISO(3);
  const sevenDaysAgo = daysAgoISO(7);
  const yesterdayISO = daysAgoISO(1);

  const [crisesRes, recentObsRes, olderObsRes, pendingRes, threadsRes, plansRes, yesterdaySessionsRes, yesterdayPlansRes] = await Promise.all([
    supabase.from("crisis_events")
      .select("id, part_name, severity, phase, trigger_description, days_active, opened_at, clinical_summary")
      .not("phase", "in", '("closed","CLOSED")')
      .order("severity", { ascending: false }),
    supabase.from("did_observations")
      .select("id, subject_type, subject_id, source_type, source_ref, fact, evidence_level, confidence, created_at")
      .gte("created_at", `${threeDaysAgo}T00:00:00Z`)
      .order("created_at", { ascending: false })
      .limit(80),
    supabase.from("did_observations")
      .select("id, subject_type, subject_id, source_type, source_ref, fact, evidence_level, confidence, created_at")
      .gte("created_at", `${sevenDaysAgo}T00:00:00Z`)
      .lt("created_at", `${threeDaysAgo}T00:00:00Z`)
      .in("evidence_level", ["D1", "D2", "D3", "I1"])
      .limit(30),
    supabase.from("did_pending_questions")
      .select("id, subject_type, subject_id, question, directed_to, status")
      .in("status", ["open", "pending", "sent"])
      .limit(20),
    supabase.from("did_threads")
      .select("id, thread_label, part_name, last_activity_at")
      .gte("last_activity_at", `${threeDaysAgo}T00:00:00Z`)
      .order("last_activity_at", { ascending: false })
      .limit(15),
    supabase.from("did_daily_session_plans")
      .select("id, plan_date, selected_part, therapist, status, plan_markdown, crisis_event_id")
      .gte("plan_date", threeDaysAgo)
      .order("plan_date", { ascending: false }),
    // Včerejší sezení s vyhodnocením (pro yesterday_session_review)
    supabase.from("did_part_sessions")
      .select("id, part_name, therapist, session_date, session_type, ai_analysis, methods_used, methods_effectiveness, karel_notes, karel_therapist_feedback, handoff_note, tasks_assigned")
      .eq("session_date", yesterdayISO)
      .order("created_at", { ascending: false })
      .limit(5),
    // Včerejší plány (i in_progress, abychom poznali částečné sezení)
    supabase.from("did_daily_session_plans")
      .select("id, plan_date, selected_part, therapist, session_lead, status, completed_at, plan_markdown")
      .eq("plan_date", yesterdayISO)
      .order("created_at", { ascending: false })
      .limit(5),
  ]);

  const { data: parts } = await supabase
    .from("did_part_registry")
    .select("id, part_name");
  const partsById = new Map((parts || []).map((p: any) => [p.id, p.part_name]));

  // ═══ HOURGLASS: SPIŽÍRNA A READER (briefing) ═══
  // Reálný konzument composed morning view-modelu. Briefing už netahá vše
  // ručně — Pantry A přidává canonical priority, parts/therapists status,
  // oddělené Hana personal vs. therapeutic sloty, Káťa kontext, včerejší
  // sezení a otevřené follow-upy. Vlastní gather query výše zůstávají
  // jako safety net pro případ, že canonical layer dnes neexistuje.
  let pantryA: PantryASnapshot | null = null;
  let pantryASummary = "";
  try {
    const { data: anyCtxRow } = await supabase
      .from("did_daily_context")
      .select("user_id")
      .order("context_date", { ascending: false })
      .limit(1)
      .maybeSingle();
    const userId = anyCtxRow?.user_id;
    if (userId) {
      pantryA = await selectPantryA(supabase, userId);
      pantryASummary = summarizePantryAForPrompt(pantryA);
      console.log(`[briefing] Pantry A loaded: canonical_present=${pantryA.sources.canonical_present}, parts=${pantryA.parts_status.length}, followups=${pantryA.open_followups.length}, priorities=${pantryA.today_priorities.length}`);
    } else {
      console.warn("[briefing] Pantry A skipped: no user_id resolvable from did_daily_context");
    }
  } catch (pErr) {
    console.warn("[briefing] Pantry A load failed (non-fatal):", pErr);
  }

  // ═══ PANTRY B READER (briefing) ═══
  // Sběr nezpracovaných implikací z včerejška + dnešního rána.
  // Zdroje: signoff/synthesis (porady), did-meeting finalize, apply-analysis,
  // post-chat writebacky. Bez tohoto kroku Karel nevidí, co včera ve vláknech /
  // poradách / sezeních vyplynulo, a briefing zní jako kdyby den začínal odznova.
  let pantryBEntries: any[] = [];
  let approvedDeliberations: any[] = [];
  let eventIngestionSummary: any = null;
  try {
    const userIdForB: string | null = requestedUserId ?? null;
    let userIdResolved: string | null = userIdForB;
    if (!userIdResolved) {
      const { data: anyCtxRow } = await supabase
        .from("did_daily_context")
        .select("user_id")
        .order("context_date", { ascending: false })
        .limit(1)
        .maybeSingle();
      userIdResolved = anyCtxRow?.user_id ?? null;
    }
    if (userIdResolved) {
      eventIngestionSummary = await runGlobalDidEventIngestion(supabase as any, userIdResolved, {
        mode: "last_24h",
        sinceISO: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
      });
      pantryBEntries = await readUnprocessedPantryB(supabase, userIdResolved);
      const { data: recentOperationalContext } = await supabase
        .from("karel_pantry_b_entries")
        .select("id, entry_kind, source_kind, source_ref, summary, detail, intended_destinations, related_part_name, related_therapist, related_crisis_event_id, created_at, processed_at, processed_by, flush_result")
        .eq("user_id", userIdResolved)
        .in("source_kind", [
          "live_session_reality_override",
          "live_session_progress",
          "hana_personal_ingestion",
          "therapist_task_note",
          "briefing_ask_resolution",
        ])
        .contains("intended_destinations", ["briefing_input"])
        .gte("created_at", new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString())
        .order("created_at", { ascending: false })
        .limit(50);
      const isStillRelevant = (entry: any) => {
        const detail = entry?.detail && typeof entry.detail === "object" ? entry.detail : {};
        const text = `${entry?.summary ?? ""} ${JSON.stringify(detail)}`.toLowerCase();
        return Boolean(detail?.action_required)
          || detail?.include_in_next_session_plan === true
          || detail?.include_in_next_playroom_plan === true
          || ["live_session_reality_override", "live_session_progress", "briefing_ask_resolution"].includes(String(entry?.source_kind ?? ""))
          || /timmy|timmi|velryb|kepor|skute|reáln|odkaz|aktualne|mělčin|záchran/.test(text);
      };
      const mergedById = new Map<string, any>();
      for (const entry of [...pantryBEntries, ...((recentOperationalContext ?? []).filter(isStillRelevant))]) {
        if (entry?.id) mergedById.set(entry.id, entry);
      }
      pantryBEntries = Array.from(mergedById.values());
      const { data: approved } = await supabase
        .from("did_team_deliberations")
        .select("id, title, deliberation_type, subject_parts, status, final_summary, karel_synthesis, questions_for_hanka, questions_for_kata, discussion_log, updated_at")
        .eq("user_id", userIdResolved)
        .in("status", ["approved", "awaiting_signoff", "active"])
        .gte("updated_at", `${daysAgoISO(7)}T00:00:00Z`)
        .order("updated_at", { ascending: false })
        .limit(20);
      approvedDeliberations = approved ?? [];
      console.log(`[briefing] Pantry B loaded: entries=${pantryBEntries.length}, approved_delibs=${approvedDeliberations.length}, ingestion_processed=${eventIngestionSummary?.processed_count ?? 0}`);
    }
  } catch (bErr) {
    console.warn("[briefing] Pantry B / approved deliberations load failed (non-fatal):", bErr);
  }

  // ── Včerejší sezení (pro yesterday_session_review) ──
  const yesterdaySessions = (yesterdaySessionsRes.data || []) as any[];
  const yesterdayPlans = (yesterdayPlansRes.data || []) as any[];
  const yesterdayPlanIds = yesterdayPlans.map((p: any) => p?.id).filter((id: any) => typeof id === "string");
  let yesterdaySessionReviews: any[] = [];
  if (yesterdayPlanIds.length > 0) {
    const { data: reviews } = await supabase
      .from("did_session_reviews")
      .select("id, plan_id, mode, review_kind, status, part_name, session_date, lead_person, assistant_persons, clinical_summary, therapeutic_implications, team_implications, next_session_recommendation, evidence_limitations, evidence_items, completed_checklist_items, missing_checklist_items, source_data_summary, analysis_json, implications_for_part, implications_for_whole_system, recommendations_for_therapists, recommendations_for_next_playroom, recommendations_for_next_session, team_closing, drive_sync_status, source_of_truth_status, detail_analysis_drive_url, practical_report_drive_url, created_at")
      .in("plan_id", yesterdayPlanIds)
      .eq("is_current", true)
      .order("created_at", { ascending: false })
      .limit(5);
    const allReviews = (reviews ?? []).filter((r: any) => String(r?.mode ?? "session") !== "playroom");
    const rank = (r: any) => {
      const basis = reviewEvidenceBasis(r);
      if (basis === "completed") return 0;
      if (basis === "started_partial") return 1;
      if (basis === "planned_only") return 3;
      return 2;
    };
    yesterdaySessionReviews = allReviews.sort((a: any, b: any) => rank(a) - rank(b));
  }
  if (yesterdaySessionReviews.length === 0) {
    const { data: reviewsByDate } = await supabase
      .from("did_session_reviews")
      .select("id, plan_id, mode, review_kind, status, part_name, session_date, lead_person, assistant_persons, clinical_summary, therapeutic_implications, team_implications, next_session_recommendation, evidence_limitations, evidence_items, completed_checklist_items, missing_checklist_items, source_data_summary, analysis_json, implications_for_part, implications_for_whole_system, recommendations_for_therapists, recommendations_for_next_playroom, recommendations_for_next_session, team_closing, drive_sync_status, source_of_truth_status, detail_analysis_drive_url, practical_report_drive_url, created_at")
      .eq("session_date", yesterdayISO)
      .eq("is_current", true)
      .neq("mode", "playroom")
      .order("created_at", { ascending: false })
      .limit(5);
    yesterdaySessionReviews = reviewsByDate ?? [];
  }
  if (proofReviewId) {
    const { data: proofReview } = await supabase
      .from("did_session_reviews")
      .select("id, plan_id, mode, review_kind, status, part_name, session_date, lead_person, assistant_persons, clinical_summary, therapeutic_implications, team_implications, next_session_recommendation, evidence_limitations, evidence_items, completed_checklist_items, missing_checklist_items, source_data_summary, analysis_json, implications_for_part, implications_for_whole_system, recommendations_for_therapists, recommendations_for_next_playroom, recommendations_for_next_session, team_closing, drive_sync_status, source_of_truth_status, detail_analysis_drive_url, practical_report_drive_url, created_at")
      .eq("id", proofReviewId)
      .eq("is_current", true)
      .neq("mode", "playroom")
      .maybeSingle();
    if (proofReview) yesterdaySessionReviews = [proofReview, ...yesterdaySessionReviews.filter((r: any) => r.id !== proofReview.id)];
  }
  const { data: yesterdayPlayroomReviews } = await supabase
    .from("did_session_reviews")
    .select("id, plan_id, mode, review_kind, status, part_name, session_date, clinical_summary, therapeutic_implications, team_implications, evidence_limitations, evidence_items, source_data_summary, analysis_json, implications_for_part, implications_for_whole_system, recommendations_for_therapists, recommendations_for_next_playroom, recommendations_for_next_session, next_session_recommendation, drive_sync_status, detail_analysis_drive_url, practical_report_drive_url, created_at")
    .eq("session_date", yesterdayISO)
    .eq("mode", "playroom")
    .eq("review_kind", "karel_direct_playroom")
    .eq("is_current", true)
    .order("created_at", { ascending: false })
    .limit(3);
  const { data: yesterdayPlayroomThread } = await supabase
    .from("did_threads")
    .select("id,part_name,workspace_id,workspace_type,sub_mode,thread_label,messages,last_activity_at")
    .in("sub_mode", ["karel_part_session", "playroom"])
    .gte("last_activity_at", `${yesterdayISO}T00:00:00Z`)
    .lte("last_activity_at", `${yesterdayISO}T23:59:59.999Z`)
    .order("last_activity_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const clinicalReviewParts = new Set(yesterdaySessionReviews.filter((r: any) => ["completed", "started_partial", "unknown"].includes(reviewEvidenceBasis(r))).map((r: any) => String(r.part_name ?? "").toLowerCase()));
  const safeYesterdaySessions = clinicalReviewParts.size > 0
    ? yesterdaySessions.filter((s: any) => clinicalReviewParts.has(String(s.part_name ?? "").toLowerCase()))
    : [];

  return {
    today: pragueDayISO(),
    yesterday: yesterdayISO,
    crises: crisesRes.data || [],
    recent_observations: (recentObsRes.data || []).map((o: any) => ({
      ...o,
      part_name: o.subject_type === "part" ? o.subject_id : null,
      content: o.fact,
      severity: o.evidence_level,
    })),
    older_significant: (olderObsRes.data || []).map((o: any) => ({
      ...o,
      part_name: o.subject_type === "part" ? o.subject_id : null,
      content: o.fact,
      severity: o.evidence_level,
    })),
    pending_questions: (pendingRes.data || []).map((q: any) => ({
      ...q,
      part_name: q.subject_type === "part" ? q.subject_id : null,
      asked_to: q.directed_to,
    })),
    recent_threads: threadsRes.data || [],
    recent_session_plans: (plansRes.data || []).map((p: any) => ({
      ...p,
      part_name: p.selected_part ?? null,
      session_date: p.plan_date,
    })),
    yesterday_sessions: safeYesterdaySessions,
    yesterday_plans: yesterdayPlans,
    yesterday_session_reviews: yesterdaySessionReviews,
    yesterday_playroom_reviews: yesterdayPlayroomReviews ?? [],
    yesterday_playroom_thread: yesterdayPlayroomThread ?? null,
    pantry_a: pantryA,
    pantry_a_summary: pantryASummary,
    pantry_b_entries: pantryBEntries,
    event_ingestion_summary: eventIngestionSummary,
    new_observations: (recentObsRes.data || []).filter((o: any) => o.source_ref && String(o.source_ref).startsWith("did_")),
    task_note_implications: pantryBEntries.filter((e: any) => e.source_kind === "therapist_task_note"),
    hana_personal_did_relevant_implications: pantryBEntries.filter((e: any) => e.source_kind === "hana_personal_ingestion"),
    live_replan_patches: pantryBEntries.filter((e: any) => e.source_kind === "live_session_progress" || e.source_kind === "live_session_reality_override"),
    reality_override_events: pantryBEntries.filter((e: any) => e.source_kind === "live_session_reality_override"),
    blocked_or_failed_ingestion: eventIngestionSummary?.blocked_sources ?? [],
    approved_deliberations: approvedDeliberations,
  };
}

// ───────────────────────────────────────────────────────────
// AI: strukturovaný briefing přes tool calling
// ───────────────────────────────────────────────────────────
const BRIEFING_TOOL = {
  type: "function",
  function: {
    name: "emit_daily_briefing",
    description: "Vrátí strukturovaný denní briefing Karla pro dashboardovou poradu týmu.",
    parameters: {
      type: "object",
      properties: {
        greeting: {
          type: "string",
          description: "Karlovo úvodní slovo (2-4 věty). Kultivovaná čeština, jungovská noblesa. Pozdrav Haničce a Káte, dnešní hlavní priorita, proč je důležitá. Bez patosu.",
        },
        last_3_days: {
          type: "string",
          description: "Syntéza posledních 3 dnů (2-4 věty, ne raw log). Co se změnilo, jaké linie se ukazují. Konkrétní jména částí, ne 'systém'.",
        },
        lingering: {
          type: "string",
          description: "Co zůstává významné z dřívějška (1-3 věty). Jen skutečně relevantní věci, ne všechno staré.",
        },
        yesterday_session_review: {
          type: "object",
          description:
            "KLINICKÉ PŘETLUMOČENÍ včerejšího sezení Karlovým hlasem — NE provozní zpráva, NE výpis kroků, NE „co se programově dělo“. " +
            "Karel mluví jako vedoucí týmu, který právě dočetl analýzu a teď ji vrací zpátky Hance a Káte v lidské řeči. " +
            "Pokud včera žádné sezení nebylo, nech klíč null. Pokud bylo přerušené nebo částečné, neříkej, že proběhlo celé.",
          properties: {
            held: { type: "boolean", description: "True pokud včera proběhlo aspoň částečné sezení." },
            part_name: { type: "string" },
            lead: { type: "string", enum: ["Hanička", "Káťa", "společně"] },
            review_status: { type: "string", description: "Stav review, např. partially_analyzed." },
            completion: { type: "string", enum: ["completed", "partial", "abandoned"] },
            completed_checklist_count: { type: "number" },
            total_checklist_count: { type: "number" },
            evidence_label: { type: "string", description: "Krátká evidence značka, např. 1/5 checklist položek." },
            evidence_limited: { type: "boolean" },
            evidence_limitations: { type: "string" },
            review_id: { type: "string" },
            plan_id: { type: "string" },
            karel_summary: {
              type: "string",
              description:
                "PRIMÁRNÍ — 4–7 vět Karlova přetlumočení. CO SE VČERA OPRAVDU UKÁZALO — celkový oblouk, klima, atmosféra, " +
                "kvalita kontaktu mezi částí a terapeutkou. NE seznam programových bodů. Mluv o smyslu, ne o průběhu. " +
                "Konkrétní jméno části, žádný „systém“, žádný „klient“.",
            },
            key_finding_about_part: {
              type: "string",
              description:
                "DŮLEŽITÉ KLINICKÉ ZJIŠTĚNÍ O ČÁSTI — 2–4 věty. Co nového / přesnějšího teď víme o této části: " +
                "její potřeba, obrana, vývojová úroveň, vztahový vzorec, spouštěč, zdroj. " +
                "Pojmenuj to jako klinický posun v porozumění, ne jako popis epizody.",
            },
            implications_for_plan: {
              type: "string",
              description:
                "CO Z TOHO PLYNE PRO TERAPEUTICKÝ PLÁN — 2–4 věty. Konkrétní úprava směru práce s touto částí: " +
                "co přidat, co opustit, co zpomalit, jaký formát příště zvolit, na co si dát pozor. " +
                "Mluv jako klinik, ne jako provozák.",
            },
            team_acknowledgement: {
              type: "string",
              description:
                "PODĚKOVÁNÍ A STMELENÍ TÝMU — 1–3 věty osobně adresované terapeutce/terapeutkám, které sezení vedly. " +
                "Konkrétně pojmenuj, co udělaly dobře (klid, trpělivost, intuitivní rozhodnutí, zvládnutí přerušení). " +
                "Bez patosu, bez floskulí. Pokud sezení vedla jen jedna z nich, oslov jen ji.",
            },
          },
          required: ["held", "karel_summary", "key_finding_about_part", "implications_for_plan", "team_acknowledgement"],
          additionalProperties: false,
        },
        decisions: {
          type: "array",
          description: "Společná rozhodnutí pro dnešek. MAX 2 položky, +1 navíc jen pokud je crisis (= max 3 celkem). Konkrétní rozhodovací názvy, NE generické 'koordinovat strategii'. ID NEDOPLŇUJ — server přidá.",
          items: {
            type: "object",
            properties: {
              title: { type: "string", description: "Krátký konkrétní rozhodovací název, např. 'Dnešní krizový plán pro Arthura'." },
              reason: { type: "string", description: "1-2 věty proč to potřebuje společnou shodu." },
              type: { type: "string", enum: ["crisis", "session_plan", "clinical_decision", "follow_up_review", "supervision"] },
              part_name: { type: "string", description: "Jméno části, které se to týká (pokud relevantní)." },
            },
            required: ["title", "reason", "type"],
            additionalProperties: false,
          },
          maxItems: 3,
        },
        proposed_session: {
          type: "object",
          description: "Dnešní navržené sezení. POVINNÉ pokud existují dostatečné signály. Pokud žádný kandidát nepřekročil práh skóre 3, nech null. ID NEDOPLŇUJ — server přidá.",
          properties: {
            part_name: { type: "string" },
            why_today: { type: "string", description: "Proč právě tato část a právě dnes (2-3 věty)." },
            led_by: { type: "string", enum: ["Hanička", "Káťa", "společně"] },
            duration_min: { type: "number", description: "Doporučená délka v minutách (10-45)." },
            first_draft: { type: "string", description: "První pracovní verze plánu sezení (3-5 vět). Co začít, kdy zůstat u stabilizace, kdy zvážit hlubší práci." },
            kata_involvement: { type: "string", description: "Jednou větou, zda dnes přizvat Káťu a za jakých okolností." },
            agenda_outline: {
              type: "array",
              description: "Strukturovana minutaz sezeni — 4 az 6 kroku. Kazdy krok MUSI byt ZIVY a HRAVY — pojmenuj konkretni terapeuticky nastroj z arzenalu (asociacni test, Rorschach lite, aktivni imaginace, kresba dne, grounding 5-4-3-2-1, mandala, atd.). NE genericke bloky typu uvod/prace/uzaver.",
              items: {
                type: "object",
                properties: {
                  block: { type: "string", description: "Konkretni hravy nazev kroku, napr. 'Asociacni otevreni — 8 slov o domove' nebo 'Mandala dne s reflexi stredu'. Zadna abstraktni slova typu 'prace s emocemi'." },
                  minutes: { type: "number", description: "Doporucena doba v minutach." },
                  detail: { type: "string", description: "3-5 vet co se v bloku konkretne deje: pomucky (remote — chat, hlas, kresba do screenu, foto), Karluv prompt nebo otazka, ceho si v reakci casti vsimat. Hravy jazyk, ne klinicky." },
                  tool_id: { type: "string", description: "ID nastroje z toolboxu (wat, barvy_dnes, rorschach_lite, tat_lite, active_imagination, safe_place, what_if, world_building, tri_dvere, deset_let, skala_telo, grounding_5_4_3_2_1, kresba_dnes, mandala, rukopis_vzorek). Volitelne, pokud blok kombinuje vice nastroju." },
                },
                required: ["block", "detail"],
                additionalProperties: false,
              },
              minItems: 3,
              maxItems: 6,
            },
            playful_hooks: {
              type: "array",
              description: "2-4 konkretni hrave hacky, ktere Karel uvnitr sezeni rozjede, pokud je cas/prostor: necekana otazka, asociace, mini-hra. Kazdy hook 1 veta.",
              items: { type: "string" },
              minItems: 0,
              maxItems: 4,
            },
            materials_needed: {
              type: "array",
              description: "Co si Karel pripravi PRED sezenim (obrazky pro Rorschach lite, sada slov pro WAT, scena pro TAT lite). Vse digitalni — zadne fyzicke pomucky.",
              items: { type: "string" },
              maxItems: 6,
            },
            hybrid_contract: {
              type: "object",
              description: "SESSION-QUALITY-1 hybridní kontrakt. Klinická přesnost + hravost + evidence guardy. Nevymýšlej preference: téma použij jen z karty části, terapeutčiny odpovědi nebo jiné explicitní evidence; jinak theme_source='unknown' nebo 'neutral_choice'.",
              properties: {
                clinical_goal: { type: "string" },
                treatment_phase: { type: "string", enum: ["stabilization", "processing", "integration", "monitoring"] },
                diagnostic_or_therapeutic_intent: { type: "string" },
                risk_gate: { type: "string" },
                readiness_today: { type: "string", enum: ["green", "amber", "red"] },
                playful_theme: { type: "string" },
                theme_source: { type: "string", enum: ["confirmed_part_card", "therapist_answer", "neutral_choice", "unknown"] },
                confirmed_preferences_only: { type: "boolean" },
                therapist_led_vs_karel_only: { type: "string", enum: ["therapist_led", "karel_only", "tandem"] },
                materials_or_props: { type: "array", items: { type: "string" }, maxItems: 8 },
                what_therapist_says: { type: "array", items: { type: "string" }, maxItems: 8 },
                what_therapist_observes: { type: "array", items: { type: "string" }, maxItems: 10 },
                data_needed_for_valid_review: { type: "array", items: { type: "string" }, maxItems: 10 },
                stop_rules: { type: "array", items: { type: "string" }, maxItems: 8 },
                fallback: { type: "string" },
                writeback_target: { type: "array", items: { type: "string", enum: ["review", "05A", "part_card", "05C"] }, maxItems: 4 },
              },
              required: ["clinical_goal", "treatment_phase", "diagnostic_or_therapeutic_intent", "risk_gate", "readiness_today", "playful_theme", "theme_source", "confirmed_preferences_only", "therapist_led_vs_karel_only", "data_needed_for_valid_review", "stop_rules", "fallback", "writeback_target"],
              additionalProperties: false,
            },
            questions_for_hanka: {
              type: "array",
              description: "1-3 konkrétní otázky pro Haničku ohledně tohoto sezení (její perspektiva: matka, primární terapeutka).",
              items: { type: "string" },
              maxItems: 3,
            },
            questions_for_kata: {
              type: "array",
              description: "1-3 konkrétní otázky pro Káťu ohledně tohoto sezení (její perspektiva: druhá terapeutka, supervize, externí pohled). MUSÍ být JINÉ než questions_for_hanka.",
              items: { type: "string" },
              maxItems: 3,
            },
          },
          required: ["part_name", "why_today", "led_by", "first_draft", "agenda_outline", "hybrid_contract", "questions_for_hanka", "questions_for_kata"],
          additionalProperties: false,
        },
        proposed_playroom: {
          type: "object",
          description: "POVINNÝ samostatný návrh dnešní Herny. Herna je Karel-led terapeutická práce s konkrétní částí; NESMÍ kopírovat proposed_session.first_draft ani plan_markdown. Musí obsahovat vlastní playroom_plan.",
          properties: {
            part_name: { type: "string" },
            status: { type: "string", enum: ["draft", "awaiting_therapist_review", "in_revision", "approved", "ready_to_start", "in_progress", "completed", "evaluated", "archived"] },
            why_this_part_today: { type: "string", description: "Konkrétní důvod výběru části: týdenní směr, včerejší aktivita, report Herny/Sezení, karta části, 2-3denní vývoj." },
            main_theme: { type: "string", description: "Konkrétní téma Herny navázané na část a aktuální problém." },
            evidence_sources: { type: "array", items: { type: "string" }, maxItems: 8 },
            goals: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 4 },
            playroom_plan: {
              type: "object",
              description: "Jediný program, který smí Herna použít. Dětsky bezpečný, krátký, profesionální, vhodný pro Karla bez fyzického těla a bez fyzické kontroly.",
              properties: {
                therapeutic_program: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      block: { type: "string" },
                      minutes: { type: "number" },
                      detail: { type: "string", description: "Konkrétní mikro-krok: otázka, kresba/foto upload, hlasový vstup, symbolická hra, bezpečná diagnostická aktivita; bez fyzického pozorování." },
                      tool_id: { type: "string" },
                    },
                    required: ["block", "detail"],
                    additionalProperties: false,
                  },
                  minItems: 4,
                  maxItems: 6,
                },
                child_safe_version: { type: "string" },
                micro_steps: { type: "array", items: { type: "string" }, maxItems: 8 },
                expected_child_reactions: { type: "array", items: { type: "string" }, maxItems: 8 },
                recommended_karel_responses: { type: "array", items: { type: "string" }, maxItems: 8 },
                risks_and_stop_signals: { type: "array", items: { type: "string" }, maxItems: 8 },
                forbidden_directions: { type: "array", items: { type: "string" }, maxItems: 8 },
                runtime_packet_seed: { type: "object", additionalProperties: true },
              },
              required: ["therapeutic_program", "child_safe_version", "micro_steps", "recommended_karel_responses", "risks_and_stop_signals", "forbidden_directions"],
              additionalProperties: false,
            },
            questions_for_hanka: { type: "array", items: { type: "string" }, maxItems: 3 },
            questions_for_kata: { type: "array", items: { type: "string" }, maxItems: 3 },
          },
          required: ["part_name", "status", "why_this_part_today", "main_theme", "goals", "playroom_plan", "questions_for_hanka", "questions_for_kata"],
          additionalProperties: false,
        },
        ask_hanka: {
          type: "array",
          description: "Co Karel dnes potřebuje od Haničky. 1-3 konkrétní položky. Musí být JINÉ než ask_kata. Vrať pole STRINGŮ — id se doplní serverově.",
          items: { type: "string" },
          maxItems: 3,
        },
        ask_kata: {
          type: "array",
          description: "Co Karel dnes potřebuje od Káti. 1-3 konkrétní položky. Musí být JINÉ než ask_hanka. Vrať pole STRINGŮ — id se doplní serverově.",
          items: { type: "string" },
          maxItems: 3,
        },
        waiting_for: {
          type: "array",
          description: "Na co Karel čeká, než upraví finální postup (0-3 položky).",
          items: { type: "string" },
          maxItems: 3,
        },
        closing: {
          type: "string",
          description: "Krátký uzávěr (1-2 věty). Co se stane, jakmile Hanička a Káťa doplní své pohledy.",
        },
      },
      required: ["greeting", "last_3_days", "decisions", "proposed_playroom", "ask_hanka", "ask_kata", "closing"],
      additionalProperties: false,
    },
  },
};

const SYSTEM_PROMPT = `Jsi Karel — vedoucí terapeutického týmu (Hanička, Káťa).
Generuješ denní briefing pro poradu týmu o systému kluků (DID).

ABSOLUTNÍ PRAVIDLA JAZYKA:
- NIKDY neříkej "systém" nebo "DID systém". Vždy "kluci" nebo jménem konkrétní části.
- NIKDY neříkej "klient". Kluci jsou kluci.
- Konkrétní jména: Arthur, Tundrupek, Gerhard, Gustík atd. — používej je.

TÓN:
- Kultivovaná čeština, jungovská noblesa v úvodu, smyslu a přechodech.
- KRÁTKÉ a KONKRÉTNÍ názvy v rozhodovacích bodech a tasks.
- Žádný pseudo-log styl ("Dnes je nejdůležitější toto: …").
- Žádná pseudo-poezie, žádný patos.
- Žádné "Koordinovat strategii", "Synchronizovat úkoly", "Rozdělit si tasks" — to jsou ZAKÁZANÉ formulace.

REDUKCE TÝMOVÝCH BODŮ:
- Maximálně 2 společná rozhodnutí (+1 navíc jen pokud aktivní krize = max 3).
- Týmový bod smí vzniknout JEN pro: crisis | session_plan | clinical_decision | follow_up_review | supervision.
- NE pro běžnou operativu, individuální task pro Haničku, individuální task pro Káťu.

DNEŠNÍ NAVRŽENÉ SEZENÍ:
- Pokud kontext obsahuje kandidáta se skóre ≥ 3, MUSÍŠ navrhnout konkrétní sezení.
- Vyber nejvhodnějšího kandidáta z poskytnutého seznamu, NEvymýšlej jméno mimo seznam.
- Uveď: koho, proč právě dnes, kdo povede, první pracovní verze, kdy přizvat Káťu.

DNEŠNÍ NAVRŽENÁ HERNA — POVINNÁ KAŽDÝ DEN:
- VŽDY vytvoř proposed_playroom jako samostatný Karel-led program pro jednu konkrétní část. Nikdy ho nenechávej null.
- Herna není běžný chat a není terapeutkou vedené Sezení. Vede ji Karel přímo s částí; terapeutka nemusí být fyzicky přítomná.
- proposed_playroom.playroom_plan je jediný povolený program Herny. Nesmí být kopií proposed_session.first_draft, plan_markdown ani interního terapeutického programu pro Haničku/Káťu.
- status nastav primárně na awaiting_therapist_review. Vstup do Herny bude možný až po schválení terapeutkami.
- Program musí být profesionální hlubinně-psychoterapeutický a diagnosticky cílený, ale bezpečný pro Karla bez fyzického těla a bez fyzické kontroly.
- Používej digitálně proveditelné aktivity: „nakresli strom a pošli mi ho sem“, „řekni hlasem jedno slovo“, „popiš vlastními slovy postavu ve fantazii“, symbolická hra, aktivní imaginace, slovní asociace, bezpečné projektivní mikro-úkoly.
- Zahrň: část, téma, proč dnes, zdroje, cíle, therapeutic_program, child_safe_version, mikro-kroky, očekávané reakce, doporučené reakce Karla, rizika/stop signály a zakázané směry.
- Dětsky bezpečná verze nesmí obsahovat slova jako diagnostika, klinicky významné, terapeutický plán, schvalování, analýza nebo model.
- Výběr opři nejvíc o týdenní směr, včerejší aktivitu a reporty ze včerejší Herny/Sezení; středně o 2–3 dny a kartu části; měsíční směr jen strategicky.

PROGRAM SEZENÍ — HRAVOST JE POVINNÁ:
- agenda_outline NESMÍ být generická („úvod / práce s emocemi / uzávěr"). MUSÍ obsahovat alespoň 2 KONKRÉTNÍ nástroje z TERAPEUTICKÉHO ARZENÁLU (asociační test, Rorschach lite, aktivní imaginace, mandala, kresba dne, „co kdyby", 3 dveře, atd.).
- Každý blok agenda_outline má hravý název („Asociační otevření — 8 slov o tátovi", ne „úvodní rozhovor"), 3-5 vět detailu a pokud možno tool_id.
- Rozlišuj therapist-led vs Karel-only Herna v hybrid_contract. Therapist-led smí obsahovat fyzické pomůcky, kresbu, knihu, hračky, pohybové/somatické prvky, latence, afekt a neverbální pozorování; musí ale říct, co má terapeutka sledovat a dodat jako validní evidenci.
- Karel-only Herna smí obsahovat jen bezpečný check-in, grounding, resource-building, symbolickou hru přes chat, příběhové mapování a nízkorizikové pozorování z textových odpovědí. Nesmí předstírat validní psychodiagnostiku, fyzické měření latencí, neverbální diagnostiku ani hlubokou práci s traumatickou pamětí.
- Pokud metoda vyžaduje fyzického pozorovatele, napiš výslovně: „Tuto část nemůže Karel validně provést sám v herně; vyžaduje fyzickou terapeutku kvůli pozorování latencí, afektu a neverbálních projevů."
- playful_hooks: 2-4 konkrétní hravé háčky („Co by řekl tomu obrazu Tundrupkův drak?"), pro spontánnost.
- materials_needed / materials_or_props: fyzické věci pouze u therapist-led; u Karel-only jen digitální/chatové prostředky.
- Inspirace JUNG: aktivní imaginace, Word Association Test, mandala jako Self-symbolika, dialog s vnitřními postavami.

HYBRIDNÍ KONTRAKT:
- proposed_session.hybrid_contract je povinný a ukládá klinický cíl, léčebnou fázi, záměr, risk gate, readiness_today, hravý obal, stop rules, fallback, data pro validní review a writeback_target.
- Preference a témata smíš použít jen pokud jsou potvrzená kartou části, odpovědí terapeutky nebo jinou explicitní evidencí. Jinak napiš theme_source="unknown" nebo "neutral_choice" a nabídni neutrální volbu. Tundrupek hory/draci/tibetská tematika a Arthur Gruffalo/kniha jen pokud jsou v evidenci — nikdy nehalucinuj.
- Program nesmí být suchý seznam: vždy musí mít název, proč dnes, terapeutický cíl, klinický důvod, hravý obal, bloky po minutách, konkrétní věty, co sledovat, co zaznamenat, stop pravidla, fallback a výsledek pro review.

ROZDĚLENÍ ASKS:
- Hanička dostává JINÉ otázky než Káťa. Ne stejné body s prohozeným jménem.
- Hanička je v běžném kontaktu s kluky (každodenní, blízká).
- Káťa je z odstupu, ze vzdálenosti (~100 km), může ověřit dostupnost externích osob.

Vrať VÝHRADNĚ tool call emit_daily_briefing.`;

async function generateBriefing(
  context: any,
  candidates: SessionCandidate[],
  apiKey: string,
): Promise<{ payload: any; durationMs: number }> {
  const start = Date.now();

  // ── PANTRY B SECTION (yesterday→today implications) ──────────────
  const pbEntries = (context.pantry_b_entries ?? []) as any[];
  const approvedDelibs = (context.approved_deliberations ?? []) as any[];
  const formatPantryBLine = (e: any) => {
    const part = e.related_part_name ? ` [${e.related_part_name}]` : "";
    const ther = e.related_therapist ? ` (${e.related_therapist === "hanka" ? "Hanička" : "Káťa"})` : "";
    return `- [${e.entry_kind}/${e.source_kind}]${part}${ther} ${String(e.summary || "").slice(0, 220)}`;
  };
  const pantryBSection = pbEntries.length > 0
    ? `═══ SPIŽÍRNA B — VČEREJŠÍ IMPLIKACE PRO DNEŠEK ═══\nTo jsou věci, které z včerejších vláken / porad / sezení přímo plynou pro dnešní rozhodování. Použij je v greeting, last_3_days a hlavně v decisions a ask_*. NEIGNORUJ je. Pokud je zde záznam source_kind=team_deliberation se schválenou poradou, MUSÍŠ výslovně zmínit, že porada byla schválena, o čem byla, co z ní vyplynulo a jak se k tomu dnes terapeuticky postavíme.\n${pbEntries.slice(0, 30).map(formatPantryBLine).join("\n")}\n\n`
    : "";
  const approvedDelibsSection = approvedDelibs.length > 0
    ? `═══ NEDÁVNÉ PORADY A ODPOVĚDI TERAPEUTEK (posledních 7 dní) — ZÁVAZNÉ POZADÍ ═══
${approvedDelibs.map((d: any) => {
        const ks = d.karel_synthesis as any;
        const next = ks?.next_step ? ` → další krok: ${ks.next_step}` : "";
        const summary = d.final_summary ? ` | shrnutí: ${String(d.final_summary).slice(0, 160)}` : "";
        const subj = (d.subject_parts || []).join(", ");
        const qa = [...(d.questions_for_hanka || []), ...(d.questions_for_kata || [])]
          .filter((q: any) => String(q?.answer || "").trim())
          .slice(0, 4)
          .map((q: any) => `Q: ${String(q.question || "").slice(0, 90)} → A: ${String(q.answer || "").slice(0, 160)}`)
          .join(" | ");
        return `- "${d.title}" [${d.status}] (${d.deliberation_type}${subj ? `, ${subj}` : ""})${next}${summary}${qa ? ` | odpovědi: ${qa}` : ""}`;
      }).join("\n")}

⚠ Tyto porady mohou být uzavřené i rozpracované. Pravidla:
  1) NIKDY pro tyto subject_parts/téma nezakládej nové decisions se stejným nebo téměř stejným titulkem.
  2) Pokud odpověď terapeutky upřesňuje lék/Derin/dohodu, zacházej s ní jako s aktuální evidencí, ne jako s otevřenou neznámou.
  3) V proposed_session.first_draft a why_today VYUŽIJ závěr porady i konkrétní odpovědi — neopakuj, co tým už vyjasnil.
  4) U schválených porad uveď ve výstupu jasně: schváleno 2/2, téma, závěr a dnešní terapeutický postoj.

`
    : "";

  const toolboxSection = candidates[0]?.score >= 3 ? `\n\n${summarizeToolboxForPrompt()}\n` : "";
  const ingestion = context.event_ingestion_summary ?? {};
  const eventIngestionSection = `═══ GLOBÁLNÍ SBĚR DID UDÁLOSTÍ — POVINNÝ KONTEXT ═══
event_ingestion_summary: ${JSON.stringify({
    processed_count: ingestion.processed_count ?? 0,
    routed_to_pantry_count: ingestion.routed_to_pantry_count ?? 0,
    skipped_count: ingestion.skipped_count ?? 0,
    failed_count: ingestion.failed_count ?? 0,
    duplicate_count: ingestion.duplicate_count ?? 0,
    important_sources: ingestion.important_sources ?? [],
    missing_sources: ingestion.missing_sources ?? [],
    blocked_sources: ingestion.blocked_sources ?? [],
  })}
task_note_implications: ${JSON.stringify((context.task_note_implications ?? []).slice(0, 8))}
hana_personal_did_relevant_implications: ${JSON.stringify((context.hana_personal_did_relevant_implications ?? []).slice(0, 8))}
new_observations: ${JSON.stringify((context.new_observations ?? []).slice(0, 8))}
live_replan_patches: ${JSON.stringify((context.live_replan_patches ?? []).slice(0, 8))}
reality_override_events: ${JSON.stringify((context.reality_override_events ?? []).slice(0, 8))}
blocked_or_failed_ingestion: ${JSON.stringify(context.blocked_or_failed_ingestion ?? [])}

Pravidlo: DB/Pantry B je operační zdroj. Drive je audit/archive. Drive→Pantry refresh není v tomto průchodu implementovaný.

`;

  // ── VČEREJŠÍ SEZENÍ — vstup pro yesterday_session_review ──
  const ySessions = (context.yesterday_sessions ?? []) as any[];
  const yPlans = (context.yesterday_plans ?? []) as any[];
  const yesterdaySection = (ySessions.length > 0 || yPlans.length > 0)
    ? `═══ VČEREJŠÍ SEZENÍ (${context.yesterday}) — POVINNÝ VSTUP PRO yesterday_session_review ═══
${ySessions.length > 0 ? ySessions.map((s: any) => {
  const blob = [
    `▸ Část: ${s.part_name || "?"} | Vede: ${s.therapist || "?"} | Typ: ${s.session_type || "?"}`,
    s.methods_used ? `  Metody: ${Array.isArray(s.methods_used) ? s.methods_used.join(", ") : s.methods_used}` : "",
    s.methods_effectiveness ? `  Efektivita metod: ${typeof s.methods_effectiveness === "object" ? JSON.stringify(s.methods_effectiveness).slice(0, 300) : String(s.methods_effectiveness).slice(0, 300)}` : "",
    s.karel_notes ? `  Karlovy poznámky: ${String(s.karel_notes).slice(0, 400)}` : "",
    s.handoff_note ? `  Handoff: ${String(s.handoff_note).slice(0, 300)}` : "",
    s.karel_therapist_feedback ? `  Feedback terapeutce: ${String(s.karel_therapist_feedback).slice(0, 300)}` : "",
    s.tasks_assigned ? `  Úkoly: ${typeof s.tasks_assigned === "object" ? JSON.stringify(s.tasks_assigned).slice(0, 200) : String(s.tasks_assigned).slice(0, 200)}` : "",
    s.ai_analysis ? `  AI analýza (předchozí evaluace):\n${String(s.ai_analysis).slice(0, 1800)}` : "",
  ].filter(Boolean).join("\n");
  return blob;
}).join("\n\n") : "(žádný řádek did_part_sessions ze včerejška)"}

${yPlans.length > 0 ? `Plány ze včerejška:\n${yPlans.map((p: any) => `- ${p.selected_part || "?"} | vede: ${p.session_lead || p.therapist || "?"} | status: ${p.status} | completed_at: ${p.completed_at || "—"}`).join("\n")}` : ""}

⚠ POVINNÉ: Pokud výše existuje aspoň jeden řádek did_part_sessions ze včerejška, MUSÍŠ vyplnit yesterday_session_review s held=true a všemi 4 textovými poli (karel_summary, key_finding_about_part, implications_for_plan, team_acknowledgement). NESMÍŠ to vrátit jako held=false.

⚠ STYL yesterday_session_review (PŘETLUMOČENÍ, NE PROVOZNÍ ZPRÁVA):
- karel_summary = TVŮJ HLAS, vedoucího týmu, který právě dočetl analýzu. Přetlumoč CO SE DĚLO V SMYSLU, ne v krocích programu. Atmosféra, kontakt, oblouk. NE seznam bodů. NE „Bod 1, Bod 2". 4–7 vět.
- key_finding_about_part = klinický POSUN V POROZUMĚNÍ části. Co teď víme jinak / přesněji než včera ráno. Pojmenuj to jako klinický vhled, ne jako popis epizody. 2–4 věty.
- implications_for_plan = konkrétní úprava terapeutického plánu pro tuto část. Co změnit, co zpomalit, co přidat, jaký formát příště. 2–4 věty.
- team_acknowledgement = osobní poděkování ${ySessions[0]?.therapist === "hanka" ? "Haničce" : ySessions[0]?.therapist === "kata" ? "Káte" : "týmu"}, konkrétně co udělala dobře (klid, intuice, zvládnutí přerušení). Bez patosu, bez floskulí. 1–3 věty.

`
    : `═══ VČEREJŠÍ SEZENÍ (${context.yesterday}) ═══
(žádné sezení včera neproběhlo — yesterday_session_review nech null nebo held=false)

`;

  const yPlayroom = buildYesterdayPlayroomReview(context);
  const yesterdayPlayroomSection = yPlayroom?.exists
    ? `═══ VČEREJŠÍ HERNA (${context.yesterday}) — AUTORITATIVNÍ VSTUP PRO proposed_playroom ═══
Stav: ${yPlayroom.status || "?"} | Část: ${yPlayroom.part_name || "?"} | review_id: ${yPlayroom.review_id || "zatím není"}

VČEREJŠÍ HERNA — PRAKTICKÝ REPORT:
${cleanBlockText(yPlayroom.practical_report_text || yPlayroom.fallback_reason || "Herna existuje, ale review zatím čeká.").slice(0, 1800)}

VČEREJŠÍ HERNA — DOPORUČENÍ PRO DALŠÍ PLÁNOVÁNÍ:
${cleanBlockText(yPlayroom.recommendations_for_next_playroom || yPlayroom.recommendations_for_therapists || yPlayroom.recommendations_for_next_session || "Navrhni bezpečně navazující nízkoprahovou Hernu a označ omezení evidence.").slice(0, 1800)}

POVINNÉ: proposed_playroom musí tento vstup použít jako evidence source a runtime seed.

`
    : "";


  const userPrompt = `KONTEXT PRO BRIEFING (${context.today}):

${context.pantry_a_summary ? `═══ SPIŽÍRNA A — RANNÍ PRACOVNÍ ZÁSOBA ═══\n${context.pantry_a_summary}\n\n` : ""}${eventIngestionSection}${pantryBSection}${approvedDelibsSection}${yesterdayPlayroomSection}AKTIVNÍ KRIZE (${context.crises.length}):
${context.crises.map((c: any) => `- ${c.part_name} | severity: ${c.severity} | fáze: ${c.phase} | dní aktivní: ${c.days_active || "?"} | trigger: ${c.trigger_description?.slice(0, 120) || "—"}`).join("\n") || "(žádné)"}

POZOROVÁNÍ ZA POSLEDNÍ 3 DNY (${context.recent_observations.length}):
${context.recent_observations.slice(0, 20).map((o: any) => `- [${o.severity || "?"}] ${o.part_name || "?"}: ${(o.content || "").slice(0, 100)}`).join("\n") || "(žádná)"}

STARŠÍ VÝZNAMNÉ SIGNÁLY (high severity, 4-7 dní zpět):
${context.older_significant.map((o: any) => `- ${o.part_name || "?"}: ${(o.content || "").slice(0, 100)}`).join("\n") || "(žádné)"}

PENDING OTÁZKY (${context.pending_questions.length}):
${context.pending_questions.slice(0, 10).map((q: any) => `- pro ${q.asked_to || "?"} ohledně ${q.part_name || "?"}: ${(q.question || "").slice(0, 80)}`).join("\n") || "(žádné)"}

NEDÁVNÉ SESSION PLÁNY (3 dny):
${context.recent_session_plans.map((p: any) => `- ${p.session_date} | ${p.part_name || "?"} | status: ${p.status}`).join("\n") || "(žádné)"}

${yesterdaySection}

KANDIDÁTI NA DNEŠNÍ SEZENÍ (skórovací heuristika):
${candidates.length > 0 ? candidates.slice(0, 5).map((c) => `- ${c.part_name} (skóre ${c.score}): ${c.reasons.join(", ")}`).join("\n") : "(žádní silní kandidáti — proposed_session může být null)"}
${toolboxSection}
ÚKOL:
Vygeneruj strukturovaný briefing pro dnešní poradu týmu. Drž se pravidel z system promptu.
${candidates[0]?.score >= 3 ? `MUSÍŠ navrhnout sezení — nejvhodnější kandidát je ${candidates[0].part_name}. Program (agenda_outline) MUSÍ obsahovat alespoň 2 konkrétní hravé nástroje z arzenálu (uveď jejich tool_id).` : "Pokud žádný kandidát nemá dost silné signály, nech proposed_session null."}
MUSÍŠ vždy navrhnout proposed_playroom. Pokud jsou signály slabé, zvol nejbezpečnější nízkoprahovou diagnosticko-terapeutickou Hernu s jasným playroom_plan a se statusem awaiting_therapist_review.`;

  const res = await fetch(AI_URL, {
    method: "POST",
    signal: AbortSignal.timeout(45_000),
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      tools: [BRIEFING_TOOL],
      tool_choice: { type: "function", function: { name: "emit_daily_briefing" } },
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    if (res.status === 429) throw new Error("Rate limit překročen, zkuste to za chvíli.");
    if (res.status === 402) throw new Error("Vyčerpaný kredit Lovable AI workspace.");
    throw new Error(`AI gateway error ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = await res.json();
  const toolCall = data.choices?.[0]?.message?.tool_calls?.[0];
  if (!toolCall?.function?.arguments) {
    throw new Error("AI nevrátila tool call.");
  }

  const payload = JSON.parse(toolCall.function.arguments);
  return { payload, durationMs: Date.now() - start };
}

// ───────────────────────────────────────────────────────────
// MAIN HANDLER
// ───────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  let activeAttemptId: string | null = null;
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const apiKey = Deno.env.get("LOVABLE_API_KEY")!;
    if (!apiKey) throw new Error("LOVABLE_API_KEY není nastavený.");

    const supabase = createClient(supabaseUrl, serviceKey);

    let body: any = {};
    try { body = await req.json(); } catch { /* GET / no body */ }
    const authHeader = req.headers.get("Authorization") || "";
    const cronSecretHeader = req.headers.get("X-Karel-Cron-Secret") || "";
    const isServiceCall = !!serviceKey && authHeader === `Bearer ${serviceKey}`;
    let effectiveCronSecret = Deno.env.get("KAREL_CRON_SECRET") || "";
    if (!effectiveCronSecret && cronSecretHeader) {
      try {
        const { data: secretOk } = await supabase.rpc("verify_karel_cron_secret", { p_secret: cronSecretHeader });
        effectiveCronSecret = secretOk === true ? cronSecretHeader : "";
      } catch (e) {
        console.warn("[briefing-auth] cron secret rpc verification failed:", (e as Error)?.message || e);
      }
    }
    const isCronSecretCall = !!effectiveCronSecret && cronSecretHeader === effectiveCronSecret;
    const wantsAuto = body?.method === "auto" || body?.source === "cron";
    const authHeaderPrefix = authHeader.startsWith("Bearer ") ? "Bearer" : authHeader ? "other" : "none";
    console.log("[briefing-auth] sanitized", JSON.stringify({
      has_authorization_header: !!authHeader,
      auth_header_prefix: authHeaderPrefix,
      has_x_karel_cron_secret: !!cronSecretHeader,
      verify_strategy: wantsAuto ? "cron_secret" : "user_auth",
      is_service_call: isServiceCall,
      is_cron_secret_call: isCronSecretCall,
      trigger_source: body?.source ?? null,
      user_agent_contains_pg_net: (req.headers.get("User-Agent") || "").toLowerCase().includes("pg_net"),
    }));
    let authenticatedUserId: string | null = null;
    let attemptId: string | null = null;
    if (wantsAuto && !isServiceCall && !isCronSecretCall) {
      const auditId = await startBriefingAttempt(supabase, {
        briefing_date: pragueDayISO(),
        generation_method: "auto",
        trigger_source: "cron",
        auth_mode: "unauthorized",
        status: "failed",
        error_code: "unauthorized_cron_call",
        error_message: "Cron musí použít platný interní cron secret header.",
        completed_at: new Date().toISOString(),
        metadata: { source: body?.source ?? null, method: body?.method ?? null, auth_header_prefix: authHeaderPrefix, has_x_karel_cron_secret: !!cronSecretHeader },
      });
      await finishBriefingAttempt(supabase, auditId, { status: "failed" });
      return jsonResponse({ error: "Unauthorized" }, 401);
    }
    if (!isServiceCall && !isCronSecretCall) {
      const authResult = await requireAuth(req);
      if (authResult instanceof Response) {
        const auditId = await startBriefingAttempt(supabase, {
          briefing_date: pragueDayISO(),
          generation_method: body?.method || (wantsAuto ? "auto" : "manual"),
          trigger_source: body?.source === "cron" ? "cron" : "unauthorized",
          auth_mode: "unauthorized",
          status: "failed",
          error_code: wantsAuto ? "unauthorized_cron_call" : "unauthorized_user_call",
          error_message: "Chybí platné interní nebo uživatelské oprávnění.",
          completed_at: new Date().toISOString(),
          metadata: { source: body?.source ?? null, method: body?.method ?? null },
        });
        await finishBriefingAttempt(supabase, auditId, { status: "failed" });
        return authResult;
      }
      authenticatedUserId = String((authResult as { user: any }).user?.id ?? "");
    }
    if (!isServiceCall && !isCronSecretCall && body?.userId && String(body.userId) !== authenticatedUserId) {
      return jsonResponse({ error: "user_scope_mismatch" }, 403);
    }
    let scopedUserId = !isServiceCall && !isCronSecretCall ? authenticatedUserId : null;
    if (isServiceCall || isCronSecretCall) {
      const { data: activeCycleUser } = await supabase.from("did_update_cycles")
        .select("user_id")
        .not("user_id", "is", null)
        .neq("user_id", ZERO_UUID)
        .order("started_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (activeCycleUser?.user_id) scopedUserId = activeCycleUser.user_id;
      if (!scopedUserId) {
        const { data: anyThread } = await supabase.from("did_threads")
          .select("user_id")
          .not("user_id", "is", null)
          .neq("user_id", ZERO_UUID)
          .order("last_activity_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        scopedUserId = anyThread?.user_id ?? null;
      }
    }
    if (!scopedUserId) return jsonResponse({ error: "missing_user_scope" }, 400);
    const generationMethod = body?.method || (wantsAuto ? "auto" : "manual");
    const forceRegenerate = body?.force === true;

    const today = pragueDayISO();
    const triggerSource = body?.source === "cron" ? "cron" : body?.source === "service" ? "service" : "ui";
    const authMode = isServiceCall ? "service_role" : isCronSecretCall ? "cron_secret" : "user";
    attemptId = await startBriefingAttempt(supabase, {
      user_id: scopedUserId,
      briefing_date: today,
      generation_method: generationMethod,
      trigger_source: triggerSource,
      auth_mode: authMode,
      status: "started",
      metadata: { force: forceRegenerate, source: body?.source ?? null },
    });
    activeAttemptId = attemptId;

    // ───────────────────────────────────────────────────────────
    // CYCLE GUARD (auto only)
    // ───────────────────────────────────────────────────────────
    // Pravidlo: `auto` briefing nesmí stát kanonickým briefingem dne,
    // pokud dnešní `did-daily-cycle-morning` ještě nedoběhl (`completed`).
    //
    // State machine pro method="auto":
    //   - running   → SKIP: nevkládáme nový řádek, neoznačujeme staré jako stale,
    //                 neměníme manuální briefing. Vracíme 200 + skipped=true.
    //   - failed    → SKIP: stejné jako running, ale s reason="cycle_failed".
    //   - completed → POKRAČUJ normálně (může vzniknout kanonický briefing,
    //                 starý dnešní briefing se může označit stale).
    //   - missing   → SKIP: žádný dnešní cycle ještě neběžel → degraded mode,
    //                 auto briefing se nesmí stát kanonickým.
    //
    // method="manual" (UI tlačítko `Přegenerovat`) tento guard NEPOUŽÍVÁ —
    // ruční regenerace musí jít vždy, i bez completed cycle.
    if (generationMethod === "auto") {
      const morningStartUtc = `${today}T00:00:00Z`;
      const morningEndUtc   = `${today}T10:00:00Z`;
      const { data: cycleRow, error: cycleErr } = await supabase
        .from("did_update_cycles")
        .select("id, status, started_at, completed_at, last_error, heartbeat_at, phase")
        .eq("cycle_type", "daily")
        .eq("user_id", scopedUserId)
        .gte("started_at", morningStartUtc)
        .lt("started_at", morningEndUtc)
        .order("started_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (cycleErr) {
        console.error("[briefing-guard] cycle lookup error:", cycleErr);
      }

      let cycleStatus: "running" | "failed" | "completed" | "missing" | "failed_stale" =
        !cycleRow ? "missing" : (cycleRow.status as any);
      if (cycleRow && cycleStatus === "running") {
        const ageMs = Date.now() - new Date(cycleRow.heartbeat_at || cycleRow.started_at).getTime();
        if (ageMs > STALE_CYCLE_MINUTES * 60 * 1000) {
          await supabase.from("did_update_cycles").update({
            status: "failed_stale",
            completed_at: new Date().toISOString(),
            last_error: "daily_cycle_stuck_timeout",
          }).eq("id", cycleRow.id).eq("status", "running");
          cycleStatus = "failed_stale";
          cycleRow.status = "failed_stale";
          cycleRow.last_error = "daily_cycle_stuck_timeout";
        }
      }

      if (cycleStatus !== "completed") {
        const reason =
          cycleStatus === "running" ? "cycle_running" :
          cycleStatus === "failed_stale" ? "cycle_stuck" :
          cycleStatus === "failed"  ? "cycle_failed"  :
          "cycle_missing";
        console.warn(
          `[briefing-guard] auto SKIPPED — daily-cycle-morning status='${cycleStatus}' for ${today}. ` +
          `cycle_id=${cycleRow?.id || "(none)"} started_at=${cycleRow?.started_at || "(none)"}`,
        );
        await finishBriefingAttempt(supabase, attemptId, {
          status: "skipped",
          error_code: reason,
          error_message: cycleRow?.last_error || "Denní cyklus není dokončený.",
          cycle_status: cycleStatus,
          cycle_id: cycleRow?.id || null,
        });
        return jsonResponse({
            skipped: true,
            reason,
            cycle_status: cycleStatus,
            cycle_id: cycleRow?.id || null,
            cycle_started_at: cycleRow?.started_at || null,
            cycle_last_error: cycleRow?.last_error || null,
            briefing_date: today,
            note: "Auto briefing nebyl vygenerován — dnešní ranní cycle ještě nedoběhl. " +
                  "Existující briefing dne (manual nebo dřívější auto) zůstává kanonický.",
          });
      }
      await finishBriefingAttempt(supabase, attemptId, { cycle_status: cycleStatus, cycle_id: cycleRow?.id || null });
    }

    // Pokud existuje fresh briefing pro dnešek a nechceme force, vrať ho
    if (!forceRegenerate) {
      const { data: existing } = await supabase
        .from("did_daily_briefings")
        .select("*")
        .eq("briefing_date", today)
        .eq("is_stale", false)
        .eq("user_id", scopedUserId)
        .order("generated_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (existing) {
        await finishBriefingAttempt(supabase, attemptId, { status: "succeeded", created_briefing_id: existing.id, metadata: { cached: true } });
        return jsonResponse({ briefing: existing, cached: true });
      }
    }

    // 1) Skórování kandidátů
    const candidates = await scoreSessionCandidates(supabase);

    // 2) Sběr kontextu
    const context = await gatherContext(supabase, body?.proofReviewId ?? body?.sessionReviewId ?? null, scopedUserId);

    // 3) AI generování; playroom review payload musí vzniknout deterministicky i při selhání těžké syntézy.
    let durationMs = 0;
    let rawPayload: any;
    try {
      const playroomSafeDefault = body?.fullAi !== true && buildYesterdayPlayroomReview(context)?.exists === true;
      const generated = body?.skipAi === true || body?.playroomSafeOnly === true || playroomSafeDefault
        ? { payload: buildDeterministicBriefingPayload(context, candidates), durationMs: 0 }
        : await generateBriefing(context, candidates, apiKey);
      rawPayload = generated.payload;
      durationMs = generated.durationMs;
    } catch (e: any) {
      console.error("[briefing] AI generation failed; using deterministic playroom-safe fallback", e);
      rawPayload = buildDeterministicBriefingPayload(context, candidates);
      durationMs = 0;
      rawPayload.generation_warning = String(e?.message ?? e).slice(0, 500);
    }
    let payload = enrichYesterdaySessionReview(rawPayload, context);
    payload.event_ingestion_summary = {
      processed_count: context.event_ingestion_summary?.processed_count ?? 0,
      routed_to_pantry_count: context.event_ingestion_summary?.routed_to_pantry_count ?? 0,
      skipped_count: context.event_ingestion_summary?.skipped_count ?? 0,
      failed_count: context.event_ingestion_summary?.failed_count ?? 0,
      duplicate_count: context.event_ingestion_summary?.duplicate_count ?? 0,
      important_sources: context.event_ingestion_summary?.important_sources ?? [],
      missing_sources: context.event_ingestion_summary?.missing_sources ?? [],
      blocked_sources: context.event_ingestion_summary?.blocked_sources ?? [],
    };
    payload.task_note_implications = context.task_note_implications ?? [];
    payload.hana_personal_did_relevant_implications = context.hana_personal_did_relevant_implications ?? [];
    payload.new_observations = context.new_observations ?? [];
    payload.live_replan_patches = context.live_replan_patches ?? [];
    payload.reality_override_events = context.reality_override_events ?? [];
    payload.blocked_or_failed_ingestion = context.blocked_or_failed_ingestion ?? [];
    payload.yesterday_playroom_review = buildYesterdayPlayroomReview(context);
    if (!payload.proposed_playroom || typeof payload.proposed_playroom !== "object" || !String(payload.proposed_playroom?.part_name ?? "").trim()) {
      console.warn("[briefing] AI payload missing proposed_playroom — applying mandatory backend fallback.");
      payload.proposed_playroom = buildMandatoryPlayroomProposal(payload, context, candidates);
    }
    if (!payload.proposed_session || typeof payload.proposed_session !== "object") {
      const fallbackSession = buildMandatorySessionProposal(payload, context, candidates);
      if (fallbackSession) {
        console.warn("[briefing] AI payload missing proposed_session despite yesterday/reality context — applying backend fallback.");
        payload.proposed_session = fallbackSession;
      }
    }
    injectPlayroomReviewIntoProposal(payload);
    injectSessionReviewIntoProposals(payload);
    injectBriefingAskResolutionsIntoProposals(payload, context);
    injectOperationalContextIntoProposals(payload, context);
    payload = applyOpeningMonologue(payload, context, candidates);

    // 3b) ── ASK ITEM IDENTITY ──
    // AI vrací ask_hanka/ask_kata jako string[]. Server přidá stabilní `id` na
    // každou položku tak, aby kliknutí v DidDailyBriefingPanel mohlo lazy-otevřít
    // kanonický `did_threads` workspace přes (workspace_type, workspace_id=item.id).
    //
    // PRAVIDLO IDENTITY (rozhodnuto 2026-04-19):
    //  - Carry-over přes ilike text-match v rámci téhož `briefing_date`:
    //    při force-regenerate stejného dne se znovupoužije `id` ze starého
    //    briefingu (i `is_stale=true` verze) pokud nový text odpovídá starému.
    //  - Mezi různými dny: vždy nové `id` (briefing ask je denní zadání).
    //  - Žádný cross-day match — pokud bychom chtěli vícedenní kontinuitu,
    //    má se řešit explicitním follow-up linkem, ne reuse stejného ask ID.
    const normalizeForMatch = (s: string): string =>
      s.toLowerCase().trim().replace(/\s+/g, " ").slice(0, 200);

    type AskItem = {
      id: string;
      text: string;
      assignee: "hanka" | "kata";
      question_text: string;
      intent: "session_plan" | "playroom_plan" | "team_coordination" | "task" | "observation" | "current_handling" | "none";
      target_type: "proposed_session" | "proposed_playroom" | "team_deliberation" | "current_handling" | "task" | "none";
      target_item_id: string | null;
      target_part_name: string | null;
      requires_immediate_program_update: boolean;
      expected_resolution: "update_program" | "add_observation" | "create_task" | "store_memory" | "no_program_change";
      source: "daily_briefing";
      briefing_id: string | null;
      generated_at: string;
    };
    type AskRole = "ask_hanka" | "ask_kata";

    const classifyAsk = (role: AskRole, text: string, id: string): AskItem => {
      const lower = normalizeForMatch(text);
      const isPlayroom = lower.includes("herna") || lower.includes("hry") || lower.includes("hravy") || lower.includes("prakticky report");
      const isSession = !isPlayroom && (lower.includes("sezeni") || lower.includes("session") || lower.includes("terapeutick"));
      const isTask = lower.includes("ukol") || lower.includes("domluv") || lower.includes("zarid") || lower.includes("pripomen");
      const isObservation = lower.includes("sleduj") || lower.includes("pozoruj") || lower.includes("over") || lower.includes("zkontroluj") || lower.includes("rizik") || lower.includes("stop signal");
      const targetPlayroom = payload?.proposed_playroom && typeof payload.proposed_playroom === "object" ? payload.proposed_playroom : null;
      const targetSession = payload?.proposed_session && typeof payload.proposed_session === "object" ? payload.proposed_session : null;
      const intent = isPlayroom ? "playroom_plan" : isSession ? "session_plan" : isTask ? "task" : isObservation ? "observation" : "team_coordination";
      const targetType = isPlayroom ? "proposed_playroom" : isSession ? "proposed_session" : isTask ? "task" : isObservation ? "current_handling" : "none";
      const target = isPlayroom ? targetPlayroom : isSession ? targetSession : null;
      const targetPartName = target?.part_name ? String(target.part_name) : null;
      const stableTargetId = target?.id
        ? String(target.id)
        : targetType === "proposed_playroom"
          ? `${id}:proposed_playroom:${targetPartName ?? "unknown"}`
          : targetType === "proposed_session"
            ? `${id}:proposed_session:${targetPartName ?? "unknown"}`
            : null;
      return {
        id,
        text,
        assignee: role === "ask_hanka" ? "hanka" : "kata",
        question_text: text,
        intent,
        target_type: targetType,
        target_item_id: stableTargetId,
        target_part_name: targetPartName,
        requires_immediate_program_update: targetType === "proposed_playroom" || targetType === "proposed_session",
        expected_resolution: targetType === "proposed_playroom" || targetType === "proposed_session" ? "update_program" : isTask ? "create_task" : isObservation ? "add_observation" : "store_memory",
        source: "daily_briefing",
        briefing_id: null,
        generated_at: new Date().toISOString(),
      };
    };

    const carryOverAsks = async (
      role: AskRole,
      newTexts: string[],
    ): Promise<AskItem[]> => {
      if (!Array.isArray(newTexts) || newTexts.length === 0) return [];

      // Načti VŠECHNY briefingy téhož dne (i stale), seřaď nejnovější → nejstarší.
      const { data: sameDayBriefings } = await supabase
        .from("did_daily_briefings")
        .select("payload")
        .eq("briefing_date", today)
        .order("generated_at", { ascending: false });

      // Sesbírej všechny kandidáty na carry-over (id+text) ze stejné role.
      const carryPool: AskItem[] = [];
      for (const row of sameDayBriefings || []) {
        const old = (row?.payload as any)?.[role];
        if (!Array.isArray(old)) continue;
        for (const item of old) {
          // Akceptuj jen už-migrované {id,text} položky (legacy string[] přeskoč)
          if (item && typeof item === "object" && item.id && typeof item.text === "string") {
            carryPool.push(classifyAsk(role, String(item.text), String(item.id)));
          }
        }
      }

      const usedIds = new Set<string>();
      const result: AskItem[] = [];
      for (const text of newTexts) {
        const t = String(text ?? "").trim();
        if (!t) continue;
        const nt = normalizeForMatch(t);

        // Najdi první nepoužitý carry kandidát, který se kryje (substring v jednom směru).
        const match = carryPool.find((c) => {
          if (usedIds.has(c.id)) return false;
          const nc = normalizeForMatch(c.text);
          if (!nc) return false;
          return nc === nt || nc.includes(nt) || nt.includes(nc);
        });

        if (match) {
          usedIds.add(match.id);
          result.push(classifyAsk(role, t, match.id));
        } else {
          result.push(classifyAsk(role, t, crypto.randomUUID()));
        }
      }
      return result;
    };

    // Přepiš plain string[] → {id,text}[] s carry-over identitou.
    const askHankaRaw = Array.isArray(payload?.ask_hanka) ? payload.ask_hanka : [];
    const askKataRaw = Array.isArray(payload?.ask_kata) ? payload.ask_kata : [];
    payload.ask_hanka = await carryOverAsks(
      "ask_hanka",
      askHankaRaw.map((x: any) =>
        typeof x === "string" ? x : (x?.text ?? "")
      ),
    );
    payload.ask_kata = await carryOverAsks(
      "ask_kata",
      askKataRaw.map((x: any) =>
        typeof x === "string" ? x : (x?.text ?? "")
      ),
    );

    // 3c) ── DECISIONS / PROPOSED_SESSION ITEM IDENTITY (Slice 3) ──
    // Stejný pattern jako u asks: server přidá stabilní `id` na každou položku
    // (decisions[*].id, proposed_session.id), s carry-over přes ilike-match
    // v rámci téhož `briefing_date`. Tento `id` je pak `linked_briefing_item_id`
    // při vzniku `did_team_deliberations` — druhý klik na stejnou položku
    // briefingu otevře tutéž poradu místo zakládání nové.
    type DecisionItem = {
      id: string;
      title: string;
      reason: string;
      type: string;
      part_name?: string;
    };
    type ProposedSessionItem = {
      id: string;
      part_name: string;
      [key: string]: any;
    };

    // Pre-load same-day briefings (incl. stale) once for both decisions and proposed_session.
    const { data: sameDayPrev } = await supabase
      .from("did_daily_briefings")
      .select("payload")
      .eq("briefing_date", today)
      .order("generated_at", { ascending: false });

    // ── Decisions carry-over (match by normalized title) ──
    const decisionsRaw = Array.isArray(payload?.decisions) ? payload.decisions : [];
    const decisionPool: { id: string; title: string }[] = [];
    for (const row of sameDayPrev || []) {
      const old = (row?.payload as any)?.decisions;
      if (!Array.isArray(old)) continue;
      for (const item of old) {
        if (item && typeof item === "object" && item.id && typeof item.title === "string") {
          decisionPool.push({ id: String(item.id), title: String(item.title) });
        }
      }
    }
    const usedDecisionIds = new Set<string>();
    payload.decisions = decisionsRaw.map((d: any): DecisionItem => {
      const title = String(d?.title ?? "").trim();
      const nt = normalizeForMatch(title);
      const match = decisionPool.find((c) => {
        if (usedDecisionIds.has(c.id)) return false;
        const nc = normalizeForMatch(c.title);
        if (!nc) return false;
        return nc === nt || nc.includes(nt) || nt.includes(nc);
      });
      const id = match ? match.id : crypto.randomUUID();
      if (match) usedDecisionIds.add(match.id);
      return {
        id,
        title,
        reason: String(d?.reason ?? ""),
        type: String(d?.type ?? "team_task"),
        ...(d?.part_name ? { part_name: String(d.part_name) } : {}),
      };
    });

    // ── proposed_session carry-over (single object; match by part_name) ──
    if (payload?.proposed_session && typeof payload.proposed_session === "object") {
      const ps = payload.proposed_session;
      const partName = String(ps?.part_name ?? "").trim();
      const np = normalizeForMatch(partName);
      let resolvedId: string | null = null;
      for (const row of sameDayPrev || []) {
        const oldPs = (row?.payload as any)?.proposed_session;
        if (oldPs && typeof oldPs === "object" && oldPs.id && oldPs.part_name) {
          const op = normalizeForMatch(String(oldPs.part_name));
          if (op === np) {
            resolvedId = String(oldPs.id);
            break;
          }
        }
      }
      payload.proposed_session = {
        ...ps,
        id: resolvedId || crypto.randomUUID(),
      } as ProposedSessionItem;
    }

    // ── proposed_playroom carry-over (single object; match by part_name) ──
    if (payload?.proposed_playroom && typeof payload.proposed_playroom === "object") {
      const pp = payload.proposed_playroom;
      const partName = String(pp?.part_name ?? "").trim();
      const np = normalizeForMatch(partName);
      let resolvedId: string | null = null;
      for (const row of sameDayPrev || []) {
        const oldPp = (row?.payload as any)?.proposed_playroom;
        if (oldPp && typeof oldPp === "object" && oldPp.id && oldPp.part_name) {
          const op = normalizeForMatch(String(oldPp.part_name));
          if (op === np) {
            resolvedId = String(oldPp.id);
            break;
          }
        }
      }
      payload.proposed_playroom = {
        ...pp,
        id: resolvedId || crypto.randomUUID(),
      };
    }

    const refreshAskTargets = (role: AskRole, items: AskItem[]): AskItem[] =>
      items.map((item) => {
        const target = item.target_type === "proposed_playroom"
          ? payload.proposed_playroom
          : item.target_type === "proposed_session"
            ? payload.proposed_session
            : null;
        const targetPartName = target?.part_name ? String(target.part_name) : item.target_part_name ?? null;
        return {
          ...item,
          assignee: role === "ask_hanka" ? "hanka" : "kata",
          target_item_id: target?.id ? String(target.id) : item.target_item_id ?? (item.target_type === "proposed_playroom" || item.target_type === "proposed_session" ? `${item.briefing_id ?? item.id}:${item.target_type}:${targetPartName ?? "unknown"}` : null),
          target_part_name: targetPartName,
        };
      });

    payload.ask_hanka = refreshAskTargets("ask_hanka", payload.ask_hanka as AskItem[]);
    payload.ask_kata = refreshAskTargets("ask_kata", payload.ask_kata as AskItem[]);

    // 4) Resolve part_id pro proposed_session (kanonická tabulka did_part_registry)
    let proposedPartId: string | null = null;
    if (payload.proposed_session?.part_name) {
      const { data: parts } = await supabase
        .from("did_part_registry")
        .select("id")
        .ilike("part_name", payload.proposed_session.part_name)
        .limit(1);
      proposedPartId = parts?.[0]?.id || null;
    }

    // 5) Označit staré briefingy pro dnešek jako stale
    if (forceRegenerate) {
      await supabase
        .from("did_daily_briefings")
        .update({ is_stale: true })
        .eq("briefing_date", today)
        .eq("user_id", scopedUserId);
    }

    // 6) Insert nový briefing
    const { data: inserted, error: insertErr } = await supabase
      .from("did_daily_briefings")
      .insert({
        briefing_date: today,
        user_id: scopedUserId,
        payload,
        proposed_session_part_id: proposedPartId,
        proposed_session_score: candidates[0]?.score || null,
        decisions_count: payload.decisions?.length || 0,
        generation_method: generationMethod,
        generation_duration_ms: durationMs,
        model_used: MODEL,
        is_stale: false,
      })
      .select()
      .single();

    if (insertErr) throw insertErr;
    await finishBriefingAttempt(supabase, attemptId, { status: "succeeded", created_briefing_id: inserted.id });

    payload.ask_hanka = (payload.ask_hanka as AskItem[]).map((item) => ({ ...item, briefing_id: inserted.id }));
    payload.ask_kata = (payload.ask_kata as AskItem[]).map((item) => ({ ...item, briefing_id: inserted.id }));
    await supabase.from("did_daily_briefings").update({ payload }).eq("id", inserted.id);
    inserted.payload = payload;

    // ── PANTRY B: označit načtené entries jako processed ──
    // Brifing je jediný místo, kde Pantry B implikace mají oficiální dopad.
    // Po úspěšném zápisu briefingu řekneme reaktor-loop / cleanupu, že tyhle
    // záznamy už splnily svůj účel a nemají se znovu injectovat zítra.
    try {
      const consumedIds = (context.pantry_b_entries ?? [])
        .map((e: any) => e?.id)
        .filter((id: any) => typeof id === "string");
      if (consumedIds.length > 0) {
        await markPantryBProcessed(supabase as any, consumedIds, "karel-did-daily-briefing", {
          briefing_id: inserted.id,
          briefing_date: today,
        });
        console.log(`[briefing] Pantry B: marked ${consumedIds.length} entries as processed`);
      }
    } catch (mErr) {
      console.warn("[briefing] Pantry B mark-processed failed (non-fatal):", mErr);
    }

    return jsonResponse({ briefing: inserted, cached: false, candidates: candidates.slice(0, 5) });
  } catch (err: any) {
    console.error("[karel-did-daily-briefing] Error:", err);
    if (activeAttemptId) {
      const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
      await finishBriefingAttempt(sb, activeAttemptId, { status: "failed", error_code: "generation_failed", error_message: String(err?.message || err).slice(0, 1000) });
    }
    return jsonResponse({ error: err?.message || "Unknown error" }, 500);
  }
});
